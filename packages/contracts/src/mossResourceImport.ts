import { Schema } from "effect";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";

const BoundedPath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(4_096),
  Schema.isPattern(/^[^\u0000]*$/u),
);
const BoundedId = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
const BoundedLocalSourceText = Schema.String.check(Schema.isMaxLength(1_000_000));
export const MossResourceImportTransactionId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(512),
  Schema.isPattern(/^transaction-[A-Za-z0-9-]+$/),
);
const Sha256 = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-f0-9]{64}$/i),
);
const IssueMessage = TrimmedNonEmptyString.check(Schema.isMaxLength(1_000));
const BoundedIssueFields = Schema.Array(BoundedId).check(Schema.isMaxLength(128));
const BoundedIssues = Schema.Array(Schema.suspend(() => MossResourceImportIssue)).check(
  Schema.isMaxLength(2_000),
);
const BoundedResources = Schema.Array(Schema.suspend(() => MossResourceImportResource)).check(
  Schema.isMaxLength(2_000),
);
const BoundedOperations = Schema.Array(Schema.suspend(() => MossResourceImportOperation)).check(
  Schema.isMaxLength(500),
);
const BoundedJournalChanges = Schema.Array(
  Schema.suspend(() => MossResourceImportJournalChange),
).check(Schema.isMaxLength(500));
const BoundedProvenanceRecords = Schema.Array(
  Schema.suspend(() => MossResourceImportProvenanceRecord),
).check(Schema.isMaxLength(2_000));

export const MOSS_RESOURCE_IMPORT_SCHEMA_VERSION = 1 as const;
export const MOSS_RESOURCE_IMPORT_JOURNAL_SCHEMA_VERSION = 3 as const;

/** Provider roots are intentionally separate from ProviderKind: `agents` is a
 * filesystem convention rather than a runtime provider, while `claude` is the
 * user-facing root name for the `claudeAgent` runtime. */
export const MossResourceImportProvider = Schema.Literals([
  "codex",
  "claude",
  "agents",
  "cursor",
  "gemini",
  "grok",
  "opencode",
  "pi",
]);
export type MossResourceImportProvider = typeof MossResourceImportProvider.Type;

export const MossResourceImportKind = Schema.Literals(["skill", "plugin", "mcp"]);
export type MossResourceImportKind = typeof MossResourceImportKind.Type;

export const MossResourceImportScope = Schema.Literals(["workspace", "user"]);
export type MossResourceImportScope = typeof MossResourceImportScope.Type;

export const MossResourceImportSelectionOrigin = Schema.Literals(["local", "catalog"]);
export type MossResourceImportSelectionOrigin = typeof MossResourceImportSelectionOrigin.Type;

export const MossResourceImportRootKind = Schema.Literals(["skills", "plugins", "mcp"]);
export type MossResourceImportRootKind = typeof MossResourceImportRootKind.Type;

export const MossResourceImportFormat = Schema.Literals(["markdown", "directory", "json", "toml"]);
export type MossResourceImportFormat = typeof MossResourceImportFormat.Type;

/** Browser-originated bytes are accepted only as a bounded local source. */
export const MossResourceImportLocalSource = Schema.Struct({
  kind: MossResourceImportKind,
  sourceName: BoundedId.check(Schema.isPattern(/^[^\\/]+$/u)),
  contents: BoundedLocalSourceText,
  sourceSelector: Schema.optional(BoundedId),
  /** Server-side conflict choice; never a client-supplied path or digest. */
  replaceExisting: Schema.optional(Schema.Boolean),
});
export type MossResourceImportLocalSource = typeof MossResourceImportLocalSource.Type;

export const MossResourceImportIssueCode = Schema.Literals([
  "missing-root",
  "unreadable",
  "invalid-json",
  "invalid-toml",
  "invalid-skill",
  "unsupported",
  "symlink",
  "symlink-escape",
  "path-traversal",
  "secret-fields",
  "conflict",
  "stale-source",
  "copy-failed",
  "durability-unsupported",
  "rollback-conflict",
  "plan-invalid",
  "authorization-required",
  "workspace-unregistered",
  "transaction-invalid",
  "recovery-needed",
  "reserved-identity",
  "mcp-invalid-transport",
  "limit-exceeded",
  "binary",
  "concurrent-modification",
  "ticket-invalid",
  "ticket-expired",
  "ticket-revoked",
  "ticket-mismatch",
  "invalid-identity",
  "plan-expired",
  "plan-budget-exceeded",
  "transaction-expired",
  "snapshot-invalid",
]);
export type MossResourceImportIssueCode = typeof MossResourceImportIssueCode.Type;

