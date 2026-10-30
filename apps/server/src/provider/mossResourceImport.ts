import { supportsPosixPermissions } from "@synara/shared/filesystemPlatform";
// FILE: mossResourceImport.ts
// Purpose: Inventory and safely import provider-native skills, plugins, and
//          MCP servers into the workspace's Moss canonical source.
// Safety:  Inventory and planning are read-only. Apply never mutates a source
//          path, never follows an escaping symlink, never overwrites a
//          canonical resource, and records a reversible transaction.

import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as nodePath from "node:path";

import type {
  MossResourceImportApplyInput,
  MossResourceImportApplyResult,
  MossResourceImportFormat,
  MossResourceImportInventoryInput,
  MossResourceImportInventoryResult,
  MossResourceImportIssue,
  MossResourceImportIssueCode,
  MossResourceImportJournal,
  MossResourceImportJournalChange,
  MossResourceImportKind,
  MossResourceImportLocalSource,
  MossResourceImportOperation,
  MossResourceImportOperationResult,
  MossResourceImportPlan,
  MossResourceImportPlanInput,
  MossResourceImportPlanResult,
  MossResourceImportProvenanceManifest,
  MossResourceImportProvenanceRecord,
  MossResourceImportProvider,
  MossResourceImportReceipt,
  MossResourceImportResource,
  MossResourceImportRollbackInput,
  MossResourceImportRollbackResult,
  MossResourceImportRoot,
  MossResourceImportScope,
  MossResourceImportSelectionOrigin,
  MossResourceImportTransactionState,
  MossCanonicalRootDescriptor,
  MossFilesystemCapability,
  MossFilesystemIdentity,
  MossFilesystemCapabilityResult,
  MossOwnershipStore,
  MossPrivateManifest,
  MossPrivateManifestInput,
  MossPrivateManifestReceipt,
  MossPrivateRecordCompactionInput,
  MossPrivateRecordCompactionReceipt,
  MossPrivateStageInput,
  MossPrivateSnapshotPublishInput,
  MossPrivateSnapshotReceipt,
  MossPrivateStage,
  MossPrivateStagePayload,
  MossPrivateSnapshotAuthority,
  MossPrivateStageRecoveryInput,
} from "@synara/contracts";
import {
  MOSS_RESOURCE_IMPORT_JOURNAL_SCHEMA_VERSION,
  MossResourceImportJournal as MossResourceImportJournalSchema,
  MossResourceImportProvenanceManifest as MossResourceImportProvenanceManifestSchema,
  MossResourceImportReceipt as MossResourceImportReceiptSchema,
} from "@synara/contracts";
import { parseScalarFrontmatter, readStringField } from "@synara/shared/frontmatter";
import { getMossSourceLayout } from "@synara/shared/mossSourceLayout";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { Schema } from "effect";

import {
  MossCanonicalMutationIntentError,
  deriveMossResourceImportMutationKey,
  deriveMossResourceImportTransactionId,
  registerMossResourceImportPlan,
  resolveMossResourceImportPlan,
} from "./mossCanonicalMutationIntent.ts";
import type { MossPrivatePlanRegistryOptions } from "./mossCanonicalMutationIntent.ts";

const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_TREE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_TREE_DEPTH = 16;
const MAX_TREE_ENTRIES = 2_000;
const DEFAULT_MAX_MCP_SERVERS = 500;
const DEFAULT_MAX_SKILLS = 500;
const DEFAULT_MAX_PLUGINS = 500;
const DEFAULT_MAX_RESOURCES = 1_000;
const DEFAULT_MAX_DIRECTORIES = 2_000;
const DEFAULT_MAX_SYMLINKS = 500;
const DEFAULT_MAX_PLAN_OPERATIONS = 500;
const DEFAULT_MAX_RESULT_OPERATIONS = 500;
const DEFAULT_PLAN_TTL_MILLIS = 5 * 60 * 1_000;
const MAX_ALLOWED_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ALLOWED_TREE_BYTES = 256 * 1024 * 1024;
const MAX_ALLOWED_TREE_ENTRIES = 10_000;
const MAX_ALLOWED_TOTAL_RESOURCES = 2_000;
const MAX_ALLOWED_OPERATION_RESULTS = 1_000;
const DEFAULT_MAX_HASH_BYTES = DEFAULT_MAX_TREE_BYTES;
const DEFAULT_MAX_HASH_DEPTH = DEFAULT_MAX_TREE_DEPTH;
const DEFAULT_MAX_HASH_MILLIS = 5_000;
const DEFAULT_MAX_STATE_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_STATE_ENTRIES = 20_000;
const PRIVATE_STAGE_ORPHAN_GRACE_MILLIS = 60_000;
const MAX_IMPORT_NAME_LENGTH = 240;
const PROVENANCE_FILE_NAME = "provenance.json";
const TRANSACTIONS_DIR_NAME = "transactions";
const RECEIPTS_DIR_NAME = "receipts";
const RESERVED_MCP_IDENTITY = "moss";

type ImportFormat = MossResourceImportFormat;
type ImportScope = MossResourceImportScope;
type ImportProvider = MossResourceImportProvider;

export type MossResourceImportFilesystemMutationAction =
  | "before-create"
  | "before-replace"
  | "before-remove"
  | "after-lstat-before-publish"
  | "after-hash-before-remove"
  | "after-readdir-before-copy";

export interface MossResourceImportFilesystemMutationContext {
  readonly action: MossResourceImportFilesystemMutationAction;
  readonly path: string;
  readonly operationId?: string;
  readonly kind?: MossResourceImportKind;
}

export type MossResourceImportFilesystemMutationHook = (
  context: MossResourceImportFilesystemMutationContext,
) => void | Promise<void>;

export type MossResourceImportDirectorySyncHook = (directoryPath: string) => void | Promise<void>;

export interface MossResourceImportOptions {
  readonly homeDir?: string;
  /** Dedicated private server-owned resource-import child; workspace `.moss` is never authority. */
  readonly stateDir?: string;
  readonly now?: () => Date;
  readonly maxFileBytes?: number;
  readonly maxTreeBytes?: number;
  readonly maxTreeDepth?: number;
  readonly maxTreeEntries?: number;
  readonly maxDirectories?: number;
  readonly maxSymlinks?: number;
  readonly maxSkills?: number;
  readonly maxPlugins?: number;
  readonly maxResources?: number;
  readonly maxPlanOperations?: number;
  readonly maxResultOperations?: number;
  readonly maxMcpServers?: number;
  readonly maxHashBytes?: number;
  readonly maxHashDepth?: number;
  readonly maxHashMillis?: number;
  readonly ownerId?: string;
  readonly issuer?: string;
  readonly sessionId?: string;
  /** Server-resolved project and authenticated principal bindings. */
  readonly projectId?: string;
  readonly principalId?: string;
  readonly workspaceId?: string;
  readonly planTtlMillis?: number;
  readonly planRegistry?: MossPrivatePlanRegistryOptions;
  readonly requireOwner?: boolean;
  readonly authorizedWorkspace?: boolean;
  readonly selectionTicketVerifier?: MossResourceImportSelectionTicketVerifier;
  readonly selectionTicket?: string;
  readonly selectionSecurityProfile?: string;
  readonly selectionLicenseState?: string;
  readonly ownershipStore?: MossOwnershipStore;
  readonly filesystemCapability?: MossFilesystemCapability;
  readonly checkpointHook?: MossResourceImportCheckpointHook;
  readonly beforeFilesystemMutation?: MossResourceImportFilesystemMutationHook;
  readonly directorySyncHook?: MossResourceImportDirectorySyncHook;
}

export interface MossResourceImportCheckpointContext {
  readonly transactionId: string;
  readonly state: MossResourceImportTransactionState;
  readonly operationId?: string;
  readonly kind?: MossResourceImportKind;
  readonly targetPath?: string;
  readonly stagingPath?: string;
}

export type MossResourceImportCheckpointHook = (
  context: MossResourceImportCheckpointContext,
) => void | Promise<void>;

export interface MossResourceImportSelectionTicketContext {
  readonly ticket: string;
  readonly ownerId: string;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly selectionSnapshotSha256: string;
  readonly resourceIds: readonly string[];
  readonly securityProfile: string;
  readonly licenseState: string;
}

export interface MossResourceImportSelectionTicketVerifier {
  readonly verify: (
    context: MossResourceImportSelectionTicketContext,
    options?: { readonly consume?: boolean },
  ) => Promise<
    | { readonly valid: true; readonly securityProfile: string; readonly licenseState: string }
    | {
        readonly valid: false;
        readonly code: "ticket-invalid" | "ticket-expired" | "ticket-revoked" | "ticket-mismatch";
      }
  >;
}

export type MossResourceImportInventoryRequest = MossResourceImportInventoryInput &
  MossResourceImportOptions;
export type MossResourceImportPlanRequest = MossResourceImportPlanInput & MossResourceImportOptions;
export type MossResourceImportApplyRequest = MossResourceImportApplyInput &
  MossResourceImportOptions;
export type MossResourceImportRollbackRequest = MossResourceImportRollbackInput &
  MossResourceImportOptions;

export class MossResourceImportError extends Error {
  readonly code: MossResourceImportIssueCode;

  constructor(code: MossResourceImportIssueCode, message: string) {
    super(message);
    this.name = "MossResourceImportError";
    this.code = code;
  }
}

function snapshotPlanNonce(planId: string): string {
  return `plan-nonce-${sha256(planId).slice(0, 32)}`;
}

function snapshotOperationId(kind: MossResourceImportKind, snapshotSha256: string): string {
  return `snapshot-${sha256(stableJson({ kind, snapshotSha256 })).slice(0, 32)}`;
}

function snapshotAuthorityForPlan(
  cwd: string,
  options: ReturnType<typeof importOptions>,
  planId: string,
  planNonce: string,
  kind: MossResourceImportKind,
  snapshotSha256: string,
): MossPrivateSnapshotAuthority {
  const workspaceId = options.workspaceId ?? workspaceBindingId(cwd);
  const projectId = options.projectId ?? workspaceId;
  return {
    canonicalRoot: nodePath.resolve(getMossSourceLayout(cwd).root),
    stateRoot: nodePath.resolve(options.stateDir),
    ownerId: options.ownerId,
    projectId,
    workspaceId,
    principalId: options.principalId,
    sessionId: options.sessionId,
    transactionId: `transaction-${sha256(planId).slice(0, 32)}`,
    operationId: snapshotOperationId(kind, snapshotSha256),
    fencingToken: `plan-fence-${sha256(planNonce).slice(0, 32)}`,
    generation: `plan-generation-${sha256(planNonce).slice(0, 32)}`,
    nonce: planNonce,
    kind,
    snapshotSha256,
  };
}

function snapshotKeyForAuthority(authority: MossPrivateSnapshotAuthority): string {
  return sha256(
    stableJson({
      schemaVersion: 1,
      canonicalRoot: nodePath.resolve(authority.canonicalRoot),
      stateRoot: nodePath.resolve(authority.stateRoot),
      ownerId: authority.ownerId,
      projectId: authority.projectId,
      workspaceId: authority.workspaceId,
      principalId: authority.principalId,
      sessionId: authority.sessionId,
      transactionId: authority.transactionId,
      operationId: authority.operationId,
      fencingToken: authority.fencingToken,
      generation: authority.generation,
      nonce: authority.nonce,
      kind: authority.kind,
      snapshotSha256: authority.snapshotSha256,
    }),
  );
}

function isServerCanonicalRoot(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\u0000") &&
    nodePath.isAbsolute(value) &&
    nodePath.resolve(value) === value
  );
}

function assertServerCanonicalRoot(value: unknown): asserts value is string {
  if (!isServerCanonicalRoot(value)) {
    throw snapshotInvalid("The server canonical root is missing or unsafe.");
  }
}

function privateStageRecoveryInput(
  cwd: string,
  options: ReturnType<typeof importOptions>,
): MossPrivateStageRecoveryInput {
  return {
    stateRoot: nodePath.resolve(options.stateDir),
    canonicalRoot: nodePath.resolve(getMossSourceLayout(cwd).root),
  };
}

interface RootSpec {
  readonly provider: ImportProvider;
  readonly kind: "skills" | "plugins" | "mcp";
  readonly relativePath: string;
  readonly format?: "json" | "toml";
}

interface ResolvedRoot extends RootSpec {
  readonly scope: ImportScope;
  readonly path: string;
}

function privateStageInput(
  options: ReturnType<typeof importOptions>,
  authority: MossPrivateSnapshotAuthority,
): MossPrivateStageInput {
  assertServerCanonicalRoot(authority.canonicalRoot);
  const createdAt = options.now().toISOString();
  return {
    transactionId: authority.transactionId,
    operationId: authority.operationId,
    kind: authority.kind,
    canonicalRoot: authority.canonicalRoot,
    ownerId: authority.ownerId,
    projectId: authority.projectId,
    workspaceId: authority.workspaceId,
    principalId: authority.principalId,
    sessionId: authority.sessionId,
    fencingToken: authority.fencingToken,
    generation: authority.generation,
    nonce: authority.nonce,
    createdAt,
    leaseExpiresAt: new Date(options.now().getTime() + options.planTtlMillis).toISOString(),
  };
}

const ROOT_SPECS: readonly RootSpec[] = [
  { provider: "codex", kind: "skills", relativePath: ".codex/skills" },
  { provider: "codex", kind: "plugins", relativePath: ".codex/plugins" },
  { provider: "codex", kind: "plugins", relativePath: ".codex-plugin" },
  { provider: "codex", kind: "mcp", relativePath: ".codex/config.toml", format: "toml" },
  { provider: "codex", kind: "mcp", relativePath: ".codex/mcp.json", format: "json" },

  { provider: "claude", kind: "skills", relativePath: ".claude/skills" },
  { provider: "claude", kind: "plugins", relativePath: ".claude/plugins" },
  { provider: "claude", kind: "plugins", relativePath: ".claude-plugin" },
  { provider: "claude", kind: "mcp", relativePath: ".claude.json", format: "json" },
  { provider: "claude", kind: "mcp", relativePath: ".mcp.json", format: "json" },
  { provider: "claude", kind: "mcp", relativePath: ".claude/mcp.json", format: "json" },
  { provider: "claude", kind: "mcp", relativePath: ".claude/settings.json", format: "json" },

  { provider: "agents", kind: "skills", relativePath: ".agents/skills" },
  { provider: "agents", kind: "plugins", relativePath: ".agents/plugins" },
  { provider: "agents", kind: "mcp", relativePath: ".agents/mcp.json", format: "json" },
  { provider: "agents", kind: "mcp", relativePath: ".agents/config.json", format: "json" },

  { provider: "cursor", kind: "skills", relativePath: ".cursor/skills" },
  { provider: "cursor", kind: "plugins", relativePath: ".cursor/plugins" },
  { provider: "cursor", kind: "mcp", relativePath: ".cursor/mcp.json", format: "json" },
  { provider: "cursor", kind: "mcp", relativePath: ".cursor/settings.json", format: "json" },

  { provider: "gemini", kind: "skills", relativePath: ".gemini/skills" },
  { provider: "gemini", kind: "plugins", relativePath: ".gemini/extensions" },
  { provider: "gemini", kind: "mcp", relativePath: ".gemini/mcp.json", format: "json" },
  { provider: "gemini", kind: "mcp", relativePath: ".gemini/settings.json", format: "json" },

  { provider: "grok", kind: "skills", relativePath: ".grok/skills" },
  { provider: "grok", kind: "plugins", relativePath: ".grok/plugins" },
  { provider: "grok", kind: "mcp", relativePath: ".grok/mcp.json", format: "json" },
  { provider: "grok", kind: "mcp", relativePath: ".grok/config.json", format: "json" },

  { provider: "opencode", kind: "skills", relativePath: ".config/opencode/skills" },
  { provider: "opencode", kind: "plugins", relativePath: ".config/opencode/plugins" },
  { provider: "opencode", kind: "plugins", relativePath: ".config/opencode/extensions" },
  { provider: "opencode", kind: "skills", relativePath: ".opencode/skills" },
  { provider: "opencode", kind: "plugins", relativePath: ".opencode/plugins" },
  {
    provider: "opencode",
    kind: "mcp",
    relativePath: ".config/opencode/opencode.json",
    format: "json",
  },
  { provider: "opencode", kind: "mcp", relativePath: ".config/opencode/mcp.json", format: "json" },
  { provider: "opencode", kind: "mcp", relativePath: ".opencode/opencode.json", format: "json" },
  { provider: "opencode", kind: "mcp", relativePath: ".opencode/mcp.json", format: "json" },

  { provider: "pi", kind: "skills", relativePath: ".pi/agent/skills" },
  { provider: "pi", kind: "plugins", relativePath: ".pi/agent/extensions" },
  { provider: "pi", kind: "plugins", relativePath: ".pi/agent/plugins" },
  { provider: "pi", kind: "mcp", relativePath: ".pi/agent/mcp.json", format: "json" },
  { provider: "pi", kind: "mcp", relativePath: ".pi/agent/settings.json", format: "json" },
];

const PLUGIN_MANIFESTS = [
  ".codex-plugin/plugin.json",
  ".claude-plugin/plugin.json",
  ".factory-plugin/plugin.json",
  "plugin.json",
] as const;

const SECRET_KEY_PATTERN =
  /(?:api[-_]?key|access[-_]?token|auth(?:orization)?|client[-_]?secret|credential|cookie|jwt|password|private[-_]?key|refresh[-_]?token|secret|session[-_]?token|token)/i;
const SECRET_VALUE_PATTERNS = [
  /\b(?:sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9_\-]{16,}|github_pat_[A-Za-z0-9_\-]{16,})\b/i,
  /\bBearer\s+[A-Za-z0-9._\-]{16,}/i,
  /(?:api[-_]?key|access[-_]?token|client[-_]?secret|password|secret|token)\s*[:=]\s*["']?[^\s"']{12,}/i,
];

interface TreeInspection {
  readonly sourceSha256: string;
  readonly sizeBytes: number;
  readonly fileCount: number;
  readonly directoryCount: number;
  readonly symlinkCount: number;
  readonly attemptedEntries: number;
  readonly secretFields: readonly string[];
  readonly safe: boolean;
}

interface ParsedMcpConfig {
  readonly value: Record<string, unknown>;
  readonly format: "json" | "toml";
}

interface McpEntry {
  readonly table: string;
  readonly name: string;
  readonly canonicalName: string;
  readonly value: Record<string, unknown>;
}

interface ChangeRecord {
  readonly operation: MossResourceImportOperation;
  readonly targetPath: string;
  readonly kind: MossResourceImportKind;
  readonly beforeHash: string;
  readonly afterHash: string;
  readonly beforeConfigExisted?: boolean;
  readonly stagingPath?: string;
  readonly markerPath?: string;
  readonly receiptPath?: string;
  readonly receiptNonce?: string;
}

/** The wire resource path is opaque; only the in-process plan can resolve it. */
const LOCAL_SOURCE_PATHS = new WeakMap<object, string>();

function resourceSourcePath(resource: MossResourceImportResource): string {
  return LOCAL_SOURCE_PATHS.get(resource) ?? resource.sourcePath;
}

