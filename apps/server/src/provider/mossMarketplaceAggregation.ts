// FILE: mossMarketplaceAggregation.ts
// Purpose: On-demand, metadata-only aggregation for remote plugins, Skills,
//          and MCP directories.
// Design: source pages are fetched lazily, cached in-process, merged by stable
//         identity, and exposed as a paginated catalog separate from install
//         state. No remote item can be executed by this module.

import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { syncDirectoryEntrySync } from "@synara/shared/filesystemPlatform";

import type {
  ProviderCatalogActivity,
  ProviderCatalogEntry,
  ProviderCatalogFieldProvenance,
  ProviderCatalogLicense,
  ProviderCatalogPage,
  ProviderCatalogProvenance,
  ProviderCatalogQuery,
  ProviderCatalogResourceKind,
  ProviderCatalogSecurity,
  ProviderCatalogSourceStatus,
  ProviderCatalogSourceTier,
  ProviderCatalogWithdrawal,
} from "@synara/contracts";

import {
  createMossMarketplaceSources,
  isValidSpdxIdentifier,
  MossMarketplaceRemoteFetchError,
  type MossMarketplaceCandidate,
  type MossMarketplaceGitRevision,
  type MossMarketplaceSourceAdapter,
  type MossMarketplaceSourceFetchInput,
  type MossMarketplaceSourceOptions,
} from "./mossMarketplaceAggregationSources.ts";

const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_QUERY_STATES = 32;
const DEFAULT_MAX_CACHE_ENTRIES = 20_000;
const DEFAULT_MAX_CACHE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_CACHE_PAGES = 256;
const DEFAULT_MAX_TOMBSTONES = 20_000;
const DEFAULT_MAX_TOMBSTONE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_CURSOR_STATES = 1_024;
const DEFAULT_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_QUERY_PAGES = 6;
const MAX_AUTHORITATIVE_LEDGER_PAGES = 128;
const MAX_SOURCE_ENTRIES = 10_000;
const SOURCE_TOMBSTONE_CAPACITY_ERROR = "SOURCE_TOMBSTONE_CAPACITY";
const SOURCE_ENTRY_CAPACITY_ERROR = "SOURCE_ENTRY_CAPACITY";
const SOURCE_CACHE_CAPACITY_ERROR = "SOURCE_CACHE_CAPACITY";
const AUTHORITATIVE_LEDGER_INCOMPLETE_ERROR = "AUTHORITATIVE_LEDGER_UNAVAILABLE";
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const STALE_AFTER_MS = 365 * 24 * 60 * 60 * 1000;

const SOURCE_TIER_RANK: Record<ProviderCatalogSourceTier, number> = {
  official: 4,
  aggregator: 3,
  curated: 2,
  discovery: 1,
};

const WITHDRAWAL_STATUS_RANK: Record<ProviderCatalogWithdrawal["status"], number> = {
  deprecated: 1,
  moderated: 2,
  withdrawn: 3,
  removed: 4,
  deleted: 5,
};

export type MossMarketplaceCursorErrorCode =
  | "CURSOR_INVALID"
  | "CURSOR_KIND_MISMATCH"
  | "CURSOR_QUERY_MISMATCH"
  | "CURSOR_EXPIRED"
  | "CURSOR_GENERATION_MISMATCH"
  | "CURSOR_REPLAY";

export class MossMarketplaceCursorError extends Error {
  readonly code: MossMarketplaceCursorErrorCode;

  constructor(code: MossMarketplaceCursorErrorCode) {
    super(code);
    this.name = "MossMarketplaceCursorError";
    this.code = code;
  }
}

export interface MossMarketplaceAggregationBrowseInput {
  readonly kind: ProviderCatalogResourceKind;
  readonly query?: ProviderCatalogQuery | undefined;
  readonly forceReload?: boolean | undefined;
  /** Internal server wiring: selects the private stateDir for this catalog. */
  readonly stateDir?: string | undefined;
}

export interface MossMarketplaceRevisionChainRecord {
  readonly sourceId: string;
  readonly generation: number;
  readonly revision: MossMarketplaceGitRevision;
}

export interface MossMarketplaceRevisionChainStore {
  readonly get: (sourceId: string) => MossMarketplaceRevisionChainRecord | undefined;
  readonly set: (sourceId: string, record: MossMarketplaceRevisionChainRecord) => void;
}

export type MossMarketplaceRevisionChainErrorCode =
  | "REVISION_CHAIN_STATE_UNAVAILABLE"
  | "REVISION_CHAIN_BUSY"
  | "REVISION_CHAIN_CORRUPT"
  | "REVISION_CHAIN_CAPACITY"
  | "REVISION_CHAIN_CAS_CONFLICT";

export class MossMarketplaceRevisionChainError extends Error {
  readonly code: MossMarketplaceRevisionChainErrorCode;

  constructor(code: MossMarketplaceRevisionChainErrorCode) {
    super(code);
    this.name = "MossMarketplaceRevisionChainError";
    this.code = code;
  }
}

/**
 * Durable revision state lives below the server's already-private stateDir.
 * This is deliberately not a workspace manifest and is bounded so a corrupt
 * or hostile local file cannot turn startup into an unbounded allocation.
 */
export const MOSS_MARKETPLACE_REVISION_CHAIN_RELATIVE_PATH = path.join(
  "marketplace",
  "revision-chain.json",
);

const MOSS_MARKETPLACE_REVISION_CHAIN_MAX_RECORDS = 256;
const MOSS_MARKETPLACE_REVISION_CHAIN_MAX_BYTES = 64 * 1024;
const MOSS_MARKETPLACE_REVISION_CHAIN_VERSION = 1;

interface RevisionChainEnvelope {
  readonly version: 1;
  readonly records: Readonly<Record<string, MossMarketplaceRevisionChainRecord>>;
  readonly integrity: string;
}

interface RevisionChainLoad {
  readonly envelope: RevisionChainEnvelope;
  readonly recovered: boolean;
}

function revisionChainErrorCode(error: unknown): MossMarketplaceRevisionChainErrorCode | null {
  if (error instanceof MossMarketplaceRevisionChainError) return error.code;
  if (isRecord(error) && typeof error.code === "string") {
    const code = error.code as MossMarketplaceRevisionChainErrorCode;
    if (
      code === "REVISION_CHAIN_STATE_UNAVAILABLE" ||
      code === "REVISION_CHAIN_BUSY" ||
      code === "REVISION_CHAIN_CORRUPT" ||
      code === "REVISION_CHAIN_CAPACITY" ||
      code === "REVISION_CHAIN_CAS_CONFLICT"
    ) {
      return code;
    }
  }
  return null;
}

function cloneRevisionRecord(
  record: MossMarketplaceRevisionChainRecord,
): MossMarketplaceRevisionChainRecord {
  return {
    sourceId: record.sourceId,
    generation: record.generation,
    revision: {
      commitSha: record.revision.commitSha,
      treeSha: record.revision.treeSha,
      parents: [...record.revision.parents],
    },
  };
}

function canonicalRevisionChainBody(
  records: Readonly<Record<string, MossMarketplaceRevisionChainRecord>>,
): string {
  const orderedRecords = Object.fromEntries(
    Object.entries(records)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([sourceId, record]) => [sourceId, cloneRevisionRecord(record)]),
  );
  return JSON.stringify({
    version: MOSS_MARKETPLACE_REVISION_CHAIN_VERSION,
    records: orderedRecords,
  });
}

function revisionChainIntegrity(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function revisionChainEnvelopeText(
  records: Readonly<Record<string, MossMarketplaceRevisionChainRecord>>,
): string {
  const body = canonicalRevisionChainBody(records);
  return `${JSON.stringify({
    version: MOSS_MARKETPLACE_REVISION_CHAIN_VERSION,
    records: JSON.parse(body).records as Readonly<
      Record<string, MossMarketplaceRevisionChainRecord>
    >,
    integrity: revisionChainIntegrity(body),
  })}\n`;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function validRevisionChainRecord(value: unknown): value is MossMarketplaceRevisionChainRecord {
  if (!plainObject(value)) return false;
  const sourceId = value.sourceId;
  const generation = value.generation;
  const revision = value.revision;
  if (
    typeof sourceId !== "string" ||
    sourceId.length === 0 ||
    sourceId.length > 256 ||
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    !plainObject(revision) ||
    typeof revision.commitSha !== "string" ||
    !/^[a-f0-9]{40}$/i.test(revision.commitSha) ||
    typeof revision.treeSha !== "string" ||
    !/^[a-f0-9]{40}$/i.test(revision.treeSha) ||
    !Array.isArray(revision.parents) ||
    revision.parents.length > 64 ||
    revision.parents.some((parent) => typeof parent !== "string" || !/^[a-f0-9]{40}$/i.test(parent))
  ) {
    return false;
  }
  return true;
}

function parseRevisionChainEnvelope(raw: string): RevisionChainEnvelope {
  if (Buffer.byteLength(raw, "utf8") > MOSS_MARKETPLACE_REVISION_CHAIN_MAX_BYTES) {
    throw new MossMarketplaceRevisionChainError("REVISION_CHAIN_CAPACITY");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new MossMarketplaceRevisionChainError("REVISION_CHAIN_CORRUPT");
  }
  if (!plainObject(value) || value.version !== MOSS_MARKETPLACE_REVISION_CHAIN_VERSION) {
    throw new MossMarketplaceRevisionChainError("REVISION_CHAIN_CORRUPT");
  }
  const recordsValue = value.records;
  const integrity = value.integrity;
  if (
    !plainObject(recordsValue) ||
    typeof integrity !== "string" ||
    !/^[a-f0-9]{64}$/.test(integrity) ||
    Object.keys(recordsValue).length > MOSS_MARKETPLACE_REVISION_CHAIN_MAX_RECORDS
  ) {
    throw new MossMarketplaceRevisionChainError("REVISION_CHAIN_CORRUPT");
  }
  const records: Record<string, MossMarketplaceRevisionChainRecord> = {};
  for (const [sourceId, record] of Object.entries(recordsValue)) {
    if (!validRevisionChainRecord(record) || record.sourceId !== sourceId) {
      throw new MossMarketplaceRevisionChainError("REVISION_CHAIN_CORRUPT");
    }
    records[sourceId] = cloneRevisionRecord(record);
  }
  const body = canonicalRevisionChainBody(records);
  if (revisionChainIntegrity(body) !== integrity) {
    throw new MossMarketplaceRevisionChainError("REVISION_CHAIN_CORRUPT");
  }
  return { version: 1, records, integrity };
}

function ensureRevisionChainDirectory(directory: string): void {
  try {
    const existing = lstatSync(directory);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new MossMarketplaceRevisionChainError("REVISION_CHAIN_STATE_UNAVAILABLE");
    }
  } catch (error) {
    if (revisionChainErrorCode(error)) throw error;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    } catch {
      throw new MossMarketplaceRevisionChainError("REVISION_CHAIN_STATE_UNAVAILABLE");
    }
  }
  const final = lstatSync(directory);
  if (final.isSymbolicLink() || !final.isDirectory()) {
    throw new MossMarketplaceRevisionChainError("REVISION_CHAIN_STATE_UNAVAILABLE");
  }
  try {
    chmodSync(directory, 0o700);
  } catch (error) {
    if (revisionChainErrorCode(error)) throw error;
    throw new MossMarketplaceRevisionChainError("REVISION_CHAIN_STATE_UNAVAILABLE");
  }
}

function readRevisionChainFile(filePath: string): string | undefined {
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw new MossMarketplaceRevisionChainError("REVISION_CHAIN_STATE_UNAVAILABLE");
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new MossMarketplaceRevisionChainError("REVISION_CHAIN_CORRUPT");
  }
  if (stat.size > MOSS_MARKETPLACE_REVISION_CHAIN_MAX_BYTES) {
    throw new MossMarketplaceRevisionChainError("REVISION_CHAIN_CAPACITY");
  }
  try {
    const contents = readFileSync(filePath, "utf8");
    if (Buffer.byteLength(contents, "utf8") > MOSS_MARKETPLACE_REVISION_CHAIN_MAX_BYTES) {
      throw new MossMarketplaceRevisionChainError("REVISION_CHAIN_CAPACITY");
    }
    return contents;
  } catch (error) {
    if (revisionChainErrorCode(error)) throw error;
    throw new MossMarketplaceRevisionChainError("REVISION_CHAIN_STATE_UNAVAILABLE");
  }
}

