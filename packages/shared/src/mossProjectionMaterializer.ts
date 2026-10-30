/**
 * Moss projection materializer (ported from 1code `moss-source/projection.ts`
 * plus the workspace orchestration subset of `runtime-materializer.ts`).
 *
 * Materializes governance mappings into provider-native paths with four
 * actions — symlink, copy, managed-bridge, adapter-inject — and records every
 * managed target in the projections manifest (layout `projectionsManifest`,
 * decoded through the `@synara/contracts` `MossProjectionManifest` schema).
 * The workspace manifest is a read-only compatibility/read-back view, never
 * an ownership authority. When an authority is injected, its private
 * append-only manifest is the source for mutation bookkeeping; without it,
 * target creation/replacement/deletion and manifest persistence are disabled.
 *
 * Moss-specific deltas vs 1code (disclosed):
 * - `copy` uses bounded no-follow reads and an in-memory frozen directory
 *   descriptor for new targets, so provider targets do not retain a live link
 *   to mutable plugin content. Existing replacement is delegated to the
 *   injected CAS capability or rejected.
 * - Managed-bridge and adapter-inject targets whose regenerated content hash
 *   equals the manifest entry (and whose on-disk bytes match) report
 *   `skipped` instead of 1code's unconditional `updated`, so re-materialize
 *   is observably idempotent.
 * - Plugin bundles remain catalog/runtime-plan resources; this generic
 *   materializer never claims that a bundle directory is executable. The
 *   server-owned plugin runtime may materialize selected component targets
 *   with the same managed manifest, but there is no generic plugin bridge
 *   table. There is no discovery retry loop, no `createIfMissing`/
 *   `expectedResourceIds`, and no
 *   `linkMossSourceIntoWorkspace` worktree helper — bootstrap stays in
 *   `mossSourceBootstrap`, runtime wiring lands in SY3.
 */
import { createHash, randomUUID } from "node:crypto";
import { access, lstat, opendir, open, readFile, readlink, realpath, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { Schema } from "effect";

import type {
  MossProjectionAction,
  MossProjectionManifestContributor,
  MossProjectionManifestEntry,
  MossProjectionMaterializeStatus,
  ProviderKind,
} from "@synara/contracts";
import { MossProjectionManifest } from "@synara/contracts";

import {
  MOSS_PROJECTION_ENGINE_IDS,
  buildMossEngineProjection,
  isMossProjectionEngineId,
  type MossEngineResourceProjection,
  type MossResourcePathMapping,
} from "./mossProjectionGovernance";
import { discoverMossSourceResources } from "./mossResourceRegistry";
import { MOSS_RELATIVE_PATHS, getMossSourceLayout } from "./mossSourceLayout";

export interface MossProjectionMaterializeResult {
  engineId: ProviderKind;
  resourceId: string;
  action: MossProjectionAction;
  sourcePath?: string | undefined;
  targetPath?: string | undefined;
  status: MossProjectionMaterializeStatus;
  reason?: string | undefined;
}

export interface MossProjectionManifestSummary {
  status: "found" | "missing" | "parse-error";
  sourcePath: string;
  generatedAt?: string | undefined;
  totalEntries: number;
  engines: Array<{ engineId: ProviderKind; entries: number }>;
  error?: string | undefined;
}

export interface MaterializeMossProjectionOptions {
  projectPath: string;
  projection: MossEngineResourceProjection;
  dryRun?: boolean | undefined;
  ownershipStore?: MossProjectionOwnershipStore | undefined;
  ownershipOwnerId?: string | undefined;
  ownershipGeneration?: string | undefined;
}

export interface RemoveMossProjectionResourceOptions {
  projectPath: string;
  resourceId: string;
  sourcePath?: string | undefined;
  targetPaths?: string[] | undefined;
  removeTargets?: boolean | undefined;
  ownershipStore?: MossProjectionOwnershipStore | undefined;
  ownershipOwnerId?: string | undefined;
  ownershipGeneration?: string | undefined;
}

export interface RemoveMossProjectionResourceResult {
  removedEntries: string[];
  removedTargets: string[];
  conflictedTargets?: string[];
}

export interface ReconcileMossProjectionResourcesOptions {
  projectPath: string;
  engineId: ProviderKind;
  resourceIdPrefix: string;
  keepResourceIds?: ReadonlySet<string> | undefined;
  ownershipStore?: MossProjectionOwnershipStore | undefined;
  ownershipOwnerId?: string | undefined;
  ownershipGeneration?: string | undefined;
}

const ADAPTER_MANIFEST_NAME = ".moss-adapter.json";
const MAX_PROJECTION_FILE_BYTES = 16 * 1024 * 1024;
const MAX_PROJECTION_ENTRIES = 1024;
const MAX_PROJECTION_DIRECTORY_DEPTH = 32;
const PRIVATE_PROJECTION_MANIFEST_VERSION = 3;

function projectionMutationTargetPath(entry: WorkingManifestEntry): string {
  if (entry.action !== "adapter-inject" || basename(entry.targetPath) === ADAPTER_MANIFEST_NAME) {
    return entry.targetPath;
  }
  return join(entry.targetPath, ADAPTER_MANIFEST_NAME);
}

export interface MossProjectionTargetIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly mode: number;
  readonly ctimeMs: number;
}

export interface MossProjectionRootIdentity {
  readonly realpath: string;
  readonly dev: string;
  readonly ino: string;
  readonly ctimeMs: number;
}

export interface MossProjectionOwnershipMutationRequest {
  readonly projectRoot: string;
  readonly projectRootIdentity: MossProjectionRootIdentity;
  readonly canonicalRoot: {
    readonly rootPath: string;
    readonly identityFingerprint: string;
  };
  readonly ownerId: string;
  readonly targetAbs: string;
  readonly targetIdentity?: MossProjectionTargetIdentity | undefined;
  readonly expectedFingerprint: string;
  /** Content hash observed immediately before the authority CAS operation. */
  readonly expectedBeforeHash: string;
  /** Desired post-publish content hash; absent only for remove. */
  readonly contentHash?: string | undefined;
  readonly operationId: string;
  readonly fencingToken: string;
  readonly action: MossProjectionAction;
  readonly resourceIds: ReadonlyArray<string>;
  readonly sourcePaths: ReadonlyArray<string>;
  readonly generation: string;
  readonly nonce: string;
  readonly expectedAfterState: "present" | "absent";
  /** The authority must commit this journal record in the same operation. */
  readonly privateManifest: MossProjectionPrivateManifestInput;
}

export type MossProjectionMutationAfterState =
  | {
      readonly state: "present";
      readonly identity: MossProjectionTargetIdentity;
      readonly fingerprint: string;
      readonly contentHash: string;
    }
  | {
      readonly state: "absent";
      readonly fingerprint: "absent";
      readonly contentHash: "absent";
    };

export interface MossProjectionOwnershipMutationReceipt {
  readonly operationId: string;
  readonly canonicalRoot: {
    readonly rootPath: string;
    readonly identityFingerprint: string;
  };
  readonly expectedFingerprint: string;
  readonly observedFingerprint: string;
  readonly expectedBeforeHash: string;
  readonly after: MossProjectionMutationAfterState;
  readonly fencingToken: string;
  readonly generation: string;
  readonly nonce: string;
  readonly manifest: MossProjectionPrivateManifestReceipt;
  readonly durable: true;
}

export type MossProjectionOwnershipMutationResult =
  | {
      readonly status: "applied";
      readonly receipt: MossProjectionOwnershipMutationReceipt;
    }
  | {
      readonly status: "missing" | "conflict" | "unsupported" | "recovery-needed";
      readonly reason?: string | undefined;
    };

export interface MossOwnershipMutationScope {
  readonly projectRoot: string;
  readonly projectRootIdentity: MossProjectionRootIdentity;
  readonly ownerId: string;
  readonly generation: string;
  readonly operationId: string;
  readonly nonce: string;
}

export interface MossProjectionPrivateManifestInput {
  readonly fileName: string;
  readonly transactionId: string;
  readonly operationId: string;
  readonly sequence: number;
  readonly previousHash: string;
  readonly recordHash: string;
  readonly value: unknown;
}

export interface MossProjectionPrivateManifestReceipt {
  readonly locator: string;
  readonly transactionId: string;
  readonly operationId: string;
  readonly sequence: number;
  readonly previousHash: string;
  readonly recordHash: string;
}

export interface MossProjectionPrivateManifest {
  readonly locator: string;
  readonly transactionId: string;
  readonly operationId: string;
  readonly sequence: number;
  readonly previousHash: string;
  readonly recordHash: string;
  readonly value: unknown;
}

export interface MossProjectionFrozenDirectoryEntry {
  readonly relativePath: string;
  readonly kind: "file" | "directory";
  readonly content?: Buffer | undefined;
}

/**
 * Bounded, immutable-at-the-boundary projection data.  The shared
 * materializer may read a source into this descriptor, but it never creates a
 * temporary path in the provider/workspace tree.  A server-owned store must
 * stage this descriptor under its private state directory before touching a
 * canonical target.
 */
export type MossProjectionFrozenTarget =
  | {
      readonly kind: "file";
      readonly content: Buffer;
      readonly contentHash: string;
    }
  | {
      readonly kind: "directory";
      readonly entries: ReadonlyArray<MossProjectionFrozenDirectoryEntry>;
      readonly contentHash: string;
    }
  | {
      readonly kind: "symlink";
      readonly target: string;
      readonly linkType: "file" | "dir" | "junction";
    };

/**
 * Narrow, replaceable adapter seam for the generic server-owned
 * `MossOwnershipStore` being integrated by #116. The durable implementation
 * belongs under the server's `stateDir/moss-authority`; this package
 * deliberately provides no fallback store. The generic authority owns
 * private staging, workspace locking, manifest writes, and target CAS for
 * create/replace/remove.
 */
export interface MossProjectionOwnershipStore {
  withMutationLock<T>(
    scope: MossOwnershipMutationScope,
    operation: (fencingToken: string) => Promise<T>,
  ): Promise<T>;
  appendPrivateManifest(
    input: MossProjectionPrivateManifestInput,
  ): Promise<MossProjectionPrivateManifestReceipt>;
  readPrivateManifest(input: {
    readonly fileName: string;
  }): Promise<MossProjectionPrivateManifest | null>;
  create(
    request: MossProjectionOwnershipMutationRequest,
    target: MossProjectionFrozenTarget,
  ): Promise<MossProjectionOwnershipMutationResult>;
  publish(
    request: MossProjectionOwnershipMutationRequest,
    target: MossProjectionFrozenTarget,
  ): Promise<MossProjectionOwnershipMutationResult>;
  replace(
    request: MossProjectionOwnershipMutationRequest,
    target: MossProjectionFrozenTarget,
  ): Promise<MossProjectionOwnershipMutationResult>;
  remove(
    request: MossProjectionOwnershipMutationRequest,
  ): Promise<MossProjectionOwnershipMutationResult>;
}

interface ProjectionOwnershipContext {
  readonly store?: MossProjectionOwnershipStore | undefined;
  readonly ownerId?: string | undefined;
  readonly projectRoot: string;
  readonly projectRootIdentity: MossProjectionRootIdentity;
  readonly generation: string;
  readonly fencingToken?: string | undefined;
}

type WorkingManifestEntry = MossProjectionManifestEntry;

/** Mutable in-memory working copy of the schema'd manifest. */
interface WorkingManifest {
  version: 1;
  generatedAt: string;
  entries: Record<string, WorkingManifestEntry>;
  privateSequence?: number | undefined;
  privateRecordHash?: string | undefined;
}