type ProvenanceRecord = MossResourceImportProvenanceRecord;
type ProvenanceManifest = MossResourceImportProvenanceManifest;
type TransactionJournal = MossResourceImportJournal;
type ImportReceipt = MossResourceImportReceipt;

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function withoutExtension(value: string): string {
  return value.replace(/\.(?:json|markdown?|md|toml)$/iu, "");
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some((descriptor) => !("value" in descriptor))) {
      return undefined;
    }
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function isPlainRecordTree(value: unknown): boolean {
  if (Array.isArray(value)) return value.every((entry) => isPlainRecordTree(entry));
  if (value === null || typeof value !== "object") return true;
  const record = recordValue(value);
  if (!record) return false;
  return Object.keys(record).every((key) => {
    if (unsafeRecordKey(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor !== undefined && "value" in descriptor && isPlainRecordTree(descriptor.value);
  });
}

/** Testable server-side guard for recursively plain MCP input records. */
export function isMossResourceImportPlainRecord(value: unknown): boolean {
  return recordValue(value) !== undefined && isPlainRecordTree(value);
}

function isWithin(root: string, candidate: string, strict = false): boolean {
  const rootResolved = nodePath.resolve(root);
  const candidateResolved = nodePath.resolve(candidate);
  if (!strict && rootResolved === candidateResolved) return true;
  if (rootResolved === candidateResolved) return false;
  const relative = nodePath.relative(rootResolved, candidateResolved);
  return relative !== "" && !relative.startsWith("..") && !nodePath.isAbsolute(relative);
}

async function realpathNearestExisting(filePath: string): Promise<string> {
  let current = nodePath.resolve(filePath);
  while (true) {
    const real = await fs.realpath(current).catch(() => null);
    if (real !== null) return real;
    const parent = nodePath.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

const COMMON_CONFUSABLES: Readonly<Record<string, string>> = {
  ß: "ss",
  а: "a",
  Α: "a",
  α: "a",
  е: "e",
  Ε: "e",
  ε: "e",
  о: "o",
  Ο: "o",
  ο: "o",
  р: "p",
  Ρ: "p",
  ρ: "p",
  с: "c",
  С: "c",
  х: "x",
  Χ: "x",
  χ: "x",
  у: "y",
  Υ: "y",
  υ: "y",
  і: "i",
  Ι: "i",
  ι: "i",
  ј: "j",
  Ј: "j",
};

function providerSanitizedIdentity(name: string): string {
  const nfkc = name.normalize("NFKC").toLocaleLowerCase("en-US");
  const confusableFolded = [...nfkc]
    .map((character) => COMMON_CONFUSABLES[character] ?? character)
    .join("");
  return confusableFolded
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function canonicalIdentityKey(input: {
  readonly kind: MossResourceImportKind;
  readonly name: string;
}): string {
  const slug =
    input.kind === "mcp"
      ? (normalizeMcpEntryName(input.name)?.toLocaleLowerCase("en-US") ?? "")
      : providerSanitizedIdentity(input.name);
  return `identity-${sha256(stableJson({ kind: input.kind, slug })).slice(0, 32)}`;
}

function isReservedMcpIdentity(name: string): boolean {
  return normalizeMcpEntryName(name)?.toLocaleLowerCase("en-US") === RESERVED_MCP_IDENTITY;
}

function issue(
  code: MossResourceImportIssueCode,
  message: string,
  sourcePath?: string,
  fieldPaths: readonly string[] = [],
  severity: MossResourceImportIssue["severity"] = "warning",
): MossResourceImportIssue {
  return {
    code,
    severity,
    message: message.slice(0, 1_000),
    ...(sourcePath ? { sourcePath } : {}),
    fieldPaths: [...fieldPaths],
  };
}

function defaultNow(): Date {
  return new Date();
}

function importOptions(options: MossResourceImportOptions): Required<
  Pick<
    MossResourceImportOptions,
    | "maxFileBytes"
    | "maxTreeBytes"
    | "maxTreeDepth"
    | "maxTreeEntries"
    | "maxDirectories"
    | "maxSymlinks"
    | "maxSkills"
    | "maxPlugins"
    | "maxResources"
    | "maxPlanOperations"
    | "maxResultOperations"
    | "maxMcpServers"
    | "maxHashBytes"
    | "maxHashDepth"
    | "maxHashMillis"
  >
> & {
  readonly now: () => Date;
  readonly homeDir: string;
  readonly stateDir: string;
  readonly ownerId: string;
  readonly issuer: string;
  readonly sessionId: string;
  readonly projectId?: string;
  readonly principalId: string;
  readonly workspaceId?: string;
  readonly activeFencingToken?: string;
  readonly activeGeneration?: string;
  readonly activeLockNonce?: string;
  readonly planTtlMillis: number;
  readonly planRegistry?: MossPrivatePlanRegistryOptions;
  readonly requireOwner: boolean;
  readonly authorizedWorkspace: boolean;
  readonly selectionTicketVerifier?: MossResourceImportSelectionTicketVerifier;
  readonly selectionTicket?: string;
  readonly selectionSecurityProfile: string;
  readonly selectionLicenseState: string;
  readonly ownershipStore: MossOwnershipStore;
  readonly filesystemCapability?: MossFilesystemCapability;
  readonly checkpointHook?: MossResourceImportCheckpointHook;
  readonly beforeFilesystemMutation?: MossResourceImportFilesystemMutationHook;
  readonly directorySyncHook?: MossResourceImportDirectorySyncHook;
} {
  const ownerId = options.ownerId?.trim();
  const issuer = options.issuer?.trim();
  const sessionId = options.sessionId?.trim();
  if (!ownerId || !issuer || !sessionId) {
    throw new MossResourceImportError(
      "authorization-required",
      "Authenticated owner, issuer, and session bindings are required.",
    );
  }
  const stateDir = options.stateDir?.trim();
  if (!stateDir) {
    throw new MossResourceImportError(
      "authorization-required",
      "A trusted server-owned resource import state directory is required.",
    );
  }
  const resolvedStateDir = nodePath.resolve(stateDir);
  const clamp = (value: number | undefined, fallback: number, maximum: number): number =>
    Math.max(0, Math.min(Math.floor(value ?? fallback), maximum));
  return {
    now: options.now ?? defaultNow,
    homeDir: nodePath.resolve(options.homeDir?.trim() || homedir()),
    stateDir: resolvedStateDir,
    maxFileBytes: clamp(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, MAX_ALLOWED_FILE_BYTES),
    maxTreeBytes: clamp(options.maxTreeBytes, DEFAULT_MAX_TREE_BYTES, MAX_ALLOWED_TREE_BYTES),
    maxTreeDepth: clamp(options.maxTreeDepth, DEFAULT_MAX_TREE_DEPTH, 64),
    maxTreeEntries: clamp(options.maxTreeEntries, MAX_TREE_ENTRIES, MAX_ALLOWED_TREE_ENTRIES),
    maxDirectories: clamp(
      options.maxDirectories,
      DEFAULT_MAX_DIRECTORIES,
      MAX_ALLOWED_TREE_ENTRIES,
    ),
    maxSymlinks: clamp(options.maxSymlinks, DEFAULT_MAX_SYMLINKS, MAX_ALLOWED_TREE_ENTRIES),
    maxSkills: clamp(options.maxSkills, DEFAULT_MAX_SKILLS, MAX_ALLOWED_TOTAL_RESOURCES),
    maxPlugins: clamp(options.maxPlugins, DEFAULT_MAX_PLUGINS, MAX_ALLOWED_TOTAL_RESOURCES),
    maxResources: clamp(options.maxResources, DEFAULT_MAX_RESOURCES, MAX_ALLOWED_TOTAL_RESOURCES),
    maxPlanOperations: clamp(
      options.maxPlanOperations,
      DEFAULT_MAX_PLAN_OPERATIONS,
      MAX_ALLOWED_OPERATION_RESULTS,
    ),
    maxResultOperations: clamp(
      options.maxResultOperations,
      DEFAULT_MAX_RESULT_OPERATIONS,
      MAX_ALLOWED_OPERATION_RESULTS,
    ),
    maxMcpServers: clamp(
      options.maxMcpServers,
      DEFAULT_MAX_MCP_SERVERS,
      MAX_ALLOWED_TOTAL_RESOURCES,
    ),
    maxHashBytes: clamp(options.maxHashBytes, DEFAULT_MAX_HASH_BYTES, MAX_ALLOWED_TREE_BYTES),
    maxHashDepth: clamp(options.maxHashDepth, DEFAULT_MAX_HASH_DEPTH, 64),
    maxHashMillis: clamp(options.maxHashMillis, DEFAULT_MAX_HASH_MILLIS, 60_000),
    ownerId,
    issuer,
    sessionId,
    principalId: options.principalId?.trim() || ownerId,
    ...(options.projectId?.trim() ? { projectId: options.projectId.trim() } : {}),
    ...(options.workspaceId?.trim() ? { workspaceId: options.workspaceId.trim() } : {}),
    planTtlMillis: clamp(options.planTtlMillis, DEFAULT_PLAN_TTL_MILLIS, 60 * 60 * 1_000),
    ...(options.planRegistry ? { planRegistry: options.planRegistry } : {}),
    requireOwner: options.requireOwner === true,
    authorizedWorkspace: options.authorizedWorkspace === true,
    ...(options.selectionTicketVerifier
      ? { selectionTicketVerifier: options.selectionTicketVerifier }
      : {}),
    ...(options.selectionTicket ? { selectionTicket: options.selectionTicket } : {}),
    selectionSecurityProfile: options.selectionSecurityProfile ?? "unknown",
    selectionLicenseState: options.selectionLicenseState ?? "unknown",
    ownershipStore: options.ownershipStore ?? makeNodeMossOwnershipStore(resolvedStateDir),
    ...(options.filesystemCapability ? { filesystemCapability: options.filesystemCapability } : {}),
    ...(options.checkpointHook ? { checkpointHook: options.checkpointHook } : {}),
    ...(options.beforeFilesystemMutation
      ? { beforeFilesystemMutation: options.beforeFilesystemMutation }
      : {}),
    ...(options.directorySyncHook ? { directorySyncHook: options.directorySyncHook } : {}),
  };
}

export function getMossResourceImportStateRoot(
  input: {
    readonly homeDir?: string;
    readonly stateDir?: string;
  } = {},
): string {
  // Test-only path helper. Production callers must inject the prepared,
  // server-owned ServerConfig.stateDir into the RPC request.
  return nodePath.resolve(
    input.stateDir?.trim() ||
      nodePath.join(input.homeDir?.trim() || homedir(), ".moss-resource-import-state"),
  );
}

async function ensurePrivateStateRoot(cwd: string, stateRoot: string): Promise<void> {
  const resolvedCwd = nodePath.resolve(cwd);
  const resolvedRoot = nodePath.resolve(stateRoot);
  if (
    resolvedCwd === resolvedRoot ||
    isWithin(resolvedCwd, resolvedRoot, false) ||
    isWithin(resolvedRoot, resolvedCwd, false)
  ) {
    throw new MossResourceImportError(
      "authorization-required",
      "Resource import authority state must not overlap the workspace.",
    );
  }
  const existing = await lstatOrNull(resolvedRoot);
  if (existing?.isSymbolicLink()) {
    throw new MossResourceImportError(
      "symlink-escape",
      "Resource import authority state is a symlink.",
    );
  }
  if (existing && !existing.isDirectory()) {
    throw new MossResourceImportError(
      "transaction-invalid",
      "Resource import authority state is not a directory.",
    );
  }
  const parentPath = nodePath.dirname(resolvedRoot);
  const parentStat = await lstatOrNull(parentPath);
  if (!parentStat || parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new MossResourceImportError(
      parentStat?.isSymbolicLink() ? "symlink-escape" : "authorization-required",
      "Resource import authority state parent is not a prepared server directory.",
    );
  }
  if (!existing) {
    try {
      await fs.mkdir(resolvedRoot, { mode: 0o700 });
    } catch (cause) {
      if (!isErrno(cause, "EEXIST")) {
        throw new MossResourceImportError(
          "authorization-required",
          "Resource import authority state could not be created safely.",
        );
      }
    }
  }
  const noFollow =
    (fsConstants as typeof fsConstants & { readonly O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const directoryOnly =
    (fsConstants as typeof fsConstants & { readonly O_DIRECTORY?: number }).O_DIRECTORY ?? 0;
  let handle: import("node:fs/promises").FileHandle;
  try {
    handle = await fs.open(resolvedRoot, fsConstants.O_RDONLY | directoryOnly | noFollow);
  } catch {
    throw new MossResourceImportError(
      "symlink-escape",
      "Resource import authority state could not be opened without following links.",
    );
  }
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory()) {
      throw new MossResourceImportError(
        "transaction-invalid",
        "Resource import authority state is not a directory.",
      );
    }
    if (supportsPosixPermissions()) await handle.chmod(0o700);
    const verified = await handle.stat();
    if (supportsPosixPermissions() && (verified.mode & 0o077) !== 0) {
      throw new MossResourceImportError(
        "authorization-required",
        "Resource import authority state permissions are too broad.",
      );
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function privateStatePathCheck(
  stateRoot: string,
  targetPath: string,
  createParents: boolean,
  allowMissingParents = false,
): Promise<void> {
  const root = nodePath.resolve(stateRoot);
  const target = nodePath.resolve(targetPath);
  if (!isWithin(root, target, false) || target === root) {
    throw new MossResourceImportError(
      "path-traversal",
      "Resource import state path leaves the server state root.",
    );
  }
  const rootStat = await lstatOrNull(root);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new MossResourceImportError("symlink-escape", "Resource import state root is unsafe.");
  }
  const relativeParent = nodePath.relative(root, nodePath.dirname(target));
  let current = root;
  for (const segment of relativeParent.split(nodePath.sep).filter(Boolean)) {
    current = nodePath.join(current, segment);
    const stat = await lstatOrNull(current);
    if (!stat) {
      if (!createParents) {
        if (allowMissingParents) break;
        throw new MossResourceImportError(
          "transaction-invalid",
          "Resource import state path is missing.",
        );
      }
      try {
        await fs.mkdir(current, { mode: 0o700 });
      } catch (cause) {
        if (!isErrno(cause, "EEXIST")) {
          throw new MossResourceImportError(
            "transaction-invalid",
            "Resource import state parent could not be created safely.",
          );
        }
      }
      const created = await lstatOrNull(current);
      if (!created || created.isSymbolicLink() || !created.isDirectory()) {
        throw new MossResourceImportError(
          "symlink-escape",
          "Resource import state parent is unsafe.",
        );
      }
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new MossResourceImportError(
        "symlink-escape",
        "Resource import state parent is unsafe.",
      );
    }
    if (supportsPosixPermissions() && (stat.mode & 0o077) !== 0) {
      throw new MossResourceImportError(
        "authorization-required",
        "Resource import state parent permissions are too broad.",
      );
    }
  }
  const rootReal = await fs.realpath(root);
  const parentReal = allowMissingParents
    ? await realpathNearestExisting(nodePath.dirname(target))
    : await fs.realpath(nodePath.dirname(target)).catch(() => null);
  if (!parentReal || !isWithin(rootReal, parentReal, false)) {
    throw new MossResourceImportError(
      "symlink-escape",
      "Resource import state parent leaves the server state root.",
    );
  }
}

async function ensurePrivateStatePath(stateRoot: string, targetPath: string): Promise<void> {
  await privateStatePathCheck(stateRoot, targetPath, true);
}

async function assertPrivateStatePath(stateRoot: string, targetPath: string): Promise<void> {
  await privateStatePathCheck(stateRoot, targetPath, false);
}

// A committed journal outlives its cleaned mutation stage. Validate every
// existing ancestor without recreating or requiring the ephemeral stage.
async function assertCleanedPrivateStatePath(stateRoot: string, targetPath: string): Promise<void> {
  await privateStatePathCheck(stateRoot, targetPath, false, true);
}

function privateStateParentGuard(stateRoot: string, filePath: string): CanonicalParentGuard {
  return {
    parentPath: nodePath.dirname(filePath),
    assertUnchanged: () => assertPrivateStatePath(stateRoot, filePath),
  };
}

async function removePrivateStatePath(
  stateRoot: string,
  filePath: string,
  options: {
    readonly recursive?: boolean;
    readonly directorySyncHook?: MossResourceImportDirectorySyncHook | undefined;
  } = {},
): Promise<void> {
  await assertPrivateStatePath(stateRoot, filePath);
  const stat = await lstatOrNull(filePath);
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    throw new MossResourceImportError("symlink-escape", "Private import state path is a symlink.");
  }
  const guard = privateStateParentGuard(stateRoot, filePath);
  await guard.assertUnchanged();
  await fs.rm(filePath, { recursive: options.recursive ?? false, force: true });
  await guard.assertUnchanged();
  await syncDirectory(nodePath.dirname(filePath), options.directorySyncHook);
}

function selectedProvider(
  providers: readonly ImportProvider[] | undefined,
  provider: ImportProvider,
) {
  return providers === undefined || providers.includes(provider);
}

function selectedKind(
  kinds: readonly MossResourceImportKind[] | undefined,
  kind: MossResourceImportKind,
) {
  return kinds === undefined || kinds.includes(kind);
}

function rootResourceKind(rootKind: RootSpec["kind"]): MossResourceImportKind {
  return rootKind === "skills" ? "skill" : rootKind === "plugins" ? "plugin" : "mcp";
}

function rootPath(base: string, relativePath: string): string {
  return nodePath.resolve(base, relativePath);
}

function resolvedRoots(
  cwd: string,
  options: Required<Pick<MossResourceImportOptions, "homeDir">>,
  providers: readonly ImportProvider[] | undefined,
  kinds: readonly MossResourceImportKind[] | undefined,
): ResolvedRoot[] {
  const bases: readonly { readonly scope: ImportScope; readonly path: string }[] = [
    { scope: "workspace", path: nodePath.resolve(cwd) },
    { scope: "user", path: options.homeDir },
  ];
  const roots: ResolvedRoot[] = [];
  const seen = new Set<string>();
  for (const base of bases) {
    for (const spec of ROOT_SPECS) {
      if (!selectedProvider(providers, spec.provider)) continue;
      if (!selectedKind(kinds, rootResourceKind(spec.kind))) continue;
      const path = rootPath(base.path, spec.relativePath);
      const key = `${spec.provider}:${base.scope}:${spec.kind}:${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      roots.push({ ...spec, scope: base.scope, path });
    }
  }
  return roots;
}

async function lstatOrNull(filePath: string): Promise<import("node:fs").Stats | null> {
  return (await lstatResult(filePath)).stat;
}

interface LstatResult {
  readonly stat: import("node:fs").Stats | null;
  readonly error?: unknown;
}

async function lstatResult(filePath: string): Promise<LstatResult> {
  try {
    return { stat: await fs.lstat(filePath) };
  } catch (error) {
    return { stat: null, error };
  }
}

function isPermissionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { readonly code?: unknown }).code;
  return code === "EACCES" || code === "EPERM";
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    (error as { readonly code?: unknown }).code === code
  );
}

async function safeRoot(
  root: ResolvedRoot,
  basePath: string,
  issues: MossResourceImportIssue[],
  permissionPaths: Set<string>,
): Promise<{ readonly path: string; readonly realPath: string } | null> {
  const baseRealPath = await fs.realpath(basePath).catch(() => nodePath.resolve(basePath));
  const result = await lstatResult(root.path);
  const stat = result.stat;
  if (!stat) {
    if (isPermissionError(result.error)) {
      permissionPaths.add(root.path);
      issues.push(
        issue(
          "unreadable",
          `Permission is required to scan this import root: ${root.path}`,
          root.path,
          [],
          "error",
        ),
      );
    }
    return null;
  }
  if (stat.isSymbolicLink()) {
    const target = await fs.realpath(root.path).catch(() => null);
    issues.push(
      issue(
        target && isWithin(baseRealPath, target) ? "symlink" : "symlink-escape",
        target
          ? `Import root is a symlink and is not scanned: ${root.path}`
          : `Import root is a broken symlink and is not scanned: ${root.path}`,
        root.path,
      ),
    );
    return null;
  }
  if (!stat.isDirectory() && root.kind !== "mcp") {
    issues.push(issue("unsupported", `Import root is not a directory: ${root.path}`, root.path));
    return null;
  }
  if (root.kind === "mcp" && !stat.isFile()) {
    issues.push(issue("unsupported", `MCP source is not a file: ${root.path}`, root.path));
    return null;
  }
  const realPath = await fs.realpath(root.path).catch(() => root.path);
  if (!isWithin(baseRealPath, realPath, false)) {
    issues.push(
      issue("path-traversal", `Source root escapes its configured base: ${root.path}`, root.path),
    );
    return null;
  }
  return { path: root.path, realPath };
}

async function safeEntry(
  entryPath: string,
  sourceRoot: string,
  issues: MossResourceImportIssue[],
): Promise<import("node:fs").Stats | null> {
  const result = await lstatResult(entryPath);
  const stat = result.stat;
  if (!stat) {
    if (isPermissionError(result.error)) {
      issues.push(
        issue(
          "unreadable",
          `Permission is required to read this import entry: ${entryPath}`,
          entryPath,
          [],
          "error",
        ),
      );
    }
    return null;
  }
  if (!stat.isSymbolicLink()) return stat;
  const target = await fs.realpath(entryPath).catch(() => null);
  if (!target || !isWithin(sourceRoot, target, false)) {
    issues.push(
      issue("symlink-escape", `Skipped symlink outside the import root: ${entryPath}`, entryPath),
    );
  } else {
    issues.push(issue("symlink", `Skipped symlinked source entry: ${entryPath}`, entryPath));
  }
  return null;
}

async function readDirectoryEntries(
  directoryPath: string,
  issues?: MossResourceImportIssue[],
  maxEntries = MAX_TREE_ENTRIES,
): Promise<import("node:fs").Dirent[]> {
  let directory: import("node:fs").Dir | undefined;
  try {
    directory = await fs.opendir(directoryPath);
    const entries: import("node:fs").Dirent[] = [];
    for await (const entry of directory) {
      if (entries.length >= maxEntries) {
        const error = new MossResourceImportError(
          "limit-exceeded",
          "Import directory exceeds the entry limit.",
        );
        if (issues) {
          issues.push(
            issue("limit-exceeded", "Import directory exceeds the entry limit.", directoryPath),
          );
          return entries;
        }
        throw error;
      }
      entries.push(entry);
    }
    return entries;
  } catch (error) {
    if (error instanceof MossResourceImportError) throw error;
    if (isPermissionError(error)) {
      issues?.push(
        issue(
          "unreadable",
          `Permission is required to read this import directory: ${directoryPath}`,
          directoryPath,
          [],
          "error",
        ),
      );
    }
    return [];
  } finally {
    if (directory) {
      try {
        await directory.close();
      } catch {
        // Directory iteration is already complete; close failure must not
        // masquerade as a state-budget or catalog read failure.
      }
    }
  }
}

function obviousSecret(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function safeSecretReference(value: string): boolean {
  return /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value.trim());
}

function unsafeRecordKey(key: string): boolean {
  return key === "__proto__" || key === "prototype" || key === "constructor";
}

interface SanitizedValue {
  readonly value: unknown;
  readonly secretFields: readonly string[];
}

function sanitizeValue(value: unknown, fieldPath: string): SanitizedValue {
  if (Array.isArray(value)) {
    const secretFields: string[] = [];
    const values = value.flatMap((entry, index) => {
      const sanitized = sanitizeValue(entry, `${fieldPath}[${index}]`);
      secretFields.push(...sanitized.secretFields);
      return sanitized.value === undefined ? [] : [sanitized.value];
    });
    return { value: values, secretFields };
  }
  if (value !== null && typeof value === "object") {
    const record = recordValue(value);
    if (!record) {
      return { value: undefined, secretFields: [fieldPath || "value"] };
    }
    const secretFields: string[] = [];
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const childPath = fieldPath ? `${fieldPath}.${key}` : key;
      if (unsafeRecordKey(key)) {
        secretFields.push(childPath);
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor || !("value" in descriptor)) {
        secretFields.push(childPath);
        continue;
      }
      const entry = descriptor.value;
      if (
        SECRET_KEY_PATTERN.test(key) &&
        !(typeof entry === "string" && safeSecretReference(entry))
      ) {
        secretFields.push(childPath);
        continue;
      }
      const sanitized = sanitizeValue(entry, childPath);
      secretFields.push(...sanitized.secretFields);
      if (sanitized.value !== undefined) output[key] = sanitized.value;
    }
    return { value: output, secretFields };
  }
  if (typeof value === "string" && obviousSecret(value) && !safeSecretReference(value)) {
    return { value: undefined, secretFields: [fieldPath || "value"] };
  }
  return { value, secretFields: [] };
}

function textSecretFields(value: string): string[] {
  return obviousSecret(value) ? ["content"] : [];
}

function parseFrontmatter(raw: string): {
  readonly name?: string;
  readonly version?: string;
  readonly description?: string;
} {
  const fields = parseScalarFrontmatter(raw);
  const name = readStringField(fields, ["name"]);
  const version = readStringField(fields, ["version"]);
  const description = readStringField(fields, ["description"]);
  return {
    ...(name ? { name } : {}),
    ...(version ? { version } : {}),
    ...(description ? { description } : {}),
  };
}

function resourceId(input: {
  readonly kind: MossResourceImportKind;
  readonly provider: ImportProvider;
  readonly scope: ImportScope;
  readonly sourcePath: string;
  readonly sourceSelector?: string;
}): string {
  return `resource-${sha256(
    stableJson({
      kind: input.kind,
      provider: input.provider,
      scope: input.scope,
      sourcePath: nodePath.resolve(input.sourcePath),
      sourceSelector: input.sourceSelector ?? null,
    }),
  ).slice(0, 32)}`;
}

async function materializeLocalSourceResource(
  input: MossResourceImportLocalSource,
  cwd: string,
  options: ReturnType<typeof importOptions>,
): Promise<MossResourceImportResource> {
  const sourceName = nodePath.basename(input.sourceName);
  if (sourceName !== input.sourceName || sourceName.includes("\0")) {
    throw new MossResourceImportError(
      "path-traversal",
      "The uploaded resource source name is not a safe basename.",
    );
  }
  const bytes = new TextEncoder().encode(input.contents);
  const sourceKey = sha256(
    stableJson({
      kind: input.kind,
      sourceName,
      contentsSha256: sha256(bytes),
      sourceSelector: input.sourceSelector ?? null,
    }),
  ).slice(0, 32);
  await ensurePrivateStateRoot(cwd, options.stateDir);
  if (!options.ownershipStore.writePrivateStage) {
    throw new MossResourceImportError(
      "durability-unsupported",
      "The configured ownership store cannot stage a browser source durably.",
    );
  }
  const workspaceId = options.workspaceId ?? workspaceBindingId(cwd);
  const projectId = options.projectId ?? workspaceId;
  const transactionId = `local-source-${randomUUID()}`;
  const operationId = `local-source-${sourceKey}`;
  const canonicalRoot = nodePath.resolve(getMossSourceLayout(cwd).root);
  const stage = await options.ownershipStore.createPrivateStage({
    transactionId,
    operationId,
    kind: input.kind,
    canonicalRoot,
    ownerId: options.ownerId,
    projectId,
    workspaceId,
    principalId: options.principalId,
    sessionId: options.sessionId,
    fencingToken: `local-source-fence-${randomUUID()}`,
    generation: `local-source-generation-${randomUUID()}`,
    nonce: `local-source-nonce-${randomUUID()}`,
    createdAt: options.now().toISOString(),
    leaseExpiresAt: new Date(options.now().getTime() + options.planTtlMillis).toISOString(),
  });
  try {
    const payload: MossPrivateStagePayload =
      input.kind === "plugin"
        ? {
            kind: "directory",
            entries: [{ relativePath: "plugin.json", kind: "file", content: bytes }],
          }
        : { kind: "file", content: bytes };
    await options.ownershipStore.writePrivateStage({ stage, payload });
    const actualSourcePath = await nodePrivateMutationPayloadPath(stage);
    const publicSourcePath = `server-state://resource-import/local/${sourceKey}/${sourceName}`;
    let name: string;
    let description: string | undefined;
    let sourceSha256: string;
    let sourceSelector: string | undefined;
    let secretFields: string[] = [];
    let sizeBytes = bytes.byteLength;
    if (input.kind === "plugin") {
      if (!/\.json$/iu.test(sourceName)) {
        throw new MossResourceImportError(
          "unsupported",
          "A local plugin source must be a JSON manifest.",
        );
      }
      const manifestInfo = await readManifest(actualSourcePath, options.maxFileBytes);
      if (!manifestInfo) {
        throw new MossResourceImportError(
          "invalid-json",
          "The local plugin source does not contain a valid plugin manifest.",
        );
      }
      const inspection = await inspectTree(
        actualSourcePath,
        actualSourcePath,
        {
          maxFileBytes: options.maxFileBytes,
          maxTreeBytes: options.maxTreeBytes,
          maxTreeDepth: options.maxTreeDepth,
          maxTreeEntries: options.maxTreeEntries,
          maxDirectories: options.maxDirectories,
          maxSymlinks: options.maxSymlinks,
        },
        [],
      );
      if (!inspection.safe) {
        throw new MossResourceImportError(
          "unsupported",
          "The local plugin source failed bounded tree validation.",
        );
      }
      name = stringValue(manifestInfo.manifest.name) ?? withoutExtension(sourceName);
      description = stringValue(manifestInfo.manifest.description);
      sourceSha256 = inspection.sourceSha256;
      sourceSelector = manifestInfo.relativePath;
      secretFields = [...inspection.secretFields];
      sizeBytes = inspection.sizeBytes;
    } else if (input.kind === "skill") {
      if (!/\.(?:markdown?|md)$/iu.test(sourceName)) {
        throw new MossResourceImportError(
          "unsupported",
          "A local skill source must be a Markdown file.",
        );
      }
      const inspected = await inspectFile(actualSourcePath, options.maxFileBytes);
      if (!inspected) {
        throw new MossResourceImportError(
          "unreadable",
          "The local skill source could not be read.",
        );
      }
      const frontmatter = parseFrontmatter(inspected.raw);
      name = frontmatter.name ?? withoutExtension(sourceName);
      description = frontmatter.description;
      sourceSha256 = inspected.sourceSha256;
      secretFields = textSecretFields(inspected.raw);
      sizeBytes = inspected.sizeBytes;
    } else {
      const format = /\.toml$/iu.test(sourceName) ? "toml" : "json";
      if (!/\.(?:json|toml)$/iu.test(sourceName)) {
        throw new MossResourceImportError(
          "unsupported",
          "A local MCP source must be JSON or TOML.",
        );
      }
      const inspected = await inspectFile(actualSourcePath, options.maxFileBytes);
      if (!inspected) {
        throw new MossResourceImportError("unreadable", "The local MCP source could not be read.");
      }
      const parsed = parseMcp(inspected.raw, format);
      if (!parsed || !input.sourceSelector) {
        throw new MossResourceImportError(
          "invalid-identity",
          "A local MCP source must identify one server entry.",
        );
      }
      const sourceServer = mcpEntryForSelector(parsed.value, input.sourceSelector);
      const sourceNameFromSelector = normalizeMcpEntryName(
        input.sourceSelector.slice(input.sourceSelector.indexOf("::") + 2),
      );
      if (!sourceServer || !sourceNameFromSelector) {
        throw new MossResourceImportError(
          "invalid-identity",
          "The local MCP source selector is not present in the source.",
        );
      }
      const validation = validateMcpServer(
        sourceNameFromSelector,
        sourceServer,
        input.sourceSelector,
      );
      if (validation) {
        throw new MossResourceImportError(validation.code, validation.message);
      }
      const sanitized = sanitizeValue(sourceServer, input.sourceSelector);
      name = sourceNameFromSelector;
      sourceSelector = input.sourceSelector;
      sourceSha256 = inspected.sourceSha256;
      secretFields = [...sanitized.secretFields];
      sizeBytes = inspected.sizeBytes;
    }
    if (!name.trim() || name.length > MAX_IMPORT_NAME_LENGTH || name.includes("\0")) {
      throw new MossResourceImportError("invalid-identity", "The local resource name is invalid.");
    }
    const resource: MossResourceImportResource = {
      id: resourceId({
        kind: input.kind,
        provider: "agents",
        scope: "workspace",
        sourcePath: publicSourcePath,
        ...(sourceSelector ? { sourceSelector } : {}),
      }),
      kind: input.kind,
      provider: "agents",
      scope: "workspace",
      name,
      sourcePath: publicSourcePath,
      ...(sourceSelector ? { sourceSelector } : {}),
      sourceSha256,
      ...(description ? { description } : {}),
      sizeBytes,
      format:
        input.kind === "skill"
          ? "markdown"
          : input.kind === "plugin"
            ? "directory"
            : /\.toml$/iu.test(sourceName)
              ? "toml"
              : "json",
      secretFields,
      warnings: secretFields.length > 0 ? ["secret-fields"] : [],
      canonicalIdentityKey: canonicalIdentityKey({ kind: input.kind, name }),
      enabled: input.kind === "skill",
      quarantined: input.kind !== "skill",
    };
    LOCAL_SOURCE_PATHS.set(resource, actualSourcePath);
    return resource;
  } catch (cause) {
    try {
      await cleanupPrivateLocalSourceStage(options.stateDir, nodePrivateStagePath(stage));
    } catch {
      throw aggregateImportCleanupFailure(
        cause,
        "The local resource stage cleanup could not be confirmed.",
      );
    }
    throw safeImportPrimaryFailure(cause);
  }
}

async function cleanupPrivateLocalSourceStage(stateRoot: string, stagePath: string): Promise<void> {
  try {
    if (!(await lstatOrNull(stagePath))) return;
    await removePrivateStatePath(stateRoot, stagePath, { recursive: true });
  } catch {
    throw new MossResourceImportError(
      "durability-unsupported",
      "A local resource stage could not be cleaned up safely.",
    );
  }
}

function safeImportPrimaryFailure(cause: unknown): MossResourceImportError {
  return new MossResourceImportError(
    cause instanceof MossResourceImportError ? cause.code : "copy-failed",
    "The primary resource import operation failed before private cleanup could be confirmed.",
  );
}

function aggregateImportCleanupFailure(cause: unknown, message: string): AggregateError {
  return new AggregateError(
    [
      safeImportPrimaryFailure(cause),
      new MossResourceImportError("durability-unsupported", message),
    ],
    "The resource import failed and its private cleanup could not be confirmed.",
  );
}

async function cleanupLocalSourceResource(
  resource: MossResourceImportResource,
  options: ReturnType<typeof importOptions>,
): Promise<void> {
  const actualSourcePath = LOCAL_SOURCE_PATHS.get(resource);
  if (!actualSourcePath) return;
  await cleanupPrivateLocalSourceStage(options.stateDir, nodePath.dirname(actualSourcePath));
  LOCAL_SOURCE_PATHS.delete(resource);
}

async function cleanupImportMutationStages(
  changes: readonly ChangeRecord[],
  options: ReturnType<typeof importOptions>,
): Promise<void> {
  for (const change of changes) {
    if (change.stagingPath) {
      const stagePath = ["payload", "tree"].includes(nodePath.basename(change.stagingPath))
        ? nodePath.dirname(change.stagingPath)
        : change.stagingPath;
      await cleanupPrivateLocalSourceStage(options.stateDir, stagePath);
    }
  }
}

async function inspectFile(
  filePath: string,
  maxFileBytes: number,
): Promise<{
  readonly raw: string;
  readonly sourceSha256: string;
  readonly sizeBytes: number;
} | null> {
  let buffer: Uint8Array;
  try {
    buffer = await readStableFile(filePath, maxFileBytes);
  } catch (error) {
    if (error instanceof MossResourceImportError && error.code === "stale-source") throw error;
    if (
      error instanceof MossResourceImportError &&
      (error.code === "binary" || error.code === "limit-exceeded")
    ) {
      throw error;
    }
    return null;
  }
  let raw: string;
  try {
    raw = decodeText(buffer, filePath);
  } catch (error) {
    if (error instanceof MossResourceImportError && error.code === "stale-source") throw error;
    return null;
  }
  return {
    raw,
    sourceSha256: sha256(buffer),
    sizeBytes: buffer.byteLength,
  };
}

function sameFileIdentity(left: import("node:fs").Stats, right: import("node:fs").Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.mode === right.mode
  );
}

function decodeText(buffer: Uint8Array, filePath: string): string {
  try {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    if (raw.includes("\u0000")) {
      throw new MossResourceImportError("binary", `Binary content is not importable: ${filePath}`);
    }
    return raw;
  } catch (error) {
    if (error instanceof MossResourceImportError) throw error;
    throw new MossResourceImportError("binary", `Binary content is not importable: ${filePath}`);
  }
}

async function readStableFile(filePath: string, maxFileBytes: number): Promise<Uint8Array> {
  const noFollow =
    (fsConstants as typeof fsConstants & { readonly O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new MossResourceImportError("unsupported", `Source is not a regular file: ${filePath}`);
    }
    if (before.size > maxFileBytes) {
      throw new MossResourceImportError(
        "limit-exceeded",
        `Source exceeds the file limit: ${filePath}`,
      );
    }
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const remaining = maxFileBytes - totalBytes;
      const chunkSize = Math.min(64 * 1024, Math.max(1, remaining + 1));
      const chunk = new Uint8Array(chunkSize);
      const { bytesRead } = await handle.read(chunk, 0, chunkSize, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > maxFileBytes) {
        throw new MossResourceImportError(
          "limit-exceeded",
          `Source exceeds the file limit: ${filePath}`,
        );
      }
      chunks.push(chunk.subarray(0, bytesRead));
      if (bytesRead < chunkSize) break;
    }
    const after = await handle.stat();
    if (!sameFileIdentity(before, after)) {
      throw new MossResourceImportError(
        "stale-source",
        `Source changed while reading: ${filePath}`,
      );
    }
    if (totalBytes !== after.size || totalBytes > maxFileBytes) {
      throw new MossResourceImportError(
        "stale-source",
        `Source changed while reading: ${filePath}`,
      );
    }
    const buffer = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return buffer;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function inspectTree(
  sourcePath: string,
  sourceRoot: string,
  options: {
    readonly maxFileBytes: number;
    readonly maxTreeBytes: number;
    readonly maxTreeDepth: number;
    readonly maxTreeEntries: number;
    readonly maxDirectories?: number;
    readonly maxSymlinks?: number;
  },
  issues: MossResourceImportIssue[],
): Promise<TreeInspection> {
  const entries: string[] = [];
  const secretFields: string[] = [];
  let sizeBytes = 0;
  let fileCount = 0;
  let directoryCount = 0;
  let symlinkCount = 0;
  let attemptedEntries = 0;
  let safe = true;

  const walk = async (
    currentPath: string,
    relativePrefix: string,
    depth: number,
  ): Promise<void> => {
    attemptedEntries += 1;
    if (attemptedEntries > options.maxTreeEntries) {
      safe = false;
      issues.push(issue("limit-exceeded", "Source tree exceeds the entry limit.", sourcePath));
      return;
    }
    const rawStat = await lstatOrNull(currentPath);
    if (rawStat?.isSymbolicLink()) {
      symlinkCount += 1;
      if (symlinkCount > (options.maxSymlinks ?? DEFAULT_MAX_SYMLINKS)) {
        safe = false;
        issues.push(issue("limit-exceeded", "Source tree exceeds the symlink limit.", sourcePath));
        return;
      }
    } else if (rawStat?.isDirectory()) {
      directoryCount += 1;
      if (directoryCount > (options.maxDirectories ?? DEFAULT_MAX_DIRECTORIES)) {
        safe = false;
        issues.push(
          issue("limit-exceeded", "Source tree exceeds the directory limit.", sourcePath),
        );
        return;
      }
    } else if (rawStat?.isFile()) fileCount += 1;
    const stat = await safeEntry(currentPath, sourceRoot, issues);
    if (!stat) {
      safe = false;
      return;
    }
    if (stat.isDirectory()) {
      if (depth >= options.maxTreeDepth) {
        safe = false;
        issues.push(issue("limit-exceeded", `Source tree exceeds the depth limit: ${sourcePath}`));
        return;
      }
      const children = await readDirectoryEntries(currentPath, issues, options.maxTreeEntries);
      for (const child of children.toSorted((left, right) => left.name.localeCompare(right.name))) {
        await walk(
          nodePath.join(currentPath, child.name),
          nodePath.join(relativePrefix, child.name),
          depth + 1,
        );
      }
      return;
    }
    if (!stat.isFile()) {
      safe = false;
      issues.push(issue("unsupported", `Unsupported source entry: ${currentPath}`, currentPath));
      return;
    }
    if (stat.size > options.maxFileBytes || sizeBytes + stat.size > options.maxTreeBytes) {
      safe = false;
      issues.push(
        issue("limit-exceeded", "Source tree exceeds the import size limit.", currentPath),
      );
      return;
    }
    let rawBuffer: Uint8Array;
    let raw: string;
    try {
      rawBuffer = await readStableFile(currentPath, options.maxFileBytes);
      raw = decodeText(rawBuffer, currentPath);
    } catch (error) {
      safe = false;
      const code = error instanceof MossResourceImportError ? error.code : "unreadable";
      issues.push(issue(code, `Source entry is not safely readable: ${currentPath}`, currentPath));
      return;
    }
    if (sizeBytes + rawBuffer.byteLength > options.maxTreeBytes) {
      safe = false;
      issues.push(issue("limit-exceeded", `Source tree exceeds the byte limit: ${sourcePath}`));
      return;
    }
    sizeBytes += rawBuffer.byteLength;
    entries.push(`${relativePrefix}\0${sha256(rawBuffer)}`);
    const extension = nodePath.extname(currentPath).toLowerCase();
    if (extension === ".json" || extension === ".toml") {
      try {
        const parsed = extension === ".toml" ? parseToml(raw) : JSON.parse(raw);
        secretFields.push(...sanitizeValue(parsed, relativePrefix).secretFields);
      } catch {
        // A plugin may contain arbitrary JSON/TOML fixtures. Parsing errors are
        // handled only for the manifest/config that makes the resource visible.
      }
    } else {
      secretFields.push(...textSecretFields(raw).map((field) => `${relativePrefix}.${field}`));
    }
  };

  await walk(sourcePath, "", 0);
  return {
    sourceSha256: sha256(entries.toSorted().join("\n")),
    sizeBytes,
    fileCount,
    directoryCount,
    symlinkCount,
    attemptedEntries,
    secretFields: [...new Set(secretFields)].toSorted(),
    safe,
  };
}

async function readManifest(
  sourcePath: string,
  maxFileBytes: number,
): Promise<{
  readonly relativePath: string;
  readonly manifest: Record<string, unknown>;
} | null> {
  for (const relativePath of PLUGIN_MANIFESTS) {
    const manifestPath = nodePath.join(sourcePath, relativePath);
    const stat = await lstatOrNull(manifestPath);
    if (!stat || !stat.isFile()) continue;
    const inspected = await inspectFile(manifestPath, maxFileBytes).catch((error) => {
      if (error instanceof MossResourceImportError && error.code === "stale-source") throw error;
      return null;
    });
    if (!inspected) return null;
    try {
      const parsed = recordValue(JSON.parse(inspected.raw));
      if (parsed) return { relativePath, manifest: parsed };
    } catch {
      return null;
    }
  }
  return null;
}

async function addSkillResource(
  resources: MossResourceImportResource[],
  issues: MossResourceImportIssue[],
  input: {
    readonly root: ResolvedRoot;
    readonly sourceRoot: string;
    readonly sourcePath: string;
    readonly options: Pick<
      ReturnType<typeof importOptions>,
      "maxFileBytes" | "maxResources" | "maxSkills" | "maxPlugins" | "maxMcpServers"
    >;
  },
): Promise<void> {
  let inspected: Awaited<ReturnType<typeof inspectFile>>;
  try {
    inspected = await inspectFile(input.sourcePath, input.options.maxFileBytes);
  } catch (error) {
    const code = error instanceof MossResourceImportError ? error.code : "unreadable";
    issues.push(issue(code, "Skill file is not safely readable.", input.sourcePath, [], "error"));
    return;
  }
  if (!inspected) {
    issues.push(
      issue(
        "unsupported",
        `Skill file is missing or too large: ${input.sourcePath}`,
        input.sourcePath,
      ),
    );
    return;
  }
  const frontmatter = parseFrontmatter(inspected.raw);
  const name = frontmatter.name ?? nodePath.basename(nodePath.dirname(input.sourcePath));
  if (!name.trim()) {
    issues.push(
      issue("invalid-skill", `Skill has no usable name: ${input.sourcePath}`, input.sourcePath),
    );
    return;
  }
  if (name.length > MAX_IMPORT_NAME_LENGTH || name.includes("\u0000")) {
    issues.push(issue("limit-exceeded", "Skill name exceeds the import limit.", input.sourcePath));
    return;
  }
  const secretFields = textSecretFields(inspected.raw);
  if (secretFields.length > 0) {
    issues.push(
      issue(
        "secret-fields",
        `Skill content contains a secret-like value: ${input.sourcePath}`,
        input.sourcePath,
        secretFields,
      ),
    );
  }
  appendResource(
    resources,
    {
      id: resourceId({
        kind: "skill",
        provider: input.root.provider,
        scope: input.root.scope,
        sourcePath: input.sourcePath,
      }),
      kind: "skill",
      provider: input.root.provider,
      scope: input.root.scope,
      name,
      sourcePath: input.sourcePath,
      sourceSha256: inspected.sourceSha256,
      ...(frontmatter.version ? { sourceVersion: frontmatter.version } : {}),
      ...(frontmatter.description ? { description: frontmatter.description } : {}),
      sizeBytes: inspected.sizeBytes,
      format: "markdown",
      secretFields,
      warnings: secretFields.length > 0 ? ["secret-fields"] : [],
      canonicalIdentityKey: canonicalIdentityKey({ kind: "skill", name }),
      enabled: true,
      quarantined: false,
    },
    issues,
    input.options,
  );
}

async function scanSkillsRoot(
  root: ResolvedRoot,
  sourceRoot: string,
  options: Pick<
    ReturnType<typeof importOptions>,
    | "maxFileBytes"
    | "maxTreeEntries"
    | "maxResources"
    | "maxSkills"
    | "maxPlugins"
    | "maxMcpServers"
  >,
  resources: MossResourceImportResource[],
  issues: MossResourceImportIssue[],
): Promise<void> {
  const directSkill = nodePath.join(root.path, "SKILL.md");
  const directStat = await safeEntry(directSkill, sourceRoot, issues);
  if (directStat?.isFile()) {
    await addSkillResource(resources, issues, {
      root,
      sourceRoot,
      sourcePath: directSkill,
      options,
    });
  }
  const entries = await readDirectoryEntries(root.path, issues, options.maxTreeEntries);
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === "SKILL.md") continue;
    const entryPath = nodePath.join(root.path, entry.name);
    const stat = await safeEntry(entryPath, sourceRoot, issues);
    if (!stat?.isDirectory()) continue;
    const skillPath = nodePath.join(entryPath, "SKILL.md");
    const skillStat = await safeEntry(skillPath, sourceRoot, issues);
    if (skillStat?.isFile()) {
      await addSkillResource(resources, issues, {
        root,
        sourceRoot,
        sourcePath: skillPath,
        options,
      });
    }
  }
}

async function addPluginResource(
  root: ResolvedRoot,
  sourceRoot: string,
  sourcePath: string,
  options: {
    readonly maxFileBytes: number;
    readonly maxTreeBytes: number;
    readonly maxTreeDepth: number;
    readonly maxTreeEntries: number;
    readonly maxDirectories: number;
    readonly maxSymlinks: number;
    readonly maxResources: number;
    readonly maxSkills: number;
    readonly maxPlugins: number;
    readonly maxMcpServers: number;
  },
  resources: MossResourceImportResource[],
  issues: MossResourceImportIssue[],
): Promise<void> {
  const manifestInfo = await readManifest(sourcePath, options.maxFileBytes);
  if (!manifestInfo) return;
  const inspection = await inspectTree(sourcePath, sourceRoot, options, issues);
  if (!inspection.safe) return;
  const secretFields = inspection.secretFields;
  if (secretFields.length > 0) {
    issues.push(
      issue(
        "secret-fields",
        `Plugin contains fields that will be redacted: ${sourcePath}`,
        sourcePath,
        secretFields,
      ),
    );
  }
  const manifest = manifestInfo.manifest;
  const name = stringValue(manifest.name) ?? nodePath.basename(sourcePath);
  if (name.length > MAX_IMPORT_NAME_LENGTH || name.includes("\u0000")) {
    issues.push(issue("limit-exceeded", "Plugin name exceeds the import limit.", sourcePath));
    return;
  }
  appendResource(
    resources,
    {
      id: resourceId({ kind: "plugin", provider: root.provider, scope: root.scope, sourcePath }),
      kind: "plugin",
      provider: root.provider,
      scope: root.scope,
      name,
      sourcePath,
      sourceSelector: manifestInfo.relativePath,
      sourceSha256: inspection.sourceSha256,
      ...(stringValue(manifest.version) ? { sourceVersion: stringValue(manifest.version) } : {}),
      ...(stringValue(manifest.description)
        ? { description: stringValue(manifest.description) }
        : {}),
      sizeBytes: inspection.sizeBytes,
      format: "directory",
      secretFields,
      warnings: secretFields.length > 0 ? ["secret-fields"] : [],
      canonicalIdentityKey: canonicalIdentityKey({ kind: "plugin", name }),
      enabled: false,
      quarantined: true,
    },
    issues,
    options,
  );
}

async function scanPluginsRoot(
  root: ResolvedRoot,
  sourceRoot: string,
  options: {
    readonly maxFileBytes: number;
    readonly maxTreeBytes: number;
    readonly maxTreeDepth: number;
    readonly maxTreeEntries: number;
    readonly maxDirectories: number;
    readonly maxSymlinks: number;
    readonly maxResources: number;
    readonly maxSkills: number;
    readonly maxPlugins: number;
    readonly maxMcpServers: number;
  },
  resources: MossResourceImportResource[],
  issues: MossResourceImportIssue[],
): Promise<void> {
  const directManifest = await readManifest(root.path, options.maxFileBytes);
  if (directManifest) {
    await addPluginResource(root, sourceRoot, root.path, options, resources, issues);
    return;
  }
  const entries = await readDirectoryEntries(root.path, issues, options.maxTreeEntries);
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = nodePath.join(root.path, entry.name);
    const stat = await safeEntry(entryPath, sourceRoot, issues);
    if (!stat?.isDirectory()) continue;
    await addPluginResource(root, sourceRoot, entryPath, options, resources, issues);
  }
}

function mcpTables(value: Record<string, unknown>): readonly [string, Record<string, unknown>][] {
  const candidates: [string, unknown][] = [
    ["mcpServers", ownRecordValue(value, "mcpServers")],
    ["mcp_servers", ownRecordValue(value, "mcp_servers")],
    ["servers", ownRecordValue(value, "servers")],
  ];
  const mcp = ownRecordValue(value, "mcp");
  if (mcp) {
    const nestedServers = ownRecordValue(mcp, "servers");
    candidates.push(nestedServers ? ["mcp.servers", nestedServers] : ["mcp", mcp]);
  }
  return candidates.flatMap(([key, candidate]) => {
    const record = recordValue(candidate);
    return record ? [[key, record] as [string, Record<string, unknown>]] : [];
  });
}

function mcpEntries(
  value: Record<string, unknown>,
  maxEntries = MAX_ALLOWED_TOTAL_RESOURCES,
  onInvalid?: (input: { readonly table: string; readonly name: string }) => void,
): McpEntry[] {
  const output: McpEntry[] = [];
  const seen = new Set<string>();
  for (const [table, servers] of mcpTables(value)) {
    for (const name of Object.keys(servers)) {
      if (output.length >= maxEntries) return output;
      const descriptor = Object.getOwnPropertyDescriptor(servers, name);
      if (!descriptor || !("value" in descriptor)) {
        onInvalid?.({ table, name });
        continue;
      }
      const normalizedName = normalizeMcpEntryName(name);
      if (!normalizedName) {
        onInvalid?.({ table, name });
        continue;
      }
      const server = recordValue(descriptor.value);
      if (!server || !isPlainRecordTree(server)) {
        onInvalid?.({ table, name });
        continue;
      }
      const key = normalizedName.toLocaleLowerCase("en-US");
      if (!key || seen.has(key)) {
        onInvalid?.({ table, name });
        continue;
      }
      seen.add(key);
      output.push({ table, name, canonicalName: key, value: server });
    }
  }
  return output;
}

function ownRecordValue(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? recordValue(descriptor.value) : undefined;
}

function normalizeMcpEntryName(name: string): string | null {
  const normalized = name.normalize("NFKC");
  if (
    normalized.trim().length === 0 ||
    normalized === "." ||
    normalized === ".." ||
    normalized.includes("/") ||
    normalized.includes("\\") ||
    /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/u.test(
      normalized,
    ) ||
    unsafeRecordKey(normalized.toLocaleLowerCase("en-US")) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function parseMcp(raw: string, format: "json" | "toml"): ParsedMcpConfig | null {
  try {
    const parsed = format === "toml" ? parseToml(raw) : JSON.parse(raw);
    const value = recordValue(parsed);
    return value ? { value, format } : null;
  } catch {
    return null;
  }
}

function mcpEntryForSelector(
  value: Record<string, unknown>,
  selector: string,
): Record<string, unknown> | null {
  const separator = selector.indexOf("::");
  if (separator < 1) return null;
  const table = selector.slice(0, separator);
  const name = normalizeMcpEntryName(selector.slice(separator + 2));
  if (!name) return null;
  return (
    mcpEntries(value).find(
      (entry) => entry.table === table && entry.canonicalName === name.toLocaleLowerCase("en-US"),
    )?.value ?? null
  );
}

interface McpValidationFailure {
  readonly code: Extract<
    MossResourceImportIssueCode,
    "secret-fields" | "mcp-invalid-transport" | "reserved-identity"
  >;
  readonly fieldPaths: readonly string[];
  readonly message: string;
}

function validateMcpTransportUrl(url: string, fieldPath: string): McpValidationFailure | null {
  try {
    const parsed = new URL(url);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      throw new Error("unsupported URL");
    }
  } catch {
    return {
      code: "mcp-invalid-transport",
      fieldPaths: [fieldPath],
      message: "MCP URL transport must be an http(s) URL without credentials, query, or fragment.",
    };
  }
  return null;
}

function validateMcpServer(
  name: string,
  value: Record<string, unknown>,
  fieldPrefix: string,
): McpValidationFailure | null {
  if (isReservedMcpIdentity(name)) {
    return {
      code: "reserved-identity",
      fieldPaths: [fieldPrefix],
      message: "The Moss control-plane identity cannot be imported.",
    };
  }
  const command = stringValue(value.command);
  const url = stringValue(value.url);
  if ((command ? 1 : 0) + (url ? 1 : 0) !== 1) {
    return {
      code: "mcp-invalid-transport",
      fieldPaths: [`${fieldPrefix}.command`, `${fieldPrefix}.url`],
      message: "MCP server must declare exactly one command or URL transport.",
    };
  }
  const transport = stringValue(value.transport ?? value.type);
  if (command && transport !== undefined && transport !== "stdio") {
    return {
      code: "mcp-invalid-transport",
      fieldPaths: [`${fieldPrefix}.transport`],
      message: "Command MCP servers must use the stdio transport.",
    };
  }
  if (url) {
    const urlValidation = validateMcpTransportUrl(url, `${fieldPrefix}.url`);
    if (urlValidation) return urlValidation;
    if (transport !== undefined && !["http", "sse", "streamable-http"].includes(transport)) {
      return {
        code: "mcp-invalid-transport",
        fieldPaths: [`${fieldPrefix}.transport`],
        message: "MCP URL transport type is not supported.",
      };
    }
  }
  if (command && (command.includes("\u0000") || obviousSecret(command))) {
    return {
      code: "secret-fields",
      fieldPaths: [`${fieldPrefix}.command`],
      message: "MCP command contains a secret-like or binary value.",
    };
  }
  if (Array.isArray(value.args)) {
    for (const [index, arg] of value.args.entries()) {
      if (typeof arg !== "string" || arg.includes("\u0000") || obviousSecret(arg)) {
        return {
          code: "secret-fields",
          fieldPaths: [`${fieldPrefix}.args[${index}]`],
          message: "MCP arguments must not contain literal secret-like values.",
        };
      }
    }
  } else if (value.args !== undefined) {
    return {
      code: "mcp-invalid-transport",
      fieldPaths: [`${fieldPrefix}.args`],
      message: "MCP args must be an array of strings.",
    };
  }
  for (const key of ["env", "headers"] as const) {
    const entries = value[key];
    if (entries === undefined) continue;
    const record = recordValue(entries);
    if (!record) {
      return {
        code: "mcp-invalid-transport",
        fieldPaths: [`${fieldPrefix}.${key}`],
        message: `MCP ${key} must be a string record of typed environment references.`,
      };
    }
    for (const [entryKey, entryValue] of Object.entries(record)) {
      if (typeof entryValue !== "string" || !safeSecretReference(entryValue)) {
        return {
          code: "secret-fields",
          fieldPaths: [`${fieldPrefix}.${key}.${entryKey}`],
          message: `MCP ${key} values must be typed environment references.`,
        };
      }
    }
  }
  return null;
}

async function scanMcpRoot(
  root: ResolvedRoot,
  options: Pick<
    ReturnType<typeof importOptions>,
    "maxFileBytes" | "maxMcpServers" | "maxResources" | "maxSkills" | "maxPlugins"
  >,
  resources: MossResourceImportResource[],
  issues: MossResourceImportIssue[],
): Promise<void> {
  let inspected: Awaited<ReturnType<typeof inspectFile>>;
  try {
    inspected = await inspectFile(root.path, options.maxFileBytes);
  } catch (error) {
    const code = error instanceof MossResourceImportError ? error.code : "unreadable";
    issues.push(issue(code, "MCP config is not safely readable.", root.path, [], "error"));
    return;
  }
  if (!inspected) {
    issues.push(
      issue("unsupported", `MCP config is missing or too large: ${root.path}`, root.path),
    );
    return;
  }
  const parsed = parseMcp(
    inspected.raw,
    root.format ?? (nodePath.extname(root.path).toLowerCase() === ".toml" ? "toml" : "json"),
  );
  if (!parsed) {
    issues.push(
      issue(
        root.format === "toml" ? "invalid-toml" : "invalid-json",
        `MCP config is not valid ${root.format ?? "JSON"}: ${root.path}`,
        root.path,
      ),
    );
    return;
  }
  const entries = mcpEntries(parsed.value, MAX_ALLOWED_TOTAL_RESOURCES, ({ table, name }) => {
    issues.push(
      issue(
        "invalid-identity",
        "MCP server name is not a safe, unique canonical identity.",
        root.path,
        [`${table}.${name}`],
        "error",
      ),
    );
  });
  for (const [entryIndex, entry] of entries.entries()) {
    if (entryIndex >= options.maxMcpServers) {
      issues.push(issue("limit-exceeded", "MCP server count exceeds the import limit.", root.path));
      break;
    }
    if (entry.name.length > MAX_IMPORT_NAME_LENGTH || entry.name.includes("\u0000")) {
      issues.push(issue("limit-exceeded", "MCP server name exceeds the import limit.", root.path));
      continue;
    }
    const selector = `${entry.table}::${entry.name}`;
    const secretFields = [
      ...sanitizeValue(entry.value, `${entry.table}.${entry.name}`).secretFields,
    ];
    const validation = validateMcpServer(entry.name, entry.value, `${entry.table}.${entry.name}`);
    if (validation) {
      secretFields.push(...validation.fieldPaths);
    }
    if (secretFields.length > 0) {
      issues.push(
        issue(
          validation?.code ?? "secret-fields",
          validation?.message ?? `MCP fields will be redacted: ${root.path}`,
          root.path,
          secretFields,
          "error",
        ),
      );
    }
    const version = stringValue(entry.value.version) ?? stringValue(parsed.value.version);
    appendResource(
      resources,
      {
        id: resourceId({
          kind: "mcp",
          provider: root.provider,
          scope: root.scope,
          sourcePath: root.path,
          sourceSelector: selector,
        }),
        kind: "mcp",
        provider: root.provider,
        scope: root.scope,
        name: entry.name,
        sourcePath: root.path,
        sourceSelector: selector,
        sourceSha256: inspected.sourceSha256,
        ...(version ? { sourceVersion: version } : {}),
        ...(stringValue(entry.value.description)
          ? { description: stringValue(entry.value.description) }
          : {}),
        sizeBytes: inspected.sizeBytes,
        format: parsed.format,
        secretFields,
        warnings: [
          ...(secretFields.length > 0 ? (["secret-fields"] as const) : []),
          ...(validation ? [validation.code] : []),
        ],
        canonicalIdentityKey: canonicalIdentityKey({ kind: "mcp", name: entry.name }),
        enabled: false,
        quarantined: true,
      },
      issues,
      options,
    );
  }
}

function warningCodes(secretFields: readonly string[]): MossResourceImportIssueCode[] {
  return secretFields.length > 0 ? ["secret-fields"] : [];
}

function appendResource(
  resources: MossResourceImportResource[],
  resource: MossResourceImportResource,
  issues: MossResourceImportIssue[],
  options: Pick<
    ReturnType<typeof importOptions>,
    "maxResources" | "maxSkills" | "maxPlugins" | "maxMcpServers"
  >,
): void {
  const kindLimit =
    resource.kind === "skill"
      ? options.maxSkills
      : resource.kind === "plugin"
        ? options.maxPlugins
        : options.maxMcpServers;
  const kindCount = resources.filter((candidate) => candidate.kind === resource.kind).length;
  if (resources.length >= options.maxResources || kindCount >= kindLimit) {
    issues.push(issue("limit-exceeded", "The resource inventory exceeds its hard total limit."));
    return;
  }
  resources.push(resource);
}

async function inventoryResolvedRoot(
  root: ResolvedRoot,
  basePath: string,
  options: ReturnType<typeof importOptions>,
  resources: MossResourceImportResource[],
  issues: MossResourceImportIssue[],
  permissionPaths: Set<string>,
): Promise<void> {
  const safe = await safeRoot(root, basePath, issues, permissionPaths);
  if (!safe) return;
  if (root.kind === "skills") {
    await scanSkillsRoot(root, safe.realPath, options, resources, issues);
  } else if (root.kind === "plugins") {
    await scanPluginsRoot(root, safe.realPath, options, resources, issues);
  } else {
    await scanMcpRoot(root, options, resources, issues);
  }
}

async function inventoryMossResourceImportInternal(
  input: MossResourceImportInventoryRequest,
  retainLocalStages: boolean,
): Promise<MossResourceImportInventoryResult> {
  const cwd = nodePath.resolve(input.cwd.trim());
  const options = importOptions(input);
  const roots = input.localSource ? [] : resolvedRoots(cwd, options, input.providers, input.kinds);
  const rootIssues: MossResourceImportIssue[] = [];
  const resources: MossResourceImportResource[] = [];
  const permissionPaths = new Set<string>();
  if (input.localSource) {
    resources.push(await materializeLocalSourceResource(input.localSource, cwd, options));
  }
  for (const root of roots) {
    const basePath = root.scope === "user" ? options.homeDir : cwd;
    await inventoryResolvedRoot(root, basePath, options, resources, rootIssues, permissionPaths);
  }
  const deduplicatedResources = [
    ...new Map(
      resources.map((resource) => [
        `${resource.kind}:${resource.provider}:${resource.scope}:${resource.sourcePath}:${resource.sourceSelector ?? ""}`,
        resource,
      ]),
    ).values(),
  ].toSorted((left, right) => left.id.localeCompare(right.id));
  let mcpCount = 0;
  let mcpLimitExceeded = false;
  const uniqueResources = deduplicatedResources.filter((resource) => {
    if (resource.kind !== "mcp") return true;
    mcpCount += 1;
    if (mcpCount <= options.maxMcpServers) return true;
    mcpLimitExceeded = true;
    return false;
  });
  if (mcpLimitExceeded) {
    rootIssues.push(issue("limit-exceeded", "MCP server count exceeds the import limit."));
  }
  const rootViews: MossResourceImportRoot[] = await Promise.all(
    roots.map(async (root) => {
      const result = await lstatResult(root.path);
      return {
        provider: root.provider,
        scope: root.scope,
        kind: root.kind,
        path: root.path,
        exists: result.stat !== null,
        permissionRequired: permissionPaths.has(root.path) || isPermissionError(result.error),
      };
    }),
  );
  const result = {
    inventoryId: `inventory-${randomUUID()}`,
    cwd,
    generatedAt: options.now().toISOString(),
    roots: rootViews,
    resources: uniqueResources,
    issues: rootIssues
      .toSorted((left, right) =>
        `${left.code}:${left.sourcePath ?? ""}`.localeCompare(
          `${right.code}:${right.sourcePath ?? ""}`,
        ),
      )
      .slice(0, 2_000),
  };
  if (!retainLocalStages) {
    for (const resource of resources) {
      await cleanupLocalSourceResource(resource, options);
    }
  }
  return result;
}

export async function inventoryMossResourceImport(
  input: MossResourceImportInventoryRequest,
): Promise<MossResourceImportInventoryResult> {
  return inventoryMossResourceImportInternal(input, false);
}

function canonicalTarget(
  resource: MossResourceImportResource,
  cwd: string,
): { readonly path: string; readonly kind: "file" | "directory" | "mcp" } {
  const layout = getMossSourceLayout(cwd);
  if (resource.kind === "mcp") return { path: layout.mcpConfig, kind: "mcp" };
  const slug = providerSanitizedIdentity(resource.name);
  if (!slug || slug.includes("..")) {
    throw new MossResourceImportError(
      "path-traversal",
      `Resource name cannot produce a safe target: ${resource.name}`,
    );
  }
  return resource.kind === "skill"
    ? { path: nodePath.join(layout.skillsRoot, slug, "SKILL.md"), kind: "file" }
    : { path: nodePath.join(layout.pluginsRoot, slug), kind: "directory" };
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | null> {
  const stat = await lstatOrNull(filePath);
  if (stat?.isSymbolicLink()) {
    throw new MossResourceImportError(
      "symlink-escape",
      `Refusing to read a canonical symlink: ${filePath}`,
    );
  }
  const rawBytes = await readStableFile(filePath, DEFAULT_MAX_FILE_BYTES).catch((error) => {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  });
  if (rawBytes === null) return null;
  try {
    return recordValue(JSON.parse(decodeText(rawBytes, filePath))) ?? {};
  } catch {
    throw new MossResourceImportError(
      "invalid-json",
      `Canonical import file is not valid JSON: ${filePath}`,
    );
  }
}

async function readProvenance(ownershipStore: MossOwnershipStore): Promise<ProvenanceManifest> {
  const record = await ownershipStore.readPrivateRecord({ fileName: PROVENANCE_FILE_NAME });
  if (record) {
    try {
      return Schema.decodeUnknownSync(MossResourceImportProvenanceManifestSchema)(record.value);
    } catch {
      throw new MossResourceImportError(
        "transaction-invalid",
        "Import provenance failed strict schema validation.",
      );
    }
  }
  return {
    schemaVersion: MOSS_RESOURCE_IMPORT_JOURNAL_SCHEMA_VERSION,
    records: [],
  } as ProvenanceManifest;
}

async function pathExists(filePath: string): Promise<boolean> {
  return (await lstatOrNull(filePath)) !== null;
}

interface HashLimits {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxMillis: number;
}

interface HashState {
  bytes: number;
  readonly startedAt: number;
}

const DEFAULT_HASH_LIMITS: HashLimits = {
  maxBytes: DEFAULT_MAX_HASH_BYTES,
  maxDepth: DEFAULT_MAX_HASH_DEPTH,
  maxMillis: DEFAULT_MAX_HASH_MILLIS,
};

function hashLimitsFor(
  options: Pick<MossResourceImportOptions, "maxHashBytes" | "maxHashDepth" | "maxHashMillis">,
): HashLimits {
  return {
    maxBytes: options.maxHashBytes ?? DEFAULT_MAX_HASH_BYTES,
    maxDepth: options.maxHashDepth ?? DEFAULT_MAX_HASH_DEPTH,
    maxMillis: options.maxHashMillis ?? DEFAULT_MAX_HASH_MILLIS,
  };
}

function assertHashWithinLimits(limits: HashLimits, state: HashState, depth: number): void {
  if (depth > limits.maxDepth || Date.now() - state.startedAt > limits.maxMillis) {
    throw new MossResourceImportError(
      "limit-exceeded",
      "Canonical hash operation exceeded its limits.",
    );
  }
  if (state.bytes > limits.maxBytes) {
    throw new MossResourceImportError(
      "limit-exceeded",
      "Canonical hash operation exceeded its byte limit.",
    );
  }
}

async function hashPath(
  filePath: string,
  limits: HashLimits = DEFAULT_HASH_LIMITS,
  state: HashState = { bytes: 0, startedAt: Date.now() },
  depth = 0,
): Promise<string> {
  assertHashWithinLimits(limits, state, depth);
  const stat = await lstatOrNull(filePath);
  if (!stat) return sha256("missing");
  if (stat.isSymbolicLink())
    throw new MossResourceImportError(
      "symlink-escape",
      `Refusing to hash a symlink target: ${filePath}`,
    );
  if (stat.isFile()) {
    if (state.bytes + stat.size > limits.maxBytes) {
      throw new MossResourceImportError(
        "limit-exceeded",
        "Canonical hash operation exceeded its byte limit.",
      );
    }
    const buffer = await readStableFile(filePath, Math.max(DEFAULT_MAX_FILE_BYTES, stat.size));
    state.bytes += buffer.byteLength;
    assertHashWithinLimits(limits, state, depth);
    return sha256(buffer);
  }
  if (stat.isDirectory()) {
    const entries = await readDirectoryEntries(filePath, undefined, MAX_TREE_ENTRIES);
    const parts: string[] = [];
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      assertHashWithinLimits(limits, state, depth + 1);
      parts.push(
        `${entry.name}\0${await hashPath(nodePath.join(filePath, entry.name), limits, state, depth + 1)}`,
      );
    }
    return sha256(parts.join("\n"));
  }
  return sha256("unsupported");
}

async function assertPrivateStateBudget(input: {
  readonly stateRoot: string;
  readonly maxBytes: number;
  readonly maxEntries: number;
}): Promise<void> {
  let entries = 0;
  let bytes = 0;
  const walk = async (currentPath: string): Promise<void> => {
    const stat = await lstatOrNull(currentPath);
    if (!stat) return;
    entries += 1;
    if (entries > input.maxEntries) {
      throw new MossResourceImportError(
        "limit-exceeded",
        "Resource import private state exceeds its aggregate entry budget.",
      );
    }
    if (stat.isSymbolicLink()) {
      throw new MossResourceImportError(
        "symlink-escape",
        "Resource import private state contains a symlink.",
      );
    }
    if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > input.maxBytes) {
        throw new MossResourceImportError(
          "limit-exceeded",
          "Resource import private state exceeds its aggregate byte budget.",
        );
      }
      return;
    }
    if (!stat.isDirectory()) return;
    const children = await readDirectoryEntries(
      currentPath,
      undefined,
      Math.max(1, input.maxEntries - entries + 1),
    );
    for (const child of children.toSorted((left, right) => left.name.localeCompare(right.name))) {
      await walk(nodePath.join(currentPath, child.name));
    }
  };
  await walk(input.stateRoot);
}

function privateManifestRecordHash(input: {
  readonly transactionId: string;
  readonly sequence: number;
  readonly previousHash: string;
  readonly value: unknown;
}): string {
  return sha256(stableJson({ schemaVersion: 3, ...input }));
}

function privateRecordTemplate(value: unknown): unknown {
  const record = recordValue(value);
  if (!record) return value;
  const {
    sequence: _sequence,
    previousHash: _previousHash,
    recordHash: _recordHash,
    ...template
  } = record;
  return template;
}

function privateRecordHashForTemplate(input: {
  readonly transactionId: string;
  readonly sequence: number;
  readonly previousHash: string;
  readonly value: unknown;
}): string {
  const record = recordValue(input.value);
  const value = record
    ? { ...record, sequence: input.sequence, previousHash: input.previousHash }
    : input.value;
  return privateManifestRecordHash({ ...input, value });
}

function assertPrivateManifestFileName(fileName: string): void {
  const normalized = nodePath.normalize(fileName);
  const segments = normalized.split(nodePath.sep);
  if (
    fileName.length === 0 ||
    normalized !== fileName ||
    nodePath.isAbsolute(fileName) ||
    fileName.includes("\u0000") ||
    !fileName.endsWith(".json") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new MossResourceImportError(
      "path-traversal",
      "Private ownership manifest name is not safe.",
    );
  }
}

const PRIVATE_OWNERSHIP_LOCK_FILE = ".lock";

function ownershipLockRecordMatches(
  value: unknown,
  expected: {
    readonly ownerId: string;
    readonly projectId: string;
    readonly workspaceId: string;
    readonly principalId: string;
    readonly sessionId: string;
    readonly nonce: string;
    readonly fencingToken: string;
    readonly generation: string;
  },
): boolean {
  const record = recordValue(value);
  return (
    record?.ownerId === expected.ownerId &&
    record.projectId === expected.projectId &&
    record.workspaceId === expected.workspaceId &&
    record.principalId === expected.principalId &&
    record.sessionId === expected.sessionId &&
    record.nonce === expected.nonce &&
    record.fencingToken === expected.fencingToken &&
    record.generation === expected.generation
  );
}

export function makeNodeMossOwnershipStore(stateRoot: string): MossOwnershipStore {
  const privateRoot = nodePath.resolve(stateRoot);
  const lockPath = nodePath.join(privateRoot, PRIVATE_OWNERSHIP_LOCK_FILE);
  const acquireLock = async (input: Parameters<MossOwnershipStore["acquireLock"]>[0]) => {
    await ensurePrivateStateRoot(input.cwd, privateRoot);
    const fencingToken = `fence-${randomUUID()}`;
    const generation = `generation-${randomUUID()}`;
    const lock = {
      cwd: nodePath.resolve(input.cwd),
      ownerId: input.ownerId,
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      principalId: input.principalId,
      sessionId: input.sessionId,
      nonce: input.nonce,
      fencingToken,
      generation,
    } as const;
    let handle: import("node:fs/promises").FileHandle | undefined;
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(lock)}\n`, "utf8");
      await handle.sync();
    } catch (cause) {
      await handle?.close().catch(() => undefined);
      if (isErrno(cause, "EEXIST")) {
        throw new MossResourceImportError(
          "concurrent-modification",
          "Canonical Moss ownership is already fenced by another authority.",
        );
      }
      await fs.rm(lockPath, { force: true }).catch(() => undefined);
      throw new MossResourceImportError(
        "durability-unsupported",
        "Canonical Moss ownership lock could not be durably created.",
      );
    }
    await handle.close();
    let released = false;
    return {
      ownerId: input.ownerId,
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      principalId: input.principalId,
      sessionId: input.sessionId,
      nonce: input.nonce,
      fencingToken,
      generation,
      release: async () => {
        if (released) return;
        released = true;
        const current = await lstatOrNull(lockPath);
        if (!current) return;
        if (current.isSymbolicLink() || !current.isFile()) {
          throw new MossResourceImportError(
            "symlink-escape",
            "Canonical Moss ownership lock is not a regular private file.",
          );
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(decodeText(await readStableFile(lockPath, 16 * 1024), lockPath));
        } catch {
          return;
        }
        if (!ownershipLockRecordMatches(parsed, lock)) return;
        await fs.rm(lockPath, { force: true });
        await syncDirectory(privateRoot);
      },
    };
  };
  const appendPrivateRecord = async (
    input: MossPrivateManifestInput,
  ): Promise<MossPrivateManifestReceipt> => {
    assertPrivateManifestFileName(input.fileName);
    await assertPrivateStateBudget({
      stateRoot: privateRoot,
      maxBytes: DEFAULT_MAX_STATE_BYTES,
      maxEntries: DEFAULT_MAX_STATE_ENTRIES,
    });
    const value = privateRecordTemplate(input.value);
    let sequence = 0;
    let previousHash = JOURNAL_GENESIS_HASH;
    let recordHash = "";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const latest = await readPrivateManifestFromNodeStore(privateRoot, input.fileName);
      if (
        latest !== null &&
        (latest.ownerId !== input.ownerId ||
          latest.projectId !== input.projectId ||
          latest.workspaceId !== input.workspaceId ||
          latest.principalId !== input.principalId ||
          latest.sessionId !== input.sessionId)
      ) {
        throw new MossResourceImportError(
          "authorization-required",
          "Private ownership manifest authority does not match.",
        );
      }
      sequence = latest === null ? 0 : latest.sequence + 1;
      previousHash = latest?.recordHash ?? JOURNAL_GENESIS_HASH;
      recordHash = privateRecordHashForTemplate({
        transactionId: input.transactionId,
        sequence,
        previousHash,
        value,
      });
      const path = await nextPrivateRecordPath(privateRoot, input.fileName);
      await ensurePrivateStatePath(privateRoot, path);
      const confirmed = await readPrivateManifestFromNodeStore(privateRoot, input.fileName);
      const head = latest ? `${latest.sequence}:${latest.recordHash}` : "genesis";
      const confirmedHead = confirmed ? `${confirmed.sequence}:${confirmed.recordHash}` : "genesis";
      if (head !== confirmedHead) {
        if (attempt === 2) {
          throw new MossResourceImportError(
            "concurrent-modification",
            "Private ownership manifest changed while allocating its next record.",
          );
        }
        continue;
      }
      try {
        await writeImmutableStateJsonFile(privateRoot, path, {
          schemaVersion: 3,
          transactionId: input.transactionId,
          sequence,
          previousHash,
          recordHash,
          ownerId: input.ownerId,
          projectId: input.projectId,
          workspaceId: input.workspaceId,
          principalId: input.principalId,
          sessionId: input.sessionId,
          stateFingerprint: input.stateFingerprint,
          nonce: input.nonce,
          value,
        });
        break;
      } catch (cause) {
        if (cause instanceof MossResourceImportError && cause.code === "conflict") {
          const raced = await readPrivateManifestFromNodeStore(privateRoot, input.fileName);
          if (raced?.transactionId === input.transactionId || attempt === 2) {
            throw new MossResourceImportError(
              "concurrent-modification",
              "Private ownership manifest append raced with another record from the same transaction.",
            );
          }
          continue;
        }
        throw cause;
      }
    }
    if (recordHash.length === 0) {
      throw new MossResourceImportError(
        "concurrent-modification",
        "Private ownership manifest append could not obtain a stable chain head.",
      );
    }
    return {
      locator: `server-state://resource-import/${input.fileName}`,
      transactionId: input.transactionId,
      sequence,
      previousHash,
      recordHash,
      ownerId: input.ownerId,
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      principalId: input.principalId,
      sessionId: input.sessionId,
      stateFingerprint: input.stateFingerprint,
      nonce: input.nonce,
      value,
    };
  };
  const readPrivateRecord = async (input: {
    readonly fileName: string;
  }): Promise<MossPrivateManifest | null> => {
    assertPrivateManifestFileName(input.fileName);
    return readPrivateManifestFromNodeStore(privateRoot, input.fileName);
  };
  const compactPrivateRecord = async (
    input: MossPrivateRecordCompactionInput,
  ): Promise<MossPrivateRecordCompactionReceipt> => {
    if (!input.lock) {
      throw new MossResourceImportError(
        "concurrent-modification",
        "Private ownership record compaction requires the active ownership lock.",
      );
    }
    const lockStat = await lstatOrNull(lockPath);
    if (!lockStat || lockStat.isSymbolicLink() || !lockStat.isFile()) {
      throw new MossResourceImportError(
        "concurrent-modification",
        "Private ownership compaction lost its active ownership lock.",
      );
    }
    let lockValue: unknown;
    try {
      lockValue = JSON.parse(decodeText(await readStableFile(lockPath, 16 * 1024), lockPath));
    } catch {
      throw new MossResourceImportError(
        "concurrent-modification",
        "Private ownership compaction lock is malformed.",
      );
    }
    if (!ownershipLockRecordMatches(lockValue, input.lock)) {
      throw new MossResourceImportError(
        "concurrent-modification",
        "Private ownership compaction lock was replaced.",
      );
    }
    if (
      input.lock.ownerId !== input.ownerId ||
      input.lock.projectId !== input.projectId ||
      input.lock.workspaceId !== input.workspaceId ||
      input.lock.principalId !== input.principalId ||
      input.lock.sessionId !== input.sessionId
    ) {
      throw new MossResourceImportError(
        "authorization-required",
        "Private ownership compaction lock authority does not match.",
      );
    }
    assertPrivateManifestFileName(input.fileName);
    const latest = await readPrivateManifestFromNodeStore(privateRoot, input.fileName);
    if (
      !latest ||
      latest.sequence !== input.expectedSequence ||
      latest.recordHash !== input.expectedRecordHash
    ) {
      throw new MossResourceImportError(
        "concurrent-modification",
        "Private ownership record changed before compaction.",
      );
    }
    if (
      latest.ownerId !== input.ownerId ||
      latest.projectId !== input.projectId ||
      latest.workspaceId !== input.workspaceId ||
      latest.principalId !== input.principalId ||
      latest.sessionId !== input.sessionId ||
      latest.stateFingerprint !== input.stateFingerprint ||
      latest.nonce !== input.nonce
    ) {
      throw new MossResourceImportError(
        "authorization-required",
        "Private ownership record authority does not match before compaction.",
      );
    }
    const directory = nodePath.join(privateRoot, nodePath.dirname(input.fileName));
    const directoryStat = await lstatOrNull(directory);
    if (!directoryStat || directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw new MossResourceImportError(
        "symlink-escape",
        "Private ownership record directory is unsafe during compaction.",
      );
    }
    await assertPrivateStatePath(privateRoot, directory);
    const baseName = nodePath.basename(input.fileName);
    const basePrefix = baseName.replace(/\.json$/u, "");
    const entries = await readDirectoryEntries(directory, undefined, 512);
    const candidates = entries.filter(
      (entry) =>
        entry.name === baseName ||
        (entry.name.startsWith(`${basePrefix}.`) &&
          /^\d+\.json$/u.test(entry.name.slice(basePrefix.length + 1))),
    );
    for (const entry of candidates) {
      if (!entry.isFile()) {
        throw new MossResourceImportError(
          "symlink-escape",
          "Private ownership record entry is not a regular file during compaction.",
        );
      }
      const path = nodePath.join(directory, entry.name);
      await assertPrivateStatePath(privateRoot, path);
    }
    throw new MossResourceImportError(
      "durability-unsupported",
      "Private ownership record compaction is GC-deferred because Node cannot perform descriptor-relative no-follow mutations safely.",
    );
  };
  return {
    acquireLock,
    assertStateBudget: (input) => assertPrivateStateBudget({ ...input, stateRoot: privateRoot }),
    createPrivateStage: async (input) => {
      assertServerCanonicalRoot(input.canonicalRoot);
      const operationToken = sha256(input.operationId).slice(0, 32);
      const stagePath = nodePath.join(
        privateRoot,
        "stage",
        input.transactionId,
        `${operationToken}.stage`,
      );
      await ensurePrivateStatePath(privateRoot, stagePath);
      const existing = await lstatOrNull(stagePath);
      if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) {
        throw new MossResourceImportError("symlink-escape", "Private snapshot stage is unsafe.");
      }
      if (!existing) {
        await fs.mkdir(stagePath, { mode: 0o700 });
      }
      const stage = {
        ...input,
        id: `${input.transactionId}:${input.operationId}`,
      };
      const metadataPath = nodePath.join(stagePath, "stage.json");
      const metadata = await lstatOrNull(metadataPath);
      if (metadata) {
        if (metadata.isSymbolicLink() || !metadata.isFile()) {
          throw snapshotInvalid("Private snapshot stage metadata is unsafe.");
        }
        let parsed: Record<string, unknown> | undefined;
        try {
          parsed = recordValue(
            JSON.parse(decodeText(await readStableFile(metadataPath, 32 * 1024), metadataPath)),
          );
        } catch {
          throw snapshotInvalid("Private snapshot stage metadata is invalid.");
        }
        if (
          !parsed ||
          typeof parsed.canonicalRoot !== "string" ||
          !isServerCanonicalRoot(parsed.canonicalRoot) ||
          parsed.canonicalRoot !== input.canonicalRoot
        ) {
          throw snapshotInvalid("Private snapshot stage canonical root does not match.");
        }
        if (
          parsed.transactionId !== input.transactionId ||
          parsed.operationId !== input.operationId ||
          parsed.kind !== input.kind ||
          parsed.ownerId !== input.ownerId ||
          parsed.projectId !== input.projectId ||
          parsed.workspaceId !== input.workspaceId ||
          parsed.principalId !== input.principalId ||
          parsed.sessionId !== input.sessionId ||
          parsed.fencingToken !== input.fencingToken ||
          parsed.generation !== input.generation ||
          parsed.nonce !== input.nonce ||
          parsed.createdAt !== input.createdAt ||
          parsed.leaseExpiresAt !== input.leaseExpiresAt
        ) {
          throw new MossResourceImportError(
            "concurrent-modification",
            "Private snapshot stage authority does not match.",
          );
        }
      } else if (existing) {
        throw snapshotInvalid("Private snapshot stage metadata is missing.");
      } else {
        await writeFileNoReplaceAtomic(
          metadataPath,
          `${JSON.stringify(stage, null, 2)}\n`,
          undefined,
          privateStateParentGuard(privateRoot, metadataPath),
        );
      }
      return {
        ...stage,
        opaque: { path: stagePath },
      };
    },
    readPrivateStage: async ({ stage }) => readNodePrivateStagePayload(privateRoot, stage),
    writePrivateStage: async ({ stage, payload }) =>
      writeNodePrivateStagePayload(privateRoot, stage, payload),
    appendPrivateManifest: appendPrivateRecord,
    readPrivateManifest: readPrivateRecord,
    appendPrivateRecord,
    readPrivateRecord,
    compactPrivateRecord,
    listPrivateRecords: async ({ prefix }) => {
      const normalizedPrefix = prefix.replace(/\/+$/u, "");
      if (
        normalizedPrefix.length === 0 ||
        normalizedPrefix.includes("\u0000") ||
        nodePath.isAbsolute(normalizedPrefix) ||
        normalizedPrefix.split("/").some((segment) => segment === ".." || segment === ".")
      ) {
        throw new MossResourceImportError("path-traversal", "Private record prefix is unsafe.");
      }
      const directory = nodePath.join(privateRoot, normalizedPrefix);
      const directoryStat = await lstatOrNull(directory);
      if (!directoryStat) return [];
      if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
        throw new MossResourceImportError("symlink-escape", "Private record directory is unsafe.");
      }
      await assertPrivateStatePath(privateRoot, directory);
      const entries = await readDirectoryEntries(directory, undefined, 512);
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => `${normalizedPrefix}/${entry.name}`);
    },
    publishPrivateSnapshot: async (input) => publishPrivateSnapshotInNodeStore(privateRoot, input),
    recoverPrivateStages: async (input) => recoverPrivateStagesInNodeStore(privateRoot, input),
  };
}