function readRevisionChainEnvelope(filePath: string, backupPath: string): RevisionChainLoad {
  const primary = readRevisionChainFile(filePath);
  if (primary === undefined) {
    const backup = readRevisionChainFile(backupPath);
    if (backup === undefined) {
      return {
        envelope: {
          version: 1,
          records: {},
          integrity: revisionChainIntegrity(canonicalRevisionChainBody({})),
        },
        recovered: false,
      };
    }
    return { envelope: parseRevisionChainEnvelope(backup), recovered: true };
  }
  try {
    return { envelope: parseRevisionChainEnvelope(primary), recovered: false };
  } catch (primaryError) {
    const backup = readRevisionChainFile(backupPath);
    if (backup !== undefined) {
      try {
        return { envelope: parseRevisionChainEnvelope(backup), recovered: true };
      } catch {
        throw primaryError;
      }
    }
    throw primaryError;
  }
}

function writeRevisionChainFile(filePath: string, text: string): void {
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, text, { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, filePath);
    chmodSync(filePath, 0o600);
    syncDirectoryEntrySync(path.dirname(filePath));
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original write error.
      }
    }
    try {
      unlinkSync(temporaryPath);
    } catch {
      // A crash can leave a temp file; it is ignored and never read as state.
    }
    throw new MossMarketplaceRevisionChainError(
      revisionChainErrorCode(error) ?? "REVISION_CHAIN_STATE_UNAVAILABLE",
    );
  }
}

function withRevisionChainLock<T>(lockPath: string, operation: () => T): T {
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (isRecord(error) && error.code === "EEXIST") {
      throw new MossMarketplaceRevisionChainError("REVISION_CHAIN_BUSY");
    }
    throw new MossMarketplaceRevisionChainError("REVISION_CHAIN_STATE_UNAVAILABLE");
  }
  try {
    fsyncSync(descriptor);
    syncDirectoryEntrySync(path.dirname(lockPath));
    return operation();
  } finally {
    try {
      closeSync(descriptor);
    } finally {
      try {
        unlinkSync(lockPath);
        syncDirectoryEntrySync(path.dirname(lockPath));
      } catch {
        // Never reclaim a lock not owned by this operation.
      }
    }
  }
}

function sameRevisionRecord(
  left: MossMarketplaceRevisionChainRecord,
  right: MossMarketplaceRevisionChainRecord,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createMossMarketplaceInMemoryRevisionChainStore(): MossMarketplaceRevisionChainStore {
  const records = new Map<string, MossMarketplaceRevisionChainRecord>();
  return {
    get: (sourceId) => {
      const record = records.get(sourceId);
      return record ? cloneRevisionRecord(record) : undefined;
    },
    set: (sourceId, record) => {
      records.set(sourceId, cloneRevisionRecord(record));
    },
  };
}

export function createMossMarketplaceDurableRevisionChainStore(
  stateDir: string,
): MossMarketplaceRevisionChainStore {
  if (!path.isAbsolute(stateDir) || stateDir.trim() === "") {
    throw new MossMarketplaceRevisionChainError("REVISION_CHAIN_STATE_UNAVAILABLE");
  }
  const directory = path.join(stateDir, "marketplace");
  const filePath = path.join(stateDir, MOSS_MARKETPLACE_REVISION_CHAIN_RELATIVE_PATH);
  const backupPath = `${filePath}.bak`;
  const lockPath = `${filePath}.lock`;
  ensureRevisionChainDirectory(directory);
  const readWithoutRecovery = (): RevisionChainLoad =>
    readRevisionChainEnvelope(filePath, backupPath);
  const read = (): RevisionChainEnvelope => {
    const loaded = readWithoutRecovery();
    if (!loaded.recovered) return loaded.envelope;
    return withRevisionChainLock(lockPath, () => {
      const latest = readWithoutRecovery();
      if (latest.recovered) {
        writeRevisionChainFile(filePath, revisionChainEnvelopeText(latest.envelope.records));
      }
      return latest.envelope;
    });
  };
  return {
    get: (sourceId) => {
      const record = read().records[sourceId];
      return record ? cloneRevisionRecord(record) : undefined;
    },
    set: (sourceId, record) => {
      if (record.sourceId !== sourceId || !validRevisionChainRecord(record)) {
        throw new MossMarketplaceRevisionChainError("REVISION_CHAIN_CAS_CONFLICT");
      }
      withRevisionChainLock(lockPath, () => {
        const loaded = readWithoutRecovery();
        const current = loaded.envelope;
        if (loaded.recovered) {
          writeRevisionChainFile(filePath, revisionChainEnvelopeText(current.records));
        }
        const existing = current.records[sourceId];
        if (existing && sameRevisionRecord(existing, record)) return;
        if (
          (existing && record.generation <= existing.generation) ||
          (!existing && record.generation !== 1)
        ) {
          throw new MossMarketplaceRevisionChainError("REVISION_CHAIN_CAS_CONFLICT");
        }
        const nextRecords = { ...current.records, [sourceId]: cloneRevisionRecord(record) };
        const text = revisionChainEnvelopeText(nextRecords);
        if (
          Object.keys(nextRecords).length > MOSS_MARKETPLACE_REVISION_CHAIN_MAX_RECORDS ||
          Buffer.byteLength(text, "utf8") > MOSS_MARKETPLACE_REVISION_CHAIN_MAX_BYTES
        ) {
          throw new MossMarketplaceRevisionChainError("REVISION_CHAIN_CAPACITY");
        }
        if (
          Object.keys(current.records).length > 0 ||
          readRevisionChainFile(filePath) !== undefined
        ) {
          writeRevisionChainFile(backupPath, revisionChainEnvelopeText(current.records));
        }
        writeRevisionChainFile(filePath, text);
      });
    },
  };
}

export interface MossMarketplaceAggregationOptions extends MossMarketplaceSourceOptions {
  readonly sources?: readonly MossMarketplaceSourceAdapter[];
  /** Existing server-private state directory; never a workspace path. */
  readonly stateDir?: string | undefined;
  /** Server-owned persistence seam for upstream revision identity and generation. */
  readonly revisionChainStore?: MossMarketplaceRevisionChainStore;
  readonly cacheTtlMs?: number;
  readonly cursorTtlMs?: number;
  readonly maxQueryStates?: number;
  /**
   * Logical global admission budget for resident candidates plus tombstones.
   * Tombstones are never evicted; when preserving negative evidence makes the
   * budget impossible, the responsible source is quarantined and receives no
   * further positive intake. This is not an RSS measurement.
   */
  readonly maxCacheEntries?: number;
  /**
   * Logical global admission budget for resident page bytes plus tombstones.
   * Existing negative evidence is retained when this budget is impossible;
   * this is not an RSS measurement.
   */
  readonly maxCacheBytes?: number;
  readonly maxCachePages?: number;
  readonly maxCacheTombstoneBytes?: number;
  readonly maxTombstones?: number;
  /** Logical resident candidate-context entry ceiling; this is not an RSS limit. */
  readonly maxCandidateContexts?: number;
  /** UTF-8 byte ceiling for resident candidate contexts; this is not an RSS limit. */
  readonly maxCandidateContextBytes?: number;
  readonly maxCursorStates?: number;
  readonly tombstoneTtlMs?: number;
  readonly now?: () => Date;
}

interface CachedSourcePage {
  readonly fetchedAt: number;
  readonly bytes: number;
  readonly generation: number;
  readonly snapshot: string;
  readonly upstreamGeneration: number;
  readonly upstreamSnapshot: string;
  readonly fullSnapshot: boolean;
  readonly complete: boolean;
  readonly truncated: boolean | undefined;
  readonly partial: boolean | undefined;
  readonly sourceVersion: string | null;
  readonly page: {
    readonly candidates: readonly MossMarketplaceCandidate[];
    readonly nextCursor: string | null;
  };
}

interface CandidatePageContext {
  readonly sourceId: string;
  readonly sourceTier: ProviderCatalogSourceTier;
  readonly generation: number;
  readonly snapshot: string;
  readonly sourceVersion: string | null;
  readonly fullSnapshot: boolean;
  readonly partial: boolean | undefined;
  readonly nextCursor: string | null;
}

type SourceCoverageMode = "catalog" | "authoritative-ledger";

interface SourceQueryState {
  readonly key: string;
  readonly kind: ProviderCatalogResourceKind;
  readonly pages: Map<string, CachedSourcePage>;
  readonly candidates: Map<string, MossMarketplaceCandidate>;
  readonly candidateContexts: Map<string, CandidatePageContext>;
  coverageMode: SourceCoverageMode | null;
  chainGeneration: number | null;
  chainSnapshot: string | null;
  chainMetadataConsistent: boolean;
  generation: number;
  snapshot: string;
  sourceVersion: string | null;
  upstreamGeneration: number;
  upstreamSnapshot: string;
  lastFetchedAt: number;
  lastAttemptAt: number;
  lastAccess: number;
  cacheBytes: number;
  contextBytes: number;
  nextCursor: string | null;
  exhausted: boolean;
  lastError: string | null;
  usedCache: boolean;
  fetchedThisCall: boolean;
}

interface SourceState {
  readonly source: MossMarketplaceSourceAdapter;
  readonly queries: Map<string, SourceQueryState>;
  readonly tombstones: Map<string, TombstoneRecord>;
  revisionRecord: MossMarketplaceRevisionChainRecord | null;
  generation: number;
  snapshot: string;
  querySerial: number;
  tombstoneCapacityExceeded: boolean;
  readonly tombstoneCapacityKinds: Set<ProviderCatalogResourceKind>;
  entryCapacityExceeded: boolean;
  cacheBudgetExceeded: boolean;
  tombstoneRefreshPending: boolean;
  readonly authoritativeLedgerReady: Set<ProviderCatalogResourceKind>;
  readonly authoritativeLedgerErrors: Map<ProviderCatalogResourceKind, string>;
}

interface SourceObservation {
  readonly sourceId: string;
  readonly sourceTier: ProviderCatalogSourceTier;
  readonly sourceVersion: string | null;
  readonly observedAt: string;
  readonly generation: number;
  readonly snapshot: string;
  readonly upstreamGeneration: number;
  readonly upstreamSnapshot: string;
  readonly localGeneration: number;
  readonly localSnapshot: string;
  readonly durable?: boolean | undefined;
}

interface FieldObservation<T> {
  readonly value: T;
  readonly observation: SourceObservation;
}

interface TombstoneRecord {
  candidate: MossMarketplaceCandidate;
  withdrawal: FieldObservation<ProviderCatalogWithdrawal>;
  lastAccess: number;
  bytes: number;
}

interface AggregateRecord {
  candidate: MossMarketplaceCandidate;
  displayObservation: SourceObservation;
  sourceIds: Set<string>;
  sourceTiers: Set<ProviderCatalogSourceTier>;
  fields: {
    identity: FieldObservation<string>;
    verified: FieldObservation<boolean>;
    featured: FieldObservation<boolean>;
    license: FieldObservation<Partial<ProviderCatalogLicense> | undefined>;
    activity: FieldObservation<Partial<ProviderCatalogActivity> | undefined>;
    security: FieldObservation<MossMarketplaceCandidateSecurity | undefined>;
  };
  withdrawal: FieldObservation<ProviderCatalogWithdrawal> | null;
}

type MossMarketplaceCandidateSecurity = NonNullable<MossMarketplaceCandidate["security"]>;

interface StoredCursor {
  readonly token: string;
  readonly kind: ProviderCatalogResourceKind;
  readonly fingerprint: string;
  readonly offset: number;
  readonly expiresAt: number;
  readonly sourceGenerations: Readonly<Record<string, number>>;
  readonly sourceSnapshots: Readonly<Record<string, string>>;
  lastAccess: number;
  used: boolean;
}

export interface MossMarketplaceCacheStats {
  readonly queryStates: number;
  readonly pages: number;
  readonly entries: number;
  readonly tombstones: number;
  readonly bytes: number;
  readonly tombstoneBytes: number;
  readonly candidateContexts: number;
  readonly contextBytes: number;
  readonly cursors: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value ?? DEFAULT_LIMIT)));
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function validGitSha(value: string): boolean {
  return /^[a-f0-9]{40}$/i.test(value);
}

function revisionSnapshot(revision: MossMarketplaceGitRevision): string {
  return `git-commit:${revision.commitSha}:git-tree:${revision.treeSha}`;
}