export const MossResourceImportIssueSeverity = Schema.Literals(["info", "warning", "error"]);
export type MossResourceImportIssueSeverity = typeof MossResourceImportIssueSeverity.Type;

export const MossResourceImportIssue = Schema.Struct({
  code: MossResourceImportIssueCode,
  severity: MossResourceImportIssueSeverity,
  message: IssueMessage,
  sourcePath: Schema.optional(BoundedPath),
  fieldPaths: BoundedIssueFields,
});
export type MossResourceImportIssue = typeof MossResourceImportIssue.Type;

export const MossResourceImportRoot = Schema.Struct({
  provider: MossResourceImportProvider,
  scope: MossResourceImportScope,
  kind: MossResourceImportRootKind,
  path: BoundedPath,
  exists: Schema.Boolean,
  /** True when the root exists but the server needs user-granted filesystem access. */
  permissionRequired: Schema.Boolean,
});
export type MossResourceImportRoot = typeof MossResourceImportRoot.Type;

export const MossResourceImportResource = Schema.Struct({
  id: BoundedId,
  kind: MossResourceImportKind,
  provider: MossResourceImportProvider,
  scope: MossResourceImportScope,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(240)),
  sourcePath: BoundedPath,
  sourceSelector: Schema.optional(BoundedId),
  sourceSha256: Sha256,
  snapshotPath: Schema.optional(BoundedPath),
  snapshotSha256: Schema.optional(Sha256),
  sourceVersion: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
  sizeBytes: NonNegativeInt,
  format: MossResourceImportFormat,
  secretFields: BoundedIssueFields,
  warnings: Schema.Array(MossResourceImportIssueCode).check(Schema.isMaxLength(128)),
  canonicalIdentityKey: Schema.optional(BoundedId),
  enabled: Schema.optional(Schema.Boolean),
  quarantined: Schema.optional(Schema.Boolean),
});
export type MossResourceImportResource = typeof MossResourceImportResource.Type;

export const MossResourceImportInventoryInput = Schema.Struct({
  cwd: BoundedPath,
  providers: Schema.optional(
    Schema.Array(MossResourceImportProvider).check(Schema.isMaxLength(10)),
  ),
  kinds: Schema.optional(Schema.Array(MossResourceImportKind).check(Schema.isMaxLength(3))),
  workspaceId: Schema.optional(BoundedId),
  /** A browser-uploaded source is staged by the server into private state. */
  localSource: Schema.optional(MossResourceImportLocalSource),
});
export type MossResourceImportInventoryInput = typeof MossResourceImportInventoryInput.Type;

export const MossResourceImportInventoryResult = Schema.Struct({
  inventoryId: BoundedId,
  cwd: BoundedPath,
  generatedAt: IsoDateTime,
  roots: Schema.Array(MossResourceImportRoot).check(Schema.isMaxLength(128)),
  resources: BoundedResources,
  issues: BoundedIssues,
});
export type MossResourceImportInventoryResult = typeof MossResourceImportInventoryResult.Type;

export const MossResourceImportPlanInput = Schema.Struct({
  cwd: BoundedPath,
  resourceIds: Schema.optional(Schema.Array(BoundedId).check(Schema.isMaxLength(500))),
  providers: Schema.optional(
    Schema.Array(MossResourceImportProvider).check(Schema.isMaxLength(10)),
  ),
  kinds: Schema.optional(Schema.Array(MossResourceImportKind).check(Schema.isMaxLength(3))),
  workspaceId: Schema.optional(BoundedId),
  selectionOrigin: Schema.optional(MossResourceImportSelectionOrigin),
  selectionTicket: Schema.optional(BoundedId),
  localSource: Schema.optional(MossResourceImportLocalSource),
});
export type MossResourceImportPlanInput = typeof MossResourceImportPlanInput.Type;