async function nextPrivateRecordPath(privateRoot: string, fileName: string): Promise<string> {
  const directory = nodePath.join(privateRoot, nodePath.dirname(fileName));
  await ensurePrivateStatePath(privateRoot, nodePath.join(directory, "placeholder.json"));
  const baseName = nodePath.basename(fileName);
  const entries = await readDirectoryEntries(directory, undefined, 512);
  if (!entries.some((entry) => entry.isFile() && entry.name === baseName)) {
    return nodePath.join(directory, baseName);
  }
  const prefix = baseName.replace(/\.json$/u, "");
  const sequence = entries.reduce((max, entry) => {
    const prefixWithDot = `${prefix}.`;
    if (!entry.name.startsWith(prefixWithDot) || !entry.name.endsWith(".json")) return max;
    const value = Number(entry.name.slice(prefixWithDot.length, -".json".length));
    return Number.isInteger(value) && value >= 0 ? Math.max(max, value) : max;
  }, 0);
  return nodePath.join(directory, `${prefix}.${sequence + 1}.json`);
}

async function readPrivateManifestFromNodeStore(
  privateRoot: string,
  fileName: string,
): Promise<MossPrivateManifest | null> {
  assertPrivateManifestFileName(fileName);
  const directory = nodePath.join(privateRoot, nodePath.dirname(fileName));
  const directoryStat = await lstatOrNull(directory);
  if (!directoryStat) return null;
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new MossResourceImportError(
      "symlink-escape",
      "Private ownership record directory is not a regular directory.",
    );
  }
  const entries = await readDirectoryEntries(directory, undefined, 512);
  const baseName = nodePath.basename(fileName);
  const candidates = entries
    .filter(
      (entry) =>
        entry.name === baseName ||
        new RegExp(`^${baseName.replace(/\.json$/u, "")}\.\\d+\\.json$`).test(entry.name),
    )
    .toSorted((left, right) => {
      const sequence = (name: string) =>
        name === baseName ? 0 : Number(name.match(/\.(\d+)\.json$/)?.[1] ?? -1);
      return sequence(left.name) - sequence(right.name);
    });
  let expectedSequence = 0;
  let previousHash = JOURNAL_GENESIS_HASH;
  let latest: MossPrivateManifest | null = null;
  let chainAuthority:
    | Pick<
        MossPrivateManifest,
        "ownerId" | "projectId" | "workspaceId" | "principalId" | "sessionId"
      >
    | undefined;
  for (const entry of candidates) {
    if (!entry.isFile()) {
      throw new MossResourceImportError(
        "symlink-escape",
        "Private ownership manifest entry is not a regular file.",
      );
    }
    const path = nodePath.join(directory, entry.name);
    await assertPrivateStatePath(privateRoot, path);
    const parsed = recordValue(
      JSON.parse(decodeText(await readStableFile(path, DEFAULT_MAX_FILE_BYTES), path)),
    );
    if (
      parsed?.schemaVersion !== 3 ||
      typeof parsed.transactionId !== "string" ||
      typeof parsed.sequence !== "number" ||
      typeof parsed.previousHash !== "string" ||
      typeof parsed.recordHash !== "string" ||
      typeof parsed.ownerId !== "string" ||
      typeof parsed.projectId !== "string" ||
      typeof parsed.workspaceId !== "string" ||
      typeof parsed.principalId !== "string" ||
      typeof parsed.sessionId !== "string" ||
      typeof parsed.stateFingerprint !== "string" ||
      typeof parsed.nonce !== "string" ||
      !Object.prototype.hasOwnProperty.call(parsed, "value")
    ) {
      throw new MossResourceImportError(
        "transaction-invalid",
        "Private ownership manifest failed strict validation.",
      );
    }
    if (
      parsed.sequence !== expectedSequence ||
      parsed.previousHash !== previousHash ||
      parsed.recordHash !==
        privateRecordHashForTemplate({
          transactionId: parsed.transactionId,
          sequence: parsed.sequence,
          previousHash: parsed.previousHash,
          value: parsed.value,
        })
    ) {
      throw new MossResourceImportError(
        "transaction-invalid",
        "Private ownership manifest hash chain is invalid.",
      );
    }
    const currentAuthority = {
      ownerId: parsed.ownerId,
      projectId: parsed.projectId,
      workspaceId: parsed.workspaceId,
      principalId: parsed.principalId,
      sessionId: parsed.sessionId,
    } as const;
    if (chainAuthority && stableJson(chainAuthority) !== stableJson(currentAuthority)) {
      throw new MossResourceImportError(
        "transaction-invalid",
        "Private ownership manifest authority changed within its hash chain.",
      );
    }
    chainAuthority ??= currentAuthority;
    latest = {
      locator: `server-state://resource-import/${fileName}`,
      transactionId: parsed.transactionId,
      sequence: parsed.sequence,
      previousHash: parsed.previousHash,
      recordHash: parsed.recordHash,
      ownerId: parsed.ownerId,
      projectId: parsed.projectId,
      workspaceId: parsed.workspaceId,
      principalId: parsed.principalId,
      sessionId: parsed.sessionId,
      stateFingerprint: parsed.stateFingerprint,
      nonce: parsed.nonce,
      value: parsed.value,
    };
    previousHash = parsed.recordHash;
    expectedSequence += 1;
  }
  return latest;
}