function usableRevisionRecord(
  sourceId: string,
  record: MossMarketplaceRevisionChainRecord | undefined,
): record is MossMarketplaceRevisionChainRecord {
  return Boolean(
    record &&
    record.sourceId === sourceId &&
    Number.isSafeInteger(record.generation) &&
    record.generation >= 1 &&
    validGitSha(record.revision.commitSha) &&
    validGitSha(record.revision.treeSha) &&
    Array.isArray(record.revision.parents) &&
    record.revision.parents.every((parent) => validGitSha(parent)),
  );
}

function uniqueStrings(values: readonly (string | undefined | null)[]): string[] {
  return [
    ...new Set(
      values
        .filter((value): value is string => Boolean(value?.trim()))
        .map((value) => value.trim()),
    ),
  ];
}

function safeDate(value: unknown): string | undefined {
  const text = nonEmptyString(value);
  if (!text) return undefined;
  const parsed = new Date(text);
  return Number.isNaN(parsed.valueOf()) ? undefined : parsed.toISOString();
}

function nowIso(now: Date): string {
  return now.toISOString();
}

function queryFingerprint(
  kind: ProviderCatalogResourceKind,
  input: ProviderCatalogQuery | undefined,
): string {
  const query = input ?? {};
  return JSON.stringify({
    kind,
    query: query.query ?? "",
    sourceIds: [...(query.sourceIds ?? [])].sort(),
    licenseSpdxIds: [...(query.licenseSpdxIds ?? [])].sort(),
    compatibility: query.compatibility ?? "",
    minQualityScore: query.minQualityScore ?? null,
    sort: query.sort ?? "quality",
    featuredOnly: query.featuredOnly ?? false,
    verifiedOnly: query.verifiedOnly ?? false,
    includeUnverified: query.includeUnverified ?? true,
    includeStale: query.includeStale ?? false,
  });
}

function remoteQuery(input: ProviderCatalogQuery | undefined): string {
  return input?.query?.trim() ?? "";
}

function candidateActivity(
  candidate: MossMarketplaceCandidate,
  now: Date,
): ProviderCatalogActivity {
  const candidateActivity = candidate.activity;
  const lastUpdatedAt = safeDate(candidateActivity?.lastUpdatedAt) ?? null;
  let status = candidateActivity?.status;
  if (!status && lastUpdatedAt) {
    status =
      now.valueOf() - new Date(lastUpdatedAt).valueOf() > STALE_AFTER_MS ? "stale" : "active";
  }
  return {
    status: status ?? "unknown",
    lastUpdatedAt,
    checkedAt: nowIso(now),
  };
}

function candidateLicense(
  license: Partial<ProviderCatalogLicense> | undefined,
  now: Date,
): ProviderCatalogLicense {
  const candidateSpdxId = nonEmptyString(license?.spdxId);
  const spdxId = candidateSpdxId && isValidSpdxIdentifier(candidateSpdxId) ? candidateSpdxId : null;
  const url = nonEmptyString(license?.url) ?? null;
  const status = spdxId ? "known" : license?.status === "missing" ? "missing" : "unknown";
  return {
    status,
    spdxId,
    url,
    checkedAt: nowIso(now),
  };
}

function candidateSecurity(
  security: MossMarketplaceCandidateSecurity | undefined,
  now: Date,
): ProviderCatalogSecurity {
  const status = security?.status ?? "unreviewed";
  return {
    status,
    riskLevel: security?.riskLevel ?? (status === "blocked" ? "high" : "unknown"),
    permissions: uniqueStrings(security?.permissions?.length ? security.permissions : ["unknown"]),
    permissionSource: security?.permissionSource ?? "unknown",
    signals: uniqueStrings([...(security?.signals ?? []), "catalog-metadata-only"]),
    checkedAt: nowIso(now),
    executionPolicy: "never",
  };
}

function normalizedCandidate(candidate: MossMarketplaceCandidate): MossMarketplaceCandidate {
  return {
    ...candidate,
    identity: candidate.identity.trim().normalize("NFKC").toLocaleLowerCase("en-US"),
    name: candidate.name.trim(),
    tags: uniqueStrings(candidate.tags ?? []).sort(),
    compatibility: uniqueStrings(candidate.compatibility ?? []).sort(),
    metadata: candidate.metadata ?? {},
  };
}

function sourceObservation(
  source: MossMarketplaceSourceAdapter,
  state: SourceQueryState,
  candidate: MossMarketplaceCandidate,
  now: Date,
): SourceObservation {
  const upstreamGeneration =
    typeof candidate.withdrawal?.generation === "number" &&
    Number.isInteger(candidate.withdrawal.generation) &&
    candidate.withdrawal.generation >= 0
      ? candidate.withdrawal.generation
      : state.upstreamGeneration;
  const upstreamSnapshot = nonEmptyString(candidate.withdrawal?.snapshot) ?? state.upstreamSnapshot;
  return {
    sourceId: source.id,
    sourceTier: source.tier,
    sourceVersion:
      nonEmptyString(candidate.withdrawal?.sourceVersion) ?? state.sourceVersion ?? null,
    observedAt: safeDate(candidate.withdrawal?.observedAt) ?? nowIso(now),
    generation: upstreamGeneration,
    snapshot: upstreamSnapshot,
    upstreamGeneration,
    upstreamSnapshot,
    localGeneration: state.generation,
    localSnapshot: state.snapshot,
  };
}

function fieldProvenance(observation: SourceObservation): ProviderCatalogFieldProvenance {
  return {
    sourceIds: [observation.sourceId],
    sourceTiers: [observation.sourceTier],
    sourceVersion: observation.sourceVersion,
    observedAt: observation.observedAt,
    generation: observation.generation,
    snapshot: observation.snapshot,
    upstreamGeneration: observation.upstreamGeneration,
    upstreamSnapshot: observation.upstreamSnapshot,
    localGeneration: observation.localGeneration,
    localSnapshot: observation.localSnapshot,
  };
}

function withdrawalFromCandidate(
  candidate: MossMarketplaceCandidate,
  observation: SourceObservation,
  tombstoneTtlMs = DEFAULT_TOMBSTONE_TTL_MS,
): FieldObservation<ProviderCatalogWithdrawal> | null {
  const withdrawal = candidate.withdrawal;
  if (!withdrawal?.status) return null;
  const status = withdrawal.status;
  if (
    status !== "deleted" &&
    status !== "deprecated" &&
    status !== "moderated" &&
    status !== "withdrawn" &&
    status !== "removed"
  ) {
    return null;
  }
  return {
    value: {
      status,
      sourceId: observation.sourceId,
      sourceTier: observation.sourceTier,
      sourceVersion: nonEmptyString(withdrawal.sourceVersion) ?? observation.sourceVersion,
      observedAt: safeDate(withdrawal.observedAt) ?? observation.observedAt,
      generation:
        typeof withdrawal.generation === "number" &&
        Number.isInteger(withdrawal.generation) &&
        withdrawal.generation >= 0
          ? withdrawal.generation
          : observation.generation,
      snapshot: nonEmptyString(withdrawal.snapshot) ?? observation.snapshot,
      expiresAt:
        safeDate(withdrawal.expiresAt) ??
        new Date(
          new Date(safeDate(withdrawal.observedAt) ?? observation.observedAt).valueOf() +
            tombstoneTtlMs,
        ).toISOString(),
    },
    observation,
  };
}

function authorityCompare(left: SourceObservation, right: SourceObservation): number {
  const tierDifference = SOURCE_TIER_RANK[left.sourceTier] - SOURCE_TIER_RANK[right.sourceTier];
  if (tierDifference !== 0) return tierDifference;
  if (left.generation !== right.generation) return left.generation - right.generation;
  return right.sourceId.localeCompare(left.sourceId);
}

function chooseField<T>(
  current: FieldObservation<T>,
  next: FieldObservation<T>,
): FieldObservation<T> {
  return authorityCompare(next.observation, current.observation) > 0 ? next : current;
}

function chooseSecurity(
  current: FieldObservation<MossMarketplaceCandidateSecurity | undefined>,
  next: FieldObservation<MossMarketplaceCandidateSecurity | undefined>,
): FieldObservation<MossMarketplaceCandidateSecurity | undefined> {
  const currentStatus = current.value?.status;
  const nextStatus = next.value?.status;
  if (currentStatus === "blocked" && nextStatus !== "blocked") return current;
  if (nextStatus === "blocked" && currentStatus !== "blocked") return next;
  const statusRank: Record<ProviderCatalogSecurity["status"], number> = {
    "source-reviewed": 0,
    unreviewed: 1,
    "needs-review": 2,
    blocked: 3,
  };
  const currentRank = statusRank[currentStatus ?? "unreviewed"];
  const nextRank = statusRank[nextStatus ?? "unreviewed"];
  if (nextRank !== currentRank) return nextRank > currentRank ? next : current;
  return chooseField(current, next);
}

function chooseWithdrawal(
  current: FieldObservation<ProviderCatalogWithdrawal> | null,
  next: FieldObservation<ProviderCatalogWithdrawal> | null,
  identityAuthority: FieldObservation<string>,
): FieldObservation<ProviderCatalogWithdrawal> | null {
  if (!current && !next) return null;
  if (!current) {
    return authorityCompare(next!.observation, identityAuthority.observation) >= 0 ? next : null;
  }
  if (!next) {
    if (current!.observation.durable) {
      return SOURCE_TIER_RANK[current!.observation.sourceTier] >=
        SOURCE_TIER_RANK[identityAuthority.observation.sourceTier]
        ? current
        : null;
    }
    return authorityCompare(current!.observation, identityAuthority.observation) >= 0
      ? current
      : null;
  }
  const authority = authorityCompare(next.observation, current.observation);
  if (authority > 0) return next;
  if (authority < 0) return current;
  return WITHDRAWAL_STATUS_RANK[next.value.status] > WITHDRAWAL_STATUS_RANK[current.value.status]
    ? next
    : current;
}

function durableWithdrawal(
  value: FieldObservation<ProviderCatalogWithdrawal>,
): FieldObservation<ProviderCatalogWithdrawal> {
  return { ...value, observation: { ...value.observation, durable: true } };
}

function mergeTombstoneLedger(
  current: FieldObservation<ProviderCatalogWithdrawal> | undefined,
  next: FieldObservation<ProviderCatalogWithdrawal>,
): FieldObservation<ProviderCatalogWithdrawal> {
  const durableNext = durableWithdrawal(next);
  if (!current) return durableNext;
  const authority = authorityCompare(durableNext.observation, current.observation);
  if (authority > 0) return durableNext;
  if (authority < 0) return current;
  return WITHDRAWAL_STATUS_RANK[durableNext.value.status] >
    WITHDRAWAL_STATUS_RANK[current.value.status]
    ? durableNext
    : current;
}

function mergeMetadata(
  preferred: MossMarketplaceCandidate["metadata"],
  fallback: MossMarketplaceCandidate["metadata"],
): NonNullable<MossMarketplaceCandidate["metadata"]> {
  return { ...(fallback ?? {}), ...(preferred ?? {}) };
}

function mergeCandidate(
  current: AggregateRecord,
  next: MossMarketplaceCandidate,
  nextObservation: SourceObservation,
  tombstoneTtlMs = DEFAULT_TOMBSTONE_TTL_MS,
): void {
  const normalized = normalizedCandidate(next);
  const nextFields = {
    identity: { value: normalized.identity, observation: nextObservation },
    verified: {
      value: Boolean(normalized.verified),
      observation: nextObservation,
    },
    featured: {
      value: Boolean(normalized.featured),
      observation: nextObservation,
    },
    license: { value: normalized.license, observation: nextObservation },
    activity: { value: normalized.activity, observation: nextObservation },
    security: { value: normalized.security, observation: nextObservation },
  } satisfies AggregateRecord["fields"];
  const preferredDisplay = authorityCompare(nextObservation, current.displayObservation) > 0;
  const chosen = preferredDisplay ? normalized : current.candidate;
  const other = preferredDisplay ? current.candidate : normalized;
  current.candidate = normalizedCandidate({
    ...chosen,
    displayName: chosen.displayName ?? other.displayName ?? null,
    description: chosen.description ?? other.description ?? null,
    tags: uniqueStrings([...(chosen.tags ?? []), ...(other.tags ?? [])]),
    sourceUrl: chosen.sourceUrl ?? other.sourceUrl ?? null,
    homepageUrl: chosen.homepageUrl ?? other.homepageUrl ?? null,
    version: chosen.version ?? other.version ?? null,
    compatibility: uniqueStrings([...(chosen.compatibility ?? []), ...(other.compatibility ?? [])]),
    metadata: mergeMetadata(chosen.metadata, other.metadata),
  });
  if (preferredDisplay) current.displayObservation = nextObservation;
  current.fields.identity = chooseField(current.fields.identity, nextFields.identity);
  current.fields.verified = chooseField(current.fields.verified, nextFields.verified);
  current.fields.featured = chooseField(current.fields.featured, nextFields.featured);
  current.fields.license = chooseField(current.fields.license, nextFields.license);
  current.fields.activity = chooseField(current.fields.activity, nextFields.activity);
  current.fields.security = chooseSecurity(current.fields.security, nextFields.security);
  current.withdrawal = chooseWithdrawal(
    current.withdrawal,
    withdrawalFromCandidate(normalized, nextObservation, tombstoneTtlMs),
    current.fields.identity,
  );
  current.sourceIds.add(nextObservation.sourceId);
  current.sourceTiers.add(nextObservation.sourceTier);
}