const decodeProjectionManifest = Schema.decodeUnknownSync(MossProjectionManifest);

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readProjectionFileNoFollow(
  filePath: string,
  maxBytes = MAX_PROJECTION_FILE_BYTES,
): Promise<Buffer> {
  const handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) throw new Error("projection path is not a regular file");
    if (fileStat.size > maxBytes) {
      throw new Error("projection file exceeds the bounded file limit");
    }
    const size = Number(fileStat.size);
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const result = await handle.read(bytes, offset, size - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const afterStat = await handle.stat();
    if (
      afterStat.dev !== fileStat.dev ||
      afterStat.ino !== fileStat.ino ||
      afterStat.size !== fileStat.size ||
      afterStat.mtimeMs !== fileStat.mtimeMs ||
      offset !== size
    ) {
      throw new Error("projection file changed while it was being read");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function normalizePathKey(projectPath: string, filePath: string): string {
  const normalizedProjectPath = resolve(projectPath);
  const normalizedFilePath = resolve(filePath);
  if (
    normalizedFilePath === normalizedProjectPath ||
    normalizedFilePath.startsWith(`${normalizedProjectPath}${sep}`)
  ) {
    return relative(normalizedProjectPath, normalizedFilePath);
  }
  return normalizedFilePath;
}

function resolveProjectionPath(projectPath: string, mappingPath: string): string {
  if (mappingPath.startsWith("~/")) {
    return join(homedir(), mappingPath.slice(2));
  }
  if (isAbsolute(mappingPath)) return mappingPath;
  return join(projectPath, mappingPath);
}

function resolveProjectionTargetPath(projectPath: string, mappingPath: string): string {
  if (
    mappingPath.includes("\0") ||
    isAbsolute(mappingPath) ||
    mappingPath.startsWith("~/") ||
    /^[A-Za-z]:[\\/]/.test(mappingPath) ||
    mappingPath.startsWith("\\\\")
  ) {
    throw new Error("Projection target must be a bounded relative path under the canonical root.");
  }
  const segments = mappingPath.split(/[\\/]+/);
  if (segments.some((segment) => segment === ".." || segment === "." || segment.length === 0)) {
    throw new Error("Projection target path contains an unsafe relative segment.");
  }
  const projectRoot = resolve(projectPath);
  const targetAbs = resolve(projectRoot, mappingPath);
  const targetRelative = relative(projectRoot, targetAbs);
  if (targetRelative === "" || targetRelative.startsWith("..") || targetRelative.startsWith(sep)) {
    throw new Error("Projection target escaped the canonical project root.");
  }
  return targetAbs;
}

function projectionSourceBoundaryRoot(sourceAbs: string, projectRoot: string): string {
  const relativeSource = relative(resolve(projectRoot), resolve(sourceAbs));
  return relativeSource === "" ||
    (!relativeSource.startsWith("..") && !relativeSource.startsWith(sep))
    ? resolve(projectRoot)
    : dirname(sourceAbs);
}

function hashContent(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function canonicalManifestValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalManifestValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalManifestValue(child)]),
    );
  }
  return value;
}

/** Recompute the v3 journal record hash; this is integrity, not authority. */
export function mossProjectionPrivateManifestRecordHash(input: {
  readonly operationId: string;
  readonly sequence: number;
  readonly previousHash: string;
  readonly value: unknown;
}): string {
  return hashContent(
    JSON.stringify(
      canonicalManifestValue({
        version: PRIVATE_PROJECTION_MANIFEST_VERSION,
        operationId: input.operationId,
        sequence: input.sequence,
        previousHash: input.previousHash,
        value: input.value,
      }),
    ),
  );
}

/** Hash a provider projection without following the target itself or its children. */
export async function mossProjectionContentHash(filePath: string): Promise<string> {
  const digest = createHash("sha256");
  const budget = { entries: 0, bytes: 0 };
  const visit = async (currentPath: string, relativePath: string, depth: number): Promise<void> => {
    if (depth > MAX_PROJECTION_DIRECTORY_DEPTH) {
      throw new Error("projection directory nesting exceeds the safety limit");
    }
    budget.entries += 1;
    if (budget.entries > MAX_PROJECTION_ENTRIES) {
      throw new Error("projection contains too many entries");
    }
    const currentStat = await lstat(currentPath);
    if (currentStat.isSymbolicLink())
      throw new Error("projection content contains a symbolic link");
    digest.update(`${relativePath}\0${currentStat.isDirectory() ? "dir" : "file"}\0`);
    if (currentStat.isDirectory()) {
      const directory = await opendir(currentPath);
      const children: string[] = [];
      try {
        for await (const child of directory) {
          if (children.length >= MAX_PROJECTION_ENTRIES) {
            throw new Error("projection contains too many directory entries");
          }
          children.push(child.name);
        }
      } finally {
        await directory.close?.()?.catch(() => undefined);
      }
      for (const child of children.toSorted()) {
        await visit(
          join(currentPath, child),
          relativePath ? relativePath + "/" + child : child,
          depth + 1,
        );
      }
      return;
    }
    if (!currentStat.isFile()) throw new Error("projection content is not a regular file");
    const content = await readProjectionFileNoFollow(currentPath);
    budget.bytes += content.byteLength;
    if (budget.bytes > MAX_PROJECTION_FILE_BYTES) {
      throw new Error("projection content exceeds the bounded byte limit");
    }
    digest.update(content);
  };
  await visit(filePath, "", 0);
  return digest.digest("hex");
}

function manifestPathFor(projectPath: string): string {
  return getMossSourceLayout(projectPath).projectionsManifest;
}

function freshManifest(): WorkingManifest {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: {},
  };
}

/**
 * Lenient manifest read: any unreadable/undecodable manifest falls back to a
 * fresh empty manifest for catalog/bookkeeping reads. It never grants
 * ownership or enables destructive target mutation.
 */
const PRIVATE_PROJECTION_MANIFEST_FILE = "projection-manifest.v3.json";

async function readManifest(
  projectPath: string,
  ownership?: ProjectionOwnershipContext,
): Promise<WorkingManifest> {
  if (ownership?.store) {
    const privateManifest = await ownership.store.readPrivateManifest({
      fileName: PRIVATE_PROJECTION_MANIFEST_FILE,
    });
    if (!privateManifest) return freshManifest();
    const decoded = decodeProjectionManifest(privateManifest.value);
    const expectedRecordHash = mossProjectionPrivateManifestRecordHash(privateManifest);
    if (
      !Number.isSafeInteger(privateManifest.sequence) ||
      privateManifest.sequence < 1 ||
      !/^[0-9a-f]{64}$/.test(privateManifest.previousHash) ||
      (privateManifest.sequence === 1 && privateManifest.previousHash !== "0".repeat(64)) ||
      !/^[0-9a-f]{64}$/.test(privateManifest.recordHash) ||
      privateManifest.recordHash !== expectedRecordHash ||
      !privateManifest.operationId
    ) {
      throw new Error("Private Moss projection manifest receipt is invalid.");
    }
    return {
      version: decoded.version,
      generatedAt: decoded.generatedAt,
      entries: { ...decoded.entries },
      privateSequence: privateManifest.sequence,
      privateRecordHash: privateManifest.recordHash,
    };
  }
  // The workspace manifest is user-controlled compatibility/read-back data.
  // Without the server-owned private journal it must not influence mutation,
  // idempotence, or cleanup decisions.
  return freshManifest();
}

/** Compatibility/read-back only. Never use this value to authorize a mutation. */
async function readCompatibilityManifest(projectPath: string): Promise<WorkingManifest> {
  try {
    const raw = (await readProjectionFileNoFollow(manifestPathFor(projectPath))).toString("utf8");
    const decoded = decodeProjectionManifest(JSON.parse(raw));
    return {
      version: decoded.version,
      generatedAt: decoded.generatedAt,
      entries: { ...decoded.entries },
    };
  } catch {
    return freshManifest();
  }
}

async function buildProjectionOwnershipContext(options: {
  projectPath: string;
  ownershipStore?: MossProjectionOwnershipStore | undefined;
  ownershipOwnerId?: string | undefined;
  ownershipGeneration?: string | undefined;
}): Promise<ProjectionOwnershipContext> {
  const projectRoot = await realpath(resolve(options.projectPath));
  const rootStat = await lstat(projectRoot);
  if (!rootStat.isDirectory()) throw new Error("Projection project root is not a directory.");
  return {
    ...(options.ownershipStore ? { store: options.ownershipStore } : {}),
    ...(options.ownershipOwnerId ? { ownerId: options.ownershipOwnerId } : {}),
    projectRoot,
    projectRootIdentity: {
      realpath: projectRoot,
      dev: String(rootStat.dev),
      ino: String(rootStat.ino),
      ctimeMs: rootStat.ctimeMs,
    },
    generation: options.ownershipGeneration ?? randomUUID(),
  };
}

export function mossProjectionIdentityFingerprint(
  identity: MossProjectionTargetIdentity | MossProjectionRootIdentity,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        dev: identity.dev,
        ino: identity.ino,
        mode: "mode" in identity ? identity.mode : undefined,
        ctimeMs: identity.ctimeMs,
        realpath: "realpath" in identity ? identity.realpath : undefined,
      }),
    )
    .digest("hex");
}

function projectionManifestValue(
  manifest: WorkingManifest,
  entries = manifest.entries,
): {
  readonly version: number;
  readonly generatedAt: string;
  readonly entries: Record<string, WorkingManifestEntry>;
} {
  return {
    version: manifest.version,
    generatedAt: new Date().toISOString(),
    entries: { ...entries },
  };
}

function projectionManifestValueWithEntry(
  manifest: WorkingManifest,
  entryKey: string,
  entry: WorkingManifestEntry,
): {
  readonly version: number;
  readonly generatedAt: string;
  readonly entries: Record<string, WorkingManifestEntry>;
} {
  return projectionManifestValue(manifest, { ...manifest.entries, [entryKey]: entry });
}

function projectionManifestValueWithoutEntry(
  manifest: WorkingManifest,
  entryKey: string,
): {
  readonly version: number;
  readonly generatedAt: string;
  readonly entries: Record<string, WorkingManifestEntry>;
} {
  const entries = { ...manifest.entries };
  delete entries[entryKey];
  return projectionManifestValue(manifest, entries);
}

function buildPrivateManifestInput(params: {
  ownership: ProjectionOwnershipContext;
  manifest: WorkingManifest;
  operationId: string;
  value: unknown;
}): MossProjectionPrivateManifestInput {
  const sequence = (params.manifest.privateSequence ?? 0) + 1;
  const previousHash = params.manifest.privateRecordHash ?? "0".repeat(64);
  return {
    fileName: PRIVATE_PROJECTION_MANIFEST_FILE,
    transactionId: params.ownership.generation,
    operationId: params.operationId,
    sequence,
    previousHash,
    recordHash: mossProjectionPrivateManifestRecordHash({
      operationId: params.operationId,
      sequence,
      previousHash,
      value: params.value,
    }),
    value: params.value,
  };
}

function applyPrivateManifestReceipt(
  manifest: WorkingManifest,
  receipt: MossProjectionPrivateManifestReceipt,
): void {
  manifest.privateSequence = receipt.sequence;
  manifest.privateRecordHash = receipt.recordHash;
}

async function appendProjectionManifestWhenNoMutation(
  ownership: ProjectionOwnershipContext,
  manifest: WorkingManifest,
): Promise<void> {
  if (!ownership.store || !ownership.ownerId) return;
  const operationId = randomUUID();
  const input = buildPrivateManifestInput({
    ownership,
    manifest,
    operationId,
    value: projectionManifestValue(manifest),
  });
  const receipt = await ownership.store.appendPrivateManifest(input);
  if (
    receipt.transactionId !== input.transactionId ||
    receipt.operationId !== input.operationId ||
    receipt.sequence !== input.sequence ||
    receipt.previousHash !== input.previousHash ||
    receipt.recordHash !== input.recordHash
  ) {
    throw new Error(
      "Server-owned Moss authority returned an unverifiable private manifest receipt.",
    );
  }
  applyPrivateManifestReceipt(manifest, receipt);
}