function privateSnapshotPaths(
  privateRoot: string,
  input: Pick<MossPrivateSnapshotPublishInput, "kind" | "snapshotKey">,
): { readonly base: string; readonly payload: string; readonly manifest: string } {
  const base = nodePath.join(privateRoot, "snapshots", `${input.kind}-${input.snapshotKey}`);
  return {
    base,
    payload: nodePath.join(base, input.kind === "plugin" ? "tree" : "payload"),
    manifest: nodePath.join(base, "manifest.json"),
  };
}

function privateSnapshotPathsForAuthority(
  privateRoot: string,
  authority: MossPrivateSnapshotAuthority,
): { readonly base: string; readonly payload: string; readonly manifest: string } {
  return privateSnapshotPaths(privateRoot, {
    kind: authority.kind,
    snapshotKey: snapshotKeyForAuthority(authority),
  });
}

function privateSnapshotPublishMarkerPathForAuthority(
  privateRoot: string,
  authority: MossPrivateSnapshotAuthority,
): string {
  return `${privateSnapshotPathsForAuthority(privateRoot, authority).base}.publish`;
}

async function privatePayloadBytes(filePath: string, maxBytes: number): Promise<number> {
  const stat = await lstatOrNull(filePath);
  if (!stat || stat.isSymbolicLink()) {
    throw new MossResourceImportError("symlink-escape", "Private snapshot payload is unsafe.");
  }
  if (stat.isFile()) {
    if (stat.size > maxBytes) {
      throw new MossResourceImportError(
        "limit-exceeded",
        "Private snapshot payload exceeds its byte budget.",
      );
    }
    return stat.size;
  }
  if (!stat.isDirectory()) {
    throw new MossResourceImportError(
      "transaction-invalid",
      "Private snapshot payload is invalid.",
    );
  }
  let total = 0;
  const entries = await readDirectoryEntries(filePath, undefined, MAX_TREE_ENTRIES);
  for (const entry of entries) {
    total += await privatePayloadBytes(nodePath.join(filePath, entry.name), maxBytes - total);
    if (total > maxBytes) {
      throw new MossResourceImportError(
        "limit-exceeded",
        "Private snapshot payload exceeds its byte budget.",
      );
    }
  }
  return total;
}

async function privatePayloadHash(filePath: string, kind: MossResourceImportKind): Promise<string> {
  if (kind !== "plugin") return hashPath(filePath);
  const entries: string[] = [];
  const walk = async (currentPath: string, relativePath: string): Promise<void> => {
    const stat = await lstatOrNull(currentPath);
    if (!stat || stat.isSymbolicLink()) {
      throw new MossResourceImportError("symlink-escape", "Private snapshot payload is unsafe.");
    }
    if (stat.isDirectory()) {
      const children = await readDirectoryEntries(currentPath, undefined, MAX_TREE_ENTRIES);
      for (const child of children.toSorted((left, right) => left.name.localeCompare(right.name))) {
        await walk(nodePath.join(currentPath, child.name), nodePath.join(relativePath, child.name));
      }
      return;
    }
    if (!stat.isFile()) {
      throw new MossResourceImportError(
        "transaction-invalid",
        "Private snapshot payload is invalid.",
      );
    }
    const bytes = await readStableFile(currentPath, DEFAULT_MAX_FILE_BYTES);
    entries.push(`${relativePath}\0${sha256(bytes)}`);
  };
  await walk(filePath, "");
  return sha256(entries.toSorted().join("\n"));
}

async function publishPrivateSnapshotInNodeStore(
  privateRoot: string,
  input: MossPrivateSnapshotPublishInput,
): Promise<MossPrivateSnapshotReceipt> {
  assertServerCanonicalRoot(input.authority.canonicalRoot);
  if (
    typeof input.stage.canonicalRoot !== "string" ||
    !isServerCanonicalRoot(input.stage.canonicalRoot) ||
    input.stage.canonicalRoot !== input.authority.canonicalRoot
  ) {
    throw snapshotInvalid("Private snapshot publish stage canonical root does not match.");
  }
  if (
    !/^[a-f0-9]{64}$/u.test(input.snapshotKey) ||
    input.snapshotKey !== snapshotKeyForAuthority(input.authority)
  ) {
    throw new MossResourceImportError(
      "transaction-invalid",
      "Private snapshot publish key is not authority scoped.",
    );
  }
  if (
    input.authority.stateRoot !== nodePath.resolve(privateRoot) ||
    input.authority.kind !== input.kind ||
    input.authority.snapshotSha256 !== input.snapshotSha256 ||
    input.stage.transactionId !== input.authority.transactionId ||
    input.stage.operationId !== input.authority.operationId ||
    input.stage.kind !== input.authority.kind ||
    input.stage.canonicalRoot !== input.authority.canonicalRoot ||
    input.stage.ownerId !== input.authority.ownerId ||
    input.stage.projectId !== input.authority.projectId ||
    input.stage.workspaceId !== input.authority.workspaceId ||
    input.stage.principalId !== input.authority.principalId ||
    input.stage.sessionId !== input.authority.sessionId ||
    input.stage.fencingToken !== input.authority.fencingToken ||
    input.stage.generation !== input.authority.generation ||
    input.stage.nonce !== input.authority.nonce
  ) {
    throw new MossResourceImportError(
      "snapshot-invalid",
      "Private snapshot publish authority does not match its stage.",
    );
  }
  const stagePath = nodePrivateStagePath(input.stage);
  await assertPrivateStatePath(privateRoot, stagePath);
  const stageStat = await lstatOrNull(stagePath);
  if (!stageStat || stageStat.isSymbolicLink() || !stageStat.isDirectory()) {
    throw new MossResourceImportError("symlink-escape", "Private snapshot stage is unsafe.");
  }
  const stagePayload = nodePath.join(stagePath, input.kind === "plugin" ? "tree" : "payload");
  const stageManifest = nodePath.join(stagePath, "manifest.json");
  await assertPrivateStatePath(privateRoot, stagePayload);
  await assertPrivateStatePath(privateRoot, stageManifest);
  const payloadStat = await lstatOrNull(stagePayload);
  const manifestStat = await lstatOrNull(stageManifest);
  if (
    !payloadStat ||
    payloadStat.isSymbolicLink() ||
    !manifestStat ||
    manifestStat.isSymbolicLink() ||
    !manifestStat.isFile()
  ) {
    throw new MossResourceImportError(
      "transaction-invalid",
      "Private snapshot stage is incomplete.",
    );
  }
  const stagedHash = await privatePayloadHash(stagePayload, input.kind);
  if (stagedHash !== input.snapshotSha256) {
    throw new MossResourceImportError(
      "stale-source",
      "Private snapshot stage hash does not match its content address.",
    );
  }
  const stagedManifest = recordValue(
    JSON.parse(decodeText(await readStableFile(stageManifest, 256 * 1024), stageManifest)),
  );
  const manifestHash = sha256(stableJson(input.manifest));
  if (
    !stagedManifest ||
    sha256(stableJson(stagedManifest)) !== manifestHash ||
    stagedManifest.snapshotSha256 !== input.snapshotSha256 ||
    stagedManifest.kind !== input.kind
  ) {
    throw new MossResourceImportError(
      "stale-source",
      "Private snapshot stage manifest does not match its content address.",
    );
  }
  const payloadBytes = await privatePayloadBytes(stagePayload, DEFAULT_MAX_TREE_BYTES);
  const revision = privateSnapshotRevision({
    kind: input.kind,
    snapshotSha256: input.snapshotSha256,
    manifestHash,
    payloadBytes,
  });
  const manifestIdentityFingerprint = await privatePayloadIdentityFingerprint(stageManifest);
  const payloadIdentityFingerprint = await privatePayloadIdentityFingerprint(stagePayload);
  const sealedPath = nodePath.join(stagePath, "sealed.json");
  await ensurePrivateStatePath(privateRoot, sealedPath);
  const seal = {
    schemaVersion: 1,
    kind: input.kind,
    snapshotSha256: input.snapshotSha256,
    canonicalRoot: input.authority.canonicalRoot,
    stateRoot: input.authority.stateRoot,
    manifestHash,
    manifestIdentityFingerprint,
    payloadIdentityFingerprint,
    payloadBytes,
    revision,
    transactionId: input.authority.transactionId,
    operationId: input.authority.operationId,
    ownerId: input.authority.ownerId,
    projectId: input.authority.projectId,
    workspaceId: input.authority.workspaceId,
    principalId: input.authority.principalId,
    sessionId: input.authority.sessionId,
    fencingToken: input.authority.fencingToken,
    generation: input.authority.generation,
    nonce: input.authority.nonce,
    createdAt: input.stage.createdAt,
    leaseExpiresAt: input.stage.leaseExpiresAt,
  };
  const existingSeal = await lstatOrNull(sealedPath);
  if (existingSeal) {
    let parsedSeal: Record<string, unknown> | undefined;
    try {
      parsedSeal = recordValue(
        JSON.parse(decodeText(await readStableFile(sealedPath, 64 * 1024), sealedPath)),
      );
    } catch {
      throw new MossResourceImportError(
        "concurrent-modification",
        "Private snapshot seal authority or revision is invalid.",
      );
    }
    if (stableJson(parsedSeal) !== stableJson(seal)) {
      throw new MossResourceImportError(
        "concurrent-modification",
        "Private snapshot seal authority or revision does not match.",
      );
    }
  } else {
    await writeFileNoReplaceAtomic(sealedPath, `${JSON.stringify(seal, null, 2)}\n`);
  }
  const publishedPath = nodePath.join(stagePath, PRIVATE_SNAPSHOT_PUBLISH_FILE);
  const publishMarker: PrivateSnapshotPublishMarker = {
    ...seal,
    schemaVersion: 1,
    marker: "committed",
    sealHash: sha256(stableJson(seal)),
  };
  const existingPublishMarker = await lstatOrNull(publishedPath);
  if (existingPublishMarker) {
    let parsedPublishMarker: Record<string, unknown> | undefined;
    try {
      parsedPublishMarker = recordValue(
        JSON.parse(decodeText(await readStableFile(publishedPath, 64 * 1024), publishedPath)),
      );
    } catch {
      throw new MossResourceImportError(
        "concurrent-modification",
        "Private snapshot publish marker is invalid.",
      );
    }
    if (stableJson(parsedPublishMarker) !== stableJson(publishMarker)) {
      throw new MossResourceImportError(
        "concurrent-modification",
        "Private snapshot publish marker does not match its seal.",
      );
    }
  } else {
    await writeFileNoReplaceAtomic(publishedPath, `${JSON.stringify(publishMarker, null, 2)}\n`);
  }
  await syncDirectory(stagePath);
  const finalPaths = privateSnapshotPathsForAuthority(privateRoot, input.authority);
  await ensurePrivateStatePath(privateRoot, finalPaths.base);
  const verifyPublishedSnapshot = async (): Promise<void> => {
    const published = await lstatOrNull(finalPaths.base);
    if (!published) {
      throw new MossResourceImportError(
        "concurrent-modification",
        "A private snapshot publish target disappeared during the publish race.",
      );
    }
    if (published.isSymbolicLink() || !published.isDirectory()) {
      throw new MossResourceImportError("symlink-escape", "Private snapshot target is unsafe.");
    }
    try {
      await assertSealedPrivateSnapshot(
        privateRoot,
        finalPaths.base,
        input.kind,
        input.snapshotSha256,
        input.authority,
      );
    } catch (cause) {
      if (
        cause instanceof MossResourceImportError &&
        (cause.code === "symlink-escape" || cause.code === "snapshot-invalid")
      ) {
        throw cause;
      }
      throw new MossResourceImportError(
        "concurrent-modification",
        "A content-addressed private snapshot already has a different sealed revision.",
      );
    }
  };
  const existing = await lstatOrNull(finalPaths.base);
  if (existing) {
    await verifyPublishedSnapshot();
    await removePrivateStatePath(privateRoot, stagePath, { recursive: true });
  } else {
    const publishMarker = privateSnapshotPublishMarkerPathForAuthority(
      privateRoot,
      input.authority,
    );
    const marker = await fs.open(publishMarker, "wx", 0o600).catch((cause) => {
      if (isErrno(cause, "EEXIST")) {
        throw new MossResourceImportError(
          "concurrent-modification",
          "A private snapshot publish is already in progress.",
        );
      }
      throw cause;
    });
    await marker.close();
    try {
      if (await lstatOrNull(finalPaths.base)) {
        await verifyPublishedSnapshot();
        await removePrivateStatePath(privateRoot, stagePath, { recursive: true });
      } else {
        try {
          await fs.rename(stagePath, finalPaths.base);
        } catch (cause) {
          if (!isErrno(cause, "EEXIST") && !isErrno(cause, "ENOTEMPTY")) throw cause;
          await verifyPublishedSnapshot();
          await removePrivateStatePath(privateRoot, stagePath, { recursive: true });
        }
        await syncDirectory(nodePath.dirname(finalPaths.base));
      }
    } finally {
      await fs.rm(publishMarker, { force: true }).catch(() => undefined);
    }
  }
  return {
    snapshotLocator: `server-state://resource-import/snapshots/${input.kind}-${input.snapshotKey}`,
    snapshotPath: finalPaths.payload,
    snapshotSha256: input.snapshotSha256,
    revision,
    payloadBytes,
    durable: true,
    sealed: true,
  };
}

async function recoverPrivateStagesInNodeStore(
  privateRoot: string,
  currentAuthority: MossPrivateStageRecoveryInput,
): Promise<void> {
  if (
    currentAuthority.stateRoot !== nodePath.resolve(privateRoot) ||
    !isServerCanonicalRoot(currentAuthority.canonicalRoot)
  ) {
    throw snapshotInvalid("Private stage recovery authority is invalid.");
  }
  const stageRoot = nodePath.join(privateRoot, "stage");
  const rootStat = await lstatOrNull(stageRoot);
  if (!rootStat) return;
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new MossResourceImportError("symlink-escape", "Private snapshot stage root is unsafe.");
  }
  const transactions = await readDirectoryEntries(stageRoot, undefined, 512);
  for (const transaction of transactions) {
    const transactionPath = nodePath.join(stageRoot, transaction.name);
    await assertPrivateStatePath(privateRoot, transactionPath);
    if (transaction.isSymbolicLink()) {
      throw new MossResourceImportError("symlink-escape", "Private snapshot stage is unsafe.");
    }
    if (!transaction.isDirectory()) continue;
    const stages = await readDirectoryEntries(transactionPath, undefined, 512);
    for (const stage of stages) {
      const stagePath = nodePath.join(transactionPath, stage.name);
      await assertPrivateStatePath(privateRoot, stagePath);
      if (stage.isSymbolicLink()) {
        throw new MossResourceImportError("symlink-escape", "Private snapshot stage is unsafe.");
      }
      if (!stage.isDirectory()) continue;
      const metadataPath = nodePath.join(stagePath, "stage.json");
      const metadataStat = await lstatOrNull(metadataPath);
      if (!metadataStat) {
        throw snapshotInvalid("Private snapshot stage metadata is missing.");
      }
      if (metadataStat.isSymbolicLink() || !metadataStat.isFile()) {
        throw snapshotInvalid("Private snapshot stage metadata is unsafe.");
      }
      let metadata: Record<string, unknown> | undefined;
      try {
        metadata = recordValue(
          JSON.parse(decodeText(await readStableFile(metadataPath, 64 * 1024), metadataPath)),
        );
      } catch {
        throw snapshotInvalid("Private snapshot stage metadata is invalid.");
      }
      if (!metadata) {
        throw new MossResourceImportError(
          "transaction-invalid",
          "Private snapshot stage lease metadata is invalid.",
        );
      }
      if (
        !isServerCanonicalRoot(metadata.canonicalRoot) ||
        metadata.canonicalRoot !== currentAuthority.canonicalRoot
      ) {
        throw snapshotInvalid("Private snapshot stage canonical root does not match recovery.");
      }
      if (
        typeof metadata.transactionId !== "string" ||
        typeof metadata.operationId !== "string" ||
        typeof metadata.kind !== "string" ||
        typeof metadata.ownerId !== "string" ||
        typeof metadata.projectId !== "string" ||
        typeof metadata.workspaceId !== "string" ||
        typeof metadata.principalId !== "string" ||
        typeof metadata.sessionId !== "string" ||
        typeof metadata.fencingToken !== "string" ||
        typeof metadata.generation !== "string" ||
        typeof metadata.nonce !== "string" ||
        typeof metadata.createdAt !== "string" ||
        typeof metadata.leaseExpiresAt !== "string"
      ) {
        throw new MossResourceImportError(
          "transaction-invalid",
          "Private snapshot stage lease metadata is invalid.",
        );
      }
      const createdAt = Date.parse(metadata.createdAt);
      const leaseExpiresAt = Date.parse(metadata.leaseExpiresAt);
      if (!Number.isFinite(createdAt) || !Number.isFinite(leaseExpiresAt)) {
        throw new MossResourceImportError(
          "transaction-invalid",
          "Private snapshot stage lease timestamps are invalid.",
        );
      }
      const now = Date.now();
      if (leaseExpiresAt > now || now - createdAt < PRIVATE_STAGE_ORPHAN_GRACE_MILLIS) {
        continue;
      }
      const sealedPath = nodePath.join(stagePath, "sealed.json");
      const sealedStat = await lstatOrNull(sealedPath);
      if (sealedStat?.isSymbolicLink()) {
        throw new MossResourceImportError("symlink-escape", "Private snapshot seal is unsafe.");
      }
      if (sealedStat && !sealedStat.isFile()) {
        throw new MossResourceImportError(
          "transaction-invalid",
          "Private snapshot seal is invalid.",
        );
      }
      if (sealedStat) {
        let sealValue: Record<string, unknown> | undefined;
        try {
          sealValue = recordValue(
            JSON.parse(decodeText(await readStableFile(sealedPath, 64 * 1024), sealedPath)),
          );
        } catch {
          throw snapshotInvalid("The sealed private stage is not valid JSON.");
        }
        if (!sealValue) {
          throw snapshotInvalid("The sealed private stage is not a plain record.");
        }
        const authority = privateSnapshotAuthorityFromSeal(sealValue);
        if (
          authority.stateRoot !== nodePath.resolve(privateRoot) ||
          !isServerCanonicalRoot(metadata.canonicalRoot) ||
          metadata.canonicalRoot !== authority.canonicalRoot ||
          authority.kind !== metadata.kind ||
          authority.transactionId !== metadata.transactionId ||
          authority.operationId !== metadata.operationId ||
          authority.ownerId !== metadata.ownerId ||
          authority.projectId !== metadata.projectId ||
          authority.workspaceId !== metadata.workspaceId ||
          authority.principalId !== metadata.principalId ||
          authority.sessionId !== metadata.sessionId ||
          authority.fencingToken !== metadata.fencingToken ||
          authority.generation !== metadata.generation ||
          authority.nonce !== metadata.nonce ||
          sealValue.createdAt !== metadata.createdAt ||
          sealValue.leaseExpiresAt !== metadata.leaseExpiresAt
        ) {
          throw snapshotInvalid(
            "The sealed private stage authority does not match its lease or state root.",
          );
        }
        await assertSealedPrivateSnapshot(
          privateRoot,
          stagePath,
          authority.kind,
          authority.snapshotSha256,
          authority,
        );
        const publishMarker = privateSnapshotPublishMarkerPathForAuthority(privateRoot, authority);
        await assertPrivateStatePath(privateRoot, publishMarker);
        const markerResult = await lstatResult(publishMarker);
        if (markerResult.error && !isErrno(markerResult.error, "ENOENT")) {
          throw snapshotInvalid("The private snapshot publish marker could not be verified.");
        }
        if (markerResult.stat) {
          if (markerResult.stat.isSymbolicLink() || !markerResult.stat.isFile()) {
            throw snapshotInvalid("The private snapshot publish marker is unsafe.");
          }
          let markerBytes: Uint8Array;
          try {
            markerBytes = await readStableFile(publishMarker, 1024);
          } catch {
            throw snapshotInvalid("The private snapshot publish marker could not be read.");
          }
          if (markerBytes.byteLength !== 0) {
            throw snapshotInvalid("The private snapshot publish marker is not canonical.");
          }
          continue;
        }
      }
      await removePrivateStatePath(privateRoot, stagePath, { recursive: true });
    }
  }
}

function nodePrivateStagePath(stage: MossPrivateStage): string {
  const opaque = recordValue(stage.opaque);
  const path = typeof opaque?.path === "string" ? opaque.path : null;
  if (!path) {
    throw new MossResourceImportError(
      "transaction-invalid",
      "The private ownership stage is not writable by this importer mode.",
    );
  }
  return path;
}

async function nodePrivateMutationPayloadPath(stage: MossPrivateStage): Promise<string> {
  const stagePath = nodePrivateStagePath(stage);
  const stageStat = await lstatOrNull(stagePath);
  if (!stageStat || !stageStat.isDirectory()) return stagePath;
  return nodePath.join(stagePath, stage.kind === "plugin" ? "tree" : "payload");
}

async function readNodePrivateStagePayload(
  privateRoot: string,
  stage: MossPrivateStage,
): Promise<MossPrivateStagePayload> {
  const stagePath = nodePrivateStagePath(stage);
  await assertPrivateStatePath(privateRoot, stagePath);
  const stageStat = await lstatOrNull(stagePath);
  if (!stageStat || stageStat.isSymbolicLink()) {
    throw new MossResourceImportError("symlink-escape", "Private mutation stage is unsafe.");
  }
  const payloadPath = stageStat.isDirectory()
    ? nodePath.join(stagePath, stage.kind === "plugin" ? "tree" : "payload")
    : stagePath;
  await assertPrivateStatePath(privateRoot, payloadPath);
  const payloadStat = await lstatOrNull(payloadPath);
  if (!payloadStat || payloadStat.isSymbolicLink()) {
    throw new MossResourceImportError(
      "durability-unsupported",
      "Private mutation stage is missing.",
    );
  }
  if (payloadStat.isFile()) {
    return { kind: "file", content: await readStableFile(payloadPath, DEFAULT_MAX_TREE_BYTES) };
  }
  if (!payloadStat.isDirectory()) {
    throw new MossResourceImportError(
      "transaction-invalid",
      "Private mutation stage payload is invalid.",
    );
  }
  const entries: Array<{
    readonly relativePath: string;
    readonly kind: "file" | "directory";
    readonly content?: Uint8Array;
  }> = [];
  let totalBytes = 0;
  const visit = async (currentPath: string, relativePath: string): Promise<void> => {
    if (entries.length >= MAX_TREE_ENTRIES) {
      throw new MossResourceImportError(
        "limit-exceeded",
        "Private mutation stage has too many entries.",
      );
    }
    const currentStat = await lstatOrNull(currentPath);
    if (!currentStat || currentStat.isSymbolicLink()) {
      throw new MossResourceImportError(
        "symlink-escape",
        "Private mutation stage contains a symlink.",
      );
    }
    if (currentStat.isDirectory()) {
      if (relativePath.length > 0) entries.push({ relativePath, kind: "directory" });
      const children = await readDirectoryEntries(currentPath, undefined, MAX_TREE_ENTRIES);
      for (const child of children.toSorted((left, right) => left.name.localeCompare(right.name))) {
        if (relativePath.length === 0 && child.name === "stage.json") continue;
        await visit(
          nodePath.join(currentPath, child.name),
          relativePath.length === 0 ? child.name : nodePath.join(relativePath, child.name),
        );
      }
      return;
    }
    if (!currentStat.isFile()) {
      throw new MossResourceImportError(
        "transaction-invalid",
        "Private mutation stage entry is invalid.",
      );
    }
    const content = await readStableFile(currentPath, DEFAULT_MAX_FILE_BYTES);
    totalBytes += content.byteLength;
    if (totalBytes > DEFAULT_MAX_TREE_BYTES) {
      throw new MossResourceImportError(
        "limit-exceeded",
        "Private mutation stage exceeds its byte limit.",
      );
    }
    entries.push({ relativePath, kind: "file", content });
  };
  await visit(payloadPath, "");
  return { kind: "directory", entries };
}

function assertPrivateStageRelativePath(relativePath: string): void {
  if (
    relativePath.length === 0 ||
    nodePath.isAbsolute(relativePath) ||
    relativePath.includes("\0") ||
    relativePath
      .split(/[\\/]+/u)
      .some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new MossResourceImportError("path-traversal", "Private mutation stage entry is unsafe.");
  }
}