function aggregateRecordForCandidate(
  normalized: MossMarketplaceCandidate,
  observation: SourceObservation,
  withdrawal: FieldObservation<ProviderCatalogWithdrawal> | null,
): AggregateRecord {
  return {
    candidate: normalized,
    displayObservation: observation,
    sourceIds: new Set([observation.sourceId]),
    sourceTiers: new Set([observation.sourceTier]),
    fields: {
      identity: { value: normalized.identity, observation },
      verified: { value: Boolean(normalized.verified), observation },
      featured: { value: Boolean(normalized.featured), observation },
      license: { value: normalized.license, observation },
      activity: { value: normalized.activity, observation },
      security: { value: normalized.security, observation },
    },
    withdrawal,
  };
}

function qualityScore(
  candidate: MossMarketplaceCandidate,
  sourceTier: ProviderCatalogSourceTier,
  license: ProviderCatalogLicense,
  activity: ProviderCatalogActivity,
  security: ProviderCatalogSecurity,
): number {
  let score = SOURCE_TIER_RANK[sourceTier] * 18;
  if (candidate.verified) score += 14;
  if (candidate.featured) score += 8;
  if (candidate.description && candidate.description.trim().length >= 20) score += 10;
  if (candidate.sourceUrl || candidate.homepageUrl) score += 8;
  if (candidate.compatibility && candidate.compatibility.length > 1) score += 6;
  if (license.status === "known") score += 14;
  if (activity.status === "active") score += 10;
  if (activity.status === "stale") score -= 8;
  if (activity.status === "archived") score -= 30;
  if (security.status === "source-reviewed") score += 8;
  if (security.status === "needs-review") score -= 2;
  if (security.status === "blocked") score = 0;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function entryFromAggregate(record: AggregateRecord, now: Date): ProviderCatalogEntry {
  const candidate = record.candidate;
  const sourceTiers = [...record.sourceTiers].sort(
    (left, right) => SOURCE_TIER_RANK[right] - SOURCE_TIER_RANK[left],
  );
  const primaryTier = sourceTiers[0] ?? "discovery";
  const license = candidateLicense(record.fields.license.value, now);
  const activity = candidateActivity({ ...candidate, activity: record.fields.activity.value }, now);
  const security = candidateSecurity(record.fields.security.value, now);
  const withdrawal = record.withdrawal?.value ?? null;
  const provenance: ProviderCatalogProvenance = {
    identity: fieldProvenance(record.fields.identity.observation),
    verified: fieldProvenance(record.fields.verified.observation),
    featured: fieldProvenance(record.fields.featured.observation),
    license: fieldProvenance(record.fields.license.observation),
    activity: fieldProvenance(record.fields.activity.observation),
    security: fieldProvenance(record.fields.security.observation),
    withdrawal: record.withdrawal ? fieldProvenance(record.withdrawal.observation) : null,
  };
  return {
    id: record.fields.identity.value,
    kind: candidate.kind,
    name: candidate.name,
    displayName: candidate.displayName ?? null,
    description: candidate.description ?? null,
    tags: [...(candidate.tags ?? [])],
    sourceIds: [...record.sourceIds].sort(),
    sourceTiers,
    sourceUrl: candidate.sourceUrl ?? null,
    homepageUrl: candidate.homepageUrl ?? null,
    version: candidate.version ?? null,
    featured: record.fields.featured.value,
    verified: record.fields.verified.value,
    compatibility: [...(candidate.compatibility ?? [])].sort(),
    qualityScore: qualityScore(
      {
        ...candidate,
        featured: record.fields.featured.value,
        verified: record.fields.verified.value,
      },
      primaryTier,
      license,
      activity,
      security,
    ),
    license,
    activity,
    security,
    withdrawal,
    provenance,
    installPolicy: "manual-review-only",
    metadata: { ...(candidate.metadata ?? {}) },
  };
}

function matchesQuery(
  entry: ProviderCatalogEntry,
  query: ProviderCatalogQuery | undefined,
): boolean {
  const requested = query ?? {};
  const search = requested.query?.trim().toLowerCase();
  if (search) {
    const haystack = [
      entry.id,
      entry.name,
      entry.displayName ?? "",
      entry.description ?? "",
      ...entry.tags,
      ...entry.sourceIds,
      ...entry.compatibility,
    ]
      .join(" ")
      .toLowerCase();
    if (!search.split(/\s+/).every((token) => haystack.includes(token))) return false;
  }
  if (
    requested.sourceIds?.length &&
    !requested.sourceIds.some((sourceId) => entry.sourceIds.includes(sourceId))
  )
    return false;
  if (
    requested.licenseSpdxIds?.length &&
    (!entry.license.spdxId || !requested.licenseSpdxIds.includes(entry.license.spdxId))
  ) {
    return false;
  }
  if (requested.compatibility && !entry.compatibility.includes(requested.compatibility))
    return false;
  if (requested.minQualityScore !== undefined && entry.qualityScore < requested.minQualityScore)
    return false;
  if (requested.featuredOnly && !entry.featured) return false;
  if (requested.verifiedOnly && !entry.verified) return false;
  if (requested.includeUnverified === false && !entry.verified) return false;
  if (entry.withdrawal && requested.includeStale !== true) return false;
  if (requested.includeStale !== true && ["stale", "archived"].includes(entry.activity.status))
    return false;
  if (entry.security.status === "blocked") return false;
  return true;
}

function compareEntries(
  left: ProviderCatalogEntry,
  right: ProviderCatalogEntry,
  sort: ProviderCatalogQuery["sort"],
): number {
  if (sort === "name") return left.name.localeCompare(right.name);
  if (sort === "updated") {
    const leftDate = left.activity.lastUpdatedAt
      ? new Date(left.activity.lastUpdatedAt).valueOf()
      : 0;
    const rightDate = right.activity.lastUpdatedAt
      ? new Date(right.activity.lastUpdatedAt).valueOf()
      : 0;
    return rightDate - leftDate || left.name.localeCompare(right.name);
  }
  if (sort === "featured") {
    return (
      Number(right.featured) - Number(left.featured) ||
      right.qualityScore - left.qualityScore ||
      left.name.localeCompare(right.name)
    );
  }
  return (
    right.qualityScore - left.qualityScore ||
    Number(right.verified) - Number(left.verified) ||
    left.name.localeCompare(right.name)
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof MossMarketplaceRemoteFetchError) return error.code;
  if (isRecord(error) && typeof error.code === "string") return error.code;
  return "SOURCE_FETCH_FAILED";
}

function sourceStatus(
  state: SourceState,
  queryState: SourceQueryState | undefined,
  errorOverride?: string | undefined,
): ProviderCatalogSourceStatus {
  const source = state.source;
  return {
    id: source.id,
    label: source.label,
    tier: source.tier,
    enabled: source.enabled,
    cached: Boolean(queryState?.usedCache && !queryState.fetchedThisCall),
    itemCount: queryState?.candidates.size ?? 0,
    error: !source.enabled
      ? `disabled: ${source.disabledReason ?? "source disabled"}`
      : state.tombstoneCapacityExceeded
        ? SOURCE_TOMBSTONE_CAPACITY_ERROR
        : state.entryCapacityExceeded
          ? SOURCE_ENTRY_CAPACITY_ERROR
          : state.cacheBudgetExceeded
            ? SOURCE_CACHE_CAPACITY_ERROR
            : (queryState?.lastError ?? errorOverride ?? null),
    remoteCursor: queryState?.nextCursor ?? null,
    generation: queryState?.generation ?? state.generation,
    sourceVersion: queryState?.sourceVersion ?? null,
    snapshot: queryState?.snapshot ?? state.snapshot,
  };
}

function sourceQueryState(
  source: SourceState,
  key: string,
  kind: ProviderCatalogResourceKind,
  access: number,
): SourceQueryState {
  source.querySerial += 1;
  return {
    key,
    kind,
    pages: new Map(),
    candidates: new Map(),
    candidateContexts: new Map(),
    coverageMode: null,
    chainGeneration: null,
    chainSnapshot: null,
    chainMetadataConsistent: true,
    generation: source.generation,
    snapshot: `${source.snapshot}:q${source.querySerial}`,
    sourceVersion: null,
    upstreamGeneration: 0,
    upstreamSnapshot: `${source.snapshot}:upstream:unknown`,
    lastFetchedAt: 0,
    lastAttemptAt: 0,
    lastAccess: access,
    cacheBytes: 0,
    contextBytes: 0,
    nextCursor: null,
    exhausted: false,
    lastError: null,
    usedCache: false,
    fetchedThisCall: false,
  };
}

function candidateContextBytes(context: CandidatePageContext): number {
  return Buffer.byteLength(JSON.stringify(context), "utf8");
}

export class MossMarketplaceAggregation {
  private readonly stateDir: string | undefined;
  private readonly cacheTtlMs: number;
  private readonly cursorTtlMs: number;
  private readonly maxQueryStates: number;
  private readonly maxCacheEntries: number;
  private readonly maxCacheBytes: number;
  private readonly maxCachePages: number;
  private readonly maxCacheTombstoneBytes: number;
  private readonly maxTombstones: number;
  private readonly maxCandidateContexts: number;
  private readonly maxCandidateContextBytes: number;
  private readonly maxCursorStates: number;
  private readonly tombstoneTtlMs: number;
  private readonly now: () => Date;
  private readonly revisionChainStore: MossMarketplaceRevisionChainStore;
  private readonly sources: SourceState[];
  private readonly statefulChildren = new Map<string, MossMarketplaceAggregation>();
  private readonly cursors = new Map<string, StoredCursor>();
  private accessCounter = 0;

  constructor(options: MossMarketplaceAggregationOptions = {}) {
    this.stateDir = options.stateDir;
    this.cacheTtlMs = Math.max(1_000, options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS);
    this.cursorTtlMs = Math.max(1_000, options.cursorTtlMs ?? this.cacheTtlMs);
    this.maxQueryStates = Math.max(
      1,
      Math.floor(options.maxQueryStates ?? DEFAULT_MAX_QUERY_STATES),
    );
    this.maxCacheEntries = Math.max(
      1,
      Math.floor(options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES),
    );
    this.maxCacheBytes = Math.max(
      1_024,
      Math.floor(options.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES),
    );
    this.maxCachePages = Math.max(1, Math.floor(options.maxCachePages ?? DEFAULT_MAX_CACHE_PAGES));
    this.maxCacheTombstoneBytes = Math.max(
      1,
      Math.floor(options.maxCacheTombstoneBytes ?? DEFAULT_MAX_TOMBSTONE_BYTES),
    );
    this.maxTombstones = Math.max(1, Math.floor(options.maxTombstones ?? DEFAULT_MAX_TOMBSTONES));
    this.maxCandidateContexts = Math.max(
      1,
      Math.floor(options.maxCandidateContexts ?? this.maxCacheEntries),
    );
    this.maxCandidateContextBytes = Math.max(
      1,
      Math.floor(options.maxCandidateContextBytes ?? this.maxCacheBytes),
    );
    this.maxCursorStates = Math.max(
      1,
      Math.floor(options.maxCursorStates ?? DEFAULT_MAX_CURSOR_STATES),
    );
    this.tombstoneTtlMs = Math.max(
      1_000,
      Math.floor(options.tombstoneTtlMs ?? DEFAULT_TOMBSTONE_TTL_MS),
    );
    this.now = options.now ?? (() => new Date());
    this.revisionChainStore =
      options.revisionChainStore ??
      (options.stateDir
        ? createMossMarketplaceDurableRevisionChainStore(options.stateDir)
        : {
            get: () => {
              throw new MossMarketplaceRevisionChainError("REVISION_CHAIN_STATE_UNAVAILABLE");
            },
            set: () => {
              throw new MossMarketplaceRevisionChainError("REVISION_CHAIN_STATE_UNAVAILABLE");
            },
          });
    const adapters = options.sources ?? createMossMarketplaceSources(options);
    this.sources = adapters.map((source) => {
      let persistedRevision: MossMarketplaceRevisionChainRecord | undefined;
      try {
        persistedRevision = this.revisionChainStore.get(source.id);
      } catch (error) {
        if (revisionChainErrorCode(error) !== "REVISION_CHAIN_STATE_UNAVAILABLE") throw error;
      }
      return {
        source,
        queries: new Map(),
        tombstones: new Map(),
        revisionRecord: usableRevisionRecord(source.id, persistedRevision)
          ? persistedRevision
          : null,
        generation: 1,
        snapshot: `${source.id}:1`,
        querySerial: 0,
        tombstoneCapacityExceeded: false,
        tombstoneCapacityKinds: new Set(),
        entryCapacityExceeded: false,
        cacheBudgetExceeded: false,
        tombstoneRefreshPending: false,
        authoritativeLedgerReady: new Set(),
        authoritativeLedgerErrors: new Map(),
      };
    });
  }

  clearCache(): void {
    this.cursors.clear();
    for (const source of this.sources) this.resetSource(source);
    for (const child of this.statefulChildren.values()) child.clearCache();
  }

  private statefulChild(stateDir: string): MossMarketplaceAggregation {
    const existing = this.statefulChildren.get(stateDir);
    if (existing) return existing;
    const child = new MossMarketplaceAggregation({
      stateDir,
      sources: this.sources.map(({ source }) => source),
      now: this.now,
      cacheTtlMs: this.cacheTtlMs,
      cursorTtlMs: this.cursorTtlMs,
      maxQueryStates: this.maxQueryStates,
      maxCacheEntries: this.maxCacheEntries,
      maxCacheBytes: this.maxCacheBytes,
      maxCachePages: this.maxCachePages,
      maxCacheTombstoneBytes: this.maxCacheTombstoneBytes,
      maxTombstones: this.maxTombstones,
      maxCandidateContexts: this.maxCandidateContexts,
      maxCandidateContextBytes: this.maxCandidateContextBytes,
      maxCursorStates: this.maxCursorStates,
      tombstoneTtlMs: this.tombstoneTtlMs,
    });
    this.statefulChildren.set(stateDir, child);
    return child;
  }

  private resetSource(source: SourceState): void {
    source.queries.clear();
    source.authoritativeLedgerReady.clear();
    source.authoritativeLedgerErrors.clear();
    source.generation += 1;
    source.snapshot = `${source.source.id}:${source.generation}`;
    source.querySerial = 0;
  }

  private enforceCacheBounds(options: { readonly includeGlobal?: boolean } = {}): void {
    const allStates = (): { source: SourceState; state: SourceQueryState }[] =>
      this.sources.flatMap((source) =>
        [...source.queries.values()].map((state) => ({ source, state })),
      );
    const candidateCount = () =>
      allStates().reduce((total, item) => total + item.state.candidates.size, 0);
    const contextCount = () =>
      allStates().reduce((total, item) => total + item.state.candidateContexts.size, 0);
    const pageCount = () => allStates().reduce((total, item) => total + item.state.pages.size, 0);
    const pageBytes = () => allStates().reduce((total, item) => total + item.state.cacheBytes, 0);
    const contextBytes = () =>
      allStates().reduce((total, item) => total + item.state.contextBytes, 0);
    const tombstoneCount = () =>
      this.sources.reduce((total, source) => total + source.tombstones.size, 0);
    const tombstoneBytes = () =>
      this.sources.reduce(
        (total, source) =>
          total + [...source.tombstones.values()].reduce((sum, record) => sum + record.bytes, 0),
        0,
      );

    while (allStates().length > this.maxQueryStates) {
      const oldest = allStates().sort(
        (left, right) => left.state.lastAccess - right.state.lastAccess,
      )[0];
      if (!oldest) break;
      oldest.source.queries.delete(oldest.state.key);
    }
    while (pageCount() > this.maxCachePages) {
      const pages = allStates().flatMap(({ source, state }) =>
        [...state.pages.entries()].map(([key, page]) => ({ source, state, key, page })),
      );
      const oldest = pages.sort((left, right) => left.page.fetchedAt - right.page.fetchedAt)[0];
      if (!oldest) break;
      oldest.state.pages.delete(oldest.key);
      oldest.state.cacheBytes = Math.max(0, oldest.state.cacheBytes - oldest.page.bytes);
    }
    while (
      options.includeGlobal !== false &&
      (candidateCount() + tombstoneCount() > this.maxCacheEntries ||
        pageBytes() + tombstoneBytes() > this.maxCacheBytes ||
        contextCount() > this.maxCandidateContexts ||
        contextBytes() > this.maxCandidateContextBytes)
    ) {
      const owners = new Set(
        this.sources.filter(
          (source) =>
            source.cacheBudgetExceeded ||
            source.tombstoneCapacityExceeded ||
            source.entryCapacityExceeded,
        ),
      );
      const ownedState = allStates()
        .filter(({ source }) => owners.has(source))
        .sort((left, right) => left.state.lastAccess - right.state.lastAccess)[0];
      const oldestState =
        ownedState ??
        (owners.size === 0
          ? allStates().sort((left, right) => left.state.lastAccess - right.state.lastAccess)[0]
          : undefined);
      if (oldestState) {
        // Passive eviction is not evidence of a bad source. When an owner is
        // known, evict only that owner's resident positive state; otherwise
        // evicting is a cache maintenance action with no quarantine side
        // effect. Negative evidence remains in the source ledger.
        oldestState.source.queries.delete(oldestState.state.key);
        continue;
      }
      const responsibleSource = (
        owners.size > 0
          ? [...owners].filter((source) => source.tombstones.size > 0)
          : this.sources.filter((source) => source.tombstones.size > 0)
      ).sort((left, right) => {
        const leftBytes = [...left.tombstones.values()].reduce(
          (sum, record) => sum + record.bytes,
          0,
        );
        const rightBytes = [...right.tombstones.values()].reduce(
          (sum, record) => sum + record.bytes,
          0,
        );
        return (
          rightBytes - leftBytes ||
          right.tombstones.size - left.tombstones.size ||
          left.source.id.localeCompare(right.source.id)
        );
      })[0];
      if (responsibleSource) responsibleSource.cacheBudgetExceeded = true;
      break;
    }

    for (const source of this.sources) {
      const bytes = [...source.tombstones.values()].reduce((sum, record) => sum + record.bytes, 0);
      if (source.tombstones.size > this.maxTombstones || bytes > this.maxCacheTombstoneBytes) {
        // Negative evidence is never silently discarded. This source remains
        // quarantined until a successful authoritative full snapshot is
        // observed; healthy sources continue to serve positive metadata.
        source.tombstoneCapacityExceeded = true;
        if (source.tombstoneCapacityKinds.size === 0) {
          for (const record of source.tombstones.values()) {
            source.tombstoneCapacityKinds.add(record.candidate.kind);
          }
        }
      }
    }
    while (this.cursors.size > this.maxCursorStates) {
      const oldest = [...this.cursors.values()].sort(
        (left, right) => left.lastAccess - right.lastAccess,
      )[0];
      if (!oldest) break;
      this.cursors.delete(oldest.token);
    }
  }

  getCacheStats(): MossMarketplaceCacheStats {
    this.enforceCacheBounds();
    const states = this.sources.flatMap((source) => [...source.queries.values()]);
    return {
      queryStates: states.length,
      pages: states.reduce((total, state) => total + state.pages.size, 0),
      entries:
        states.reduce((total, state) => total + state.candidates.size, 0) +
        this.sources.reduce((total, source) => total + source.tombstones.size, 0),
      tombstones: this.sources.reduce((total, source) => total + source.tombstones.size, 0),
      bytes: states.reduce((total, state) => total + state.cacheBytes, 0),
      tombstoneBytes: this.sources.reduce(
        (total, source) =>
          total + [...source.tombstones.values()].reduce((sum, record) => sum + record.bytes, 0),
        0,
      ),
      candidateContexts: states.reduce((total, state) => total + state.candidateContexts.size, 0),
      contextBytes: states.reduce((total, state) => total + state.contextBytes, 0),
      cursors: this.cursors.size,
    };
  }

  private stateFor(
    source: SourceState,
    kind: ProviderCatalogResourceKind,
    queryText: string,
  ): SourceQueryState {
    const key = `${kind}\u0000${queryText}`;
    let state = source.queries.get(key);
    if (!state) {
      state = sourceQueryState(source, key, kind, ++this.accessCounter);
      source.queries.set(key, state);
    } else {
      source.queries.delete(key);
      state.lastAccess = ++this.accessCounter;
      source.queries.set(key, state);
    }
    this.enforceCacheBounds();
    return state;
  }

  private isStateResident(source: SourceState, state: SourceQueryState): boolean {
    return source.queries.get(state.key) === state;
  }

  private admitCandidate(
    source: SourceState,
    state: SourceQueryState,
    candidate: MossMarketplaceCandidate,
    context: CandidatePageContext,
  ): boolean {
    const existingContext = state.candidateContexts.get(candidate.identity);
    const bytes = Buffer.byteLength(JSON.stringify(context), "utf8");
    const nextContextCount = state.candidateContexts.size + (existingContext ? 0 : 1);
    const nextContextBytes =
      state.contextBytes - (existingContext ? candidateContextBytes(existingContext) : 0) + bytes;
    const contextFits =
      nextContextCount <= this.maxCandidateContexts &&
      nextContextBytes <= this.maxCandidateContextBytes;
    const isNegative = candidate.withdrawal !== undefined && candidate.withdrawal !== null;
    if (!contextFits && !isNegative) {
      source.cacheBudgetExceeded = true;
      state.lastError = SOURCE_CACHE_CAPACITY_ERROR;
      return false;
    }
    if (!existingContext && !state.candidates.has(candidate.identity)) {
      if (state.candidates.size >= MAX_SOURCE_ENTRIES) {
        source.entryCapacityExceeded = true;
        state.lastError = SOURCE_ENTRY_CAPACITY_ERROR;
        if (!isNegative) return false;
        // The bounded positive page cannot admit another context, but a
        // withdrawal at the boundary is durable negative evidence and must
        // still reach the tombstone ledger.
        state.candidates.set(candidate.identity, candidate);
        return true;
      }
    }
    state.candidates.set(candidate.identity, candidate);
    if (!contextFits) {
      // A negative record remains available to the ledger even when its
      // diagnostic page context cannot be admitted. It cannot participate in
      // reinstatement without a complete context, which is fail-closed.
      state.lastError = SOURCE_CACHE_CAPACITY_ERROR;
      return true;
    }
    if (existingContext) {
      state.contextBytes = Math.max(0, state.contextBytes - candidateContextBytes(existingContext));
    }
    state.candidateContexts.set(candidate.identity, context);
    state.contextBytes += bytes;
    return true;
  }

  private admitPageBytes(
    source: SourceState,
    state: SourceQueryState,
    pageKey: string,
    bytes: number,
    preserveNegativeEvidence: boolean,
  ): boolean {
    const residentPageBytes = this.residentPageBytes();
    const previousBytes = state.pages.get(pageKey)?.bytes ?? 0;
    if (
      bytes > this.maxCacheBytes ||
      residentPageBytes - previousBytes + bytes + this.residentTombstoneBytes() > this.maxCacheBytes
    ) {
      if (!preserveNegativeEvidence) source.cacheBudgetExceeded = true;
      state.lastError = SOURCE_CACHE_CAPACITY_ERROR;
      return false;
    }
    return true;
  }

  private residentTombstoneBytes(): number {
    return this.sources.reduce(
      (total, source) =>
        total + [...source.tombstones.values()].reduce((sum, record) => sum + record.bytes, 0),
      0,
    );
  }

  private residentCandidateCount(): number {
    return this.sources.reduce(
      (total, source) =>
        total +
        [...source.queries.values()].reduce(
          (sourceTotal, state) => sourceTotal + state.candidates.size,
          0,
        ),
      0,
    );
  }

  private residentPageBytes(): number {
    return this.sources.reduce(
      (total, source) =>
        total +
        [...source.queries.values()].reduce(
          (sourceTotal, state) => sourceTotal + state.cacheBytes,
          0,
        ),
      0,
    );
  }

  private residentContextCount(): number {
    return this.sources.reduce(
      (total, source) =>
        total +
        [...source.queries.values()].reduce(
          (sourceTotal, state) => sourceTotal + state.candidateContexts.size,
          0,
        ),
      0,
    );
  }

  private residentContextBytes(): number {
    return this.sources.reduce(
      (total, source) =>
        total +
        [...source.queries.values()].reduce(
          (sourceTotal, state) => sourceTotal + state.contextBytes,
          0,
        ),
      0,
    );
  }

  private residentBudgetExceeded(): boolean {
    return (
      this.residentCandidateCount() +
        this.sources.reduce((total, source) => total + source.tombstones.size, 0) >
        this.maxCacheEntries ||
      this.residentPageBytes() + this.residentTombstoneBytes() > this.maxCacheBytes ||
      this.residentContextCount() > this.maxCandidateContexts ||
      this.residentContextBytes() > this.maxCandidateContextBytes
    );
  }

  private hasOtherBudgetOwner(source: SourceState): boolean {
    return this.sources.some(
      (candidate) =>
        candidate !== source &&
        (candidate.cacheBudgetExceeded ||
          candidate.tombstoneCapacityExceeded ||
          candidate.entryCapacityExceeded),
    );
  }

  private isAuthoritativeLedgerUnavailable(
    kind: ProviderCatalogResourceKind,
    states: readonly {
      source: SourceState;
      state: SourceQueryState | undefined;
    }[],
  ): boolean {
    let globallyUnavailable = false;
    for (const { source, state } of states) {
      const authoritativeTombstoneCapacity =
        source.source.tier === "official" &&
        (source.tombstoneCapacityKinds.has(kind) ||
          state?.lastError === SOURCE_TOMBSTONE_CAPACITY_ERROR);
      const localCapacityError = source.tombstoneCapacityExceeded
        ? SOURCE_TOMBSTONE_CAPACITY_ERROR
        : source.entryCapacityExceeded
          ? SOURCE_ENTRY_CAPACITY_ERROR
          : source.cacheBudgetExceeded ||
              state?.lastError === SOURCE_CACHE_CAPACITY_ERROR ||
              (state !== undefined && !this.isStateResident(source, state))
            ? SOURCE_CACHE_CAPACITY_ERROR
            : null;
      if (localCapacityError) {
        source.authoritativeLedgerReady.delete(kind);
        source.authoritativeLedgerErrors.set(kind, localCapacityError);
        if (authoritativeTombstoneCapacity) globallyUnavailable = true;
        // Ordinary cache/entry eviction is source-local. An authoritative
        // tombstone ledger overflow is different: it leaves a kind-level gap
        // in negative evidence, so every positive projection must fail closed.
        continue;
      }
      const unavailable =
        !state ||
        !this.isStateResident(source, state) ||
        Boolean(state.lastError) ||
        !source.authoritativeLedgerReady.has(kind) ||
        source.entryCapacityExceeded ||
        source.cacheBudgetExceeded;
      if (!unavailable) continue;
      source.authoritativeLedgerReady.delete(kind);
      source.authoritativeLedgerErrors.set(
        kind,
        state?.lastError ??
          (source.entryCapacityExceeded
            ? SOURCE_ENTRY_CAPACITY_ERROR
            : source.cacheBudgetExceeded
              ? SOURCE_CACHE_CAPACITY_ERROR
              : AUTHORITATIVE_LEDGER_INCOMPLETE_ERROR),
      );
      globallyUnavailable = true;
    }
    return globallyUnavailable;
  }

  private updateSnapshotChain(
    state: SourceQueryState,
    generation: number | undefined,
    snapshot: string | undefined,
    complete: boolean | undefined,
    truncated: boolean | undefined,
    partial: boolean | undefined,
  ): boolean {
    const metadataComplete =
      complete === true &&
      truncated === false &&
      partial === false &&
      generation !== undefined &&
      snapshot !== undefined;
    if (state.pages.size === 0) {
      state.chainGeneration = generation ?? null;
      state.chainSnapshot = snapshot ?? null;
    } else if (state.chainGeneration !== generation || state.chainSnapshot !== snapshot) {
      state.chainMetadataConsistent = false;
    }
    if (!metadataComplete) state.chainMetadataConsistent = false;
    return state.chainMetadataConsistent;
  }

  private hasVerifiedFullSnapshot(state: SourceQueryState): boolean {
    return (
      state.chainMetadataConsistent &&
      [...state.pages.values()].some(
        (page) =>
          page.fullSnapshot &&
          page.complete === true &&
          page.truncated === false &&
          page.partial === false &&
          page.page.nextCursor === null,
      )
    );
  }

  private resolvePageRevision(
    source: SourceState,
    page: Awaited<ReturnType<MossMarketplaceSourceAdapter["fetchPage"]>>,
  ): {
    readonly generation: number | undefined;
    readonly snapshot: string | undefined;
    readonly sourceVersion: string | null;
  } {
    const revision = page.revision;
    if (!revision) {
      return {
        generation:
          typeof page.generation === "number" &&
          Number.isSafeInteger(page.generation) &&
          page.generation >= 0
            ? page.generation
            : undefined,
        snapshot: nonEmptyString(page.snapshot),
        sourceVersion: page.sourceVersion ?? null,
      };
    }
    const proof = page.revisionProof;
    const snapshot = nonEmptyString(page.snapshot);
    const sourceVersion = nonEmptyString(page.sourceVersion);
    if (
      !validGitSha(revision.commitSha) ||
      !validGitSha(revision.treeSha) ||
      !Array.isArray(revision.parents) ||
      revision.parents.some((parent) => !validGitSha(parent)) ||
      sourceVersion !== revision.commitSha ||
      snapshot !== revisionSnapshot(revision) ||
      !proof
    ) {
      throw new MossMarketplaceRemoteFetchError("REMOTE_UPSTREAM_REVISION_ORDER_UNPROVEN");
    }
    const previous = source.revisionRecord;
    let generation: number;
    if (!previous) {
      if (proof.relation !== "initial" || proof.previousCommitSha !== null) {
        throw new MossMarketplaceRemoteFetchError("REMOTE_UPSTREAM_REVISION_ORDER_UNPROVEN");
      }
      generation = 1;
    } else if (revision.commitSha === previous.revision.commitSha) {
      if (
        revision.treeSha !== previous.revision.treeSha ||
        proof.relation !== "same" ||
        proof.previousCommitSha !== previous.revision.commitSha
      ) {
        throw new MossMarketplaceRemoteFetchError("REMOTE_UPSTREAM_REVISION_ORDER_UNPROVEN");
      }
      generation = previous.generation;
    } else {
      if (proof.previousCommitSha !== previous.revision.commitSha) {
        throw new MossMarketplaceRemoteFetchError("REMOTE_UPSTREAM_REVISION_ORDER_UNPROVEN");
      }
      const directParent =
        proof.relation === "direct-parent" &&
        revision.parents.includes(previous.revision.commitSha);
      const comparedDescendant =
        proof.relation === "compare-ahead" &&
        Number.isSafeInteger(proof.aheadBy) &&
        proof.aheadBy >= 1 &&
        proof.behindBy === 0;
      if (!directParent && !comparedDescendant) {
        throw new MossMarketplaceRemoteFetchError("REMOTE_UPSTREAM_REVISION_ORDER_UNPROVEN");
      }
      generation = previous.generation + 1;
      if (!Number.isSafeInteger(generation)) {
        throw new MossMarketplaceRemoteFetchError("REMOTE_UPSTREAM_REVISION_ORDER_UNPROVEN");
      }
    }
    const record: MossMarketplaceRevisionChainRecord = {
      sourceId: source.source.id,
      generation,
      revision: {
        commitSha: revision.commitSha,
        treeSha: revision.treeSha,
        parents: [...revision.parents],
      },
    };
    source.revisionRecord = record;
    this.revisionChainStore.set(source.source.id, record);
    return { generation, snapshot, sourceVersion };
  }

  private async fetchSourcePage(
    source: SourceState,
    state: SourceQueryState,
    input: MossMarketplaceSourceFetchInput,
  ): Promise<void> {
    const pageKey = `${input.cursor ?? "<first>"}`;
    const cached = state.pages.get(pageKey);
    const nowMs = input.now.valueOf();
    if (
      cached &&
      cached.generation === state.generation &&
      nowMs - cached.fetchedAt < this.cacheTtlMs
    ) {
      this.updateSnapshotChain(
        state,
        cached.upstreamGeneration,
        cached.upstreamSnapshot,
        cached.complete,
        cached.truncated,
        cached.partial,
      );
      state.usedCache = true;
      state.nextCursor = cached.page.nextCursor;
      state.exhausted = cached.page.nextCursor === null;
      for (const candidate of cached.page.candidates) {
        const normalized = normalizedCandidate(candidate);
        const admitted = this.admitCandidate(source, state, normalized, {
          sourceId: source.source.id,
          sourceTier: source.source.tier,
          generation: cached.upstreamGeneration,
          snapshot: cached.upstreamSnapshot,
          sourceVersion: cached.sourceVersion,
          fullSnapshot: cached.fullSnapshot,
          partial: cached.partial,
          nextCursor: cached.page.nextCursor,
        });
        if (!admitted) {
          state.nextCursor = null;
          state.exhausted = true;
          break;
        }
      }
      state.upstreamGeneration = cached.upstreamGeneration;
      state.upstreamSnapshot = cached.upstreamSnapshot;
      return;
    }
    const page = await source.source.fetchPage({
      ...input,
      previousRevision: source.revisionRecord?.revision,
    });
    if (page.candidates.length > MAX_SOURCE_ENTRIES) {
      source.entryCapacityExceeded = true;
      state.lastError = SOURCE_ENTRY_CAPACITY_ERROR;
      state.lastFetchedAt = nowMs;
      state.lastAttemptAt = nowMs;
      state.fetchedThisCall = true;
      state.nextCursor = null;
      state.exhausted = true;
      return;
    }
    const normalized = {
      candidates: page.candidates.map(normalizedCandidate),
      nextCursor: page.nextCursor,
    };
    const revisionMetadata = this.resolvePageRevision(source, page);
    const pageGeneration = revisionMetadata.generation;
    const pageSnapshot = revisionMetadata.snapshot;
    const chainMetadataConsistent = this.updateSnapshotChain(
      state,
      pageGeneration,
      pageSnapshot,
      page.complete,
      page.truncated,
      page.partial,
    );
    const fullSnapshot =
      page.fullSnapshot === true &&
      page.complete === true &&
      page.truncated === false &&
      page.partial === false &&
      normalized.nextCursor === null &&
      pageGeneration !== undefined &&
      pageSnapshot !== undefined &&
      chainMetadataConsistent;
    const bytes = Buffer.byteLength(JSON.stringify(normalized), "utf8");
    const upstreamGeneration = pageGeneration ?? state.generation;
    const upstreamSnapshot = pageSnapshot ?? `${source.source.id}:upstream:unknown`;
    const preserveNegativeEvidence = normalized.candidates.some(
      (candidate) => candidate.withdrawal !== undefined && candidate.withdrawal !== null,
    );
    if (!this.admitPageBytes(source, state, pageKey, bytes, preserveNegativeEvidence)) {
      if (preserveNegativeEvidence) {
        state.lastError = SOURCE_CACHE_CAPACITY_ERROR;
        for (const candidate of normalized.candidates) {
          if (candidate.withdrawal === undefined || candidate.withdrawal === null) continue;
          this.admitCandidate(source, state, candidate, {
            sourceId: source.source.id,
            sourceTier: source.source.tier,
            generation: upstreamGeneration,
            snapshot: upstreamSnapshot,
            sourceVersion: revisionMetadata.sourceVersion,
            fullSnapshot,
            partial: page.partial,
            nextCursor: normalized.nextCursor,
          });
        }
      }
      state.lastFetchedAt = nowMs;
      state.lastAttemptAt = nowMs;
      state.fetchedThisCall = true;
      state.nextCursor = null;
      state.exhausted = true;
      return;
    }
    let projectedContextCount = state.candidateContexts.size;
    let projectedContextBytes = state.contextBytes;
    for (const candidate of normalized.candidates) {
      const context: CandidatePageContext = {
        sourceId: source.source.id,
        sourceTier: source.source.tier,
        generation: upstreamGeneration,
        snapshot: upstreamSnapshot,
        sourceVersion: revisionMetadata.sourceVersion,
        fullSnapshot,
        partial: page.partial,
        nextCursor: normalized.nextCursor,
      };
      const previous = state.candidateContexts.get(candidate.identity);
      const nextCount = projectedContextCount + (previous ? 0 : 1);
      const nextBytes =
        projectedContextBytes -
        (previous ? candidateContextBytes(previous) : 0) +
        candidateContextBytes(context);
      const isNegative = candidate.withdrawal !== undefined && candidate.withdrawal !== null;
      if (
        !isNegative &&
        (nextCount > this.maxCandidateContexts || nextBytes > this.maxCandidateContextBytes)
      ) {
        source.cacheBudgetExceeded = true;
        state.lastError = SOURCE_CACHE_CAPACITY_ERROR;
        state.lastFetchedAt = nowMs;
        state.lastAttemptAt = nowMs;
        state.fetchedThisCall = true;
        state.nextCursor = null;
        state.exhausted = true;
        return;
      }
      if (nextCount <= this.maxCandidateContexts && nextBytes <= this.maxCandidateContextBytes) {
        projectedContextCount = nextCount;
        projectedContextBytes = nextBytes;
      }
    }
    const previous = state.pages.get(pageKey);
    state.cacheBytes -= previous?.bytes ?? 0;
    state.pages.set(pageKey, {
      fetchedAt: nowMs,
      bytes,
      generation: state.generation,
      snapshot: upstreamSnapshot,
      upstreamGeneration,
      upstreamSnapshot,
      fullSnapshot,
      complete: page.complete === true,
      truncated: page.truncated,
      partial: page.partial,
      sourceVersion: revisionMetadata.sourceVersion,
      page: normalized,
    });
    state.cacheBytes += bytes;
    state.sourceVersion = revisionMetadata.sourceVersion ?? state.sourceVersion;
    state.upstreamGeneration = upstreamGeneration;
    state.upstreamSnapshot = upstreamSnapshot;
    state.lastFetchedAt = nowMs;
    state.fetchedThisCall = true;
    state.lastError = null;
    state.nextCursor = normalized.nextCursor;
    state.exhausted = normalized.nextCursor === null;
    for (const candidate of normalized.candidates) {
      const admitted = this.admitCandidate(source, state, candidate, {
        sourceId: source.source.id,
        sourceTier: source.source.tier,
        generation: upstreamGeneration,
        snapshot: upstreamSnapshot,
        sourceVersion: revisionMetadata.sourceVersion,
        fullSnapshot,
        partial: page.partial,
        nextCursor: normalized.nextCursor,
      });
      if (!admitted) {
        state.nextCursor = null;
        state.exhausted = true;
        break;
      }
    }
  }

  private async ensureSourceCoverage(
    source: SourceState,
    input: MossMarketplaceAggregationBrowseInput,
    offset: number,
    limit: number,
    mode: SourceCoverageMode = "catalog",
  ): Promise<SourceQueryState | undefined> {
    if (!source.source.supportedKinds.includes(input.kind)) return undefined;
    const queryText = mode === "authoritative-ledger" ? "" : remoteQuery(input.query);
    let state = this.stateFor(source, input.kind, queryText);
    state.coverageMode = mode;
    const nowMs = this.now().valueOf();
    if (
      (state.lastFetchedAt > 0 && nowMs - state.lastFetchedAt >= this.cacheTtlMs) ||
      (state.lastAttemptAt > 0 && nowMs - state.lastAttemptAt >= this.cacheTtlMs)
    ) {
      this.resetSource(source);
      state = this.stateFor(source, input.kind, queryText);
      state.coverageMode = mode;
    }
    state.usedCache = false;
    state.fetchedThisCall = false;
    state.lastAttemptAt = nowMs;
    if (!source.source.enabled) {
      this.enforceCacheBounds({ includeGlobal: false });
      return state;
    }
    if (source.cacheBudgetExceeded) {
      state.lastError = SOURCE_CACHE_CAPACITY_ERROR;
      if (mode === "authoritative-ledger") {
        source.authoritativeLedgerReady.delete(input.kind);
        source.authoritativeLedgerErrors.set(input.kind, SOURCE_CACHE_CAPACITY_ERROR);
      }
      this.enforceCacheBounds({ includeGlobal: false });
      return state;
    }
    if (mode === "authoritative-ledger" && state.lastError && state.pages.size === 0) {
      this.resetSource(source);
      state = this.stateFor(source, input.kind, queryText);
      state.coverageMode = mode;
      state.lastAttemptAt = nowMs;
    }
    if (state.lastError && state.pages.size === 0) {
      this.enforceCacheBounds({ includeGlobal: false });
      return state;
    }
    if (state.exhausted && state.pages.size > 0) {
      if (mode === "authoritative-ledger") {
        if (state.lastError || !this.hasVerifiedFullSnapshot(state)) {
          if (!state.lastError) {
            state.lastError = AUTHORITATIVE_LEDGER_INCOMPLETE_ERROR;
          }
          source.authoritativeLedgerReady.delete(input.kind);
          source.authoritativeLedgerErrors.set(input.kind, state.lastError);
        } else {
          source.authoritativeLedgerReady.add(input.kind);
          source.authoritativeLedgerErrors.delete(input.kind);
        }
        this.releaseTombstoneQuarantineAfterFullSnapshot(source, state);
      }
      state.usedCache = true;
      this.enforceCacheBounds({ includeGlobal: false });
      return state;
    }
    const queryTextIsPresent = Boolean(queryText);
    const pagesWanted =
      mode === "authoritative-ledger"
        ? MAX_AUTHORITATIVE_LEDGER_PAGES
        : queryTextIsPresent || offset > 0
          ? MAX_QUERY_PAGES
          : 1;
    let pagesRead = 0;
    while (!state.exhausted && pagesRead < pagesWanted) {
      const cursor = state.pages.size === 0 ? null : state.nextCursor;
      if (state.pages.size > 0 && cursor === null) break;
      try {
        await this.fetchSourcePage(source, state, {
          kind: input.kind,
          cursor,
          limit: Math.min(100, Math.max(limit, 25)),
          query: queryText,
          now: this.now(),
        });
      } catch (error) {
        state.lastError = errorMessage(error);
        break;
      }
      if (source.cacheBudgetExceeded || !this.isStateResident(source, state)) {
        state.lastError = SOURCE_CACHE_CAPACITY_ERROR;
        break;
      }
      pagesRead += 1;
      if (mode === "authoritative-ledger") {
        const fetchedPage = state.pages.get(cursor ?? "<first>");
        if (
          !fetchedPage ||
          fetchedPage.complete !== true ||
          fetchedPage.truncated !== false ||
          fetchedPage.partial !== false ||
          !state.chainMetadataConsistent
        ) {
          state.lastError = AUTHORITATIVE_LEDGER_INCOMPLETE_ERROR;
          break;
        }
      }
      if (mode === "catalog" && state.candidates.size >= offset + limit && !queryTextIsPresent) {
        break;
      }
    }
    if (mode === "authoritative-ledger" && !state.exhausted && !state.lastError) {
      state.lastError = AUTHORITATIVE_LEDGER_INCOMPLETE_ERROR;
    }
    if (mode === "authoritative-ledger") {
      if (state.exhausted && !state.lastError && this.hasVerifiedFullSnapshot(state)) {
        source.authoritativeLedgerReady.add(input.kind);
        source.authoritativeLedgerErrors.delete(input.kind);
        this.releaseTombstoneQuarantineAfterFullSnapshot(source, state);
      } else {
        if (!state.lastError) {
          state.lastError = AUTHORITATIVE_LEDGER_INCOMPLETE_ERROR;
        }
        source.authoritativeLedgerReady.delete(input.kind);
        source.authoritativeLedgerErrors.set(
          input.kind,
          state.lastError ?? AUTHORITATIVE_LEDGER_INCOMPLETE_ERROR,
        );
      }
    }
    if (pagesRead > 0 || state.lastError) {
      source.tombstoneRefreshPending = false;
    }
    this.enforceCacheBounds({ includeGlobal: false });
    return state;
  }

  private readCursor(
    value: string | undefined,
    kind: ProviderCatalogResourceKind,
    fingerprint: string,
    nowMs: number,
  ): StoredCursor | null {
    if (!value) return null;
    const cursor = this.cursors.get(value);
    if (!cursor) throw new MossMarketplaceCursorError("CURSOR_INVALID");
    if (cursor.used) throw new MossMarketplaceCursorError("CURSOR_REPLAY");
    if (cursor.expiresAt <= nowMs) {
      this.cursors.delete(value);
      throw new MossMarketplaceCursorError("CURSOR_EXPIRED");
    }
    if (cursor.kind !== kind) throw new MossMarketplaceCursorError("CURSOR_KIND_MISMATCH");
    if (cursor.fingerprint !== fingerprint) {
      throw new MossMarketplaceCursorError("CURSOR_QUERY_MISMATCH");
    }
    // Reserve before browse reaches its first await. The reservation is
    // deliberately not rolled back when a later source fetch fails.
    cursor.used = true;
    cursor.lastAccess = ++this.accessCounter;
    return cursor;
  }

  private issueCursor(input: Omit<StoredCursor, "token" | "lastAccess" | "used">): string {
    let token = randomBytes(24).toString("base64url");
    while (this.cursors.has(token)) token = randomBytes(24).toString("base64url");
    this.cursors.set(token, {
      ...input,
      token,
      lastAccess: ++this.accessCounter,
      used: false,
    });
    this.enforceCacheBounds();
    return token;
  }

  private validateCursorSources(
    cursor: StoredCursor | null,
    states: readonly {
      source: SourceState;
      state: SourceQueryState | undefined;
    }[],
  ): void {
    if (!cursor) return;
    for (const { source, state } of states) {
      const expectedGeneration = cursor.sourceGenerations[source.source.id];
      const expectedSnapshot = cursor.sourceSnapshots[source.source.id];
      if (expectedGeneration === undefined) {
        throw new MossMarketplaceCursorError("CURSOR_GENERATION_MISMATCH");
      }
      if (!state) {
        if (source.generation !== expectedGeneration || source.snapshot !== expectedSnapshot) {
          throw new MossMarketplaceCursorError("CURSOR_GENERATION_MISMATCH");
        }
        continue;
      }
      if (
        state.generation !== expectedGeneration ||
        state.snapshot !== expectedSnapshot ||
        source.generation !== expectedGeneration
      ) {
        throw new MossMarketplaceCursorError("CURSOR_GENERATION_MISMATCH");
      }
    }
  }

  private prepareTombstones(nowMs: number): void {
    for (const source of this.sources) {
      let expired = false;
      for (const record of source.tombstones.values()) {
        const expiresAt = record.withdrawal.value.expiresAt;
        if (expiresAt && new Date(expiresAt).valueOf() <= nowMs) {
          expired = true;
        }
      }
      if (expired && !source.tombstoneRefreshPending) {
        // An expired negative observation is still a safety fence. Refreshing
        // this source is required, but a low-tier active candidate cannot
        // revive it merely because the ordinary cache/tombstone TTL elapsed.
        source.tombstoneRefreshPending = true;
        this.resetSource(source);
      }
    }
  }

  private isAuthoritativeReinstatement(
    source: SourceState,
    tombstone: TombstoneRecord,
    context: CandidatePageContext | undefined,
  ): boolean {
    if (!context) return false;
    if (context.sourceId !== source.source.id) return false;
    if (context.sourceTier !== source.source.tier) return false;
    if (!context.fullSnapshot || context.partial !== false || context.nextCursor !== null) {
      return false;
    }
    if (
      !Number.isInteger(context.generation) ||
      context.generation <= tombstone.withdrawal.value.generation
    ) {
      return false;
    }
    if (!context.snapshot || context.snapshot === tombstone.withdrawal.value.snapshot) {
      return false;
    }
    return (
      context.sourceVersion !== tombstone.withdrawal.value.sourceVersion ||
      context.snapshot !== tombstone.withdrawal.value.snapshot
    );
  }

  private absorbSourceLedger(source: SourceState, state: SourceQueryState, now: Date): void {
    if (source.cacheBudgetExceeded || !this.isStateResident(source, state)) {
      source.cacheBudgetExceeded = true;
      state.lastError = SOURCE_CACHE_CAPACITY_ERROR;
      return;
    }
    const candidates = [...state.candidates.values()].map(normalizedCandidate);
    let tombstoneBytes = [...source.tombstones.values()].reduce(
      (sum, record) => sum + record.bytes,
      0,
    );
    let capacityExceeded = false;
    const negativeIdentities = new Set<string>();

    // Negative evidence may be merged from any coverage mode, including a
    // failed/partial state. It is never dropped, but a new record that would
    // exceed the source budget quarantines the source and stops this pass.
    for (const normalized of candidates) {
      const observation = sourceObservation(source.source, state, normalized, now);
      const candidateWithdrawal = withdrawalFromCandidate(
        normalized,
        observation,
        this.tombstoneTtlMs,
      );
      if (!candidateWithdrawal) continue;
      negativeIdentities.add(normalized.identity);
      const existing = source.tombstones.get(normalized.identity);
      const merged = mergeTombstoneLedger(existing?.withdrawal, candidateWithdrawal);
      const prior = existing;
      const candidate =
        !prior || authorityCompare(observation, prior.withdrawal.observation) >= 0
          ? normalized
          : prior.candidate;
      const bytes = Buffer.byteLength(
        JSON.stringify({ candidate, withdrawal: merged.value }),
        "utf8",
      );
      const nextCount = source.tombstones.size + (existing ? 0 : 1);
      const nextBytes = tombstoneBytes - (existing?.bytes ?? 0) + bytes;
      if (nextCount > this.maxTombstones || nextBytes > this.maxCacheTombstoneBytes) {
        source.tombstoneCapacityExceeded = true;
        source.tombstoneCapacityKinds.add(normalized.kind);
        state.lastError = SOURCE_TOMBSTONE_CAPACITY_ERROR;
        capacityExceeded = true;
        break;
      }
      source.tombstones.set(normalized.identity, {
        candidate,
        withdrawal: merged,
        lastAccess: ++this.accessCounter,
        bytes,
      });
      tombstoneBytes = nextBytes;
    }

    if (
      this.residentBudgetExceeded() &&
      !source.cacheBudgetExceeded &&
      !source.tombstoneCapacityExceeded &&
      !source.entryCapacityExceeded &&
      !this.hasOtherBudgetOwner(source)
    ) {
      // Attribute an admission overflow to the source whose page is being
      // absorbed. A later passive eviction must not quarantine an unrelated
      // healthy source.
      source.cacheBudgetExceeded = true;
      state.lastError = SOURCE_CACHE_CAPACITY_ERROR;
    }

    const canReinstate =
      !capacityExceeded &&
      state.coverageMode === "authoritative-ledger" &&
      state.exhausted &&
      state.lastError === null &&
      this.hasVerifiedFullSnapshot(state);
    if (!canReinstate) return;

    for (const normalized of candidates) {
      if (negativeIdentities.has(normalized.identity)) continue;
      const existing = source.tombstones.get(normalized.identity);
      if (
        existing &&
        this.isAuthoritativeReinstatement(
          source,
          existing,
          state.candidateContexts.get(normalized.identity),
        )
      ) {
        source.tombstones.delete(normalized.identity);
      }
    }
  }

  private releaseTombstoneQuarantineAfterFullSnapshot(
    source: SourceState,
    state: SourceQueryState | undefined,
  ): void {
    if (
      !state ||
      state.lastError ||
      state.coverageMode !== "authoritative-ledger" ||
      !state.exhausted ||
      !state.chainMetadataConsistent ||
      !this.hasVerifiedFullSnapshot(state)
    ) {
      return;
    }
    const tombstoneBytes = [...source.tombstones.values()].reduce(
      (sum, record) => sum + record.bytes,
      0,
    );
    if (
      source.tombstones.size <= this.maxTombstones &&
      tombstoneBytes <= this.maxCacheTombstoneBytes
    ) {
      source.tombstoneCapacityKinds.delete(state.kind);
      source.tombstoneCapacityExceeded = source.tombstoneCapacityKinds.size > 0;
    }
    source.entryCapacityExceeded = false;
  }

  async browse(input: MossMarketplaceAggregationBrowseInput): Promise<ProviderCatalogPage> {
    if (this.stateDir === undefined && input.stateDir !== undefined) {
      const { stateDir: _stateDir, ...delegatedInput } = input;
      return this.statefulChild(input.stateDir).browse(delegatedInput);
    }
    const now = this.now();
    this.prepareTombstones(now.valueOf());
    // A cache-pressure quarantine is scoped to the current admission attempt;
    // durable tombstone/entry capacity flags are cleared only by their own
    // successful source refresh rules.
    for (const source of this.sources) source.cacheBudgetExceeded = false;
    this.enforceCacheBounds();
    const query = input.query;
    const fingerprint = queryFingerprint(input.kind, query);
    const cursor = this.readCursor(query?.cursor, input.kind, fingerprint, now.valueOf());
    if (cursor && input.forceReload === true) {
      throw new MossMarketplaceCursorError("CURSOR_GENERATION_MISMATCH");
    }
    const limit = clampLimit(query?.limit);
    const sourceFilter = query?.sourceIds?.length ? new Set(query.sourceIds) : undefined;
    const selected = this.sources.filter(
      (source) => !sourceFilter || sourceFilter.has(source.source.id),
    );
    if (input.forceReload === true) {
      for (const source of selected) this.resetSource(source);
    }
    const authoritativeSources = this.sources.filter(
      (source) =>
        source.source.enabled &&
        source.source.tier === "official" &&
        source.source.supportedKinds.includes(input.kind),
    );
    const authoritativeStates = await Promise.all(
      authoritativeSources.map(async (source) => ({
        source,
        state: await this.ensureSourceCoverage(source, input, 0, limit, "authoritative-ledger"),
      })),
    );
    const positiveQueryText = remoteQuery(input.query);
    const authoritativeBySource = new Map(
      authoritativeStates.map(({ source, state }) => [source, state] as const),
    );
    const states = await Promise.all(
      selected.map(async (source) => {
        const authoritativeState = authoritativeBySource.get(source);
        const state =
          source.source.tier === "official" &&
          positiveQueryText === "" &&
          authoritativeState !== undefined
            ? authoritativeState
            : await this.ensureSourceCoverage(source, input, cursor?.offset ?? 0, limit);
        return { source, state };
      }),
    );
    this.validateCursorSources(cursor, states);
    if (cursor) cursor.used = true;

    const byIdentity = new Map<string, AggregateRecord>();
    const absorbedStates = new Set<SourceQueryState>();
    for (const { source, state } of authoritativeStates) {
      if (state) {
        this.absorbSourceLedger(source, state, now);
        this.releaseTombstoneQuarantineAfterFullSnapshot(source, state);
        absorbedStates.add(state);
      }
    }
    for (const { source, state } of states) {
      if (state) {
        if (!absorbedStates.has(state)) {
          this.absorbSourceLedger(source, state, now);
        }
      }
    }
    this.enforceCacheBounds();
    const authoritativeLedgerUnavailable = this.isAuthoritativeLedgerUnavailable(
      input.kind,
      authoritativeStates,
    );

    const addRecord = (
      source: SourceState,
      normalized: MossMarketplaceCandidate,
      observation: SourceObservation,
      withdrawal: FieldObservation<ProviderCatalogWithdrawal> | null,
    ): void => {
      const existing = byIdentity.get(normalized.identity);
      if (!existing) {
        byIdentity.set(
          normalized.identity,
          aggregateRecordForCandidate(normalized, observation, withdrawal),
        );
        return;
      }
      mergeCandidate(existing, normalized, observation, this.tombstoneTtlMs);
      existing.withdrawal = chooseWithdrawal(
        existing.withdrawal,
        withdrawal,
        existing.fields.identity,
      );
      void source;
    };

    // Authoritative negative evidence is global. A source filter is a
    // diagnostic/refresh scope and must never permit a lower-tier source to
    // resurrect an identity withdrawn by an authoritative source outside the
    // selected view. Quarantine suppresses only that source's positive state;
    // its tombstones continue to be projected globally.
    for (const source of this.sources) {
      for (const tombstone of source.tombstones.values()) {
        if (tombstone.candidate.kind !== input.kind) continue;
        const observation = tombstone.withdrawal.observation;
        addRecord(source, tombstone.candidate, observation, tombstone.withdrawal);
        tombstone.lastAccess = ++this.accessCounter;
      }
    }
    for (const { source, state } of states) {
      if (!state) continue;
      for (const candidate of state.candidates.values()) {
        if (
          !this.isStateResident(source, state) ||
          authoritativeLedgerUnavailable ||
          state.lastError === SOURCE_CACHE_CAPACITY_ERROR ||
          state.lastError === SOURCE_ENTRY_CAPACITY_ERROR ||
          state.lastError === SOURCE_TOMBSTONE_CAPACITY_ERROR ||
          source.tombstoneCapacityExceeded ||
          source.entryCapacityExceeded ||
          source.cacheBudgetExceeded
        ) {
          continue;
        }
        const normalized = normalizedCandidate(candidate);
        const observation = sourceObservation(source.source, state, normalized, now);
        const candidateWithdrawal = withdrawalFromCandidate(
          normalized,
          observation,
          this.tombstoneTtlMs,
        );
        addRecord(
          source,
          normalized,
          observation,
          chooseWithdrawal(
            source.tombstones.get(normalized.identity)?.withdrawal ?? null,
            candidateWithdrawal,
            { value: normalized.identity, observation },
          ),
        );
      }
    }

    const entries = [...byIdentity.values()]
      .map((record) => entryFromAggregate(record, now))
      .filter((entry) => matchesQuery(entry, query))
      .sort((left, right) => compareEntries(left, right, query?.sort ?? "quality"));
    const offset = cursor?.offset ?? 0;
    const pageEntries = entries.slice(offset, offset + limit);
    const remoteHasMore = states.some(({ source, state }) => {
      if (!source.source.enabled) return false;
      return Boolean(state?.nextCursor);
    });
    const hasMore = offset + pageEntries.length < entries.length || remoteHasMore;
    const sourceGenerations: Record<string, number> = {};
    const sourceSnapshots: Record<string, string> = {};
    for (const { source, state } of states) {
      sourceGenerations[source.source.id] = state?.generation ?? source.generation;
      sourceSnapshots[source.source.id] = state?.snapshot ?? source.snapshot;
    }
    const nextCursor = hasMore
      ? this.issueCursor({
          kind: input.kind,
          fingerprint,
          offset: offset + pageEntries.length,
          expiresAt: now.valueOf() + this.cursorTtlMs,
          sourceGenerations,
          sourceSnapshots,
        })
      : null;
    const sourceStatuses = states.map(({ source, state }) =>
      sourceStatus(
        source,
        state,
        authoritativeLedgerUnavailable ? AUTHORITATIVE_LEDGER_INCOMPLETE_ERROR : undefined,
      ),
    );
    const usedCacheOnly = states.every(({ source, state }) => {
      if (!source.source.enabled || !state) return true;
      if (state.pages.size === 0 && state.lastError) return true;
      return Boolean(state.usedCache && !state.fetchedThisCall);
    });
    const partial = remoteHasMore || sourceStatuses.some((status) => Boolean(status.error));
    const snapshot = sourceStatuses
      .map((status) => `${status.id}@${status.generation}:${status.snapshot}`)
      .sort()
      .join("|");
    return {
      kind: input.kind,
      entries: pageEntries,
      nextCursor,
      totalKnown: entries.length,
      partial,
      cached: usedCacheOnly,
      fetchedAt: nowIso(now),
      snapshot: snapshot || `empty:${input.kind}`,
      sources: sourceStatuses,
    };
  }
}

export const mossMarketplaceAggregation = new MossMarketplaceAggregation();

export const browseMossMarketplace = (
  input: MossMarketplaceAggregationBrowseInput,
): Promise<ProviderCatalogPage> => mossMarketplaceAggregation.browse(input);

export const clearMossMarketplaceAggregationCache = (): void =>
  mossMarketplaceAggregation.clearCache();