function buildProjectionOwnershipRequest(params: {
  ownership: ProjectionOwnershipContext;
  manifest: WorkingManifest;
  manifestValue: unknown;
  targetAbs: string;
  targetIdentity?: MossProjectionTargetIdentity | undefined;
  expectedBeforeHash?: string | undefined;
  expectedAfterState?: "present" | "absent" | undefined;
  action: MossProjectionAction;
  resourceIds: ReadonlyArray<string>;
  sourcePaths: ReadonlyArray<string | undefined>;
  contentHash?: string | undefined;
}): MossProjectionOwnershipMutationRequest | undefined {
  if (!params.ownership.store || !params.ownership.ownerId || !params.ownership.fencingToken) {
    return undefined;
  }
  const operationId = randomUUID();
  const privateManifest = buildPrivateManifestInput({
    ownership: params.ownership,
    manifest: params.manifest,
    operationId,
    value: params.manifestValue,
  });
  return {
    projectRoot: params.ownership.projectRoot,
    projectRootIdentity: params.ownership.projectRootIdentity,
    canonicalRoot: {
      rootPath: params.ownership.projectRoot,
      identityFingerprint: mossProjectionIdentityFingerprint(params.ownership.projectRootIdentity),
    },
    ownerId: params.ownership.ownerId,
    targetAbs: resolve(params.targetAbs),
    ...(params.targetIdentity ? { targetIdentity: params.targetIdentity } : {}),
    expectedFingerprint: params.targetIdentity
      ? mossProjectionIdentityFingerprint(params.targetIdentity)
      : "absent",
    expectedBeforeHash: params.expectedBeforeHash ?? (params.targetIdentity ? "unknown" : "absent"),
    operationId,
    fencingToken: params.ownership.fencingToken,
    action: params.action,
    resourceIds: [...params.resourceIds],
    sourcePaths: params.sourcePaths.filter(
      (sourcePath): sourcePath is string => sourcePath !== undefined,
    ),
    ...(params.contentHash ? { contentHash: params.contentHash } : {}),
    generation: params.ownership.generation,
    nonce: operationId,
    expectedAfterState: params.expectedAfterState ?? "present",
    privateManifest,
  };
}

function validateDurableMutationResult(
  result: MossProjectionOwnershipMutationResult,
  request: MossProjectionOwnershipMutationRequest,
): MossProjectionOwnershipMutationResult {
  if (result.status !== "applied") return result;
  const receipt = result.receipt;
  const expectedManifest = request.privateManifest;
  const manifestValid =
    receipt.manifest.transactionId === expectedManifest.transactionId &&
    receipt.manifest.operationId === expectedManifest.operationId &&
    receipt.manifest.sequence === expectedManifest.sequence &&
    receipt.manifest.previousHash === expectedManifest.previousHash &&
    receipt.manifest.recordHash === expectedManifest.recordHash &&
    receipt.manifest.recordHash === mossProjectionPrivateManifestRecordHash(expectedManifest);
  const rootValid =
    receipt.canonicalRoot.rootPath === request.canonicalRoot.rootPath &&
    receipt.canonicalRoot.identityFingerprint === request.canonicalRoot.identityFingerprint;
  const commonValid =
    receipt.operationId === request.operationId &&
    receipt.durable === true &&
    receipt.expectedFingerprint === request.expectedFingerprint &&
    receipt.expectedBeforeHash === request.expectedBeforeHash &&
    receipt.fencingToken === request.fencingToken &&
    receipt.generation === request.generation &&
    receipt.nonce === request.nonce &&
    manifestValid &&
    rootValid;
  const afterValid =
    request.expectedAfterState === "present"
      ? receipt.after.state === "present" &&
        receipt.after.fingerprint === mossProjectionIdentityFingerprint(receipt.after.identity) &&
        receipt.observedFingerprint === receipt.after.fingerprint &&
        receipt.after.contentHash === (request.contentHash ?? "")
      : receipt.after.state === "absent" &&
        receipt.after.fingerprint === "absent" &&
        receipt.after.contentHash === "absent" &&
        receipt.observedFingerprint === "absent";
  if (!commonValid || !afterValid) {
    return {
      status: "conflict",
      reason: "Moss authority returned an unverifiable mutation or manifest receipt.",
    };
  }
  return result;
}

function unsupportedExistingMutation(reason: string): MossProjectionOwnershipMutationResult {
  return { status: "unsupported", reason };
}

function unsupportedNewMutation(reason: string): MossProjectionOwnershipMutationResult {
  return { status: "unsupported", reason };
}

function frozenProjectionTargetContentHash(target: MossProjectionFrozenTarget): string {
  if (target.kind === "file" || target.kind === "directory") return target.contentHash;
  return hashContent(`symlink\0${target.target}`);
}