async function writeNodePrivateStagePayload(
  privateRoot: string,
  stage: MossPrivateStage,
  payload: MossPrivateStagePayload,
): Promise<void> {
  const stagePath = nodePrivateStagePath(stage);
  await assertPrivateStatePath(privateRoot, stagePath);
  const stageStat = await lstatOrNull(stagePath);
  if (!stageStat || stageStat.isSymbolicLink() || !stageStat.isDirectory()) {
    throw new MossResourceImportError("symlink-escape", "Private mutation stage is unsafe.");
  }
  const payloadPath = await nodePrivateMutationPayloadPath(stage);
  await assertPrivateStatePath(privateRoot, payloadPath);
  if (payload.kind === "file") {
    await writeFileNoReplaceAtomic(
      payloadPath,
      decodeText(payload.content, payloadPath),
      undefined,
      privateStateParentGuard(privateRoot, payloadPath),
    );
    return;
  }
  const existing = await lstatOrNull(payloadPath);
  if (existing) {
    throw new MossResourceImportError(
      "concurrent-modification",
      "Private stage payload already exists.",
    );
  }
  await fs.mkdir(payloadPath, { mode: 0o700 });
  for (const entry of payload.entries.toSorted((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  )) {
    assertPrivateStageRelativePath(entry.relativePath);
    const entryPath = nodePath.join(payloadPath, entry.relativePath);
    await assertPrivateStatePath(privateRoot, entryPath);
    if (entry.kind === "directory") {
      await fs.mkdir(entryPath, { recursive: true, mode: 0o700 });
      continue;
    }
    if (!entry.content) {
      throw new MossResourceImportError(
        "durability-unsupported",
        "Private stage file content is missing.",
      );
    }
    await writeFileNoReplaceAtomic(
      entryPath,
      decodeText(entry.content, entryPath),
      undefined,
      privateStateParentGuard(privateRoot, entryPath),
    );
  }
  await syncDirectory(payloadPath);
}

async function targetConflict(
  resource: MossResourceImportResource,
  target: { readonly path: string; readonly kind: "file" | "directory" | "mcp" },
  provenance: ProvenanceManifest,
): Promise<"skip" | "conflict" | null> {
  const matching = provenance.records.some(
    (record) =>
      record.sourcePath === resource.sourcePath &&
      record.sourceSha256 === resource.sourceSha256 &&
      record.sourceVersion === resource.sourceVersion &&
      record.targetPath === target.path,
  );
  if (matching) return "skip";
  if (target.kind === "mcp") {
    const config = await readJsonObject(target.path);
    if (!config) return null;
    for (const entry of mcpEntries(config)) {
      if (
        entry.name === resource.name ||
        canonicalIdentityKey({ kind: "mcp", name: entry.name }) ===
          (resource.canonicalIdentityKey ??
            canonicalIdentityKey({ kind: resource.kind, name: resource.name }))
      ) {
        return "conflict";
      }
    }
    return null;
  }
  return (await pathExists(target.path)) ? "conflict" : null;
}

function planHash(plan: Omit<MossResourceImportPlan, "planHash">): string {
  return sha256(stableJson(plan));
}

function workspaceBindingId(cwd: string): string {
  return `workspace-${sha256(nodePath.resolve(cwd)).slice(0, 32)}`;
}

function selectionSnapshotHash(resources: readonly MossResourceImportResource[]): string {
  return sha256(
    stableJson(
      resources
        .map((resource) => ({
          id: resource.id,
          canonicalIdentityKey:
            resource.canonicalIdentityKey ??
            canonicalIdentityKey({ kind: resource.kind, name: resource.name }),
          sourcePath: nodePath.resolve(resource.sourcePath),
          sourceSelector: resource.sourceSelector ?? null,
          sourceSha256: resource.sourceSha256,
          snapshotPath: resource.snapshotPath ?? null,
          snapshotSha256: resource.snapshotSha256 ?? null,
          sourceVersion: resource.sourceVersion ?? null,
        }))
        .toSorted((left, right) => left.id.localeCompare(right.id)),
    ),
  );
}

function importStateFingerprint(
  cwd: string,
  workspaceId: string,
  snapshotHash: string,
  stateRoot: string,
): string {
  return sha256(
    stableJson({
      cwd: nodePath.resolve(cwd),
      workspaceId,
      snapshotHash,
      stateRoot: nodePath.resolve(stateRoot),
    }),
  );
}

function isExpired(isoDateTime: string, now: Date): boolean {
  const expiresAt = Date.parse(isoDateTime);
  return !Number.isFinite(expiresAt) || expiresAt <= now.getTime();
}

interface SnapshotManifestEntry {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

interface SnapshotManifest {
  readonly schemaVersion: 1;
  readonly kind: MossResourceImportKind;
  readonly snapshotSha256: string;
  readonly entries: readonly SnapshotManifestEntry[];
}

interface PrivateSnapshotSeal {
  readonly schemaVersion: 1;
  readonly kind: MossResourceImportKind;
  readonly snapshotSha256: string;
  readonly canonicalRoot: string;
  readonly stateRoot: string;
  readonly manifestHash: string;
  readonly manifestIdentityFingerprint: string;
  readonly payloadIdentityFingerprint: string;
  readonly payloadBytes: number;
  readonly revision: string;
  readonly transactionId: string;
  readonly operationId: string;
  readonly ownerId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly fencingToken: string;
  readonly generation: string;
  readonly nonce: string;
  readonly createdAt: string;
  readonly leaseExpiresAt: string;
}

function privateSnapshotAuthorityFromSeal(
  seal: Record<string, unknown>,
): MossPrivateSnapshotAuthority {
  if (seal.schemaVersion !== 1) {
    throw snapshotInvalid("The sealed private stage schema version is invalid.");
  }
  const kind = seal.kind;
  if (kind !== "skill" && kind !== "plugin" && kind !== "mcp") {
    throw snapshotInvalid("The sealed private stage kind is invalid.");
  }
  const stringField = (field: keyof MossPrivateSnapshotAuthority): string => {
    const value = seal[field];
    if (typeof value !== "string" || value.length === 0 || value.includes("\u0000")) {
      throw snapshotInvalid(`The sealed private stage authority field ${field} is invalid.`);
    }
    return value;
  };
  const canonicalRoot = stringField("canonicalRoot");
  const stateRoot = stringField("stateRoot");
  const snapshotSha256 = stringField("snapshotSha256");
  if (!isServerCanonicalRoot(canonicalRoot) || !isServerCanonicalRoot(stateRoot)) {
    throw snapshotInvalid("The sealed private stage roots are not absolute.");
  }
  if (!/^[a-f0-9]{64}$/u.test(snapshotSha256)) {
    throw snapshotInvalid("The sealed private stage snapshot hash is invalid.");
  }
  return {
    canonicalRoot,
    stateRoot,
    ownerId: stringField("ownerId"),
    projectId: stringField("projectId"),
    workspaceId: stringField("workspaceId"),
    principalId: stringField("principalId"),
    sessionId: stringField("sessionId"),
    transactionId: stringField("transactionId"),
    operationId: stringField("operationId"),
    fencingToken: stringField("fencingToken"),
    generation: stringField("generation"),
    nonce: stringField("nonce"),
    kind,
    snapshotSha256,
  };
}

interface PrivateSnapshotPublishMarker extends PrivateSnapshotSeal {
  readonly marker: "committed";
  readonly sealHash: string;
}

const PRIVATE_SNAPSHOT_SEAL_FILE = "sealed.json";
const PRIVATE_SNAPSHOT_PUBLISH_FILE = "published.json";

function privateSnapshotRevision(input: {
  readonly kind: MossResourceImportKind;
  readonly snapshotSha256: string;
  readonly manifestHash: string;
  readonly payloadBytes: number;
}): string {
  return sha256(
    stableJson({
      schemaVersion: 1,
      kind: input.kind,
      snapshotSha256: input.snapshotSha256,
      manifestHash: input.manifestHash,
      payloadBytes: input.payloadBytes,
    }),
  );
}

async function privatePayloadIdentityFingerprint(filePath: string): Promise<string> {
  const stat = await lstatOrNull(filePath);
  if (!stat || stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    throw new MossResourceImportError(
      "snapshot-invalid",
      "Private snapshot payload identity is invalid.",
    );
  }
  return sha256(
    stableJson({
      type: stat.isDirectory() ? "directory" : "file",
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode,
    }),
  );
}

function assertSnapshotAuthority(
  seal: PrivateSnapshotSeal,
  authority: MossPrivateSnapshotAuthority,
): void {
  const fields: readonly (keyof MossPrivateSnapshotAuthority)[] = [
    "canonicalRoot",
    "stateRoot",
    "ownerId",
    "projectId",
    "workspaceId",
    "principalId",
    "sessionId",
    "transactionId",
    "operationId",
    "fencingToken",
    "generation",
    "nonce",
    "kind",
    "snapshotSha256",
  ];
  for (const field of fields) {
    if (seal[field] !== authority[field]) {
      throw snapshotInvalid(`The server-owned snapshot authority field ${field} does not match.`);
    }
  }
}

function snapshotInvalid(message: string): MossResourceImportError {
  return new MossResourceImportError("snapshot-invalid", message);
}

function snapshotBasePath(
  stateRoot: string,
  resource: MossResourceImportResource,
  authority: MossPrivateSnapshotAuthority,
): string {
  return nodePath.join(
    stateRoot,
    "snapshots",
    `${resource.kind}-${snapshotKeyForAuthority(authority)}`,
  );
}

function snapshotPayloadPath(
  stateRoot: string,
  resource: MossResourceImportResource,
  authority: MossPrivateSnapshotAuthority,
): string {
  return nodePath.join(
    snapshotBasePath(stateRoot, resource, authority),
    resource.kind === "plugin" ? "tree" : "payload",
  );
}

async function readSnapshotManifest(path: string): Promise<SnapshotManifest | null> {
  const raw = await readStableFile(path, 256 * 1024).catch((error) => {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  });
  if (raw === null) return null;
  try {
    const parsed = recordValue(JSON.parse(decodeText(raw, path)));
    if (
      !parsed ||
      parsed.schemaVersion !== 1 ||
      typeof parsed.kind !== "string" ||
      typeof parsed.snapshotSha256 !== "string" ||
      !Array.isArray(parsed.entries)
    ) {
      throw new Error("invalid snapshot manifest");
    }
    return parsed as unknown as SnapshotManifest;
  } catch {
    throw new MossResourceImportError(
      "transaction-invalid",
      "Import snapshot failed strict validation.",
    );
  }
}

async function assertSealedPrivateSnapshot(
  stateRoot: string,
  basePath: string,
  kind: MossResourceImportKind,
  snapshotSha256: string,
  authority: MossPrivateSnapshotAuthority,
): Promise<SnapshotManifest> {
  await assertPrivateStatePath(stateRoot, basePath);
  const baseStat = await lstatOrNull(basePath);
  if (!baseStat || baseStat.isSymbolicLink() || !baseStat.isDirectory()) {
    throw snapshotInvalid("The server-owned snapshot directory is missing or unsafe.");
  }
  const payloadPath = nodePath.join(basePath, kind === "plugin" ? "tree" : "payload");
  const manifestPath = nodePath.join(basePath, "manifest.json");
  const sealPath = nodePath.join(basePath, PRIVATE_SNAPSHOT_SEAL_FILE);
  const publishPath = nodePath.join(basePath, PRIVATE_SNAPSHOT_PUBLISH_FILE);
  let manifest: SnapshotManifest | null;
  try {
    manifest = await readSnapshotManifest(manifestPath);
  } catch {
    throw snapshotInvalid("The server-owned snapshot manifest is invalid.");
  }
  if (!manifest || manifest.kind !== kind || manifest.snapshotSha256 !== snapshotSha256) {
    throw snapshotInvalid("The server-owned snapshot manifest is not sealed.");
  }
  const sealStat = await lstatOrNull(sealPath);
  const publishStat = await lstatOrNull(publishPath);
  if (
    !sealStat ||
    sealStat.isSymbolicLink() ||
    !sealStat.isFile() ||
    !publishStat ||
    publishStat.isSymbolicLink() ||
    !publishStat.isFile()
  ) {
    throw snapshotInvalid("The server-owned snapshot seal or publish marker is missing.");
  }
  let sealValue: Record<string, unknown> | undefined;
  let publishValue: Record<string, unknown> | undefined;
  try {
    sealValue = recordValue(
      JSON.parse(decodeText(await readStableFile(sealPath, 64 * 1024), sealPath)),
    );
    publishValue = recordValue(
      JSON.parse(decodeText(await readStableFile(publishPath, 64 * 1024), publishPath)),
    );
  } catch {
    throw snapshotInvalid("The server-owned snapshot seal is not valid JSON.");
  }
  if (!sealValue || !publishValue) {
    throw snapshotInvalid("The server-owned snapshot seal is not a plain record.");
  }
  const sealStringFields = [
    "snapshotSha256",
    "canonicalRoot",
    "stateRoot",
    "manifestHash",
    "manifestIdentityFingerprint",
    "payloadIdentityFingerprint",
    "revision",
    "transactionId",
    "operationId",
    "ownerId",
    "projectId",
    "workspaceId",
    "principalId",
    "sessionId",
    "fencingToken",
    "generation",
    "nonce",
    "createdAt",
    "leaseExpiresAt",
  ] as const;
  if (
    sealValue.schemaVersion !== 1 ||
    sealValue.kind !== kind ||
    sealStringFields.some((field) => typeof sealValue[field] !== "string") ||
    typeof sealValue.payloadBytes !== "number" ||
    !Number.isSafeInteger(sealValue.payloadBytes) ||
    sealValue.payloadBytes < 0
  ) {
    throw snapshotInvalid("The server-owned snapshot seal schema is invalid.");
  }
  const seal = sealValue as unknown as PrivateSnapshotSeal;
  assertSnapshotAuthority(seal, authority);
  const manifestHash = sha256(stableJson(manifest));
  let payloadHash: string;
  let payloadBytes: number;
  let payloadIdentityFingerprint: string;
  let manifestIdentityFingerprint: string;
  try {
    manifestIdentityFingerprint = await privatePayloadIdentityFingerprint(manifestPath);
    payloadHash = await privatePayloadHash(payloadPath, kind);
    payloadBytes = await privatePayloadBytes(payloadPath, DEFAULT_MAX_TREE_BYTES);
    payloadIdentityFingerprint = await privatePayloadIdentityFingerprint(payloadPath);
  } catch {
    throw snapshotInvalid("The server-owned snapshot payload is invalid.");
  }
  const revision = privateSnapshotRevision({
    kind,
    snapshotSha256,
    manifestHash,
    payloadBytes,
  });
  if (
    seal.snapshotSha256 !== snapshotSha256 ||
    seal.manifestHash !== manifestHash ||
    seal.manifestIdentityFingerprint !== manifestIdentityFingerprint ||
    seal.payloadIdentityFingerprint !== payloadIdentityFingerprint ||
    seal.payloadBytes !== payloadBytes ||
    seal.revision !== revision ||
    payloadHash !== snapshotSha256
  ) {
    throw snapshotInvalid("The server-owned snapshot seal does not match its payload.");
  }
  const expectedPublishMarker: PrivateSnapshotPublishMarker = {
    ...seal,
    marker: "committed",
    sealHash: sha256(stableJson(seal)),
  };
  if (stableJson(publishValue) !== stableJson(expectedPublishMarker)) {
    throw snapshotInvalid("The server-owned snapshot publish marker does not match its seal.");
  }
  return manifest;
}

async function assertSnapshotBinding(
  cwd: string,
  operation: MossResourceImportOperation,
  authority: MossPrivateSnapshotAuthority,
): Promise<void> {
  if (authority.kind !== operation.kind || authority.snapshotSha256 !== operation.snapshotSha256) {
    throw snapshotInvalid("The current snapshot authority does not match the operation.");
  }
  const stateRoot = nodePath.resolve(authority.stateRoot);
  const expectedPath = snapshotPayloadPath(
    stateRoot,
    {
      id: operation.resourceId,
      kind: operation.kind,
      provider: operation.provider,
      scope: operation.scope,
      name: operation.name,
      sourcePath: operation.sourcePath,
      sourceSha256: operation.snapshotSha256,
      sizeBytes: 0,
      format:
        operation.kind === "skill"
          ? "markdown"
          : operation.kind === "plugin"
            ? "directory"
            : "json",
      secretFields: [],
      warnings: [],
    },
    authority,
  );
  if (expectedPath !== nodePath.resolve(operation.snapshotPath)) {
    throw new MossResourceImportError("path-traversal", "Import snapshot is not server-owned.");
  }
  const base = nodePath.resolve(stateRoot);
  if (!isWithin(base, expectedPath, false)) {
    throw new MossResourceImportError(
      "path-traversal",
      "Import snapshot leaves the server-owned state.",
    );
  }
  await assertPrivateStatePath(stateRoot, expectedPath);
  const snapshotParent = await realpathNearestExisting(nodePath.dirname(expectedPath));
  const baseReal = await fs.realpath(base);
  if (!isWithin(baseReal, snapshotParent, false)) {
    throw new MossResourceImportError(
      "symlink-escape",
      "Import snapshot parent leaves server-owned state.",
    );
  }
  await assertSealedPrivateSnapshot(
    stateRoot,
    nodePath.dirname(expectedPath),
    operation.kind,
    operation.snapshotSha256,
    authority,
  );
}

async function freezeResourceSnapshot(
  resource: MossResourceImportResource,
  cwd: string,
  options: ReturnType<typeof importOptions>,
  authority: MossPrivateSnapshotAuthority,
): Promise<MossResourceImportResource> {
  const sourcePath = resourceSourcePath(resource);
  const finalPaths = privateSnapshotPathsForAuthority(options.stateDir, authority);
  await ensurePrivateStateRoot(cwd, options.stateDir);
  await options.ownershipStore.recoverPrivateStages(privateStageRecoveryInput(cwd, options));
  const existingSnapshot = await lstatOrNull(finalPaths.base);
  if (existingSnapshot) {
    if (existingSnapshot.isSymbolicLink() || !existingSnapshot.isDirectory()) {
      throw snapshotInvalid("The server-owned snapshot directory is missing or unsafe.");
    }
    await assertSealedPrivateSnapshot(
      options.stateDir,
      finalPaths.base,
      resource.kind,
      resource.sourceSha256,
      authority,
    );
    return {
      ...resource,
      snapshotPath: finalPaths.payload,
      snapshotSha256: resource.sourceSha256,
    };
  }
  const publishMarkerPath = privateSnapshotPublishMarkerPathForAuthority(
    options.stateDir,
    authority,
  );
  if (await lstatOrNull(publishMarkerPath)) {
    throw new MossResourceImportError(
      "concurrent-modification",
      "A server-owned snapshot publish is still in progress.",
    );
  }
  const snapshotStage = await options.ownershipStore.createPrivateStage(
    privateStageInput(options, authority),
  );
  let snapshotPublished = false;
  try {
    const stageRoot = nodePrivateStagePath(snapshotStage);
    await ensurePrivateStatePath(options.stateDir, stageRoot);
    await fs.mkdir(stageRoot, { mode: 0o700 }).catch((cause) => {
      if (!isErrno(cause, "EEXIST")) throw cause;
    });
    const payloadPath = nodePath.join(stageRoot, resource.kind === "plugin" ? "tree" : "payload");
    const manifestPath = nodePath.join(stageRoot, "manifest.json");
    const entries: SnapshotManifestEntry[] = [];
    if (resource.kind === "plugin") {
      const sourceRoot = await fs.realpath(sourcePath).catch(() => sourcePath);
      const sourceStat = await lstatOrNull(sourcePath);
      if (!sourceStat || sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
        throw new MossResourceImportError(
          "symlink-escape",
          "Plugin source is not a safe directory.",
        );
      }
      const sourceGuard = await captureNoFollowPathGuard(sourceRoot);
      let attemptedEntries = 0;
      let directoryCount = 0;
      let symlinkCount = 0;
      let totalBytes = 0;
      const copy = async (
        sourcePath: string,
        destination: string,
        relativePath: string,
        depth: number,
      ) => {
        attemptedEntries += 1;
        if (attemptedEntries > options.maxTreeEntries) {
          throw new MossResourceImportError(
            "limit-exceeded",
            "Plugin snapshot exceeds the entry limit.",
          );
        }
        await sourceGuard.assertUnchanged();
        const stat = await lstatOrNull(sourcePath);
        if (!stat) {
          throw new MossResourceImportError(
            "unreadable",
            "Plugin snapshot source entry disappeared.",
          );
        }
        if (stat.isSymbolicLink()) {
          symlinkCount += 1;
          if (symlinkCount > options.maxSymlinks) {
            throw new MossResourceImportError(
              "limit-exceeded",
              "Plugin snapshot exceeds the symlink limit.",
            );
          }
          throw new MossResourceImportError(
            "symlink-escape",
            "Plugin snapshot encountered an unsafe source entry.",
          );
        }
        if (stat.isDirectory()) {
          directoryCount += 1;
          if (directoryCount > options.maxDirectories) {
            throw new MossResourceImportError(
              "limit-exceeded",
              "Plugin snapshot exceeds the directory limit.",
            );
          }
          if (depth > options.maxTreeDepth) {
            throw new MossResourceImportError(
              "limit-exceeded",
              "Plugin snapshot exceeds the depth limit.",
            );
          }
          try {
            await fs.mkdir(destination, { mode: 0o700 });
          } catch (cause) {
            if (!isErrno(cause, "EEXIST")) throw cause;
          }
          const destinationStat = await lstatOrNull(destination);
          if (
            !destinationStat ||
            destinationStat.isSymbolicLink() ||
            !destinationStat.isDirectory()
          ) {
            throw new MossResourceImportError(
              "symlink-escape",
              "Plugin snapshot destination is unsafe.",
            );
          }
          const children = await readDirectoryEntries(
            sourcePath,
            undefined,
            options.maxTreeEntries,
          );
          await options.beforeFilesystemMutation?.({
            action: "after-readdir-before-copy",
            path: sourcePath,
            kind: resource.kind,
          });
          for (const child of children.toSorted((left, right) =>
            left.name.localeCompare(right.name),
          )) {
            await copy(
              nodePath.join(sourcePath, child.name),
              nodePath.join(destination, child.name),
              nodePath.join(relativePath, child.name),
              depth + 1,
            );
          }
          return;
        }
        if (!stat.isFile() || stat.size > options.maxFileBytes) {
          throw new MossResourceImportError(
            "limit-exceeded",
            "Plugin snapshot exceeds the file limit.",
          );
        }
        const bytes = await readStableFile(sourcePath, options.maxFileBytes);
        totalBytes += bytes.byteLength;
        if (totalBytes > options.maxTreeBytes) {
          throw new MossResourceImportError(
            "limit-exceeded",
            "Plugin snapshot exceeds the byte limit.",
          );
        }
        entries.push({ path: relativePath, sha256: sha256(bytes), sizeBytes: bytes.byteLength });
        const content = decodeText(bytes, sourcePath);
        try {
          await writeFileNoReplaceAtomic(destination, content, undefined, undefined, {
            mutationHook: options.beforeFilesystemMutation,
            directorySyncHook: options.directorySyncHook,
          });
        } catch (cause) {
          if (!(cause instanceof MossResourceImportError) || cause.code !== "conflict") throw cause;
          await verifyPrivateFileAfterCreateRace(
            options.stateDir,
            destination,
            content,
            options.maxFileBytes,
          );
        }
      };
      await copy(sourcePath, payloadPath, "", 0);
      await sourceGuard.assertUnchanged();
    } else {
      const sourceBytes = await readStableFile(sourcePath, options.maxFileBytes);
      if (sha256(sourceBytes) !== resource.sourceSha256) {
        throw new MossResourceImportError(
          "stale-source",
          "Source changed before its snapshot was sealed.",
        );
      }
      entries.push({
        path: nodePath.basename(sourcePath),
        sha256: sha256(sourceBytes),
        sizeBytes: sourceBytes.byteLength,
      });
      await ensurePrivateStatePath(options.stateDir, payloadPath);
      const content = decodeText(sourceBytes, sourcePath);
      try {
        await writeFileNoReplaceAtomic(payloadPath, content, undefined, undefined, {
          mutationHook: options.beforeFilesystemMutation,
          directorySyncHook: options.directorySyncHook,
        });
      } catch (cause) {
        if (!(cause instanceof MossResourceImportError) || cause.code !== "conflict") throw cause;
        await verifyPrivateFileAfterCreateRace(
          options.stateDir,
          payloadPath,
          content,
          options.maxFileBytes,
        );
      }
    }
    const snapshotSha256 =
      resource.kind === "plugin"
        ? sha256(
            entries
              .toSorted((left, right) => left.path.localeCompare(right.path))
              .map((entry) => `${entry.path}\0${entry.sha256}`)
              .join("\n"),
          )
        : resource.sourceSha256;
    if (snapshotSha256 !== resource.sourceSha256) {
      throw new MossResourceImportError(
        "stale-source",
        "Source changed while its snapshot was sealed.",
      );
    }
    const manifest = { schemaVersion: 1 as const, kind: resource.kind, snapshotSha256, entries };
    await writeFileNoReplaceAtomic(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      undefined,
      undefined,
      {
        mutationHook: options.beforeFilesystemMutation,
        directorySyncHook: options.directorySyncHook,
      },
    );
    const published = await options.ownershipStore.publishPrivateSnapshot({
      stage: snapshotStage,
      authority,
      kind: resource.kind,
      snapshotKey: snapshotKeyForAuthority(authority),
      snapshotSha256,
      manifest,
    });
    snapshotPublished = true;
    return { ...resource, snapshotPath: published.snapshotPath, snapshotSha256 };
  } catch (cause) {
    if (!snapshotPublished) {
      try {
        await cleanupPrivateLocalSourceStage(options.stateDir, nodePrivateStagePath(snapshotStage));
      } catch {
        throw aggregateImportCleanupFailure(
          cause,
          "The private snapshot stage cleanup could not be confirmed.",
        );
      }
    }
    throw safeImportPrimaryFailure(cause);
  }
}

async function verifySelectionTicket(input: {
  readonly origin: MossResourceImportSelectionOrigin;
  readonly ticket: string | undefined;
  readonly verifier: MossResourceImportSelectionTicketVerifier | undefined;
  readonly options: ReturnType<typeof importOptions>;
  readonly cwd: string;
  readonly workspaceId: string;
  readonly snapshotHash: string;
  readonly resourceIds: readonly string[];
  readonly consume?: boolean;
}): Promise<void> {
  if (input.origin !== "catalog") return;
  if (!input.ticket || !input.verifier || !input.options.workspaceId) {
    throw new MossResourceImportError(
      "ticket-invalid",
      "A valid catalog selection ticket and workspace binding are required.",
    );
  }
  const context = {
    ticket: input.ticket,
    ownerId: input.options.ownerId,
    workspaceId: input.workspaceId,
    workspaceRoot: input.cwd,
    selectionSnapshotSha256: input.snapshotHash,
    resourceIds: input.resourceIds,
    securityProfile: input.options.selectionSecurityProfile,
    licenseState: input.options.selectionLicenseState,
  };
  const result =
    input.consume === undefined
      ? await input.verifier.verify(context)
      : await input.verifier.verify(context, { consume: input.consume });
  if (!result.valid) {
    throw new MossResourceImportError(result.code, "Catalog selection ticket is not valid.");
  }
  if (
    (input.options.selectionSecurityProfile !== "unknown" &&
      result.securityProfile !== input.options.selectionSecurityProfile) ||
    (input.options.selectionLicenseState !== "unknown" &&
      result.licenseState !== input.options.selectionLicenseState)
  ) {
    throw new MossResourceImportError(
      "ticket-mismatch",
      "Catalog selection ticket security or license claims do not match the request.",
    );
  }
}

function blockingWarningCode(
  resource: MossResourceImportResource,
): Extract<
  MossResourceImportIssueCode,
  | "secret-fields"
  | "reserved-identity"
  | "mcp-invalid-transport"
  | "binary"
  | "limit-exceeded"
  | "invalid-identity"
> | null {
  const code = resource.warnings.find((warning) =>
    [
      "secret-fields",
      "reserved-identity",
      "mcp-invalid-transport",
      "binary",
      "limit-exceeded",
      "invalid-identity",
    ].includes(warning),
  ) as
    | Extract<
        MossResourceImportIssueCode,
        | "secret-fields"
        | "reserved-identity"
        | "mcp-invalid-transport"
        | "binary"
        | "limit-exceeded"
        | "invalid-identity"
      >
    | undefined;
  // Plugin manifests and structured plugin files are copied through the
  // sanitizer below. Literal secret fields are omitted there, while secret
  // content in executable/text payloads remains a hard block.
  if (
    resource.kind === "plugin" &&
    code === "secret-fields" &&
    !resource.secretFields.some((field) => field === "content" || field.endsWith(".content"))
  ) {
    return null;
  }
  return code === undefined ? null : code;
}

async function readMcpSnapshotServer(
  operation: MossResourceImportOperation,
  maxFileBytes: number,
): Promise<{
  readonly source: NonNullable<Awaited<ReturnType<typeof inspectFile>>>;
  readonly sourceServer: Record<string, unknown>;
}> {
  const source = await inspectFile(operation.snapshotPath, maxFileBytes);
  if (!source || source.sourceSha256 !== operation.snapshotSha256) {
    throw new MossResourceImportError(
      "stale-source",
      "Server-owned MCP snapshot failed verification.",
    );
  }
  const format = nodePath.extname(operation.sourcePath).toLowerCase() === ".toml" ? "toml" : "json";
  const parsed = parseMcp(source.raw, format);
  const sourceServer =
    parsed && operation.sourceSelector
      ? mcpEntryForSelector(parsed.value, operation.sourceSelector)
      : null;
  if (!sourceServer) {
    throw new MossResourceImportError(
      "stale-source",
      "MCP server disappeared from the server-owned snapshot.",
    );
  }
  const sourceValidation = validateMcpServer(
    operation.name,
    sourceServer,
    operation.sourceSelector ?? operation.name,
  );
  if (sourceValidation) {
    throw new MossResourceImportError(sourceValidation.code, sourceValidation.message);
  }
  return { source, sourceServer };
}

export async function planMossResourceImport(
  input: MossResourceImportPlanRequest,
): Promise<MossResourceImportPlanResult> {
  const inventory = await inventoryMossResourceImportInternal(input, true);
  const options = importOptions(input);
  const localSourceResources = inventory.resources.filter((resource) =>
    LOCAL_SOURCE_PATHS.has(resource),
  );
  try {
    const cwd = nodePath.resolve(input.cwd);
    const selected = input.resourceIds
      ? inventory.resources.filter((resource) => input.resourceIds?.includes(resource.id))
      : inventory.resources;
    if (
      selected.some(
        (resource) =>
          resource.kind === "mcp" && resource.warnings.includes("mcp-invalid-transport"),
      )
    ) {
      throw new MossResourceImportError(
        "mcp-invalid-transport",
        "MCP URL transport is not safe to import.",
      );
    }
    await ensurePrivateStateRoot(cwd, options.stateDir);
    await options.ownershipStore.recoverPrivateStages(privateStageRecoveryInput(cwd, options));
    await options.ownershipStore.assertStateBudget({
      maxBytes: DEFAULT_MAX_STATE_BYTES,
      maxEntries: DEFAULT_MAX_STATE_ENTRIES,
    });
    const planId = `plan-${randomUUID()}`;
    const planNonce = snapshotPlanNonce(planId);
    const workspaceId = input.workspaceId ?? options.workspaceId ?? workspaceBindingId(cwd);
    const selectionTicket = input.selectionTicket ?? options.selectionTicket;
    const selectionOrigin: MossResourceImportSelectionOrigin =
      input.selectionOrigin ?? (selectionTicket ? "catalog" : "local");
    const selectedWithinLimit: MossResourceImportResource[] = [];
    for (const resource of selected.slice(0, options.maxPlanOperations)) {
      const frozen = await freezeResourceSnapshot(
        resource,
        cwd,
        options,
        snapshotAuthorityForPlan(
          cwd,
          options,
          planId,
          planNonce,
          resource.kind,
          resource.sourceSha256,
        ),
      );
      selectedWithinLimit.push(frozen);
      if (LOCAL_SOURCE_PATHS.has(resource)) {
        await cleanupLocalSourceResource(resource, options);
      }
      await options.ownershipStore.assertStateBudget({
        maxBytes: DEFAULT_MAX_STATE_BYTES,
        maxEntries: DEFAULT_MAX_STATE_ENTRIES,
      });
    }
    const selectedIds = selectedWithinLimit.map((resource) => resource.id);
    const snapshotHash = selectionSnapshotHash(selectedWithinLimit);
    const stateFingerprint = importStateFingerprint(
      cwd,
      workspaceId,
      snapshotHash,
      options.stateDir,
    );
    await verifySelectionTicket({
      origin: selectionOrigin,
      ticket: selectionTicket,
      verifier: options.selectionTicketVerifier,
      options,
      cwd,
      workspaceId,
      snapshotHash,
      resourceIds: selectedIds,
      consume: false,
    });
    const provenance = await readProvenance(options.ownershipStore);
    const operations: MossResourceImportOperation[] = [];
    const issues = [
      ...inventory.issues,
      ...(selected.length > selectedWithinLimit.length
        ? [issue("limit-exceeded", "The import plan exceeds its hard operation limit.")]
        : []),
    ];
    const owners = new Map<string, string>();
    for (const resource of selectedWithinLimit.toSorted((left, right) => {
      const leftScope = left.scope === "workspace" ? 0 : 1;
      const rightScope = right.scope === "workspace" ? 0 : 1;
      return (
        leftScope - rightScope ||
        left.provider.localeCompare(right.provider) ||
        left.sourcePath.localeCompare(right.sourcePath) ||
        left.id.localeCompare(right.id)
      );
    })) {
      const identity =
        resource.canonicalIdentityKey ??
        canonicalIdentityKey({ kind: resource.kind, name: resource.name });
      if (!owners.has(identity)) owners.set(identity, resource.id);
    }
    for (const resource of selectedWithinLimit) {
      const identity =
        resource.canonicalIdentityKey ??
        canonicalIdentityKey({ kind: resource.kind, name: resource.name });
      const collisionOwner = owners.get(identity);
      const invalidIdentity = providerSanitizedIdentity(resource.name).length === 0;
      const target = invalidIdentity
        ? {
            path: nodePath.join(getMossSourceLayout(cwd).root, "rejected", resource.id),
            kind: resource.kind === "mcp" ? ("mcp" as const) : ("file" as const),
          }
        : canonicalTarget(resource, cwd);
      if (!invalidIdentity) await assertCanonicalPathParents(cwd, target.path);
      const existing = invalidIdentity ? null : await targetConflict(resource, target, provenance);
      const blockingCode = invalidIdentity ? "invalid-identity" : blockingWarningCode(resource);
      const isCollision = collisionOwner !== undefined && collisionOwner !== resource.id;
      const baseAction = isCollision
        ? "conflict"
        : (existing ??
          (blockingCode !== null ||
          (resource.kind !== "mcp" &&
            resource.secretFields.some(
              (field) => field === "content" || field.endsWith(".content"),
            ))
            ? "blocked"
            : resource.kind === "mcp"
              ? "merge"
              : "copy"));
      const action =
        baseAction === "conflict" &&
        input.localSource?.replaceExisting === true &&
        resource.kind !== "mcp"
          ? "replace"
          : baseAction;
      const expectedBeforeHash =
        action === "replace" ? await hashPath(target.path, hashLimitsFor(options)) : undefined;
      if (isCollision) {
        issues.push(
          issue("conflict", "Multiple selected resources claim the same canonical identity."),
        );
      }
      if (action === "conflict") {
        if (!isCollision) issues.push(issue("conflict", "Canonical target already exists."));
      }
      if (action === "blocked") {
        issues.push(
          issue(
            blockingCode ?? "secret-fields",
            "Resource is quarantined because it is not safe to import automatically.",
            undefined,
            resource.secretFields,
            "error",
          ),
        );
      }
      operations.push({
        operationId: `operation-${sha256(`${planId}:${resource.id}:${target.path}`).slice(0, 32)}`,
        resourceId: resource.id,
        kind: resource.kind,
        provider: resource.provider,
        scope: resource.scope,
        name: resource.name,
        sourcePath: resource.sourcePath,
        ...(resource.sourceSelector ? { sourceSelector: resource.sourceSelector } : {}),
        sourceSha256: resource.sourceSha256,
        snapshotPath: resource.snapshotPath!,
        snapshotSha256: resource.snapshotSha256!,
        ...(resource.sourceVersion ? { sourceVersion: resource.sourceVersion } : {}),
        targetPath: target.path,
        action,
        ...(expectedBeforeHash !== undefined ? { expectedBeforeHash } : {}),
        secretFields: [...resource.secretFields],
        warnings: [
          ...resource.warnings,
          ...warningCodes(resource.secretFields),
          ...(invalidIdentity ? ["invalid-identity" as const] : []),
        ],
        canonicalIdentityKey: identity,
        enabled: resource.enabled ?? resource.kind === "skill",
        quarantined: resource.quarantined ?? resource.kind !== "skill",
      });
    }
    const createdAt = options.now().toISOString();
    const expiresAt = new Date(options.now().getTime() + options.planTtlMillis).toISOString();
    const unsigned = {
      schemaVersion: 1 as const,
      planId,
      cwd,
      createdAt,
      expiresAt,
      issuer: options.issuer,
      ownerId: options.ownerId,
      projectId: options.projectId ?? workspaceId,
      principalId: options.principalId,
      sessionId: options.sessionId,
      workspaceId,
      stateFingerprint,
      stateRoot: options.stateDir,
      nonce: planNonce,
      selectedResourceIds: selectedIds,
      operations,
      issues: issues.slice(0, 2_000),
      selectionOrigin,
      selectionSnapshotSha256: snapshotHash,
      ...(selectionTicket ? { selectionTicketDigest: sha256(selectionTicket) } : {}),
    };
    const plan = { ...unsigned, planHash: planHash(unsigned) };
    try {
      await registerMossResourceImportPlan({
        ownershipStore: options.ownershipStore,
        plan,
        ...(options.planRegistry ? { registry: options.planRegistry } : {}),
      });
    } catch (cause) {
      if (cause instanceof MossCanonicalMutationIntentError) {
        throw new MossResourceImportError(cause.code, cause.message);
      }
      throw cause;
    }
    return {
      inventoryId: inventory.inventoryId,
      plan,
    };
  } finally {
    for (const resource of localSourceResources) {
      await cleanupLocalSourceResource(resource, options);
    }
  }
}

function unsignedPlan(plan: MossResourceImportPlan): Omit<MossResourceImportPlan, "planHash"> {
  const { planHash: _planHash, ...rest } = plan;
  return rest;
}

async function assertCanonicalPathParents(cwd: string, targetPath: string): Promise<void> {
  const root = nodePath.resolve(getMossSourceLayout(cwd).root);
  const target = nodePath.resolve(targetPath);
  if (!isWithin(root, target, false)) {
    throw new MossResourceImportError(
      "path-traversal",
      "Import path is outside the canonical Moss root.",
    );
  }
  const rootStat = await lstatOrNull(root);
  if (!rootStat) return;
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new MossResourceImportError("symlink-escape", "Canonical Moss parent is unsafe.");
  }
  let current = root;
  const relativeParent = nodePath.relative(root, nodePath.dirname(target));
  for (const segment of relativeParent.split(nodePath.sep).filter(Boolean)) {
    current = nodePath.join(current, segment);
    const stat = await lstatOrNull(current);
    if (!stat) return;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new MossResourceImportError("symlink-escape", "Canonical Moss parent is unsafe.");
    }
  }
  const rootReal = await fs.realpath(root);
  const parentReal = await fs.realpath(nodePath.dirname(target));
  if (!isWithin(rootReal, parentReal, false)) {
    throw new MossResourceImportError(
      "path-traversal",
      "Canonical Moss parent escapes the workspace.",
    );
  }
}