export const MossResourceImportOperationAction = Schema.Literals([
  "copy",
  "merge",
  "replace",
  "skip",
  "conflict",
  "blocked",
]);
export type MossResourceImportOperationAction = typeof MossResourceImportOperationAction.Type;

export const MossResourceImportOperation = Schema.Struct({
  operationId: BoundedId,
  resourceId: BoundedId,
  kind: MossResourceImportKind,
  provider: MossResourceImportProvider,
  scope: MossResourceImportScope,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(240)),
  sourcePath: BoundedPath,
  sourceSelector: Schema.optional(BoundedId),
  sourceSha256: Sha256,
  snapshotPath: BoundedPath,
  snapshotSha256: Sha256,
  sourceVersion: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
  targetPath: BoundedPath,
  action: MossResourceImportOperationAction,
  expectedBeforeHash: Schema.optional(Sha256),
  secretFields: BoundedIssueFields,
  warnings: Schema.Array(MossResourceImportIssueCode).check(Schema.isMaxLength(128)),
  canonicalIdentityKey: Schema.optional(BoundedId),
  enabled: Schema.optional(Schema.Boolean),
  quarantined: Schema.optional(Schema.Boolean),
});
export type MossResourceImportOperation = typeof MossResourceImportOperation.Type;

export const MossResourceImportPlan = Schema.Struct({
  schemaVersion: Schema.Literal(MOSS_RESOURCE_IMPORT_SCHEMA_VERSION),
  planId: BoundedId,
  cwd: BoundedPath,
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  issuer: BoundedId,
  ownerId: BoundedId,
  projectId: BoundedId,
  principalId: BoundedId,
  sessionId: BoundedId,
  workspaceId: BoundedId,
  stateFingerprint: Sha256,
  stateRoot: BoundedPath,
  nonce: BoundedId,
  planHash: Sha256,
  selectedResourceIds: Schema.Array(BoundedId).check(Schema.isMaxLength(500)),
  operations: BoundedOperations,
  issues: BoundedIssues,
  selectionOrigin: Schema.optional(MossResourceImportSelectionOrigin),
  selectionSnapshotSha256: Sha256,
  selectionTicketDigest: Schema.optional(Sha256),
});
export type MossResourceImportPlan = typeof MossResourceImportPlan.Type;

export const MossResourceImportPlanResult = Schema.Struct({
  inventoryId: Schema.optional(BoundedId),
  plan: MossResourceImportPlan,
});
export type MossResourceImportPlanResult = typeof MossResourceImportPlanResult.Type;

export const MossResourceImportOperationResult = Schema.Struct({
  operationId: BoundedId,
  status: Schema.Literals(["created", "merged", "skipped", "conflict", "blocked", "failed"]),
  targetPath: BoundedPath,
  message: Schema.optional(IssueMessage),
});
export type MossResourceImportOperationResult = typeof MossResourceImportOperationResult.Type;

export const MossResourceImportApplyInput = Schema.Struct({
  cwd: BoundedPath,
  plan: MossResourceImportPlan,
  workspaceId: Schema.optional(BoundedId),
  selectionTicket: Schema.optional(BoundedId),
});
export type MossResourceImportApplyInput = typeof MossResourceImportApplyInput.Type;

export const MossResourceImportApplyResult = Schema.Struct({
  transactionId: BoundedId,
  planId: BoundedId,
  status: Schema.Literals(["committed", "rolled-back", "partial", "blocked"]),
  operations: Schema.Array(MossResourceImportOperationResult).check(Schema.isMaxLength(500)),
  provenancePath: Schema.optional(BoundedPath),
  issues: BoundedIssues,
  receipt: Schema.optional(
    Schema.Struct({
      transactionId: MossResourceImportTransactionId,
      operationId: BoundedId,
      planHash: Sha256,
      afterState: Schema.Array(
        Schema.Struct({
          operationId: BoundedId,
          targetPath: BoundedPath,
          state: Schema.Literal("present"),
          afterHash: Sha256,
          durable: Schema.Literal(true),
        }),
      ).check(Schema.isMaxLength(500)),
    }),
  ),
});
export type MossResourceImportApplyResult = typeof MossResourceImportApplyResult.Type;