async function assertNoSymlinkParent(targetAbs: string, boundaryRoot?: string): Promise<void> {
  const boundary = boundaryRoot ? resolve(boundaryRoot) : undefined;
  let current = dirname(targetAbs);
  while (true) {
    if (boundary) {
      const relativeToBoundary = relative(boundary, current);
      if (relativeToBoundary.startsWith("..") || relativeToBoundary.startsWith(sep)) {
        throw new Error("projection path escaped the canonical root while checking parents");
      }
    }
    try {
      const parentStat = await lstat(current);
      if (parentStat.isSymbolicLink()) {
        throw new Error(`projection target has a symbolic-link parent: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const next = dirname(current);
        if (next === current) return;
        current = next;
        continue;
      }
      throw error;
    }
    if (boundary && current === boundary) return;
    const next = dirname(current);
    if (next === current) return;
    current = next;
  }
}

async function snapshotProjectionDirectory(
  sourceAbs: string,
  boundaryRoot?: string,
): Promise<MossProjectionFrozenTarget> {
  const budget = { entries: 0, bytes: 0 };
  const entries: MossProjectionFrozenDirectoryEntry[] = [];

  const visit = async (currentPath: string, relativePath: string, depth: number): Promise<void> => {
    if (depth > MAX_PROJECTION_DIRECTORY_DEPTH) {
      throw new Error("projection directory nesting exceeds the safety limit");
    }
    budget.entries += 1;
    if (budget.entries > MAX_PROJECTION_ENTRIES) {
      throw new Error("projection contains too many entries");
    }
    const currentStat = await lstat(currentPath);
    if (currentStat.isSymbolicLink()) {
      throw new Error("Projection copy source may not be a symbolic link.");
    }
    if (currentStat.isDirectory()) {
      if (relativePath) entries.push({ relativePath, kind: "directory" });
      const directory = await opendir(currentPath);
      const children: string[] = [];
      try {
        for await (const child of directory) {
          if (children.length >= MAX_PROJECTION_ENTRIES) {
            throw new Error("projection contains too many directory entries");
          }
          children.push(child.name);
        }
      } finally {
        await directory.close?.()?.catch(() => undefined);
      }
      for (const child of children.toSorted()) {
        await visit(
          join(currentPath, child),
          relativePath ? `${relativePath}/${child}` : child,
          depth + 1,
        );
      }
      return;
    }
    if (!currentStat.isFile()) {
      throw new Error("Projection copy source is not a regular file.");
    }
    const content = await readProjectionFileNoFollow(currentPath);
    budget.bytes += content.byteLength;
    if (budget.bytes > MAX_PROJECTION_FILE_BYTES) {
      throw new Error("projection content exceeds the bounded byte limit");
    }
    entries.push({ relativePath, kind: "file", content });
  };

  await assertNoSymlinkParent(sourceAbs, boundaryRoot);
  await visit(sourceAbs, "", 0);
  return {
    kind: "directory",
    entries,
    contentHash: await mossProjectionContentHash(sourceAbs),
  };
}

async function snapshotProjectionTarget(
  sourceAbs: string,
  sourceStat: import("node:fs").Stats,
  expectedHash?: string,
  boundaryRoot?: string,
): Promise<MossProjectionFrozenTarget> {
  if (sourceStat.isDirectory()) {
    const snapshot = await snapshotProjectionDirectory(sourceAbs, boundaryRoot);
    if (expectedHash && snapshot.kind === "directory" && snapshot.contentHash !== expectedHash) {
      throw new Error("Copy source changed during directory snapshot.");
    }
    return snapshot;
  }
  const content = await readProjectionFileNoFollow(sourceAbs);
  const contentHash = hashContent(content);
  if (expectedHash && contentHash !== expectedHash) {
    throw new Error("Copy source changed during file snapshot.");
  }
  return { kind: "file", content, contentHash };
}

async function withProjectionMutationLock<T>(
  options: {
    projectPath: string;
    ownershipStore?: MossProjectionOwnershipStore | undefined;
    ownershipOwnerId?: string | undefined;
    ownershipGeneration?: string | undefined;
  },
  operation: (ownership: ProjectionOwnershipContext) => Promise<T>,
  dryRun = false,
): Promise<T> {
  const ownership = await buildProjectionOwnershipContext(options);
  if (!hasProjectionMutationAuthority(options.ownershipStore, options.ownershipOwnerId) || dryRun) {
    return operation(ownership);
  }
  const operationId = randomUUID();
  const nonce = randomUUID();
  return ownership.store!.withMutationLock(
    {
      projectRoot: ownership.projectRoot,
      projectRootIdentity: ownership.projectRootIdentity,
      ownerId: ownership.ownerId!,
      generation: ownership.generation,
      operationId,
      nonce,
    },
    (fencingToken) => operation({ ...ownership, fencingToken }),
  );
}

function summarizeManifest(
  manifest: WorkingManifest,
  sourcePath: string,
): MossProjectionManifestSummary {
  const counts = new Map<ProviderKind, number>();
  for (const entry of Object.values(manifest.entries)) {
    counts.set(entry.engineId, (counts.get(entry.engineId) ?? 0) + 1);
  }

  return {
    status: "found",
    sourcePath,
    generatedAt: manifest.generatedAt,
    totalEntries: Object.keys(manifest.entries).length,
    engines: Array.from(counts.entries())
      .map(([engineId, entries]) => ({ engineId, entries }))
      .toSorted((a, b) => a.engineId.localeCompare(b.engineId)),
  };
}

export async function readMossProjectionManifestSummary(
  projectPath: string,
): Promise<MossProjectionManifestSummary> {
  const manifestPath = manifestPathFor(projectPath);
  if (!(await pathExists(manifestPath))) {
    return {
      status: "missing",
      sourcePath: manifestPath,
      totalEntries: 0,
      engines: [],
    };
  }

  try {
    const raw = (await readProjectionFileNoFollow(manifestPath)).toString("utf8");
    const decoded = decodeProjectionManifest(JSON.parse(raw));
    return summarizeManifest(
      {
        version: decoded.version,
        generatedAt: decoded.generatedAt,
        entries: { ...decoded.entries },
      },
      manifestPath,
    );
  } catch (error) {
    return {
      status: "parse-error",
      sourcePath: manifestPath,
      totalEntries: 0,
      engines: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function removeMossProjectionResource(
  options: RemoveMossProjectionResourceOptions,
): Promise<RemoveMossProjectionResourceResult> {
  return withProjectionMutationLock(options, (ownership) =>
    removeMossProjectionResourceUnlocked(options, ownership),
  );
}

/**
 * Reconcile only manifest-owned resources under a namespace. This is used by
 * the plugin runtime when a component is revoked, disabled, or disappears
 * from discovery. A target without an injected server-owned CAS decision is
 * left in place and retains its bookkeeping entry for recovery; user content
 * is never deleted as a side effect of reconciliation.
 */
export function reconcileMossProjectionResources(
  options: ReconcileMossProjectionResourcesOptions,
): Promise<RemoveMossProjectionResourceResult> {
  return withProjectionMutationLock(options, async (ownership) => {
    const manifestPath = manifestPathFor(ownership.projectRoot);
    const hasAuthority = hasProjectionMutationAuthority(
      options.ownershipStore,
      options.ownershipOwnerId,
    );
    if (!hasAuthority && !(await pathExists(manifestPath))) {
      return { removedEntries: [], removedTargets: [] };
    }
    const manifest = hasAuthority
      ? await readManifest(ownership.projectRoot, ownership)
      : await readCompatibilityManifest(ownership.projectRoot);
    const removedEntries: string[] = [];
    const removedTargets: string[] = [];
    const conflictedTargets: string[] = [];
    let mutationApplied = false;
    for (const [entryKey, entry] of Object.entries(manifest.entries)) {
      if (entry.engineId !== options.engineId) continue;
      if (!entry.resourceId.startsWith(options.resourceIdPrefix)) continue;
      if (options.keepResourceIds?.has(entry.resourceId)) continue;
      if (!hasProjectionMutationAuthority(options.ownershipStore, options.ownershipOwnerId)) {
        conflictedTargets.push(projectionMutationTargetPath(entry));
        continue;
      }
      const mutationTargetPath = projectionMutationTargetPath(entry);
      const targetAbs = resolveProjectionTargetPath(ownership.projectRoot, mutationTargetPath);
      const mutation = await invokeExistingProjectionRemoval({
        ownership,
        manifest,
        manifestValue: projectionManifestValueWithoutEntry(manifest, entryKey),
        targetAbs,
        action: entry.action,
        resourceIds: [
          entry.resourceId,
          ...(entry.contributors?.map((contributor) => contributor.resourceId) ?? []),
        ],
        sourcePaths: [
          entry.sourcePath,
          ...(entry.contributors?.map((contributor) => contributor.sourcePath) ?? []),
        ],
        ...(entry.contentHash ? { contentHash: entry.contentHash } : {}),
      });
      if (mutation.status === "applied") {
        delete manifest.entries[entryKey];
        mutationApplied = true;
        removedEntries.push(entryKey);
        removedTargets.push(mutationTargetPath);
      } else if (mutation.status === "missing") {
        if (mutationApplied) {
          conflictedTargets.push(mutationTargetPath);
        } else {
          delete manifest.entries[entryKey];
          removedEntries.push(entryKey);
        }
      } else {
        conflictedTargets.push(mutationTargetPath);
      }
    }
    if (removedEntries.length > 0 && !mutationApplied) {
      await appendProjectionManifestWhenNoMutation(ownership, manifest);
    }
    return {
      removedEntries,
      removedTargets,
      ...(conflictedTargets.length > 0 ? { conflictedTargets } : {}),
    };
  });
}

async function removeMossProjectionResourceUnlocked(
  options: RemoveMossProjectionResourceOptions,
  ownership: ProjectionOwnershipContext,
): Promise<RemoveMossProjectionResourceResult> {
  const manifestPath = manifestPathFor(ownership.projectRoot);
  const hasAuthority = hasProjectionMutationAuthority(
    options.ownershipStore,
    options.ownershipOwnerId,
  );
  if (!hasAuthority && !(await pathExists(manifestPath))) {
    return {
      removedEntries: [],
      removedTargets: [],
    };
  }
  const manifest = hasAuthority
    ? await readManifest(ownership.projectRoot, ownership)
    : await readCompatibilityManifest(ownership.projectRoot);
  const sourceKey = options.sourcePath
    ? normalizePathKey(
        options.projectPath,
        resolveProjectionPath(options.projectPath, options.sourcePath),
      )
    : undefined;
  const targetKeys = new Set(
    (options.targetPaths ?? []).map((targetPath) =>
      normalizePathKey(
        ownership.projectRoot,
        resolveProjectionTargetPath(ownership.projectRoot, targetPath),
      ),
    ),
  );
  const removedEntries: string[] = [];
  const removedTargets: string[] = [];
  const conflictedTargets: string[] = [];
  let mutationApplied = false;

  for (const [entryKey, entry] of Object.entries(manifest.entries)) {
    const entryManifestKey = normalizePathKey(
      options.projectPath,
      resolveProjectionPath(options.projectPath, entryKey),
    );
    const entrySourceKey = entry.sourcePath
      ? normalizePathKey(
          options.projectPath,
          resolveProjectionPath(options.projectPath, entry.sourcePath),
        )
      : undefined;
    const entryTargetKey = normalizePathKey(
      options.projectPath,
      resolveProjectionTargetPath(ownership.projectRoot, entry.targetPath),
    );
    const matchesByTarget = targetKeys.has(entryTargetKey) || targetKeys.has(entryManifestKey);
    const matches =
      entry.resourceId === options.resourceId ||
      (sourceKey !== undefined && entrySourceKey === sourceKey) ||
      matchesByTarget;

    if (!matches) continue;

    // Contributor-precise reclaim: a shared managed-bridge/adapter-inject
    // target (e.g. .codex/config.toml carrying mcp + provider bridges) fans in
    // from many resources. When removing a single resource while leaving the
    // file for re-materialize (removeTargets === false), drop just that
    // contributor and keep the entry alive while others remain.
    if (
      hasAuthority &&
      !options.removeTargets &&
      entry.contributors &&
      entry.contributors.length > 1
    ) {
      const remaining = entry.contributors.filter((contributor) => {
        if (contributor.resourceId === options.resourceId) return false;
        if (sourceKey !== undefined) {
          const contributorSourceKey = contributor.sourcePath
            ? normalizePathKey(
                options.projectPath,
                resolveProjectionPath(options.projectPath, contributor.sourcePath),
              )
            : undefined;
          if (contributorSourceKey === sourceKey) return false;
        }
        return true;
      });
      const nextLast = remaining[remaining.length - 1];
      if (nextLast && remaining.length < entry.contributors.length) {
        manifest.entries[entryKey] = {
          ...entry,
          resourceId: nextLast.resourceId,
          sourcePath: nextLast.sourcePath,
          contributors: remaining,
          updatedAt: new Date().toISOString(),
        };
        removedEntries.push(entryKey);
        continue;
      }
    }

    if (options.removeTargets) {
      const mutationTargetPath = projectionMutationTargetPath(entry);
      if (!hasAuthority) {
        conflictedTargets.push(mutationTargetPath);
        continue;
      }
      const targetAbs = resolveProjectionTargetPath(ownership.projectRoot, mutationTargetPath);
      const mutation = await invokeExistingProjectionRemoval({
        ownership,
        manifest,
        manifestValue: projectionManifestValueWithoutEntry(manifest, entryKey),
        targetAbs,
        action: entry.action,
        resourceIds: [options.resourceId, entry.resourceId],
        sourcePaths: [options.sourcePath, entry.sourcePath],
        ...(entry.contentHash ? { contentHash: entry.contentHash } : {}),
      });
      if (
        mutation.status === "conflict" ||
        mutation.status === "unsupported" ||
        mutation.status === "recovery-needed"
      ) {
        conflictedTargets.push(mutationTargetPath);
        continue;
      }
      if (mutation.status === "applied") {
        delete manifest.entries[entryKey];
        mutationApplied = true;
        removedEntries.push(entryKey);
        removedTargets.push(mutationTargetPath);
      } else if (mutation.status === "missing") {
        if (mutationApplied) {
          conflictedTargets.push(mutationTargetPath);
        } else {
          delete manifest.entries[entryKey];
          removedEntries.push(entryKey);
        }
      }
      continue;
    }

    if (hasAuthority) {
      delete manifest.entries[entryKey];
      removedEntries.push(entryKey);
    }
  }

  // Explicit target paths are only hints for matching a server-owned
  // manifest entry. Never delete a path merely because a caller supplied it:
  // the workspace and its manifest are user-controlled, and an unlisted
  // symlink/file has no injected CAS authority to authorize removal.

  if (hasAuthority && removedEntries.length > 0 && !mutationApplied) {
    await appendProjectionManifestWhenNoMutation(ownership, manifest);
  }

  return {
    removedEntries,
    removedTargets,
    ...(conflictedTargets.length > 0 ? { conflictedTargets } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readLinkTarget(filePath: string): Promise<string | null> {
  try {
    return await readlink(filePath);
  } catch {
    return null;
  }
}

async function isSameSymlinkTarget(linkPath: string, sourcePath: string): Promise<boolean> {
  const existingTarget = await readLinkTarget(linkPath);
  if (!existingTarget) return false;
  const resolvedExisting = resolve(dirname(linkPath), existingTarget);
  try {
    return (await realpath(resolvedExisting)) === (await realpath(sourcePath));
  } catch {
    return false;
  }
}

interface ExistingProjectionTarget {
  readonly identity: MossProjectionTargetIdentity;
  readonly contentHash: string;
}

async function inspectExistingProjectionTarget(
  targetAbs: string,
  boundaryRoot?: string,
): Promise<ExistingProjectionTarget | undefined> {
  try {
    await assertNoSymlinkParent(targetAbs, boundaryRoot);
    const targetStat = await lstat(targetAbs);
    const contentHash = targetStat.isSymbolicLink()
      ? hashContent(`symlink\0${await readlink(targetAbs)}`)
      : await mossProjectionContentHash(targetAbs);
    return {
      identity: {
        dev: String(targetStat.dev),
        ino: String(targetStat.ino),
        mode: targetStat.mode,
        ctimeMs: targetStat.ctimeMs,
      },
      contentHash,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function invokeExistingProjectionReplacement(params: {
  ownership: ProjectionOwnershipContext;
  manifest: WorkingManifest;
  manifestValue: unknown;
  targetAbs: string;
  action: MossProjectionAction;
  resourceIds: ReadonlyArray<string>;
  sourcePaths: ReadonlyArray<string | undefined>;
  contentHash?: string | undefined;
  target: MossProjectionFrozenTarget;
}): Promise<MossProjectionOwnershipMutationResult> {
  let existing: ExistingProjectionTarget | undefined;
  try {
    existing = await inspectExistingProjectionTarget(
      params.targetAbs,
      params.ownership.projectRoot,
    );
  } catch (error) {
    return {
      status: "conflict",
      reason: error instanceof Error ? error.message : "Projection target validation failed.",
    };
  }
  if (!existing) return { status: "missing", reason: "Projection target disappeared before CAS." };
  const request = buildProjectionOwnershipRequest({
    ownership: params.ownership,
    manifest: params.manifest,
    manifestValue: params.manifestValue,
    targetAbs: params.targetAbs,
    targetIdentity: existing.identity,
    expectedBeforeHash: existing.contentHash,
    action: params.action,
    resourceIds: params.resourceIds,
    sourcePaths: params.sourcePaths,
    contentHash: params.contentHash ?? frozenProjectionTargetContentHash(params.target),
  });
  if (!request || !params.ownership.store) {
    return unsupportedExistingMutation(
      "Existing projection replacement requires an injected server-owned filesystem CAS store.",
    );
  }
  const result = validateDurableMutationResult(
    await params.ownership.store.replace(request, params.target),
    request,
  );
  if (result.status === "applied")
    applyPrivateManifestReceipt(params.manifest, result.receipt.manifest);
  return result;
}

async function invokeNewProjectionCreate(params: {
  ownership: ProjectionOwnershipContext;
  manifest: WorkingManifest;
  manifestValue: unknown;
  targetAbs: string;
  action: MossProjectionAction;
  resourceIds: ReadonlyArray<string>;
  sourcePaths: ReadonlyArray<string | undefined>;
  contentHash?: string | undefined;
  target: MossProjectionFrozenTarget;
}): Promise<MossProjectionOwnershipMutationResult> {
  const request = buildProjectionOwnershipRequest({
    ownership: params.ownership,
    manifest: params.manifest,
    manifestValue: params.manifestValue,
    targetAbs: params.targetAbs,
    action: params.action,
    resourceIds: params.resourceIds,
    sourcePaths: params.sourcePaths,
    contentHash: params.contentHash ?? frozenProjectionTargetContentHash(params.target),
  });
  if (!request || !params.ownership.store) {
    return unsupportedNewMutation(
      "New projection creation requires an injected server-owned filesystem CAS store with private staging.",
    );
  }
  const result = validateDurableMutationResult(
    await params.ownership.store.publish(request, params.target),
    request,
  );
  if (result.status === "applied")
    applyPrivateManifestReceipt(params.manifest, result.receipt.manifest);
  return result;
}

async function invokeExistingProjectionRemoval(params: {
  ownership: ProjectionOwnershipContext;
  manifest: WorkingManifest;
  manifestValue: unknown;
  targetAbs: string;
  action: MossProjectionAction;
  resourceIds: ReadonlyArray<string>;
  sourcePaths: ReadonlyArray<string | undefined>;
  contentHash?: string | undefined;
}): Promise<MossProjectionOwnershipMutationResult> {
  let existing: ExistingProjectionTarget | undefined;
  try {
    existing = await inspectExistingProjectionTarget(
      params.targetAbs,
      params.ownership.projectRoot,
    );
  } catch (error) {
    return {
      status: "conflict",
      reason: error instanceof Error ? error.message : "Projection target validation failed.",
    };
  }
  if (!existing) return { status: "missing", reason: "Projection target is already absent." };
  const request = buildProjectionOwnershipRequest({
    ownership: params.ownership,
    manifest: params.manifest,
    manifestValue: params.manifestValue,
    targetAbs: params.targetAbs,
    targetIdentity: existing.identity,
    expectedBeforeHash: existing.contentHash,
    expectedAfterState: "absent",
    action: params.action,
    resourceIds: params.resourceIds,
    sourcePaths: params.sourcePaths,
    ...(params.contentHash ? { contentHash: params.contentHash } : {}),
  });
  if (!request || !params.ownership.store) {
    return unsupportedExistingMutation(
      "Existing projection deletion requires an injected server-owned filesystem CAS store.",
    );
  }
  const result = validateDurableMutationResult(
    await params.ownership.store.remove(request),
    request,
  );
  if (result.status === "applied")
    applyPrivateManifestReceipt(params.manifest, result.receipt.manifest);
  return result;
}

function hasProjectionMutationAuthority(
  store: MossProjectionOwnershipStore | undefined,
  ownerId: string | undefined,
): boolean {
  return Boolean(store && ownerId);
}

function isRegisteredProjectionEntry(
  manifest: WorkingManifest,
  targetKey: string,
  resourceId: string,
  action: MossProjectionAction,
  contentHash?: string | undefined,
): boolean {
  const entry = manifest.entries[targetKey];
  return Boolean(
    entry &&
    entry.resourceId === resourceId &&
    entry.action === action &&
    (contentHash === undefined || entry.contentHash === contentHash),
  );
}

function isRegisteredProjectionTargetForMappings(
  manifest: WorkingManifest,
  targetKey: string,
  mappings: ReadonlyArray<MossResourcePathMapping>,
  action: MossProjectionAction,
  contentHash?: string | undefined,
): boolean {
  return mappings.some((mapping) =>
    isRegisteredProjectionEntry(manifest, targetKey, mapping.resourceId, action, contentHash),
  );
}

function noAuthorityCreationReason(): string {
  return "New projection creation is disabled until a server-owned filesystem CAS store with private staging is injected.";
}

function materializeStatusForMutation(
  status: MossProjectionOwnershipMutationResult["status"],
): "conflict" | "unsupported" {
  // Keep a missing native durability capability typed as unsupported. A CAS
  // race, forged receipt, or recovery-needed result remains a conflict and is
  // never presented as a successful projection.
  return status === "unsupported" ? "unsupported" : "conflict";
}

async function materializeSymlink(params: {
  projectPath: string;
  ownership: ProjectionOwnershipContext;
  engineId: ProviderKind;
  mapping: MossResourcePathMapping;
  manifest: WorkingManifest;
  dryRun?: boolean | undefined;
}): Promise<MossProjectionMaterializeResult> {
  if (!params.mapping.sourcePath || !params.mapping.targetPath) {
    return {
      engineId: params.engineId,
      resourceId: params.mapping.resourceId,
      action: params.mapping.action,
      status: "unsupported",
      reason: "Symlink projection requires sourcePath and targetPath.",
    };
  }

  const sourceAbs = resolveProjectionPath(params.ownership.projectRoot, params.mapping.sourcePath);
  const sourceLinkTarget = resolveProjectionPath(params.projectPath, params.mapping.sourcePath);
  let targetAbs: string;
  try {
    targetAbs = resolveProjectionTargetPath(
      params.ownership.projectRoot,
      params.mapping.targetPath,
    );
  } catch (error) {
    return {
      engineId: params.engineId,
      resourceId: params.mapping.resourceId,
      action: "symlink",
      sourcePath: params.mapping.sourcePath,
      targetPath: params.mapping.targetPath,
      status: "conflict",
      reason: error instanceof Error ? error.message : "Unsafe projection target path.",
    };
  }
  const targetKey = normalizePathKey(params.ownership.projectRoot, targetAbs);

  let sourceLinkStat;
  try {
    sourceLinkStat = await lstat(sourceAbs);
  } catch {
    return {
      engineId: params.engineId,
      resourceId: params.mapping.resourceId,
      action: "symlink",
      sourcePath: params.mapping.sourcePath,
      targetPath: params.mapping.targetPath,
      status: "conflict",
      reason: "Source path does not exist.",
    };
  }
  if (sourceLinkStat.isSymbolicLink()) {
    return {
      engineId: params.engineId,
      resourceId: params.mapping.resourceId,
      action: "symlink",
      sourcePath: params.mapping.sourcePath,
      targetPath: params.mapping.targetPath,
      status: "conflict",
      reason: "Symlink projection does not follow symbolic-link sources.",
    };
  }

  try {
    await assertNoSymlinkParent(targetAbs, params.ownership.projectRoot);
  } catch (error) {
    return {
      engineId: params.engineId,
      resourceId: params.mapping.resourceId,
      action: "symlink",
      sourcePath: params.mapping.sourcePath,
      targetPath: params.mapping.targetPath,
      status: "conflict",
      reason: error instanceof Error ? error.message : "Projection target validation failed.",
    };
  }

  if (await isSameSymlinkTarget(targetAbs, sourceAbs)) {
    if (
      !isRegisteredProjectionEntry(params.manifest, targetKey, params.mapping.resourceId, "symlink")
    ) {
      return {
        engineId: params.engineId,
        resourceId: params.mapping.resourceId,
        action: "symlink",
        sourcePath: params.mapping.sourcePath,
        targetPath: params.mapping.targetPath,
        status: "conflict",
        reason: "Identical projection target is not registered in the server-owned manifest.",
      };
    }
    return {
      engineId: params.engineId,
      resourceId: params.mapping.resourceId,
      action: "symlink",
      sourcePath: params.mapping.sourcePath,
      targetPath: params.mapping.targetPath,
      status: "skipped",
      reason: "Symlink already points at the Moss source; no mutation was needed.",
    };
  }

  const existingTarget = await inspectExistingProjectionTarget(
    targetAbs,
    params.ownership.projectRoot,
  );
  if (existingTarget) {
    if (
      !isRegisteredProjectionEntry(params.manifest, targetKey, params.mapping.resourceId, "symlink")
    ) {
      return {
        engineId: params.engineId,
        resourceId: params.mapping.resourceId,
        action: "symlink",
        sourcePath: params.mapping.sourcePath,
        targetPath: params.mapping.targetPath,
        status: "conflict",
        reason: "Target exists and is not managed by the server-owned manifest.",
      };
    }
    if (!params.ownership.store || !params.ownership.ownerId || params.dryRun) {
      return {
        engineId: params.engineId,
        resourceId: params.mapping.resourceId,
        action: "symlink",
        sourcePath: params.mapping.sourcePath,
        targetPath: params.mapping.targetPath,
        status: "conflict",
        reason:
          "Existing symlink replacement is disabled until a server-owned filesystem CAS store is injected.",
      };
    }
    let sourceStat;
    try {
      sourceStat = await stat(sourceAbs);
    } catch {
      return {
        engineId: params.engineId,
        resourceId: params.mapping.resourceId,
        action: "symlink",
        sourcePath: params.mapping.sourcePath,
        targetPath: params.mapping.targetPath,
        status: "conflict",
        reason: "Unable to stat source path.",
      };
    }
    const type = sourceStat.isDirectory()
      ? process.platform === "win32"
        ? "junction"
        : "dir"
      : "file";
    const target: MossProjectionFrozenTarget = {
      kind: "symlink",
      target: sourceLinkTarget,
      linkType: type,
    };
    const entry: WorkingManifestEntry = {
      engineId: params.engineId,
      resourceId: params.mapping.resourceId,
      action: "symlink",
      sourcePath: params.mapping.sourcePath,
      targetPath: params.mapping.targetPath,
      updatedAt: new Date().toISOString(),
    };
    const mutation = await invokeExistingProjectionReplacement({
      ownership: params.ownership,
      manifest: params.manifest,
      manifestValue: projectionManifestValueWithEntry(params.manifest, targetKey, entry),
      targetAbs,
      action: "symlink",
      resourceIds: [params.mapping.resourceId],
      sourcePaths: [params.mapping.sourcePath],
      target,
    });
    if (mutation.status !== "applied") {
      return {
        engineId: params.engineId,
        resourceId: params.mapping.resourceId,
        action: "symlink",
        sourcePath: params.mapping.sourcePath,
        targetPath: params.mapping.targetPath,
        status: materializeStatusForMutation(mutation.status),
        reason: mutation.reason ?? "Filesystem CAS refused existing symlink replacement.",
      };
    }
    params.manifest.entries[targetKey] = entry;
    return {
      engineId: params.engineId,
      resourceId: params.mapping.resourceId,
      action: "symlink",
      sourcePath: params.mapping.sourcePath,
      targetPath: params.mapping.targetPath,
      status: "updated",
      reason: "Existing symlink was replaced by the injected filesystem CAS store.",
    };
  }

  if (!params.ownership.store || !params.ownership.ownerId || params.dryRun) {
    return {
      engineId: params.engineId,
      resourceId: params.mapping.resourceId,
      action: "symlink",
      sourcePath: params.mapping.sourcePath,
      targetPath: params.mapping.targetPath,
      status: "conflict",
      reason: params.dryRun
        ? "Dry run: projection creation was not attempted."
        : noAuthorityCreationReason(),
    };
  }

  let sourceStat;
  try {
    sourceStat = await stat(sourceAbs);
  } catch {
    return {
      engineId: params.engineId,
      resourceId: params.mapping.resourceId,
      action: "symlink",
      sourcePath: params.mapping.sourcePath,
      targetPath: params.mapping.targetPath,
      status: "conflict",
      reason: "Unable to stat source path.",
    };
  }

  const type = sourceStat.isDirectory()
    ? process.platform === "win32"
      ? "junction"
      : "dir"
    : "file";
  const entry: WorkingManifestEntry = {
    engineId: params.engineId,
    resourceId: params.mapping.resourceId,
    action: "symlink",
    sourcePath: params.mapping.sourcePath,
    targetPath: params.mapping.targetPath,
    updatedAt: new Date().toISOString(),
  };
  const mutation = await invokeNewProjectionCreate({
    ownership: params.ownership,
    manifest: params.manifest,
    manifestValue: projectionManifestValueWithEntry(params.manifest, targetKey, entry),
    targetAbs,
    action: "symlink",
    resourceIds: [params.mapping.resourceId],
    sourcePaths: [params.mapping.sourcePath],
    target: { kind: "symlink", target: sourceLinkTarget, linkType: type },
  });
  if (mutation.status !== "applied") {
    return {
      engineId: params.engineId,
      resourceId: params.mapping.resourceId,
      action: "symlink",
      sourcePath: params.mapping.sourcePath,
      targetPath: params.mapping.targetPath,
      status: materializeStatusForMutation(mutation.status),
      reason: mutation.reason ?? "Filesystem CAS refused new symlink creation.",
    };
  }
  params.manifest.entries[targetKey] = entry;

  return {
    engineId: params.engineId,
    resourceId: params.mapping.resourceId,
    action: "symlink",
    sourcePath: params.mapping.sourcePath,
    targetPath: params.mapping.targetPath,
    status: "created",
  };
}

/**
 * Copy materialization (moss extension). Creation and
 * conflict rules match symlink; identical target bytes report `skipped`.
 */
async function materializeCopy(params: {
  projectPath: string;
  ownership: ProjectionOwnershipContext;
  engineId: ProviderKind;
  mapping: MossResourcePathMapping;
  manifest: WorkingManifest;
  dryRun?: boolean | undefined;
}): Promise<MossProjectionMaterializeResult> {
  if (!params.mapping.sourcePath || !params.mapping.targetPath) {
    return {
      engineId: params.engineId,
      resourceId: params.mapping.resourceId,
      action: params.mapping.action,
      status: "unsupported",
      reason: "Copy projection requires sourcePath and targetPath.",
    };
  }

  const base = {
    engineId: params.engineId,
    resourceId: params.mapping.resourceId,
    action: "copy" as const,
    sourcePath: params.mapping.sourcePath,
    targetPath: params.mapping.targetPath,
  };
  const sourceAbs = resolveProjectionPath(params.ownership.projectRoot, params.mapping.sourcePath);
  let targetAbs: string;
  try {
    targetAbs = resolveProjectionTargetPath(
      params.ownership.projectRoot,
      params.mapping.targetPath,
    );
  } catch (error) {
    return {
      ...base,
      status: "conflict",
      reason: error instanceof Error ? error.message : "Unsafe projection target path.",
    };
  }
  const targetKey = normalizePathKey(params.ownership.projectRoot, targetAbs);

  let sourceStat;
  try {
    sourceStat = await lstat(sourceAbs);
  } catch {
    return { ...base, status: "conflict", reason: "Source path does not exist." };
  }
  if (sourceStat.isSymbolicLink()) {
    return {
      ...base,
      status: "conflict",
      reason: "Copy projection does not follow symbolic-link sources.",
    };
  }
  if (!sourceStat.isDirectory() && !sourceStat.isFile()) {
    return {
      ...base,
      status: "unsupported",
      reason: "Copy projection requires a file or directory source.",
    };
  }

  const sourceContent = sourceStat.isFile()
    ? await readProjectionFileNoFollow(sourceAbs)
    : undefined;
  const contentHash = sourceStat.isDirectory()
    ? await mossProjectionContentHash(sourceAbs)
    : hashContent(sourceContent ?? Buffer.alloc(0));

  const existingTarget = await inspectExistingProjectionTarget(
    targetAbs,
    params.ownership.projectRoot,
  );
  if (existingTarget) {
    try {
      const targetStat = await lstat(targetAbs);
      if (!targetStat.isSymbolicLink() && (targetStat.isFile() || targetStat.isDirectory())) {
        const existingHash = targetStat.isDirectory()
          ? await mossProjectionContentHash(targetAbs)
          : hashContent(await readProjectionFileNoFollow(targetAbs));
        if (existingHash === contentHash) {
          if (
            isRegisteredProjectionEntry(
              params.manifest,
              targetKey,
              params.mapping.resourceId,
              "copy",
              contentHash,
            )
          ) {
            return {
              ...base,
              status: "skipped",
              reason:
                "Copy target already matches the Moss source content; no mutation was needed.",
            };
          }
          return {
            ...base,
            status: "conflict",
            reason: "Identical copy target is not registered in the server-owned manifest.",
          };
        }
      }
    } catch {
      // An unreadable/replaced existing target is a conflict, never a reason
      // to fall through to overwrite.
    }
    if (
      !isRegisteredProjectionEntry(params.manifest, targetKey, params.mapping.resourceId, "copy")
    ) {
      return {
        ...base,
        status: "conflict",
        reason: "Target exists and is not managed by the server-owned manifest.",
      };
    }
    if (!params.ownership.store || !params.ownership.ownerId || params.dryRun) {
      return {
        ...base,
        status: "conflict",
        reason:
          "Target exists and is not managed; existing copy replacement is disabled until a server-owned filesystem CAS store is injected.",
      };
    }
    let target: MossProjectionFrozenTarget;
    try {
      target = await snapshotProjectionTarget(
        sourceAbs,
        sourceStat,
        contentHash,
        projectionSourceBoundaryRoot(sourceAbs, params.ownership.projectRoot),
      );
      const entry: WorkingManifestEntry = {
        engineId: params.engineId,
        resourceId: params.mapping.resourceId,
        action: "copy",
        sourcePath: params.mapping.sourcePath,
        targetPath: params.mapping.targetPath,
        contentHash,
        updatedAt: new Date().toISOString(),
      };
      const mutation = await invokeExistingProjectionReplacement({
        ownership: params.ownership,
        manifest: params.manifest,
        manifestValue: projectionManifestValueWithEntry(params.manifest, targetKey, entry),
        targetAbs,
        action: "copy",
        resourceIds: [params.mapping.resourceId],
        sourcePaths: [params.mapping.sourcePath],
        contentHash,
        target,
      });
      if (mutation.status !== "applied") {
        return {
          ...base,
          status: materializeStatusForMutation(mutation.status),
          reason: mutation.reason ?? "Filesystem CAS refused existing copy replacement.",
        };
      }
    } catch (error) {
      return {
        ...base,
        status: "conflict",
        reason: error instanceof Error ? error.message : "Copy source changed during snapshot.",
      };
    }
    params.manifest.entries[targetKey] = {
      engineId: params.engineId,
      resourceId: params.mapping.resourceId,
      action: "copy",
      sourcePath: params.mapping.sourcePath,
      targetPath: params.mapping.targetPath,
      contentHash,
      updatedAt: new Date().toISOString(),
    };
    return { ...base, status: "updated" };
  }

  if (!params.ownership.store || !params.ownership.ownerId || params.dryRun) {
    return {
      ...base,
      status: params.dryRun ? "skipped" : "conflict",
      reason: params.dryRun
        ? "Dry run: projection creation was not attempted."
        : noAuthorityCreationReason(),
    };
  }

  let target: MossProjectionFrozenTarget;
  try {
    target = await snapshotProjectionTarget(
      sourceAbs,
      sourceStat,
      contentHash,
      projectionSourceBoundaryRoot(sourceAbs, params.ownership.projectRoot),
    );
  } catch (error) {
    return {
      ...base,
      status: "conflict",
      reason: error instanceof Error ? error.message : "Copy source changed during snapshot.",
    };
  }
  const entry: WorkingManifestEntry = {
    engineId: params.engineId,
    resourceId: params.mapping.resourceId,
    action: "copy",
    sourcePath: params.mapping.sourcePath,
    targetPath: params.mapping.targetPath,
    contentHash,
    updatedAt: new Date().toISOString(),
  };
  const mutation = await invokeNewProjectionCreate({
    ownership: params.ownership,
    manifest: params.manifest,
    manifestValue: projectionManifestValueWithEntry(params.manifest, targetKey, entry),
    targetAbs,
    action: "copy",
    resourceIds: [params.mapping.resourceId],
    sourcePaths: [params.mapping.sourcePath],
    contentHash,
    target,
  });
  if (mutation.status !== "applied") {
    return {
      ...base,
      status: "conflict",
      reason: mutation.reason ?? "Filesystem CAS refused new copy creation.",
    };
  }
  params.manifest.entries[targetKey] = entry;

  return { ...base, status: "created" };
}

function quoteTomlString(value: string): string {
  return JSON.stringify(value);
}

function appendTomlValue(lines: string[], key: string, value: unknown): void {
  if (typeof value === "string") {
    lines.push(`${key} = ${quoteTomlString(value)}`);
    return;
  }
  if (typeof value === "boolean" || typeof value === "number") {
    lines.push(`${key} = ${String(value)}`);
    return;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    lines.push(`${key} = [${value.map(quoteTomlString).join(", ")}]`);
  }
}

function sourcePathMatchesLayoutFile(
  sourcePath: string | undefined,
  relativePath: string,
): boolean {
  if (!sourcePath) return false;
  const normalizedSourcePath = sourcePath.split(sep).join("/");
  return normalizedSourcePath === relativePath || normalizedSourcePath.endsWith(`/${relativePath}`);
}

async function readMcpServers(sourceAbs: string): Promise<Record<string, unknown>> {
  const raw = (await readProjectionFileNoFollow(sourceAbs)).toString("utf8");
  const parsed = JSON.parse(raw) as {
    mcpServers?: Record<string, unknown>;
    servers?: Record<string, unknown>;
  };
  return parsed.mcpServers ?? parsed.servers ?? {};
}

async function buildCodexTomlBridge(
  projectPath: string,
  mappings: ReadonlyArray<MossResourcePathMapping>,
): Promise<string> {
  const lines = [
    "# Generated by Moss from the Moss Unified Source.",
    "# Do not edit this file directly; update the Moss source instead.",
    "",
  ];

  const mcpMappings = mappings.filter((mapping) =>
    sourcePathMatchesLayoutFile(mapping.sourcePath, MOSS_RELATIVE_PATHS.mcpConfig),
  );
  const seenMcpSources = new Set<string>();
  for (const mapping of mcpMappings) {
    if (!mapping.sourcePath) continue;
    if (seenMcpSources.has(mapping.sourcePath)) continue;
    seenMcpSources.add(mapping.sourcePath);
    const sourceAbs = resolveProjectionPath(projectPath, mapping.sourcePath);
    const servers = await readMcpServers(sourceAbs);
    for (const [serverName, serverConfig] of Object.entries(servers)) {
      const config = isRecord(serverConfig) ? serverConfig : {};
      lines.push(`[mcp_servers.${serverName}]`);
      appendTomlValue(lines, "command", config.command);
      appendTomlValue(lines, "url", config.url);
      appendTomlValue(lines, "args", config.args);
      if (isRecord(config.env)) {
        lines.push("");
        lines.push(`[mcp_servers.${serverName}.env]`);
        for (const [envKey, envValue] of Object.entries(config.env)) {
          appendTomlValue(lines, envKey, envValue);
        }
      }
      lines.push("");
    }
  }

  const providerMappings = mappings.filter((mapping) =>
    sourcePathMatchesLayoutFile(mapping.sourcePath, MOSS_RELATIVE_PATHS.providersConfig),
  );
  const seenProviderSources = new Set<string>();
  for (const mapping of providerMappings) {
    if (!mapping.sourcePath) continue;
    if (seenProviderSources.has(mapping.sourcePath)) continue;
    seenProviderSources.add(mapping.sourcePath);
    lines.push(`# Moss provider routing source: ${mapping.sourcePath}`);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

async function buildManagedBridgeContent(
  projectPath: string,
  targetAbs: string,
  mappings: ReadonlyArray<MossResourcePathMapping>,
): Promise<string> {
  const targetName = basename(targetAbs);
  const firstSourcePath = mappings.find((mapping) => mapping.sourcePath)?.sourcePath;
  const firstSourceAbs = firstSourcePath
    ? resolveProjectionPath(projectPath, firstSourcePath)
    : undefined;

  if (targetName === ".mcp.json" && firstSourceAbs) {
    const raw = (await readProjectionFileNoFollow(firstSourceAbs)).toString("utf8");
    const parsed = JSON.parse(raw);
    return `${JSON.stringify(parsed, null, 2)}\n`;
  }

  if (targetName.endsWith(".toml")) {
    return buildCodexTomlBridge(projectPath, mappings);
  }

  return `${JSON.stringify(
    {
      moss: {
        generated: true,
        sources: mappings.map((mapping) => mapping.sourcePath).filter(Boolean),
        note: "Generated by Moss from the Moss Unified Source. Update the Moss source instead.",
      },
    },
    null,
    2,
  )}\n`;
}

function buildContributors(
  mappings: ReadonlyArray<MossResourcePathMapping>,
): MossProjectionManifestContributor[] {
  return mappings.map((mapping) => ({
    resourceId: mapping.resourceId,
    sourcePath: mapping.sourcePath,
  }));
}

/**
 * True when a shared managed target is already exactly what we would write:
 * the on-disk bytes still match. This is read-only and does not establish
 * ownership or authorize a later mutation.
 * Reported as `skipped` so re-materialize is idempotent (moss deviation
 * from 1code, which always reported `updated`).
 */
async function isUpToDateManagedTarget(params: {
  targetAbs: string;
  contentHash: string;
}): Promise<boolean> {
  try {
    const targetStat = await lstat(params.targetAbs);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) return false;
    return hashContent(await readProjectionFileNoFollow(params.targetAbs)) === params.contentHash;
  } catch {
    return false;
  }
}

async function materializeManagedBridge(params: {
  projectPath: string;
  ownership: ProjectionOwnershipContext;
  projection: MossEngineResourceProjection;
  mappings: MossResourcePathMapping[];
  targetPath: string;
  manifest: WorkingManifest;
  dryRun?: boolean | undefined;
}): Promise<MossProjectionMaterializeResult[]> {
  let targetAbs: string;
  try {
    targetAbs = resolveProjectionTargetPath(params.ownership.projectRoot, params.targetPath);
  } catch (error) {
    return params.mappings.map((mapping) => ({
      engineId: params.projection.engineId,
      resourceId: mapping.resourceId,
      action: "managed-bridge" as const,
      sourcePath: mapping.sourcePath,
      targetPath: params.targetPath,
      status: "conflict" as const,
      reason: error instanceof Error ? error.message : "Unsafe projection target path.",
    }));
  }
  const targetKey = normalizePathKey(params.ownership.projectRoot, targetAbs);
  const content = await buildManagedBridgeContent(
    params.ownership.projectRoot,
    targetAbs,
    params.mappings,
  );
  const contentHash = hashContent(content);
  const contributors = buildContributors(params.mappings);

  const managedTargetMatches = await isUpToDateManagedTarget({ targetAbs, contentHash });
  const lastMapping = params.mappings[params.mappings.length - 1];
  if (managedTargetMatches) {
    if (
      lastMapping &&
      isRegisteredProjectionTargetForMappings(
        params.manifest,
        targetKey,
        params.mappings,
        "managed-bridge",
        contentHash,
      )
    ) {
      const registeredEntry = params.manifest.entries[targetKey];
      const desiredEntry: WorkingManifestEntry = {
        ...(registeredEntry ?? {}),
        engineId: params.projection.engineId,
        resourceId: lastMapping.resourceId,
        action: "managed-bridge",
        sourcePath: lastMapping.sourcePath,
        targetPath: params.targetPath,
        contentHash,
        updatedAt: new Date().toISOString(),
        contributors,
      };
      if (JSON.stringify(registeredEntry?.contributors ?? []) !== JSON.stringify(contributors)) {
        params.manifest.entries[targetKey] = desiredEntry;
        if (!params.dryRun) {
          await appendProjectionManifestWhenNoMutation(params.ownership, params.manifest);
        }
      }
      return params.mappings.map((mapping) => ({
        engineId: params.projection.engineId,
        resourceId: mapping.resourceId,
        action: "managed-bridge",
        sourcePath: mapping.sourcePath,
        targetPath: params.targetPath,
        status: "skipped",
        reason: "Managed bridge already matches the Moss source content.",
      }));
    }
    return params.mappings.map((mapping) => ({
      engineId: params.projection.engineId,
      resourceId: mapping.resourceId,
      action: "managed-bridge" as const,
      sourcePath: mapping.sourcePath,
      targetPath: params.targetPath,
      status: "conflict" as const,
      reason: "Identical managed bridge is not registered in the server-owned manifest.",
    }));
  }

  const existingTarget = await inspectExistingProjectionTarget(
    targetAbs,
    params.ownership.projectRoot,
  );
  if (existingTarget) {
    if (
      !lastMapping ||
      !isRegisteredProjectionTargetForMappings(
        params.manifest,
        targetKey,
        params.mappings,
        "managed-bridge",
      )
    ) {
      return params.mappings.map((mapping) => ({
        engineId: params.projection.engineId,
        resourceId: mapping.resourceId,
        action: "managed-bridge" as const,
        sourcePath: mapping.sourcePath,
        targetPath: params.targetPath,
        status: "conflict" as const,
        reason: "Target exists and is not managed by the server-owned manifest.",
      }));
    }
    if (!params.ownership.store || !params.ownership.ownerId || params.dryRun) {
      return params.mappings.map((mapping) => ({
        engineId: params.projection.engineId,
        resourceId: mapping.resourceId,
        action: "managed-bridge",
        sourcePath: mapping.sourcePath,
        targetPath: params.targetPath,
        status: "conflict",
        reason:
          "Existing managed-bridge replacement is disabled until a server-owned filesystem CAS store is injected.",
      }));
    }
    const entry: WorkingManifestEntry = {
      engineId: params.projection.engineId,
      resourceId: lastMapping?.resourceId ?? "",
      action: "managed-bridge",
      sourcePath: lastMapping?.sourcePath,
      targetPath: params.targetPath,
      contentHash,
      updatedAt: new Date().toISOString(),
      contributors,
    };
    const mutation = await invokeExistingProjectionReplacement({
      ownership: params.ownership,
      manifest: params.manifest,
      manifestValue: projectionManifestValueWithEntry(params.manifest, targetKey, entry),
      targetAbs,
      action: "managed-bridge",
      resourceIds: params.mappings.map((mapping) => mapping.resourceId),
      sourcePaths: params.mappings.map((mapping) => mapping.sourcePath),
      contentHash,
      target: { kind: "file", content: Buffer.from(content), contentHash },
    });
    if (mutation.status !== "applied") {
      return params.mappings.map((mapping) => ({
        engineId: params.projection.engineId,
        resourceId: mapping.resourceId,
        action: "managed-bridge",
        sourcePath: mapping.sourcePath,
        targetPath: params.targetPath,
        status: materializeStatusForMutation(mutation.status),
        reason: mutation.reason ?? "Filesystem CAS refused existing managed-bridge replacement.",
      }));
    }
    params.manifest.entries[targetKey] = entry;
    return params.mappings.map((mapping) => ({
      engineId: params.projection.engineId,
      resourceId: mapping.resourceId,
      action: "managed-bridge",
      sourcePath: mapping.sourcePath,
      targetPath: params.targetPath,
      status: "updated",
    }));
  }

  if (!params.ownership.store || !params.ownership.ownerId || params.dryRun) {
    return params.mappings.map((mapping) => ({
      engineId: params.projection.engineId,
      resourceId: mapping.resourceId,
      action: mapping.action,
      sourcePath: mapping.sourcePath,
      targetPath: mapping.targetPath,
      status: "conflict",
      reason: params.dryRun
        ? "Dry run: projection creation was not attempted."
        : noAuthorityCreationReason(),
    }));
  }

  const entry: WorkingManifestEntry = {
    engineId: params.projection.engineId,
    resourceId: lastMapping?.resourceId ?? "",
    action: "managed-bridge",
    sourcePath: lastMapping?.sourcePath,
    targetPath: params.targetPath,
    contentHash,
    updatedAt: new Date().toISOString(),
    contributors,
  };
  const mutation = await invokeNewProjectionCreate({
    ownership: params.ownership,
    manifest: params.manifest,
    manifestValue: projectionManifestValueWithEntry(params.manifest, targetKey, entry),
    targetAbs,
    action: "managed-bridge",
    resourceIds: params.mappings.map((mapping) => mapping.resourceId),
    sourcePaths: params.mappings.map((mapping) => mapping.sourcePath),
    contentHash,
    target: { kind: "file", content: Buffer.from(content), contentHash },
  });
  if (mutation.status !== "applied") {
    return params.mappings.map((mapping) => ({
      engineId: params.projection.engineId,
      resourceId: mapping.resourceId,
      action: "managed-bridge",
      sourcePath: mapping.sourcePath,
      targetPath: params.targetPath,
      status: materializeStatusForMutation(mutation.status),
      reason: mutation.reason ?? "Filesystem CAS refused new managed-bridge creation.",
    }));
  }

  params.manifest.entries[targetKey] = entry;

  return params.mappings.map((mapping) => ({
    engineId: params.projection.engineId,
    resourceId: mapping.resourceId,
    action: "managed-bridge",
    sourcePath: mapping.sourcePath,
    targetPath: params.targetPath,
    status: "created",
  }));
}

async function materializeAdapterInjection(params: {
  projectPath: string;
  ownership: ProjectionOwnershipContext;
  projection: MossEngineResourceProjection;
  mappings: MossResourcePathMapping[];
  targetPath: string;
  manifest: WorkingManifest;
  dryRun?: boolean | undefined;
}): Promise<MossProjectionMaterializeResult[]> {
  let targetAbs: string;
  try {
    targetAbs = resolveProjectionTargetPath(params.ownership.projectRoot, params.targetPath);
  } catch (error) {
    return params.mappings.map((mapping) => ({
      engineId: params.projection.engineId,
      resourceId: mapping.resourceId,
      action: "adapter-inject" as const,
      sourcePath: mapping.sourcePath,
      targetPath: params.targetPath,
      status: "conflict" as const,
      reason: error instanceof Error ? error.message : "Unsafe projection target path.",
    }));
  }
  const adapterManifestAbs = join(targetAbs, ADAPTER_MANIFEST_NAME);
  const adapterManifestKey = normalizePathKey(params.ownership.projectRoot, adapterManifestAbs);

  const content = `${JSON.stringify(
    {
      version: 1,
      engineId: params.projection.engineId,
      generatedBy: "moss",
      resources: params.mappings.map((mapping) => ({
        resourceId: mapping.resourceId,
        sourcePath: mapping.sourcePath,
        targetPath: mapping.targetPath,
        reason: mapping.reason,
      })),
    },
    null,
    2,
  )}\n`;
  const contentHash = hashContent(content);
  const contributors = buildContributors(params.mappings);

  const adapterTargetMatches = await isUpToDateManagedTarget({
    targetAbs: adapterManifestAbs,
    contentHash,
  });
  const lastAdapterMapping = params.mappings[params.mappings.length - 1];
  if (adapterTargetMatches) {
    if (
      lastAdapterMapping &&
      isRegisteredProjectionEntry(
        params.manifest,
        adapterManifestKey,
        lastAdapterMapping.resourceId,
        "adapter-inject",
        contentHash,
      )
    ) {
      const registeredEntry = params.manifest.entries[adapterManifestKey];
      const desiredEntry: WorkingManifestEntry = {
        ...(registeredEntry ?? {}),
        engineId: params.projection.engineId,
        resourceId: lastAdapterMapping.resourceId,
        action: "adapter-inject",
        sourcePath: lastAdapterMapping.sourcePath,
        targetPath: params.targetPath,
        contentHash,
        updatedAt: new Date().toISOString(),
        contributors,
      };
      if (JSON.stringify(registeredEntry?.contributors ?? []) !== JSON.stringify(contributors)) {
        params.manifest.entries[adapterManifestKey] = desiredEntry;
        if (!params.dryRun) {
          await appendProjectionManifestWhenNoMutation(params.ownership, params.manifest);
        }
      }
      return params.mappings.map((mapping) => ({
        engineId: params.projection.engineId,
        resourceId: mapping.resourceId,
        action: "adapter-inject",
        sourcePath: mapping.sourcePath,
        targetPath: params.targetPath,
        status: "skipped",
        reason: "Adapter manifest already matches the Moss source content.",
      }));
    }
    return params.mappings.map((mapping) => ({
      engineId: params.projection.engineId,
      resourceId: mapping.resourceId,
      action: "adapter-inject" as const,
      sourcePath: mapping.sourcePath,
      targetPath: params.targetPath,
      status: "conflict" as const,
      reason: "Identical adapter manifest is not registered in the server-owned manifest.",
    }));
  }

  try {
    const targetStat = await lstat(targetAbs);
    if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
      return params.mappings.map((mapping) => ({
        engineId: params.projection.engineId,
        resourceId: mapping.resourceId,
        action: mapping.action,
        sourcePath: mapping.sourcePath,
        targetPath: mapping.targetPath,
        status: "conflict",
        reason: "Adapter injection target exists and is not a directory.",
      }));
    }
  } catch {
    // Directory will be created below.
  }

  const existingTarget = await inspectExistingProjectionTarget(
    adapterManifestAbs,
    params.ownership.projectRoot,
  );
  if (existingTarget) {
    if (
      !lastAdapterMapping ||
      !isRegisteredProjectionEntry(
        params.manifest,
        adapterManifestKey,
        lastAdapterMapping.resourceId,
        "adapter-inject",
      )
    ) {
      return params.mappings.map((mapping) => ({
        engineId: params.projection.engineId,
        resourceId: mapping.resourceId,
        action: "adapter-inject" as const,
        sourcePath: mapping.sourcePath,
        targetPath: params.targetPath,
        status: "conflict" as const,
        reason: "Target exists and is not managed by the server-owned manifest.",
      }));
    }
    if (!params.ownership.store || !params.ownership.ownerId || params.dryRun) {
      return params.mappings.map((mapping) => ({
        engineId: params.projection.engineId,
        resourceId: mapping.resourceId,
        action: "adapter-inject",
        sourcePath: mapping.sourcePath,
        targetPath: params.targetPath,
        status: "conflict",
        reason:
          "Existing adapter replacement is disabled until a server-owned filesystem CAS store is injected.",
      }));
    }
    const entry: WorkingManifestEntry = {
      engineId: params.projection.engineId,
      resourceId: lastAdapterMapping?.resourceId ?? "",
      action: "adapter-inject",
      sourcePath: lastAdapterMapping?.sourcePath,
      targetPath: params.targetPath,
      contentHash,
      updatedAt: new Date().toISOString(),
      contributors,
    };
    const mutation = await invokeExistingProjectionReplacement({
      ownership: params.ownership,
      manifest: params.manifest,
      manifestValue: projectionManifestValueWithEntry(params.manifest, adapterManifestKey, entry),
      targetAbs: adapterManifestAbs,
      action: "adapter-inject",
      resourceIds: params.mappings.map((mapping) => mapping.resourceId),
      sourcePaths: params.mappings.map((mapping) => mapping.sourcePath),
      contentHash,
      target: { kind: "file", content: Buffer.from(content), contentHash },
    });
    if (mutation.status !== "applied") {
      return params.mappings.map((mapping) => ({
        engineId: params.projection.engineId,
        resourceId: mapping.resourceId,
        action: "adapter-inject",
        sourcePath: mapping.sourcePath,
        targetPath: params.targetPath,
        status: materializeStatusForMutation(mutation.status),
        reason: mutation.reason ?? "Filesystem CAS refused existing adapter replacement.",
      }));
    }
    params.manifest.entries[adapterManifestKey] = entry;
    return params.mappings.map((mapping) => ({
      engineId: params.projection.engineId,
      resourceId: mapping.resourceId,
      action: "adapter-inject",
      sourcePath: mapping.sourcePath,
      targetPath: params.targetPath,
      status: "updated",
    }));
  }

  if (!params.ownership.store || !params.ownership.ownerId || params.dryRun) {
    return params.mappings.map((mapping) => ({
      engineId: params.projection.engineId,
      resourceId: mapping.resourceId,
      action: mapping.action,
      sourcePath: mapping.sourcePath,
      targetPath: mapping.targetPath,
      status: "conflict",
      reason: params.dryRun
        ? "Dry run: projection creation was not attempted."
        : noAuthorityCreationReason(),
    }));
  }

  const entry: WorkingManifestEntry = {
    engineId: params.projection.engineId,
    resourceId: lastAdapterMapping?.resourceId ?? "",
    action: "adapter-inject",
    sourcePath: lastAdapterMapping?.sourcePath,
    targetPath: params.targetPath,
    contentHash,
    updatedAt: new Date().toISOString(),
    contributors,
  };
  const mutation = await invokeNewProjectionCreate({
    ownership: params.ownership,
    manifest: params.manifest,
    manifestValue: projectionManifestValueWithEntry(params.manifest, adapterManifestKey, entry),
    targetAbs: adapterManifestAbs,
    action: "adapter-inject",
    resourceIds: params.mappings.map((mapping) => mapping.resourceId),
    sourcePaths: params.mappings.map((mapping) => mapping.sourcePath),
    contentHash,
    target: { kind: "file", content: Buffer.from(content), contentHash },
  });
  if (mutation.status !== "applied") {
    return params.mappings.map((mapping) => ({
      engineId: params.projection.engineId,
      resourceId: mapping.resourceId,
      action: "adapter-inject",
      sourcePath: mapping.sourcePath,
      targetPath: params.targetPath,
      status: materializeStatusForMutation(mutation.status),
      reason: mutation.reason ?? "Filesystem CAS refused new adapter creation.",
    }));
  }

  params.manifest.entries[adapterManifestKey] = entry;

  return params.mappings.map((mapping) => ({
    engineId: params.projection.engineId,
    resourceId: mapping.resourceId,
    action: "adapter-inject",
    sourcePath: mapping.sourcePath,
    targetPath: params.targetPath,
    status: "created",
  }));
}

function groupByTarget(
  mappings: ReadonlyArray<MossResourcePathMapping>,
): Map<string, MossResourcePathMapping[]> {
  const groups = new Map<string, MossResourcePathMapping[]>();
  for (const mapping of mappings) {
    if (!mapping.targetPath) continue;
    const group = groups.get(mapping.targetPath) ?? [];
    group.push(mapping);
    groups.set(mapping.targetPath, group);
  }
  return groups;
}

export async function materializeMossProjection(
  options: MaterializeMossProjectionOptions,
): Promise<MossProjectionMaterializeResult[]> {
  return withProjectionMutationLock(
    options,
    async (ownership) => {
      const manifest = await readManifest(ownership.projectRoot, ownership);
      const results: MossProjectionMaterializeResult[] = [];

      const symlinks = options.projection.mappings.filter(
        (mapping) => mapping.action === "symlink",
      );
      for (const mapping of symlinks) {
        results.push(
          await materializeSymlink({
            projectPath: options.projectPath,
            ownership,
            engineId: options.projection.engineId,
            mapping,
            manifest,
            dryRun: options.dryRun,
          }),
        );
      }

      const copies = options.projection.mappings.filter((mapping) => mapping.action === "copy");
      for (const mapping of copies) {
        results.push(
          await materializeCopy({
            projectPath: options.projectPath,
            ownership,
            engineId: options.projection.engineId,
            mapping,
            manifest,
            dryRun: options.dryRun,
          }),
        );
      }

      const managedBridgeGroups = groupByTarget(
        options.projection.mappings.filter((mapping) => mapping.action === "managed-bridge"),
      );
      for (const [targetPath, mappings] of managedBridgeGroups) {
        results.push(
          ...(await materializeManagedBridge({
            projectPath: options.projectPath,
            ownership,
            projection: options.projection,
            mappings,
            targetPath,
            manifest,
            dryRun: options.dryRun,
          })),
        );
      }

      const adapterInjectionGroups = groupByTarget(
        options.projection.mappings.filter((mapping) => mapping.action === "adapter-inject"),
      );
      for (const [targetPath, mappings] of adapterInjectionGroups) {
        results.push(
          ...(await materializeAdapterInjection({
            projectPath: options.projectPath,
            ownership,
            projection: options.projection,
            mappings,
            targetPath,
            manifest,
            dryRun: options.dryRun,
          })),
        );
      }

      for (const mapping of options.projection.mappings) {
        if (
          mapping.action === "symlink" ||
          mapping.action === "copy" ||
          mapping.action === "managed-bridge" ||
          mapping.action === "adapter-inject"
        ) {
          continue;
        }
        results.push({
          engineId: options.projection.engineId,
          resourceId: mapping.resourceId,
          action: mapping.action,
          sourcePath: mapping.sourcePath,
          targetPath: mapping.targetPath,
          status: mapping.action === "native" ? "skipped" : "unsupported",
          reason: mapping.reason,
        });
      }

      return results;
    },
    options.dryRun,
  );
}

// ── Workspace orchestration ─────────────────────────────────────────────────

export interface MossEngineProjectionSummary {
  created: number;
  updated: number;
  skipped: number;
  conflict: number;
  unsupported: number;
  total: number;
}

export interface MaterializedMossEngineProjection {
  engineId: ProviderKind;
  projectPath: string;
  projectionStatus: MossEngineResourceProjection["status"] | "skipped";
  warnings: ReadonlyArray<string>;
  results: MossProjectionMaterializeResult[];
  summary: MossEngineProjectionSummary;
  reason?: string | undefined;
  /** Set when the engine projection threw instead of completing. */
  failed?: boolean | undefined;
}

export interface MaterializeMossWorkspaceProjectionsOptions {
  projectPath: string;
  engines?: ReadonlyArray<ProviderKind> | undefined;
  dryRun?: boolean | undefined;
  ownershipStore?: MossProjectionOwnershipStore | undefined;
  ownershipOwnerId?: string | undefined;
  ownershipGeneration?: string | undefined;
}

export interface MaterializedMossWorkspaceProjections {
  projectPath: string;
  dryRun: boolean;
  projections: MaterializedMossEngineProjection[];
}

export function summarizeMossProjectionResults(
  results: ReadonlyArray<MossProjectionMaterializeResult>,
): MossEngineProjectionSummary {
  const summary: Record<MossProjectionMaterializeStatus, number> = {
    created: 0,
    updated: 0,
    skipped: 0,
    conflict: 0,
    unsupported: 0,
  };

  for (const result of results) {
    summary[result.status] += 1;
  }

  return {
    ...summary,
    total: results.length,
  };
}

function skippedEngineProjection(params: {
  projectPath: string;
  engineId: ProviderKind;
  reason: string;
  failed?: boolean | undefined;
}): MaterializedMossEngineProjection {
  return {
    engineId: params.engineId,
    projectPath: params.projectPath,
    projectionStatus: "skipped",
    warnings: [],
    results: [],
    summary: summarizeMossProjectionResults([]),
    reason: params.reason,
    ...(params.failed ? { failed: true } : {}),
  };
}

/**
 * Materialize the workspace's `.moss` source for the requested engines
 * (default: the SY2 lead engines). Engine failures degrade to a per-engine
 * `failed` result instead of aborting the other engines.
 */
export async function materializeMossWorkspaceProjections(
  options: MaterializeMossWorkspaceProjectionsOptions,
): Promise<MaterializedMossWorkspaceProjections> {
  const engines = options.engines ?? MOSS_PROJECTION_ENGINE_IDS;
  const resources = await discoverMossSourceResources(options.projectPath);
  if (resources.length === 0) {
    return {
      projectPath: options.projectPath,
      dryRun: Boolean(options.dryRun),
      projections: engines.map((engineId) =>
        skippedEngineProjection({
          engineId,
          projectPath: options.projectPath,
          reason: "No .moss Unified Source was found for this project.",
        }),
      ),
    };
  }

  const projections: MaterializedMossEngineProjection[] = [];
  for (const engineId of engines) {
    try {
      // Only the two lead engines are materialized on disk. The other six
      // ProviderKind engines have governance mappings (SY8) but land their one
      // native surface (MCP) through the runtime, not the filesystem — the ACP
      // family injects it into the session/new handshake, and config-file
      // engines carry declarative bridge targets. Report those without touching
      // the manifest or the filesystem, even if explicitly requested.
      if (!isMossProjectionEngineId(engineId)) {
        const projection = buildMossEngineProjection(engineId, resources);
        projections.push({
          engineId,
          projectPath: options.projectPath,
          projectionStatus: "unsupported",
          warnings: [
            `${engineId} is not materialized on disk; its MCP surface is injected at runtime (SY8). Governance mappings: ${projection.mappings.length}.`,
          ],
          results: [],
          summary: summarizeMossProjectionResults([]),
        });
        continue;
      }
      const projection = buildMossEngineProjection(engineId, resources);
      if (projection.status === "unsupported") {
        // No projection targets for this engine yet: report it without
        // touching the manifest or the filesystem.
        projections.push({
          engineId,
          projectPath: options.projectPath,
          projectionStatus: projection.status,
          warnings: projection.warnings,
          results: [],
          summary: summarizeMossProjectionResults([]),
        });
        continue;
      }
      const results = await materializeMossProjection({
        projectPath: options.projectPath,
        projection,
        dryRun: options.dryRun,
        ...(options.ownershipStore ? { ownershipStore: options.ownershipStore } : {}),
        ...(options.ownershipOwnerId ? { ownershipOwnerId: options.ownershipOwnerId } : {}),
        ...(options.ownershipGeneration
          ? { ownershipGeneration: options.ownershipGeneration }
          : {}),
      });
      projections.push({
        engineId,
        projectPath: options.projectPath,
        projectionStatus: projection.status,
        warnings: projection.warnings,
        results,
        summary: summarizeMossProjectionResults(results),
      });
    } catch (error) {
      projections.push(
        skippedEngineProjection({
          engineId,
          projectPath: options.projectPath,
          reason: error instanceof Error ? error.message : String(error),
          failed: true,
        }),
      );
    }
  }

  return {
    projectPath: options.projectPath,
    dryRun: Boolean(options.dryRun),
    projections,
  };
}