interface CanonicalDirectoryIdentity {
  readonly path: string;
  readonly realPath: string;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
}

interface CanonicalParentGuard {
  readonly parentPath: string;
  readonly assertUnchanged: () => Promise<void>;
}

interface NoFollowPathGuard {
  readonly assertUnchanged: () => Promise<void>;
}

async function captureNoFollowPathGuard(path: string): Promise<NoFollowPathGuard> {
  const resolved = nodePath.resolve(path);
  const parsed = nodePath.parse(resolved);
  const identities: CanonicalDirectoryIdentity[] = [];
  let current = parsed.root;
  const relative = nodePath.relative(parsed.root, resolved);
  for (const segment of relative.split(nodePath.sep).filter(Boolean)) {
    current = nodePath.join(current, segment);
    const stat = await lstatOrNull(current);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new MossResourceImportError(
        "symlink-escape",
        "Source directory is not a safe directory.",
      );
    }
    const realPath = await fs.realpath(current);
    identities.push({ path: current, realPath, dev: stat.dev, ino: stat.ino, mode: stat.mode });
  }
  return {
    assertUnchanged: async () => {
      for (const identity of identities) {
        const stat = await lstatOrNull(identity.path);
        const realPath = await fs.realpath(identity.path).catch(() => null);
        if (
          !stat ||
          stat.isSymbolicLink() ||
          !stat.isDirectory() ||
          realPath !== identity.realPath ||
          stat.dev !== identity.dev ||
          stat.ino !== identity.ino ||
          stat.mode !== identity.mode
        ) {
          throw new MossResourceImportError(
            stat?.isSymbolicLink() ? "symlink-escape" : "concurrent-modification",
            "Source directory changed during import.",
          );
        }
      }
    },
  };
}

async function assertOwnedImportMarker(markerPath: string, operationId: string): Promise<void> {
  const stat = await lstatOrNull(markerPath);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    throw new MossResourceImportError(
      "symlink-escape",
      "Import marker is not a safe regular file.",
    );
  }
  try {
    const marker = JSON.parse(decodeText(await readStableFile(markerPath, 16 * 1024), markerPath));
    if (recordValue(marker)?.operationId !== operationId) {
      throw new MossResourceImportError(
        "transaction-invalid",
        "Import marker ownership is invalid.",
      );
    }
  } catch (cause) {
    if (cause instanceof MossResourceImportError) throw cause;
    throw new MossResourceImportError("transaction-invalid", "Import marker ownership is invalid.");
  }
}

async function withWorkspaceLock<T>(
  cwd: string,
  options: ReturnType<typeof importOptions>,
  operation: (lockedOptions: ReturnType<typeof importOptions>) => Promise<T>,
): Promise<T> {
  const lockNonce = `lock-nonce-${randomUUID()}`;
  const expectedWorkspaceId = options.workspaceId ?? workspaceBindingId(cwd);
  const expectedProjectId = options.projectId ?? expectedWorkspaceId;
  const lock = await options.ownershipStore.acquireLock({
    cwd,
    ownerId: options.ownerId,
    workspaceId: expectedWorkspaceId,
    projectId: expectedProjectId,
    principalId: options.principalId,
    sessionId: options.sessionId,
    nonce: lockNonce,
  });
  if (
    lock.ownerId !== options.ownerId ||
    lock.projectId !== expectedProjectId ||
    lock.workspaceId !== expectedWorkspaceId ||
    lock.principalId !== options.principalId ||
    lock.sessionId !== options.sessionId
  ) {
    await lock.release().catch(() => undefined);
    throw new MossResourceImportError(
      "authorization-required",
      "Ownership lock binding does not match the authenticated session.",
    );
  }
  const lockedOptions = {
    ...options,
    activeFencingToken: lock.fencingToken,
    activeGeneration: lock.generation,
    activeLockNonce: lock.nonce,
  } satisfies ReturnType<typeof importOptions>;
  try {
    return await operation(lockedOptions);
  } finally {
    await lock.release();
  }
}

async function syncDirectory(
  directoryPath: string,
  directorySyncHook?: MossResourceImportDirectorySyncHook,
): Promise<void> {
  try {
    await directorySyncHook?.(directoryPath);
    const handle = await fs.open(directoryPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    throw new MossResourceImportError(
      "durability-unsupported",
      "Canonical directory durability could not be confirmed.",
    );
  }
}

async function writeFileNoReplaceAtomic(
  filePath: string,
  content: string,
  temporaryPath?: string,
  parentGuard?: CanonicalParentGuard,
  context: {
    readonly mutationHook?: MossResourceImportFilesystemMutationHook | undefined;
    readonly directorySyncHook?: MossResourceImportDirectorySyncHook | undefined;
    readonly operationId?: string;
    readonly kind?: MossResourceImportKind;
  } = {},
): Promise<void> {
  await parentGuard?.assertUnchanged();
  if (!parentGuard) await fs.mkdir(nodePath.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = temporaryPath ?? `${filePath}.tmp-${randomUUID()}`;
  if (nodePath.dirname(tempPath) !== nodePath.dirname(filePath)) {
    throw new MossResourceImportError(
      "path-traversal",
      "Atomic staging path is outside the target parent.",
    );
  }
  let cleanupAllowed = true;
  try {
    const handle = await fs.open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close().catch(() => undefined);
    }
    try {
      await parentGuard?.assertUnchanged();
      await context.mutationHook?.({
        action: "before-create",
        path: filePath,
        ...(context.operationId ? { operationId: context.operationId } : {}),
        ...(context.kind ? { kind: context.kind } : {}),
      });
      await context.mutationHook?.({
        action: "after-lstat-before-publish",
        path: filePath,
        ...(context.operationId ? { operationId: context.operationId } : {}),
        ...(context.kind ? { kind: context.kind } : {}),
      });
      await parentGuard?.assertUnchanged();
      await fs.link(tempPath, filePath);
    } catch (cause) {
      if (isErrno(cause, "EEXIST")) {
        throw new MossResourceImportError("conflict", "Canonical target already exists.");
      }
      throw cause;
    }
    await parentGuard?.assertUnchanged();
    const tempStat = await lstatOrNull(tempPath);
    if (tempStat?.isSymbolicLink()) {
      throw new MossResourceImportError("symlink-escape", "Atomic staging path became a symlink.");
    }
    await fs.rm(tempPath, { force: true });
    await syncDirectory(nodePath.dirname(filePath), context.directorySyncHook);
    await parentGuard?.assertUnchanged();
  } catch (cause) {
    if (parentGuard) {
      try {
        await parentGuard.assertUnchanged();
      } catch {
        cleanupAllowed = false;
      }
    }
    if (cleanupAllowed) await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw cause;
  }
}

async function verifyPrivateFileAfterCreateRace(
  stateRoot: string,
  filePath: string,
  expectedContent: string,
  maxBytes: number,
): Promise<void> {
  await assertPrivateStatePath(stateRoot, filePath);
  const stat = await lstatOrNull(filePath);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    throw new MossResourceImportError(
      "concurrent-modification",
      "A concurrent private snapshot writer produced an unsafe file.",
    );
  }
  const actual = await readStableFile(filePath, maxBytes);
  if (sha256(actual) !== sha256(new TextEncoder().encode(expectedContent))) {
    throw new MossResourceImportError(
      "concurrent-modification",
      "A concurrent private snapshot writer produced different content.",
    );
  }
}

function copyableText(raw: string, fieldPath: string): string {
  if (obviousSecret(raw)) {
    throw new MossResourceImportError(
      "secret-fields",
      `Refusing to copy a text resource containing a secret-like value: ${fieldPath}`,
    );
  }
  return raw;
}

async function copyPluginTree(
  operation: MossResourceImportOperation,
  sourcePath: string,
  targetPath: string,
  options: {
    readonly cwd: string;
    readonly stateRoot: string;
    readonly maxFileBytes: number;
    readonly maxTreeBytes: number;
    readonly maxTreeDepth: number;
    readonly maxTreeEntries: number;
    readonly maxHashBytes: number;
    readonly maxHashDepth: number;
    readonly maxHashMillis: number;
    readonly stagingPath: string;
    readonly stage: MossPrivateStage;
    readonly filesystemCapability: MossFilesystemCapability;
    readonly action: "publish" | "replace";
    readonly authorityFor: (expectedAfterHash: string) => CapabilityAuthority;
    readonly expectedBeforeHash: string;
    readonly onPrepared?: (expectedHash: string) => void | Promise<void>;
    readonly mutationHook?: MossResourceImportFilesystemMutationHook | undefined;
    readonly directorySyncHook?: MossResourceImportDirectorySyncHook | undefined;
  },
): Promise<{ readonly afterHash: string; readonly expectedHash: string }> {
  const sourceRoot = await fs.realpath(sourcePath).catch(() => sourcePath);
  const stat = await lstatOrNull(sourcePath);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new MossResourceImportError(
      "symlink-escape",
      `Plugin source is not a regular directory: ${sourcePath}`,
    );
  }
  const sourceGuard = await captureNoFollowPathGuard(sourceRoot);
  const stagingPath = options.stagingPath;
  let expectedHash: string | undefined;
  try {
    await ensurePrivateStatePath(options.stateRoot, stagingPath);
    await fs.mkdir(stagingPath, { mode: 0o700 });
    const stagingStat = await lstatOrNull(stagingPath);
    if (!stagingStat || stagingStat.isSymbolicLink() || !stagingStat.isDirectory()) {
      throw new MossResourceImportError("symlink-escape", "Plugin staging directory is unsafe.");
    }
    let sizeBytes = 0;
    let attemptedEntries = 0;

    const copyEntry = async (
      sourceEntry: string,
      targetEntry: string,
      relativePath: string,
      depth: number,
    ): Promise<void> => {
      await sourceGuard.assertUnchanged();
      attemptedEntries += 1;
      if (attemptedEntries > options.maxTreeEntries) {
        throw new MossResourceImportError("limit-exceeded", "Plugin tree exceeds the entry limit.");
      }
      const entryStat = await lstatOrNull(sourceEntry);
      if (!entryStat)
        throw new MossResourceImportError("unreadable", `Plugin entry disappeared: ${sourceEntry}`);
      if (entryStat.isSymbolicLink()) {
        const target = await fs.realpath(sourceEntry).catch(() => null);
        throw new MossResourceImportError(
          target && isWithin(sourceRoot, target, false) ? "symlink" : "symlink-escape",
          `Refusing to copy a symlinked plugin entry: ${sourceEntry}`,
        );
      }
      if (entryStat.isDirectory()) {
        if (depth >= options.maxTreeDepth) {
          throw new MossResourceImportError(
            "limit-exceeded",
            "Plugin tree exceeds the depth limit.",
          );
        }
        await fs.mkdir(targetEntry, { mode: 0o700 });
        const targetEntryStat = await lstatOrNull(targetEntry);
        if (
          !targetEntryStat ||
          targetEntryStat.isSymbolicLink() ||
          !targetEntryStat.isDirectory()
        ) {
          throw new MossResourceImportError(
            "symlink-escape",
            "Plugin staging directory is unsafe.",
          );
        }
        const sourceEntryGuard = await captureNoFollowPathGuard(await fs.realpath(sourceEntry));
        await sourceEntryGuard.assertUnchanged();
        const children = await fs.readdir(sourceEntry, { withFileTypes: true });
        await options.mutationHook?.({
          action: "after-readdir-before-copy",
          path: sourceEntry,
          operationId: operation.operationId,
          kind: operation.kind,
        });
        for (const child of children.toSorted((left, right) =>
          left.name.localeCompare(right.name),
        )) {
          await copyEntry(
            nodePath.join(sourceEntry, child.name),
            nodePath.join(targetEntry, child.name),
            nodePath.join(relativePath, child.name),
            depth + 1,
          );
        }
        await sourceEntryGuard.assertUnchanged();
        return;
      }
      if (
        !entryStat.isFile() ||
        entryStat.size > options.maxFileBytes ||
        sizeBytes + entryStat.size > options.maxTreeBytes
      ) {
        throw new MossResourceImportError(
          "limit-exceeded",
          "Plugin file exceeds the import limits.",
        );
      }
      const rawBuffer = await readStableFile(sourceEntry, options.maxFileBytes);
      const raw = decodeText(rawBuffer, sourceEntry);
      sizeBytes += rawBuffer.byteLength;
      if (sizeBytes > options.maxTreeBytes) {
        throw new MossResourceImportError("limit-exceeded", "Plugin tree exceeds the byte limit.");
      }
      if (relativePath === "plugin.json") return;
      const extension = nodePath.extname(sourceEntry).toLowerCase();
      let output = raw;
      if (extension === ".json" || extension === ".toml") {
        try {
          const parsed = extension === ".toml" ? parseToml(output) : JSON.parse(output);
          const sanitized = sanitizeValue(parsed, nodePath.relative(sourcePath, sourceEntry));
          output =
            extension === ".toml"
              ? stringifyToml(sanitized.value as Record<string, unknown>)
              : `${JSON.stringify(sanitized.value, null, 2)}\n`;
        } catch (cause) {
          if (cause instanceof MossResourceImportError) throw cause;
          output = copyableText(output, sourceEntry);
        }
      } else {
        output = copyableText(output, sourceEntry);
      }
      const stagingGuard = privateStateParentGuard(options.stateRoot, targetEntry);
      await writeFileNoReplaceAtomic(targetEntry, output, undefined, stagingGuard, {
        mutationHook: options.mutationHook,
        directorySyncHook: options.directorySyncHook,
        operationId: operation.operationId,
        kind: operation.kind,
      });
    };

    await sourceGuard.assertUnchanged();
    const children = await fs.readdir(sourcePath, { withFileTypes: true });
    await options.mutationHook?.({
      action: "after-readdir-before-copy",
      path: sourcePath,
      operationId: operation.operationId,
      kind: operation.kind,
    });
    for (const child of children.toSorted((left, right) => left.name.localeCompare(right.name))) {
      await copyEntry(
        nodePath.join(sourcePath, child.name),
        nodePath.join(stagingPath, child.name),
        child.name,
        1,
      );
    }
    await sourceGuard.assertUnchanged();
    const manifestInfo = await readManifest(sourcePath, options.maxFileBytes);
    await sourceGuard.assertUnchanged();
    const snapshotInspection = await inspectTree(
      sourcePath,
      sourceRoot,
      {
        maxFileBytes: options.maxFileBytes,
        maxTreeBytes: options.maxTreeBytes,
        maxTreeDepth: options.maxTreeDepth,
        maxTreeEntries: options.maxTreeEntries,
      },
      [],
    );
    if (!snapshotInspection.safe || snapshotInspection.sourceSha256 !== operation.snapshotSha256) {
      throw new MossResourceImportError(
        "stale-source",
        "Server-owned plugin snapshot failed verification.",
      );
    }
    if (!manifestInfo) {
      throw new MossResourceImportError(
        "unsupported",
        "Plugin manifest disappeared during import.",
      );
    }
    const manifest = sanitizeValue(manifestInfo.manifest, "plugin").value;
    const manifestStagingGuard = privateStateParentGuard(
      options.stateRoot,
      nodePath.join(stagingPath, "plugin.json"),
    );
    await writeFileNoReplaceAtomic(
      nodePath.join(stagingPath, "plugin.json"),
      `${JSON.stringify(
        {
          ...(recordValue(manifest) ?? {}),
          name: operation.name,
          enabled: false,
          quarantined: true,
          committed: true,
          source: "moss-import",
          provider: operation.provider,
          canonicalIdentityKey:
            operation.canonicalIdentityKey ??
            canonicalIdentityKey({ kind: operation.kind, name: operation.name }),
        },
        null,
        2,
      )}\n`,
      undefined,
      manifestStagingGuard,
      {
        mutationHook: options.mutationHook,
        directorySyncHook: options.directorySyncHook,
        operationId: operation.operationId,
        kind: operation.kind,
      },
    );
    await manifestStagingGuard.assertUnchanged();
    expectedHash = await hashPath(stagingPath, {
      maxBytes: options.maxHashBytes,
      maxDepth: options.maxHashDepth,
      maxMillis: options.maxHashMillis,
    });
    await options.onPrepared?.(expectedHash);
    await options.mutationHook?.({
      action: "after-lstat-before-publish",
      path: targetPath,
      operationId: operation.operationId,
      kind: operation.kind,
    });
    const authority = options.authorityFor(expectedHash);
    const result = await options.filesystemCapability[options.action]({
      cwd: options.cwd,
      targetPath,
      stage: options.stage,
      kind: operation.kind,
      ...authority,
    });
    const afterHash = assertDurableCapabilityResult(result, authority, expectedHash);
    await removePrivateStatePath(options.stateRoot, stagingPath, {
      recursive: true,
      directorySyncHook: options.directorySyncHook,
    });
    return { afterHash, expectedHash };
  } catch (cause) {
    await removePrivateStatePath(options.stateRoot, stagingPath, {
      recursive: true,
      directorySyncHook: options.directorySyncHook,
    }).catch(() => undefined);
    throw cause;
  }
}

async function copySkillFile(
  operation: MossResourceImportOperation,
  cwd: string,
  targetPath: string,
  options: {
    readonly maxFileBytes: number;
    readonly stateRoot: string;
    readonly stagingPath: string;
    readonly stage: MossPrivateStage;
    readonly filesystemCapability: MossFilesystemCapability;
    readonly action: "create" | "replace";
    readonly authorityFor: (expectedAfterHash: string) => CapabilityAuthority;
    readonly expectedBeforeHash: string;
    readonly onPrepared?: (expectedHash: string) => void | Promise<void>;
    readonly hashLimits: HashLimits;
    readonly mutationHook?: MossResourceImportFilesystemMutationHook | undefined;
    readonly directorySyncHook?: MossResourceImportDirectorySyncHook | undefined;
  },
): Promise<string> {
  const inspected = await inspectFile(operation.snapshotPath, options.maxFileBytes);
  if (!inspected || inspected.sourceSha256 !== operation.snapshotSha256) {
    throw new MossResourceImportError(
      "stale-source",
      "Server-owned skill snapshot failed verification.",
    );
  }
  const output = copyableText(inspected.raw, operation.snapshotPath);
  const expectedHash = sha256(new TextEncoder().encode(output));
  await options.onPrepared?.(expectedHash);
  await ensurePrivateStatePath(options.stateRoot, options.stagingPath);
  await writeFileNoReplaceAtomic(
    options.stagingPath,
    output,
    undefined,
    privateStateParentGuard(options.stateRoot, options.stagingPath),
    {
      mutationHook: options.mutationHook,
      directorySyncHook: options.directorySyncHook,
      operationId: operation.operationId,
      kind: operation.kind,
    },
  );
  await options.mutationHook?.({
    action: "after-lstat-before-publish",
    path: targetPath,
    operationId: operation.operationId,
    kind: operation.kind,
  });
  const result = await options.filesystemCapability[options.action]({
    cwd,
    targetPath,
    stage: options.stage,
    kind: operation.kind,
    ...options.authorityFor(expectedHash),
  });
  return assertDurableCapabilityResult(result, options.authorityFor(expectedHash), expectedHash);
}

async function mergeMcpServer(
  operation: MossResourceImportOperation,
  cwd: string,
  options: {
    readonly maxFileBytes: number;
    readonly stateRoot: string;
    readonly expectedBeforeHash: string;
    readonly stagingPath: string;
    readonly stage: MossPrivateStage;
    readonly filesystemCapability: MossFilesystemCapability;
    readonly importOptions: ReturnType<typeof importOptions>;
    readonly capabilityOperationId: string;
    readonly onPrepared?: (expectedHash: string) => void | Promise<void>;
    readonly hashLimits: HashLimits;
    readonly mutationHook?: MossResourceImportFilesystemMutationHook | undefined;
    readonly directorySyncHook?: MossResourceImportDirectorySyncHook | undefined;
  },
): Promise<{
  readonly afterHash: string;
  readonly beforeHash: string;
  readonly beforeConfigExisted: boolean;
}> {
  const { source, sourceServer } = await readMcpSnapshotServer(operation, options.maxFileBytes);
  const sanitized = sanitizeValue(sourceServer, operation.sourceSelector ?? operation.name);
  const safeServer = recordValue(sanitized.value);
  if (!safeServer || Object.keys(safeServer).length === 0) {
    throw new MossResourceImportError(
      "secret-fields",
      `MCP server has no non-secret fields to import: ${operation.name}`,
    );
  }
  const targetPath = operation.targetPath;
  const beforeConfigExisted = await pathExists(targetPath);
  const beforeHash = await hashPath(targetPath, options.hashLimits);
  if (beforeHash !== options.expectedBeforeHash) {
    throw new MossResourceImportError(
      "concurrent-modification",
      "Canonical MCP config changed before the import could be committed.",
    );
  }
  const config = (await readJsonObject(targetPath)) ?? {};
  const servers = recordValue(config.mcpServers) ?? {};
  if (
    Object.entries(servers).some(
      ([name]) => canonicalIdentityKey({ kind: "mcp", name }) === operation.canonicalIdentityKey,
    )
  ) {
    throw new MossResourceImportError(
      "conflict",
      `Canonical MCP server already exists: ${operation.name}`,
    );
  }
  const nextConfig = {
    ...config,
    mcpServers: {
      ...servers,
      [operation.name]: { ...safeServer, enabled: false },
    },
  };
  const serialized = `${JSON.stringify(nextConfig, null, 2)}\n`;
  if (new TextEncoder().encode(serialized).byteLength > options.maxFileBytes) {
    throw new MossResourceImportError(
      "limit-exceeded",
      "Canonical MCP config exceeds the file limit.",
    );
  }
  const expectedHash = sha256(new TextEncoder().encode(serialized));
  await options.onPrepared?.(expectedHash);
  await ensurePrivateStatePath(options.stateRoot, options.stagingPath);
  await writeFileNoReplaceAtomic(
    options.stagingPath,
    serialized,
    undefined,
    privateStateParentGuard(options.stateRoot, options.stagingPath),
    {
      mutationHook: options.mutationHook,
      directorySyncHook: options.directorySyncHook,
      operationId: operation.operationId,
      kind: operation.kind,
    },
  );
  await options.mutationHook?.({
    action: beforeConfigExisted ? "before-replace" : "before-create",
    path: targetPath,
    operationId: operation.operationId,
    kind: operation.kind,
  });
  await options.mutationHook?.({
    action: "after-lstat-before-publish",
    path: targetPath,
    operationId: operation.operationId,
    kind: operation.kind,
  });
  const result = await (beforeConfigExisted
    ? options.filesystemCapability.replace({
        cwd,
        targetPath,
        stage: options.stage,
        ...capabilityAuthority(
          cwd,
          options.importOptions,
          options.capabilityOperationId,
          beforeHash,
          expectedHash,
        ),
        kind: operation.kind,
      })
    : options.filesystemCapability.create({
        cwd,
        targetPath,
        stage: options.stage,
        ...capabilityAuthority(
          cwd,
          options.importOptions,
          options.capabilityOperationId,
          beforeHash,
          expectedHash,
        ),
        kind: operation.kind,
      }));
  const authority = capabilityAuthority(
    cwd,
    options.importOptions,
    options.capabilityOperationId,
    beforeHash,
    expectedHash,
  );
  const afterHash = assertDurableCapabilityResult(result, authority, expectedHash);
  return {
    afterHash,
    beforeHash,
    beforeConfigExisted,
  };
}

async function removeProvenanceRecords(
  _cwd: string,
  transactionId: string,
  options: ReturnType<typeof importOptions>,
  operationIds?: ReadonlySet<string>,
): Promise<void> {
  const currentRecord = await options.ownershipStore.readPrivateRecord({
    fileName: PROVENANCE_FILE_NAME,
  });
  if (!currentRecord) return;
  const current = await readProvenance(options.ownershipStore);
  const records = current.records.filter(
    (record) =>
      record.transactionId !== transactionId ||
      (operationIds && !operationIds.has(record.operationId)),
  );
  if (records.length === current.records.length) return;
  const appended = await options.ownershipStore.appendPrivateRecord({
    fileName: PROVENANCE_FILE_NAME,
    transactionId: currentRecord.transactionId,
    value: {
      schemaVersion: MOSS_RESOURCE_IMPORT_JOURNAL_SCHEMA_VERSION,
      records,
    },
    ownerId: currentRecord.ownerId,
    projectId: currentRecord.projectId,
    workspaceId: currentRecord.workspaceId,
    principalId: currentRecord.principalId,
    sessionId: currentRecord.sessionId,
    stateFingerprint: currentRecord.stateFingerprint,
    nonce: currentRecord.nonce,
  });
  if (
    appended.transactionId !== currentRecord.transactionId ||
    appended.ownerId !== currentRecord.ownerId ||
    appended.projectId !== currentRecord.projectId ||
    appended.workspaceId !== currentRecord.workspaceId ||
    appended.principalId !== currentRecord.principalId ||
    appended.sessionId !== currentRecord.sessionId ||
    appended.stateFingerprint !== currentRecord.stateFingerprint ||
    appended.nonce !== currentRecord.nonce
  ) {
    throw new MossResourceImportError(
      "transaction-invalid",
      "Private provenance rollback append returned an unverifiable receipt.",
    );
  }
}

async function rollbackChanges(
  cwd: string,
  changes: readonly ChangeRecord[],
  options: ReturnType<typeof importOptions>,
  journal?: TransactionJournal,
  expectedTransactionId?: string,
  snapshotPlan?: MossResourceImportPlan,
): Promise<{
  readonly restored: MossResourceImportOperationResult[];
  readonly issues: MossResourceImportIssue[];
}> {
  const restored: MossResourceImportOperationResult[] = [];
  const issues: MossResourceImportIssue[] = [];
  const filesystemCapability = requireFilesystemCapability(options);
  for (const change of [...changes].reverse()) {
    try {
      const snapshotAuthority = journal
        ? snapshotAuthorityForPlan(
            cwd,
            options,
            journal.planId,
            snapshotPlanNonce(journal.planId),
            change.kind,
            change.operation.snapshotSha256,
          )
        : snapshotPlan
          ? snapshotAuthorityForPlan(
              cwd,
              options,
              snapshotPlan.planId,
              snapshotPlan.nonce,
              change.kind,
              change.operation.snapshotSha256,
            )
          : undefined;
      if (!snapshotAuthority) {
        throw snapshotInvalid("Import rollback lacks snapshot authority binding.");
      }
      const rollbackPlan = journal ?? snapshotPlan;
      if (!rollbackPlan) {
        throw snapshotInvalid("Import rollback lacks an immutable plan binding.");
      }
      const capabilityOperationId = importCapabilityOperationId(
        change.operation,
        rollbackPlan,
        "rollback",
      );
      await assertCanonicalTargetBinding(
        cwd,
        journalChangeFromChange(change),
        options.stateDir,
        snapshotAuthority,
        journal?.state === "committed",
      );
      await assertOwnedImportReceipt(cwd, change, options, journal, expectedTransactionId);
      if (!(await pathExists(change.targetPath))) {
        if (change.stagingPath) {
          await removePrivateStatePath(options.stateDir, change.stagingPath, { recursive: true });
        }
        if (change.markerPath) {
          const marker = await lstatOrNull(change.markerPath);
          if (marker)
            await assertOwnedImportMarker(change.markerPath, change.operation.operationId);
        }
        if (change.receiptPath) {
          await removePrivateStatePath(options.stateDir, change.receiptPath, {
            directorySyncHook: options.directorySyncHook,
          });
        }
        restored.push({
          operationId: change.operation.operationId,
          status: "skipped",
          targetPath: change.targetPath,
          message: "Target was already absent.",
        });
        continue;
      }
      const hashLimits = hashLimitsFor(options);
      if (change.kind === "mcp") {
        if ((await hashPath(change.targetPath, hashLimits)) !== change.afterHash) {
          issues.push(
            issue(
              "rollback-conflict",
              "Canonical MCP config changed after import.",
              undefined,
              [],
              "error",
            ),
          );
          continue;
        }
        const config = await readJsonObject(change.targetPath);
        const servers = recordValue(config?.mcpServers) ?? {};
        if (!Object.prototype.hasOwnProperty.call(servers, change.operation.name)) {
          restored.push({
            operationId: change.operation.operationId,
            status: "skipped",
            targetPath: change.targetPath,
            message: "Imported MCP entry was already absent.",
          });
          continue;
        }
        const nextServers = { ...servers };
        delete nextServers[change.operation.name];
        if (change.beforeConfigExisted === false && Object.keys(nextServers).length === 0) {
          await options.beforeFilesystemMutation?.({
            action: "before-remove",
            path: change.targetPath,
            operationId: change.operation.operationId,
            kind: change.kind,
          });
          await options.beforeFilesystemMutation?.({
            action: "after-hash-before-remove",
            path: change.targetPath,
            operationId: change.operation.operationId,
            kind: change.kind,
          });
          const result = await filesystemCapability.remove({
            cwd,
            targetPath: change.targetPath,
            kind: change.kind,
            ...capabilityAuthority(
              cwd,
              options,
              capabilityOperationId,
              change.afterHash,
              sha256("missing"),
            ),
          });
          assertDurableCapabilityResult(
            result,
            capabilityAuthority(
              cwd,
              options,
              capabilityOperationId,
              change.afterHash,
              sha256("missing"),
            ),
            sha256("missing"),
          );
        } else {
          const rollbackTransactionId =
            journal?.transactionId ??
            expectedTransactionId ??
            `transaction-rollback-${randomUUID()}`;
          const rollbackAuthority: MossPrivateSnapshotAuthority = {
            ...snapshotAuthority,
            transactionId: rollbackTransactionId,
            operationId: capabilityOperationId,
            fencingToken: options.activeFencingToken ?? snapshotAuthority.fencingToken,
            generation: options.activeGeneration ?? snapshotAuthority.generation,
            nonce: options.activeLockNonce ?? snapshotAuthority.nonce,
          };
          const rollbackStage = await options.ownershipStore.createPrivateStage(
            privateStageInput(options, rollbackAuthority),
          );
          const rollbackStagePath = await nodePrivateMutationPayloadPath(rollbackStage);
          const serialized = `${JSON.stringify({ ...(config ?? {}), mcpServers: nextServers }, null, 2)}\n`;
          await ensurePrivateStatePath(options.stateDir, rollbackStagePath);
          await writeFileNoReplaceAtomic(
            rollbackStagePath,
            serialized,
            undefined,
            privateStateParentGuard(options.stateDir, rollbackStagePath),
            { directorySyncHook: options.directorySyncHook },
          );
          try {
            await options.beforeFilesystemMutation?.({
              action: "before-replace",
              path: change.targetPath,
              operationId: change.operation.operationId,
              kind: change.kind,
            });
            await options.beforeFilesystemMutation?.({
              action: "after-lstat-before-publish",
              path: change.targetPath,
              operationId: change.operation.operationId,
              kind: change.kind,
            });
            const result = await filesystemCapability.replace({
              cwd,
              targetPath: change.targetPath,
              stage: rollbackStage,
              kind: change.kind,
              ...capabilityAuthority(
                cwd,
                options,
                capabilityOperationId,
                change.afterHash,
                sha256(new TextEncoder().encode(serialized)),
              ),
            });
            const authority = capabilityAuthority(
              cwd,
              options,
              capabilityOperationId,
              change.afterHash,
              sha256(new TextEncoder().encode(serialized)),
            );
            assertDurableCapabilityResult(
              result,
              authority,
              sha256(new TextEncoder().encode(serialized)),
            );
          } finally {
            await removePrivateStatePath(options.stateDir, rollbackStagePath, {
              directorySyncHook: options.directorySyncHook,
            }).catch(() => undefined);
          }
        }
      } else {
        const marker = change.markerPath ? await lstatOrNull(change.markerPath) : null;
        if (marker?.isSymbolicLink()) {
          throw new MossResourceImportError("symlink-escape", "Rollback marker is a symlink.");
        }
        if (marker && change.markerPath) {
          await assertOwnedImportMarker(change.markerPath, change.operation.operationId);
        }
        if ((await hashPath(change.targetPath, hashLimits)) !== change.afterHash) {
          issues.push(
            issue(
              "rollback-conflict",
              "Canonical target changed after import.",
              undefined,
              [],
              "error",
            ),
          );
          continue;
        }
        await options.beforeFilesystemMutation?.({
          action: "before-remove",
          path: change.targetPath,
          operationId: change.operation.operationId,
          kind: change.kind,
        });
        await options.beforeFilesystemMutation?.({
          action: "after-hash-before-remove",
          path: change.targetPath,
          operationId: change.operation.operationId,
          kind: change.kind,
        });
        const result = await filesystemCapability.remove({
          cwd,
          targetPath: change.targetPath,
          kind: change.kind,
          ...capabilityAuthority(
            cwd,
            options,
            capabilityOperationId,
            change.afterHash,
            sha256("missing"),
          ),
        });
        assertDurableCapabilityResult(
          result,
          capabilityAuthority(
            cwd,
            options,
            capabilityOperationId,
            change.afterHash,
            sha256("missing"),
          ),
          sha256("missing"),
        );
      }
      restored.push({
        operationId: change.operation.operationId,
        status: "skipped",
        targetPath: change.targetPath,
        message: "Import output removed.",
      });
    } catch (cause) {
      issues.push(
        issue(
          "rollback-conflict",
          "Canonical rollback target could not be safely validated.",
          undefined,
          [],
          "error",
        ),
      );
    }
  }
  return { restored, issues };
}