export const MossResourceImportRollbackInput = Schema.Struct({
  cwd: BoundedPath,
  transactionId: MossResourceImportTransactionId,
  workspaceId: Schema.optional(BoundedId),
});
export type MossResourceImportRollbackInput = typeof MossResourceImportRollbackInput.Type;

export const MossResourceImportRollbackResult = Schema.Struct({
  transactionId: BoundedId,
  status: Schema.Literals(["rolled-back", "partial", "not-found"]),
  restored: Schema.Array(MossResourceImportOperationResult).check(Schema.isMaxLength(500)),
  issues: BoundedIssues,
});
export type MossResourceImportRollbackResult = typeof MossResourceImportRollbackResult.Type;

export const MossResourceImportTransactionState = Schema.Literals([
  "prepared",
  "applying",
  "committed",
  "partial",
  "rolling-back",
  "rolled-back",
  "recovery-needed",
]);
export type MossResourceImportTransactionState = typeof MossResourceImportTransactionState.Type;

export const MossResourceImportJournalChangePhase = Schema.Literals(["intent", "applied"]);
export type MossResourceImportJournalChangePhase = typeof MossResourceImportJournalChangePhase.Type;

export const MossResourceImportJournalChange = Schema.Struct({
  operationId: BoundedId,
  phase: MossResourceImportJournalChangePhase,
  kind: MossResourceImportKind,
  provider: MossResourceImportProvider,
  scope: MossResourceImportScope,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(240)),
  canonicalIdentityKey: BoundedId,
  sourcePath: BoundedPath,
  sourceSelector: Schema.optional(BoundedId),
  sourceSha256: Sha256,
  snapshotPath: BoundedPath,
  snapshotSha256: Sha256,
  sourceVersion: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
  targetPath: BoundedPath,
  beforeHash: Sha256,
  expectedHash: Schema.optional(Sha256),
  stagingPath: Schema.optional(BoundedPath),
  markerPath: Schema.optional(BoundedPath),
  receiptPath: Schema.optional(BoundedPath),
  receiptNonce: Schema.optional(BoundedId),
  afterHash: Schema.optional(Sha256),
  beforeConfigExisted: Schema.optional(Schema.Boolean),
});
export type MossResourceImportJournalChange = typeof MossResourceImportJournalChange.Type;

export const MossResourceImportJournal = Schema.Struct({
  schemaVersion: Schema.Literal(MOSS_RESOURCE_IMPORT_JOURNAL_SCHEMA_VERSION),
  transactionId: MossResourceImportTransactionId,
  planId: BoundedId,
  issuer: BoundedId,
  ownerId: BoundedId,
  projectId: BoundedId,
  principalId: BoundedId,
  sessionId: BoundedId,
  workspaceId: BoundedId,
  cwd: BoundedPath,
  canonicalRoot: BoundedPath,
  planHash: Sha256,
  selectionSnapshotSha256: Sha256,
  /** Digest of the server-verified catalog ticket used for this plan, if any. */
  selectionTicketDigest: Schema.optional(Sha256),
  stateFingerprint: Sha256,
  stateRoot: BoundedPath,
  nonce: BoundedId,
  previousHash: Sha256,
  recordHash: Sha256,
  expiresAt: IsoDateTime,
  sequence: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  state: MossResourceImportTransactionState,
  changes: BoundedJournalChanges,
});
export type MossResourceImportJournal = typeof MossResourceImportJournal.Type;