async function writeImmutableStateJsonFile(
  stateRoot: string,
  filePath: string,
  value: unknown,
  options?: Pick<ReturnType<typeof importOptions>, "directorySyncHook">,
): Promise<void> {
  await assertPrivateStatePath(stateRoot, filePath);
  const parentGuard: CanonicalParentGuard = {
    parentPath: nodePath.dirname(filePath),
    assertUnchanged: () => assertPrivateStatePath(stateRoot, filePath),
  };
  await writeFileNoReplaceAtomic(
    filePath,
    `${JSON.stringify(value, null, 2)}\n`,
    undefined,
    parentGuard,
    options?.directorySyncHook ? { directorySyncHook: options.directorySyncHook } : {},
  );
}

async function writeProvenance(
  cwd: string,
  transactionId: string,
  planId: string,
  planHash: string,
  issuer: string,
  ownerId: string,
  sessionId: string,
  workspaceId: string,
  selectionSnapshotSha256: string,
  stateFingerprint: string,
  expiresAt: string,
  changes: readonly ChangeRecord[],
  importedAt: string,
  transactionNonce: string,
  options: Pick<
    ReturnType<typeof importOptions>,
    "directorySyncHook" | "stateDir" | "ownershipStore" | "projectId" | "principalId"
  >,
): Promise<string> {
  const directory = nodePath.resolve(options.stateDir);
  const current = await readProvenance(options.ownershipStore);
  const additions: ProvenanceRecord[] = changes.map((change) => ({
    schemaVersion: MOSS_RESOURCE_IMPORT_JOURNAL_SCHEMA_VERSION,
    transactionId,
    planId,
    planHash,
    selectionSnapshotSha256,
    stateFingerprint,
    stateRoot: directory,
    issuer,
    operationId: change.operation.operationId,
    ownerId,
    projectId: options.projectId ?? workspaceId,
    principalId: options.principalId,
    workspaceId,
    sessionId,
    cwd,
    kind: change.operation.kind,
    provider: change.operation.provider,
    scope: change.operation.scope,
    name: change.operation.name,
    sourcePath: change.operation.sourcePath,
    sourceSha256: change.operation.sourceSha256,
    snapshotPath: change.operation.snapshotPath,
    snapshotSha256: change.operation.snapshotSha256,
    ...(change.operation.sourceVersion ? { sourceVersion: change.operation.sourceVersion } : {}),
    targetPath: change.targetPath,
    targetHash: change.afterHash,
    importedAt,
    canonicalIdentityKey:
      change.operation.canonicalIdentityKey ??
      canonicalIdentityKey({ kind: change.operation.kind, name: change.operation.name }),
    redactedFields: [...change.operation.secretFields],
    ...(change.receiptPath ? { receiptPath: change.receiptPath } : {}),
    ...(change.receiptNonce ? { receiptNonce: change.receiptNonce } : {}),
    expiresAt,
  }));
  const manifest: ProvenanceManifest = {
    schemaVersion: MOSS_RESOURCE_IMPORT_JOURNAL_SCHEMA_VERSION,
    records: [
      ...current.records.filter(
        (record) =>
          !additions.some(
            (addition) =>
              addition.transactionId === record.transactionId &&
              addition.operationId === record.operationId,
          ),
      ),
      ...additions,
    ],
  };
  const appended = await options.ownershipStore.appendPrivateRecord({
    fileName: PROVENANCE_FILE_NAME,
    transactionId,
    value: manifest,
    ownerId,
    projectId: options.projectId ?? workspaceId,
    workspaceId,
    principalId: options.principalId,
    sessionId,
    stateFingerprint,
    nonce: transactionNonce,
  });
  if (
    appended.transactionId !== transactionId ||
    appended.ownerId !== ownerId ||
    appended.projectId !== (options.projectId ?? workspaceId) ||
    appended.workspaceId !== workspaceId ||
    appended.principalId !== options.principalId ||
    appended.sessionId !== sessionId ||
    appended.stateFingerprint !== stateFingerprint ||
    appended.nonce !== transactionNonce
  ) {
    throw new MossResourceImportError(
      "transaction-invalid",
      "Private import provenance append returned an unverifiable receipt.",
    );
  }
  // The server keeps the authoritative manifest private. RPC results expose
  // only an opaque locator, never an absolute local state path.
  return "server-state://resource-import/provenance.json";
}

const JOURNAL_GENESIS_HASH = sha256("moss-resource-import:journal:v3:genesis");

function journalRecordHash(journal: Omit<TransactionJournal, "recordHash">): string {
  return privateManifestRecordHash({
    transactionId: journal.transactionId,
    sequence: journal.sequence,
    previousHash: journal.previousHash,
    value: journal,
  });
}

function appendJournalRecord(
  journal: TransactionJournal,
  patch: Pick<TransactionJournal, "state" | "updatedAt">,
): TransactionJournal {
  const { recordHash: _recordHash, ...withoutRecordHash } = journal;
  const next = {
    ...withoutRecordHash,
    ...patch,
    sequence: journal.sequence + 1,
    previousHash: journal.recordHash,
  } satisfies Omit<TransactionJournal, "recordHash">;
  return { ...next, recordHash: journalRecordHash(next) };
}

async function writeJournal(
  cwd: string,
  journal: TransactionJournal,
  options: Pick<ReturnType<typeof importOptions>, "stateDir" | "ownershipStore">,
): Promise<TransactionJournal> {
  const directory = nodePath.join(journal.stateRoot, TRANSACTIONS_DIR_NAME);
  const baseName = `${journal.transactionId}.json`;
  const path = nodePath.join(directory, baseName);
  const decoded = Schema.decodeUnknownSync(MossResourceImportJournalSchema)(journal);
  const appended = await options.ownershipStore.appendPrivateRecord({
    fileName: nodePath.relative(journal.stateRoot, path),
    transactionId: journal.transactionId,
    value: privateRecordTemplate(decoded),
    ownerId: journal.ownerId,
    projectId: journal.projectId,
    workspaceId: journal.workspaceId,
    principalId: journal.principalId,
    sessionId: journal.sessionId,
    stateFingerprint: journal.stateFingerprint,
    nonce: journal.nonce,
  });
  if (
    appended.transactionId !== journal.transactionId ||
    appended.ownerId !== journal.ownerId ||
    appended.projectId !== journal.projectId ||
    appended.workspaceId !== journal.workspaceId ||
    appended.principalId !== journal.principalId ||
    appended.sessionId !== journal.sessionId ||
    appended.stateFingerprint !== journal.stateFingerprint ||
    appended.nonce !== journal.nonce
  ) {
    throw new MossResourceImportError(
      "transaction-invalid",
      "Private journal append returned an unverifiable receipt.",
    );
  }
  let persisted: TransactionJournal;
  try {
    persisted = Schema.decodeUnknownSync(MossResourceImportJournalSchema)({
      ...recordValue(appended.value),
      sequence: appended.sequence,
      previousHash: appended.previousHash,
      recordHash: appended.recordHash,
    });
  } catch {
    throw new MossResourceImportError(
      "transaction-invalid",
      "Private journal append returned an invalid journal value.",
    );
  }
  const { recordHash: _recordHash, ...withoutRecordHash } = persisted;
  if (
    persisted.transactionId !== journal.transactionId ||
    persisted.stateRoot !== journal.stateRoot ||
    persisted.sessionId !== journal.sessionId ||
    persisted.projectId !== journal.projectId ||
    persisted.principalId !== journal.principalId ||
    persisted.recordHash !== journalRecordHash(withoutRecordHash)
  ) {
    throw new MossResourceImportError(
      "transaction-invalid",
      "Private journal append returned an unverifiable chain record.",
    );
  }
  return persisted;
}

async function readJournal(
  _cwd: string,
  transactionId: string,
  stateRoot: string,
  ownershipStore: MossOwnershipStore,
): Promise<TransactionJournal | null> {
  const record = await ownershipStore.readPrivateRecord({
    fileName: `${TRANSACTIONS_DIR_NAME}/${transactionId}.json`,
  });
  if (!record) return null;
  try {
    const journal = Schema.decodeUnknownSync(MossResourceImportJournalSchema)({
      ...recordValue(record.value),
      sequence: record.sequence,
      previousHash: record.previousHash,
      recordHash: record.recordHash,
    });
    const { recordHash: _recordHash, ...withoutRecordHash } = journal;
    if (
      journal.transactionId !== transactionId ||
      journal.sequence !== record.sequence ||
      journal.stateRoot !== nodePath.resolve(stateRoot) ||
      journal.previousHash !== record.previousHash ||
      journal.recordHash !== record.recordHash ||
      journal.recordHash !== journalRecordHash(withoutRecordHash)
    ) {
      throw new MossResourceImportError(
        "transaction-invalid",
        "Import transaction journal hash chain is invalid.",
      );
    }
    if (
      record.ownerId !== journal.ownerId ||
      record.projectId !== journal.projectId ||
      record.workspaceId !== journal.workspaceId ||
      record.principalId !== journal.principalId ||
      record.sessionId !== journal.sessionId ||
      record.stateFingerprint !== journal.stateFingerprint ||
      record.nonce !== journal.nonce
    ) {
      throw new MossResourceImportError(
        "authorization-required",
        "Import transaction private record authority does not match.",
      );
    }
    return journal;
  } catch (error) {
    if (error instanceof MossResourceImportError) throw error;
    throw new MossResourceImportError(
      "transaction-invalid",
      "Import transaction failed strict schema validation.",
    );
  }
}

async function writeImportReceipt(
  cwd: string,
  journal: TransactionJournal,
  operation: MossResourceImportOperation,
  beforeHash: string,
  receiptPath: string,
  receiptNonce: string,
  options: ReturnType<typeof importOptions>,
): Promise<void> {
  const receipt: ImportReceipt = {
    schemaVersion: MOSS_RESOURCE_IMPORT_JOURNAL_SCHEMA_VERSION,
    transactionId: journal.transactionId,
    operationId: operation.operationId,
    issuer: journal.issuer,
    ownerId: journal.ownerId,
    projectId: journal.projectId,
    principalId: journal.principalId,
    sessionId: journal.sessionId,
    workspaceId: journal.workspaceId,
    cwd: journal.cwd,
    canonicalRoot: journal.canonicalRoot,
    stateFingerprint: journal.stateFingerprint,
    stateRoot: journal.stateRoot,
    nonce: journal.nonce,
    receiptNonce,
    expiresAt: journal.expiresAt,
    kind: operation.kind,
    canonicalIdentityKey:
      operation.canonicalIdentityKey ??
      canonicalIdentityKey({ kind: operation.kind, name: operation.name }),
    snapshotPath: operation.snapshotPath,
    snapshotSha256: operation.snapshotSha256,
    targetPath: operation.targetPath,
    beforeHash,
  };
  const decoded = Schema.decodeUnknownSync(MossResourceImportReceiptSchema)(receipt);
  await ensurePrivateStatePath(journal.stateRoot, receiptPath);
  const fileName = nodePath.relative(journal.stateRoot, receiptPath);
  const appended = await options.ownershipStore.appendPrivateRecord({
    fileName,
    transactionId: journal.transactionId,
    value: decoded,
    ownerId: journal.ownerId,
    projectId: journal.projectId,
    workspaceId: journal.workspaceId,
    principalId: journal.principalId,
    sessionId: journal.sessionId,
    stateFingerprint: journal.stateFingerprint,
    nonce: journal.nonce,
  });
  if (
    appended.transactionId !== journal.transactionId ||
    appended.ownerId !== journal.ownerId ||
    appended.projectId !== journal.projectId ||
    appended.workspaceId !== journal.workspaceId ||
    appended.principalId !== journal.principalId ||
    appended.sessionId !== journal.sessionId ||
    appended.stateFingerprint !== journal.stateFingerprint ||
    appended.nonce !== journal.nonce ||
    appended.sequence !== 0
  ) {
    throw new MossResourceImportError(
      "transaction-invalid",
      "Private import receipt append returned an unverifiable receipt.",
    );
  }
}

async function assertOwnedImportReceipt(
  cwd: string,
  change: ChangeRecord,
  options: ReturnType<typeof importOptions>,
  journal?: TransactionJournal,
  expectedTransactionId?: string,
): Promise<void> {
  if (!change.receiptPath || !change.receiptNonce) {
    throw new MossResourceImportError(
      "transaction-invalid",
      "Import receipt binding is incomplete.",
    );
  }
  await assertPrivateStatePath(options.stateDir, change.receiptPath);
  const fileName = nodePath.relative(options.stateDir, change.receiptPath);
  const record = await options.ownershipStore.readPrivateRecord({ fileName });
  if (!record)
    throw new MossResourceImportError("transaction-invalid", "Import receipt is missing.");
  let receipt: ImportReceipt;
  try {
    receipt = Schema.decodeUnknownSync(MossResourceImportReceiptSchema)(record.value);
  } catch {
    throw new MossResourceImportError(
      "transaction-invalid",
      "Import receipt failed strict validation.",
    );
  }
  if (
    receipt.transactionId !==
      (journal?.transactionId ?? expectedTransactionId ?? receipt.transactionId) ||
    receipt.operationId !== change.operation.operationId ||
    receipt.receiptNonce !== change.receiptNonce ||
    receipt.beforeHash !== change.beforeHash ||
    receipt.issuer !== (journal?.issuer ?? options.issuer) ||
    receipt.ownerId !== (journal?.ownerId ?? options.ownerId) ||
    receipt.projectId !== (journal?.projectId ?? options.projectId ?? workspaceBindingId(cwd)) ||
    receipt.principalId !== (journal?.principalId ?? options.principalId) ||
    receipt.sessionId !== (journal?.sessionId ?? options.sessionId) ||
    receipt.workspaceId !== (journal?.workspaceId ?? options.workspaceId) ||
    receipt.canonicalRoot !== nodePath.resolve(getMossSourceLayout(cwd).root) ||
    receipt.cwd !== cwd ||
    receipt.snapshotPath !== change.operation.snapshotPath ||
    receipt.snapshotSha256 !== change.operation.snapshotSha256 ||
    receipt.stateRoot !== options.stateDir ||
    receipt.targetPath !== change.targetPath ||
    receipt.canonicalIdentityKey !==
      (change.operation.canonicalIdentityKey ??
        canonicalIdentityKey({ kind: change.operation.kind, name: change.operation.name })) ||
    (journal &&
      (receipt.ownerId !== journal.ownerId ||
        receipt.workspaceId !== journal.workspaceId ||
        receipt.stateFingerprint !== journal.stateFingerprint ||
        receipt.nonce !== journal.nonce ||
        receipt.expiresAt !== journal.expiresAt))
  ) {
    throw new MossResourceImportError(
      "transaction-invalid",
      "Import receipt binding does not match.",
    );
  }
  if (isExpired(receipt.expiresAt, options.now())) {
    throw new MossResourceImportError("transaction-expired", "Import receipt has expired.");
  }
  if (nodePath.resolve(receipt.cwd) !== nodePath.resolve(cwd)) {
    throw new MossResourceImportError(
      "authorization-required",
      "Import receipt workspace does not match.",
    );
  }
}

function assertSafeTransactionId(transactionId: string): void {
  if (!/^transaction-[A-Za-z0-9-]+$/.test(transactionId)) {
    throw new MossResourceImportError(
      "path-traversal",
      `Import transaction id is not a safe journal name: ${transactionId}`,
    );
  }
}

function journalChangeFromChange(
  change: ChangeRecord,
  stagingPath = change.stagingPath,
  markerPath = change.markerPath,
): MossResourceImportJournalChange {
  return {
    operationId: change.operation.operationId,
    phase: "applied",
    kind: change.operation.kind,
    provider: change.operation.provider,
    scope: change.operation.scope,
    name: change.operation.name,
    canonicalIdentityKey:
      change.operation.canonicalIdentityKey ??
      canonicalIdentityKey({ kind: change.operation.kind, name: change.operation.name }),
    sourcePath: change.operation.sourcePath,
    ...(change.operation.sourceSelector ? { sourceSelector: change.operation.sourceSelector } : {}),
    sourceSha256: change.operation.sourceSha256,
    snapshotPath: change.operation.snapshotPath,
    snapshotSha256: change.operation.snapshotSha256,
    ...(change.operation.sourceVersion ? { sourceVersion: change.operation.sourceVersion } : {}),
    targetPath: change.targetPath,
    beforeHash: change.beforeHash,
    ...(stagingPath ? { stagingPath } : {}),
    ...(markerPath ? { markerPath } : {}),
    ...(change.receiptPath ? { receiptPath: change.receiptPath } : {}),
    ...(change.receiptNonce ? { receiptNonce: change.receiptNonce } : {}),
    afterHash: change.afterHash,
    ...(change.beforeConfigExisted !== undefined
      ? { beforeConfigExisted: change.beforeConfigExisted }
      : {}),
  };
}

function journalIntentFromOperation(input: {
  readonly operation: MossResourceImportOperation;
  readonly beforeHash: string;
  readonly stagingPath: string;
  readonly markerPath?: string;
  readonly receiptPath: string;
  readonly receiptNonce: string;
  readonly expectedHash?: string;
}): MossResourceImportJournalChange {
  const { operation } = input;
  return {
    operationId: operation.operationId,
    phase: "intent",
    kind: operation.kind,
    provider: operation.provider,
    scope: operation.scope,
    name: operation.name,
    canonicalIdentityKey:
      operation.canonicalIdentityKey ??
      canonicalIdentityKey({ kind: operation.kind, name: operation.name }),
    sourcePath: operation.sourcePath,
    ...(operation.sourceSelector ? { sourceSelector: operation.sourceSelector } : {}),
    sourceSha256: operation.sourceSha256,
    snapshotPath: operation.snapshotPath,
    snapshotSha256: operation.snapshotSha256,
    ...(operation.sourceVersion ? { sourceVersion: operation.sourceVersion } : {}),
    targetPath: operation.targetPath,
    beforeHash: input.beforeHash,
    ...(input.expectedHash ? { expectedHash: input.expectedHash } : {}),
    stagingPath: input.stagingPath,
    ...(input.markerPath ? { markerPath: input.markerPath } : {}),
    receiptPath: input.receiptPath,
    receiptNonce: input.receiptNonce,
  };
}

function operationFromJournal(
  change: MossResourceImportJournalChange,
): MossResourceImportOperation {
  return {
    operationId: change.operationId,
    resourceId: change.operationId,
    kind: change.kind,
    provider: change.provider,
    scope: change.scope,
    name: change.name,
    sourcePath: change.sourcePath,
    ...(change.sourceSelector ? { sourceSelector: change.sourceSelector } : {}),
    sourceSha256: change.sourceSha256,
    snapshotPath: change.snapshotPath,
    snapshotSha256: change.snapshotSha256,
    ...(change.sourceVersion ? { sourceVersion: change.sourceVersion } : {}),
    targetPath: change.targetPath,
    action: change.kind === "mcp" ? "merge" : "copy",
    secretFields: [],
    warnings: [],
    canonicalIdentityKey: change.canonicalIdentityKey,
    enabled: change.kind === "skill",
    quarantined: change.kind !== "skill",
  };
}

function changeFromJournal(change: MossResourceImportJournalChange): ChangeRecord | null {
  const afterHash = change.afterHash ?? change.expectedHash;
  if (afterHash === undefined) return null;
  return {
    operation: operationFromJournal(change),
    targetPath: change.targetPath,
    kind: change.kind,
    beforeHash: change.beforeHash,
    afterHash,
    ...(change.beforeConfigExisted !== undefined
      ? { beforeConfigExisted: change.beforeConfigExisted }
      : {}),
    ...(change.stagingPath ? { stagingPath: change.stagingPath } : {}),
    ...(change.markerPath ? { markerPath: change.markerPath } : {}),
    ...(change.receiptPath ? { receiptPath: change.receiptPath } : {}),
    ...(change.receiptNonce ? { receiptNonce: change.receiptNonce } : {}),
  };
}

async function assertCanonicalTargetBinding(
  cwd: string,
  change: MossResourceImportJournalChange,
  stateRoot: string,
  snapshotAuthority: MossPrivateSnapshotAuthority,
  allowCleanedStagingPath = false,
): Promise<void> {
  const expected = canonicalTarget(
    {
      id: change.operationId,
      kind: change.kind,
      provider: change.provider,
      scope: change.scope,
      name: change.name,
      sourcePath: change.sourcePath,
      sourceSha256: change.sourceSha256,
      sizeBytes: 0,
      format:
        change.kind === "skill" ? "markdown" : change.kind === "plugin" ? "directory" : "json",
      secretFields: [],
      warnings: [],
      canonicalIdentityKey: change.canonicalIdentityKey,
    },
    cwd,
  );
  const root = nodePath.resolve(getMossSourceLayout(cwd).root);
  const rootStat = await lstatOrNull(root);
  if (rootStat?.isSymbolicLink()) {
    throw new MossResourceImportError("symlink-escape", "Canonical Moss root is a symlink.");
  }
  const rootReal = await fs.realpath(root).catch(() => root);
  const target = nodePath.resolve(change.targetPath);
  const expectedKind =
    change.kind === "mcp" ? "mcp" : change.kind === "skill" ? "file" : "directory";
  if (!isWithin(root, target, false)) {
    throw new MossResourceImportError(
      "path-traversal",
      "Import journal target leaves the Moss root.",
    );
  }
  if (expected.path !== target || expected.kind !== expectedKind) {
    throw new MossResourceImportError(
      "transaction-invalid",
      "Import journal target is not canonical.",
    );
  }
  const targetStat = await lstatOrNull(target);
  if (targetStat?.isSymbolicLink()) {
    throw new MossResourceImportError("symlink-escape", "Import journal target is a symlink.");
  }
  const parentReal = await realpathNearestExisting(nodePath.dirname(target));
  if (!isWithin(rootReal, parentReal, false)) {
    throw new MossResourceImportError(
      "path-traversal",
      "Import journal target leaves the Moss root.",
    );
  }
  for (const auxiliaryPath of [change.stagingPath, change.markerPath]) {
    if (auxiliaryPath === undefined) continue;
    const resolved = nodePath.resolve(auxiliaryPath);
    const isPrivateStage = auxiliaryPath === change.stagingPath;
    if (isPrivateStage) {
      if (!isWithin(nodePath.resolve(stateRoot), resolved, false)) {
        throw new MossResourceImportError(
          "path-traversal",
          "Import journal staging leaves server state.",
        );
      }
      if (allowCleanedStagingPath) {
        await assertCleanedPrivateStatePath(stateRoot, resolved);
      } else {
        await assertPrivateStatePath(stateRoot, resolved);
      }
    } else {
      if (!isWithin(root, resolved, false)) {
        throw new MossResourceImportError(
          "path-traversal",
          "Import journal marker leaves the Moss root.",
        );
      }
      if (nodePath.dirname(resolved) !== target) {
        throw new MossResourceImportError(
          "path-traversal",
          "Import journal marker is not inside its plugin target.",
        );
      }
    }
    const auxiliaryStat = await lstatOrNull(resolved);
    if (auxiliaryStat?.isSymbolicLink()) {
      throw new MossResourceImportError(
        "symlink-escape",
        "Import journal staging path is a symlink.",
      );
    }
    const auxiliaryParent = await realpathNearestExisting(nodePath.dirname(resolved));
    const allowedParent = isPrivateStage ? await fs.realpath(stateRoot) : rootReal;
    if (!isWithin(allowedParent, auxiliaryParent, false)) {
      throw new MossResourceImportError(
        "path-traversal",
        "Import journal auxiliary path leaves its owner root.",
      );
    }
  }
  if (change.receiptPath !== undefined) {
    const receiptsRoot = nodePath.resolve(nodePath.join(stateRoot, RECEIPTS_DIR_NAME));
    const receiptPath = nodePath.resolve(change.receiptPath);
    if (
      !isWithin(receiptsRoot, receiptPath, false) ||
      !/^transaction-[A-Za-z0-9-]+-[A-Za-z0-9-]+\.json$/.test(nodePath.basename(receiptPath))
    ) {
      throw new MossResourceImportError(
        "path-traversal",
        "Import receipt leaves the server-owned state.",
      );
    }
    await assertPrivateStatePath(stateRoot, receiptPath);
    const receiptParent = await realpathNearestExisting(nodePath.dirname(receiptPath));
    if (!isWithin(await fs.realpath(stateRoot), receiptParent, false)) {
      throw new MossResourceImportError(
        "path-traversal",
        "Import receipt leaves the server-owned state.",
      );
    }
    const receiptStat = await lstatOrNull(receiptPath);
    if (receiptStat?.isSymbolicLink()) {
      throw new MossResourceImportError("symlink-escape", "Import receipt is a symlink.");
    }
  }
  await assertSnapshotBinding(cwd, operationFromJournal(change), snapshotAuthority);
}

async function assertJournalBinding(
  cwd: string,
  journal: TransactionJournal,
  options: ReturnType<typeof importOptions>,
  allowMissingProvenance = false,
): Promise<void> {
  const workspaceId = options.workspaceId ?? workspaceBindingId(cwd);
  if (
    journal.cwd !== cwd ||
    journal.issuer !== options.issuer ||
    journal.ownerId !== options.ownerId ||
    journal.projectId !== (options.projectId ?? workspaceId) ||
    journal.principalId !== options.principalId ||
    journal.sessionId !== options.sessionId ||
    journal.workspaceId !== workspaceId ||
    journal.canonicalRoot !== nodePath.resolve(getMossSourceLayout(cwd).root) ||
    journal.stateRoot !== options.stateDir
  ) {
    throw new MossResourceImportError(
      "authorization-required",
      "Import journal binding does not match.",
    );
  }
  if (isExpired(journal.expiresAt, options.now())) {
    throw new MossResourceImportError(
      "transaction-expired",
      "Import transaction receipt has expired.",
    );
  }
  if (
    journal.stateFingerprint !==
    importStateFingerprint(
      cwd,
      journal.workspaceId,
      journal.selectionSnapshotSha256,
      journal.stateRoot,
    )
  ) {
    throw new MossResourceImportError(
      "transaction-invalid",
      "Import transaction state fingerprint is invalid.",
    );
  }
  for (const change of journal.changes) {
    await assertCanonicalTargetBinding(
      cwd,
      change,
      options.stateDir,
      snapshotAuthorityForPlan(
        cwd,
        options,
        journal.planId,
        snapshotPlanNonce(journal.planId),
        change.kind,
        change.snapshotSha256,
      ),
      journal.state === "committed",
    );
  }
  const provenance = await readProvenance(options.ownershipStore);
  for (const change of journal.changes) {
    if (change.phase === "intent") continue;
    if (change.afterHash === undefined) {
      throw new MossResourceImportError(
        "transaction-invalid",
        "Applied journal change is missing its committed hash.",
      );
    }
    const record = provenance.records.find(
      (candidate) =>
        candidate.transactionId === journal.transactionId &&
        candidate.planId === journal.planId &&
        candidate.planHash === journal.planHash &&
        candidate.selectionSnapshotSha256 === journal.selectionSnapshotSha256 &&
        candidate.stateFingerprint === journal.stateFingerprint &&
        candidate.stateRoot === journal.stateRoot &&
        candidate.issuer === journal.issuer &&
        candidate.operationId === change.operationId &&
        candidate.ownerId === journal.ownerId &&
        candidate.projectId === journal.projectId &&
        candidate.principalId === journal.principalId &&
        candidate.workspaceId === journal.workspaceId &&
        candidate.sessionId === journal.sessionId &&
        candidate.cwd === journal.cwd &&
        candidate.kind === change.kind &&
        candidate.provider === change.provider &&
        candidate.scope === change.scope &&
        candidate.name === change.name &&
        candidate.canonicalIdentityKey === change.canonicalIdentityKey &&
        candidate.sourcePath === change.sourcePath &&
        candidate.sourceSelector === change.sourceSelector &&
        candidate.sourceSha256 === change.sourceSha256 &&
        candidate.snapshotPath === change.snapshotPath &&
        candidate.snapshotSha256 === change.snapshotSha256 &&
        candidate.sourceVersion === change.sourceVersion &&
        candidate.targetPath === change.targetPath &&
        candidate.receiptPath === change.receiptPath &&
        candidate.receiptNonce === change.receiptNonce &&
        candidate.expiresAt === journal.expiresAt &&
        candidate.targetHash === change.afterHash,
    );
    if (!record && !allowMissingProvenance) {
      throw new MossResourceImportError(
        "transaction-invalid",
        "Import provenance does not match the transaction journal.",
      );
    }
  }
}

function operationResult(
  operation: MossResourceImportOperation,
  status: MossResourceImportOperationResult["status"],
  message?: string,
): MossResourceImportOperationResult {
  return {
    operationId: operation.operationId,
    status,
    targetPath: operation.targetPath,
    ...(message ? { message: message.slice(0, 1_000) } : {}),
  };
}

function applyIssue(cause: unknown): MossResourceImportIssue {
  if (cause instanceof MossResourceImportError) {
    const messages: Partial<Record<MossResourceImportIssueCode, string>> = {
      "stale-source": "The selected source changed after planning.",
      "plan-invalid": "The import plan is not bound to the current workspace state.",
      "secret-fields": "The resource contains a literal secret or unsafe field.",
      "symlink-escape": "The import path crossed a symlink boundary.",
      "path-traversal": "The import path is outside the allowed workspace boundary.",
      "transaction-invalid": "The import transaction failed strict validation.",
      "recovery-needed": "The import transaction needs safe recovery.",
      "concurrent-modification": "The canonical resource changed during import.",
      "durability-unsupported": "Filesystem durability could not be confirmed.",
      "invalid-identity": "The resource name cannot produce a safe canonical identity.",
      "snapshot-invalid": "The server-owned snapshot seal is invalid.",
    };
    return issue(
      cause.code,
      messages[cause.code] ?? "The resource import operation was rejected.",
      undefined,
      [],
      cause.code === "copy-failed" || cause.code === "durability-unsupported" ? "error" : "warning",
    );
  }
  return issue(
    "copy-failed",
    "The resource import operation failed due to an unexpected filesystem error.",
    undefined,
    [],
    "error",
  );
}

function assertMutationAuthorized(options: ReturnType<typeof importOptions>): void {
  if (!options.requireOwner) return;
  if (!options.authorizedWorkspace || !options.workspaceId) {
    throw new MossResourceImportError(
      "authorization-required",
      "Owner authorization and a registered workspace binding are required.",
    );
  }
}

function requireFilesystemCapability(
  options: ReturnType<typeof importOptions>,
): MossFilesystemCapability {
  if (!options.filesystemCapability) {
    throw new MossResourceImportError(
      "durability-unsupported",
      "A native canonical filesystem capability is required for resource mutation.",
    );
  }
  return options.filesystemCapability;
}

function canonicalRootDescriptor(
  cwd: string,
  options: ReturnType<typeof importOptions>,
): MossCanonicalRootDescriptor {
  const rootPath = nodePath.resolve(getMossSourceLayout(cwd).root);
  return {
    rootPath,
    // This is an identity fingerprint for the descriptor, not a signature or
    // authorization token. The native capability must independently validate
    // the opened root and return the observed durable fingerprint.
    identityFingerprint: sha256(rootPath),
    projectId: options.projectId ?? options.workspaceId ?? workspaceBindingId(cwd),
    workspaceId: options.workspaceId ?? workspaceBindingId(cwd),
    ownerId: options.ownerId,
    principalId: options.principalId,
    sessionId: options.sessionId,
  };
}

interface CapabilityAuthority {
  readonly canonicalRoot: MossCanonicalRootDescriptor;
  readonly ownerId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly operationId: string;
  readonly fencingToken: string;
  readonly generation: string;
  readonly nonce: string;
  readonly expectedFingerprint: string;
  readonly expectedBeforeHash: string;
  readonly expected: MossFilesystemIdentity;
  readonly expectedAfterHash?: string;
  readonly expectedAfter?: MossFilesystemIdentity;
}

function capabilityAuthority(
  cwd: string,
  options: ReturnType<typeof importOptions>,
  operationId: string,
  expectedBeforeHash: string,
  expectedAfterHash?: string,
): CapabilityAuthority {
  const canonicalRoot = canonicalRootDescriptor(cwd, options);
  if (!options.activeFencingToken || !options.activeGeneration || !options.activeLockNonce) {
    throw new MossResourceImportError(
      "durability-unsupported",
      "A fenced ownership lock is required before canonical capability use.",
    );
  }
  return {
    canonicalRoot,
    ownerId: options.ownerId,
    projectId: canonicalRoot.projectId,
    workspaceId: canonicalRoot.workspaceId,
    principalId: canonicalRoot.principalId,
    sessionId: options.sessionId,
    operationId,
    fencingToken: options.activeFencingToken,
    generation: options.activeGeneration,
    nonce: options.activeLockNonce,
    expectedFingerprint: canonicalRoot.identityFingerprint,
    expectedBeforeHash,
    expected: {
      identityFingerprint: canonicalRoot.identityFingerprint,
      hash: expectedBeforeHash,
    },
    ...(expectedAfterHash !== undefined
      ? {
          expectedAfterHash,
          expectedAfter: {
            identityFingerprint: canonicalRoot.identityFingerprint,
            hash: expectedAfterHash,
          },
        }
      : {}),
  };
}

function importCapabilityOperationId(
  operation: MossResourceImportOperation,
  plan: Pick<
    MossResourceImportPlan,
    | "planId"
    | "planHash"
    | "selectionTicketDigest"
    | "issuer"
    | "ownerId"
    | "projectId"
    | "principalId"
    | "sessionId"
    | "workspaceId"
  >,
  purpose: "apply" | "rollback" = "apply",
): string {
  return deriveMossResourceImportMutationKey({
    planId: plan.planId,
    planHash: plan.planHash,
    operationId: operation.operationId,
    targetPath: operation.targetPath,
    action: purpose === "rollback" ? `rollback:${operation.action}` : operation.action,
    ownerId: plan.ownerId,
    projectId: plan.projectId,
    workspaceId: plan.workspaceId,
    principalId: plan.principalId,
    sessionId: plan.sessionId,
    issuer: plan.issuer,
    ...(plan.selectionTicketDigest ? { selectionTicketDigest: plan.selectionTicketDigest } : {}),
  });
}

function assertDurableCapabilityResult(
  result: MossFilesystemCapabilityResult,
  authority: CapabilityAuthority,
  expectedAfterHash?: string,
): string {
  if (
    result.receipt.canonicalRoot.rootPath !== authority.canonicalRoot.rootPath ||
    result.receipt.canonicalRoot.identityFingerprint !==
      authority.canonicalRoot.identityFingerprint ||
    result.receipt.canonicalRoot.projectId !== authority.projectId ||
    result.receipt.canonicalRoot.workspaceId !== authority.workspaceId ||
    (authority.canonicalRoot.ownerId !== undefined &&
      result.receipt.canonicalRoot.ownerId !== authority.canonicalRoot.ownerId) ||
    result.receipt.canonicalRoot.principalId !== authority.principalId ||
    (authority.canonicalRoot.ownerId !== undefined &&
      result.receipt.ownerId !== authority.canonicalRoot.ownerId) ||
    result.receipt.projectId !== authority.projectId ||
    result.receipt.workspaceId !== authority.workspaceId ||
    result.receipt.principalId !== authority.principalId ||
    result.receipt.sessionId !== authority.sessionId ||
    result.receipt.canonicalRoot.sessionId !== authority.sessionId ||
    result.receipt.operationId !== authority.operationId ||
    result.receipt.fencingToken !== authority.fencingToken ||
    result.receipt.generation !== authority.generation ||
    result.receipt.nonce !== authority.nonce ||
    result.receipt.expected.identityFingerprint !== authority.expected.identityFingerprint ||
    result.receipt.expected.hash !== authority.expected.hash ||
    result.receipt.afterHash !== result.afterHash ||
    result.receipt.durableObservedFingerprint !== result.durableObservedFingerprint ||
    result.observed.identityFingerprint !== result.durableObservedFingerprint ||
    result.observed.hash !== result.afterHash ||
    result.receipt.observed.identityFingerprint !== result.observed.identityFingerprint ||
    result.receipt.observed.hash !== result.observed.hash ||
    result.receipt.durable !== true
  ) {
    throw new MossResourceImportError(
      "transaction-invalid",
      "Native filesystem capability returned an unverifiable durability receipt.",
    );
  }
  if (
    expectedAfterHash !== undefined &&
    (result.afterHash !== expectedAfterHash ||
      result.observed.hash !== expectedAfterHash ||
      result.receipt.observed.hash !== expectedAfterHash ||
      result.receipt.expectedAfter?.hash !== expectedAfterHash ||
      result.receipt.expectedAfter?.identityFingerprint !==
        authority.canonicalRoot.identityFingerprint)
  ) {
    throw new MossResourceImportError(
      "concurrent-modification",
      "Native filesystem capability observed an unexpected canonical result.",
    );
  }
  return result.afterHash;
}

function transactionJournal(input: {
  readonly transactionId: string;
  readonly plan: MossResourceImportPlan;
  readonly cwd: string;
  readonly ownerId: string;
  readonly projectId: string;
  readonly principalId: string;
  readonly workspaceId: string;
  readonly stateRoot: string;
  readonly selectionSnapshotSha256: string;
  readonly selectionTicketDigest?: string;
  readonly transactionNonce: string;
  readonly previousHash: string;
  readonly sequence: number;
  readonly state: MossResourceImportTransactionState;
  readonly changes: readonly ChangeRecord[];
  readonly journalChanges?: readonly MossResourceImportJournalChange[];
  readonly createdAt: string;
  readonly updatedAt: string;
}): TransactionJournal {
  const withoutRecordHash = {
    schemaVersion: MOSS_RESOURCE_IMPORT_JOURNAL_SCHEMA_VERSION,
    transactionId: input.transactionId,
    planId: input.plan.planId,
    issuer: input.plan.issuer,
    ownerId: input.ownerId,
    projectId: input.projectId,
    principalId: input.principalId,
    sessionId: input.plan.sessionId,
    workspaceId: input.workspaceId,
    cwd: input.cwd,
    canonicalRoot: nodePath.resolve(getMossSourceLayout(input.cwd).root),
    planHash: input.plan.planHash,
    selectionSnapshotSha256: input.selectionSnapshotSha256,
    ...(input.selectionTicketDigest ? { selectionTicketDigest: input.selectionTicketDigest } : {}),
    stateFingerprint: input.plan.stateFingerprint,
    stateRoot: input.stateRoot,
    nonce: input.transactionNonce,
    previousHash: input.previousHash,
    expiresAt: input.plan.expiresAt,
    sequence: input.sequence,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    state: input.state,
    changes: input.journalChanges ?? input.changes.map((change) => journalChangeFromChange(change)),
  } satisfies Omit<TransactionJournal, "recordHash">;
  return { ...withoutRecordHash, recordHash: journalRecordHash(withoutRecordHash) };
}

function replayCommittedImportResult(
  plan: MossResourceImportPlan,
  journal: TransactionJournal,
): MossResourceImportApplyResult {
  const applied = new Map(journal.changes.map((change) => [change.operationId, change]));
  const operations = plan.operations.map((operation) => {
    const change = applied.get(operation.operationId);
    if (change) {
      return operationResult(operation, operation.kind === "mcp" ? "merged" : "created");
    }
    if (operation.action === "skip") {
      return operationResult(operation, "skipped", "Already imported from the same source SHA.");
    }
    if (operation.action === "conflict") {
      return operationResult(operation, "conflict", "Canonical target already exists.");
    }
    if (operation.action === "blocked") {
      return operationResult(operation, "blocked", "Resource is blocked by the immutable plan.");
    }
    return operationResult(
      operation,
      "failed",
      "Committed journal is missing an operation intent.",
    );
  });
  const durableAfterState = journal.changes.map((change) => ({
    operationId: change.operationId,
    targetPath: change.targetPath,
    state: "present" as const,
    afterHash: change.afterHash ?? change.expectedHash ?? sha256("missing"),
    durable: true as const,
  }));
  return {
    transactionId: journal.transactionId,
    planId: plan.planId,
    status: "committed",
    operations,
    ...(journal.changes.length > 0
      ? {
          provenancePath: "server-state://resource-import/provenance.json",
          receipt: {
            transactionId: journal.transactionId,
            operationId: journal.transactionId,
            planHash: plan.planHash,
            afterState: durableAfterState,
          },
        }
      : {}),
    issues: [],
  };
}

async function recoverPendingTransactions(
  cwd: string,
  options: ReturnType<typeof importOptions>,
): Promise<void> {
  const recordNames = await options.ownershipStore.listPrivateRecords({
    prefix: TRANSACTIONS_DIR_NAME,
  });
  for (const recordName of recordNames) {
    if (!/^transactions\/transaction-[A-Za-z0-9-]+\.json$/.test(recordName)) continue;
    const transactionId = nodePath.basename(recordName, ".json");
    const journal = await readJournal(cwd, transactionId, options.stateDir, options.ownershipStore);
    if (
      !journal ||
      !["prepared", "applying", "rolling-back", "recovery-needed"].includes(journal.state)
    ) {
      continue;
    }
    await assertJournalBinding(cwd, journal, options, true);
    const changes: ChangeRecord[] = [];
    const unresolvedIntents: MossResourceImportJournalChange[] = [];
    const unresolvedTargets: MossResourceImportJournalChange[] = [];
    for (const journalChange of journal.changes) {
      const change = changeFromJournal(journalChange);
      if (journalChange.phase === "intent" && change === null) {
        unresolvedIntents.push(journalChange);
        continue;
      }
      if (change !== null) changes.push(change);
    }
    for (const intent of unresolvedIntents) {
      if (intent.markerPath !== undefined) {
        const markerStat = await lstatOrNull(intent.markerPath);
        if (markerStat?.isSymbolicLink()) {
          throw new MossResourceImportError("symlink-escape", "Import recovery marker is unsafe.");
        }
        if (markerStat) await assertOwnedImportMarker(intent.markerPath, intent.operationId);
      }
      if (intent.stagingPath !== undefined) {
        await removePrivateStatePath(options.stateDir, intent.stagingPath, {
          recursive: true,
        }).catch((cause) => {
          if (cause instanceof MossResourceImportError) throw cause;
          throw new MossResourceImportError(
            "recovery-needed",
            "Import staging could not be recovered.",
          );
        });
      }
      if (intent.markerPath !== undefined) {
        await assertOwnedImportMarker(intent.markerPath, intent.operationId);
      }
      if (intent.receiptPath !== undefined) {
        await removePrivateStatePath(options.stateDir, intent.receiptPath, {
          directorySyncHook: options.directorySyncHook,
        }).catch((cause) => {
          if (cause instanceof MossResourceImportError) throw cause;
          throw new MossResourceImportError(
            "recovery-needed",
            "Import receipt could not be recovered.",
          );
        });
      }
      if (await pathExists(intent.targetPath)) unresolvedTargets.push(intent);
    }
    const rollback = await rollbackChanges(cwd, changes, options, journal);
    const restoredIds = new Set(rollback.restored.map((result) => result.operationId));
    if (restoredIds.size > 0) {
      await removeProvenanceRecords(cwd, journal.transactionId, options, restoredIds);
    }
    if (unresolvedTargets.length > 0) {
      await writeJournal(
        cwd,
        appendJournalRecord(journal, {
          state: "recovery-needed",
          updatedAt: new Date().toISOString(),
        }),
        options,
      );
      throw new MossResourceImportError(
        "recovery-needed",
        "A previous import left a target without durable ownership evidence.",
      );
    }
    await writeJournal(
      cwd,
      appendJournalRecord(journal, {
        state: rollback.issues.length === 0 ? "rolled-back" : "recovery-needed",
        updatedAt: new Date().toISOString(),
      }),
      options,
    );
    if (rollback.issues.length > 0) {
      throw new MossResourceImportError(
        "recovery-needed",
        "A previous import could not be recovered without a canonical conflict.",
      );
    }
  }
}

export async function applyMossResourceImport(
  input: MossResourceImportApplyRequest,
): Promise<MossResourceImportApplyResult> {
  const cwd = nodePath.resolve(input.cwd);
  const submittedPlan = input.plan;
  const initialOptions = importOptions(input);
  const workspaceId =
    input.workspaceId ??
    submittedPlan.workspaceId ??
    initialOptions.workspaceId ??
    workspaceBindingId(cwd);
  const options = importOptions({ ...input, workspaceId });
  let plan: MossResourceImportPlan;
  try {
    plan = await resolveMossResourceImportPlan({
      ownershipStore: options.ownershipStore,
      plan: submittedPlan,
      scope: {
        cwd,
        issuer: options.issuer,
        ownerId: options.ownerId,
        projectId: options.projectId ?? workspaceId,
        principalId: options.principalId,
        sessionId: options.sessionId,
        workspaceId,
      },
      ...(options.planRegistry ? { registry: options.planRegistry } : {}),
      now: options.now(),
    });
  } catch (cause) {
    if (cause instanceof MossCanonicalMutationIntentError) {
      throw new MossResourceImportError(cause.code, cause.message);
    }
    throw cause;
  }
  if (
    plan.workspaceId !== workspaceId ||
    plan.ownerId !== options.ownerId ||
    plan.projectId !== (options.projectId ?? workspaceId) ||
    plan.principalId !== options.principalId ||
    plan.issuer !== options.issuer ||
    plan.sessionId !== options.sessionId
  ) {
    throw new MossResourceImportError(
      "authorization-required",
      "Import plan is bound to a different authenticated session or workspace.",
    );
  }
  if (plan.nonce !== snapshotPlanNonce(plan.planId)) {
    throw new MossResourceImportError(
      "plan-invalid",
      "Import plan snapshot authority nonce is invalid.",
    );
  }
  assertMutationAuthorized(options);
  requireFilesystemCapability(options);
  await ensurePrivateStateRoot(cwd, options.stateDir);
  await options.ownershipStore.recoverPrivateStages(privateStageRecoveryInput(cwd, options));
  await options.ownershipStore.assertStateBudget({
    maxBytes: DEFAULT_MAX_STATE_BYTES,
    maxEntries: DEFAULT_MAX_STATE_ENTRIES,
  });
  if (isExpired(plan.expiresAt, options.now())) {
    throw new MossResourceImportError("plan-expired", "Import plan has expired.");
  }
  if (
    nodePath.resolve(plan.cwd) !== cwd ||
    planHash(unsignedPlan(plan)) !== plan.planHash ||
    plan.stateFingerprint !==
      importStateFingerprint(cwd, workspaceId, plan.selectionSnapshotSha256, options.stateDir) ||
    plan.stateRoot !== options.stateDir
  ) {
    throw new MossResourceImportError("plan-invalid", "Import plan is stale or has been modified.");
  }
  if (plan.operations.length > options.maxResultOperations) {
    throw new MossResourceImportError(
      "limit-exceeded",
      "The import result exceeds its hard operation limit.",
    );
  }
  for (const operation of plan.operations) {
    if (
      operation.kind !== "mcp" ||
      operation.action === "blocked" ||
      operation.action === "conflict"
    ) {
      continue;
    }
    const snapshotAuthority = snapshotAuthorityForPlan(
      cwd,
      options,
      plan.planId,
      plan.nonce,
      operation.kind,
      operation.snapshotSha256,
    );
    await assertSnapshotBinding(cwd, operation, snapshotAuthority);
    await readMcpSnapshotServer(operation, options.maxFileBytes);
  }
  const result: MossResourceImportApplyResult = await withWorkspaceLock(
    cwd,
    options,
    async (options) => {
      await recoverPendingTransactions(cwd, options);

      const selectionTicket = input.selectionTicket ?? options.selectionTicket;
      const selectionOrigin: MossResourceImportSelectionOrigin =
        plan.selectionOrigin ?? (selectionTicket ? "catalog" : "local");
      const selectionSnapshotSha256 = plan.selectionSnapshotSha256;
      const transactionId = deriveMossResourceImportTransactionId({
        planId: plan.planId,
        planHash: plan.planHash,
        ownerId: plan.ownerId,
        projectId: plan.projectId,
        workspaceId: plan.workspaceId,
        principalId: plan.principalId,
        sessionId: plan.sessionId,
        issuer: plan.issuer,
        ...(plan.selectionTicketDigest
          ? { selectionTicketDigest: plan.selectionTicketDigest }
          : {}),
      });
      const existingJournal = await readJournal(
        cwd,
        transactionId,
        options.stateDir,
        options.ownershipStore,
      );
      if (existingJournal?.state === "committed") {
        await assertJournalBinding(cwd, existingJournal, options);
        return replayCommittedImportResult(plan, existingJournal);
      }
      if (
        plan.selectionTicketDigest !== undefined &&
        (!selectionTicket || sha256(selectionTicket) !== plan.selectionTicketDigest)
      ) {
        throw new MossResourceImportError(
          "ticket-mismatch",
          "Catalog selection ticket does not match the plan.",
        );
      }
      if (!existingJournal) {
        await verifySelectionTicket({
          origin: selectionOrigin,
          ticket: selectionTicket,
          verifier: options.selectionTicketVerifier,
          options,
          cwd,
          workspaceId,
          snapshotHash: selectionSnapshotSha256,
          resourceIds: plan.selectedResourceIds,
          consume: true,
        });
      }
      const createdAt = options.now().toISOString();
      const results: MossResourceImportOperationResult[] = [];
      const changes: ChangeRecord[] = [];
      const journalChanges: MossResourceImportJournalChange[] = [];
      const issues: MossResourceImportIssue[] = [...plan.issues];
      let provenancePath: string | undefined;
      let journalCreated = false;
      let journalSequence = 0;
      let previousJournalHash = JOURNAL_GENESIS_HASH;
      let durableState: MossResourceImportTransactionState | undefined;
      const transactionNonce = `transaction-nonce-${randomUUID()}`;

      const checkpoint = async (
        state: MossResourceImportTransactionState,
        context?: Omit<MossResourceImportCheckpointContext, "transactionId" | "state">,
      ): Promise<void> => {
        const journal = transactionJournal({
          transactionId,
          plan,
          cwd,
          ownerId: options.ownerId,
          projectId: options.projectId ?? workspaceId,
          principalId: options.principalId,
          workspaceId,
          stateRoot: options.stateDir,
          selectionSnapshotSha256,
          ...(plan.selectionTicketDigest
            ? { selectionTicketDigest: plan.selectionTicketDigest }
            : {}),
          transactionNonce,
          previousHash: previousJournalHash,
          sequence: journalSequence,
          state,
          changes,
          journalChanges,
          createdAt,
          updatedAt: options.now().toISOString(),
        });
        const persisted = await writeJournal(cwd, journal, options);
        journalSequence = persisted.sequence + 1;
        previousJournalHash = persisted.recordHash;
        journalCreated = true;
        durableState = state;
        await options.checkpointHook?.({ transactionId, state, ...context });
      };

      const finishCommitted = async (): Promise<MossResourceImportApplyResult> => {
        let cleanupIssue: MossResourceImportIssue | undefined;
        if (changes.length > 0) {
          try {
            await cleanupImportMutationStages(changes, options);
          } catch {
            cleanupIssue = issue(
              "durability-unsupported",
              "Private mutation stage cleanup could not be confirmed.",
              undefined,
              [],
              "error",
            );
          }
        }
        const durableReceipt =
          changes.length > 0
            ? {
                transactionId,
                operationId: transactionId,
                planHash: plan.planHash,
                afterState: changes.map((change) => ({
                  operationId: change.operation.operationId,
                  targetPath: change.targetPath,
                  state: "present" as const,
                  afterHash: change.afterHash,
                  durable: true as const,
                })),
              }
            : undefined;
        return {
          transactionId,
          planId: plan.planId,
          status: "committed",
          operations: results,
          ...(provenancePath ? { provenancePath } : {}),
          issues: [...issues, ...(cleanupIssue ? [cleanupIssue] : [])].slice(0, 2_000),
          ...(durableReceipt ? { receipt: durableReceipt } : {}),
        };
      };

      try {
        await checkpoint("prepared");
        for (const operation of plan.operations) {
          if (operation.action === "skip") {
            results.push(
              operationResult(operation, "skipped", "Already imported from the same source SHA."),
            );
            continue;
          }
          if (operation.action === "conflict") {
            results.push(
              operationResult(
                operation,
                "conflict",
                "Canonical target already exists; no overwrite performed.",
              ),
            );
            continue;
          }
          if (operation.action === "blocked") {
            results.push(
              operationResult(
                operation,
                "blocked",
                "Resource contains content that cannot be safely imported.",
              ),
            );
            continue;
          }
          const snapshotAuthority = snapshotAuthorityForPlan(
            cwd,
            options,
            plan.planId,
            plan.nonce,
            operation.kind,
            operation.snapshotSha256,
          );
          await assertSnapshotBinding(cwd, operation, snapshotAuthority);
          const expectedTarget = canonicalTarget(
            {
              id: operation.resourceId,
              kind: operation.kind,
              provider: operation.provider,
              scope: operation.scope,
              name: operation.name,
              sourcePath: operation.sourcePath,
              sourceSha256: operation.sourceSha256,
              snapshotPath: operation.snapshotPath,
              snapshotSha256: operation.snapshotSha256,
              sizeBytes: 0,
              format:
                operation.kind === "skill"
                  ? "markdown"
                  : operation.kind === "plugin"
                    ? "directory"
                    : "json",
              secretFields: operation.secretFields,
              warnings: operation.warnings,
              canonicalIdentityKey: operation.canonicalIdentityKey,
            },
            cwd,
          ).path;
          const expectedIdentity =
            operation.canonicalIdentityKey ??
            canonicalIdentityKey({ kind: operation.kind, name: operation.name });
          if (
            expectedTarget !== operation.targetPath ||
            operation.canonicalIdentityKey !== expectedIdentity
          ) {
            throw new MossResourceImportError(
              "plan-invalid",
              "Import operation is not bound to the current canonical identity.",
            );
          }
          if (
            blockingWarningCode({
              id: operation.resourceId,
              kind: operation.kind,
              provider: operation.provider,
              scope: operation.scope,
              name: operation.name,
              sourcePath: operation.sourcePath,
              sourceSha256: operation.sourceSha256,
              snapshotPath: operation.snapshotPath,
              snapshotSha256: operation.snapshotSha256,
              sizeBytes: 0,
              format:
                operation.kind === "skill"
                  ? "markdown"
                  : operation.kind === "plugin"
                    ? "directory"
                    : "json",
              secretFields: operation.secretFields,
              warnings: operation.warnings,
              canonicalIdentityKey: operation.canonicalIdentityKey,
            }) !== null ||
            (operation.kind !== "plugin" && operation.secretFields.length > 0) ||
            operation.secretFields.some(
              (field) => field === "content" || field.endsWith(".content"),
            )
          ) {
            throw new MossResourceImportError(
              "secret-fields",
              "Resource is quarantined because it contains unsafe fields.",
            );
          }
          if ((await pathExists(operation.targetPath)) && operation.kind !== "mcp") {
            if (operation.action === "replace") {
              // A replace is allowed only when the plan captured a server-side
              // compare-and-swap hash; the capability rechecks it under lock.
            } else {
              results.push(
                operationResult(
                  operation,
                  "conflict",
                  "Canonical target appeared after planning; no overwrite performed.",
                ),
              );
              continue;
            }
          }
          const hashLimits = hashLimitsFor(options);
          const snapshotHash =
            operation.kind === "plugin"
              ? (
                  await inspectTree(
                    operation.snapshotPath,
                    await fs.realpath(operation.snapshotPath),
                    {
                      maxFileBytes: options.maxFileBytes,
                      maxTreeBytes: options.maxTreeBytes,
                      maxTreeDepth: options.maxTreeDepth,
                      maxTreeEntries: options.maxTreeEntries,
                      maxDirectories: options.maxDirectories,
                      maxSymlinks: options.maxSymlinks,
                    },
                    [],
                  )
                ).sourceSha256
              : await hashPath(operation.snapshotPath, hashLimits);
          if (snapshotHash !== operation.snapshotSha256) {
            throw new MossResourceImportError(
              "stale-source",
              "The server-owned snapshot failed verification.",
            );
          }
          const beforeHash = await hashPath(operation.targetPath, hashLimits);
          if (
            operation.action === "replace" &&
            (operation.expectedBeforeHash === undefined ||
              operation.expectedBeforeHash !== beforeHash)
          ) {
            throw new MossResourceImportError(
              "concurrent-modification",
              "The canonical replace target changed after planning.",
            );
          }
          const operationToken = sha256(operation.operationId).slice(0, 32);
          const capabilityOperationId = importCapabilityOperationId(operation, plan);
          const privateStageAuthority: MossPrivateSnapshotAuthority = {
            ...snapshotAuthority,
            transactionId,
            operationId: capabilityOperationId,
            fencingToken: options.activeFencingToken ?? snapshotAuthority.fencingToken,
            generation: options.activeGeneration ?? snapshotAuthority.generation,
            nonce: options.activeLockNonce ?? snapshotAuthority.nonce,
          };
          const privateStage = await options.ownershipStore.createPrivateStage(
            privateStageInput(options, privateStageAuthority),
          );
          const stagingPath = await nodePrivateMutationPayloadPath(privateStage);
          const receiptPath = nodePath.join(
            options.stateDir,
            RECEIPTS_DIR_NAME,
            `${transactionId}-${operationToken}.json`,
          );
          const receiptNonce = `receipt-nonce-${randomUUID()}`;
          const journalIndex = journalChanges.length;
          journalChanges.push(
            journalIntentFromOperation({
              operation,
              beforeHash,
              stagingPath,
              receiptPath,
              receiptNonce,
            }),
          );
          const checkpointContext = {
            operationId: operation.operationId,
            kind: operation.kind,
            targetPath: operation.targetPath,
            stagingPath,
          } as const;
          const onPrepared = async (expectedHash: string): Promise<void> => {
            journalChanges[journalIndex] = {
              ...journalChanges[journalIndex]!,
              expectedHash,
            };
            await checkpoint("applying", checkpointContext);
          };
          await checkpoint("applying", checkpointContext);
          const receiptJournal = transactionJournal({
            transactionId,
            plan,
            cwd,
            ownerId: options.ownerId,
            projectId: options.projectId ?? workspaceId,
            principalId: options.principalId,
            workspaceId,
            stateRoot: options.stateDir,
            selectionSnapshotSha256,
            ...(plan.selectionTicketDigest
              ? { selectionTicketDigest: plan.selectionTicketDigest }
              : {}),
            transactionNonce,
            previousHash: previousJournalHash,
            sequence: journalSequence,
            state: "applying",
            changes,
            journalChanges,
            createdAt,
            updatedAt: options.now().toISOString(),
          });
          await writeImportReceipt(
            cwd,
            receiptJournal,
            operation,
            beforeHash,
            receiptPath,
            receiptNonce,
            options,
          );
          const filesystemCapability = requireFilesystemCapability(options);
          let change: ChangeRecord;
          if (operation.kind === "skill") {
            const afterHash = await copySkillFile(operation, cwd, operation.targetPath, {
              maxFileBytes: options.maxFileBytes,
              stateRoot: options.stateDir,
              stagingPath,
              stage: privateStage,
              filesystemCapability,
              action: operation.action === "replace" ? "replace" : "create",
              authorityFor: (expectedAfterHash) =>
                capabilityAuthority(
                  cwd,
                  options,
                  capabilityOperationId,
                  beforeHash,
                  expectedAfterHash,
                ),
              expectedBeforeHash: beforeHash,
              onPrepared,
              hashLimits,
              mutationHook: options.beforeFilesystemMutation,
              directorySyncHook: options.directorySyncHook,
            });
            change = {
              operation,
              targetPath: operation.targetPath,
              kind: operation.kind,
              beforeHash,
              afterHash,
              stagingPath,
              receiptPath,
              receiptNonce,
            };
            results.push(operationResult(operation, "created"));
          } else if (operation.kind === "plugin") {
            const copied = await copyPluginTree(
              operation,
              operation.snapshotPath,
              operation.targetPath,
              {
                cwd,
                stateRoot: options.stateDir,
                maxFileBytes: options.maxFileBytes,
                maxTreeBytes: options.maxTreeBytes,
                maxTreeDepth: options.maxTreeDepth,
                maxTreeEntries: options.maxTreeEntries,
                maxHashBytes: options.maxHashBytes,
                maxHashDepth: options.maxHashDepth,
                maxHashMillis: options.maxHashMillis,
                stagingPath,
                stage: privateStage,
                filesystemCapability,
                action: operation.action === "replace" ? "replace" : "publish",
                authorityFor: (expectedAfterHash) =>
                  capabilityAuthority(
                    cwd,
                    options,
                    capabilityOperationId,
                    beforeHash,
                    expectedAfterHash,
                  ),
                expectedBeforeHash: beforeHash,
                onPrepared,
                mutationHook: options.beforeFilesystemMutation,
                directorySyncHook: options.directorySyncHook,
              },
            );
            const afterHash = copied.afterHash;
            change = {
              operation,
              targetPath: operation.targetPath,
              kind: operation.kind,
              beforeHash,
              afterHash,
              stagingPath,
              receiptPath,
              receiptNonce,
            };
            results.push(operationResult(operation, "created"));
          } else {
            const merged = await mergeMcpServer(operation, cwd, {
              maxFileBytes: options.maxFileBytes,
              stateRoot: options.stateDir,
              expectedBeforeHash: beforeHash,
              stagingPath,
              stage: privateStage,
              filesystemCapability,
              importOptions: options,
              capabilityOperationId,
              onPrepared,
              hashLimits,
              mutationHook: options.beforeFilesystemMutation,
              directorySyncHook: options.directorySyncHook,
            });
            change = {
              operation,
              targetPath: operation.targetPath,
              kind: operation.kind,
              beforeHash: merged.beforeHash,
              afterHash: merged.afterHash,
              beforeConfigExisted: merged.beforeConfigExisted,
              stagingPath,
              receiptPath,
              receiptNonce,
            };
            results.push(operationResult(operation, "merged"));
          }
          changes.push(change);
          journalChanges[journalIndex] = journalChangeFromChange(change);
          await checkpoint("applying", checkpointContext);
          provenancePath = await writeProvenance(
            cwd,
            transactionId,
            plan.planId,
            plan.planHash,
            options.issuer,
            options.ownerId,
            options.sessionId,
            workspaceId,
            selectionSnapshotSha256,
            plan.stateFingerprint,
            plan.expiresAt,
            changes,
            options.now().toISOString(),
            transactionNonce,
            options,
          );
        }

        const successes = results.filter(
          (result) => result.status === "created" || result.status === "merged",
        );
        const hasProblem = results.some((result) =>
          ["conflict", "blocked", "failed"].includes(result.status),
        );
        if (changes.length > 0) {
          provenancePath = await writeProvenance(
            cwd,
            transactionId,
            plan.planId,
            plan.planHash,
            options.issuer,
            options.ownerId,
            options.sessionId,
            workspaceId,
            selectionSnapshotSha256,
            plan.stateFingerprint,
            plan.expiresAt,
            changes,
            options.now().toISOString(),
            transactionNonce,
            options,
          );
        }
        await checkpoint(hasProblem ? "partial" : "committed");
        if (!hasProblem) return finishCommitted();
        return {
          transactionId,
          planId: plan.planId,
          status: successes.length === 0 ? "blocked" : "partial",
          operations: results,
          ...(provenancePath ? { provenancePath } : {}),
          issues: issues.slice(0, 2_000),
        };
      } catch (cause) {
        const failure = applyIssue(cause);
        issues.push(failure);
        if (durableState === "committed") return finishCommitted();
        if (journalCreated) {
          await checkpoint("rolling-back").catch(() => undefined);
        }
        const rollbackChangesForTransaction = [...changes];
        const changedOperationIds = new Set(
          rollbackChangesForTransaction.map((change) => change.operation.operationId),
        );
        for (const journalChange of journalChanges) {
          if (journalChange.phase !== "intent" || !journalChange.expectedHash) continue;
          if (changedOperationIds.has(journalChange.operationId)) continue;
          const resolved = changeFromJournal(journalChange);
          if (resolved) rollbackChangesForTransaction.push(resolved);
        }
        const rollback = await rollbackChanges(
          cwd,
          rollbackChangesForTransaction,
          options,
          undefined,
          transactionId,
          plan,
        );
        const restoredIds = new Set(rollback.restored.map((result) => result.operationId));
        if (restoredIds.size > 0) {
          await removeProvenanceRecords(cwd, transactionId, options, restoredIds).catch(() => {
            rollback.issues.push(
              issue(
                "rollback-conflict",
                "Import provenance could not be removed safely.",
                undefined,
                [],
                "error",
              ),
            );
          });
        }
        issues.push(...rollback.issues);
        const durabilityUncertain = failure.code === "durability-unsupported";
        if (journalCreated) {
          await checkpoint(rollback.issues.length === 0 ? "rolled-back" : "recovery-needed").catch(
            () => undefined,
          );
        }
        return {
          transactionId,
          planId: plan.planId,
          status: rollback.issues.length === 0 && !durabilityUncertain ? "rolled-back" : "partial",
          operations: [...results, ...rollback.restored],
          issues,
        };
      }
    },
  );
  return result;
}

export async function rollbackMossResourceImport(
  input: MossResourceImportRollbackRequest,
): Promise<MossResourceImportRollbackResult> {
  const cwd = nodePath.resolve(input.cwd);
  assertSafeTransactionId(input.transactionId);
  const initialOptions = importOptions(input);
  const workspaceId = input.workspaceId ?? initialOptions.workspaceId ?? workspaceBindingId(cwd);
  const options = importOptions({ ...input, workspaceId });
  assertMutationAuthorized(options);
  requireFilesystemCapability(options);
  await ensurePrivateStateRoot(cwd, options.stateDir);
  const result: MossResourceImportRollbackResult = await withWorkspaceLock(
    cwd,
    options,
    async (options) => {
      try {
        await recoverPendingTransactions(cwd, options);
        const journal = await readJournal(
          cwd,
          input.transactionId,
          options.stateDir,
          options.ownershipStore,
        );
        if (!journal) {
          return {
            transactionId: input.transactionId,
            status: "not-found",
            restored: [],
            issues: [],
          };
        }
        if (journal.state === "rolled-back") {
          return {
            transactionId: input.transactionId,
            status: "rolled-back",
            restored: [],
            issues: [],
          };
        }
        await assertJournalBinding(cwd, journal, options);
        const changes = journal.changes.flatMap((change) => {
          const resolved = changeFromJournal(change);
          return resolved ? [resolved] : [];
        });
        if (changes.length !== journal.changes.length) {
          throw new MossResourceImportError(
            "recovery-needed",
            "Import transaction contains an incomplete mutation intent.",
          );
        }
        const rollbackJournal = appendJournalRecord(journal, {
          state: "rolling-back",
          updatedAt: options.now().toISOString(),
        });
        await writeJournal(cwd, rollbackJournal, options);
        const rollback = await rollbackChanges(cwd, changes, options, journal);
        const restoredIds = new Set(rollback.restored.map((result) => result.operationId));
        if (restoredIds.size > 0) {
          await removeProvenanceRecords(cwd, input.transactionId, options, restoredIds).catch(
            () => {
              rollback.issues.push(
                issue(
                  "rollback-conflict",
                  "Import provenance could not be removed safely.",
                  undefined,
                  [],
                  "error",
                ),
              );
            },
          );
        }
        await writeJournal(
          cwd,
          appendJournalRecord(rollbackJournal, {
            state: rollback.issues.length === 0 ? "rolled-back" : "recovery-needed",
            updatedAt: options.now().toISOString(),
          }),
          options,
        );
        return {
          transactionId: input.transactionId,
          status: rollback.issues.length === 0 ? "rolled-back" : "partial",
          restored: rollback.restored,
          issues: rollback.issues,
        };
      } catch (cause) {
        if (cause instanceof MossResourceImportError) {
          return {
            transactionId: input.transactionId,
            status: "partial",
            restored: [],
            issues: [
              issue(
                cause.code,
                "Import transaction could not be safely validated; no files were changed.",
                undefined,
                [],
                "error",
              ),
            ],
          };
        }
        throw cause;
      }
    },
  );
  return result;
}

// Singular aliases keep the service easy to discover for callers that use the
// noun from the RPC method name rather than the collection-oriented wording.
export const inventoryMossResources = inventoryMossResourceImport;
export const planMossResourcesImport = planMossResourceImport;