export const MossResourceImportProvenanceRecord = Schema.Struct({
  schemaVersion: Schema.Literal(MOSS_RESOURCE_IMPORT_JOURNAL_SCHEMA_VERSION),
  transactionId: MossResourceImportTransactionId,
  planId: BoundedId,
  planHash: Sha256,
  selectionSnapshotSha256: Sha256,
  stateFingerprint: Sha256,
  stateRoot: BoundedPath,
  issuer: BoundedId,
  operationId: BoundedId,
  ownerId: BoundedId,
  projectId: BoundedId,
  principalId: BoundedId,
  workspaceId: BoundedId,
  sessionId: BoundedId,
  cwd: BoundedPath,
  kind: MossResourceImportKind,
  provider: MossResourceImportProvider,
  scope: MossResourceImportScope,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(240)),
  canonicalIdentityKey: BoundedId,
  sourcePath: BoundedPath,
  sourceSelector: Schema.optional(BoundedId),
  sourceSha256: Sha256,
  snapshotPath: BoundedPath,
  snapshotSha256: Sha256,
  sourceVersion: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
  targetPath: BoundedPath,
  targetHash: Sha256,
  receiptPath: Schema.optional(BoundedPath),
  receiptNonce: Schema.optional(BoundedId),
  expiresAt: IsoDateTime,
  importedAt: IsoDateTime,
  redactedFields: BoundedIssueFields,
});
export type MossResourceImportProvenanceRecord = typeof MossResourceImportProvenanceRecord.Type;

export const MossResourceImportProvenanceManifest = Schema.Struct({
  schemaVersion: Schema.Literal(MOSS_RESOURCE_IMPORT_JOURNAL_SCHEMA_VERSION),
  records: BoundedProvenanceRecords,
});
export type MossResourceImportProvenanceManifest = typeof MossResourceImportProvenanceManifest.Type;

export const MossResourceImportReceipt = Schema.Struct({
  schemaVersion: Schema.Literal(MOSS_RESOURCE_IMPORT_JOURNAL_SCHEMA_VERSION),
  transactionId: MossResourceImportTransactionId,
  operationId: BoundedId,
  issuer: BoundedId,
  ownerId: BoundedId,
  projectId: BoundedId,
  principalId: BoundedId,
  sessionId: BoundedId,
  workspaceId: BoundedId,
  cwd: BoundedPath,
  canonicalRoot: BoundedPath,
  stateFingerprint: Sha256,
  stateRoot: BoundedPath,
  nonce: BoundedId,
  receiptNonce: BoundedId,
  expiresAt: IsoDateTime,
  kind: MossResourceImportKind,
  canonicalIdentityKey: BoundedId,
  snapshotPath: BoundedPath,
  snapshotSha256: Sha256,
  targetPath: BoundedPath,
  beforeHash: Sha256,
});
export type MossResourceImportReceipt = typeof MossResourceImportReceipt.Type;

/** Pure protocol types consumed by server and shared projection adapters. */
export interface MossCanonicalRootDescriptor {
  readonly rootPath: string;
  /** Descriptor identity only; never a signature or authorization token. */
  readonly identityFingerprint: string;
  readonly projectId: string;
  readonly workspaceId: string;
  /** Optional explicit owner binding; older injected capability doubles may omit it. */
  readonly ownerId?: string;
  readonly principalId: string;
  /** Authenticated connection/session binding; never caller-selected metadata. */
  readonly sessionId: string;
}

export interface MossFilesystemIdentity {
  /** Identity is an observed fingerprint, not a signature or authorization token. */
  readonly identityFingerprint: string;
  readonly hash: string;
}

export interface MossResourceImportFrozenDescriptor {
  readonly operationId: string;
  readonly kind: MossResourceImportKind;
  readonly canonicalIdentityKey: string;
  readonly sourceSha256: string;
  readonly snapshotSha256: string;
  /** Opaque server-owned locator; consumers must not derive filesystem paths. */
  readonly snapshotLocator: string;
}

export interface MossPrivateStageInput {
  readonly transactionId: string;
  readonly operationId: string;
  readonly kind: MossResourceImportKind;
  /** Server-owned absolute canonical root bound to this stage. */
  readonly canonicalRoot: string;
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

export interface MossPrivateStage {
  readonly id: string;
  readonly transactionId: string;
  readonly operationId: string;
  readonly kind: MossResourceImportKind;
  /** Server-owned absolute canonical root bound to this stage. */
  readonly canonicalRoot: string;
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
  /** Opaque store-owned handle; callers must not interpret it as a path. */
  readonly opaque: unknown;
}

export type MossPrivateStagePayload =
  | {
      readonly kind: "file";
      readonly content: Uint8Array;
    }
  | {
      readonly kind: "directory";
      readonly entries: ReadonlyArray<{
        readonly relativePath: string;
        readonly kind: "file" | "directory";
        readonly content?: Uint8Array;
      }>;
    };

export interface MossFilesystemCapabilityInput {
  readonly cwd: string;
  readonly canonicalRoot: MossCanonicalRootDescriptor;
  readonly projectId: string;
  readonly workspaceId: string;
  /** Optional explicit owner binding; older injected capability doubles may omit it. */
  readonly ownerId?: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly targetPath: string;
  /** Required for create/publish/replace; remove has no private payload. */
  readonly stage?: MossPrivateStage;
  readonly operationId: string;
  readonly kind: MossResourceImportKind;
  /** Fencing is supplied by the ownership lock and is never client-selected. */
  readonly fencingToken: string;
  readonly generation: string;
  readonly nonce: string;
  readonly expected: MossFilesystemIdentity;
  readonly expectedFingerprint: string;
  readonly expectedBeforeHash: string;
  readonly expectedAfter?: MossFilesystemIdentity;
  readonly expectedAfterHash?: string;
}

export interface MossFilesystemCapabilityReceipt {
  readonly canonicalRoot: MossCanonicalRootDescriptor;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly ownerId?: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly operationId: string;
  readonly fencingToken: string;
  readonly generation: string;
  readonly nonce: string;
  readonly expected: MossFilesystemIdentity;
  readonly expectedAfter?: MossFilesystemIdentity;
  readonly observed: MossFilesystemIdentity;
  readonly afterHash: string;
  readonly durableObservedFingerprint: string;
  readonly durable: true;
}

export interface MossFilesystemCapabilityResult {
  readonly observed: MossFilesystemIdentity;
  readonly afterHash: string;
  readonly durableObservedFingerprint: string;
  readonly receipt: MossFilesystemCapabilityReceipt;
}

export interface MossFilesystemCapability {
  readonly create: (
    input: MossFilesystemCapabilityInput,
  ) => Promise<MossFilesystemCapabilityResult>;
  readonly publish: (
    input: MossFilesystemCapabilityInput,
  ) => Promise<MossFilesystemCapabilityResult>;
  readonly replace: (
    input: MossFilesystemCapabilityInput,
  ) => Promise<MossFilesystemCapabilityResult>;
  readonly remove: (
    input: MossFilesystemCapabilityInput,
  ) => Promise<MossFilesystemCapabilityResult>;
}

export interface MossOwnershipLockInput {
  readonly cwd: string;
  readonly ownerId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly nonce: string;
}

export interface MossOwnershipLock {
  readonly ownerId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly nonce: string;
  readonly fencingToken: string;
  readonly generation: string;
  readonly sessionId: string;
  /** Must be idempotent and must not release a newer fencing token. */
  readonly release: () => Promise<void>;
}

export interface MossStateBudgetInput {
  readonly maxBytes: number;
  readonly maxEntries: number;
}

export interface MossPrivateManifestInput {
  readonly fileName: string;
  readonly transactionId: string;
  /** The store allocates and verifies sequence, previousHash, and recordHash. */
  readonly value: unknown;
  readonly ownerId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly stateFingerprint: string;
  readonly nonce: string;
}

export interface MossPrivateManifestReceipt {
  readonly locator: string;
  readonly transactionId: string;
  readonly sequence: number;
  readonly previousHash: string;
  readonly recordHash: string;
  readonly ownerId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly stateFingerprint: string;
  readonly nonce: string;
  readonly value: unknown;
}

export interface MossPrivateManifest {
  readonly locator: string;
  readonly transactionId: string;
  readonly sequence: number;
  readonly previousHash: string;
  readonly recordHash: string;
  readonly ownerId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly stateFingerprint: string;
  readonly nonce: string;
  readonly value: unknown;
}

export interface MossPrivateRecordCompactionInput {
  /** The exact live store fencing lease held by the caller's mutation. */
  readonly lock: MossOwnershipLock;
  readonly fileName: string;
  readonly expectedSequence: number;
  readonly expectedRecordHash: string;
  readonly ownerId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly stateFingerprint: string;
  readonly nonce: string;
}

export interface MossPrivateRecordCompactionReceipt {
  readonly fileName: string;
  readonly compactedSequence: number;
  readonly compactedRecordHash: string;
  readonly tombstoneDigest: string;
}

export interface MossPrivateManifestReadInput {
  readonly fileName: string;
}

export interface MossPrivateSnapshotPublishInput {
  readonly stage: MossPrivateStage;
  /** Current server-owned authority; the store must bind it into the seal. */
  readonly authority: MossPrivateSnapshotAuthority;
  readonly kind: MossResourceImportKind;
  readonly snapshotSha256: string;
  /** Authority-scoped content key; the store derives the private filesystem target. */
  readonly snapshotKey: string;
  readonly manifest: unknown;
}

export interface MossPrivateSnapshotAuthority {
  readonly canonicalRoot: string;
  readonly stateRoot: string;
  readonly ownerId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly transactionId: string;
  readonly operationId: string;
  readonly fencingToken: string;
  readonly generation: string;
  readonly nonce: string;
  readonly kind: MossResourceImportKind;
  readonly snapshotSha256: string;
}

export interface MossPrivateSnapshotReceipt {
  /** Opaque locator for consumers; the path is retained for the server wire protocol. */
  readonly snapshotLocator: string;
  readonly snapshotPath: string;
  readonly snapshotSha256: string;
  readonly revision: string;
  readonly payloadBytes: number;
  readonly durable: true;
  readonly sealed: true;
}

export interface MossPrivateStageRecoveryInput {
  /** Current server-owned state root; the store must bind recovery to it. */
  readonly stateRoot: string;
  /** Current server-canonical absolute root; every stage must match it. */
  readonly canonicalRoot: string;
}

/** Server-owned private state seam. `stateRoot` is intentionally absent. */
export interface MossOwnershipStore {
  readonly acquireLock: (input: MossOwnershipLockInput) => Promise<MossOwnershipLock>;
  readonly assertStateBudget: (input: MossStateBudgetInput) => Promise<void>;
  readonly createPrivateStage: (input: MossPrivateStageInput) => Promise<MossPrivateStage>;
  /** Reads an authority-owned stage without exposing its private path. */
  readonly readPrivateStage?: (input: {
    readonly stage: MossPrivateStage;
  }) => Promise<MossPrivateStagePayload>;
  /** Writes an immutable frozen payload into an already-created private stage. */
  readonly writePrivateStage?: (input: {
    readonly stage: MossPrivateStage;
    readonly payload: MossPrivateStagePayload;
  }) => Promise<void>;
  readonly appendPrivateManifest: (
    input: MossPrivateManifestInput,
  ) => Promise<MossPrivateManifestReceipt>;
  readonly readPrivateManifest: (
    input: MossPrivateManifestReadInput,
  ) => Promise<MossPrivateManifest | null>;
  /** Append-only v3 records used for journals, receipts, and other authority state. */
  readonly appendPrivateRecord: (
    input: MossPrivateManifestInput,
  ) => Promise<MossPrivateManifestReceipt>;
  readonly readPrivateRecord: (
    input: MossPrivateManifestReadInput,
  ) => Promise<MossPrivateManifest | null>;
  /** Removes one authority-owned immutable record chain after an expected-head CAS. */
  readonly compactPrivateRecord?: (
    input: MossPrivateRecordCompactionInput,
  ) => Promise<MossPrivateRecordCompactionReceipt>;
  /** Lists authority-owned record locators; callers never scan/sort state files. */
  readonly listPrivateRecords: (input: { readonly prefix: string }) => Promise<readonly string[]>;
  /** Publishes only a complete, sealed, content-addressed private snapshot. */
  readonly publishPrivateSnapshot: (
    input: MossPrivateSnapshotPublishInput,
  ) => Promise<MossPrivateSnapshotReceipt>;
  /** Removes only proven private stages; canonical/user files are out of scope. */
  readonly recoverPrivateStages: (input: MossPrivateStageRecoveryInput) => Promise<void>;
}
