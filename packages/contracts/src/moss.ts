import { Schema } from "effect";
import {
  EventId,
  IsoDateTime,
  NonNegativeInt,
  RuntimeSessionId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas";
import {
  ProviderApprovalPolicy,
  ProviderKind,
  ProviderSandboxMode,
  RuntimeMode,
} from "./orchestration";
import {
  ProviderPluginAppSummary,
  ProviderPluginAuthPolicy,
  ProviderPluginInterface,
  ProviderSkillDescriptor,
} from "./providerDiscovery";

const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;

export const MOSS_CONTROL_PLANE_VERSION = 1 as const;

export const MossConfigProjectionTarget = Schema.Literals([
  "moss",
  "codex",
  "claude",
  "hermes",
  "acp",
  "custom-cli",
]);
export type MossConfigProjectionTarget = typeof MossConfigProjectionTarget.Type;

export const MossConfigSourceKind = Schema.Literals([
  "canonical",
  "project",
  "user",
  "environment",
  "provider",
  "generated",
]);
export type MossConfigSourceKind = typeof MossConfigSourceKind.Type;

export const MossConfigSource = Schema.Struct({
  kind: MossConfigSourceKind,
  path: Schema.optional(TrimmedNonEmptyStringSchema),
  required: Schema.optional(Schema.Boolean),
  hash: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type MossConfigSource = typeof MossConfigSource.Type;

export const MossConfigEntry = Schema.Struct({
  name: TrimmedNonEmptyStringSchema,
  source: Schema.optional(TrimmedNonEmptyStringSchema),
  enabled: Schema.optional(Schema.Boolean),
  metadata: Schema.optional(UnknownRecordSchema),
});
export type MossConfigEntry = typeof MossConfigEntry.Type;

export const MossToolPolicy = Schema.Struct({
  allow: Schema.Array(TrimmedNonEmptyStringSchema),
  deny: Schema.Array(TrimmedNonEmptyStringSchema),
});
export type MossToolPolicy = typeof MossToolPolicy.Type;

export const MossLaunchPlanPermissions = Schema.Struct({
  runtimeMode: RuntimeMode,
  approvalPolicy: ProviderApprovalPolicy,
  sandboxMode: ProviderSandboxMode,
});
export type MossLaunchPlanPermissions = typeof MossLaunchPlanPermissions.Type;

export const MossLaunchPlanEnvironmentVariable = Schema.Struct({
  key: TrimmedNonEmptyStringSchema,
  redacted: Schema.Boolean,
  valueHash: Schema.optional(TrimmedNonEmptyStringSchema),
  source: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type MossLaunchPlanEnvironmentVariable = typeof MossLaunchPlanEnvironmentVariable.Type;

export const MossLaunchPlanEnvironment = Schema.Struct({
  variables: Schema.Array(MossLaunchPlanEnvironmentVariable),
});
export type MossLaunchPlanEnvironment = typeof MossLaunchPlanEnvironment.Type;

export const MossLaunchPlanWorkspace = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  projectId: Schema.optional(TrimmedNonEmptyStringSchema),
  threadId: Schema.optional(ThreadId),
});
export type MossLaunchPlanWorkspace = typeof MossLaunchPlanWorkspace.Type;

export const MossLaunchPlan = Schema.Struct({
  version: Schema.Literal(MOSS_CONTROL_PLANE_VERSION),
  planId: TrimmedNonEmptyStringSchema,
  planHash: TrimmedNonEmptyStringSchema,
  createdAt: IsoDateTime,
  provider: ProviderKind,
  model: Schema.NullOr(TrimmedNonEmptyStringSchema),
  workspace: MossLaunchPlanWorkspace,
  environment: MossLaunchPlanEnvironment,
  permissions: MossLaunchPlanPermissions,
  mcp: Schema.Array(MossConfigEntry),
  skills: Schema.Array(MossConfigEntry),
  memory: Schema.Array(MossConfigEntry),
  hooks: Schema.Array(MossConfigEntry),
  tools: MossToolPolicy,
  providerStartOptions: Schema.optional(UnknownRecordSchema),
  configSources: Schema.Array(MossConfigSource),
  projectionWarnings: Schema.Array(TrimmedNonEmptyStringSchema),
  /**
   * Stable fingerprint of the `.moss` workspace projection materialized just
   * before the provider session (re)started (SY3). Present only when the
   * runtime refreshed on-disk projections during launch-plan compilation; the
   * value is also carried as a `kind: "generated"` {@link MossConfigSource} so
   * the surrounding `planHash` covers it, and it is recomputable by re-running
   * the shared projection materializer over the live workspace.
   */
  projectionFingerprint: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type MossLaunchPlan = typeof MossLaunchPlan.Type;

export const MossCanonicalConfig = Schema.Struct({
  version: Schema.Literal(MOSS_CONTROL_PLANE_VERSION),
  name: TrimmedNonEmptyStringSchema,
  defaultProvider: ProviderKind,
  providers: Schema.Record(TrimmedNonEmptyStringSchema, UnknownRecordSchema),
  mcp: Schema.Array(MossConfigEntry),
  skills: Schema.Array(MossConfigEntry),
  memory: Schema.Array(MossConfigEntry),
  hooks: Schema.Array(MossConfigEntry),
  tools: MossToolPolicy,
  overlays: Schema.optional(UnknownRecordSchema),
});
export type MossCanonicalConfig = typeof MossCanonicalConfig.Type;

export const MossProjectionWarning = Schema.Struct({
  code: TrimmedNonEmptyStringSchema,
  message: TrimmedNonEmptyStringSchema,
  path: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type MossProjectionWarning = typeof MossProjectionWarning.Type;

export const MossProjectionWrite = Schema.Struct({
  action: Schema.Literals(["would-create", "would-update", "create", "update", "skip"]),
  path: TrimmedNonEmptyStringSchema,
  reason: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type MossProjectionWrite = typeof MossProjectionWrite.Type;

export const MossProjectionResult = Schema.Struct({
  target: MossConfigProjectionTarget,
  dryRun: Schema.Boolean,
  createdAt: IsoDateTime,
  sourceHash: TrimmedNonEmptyStringSchema,
  outputPath: Schema.optional(TrimmedNonEmptyStringSchema),
  rendered: UnknownRecordSchema,
  warnings: Schema.Array(MossProjectionWarning),
  writes: Schema.Array(MossProjectionWrite),
});
export type MossProjectionResult = typeof MossProjectionResult.Type;

export const MossProjectEventType = Schema.Literals([
  "moss.goal.defined",
  "moss.role.assigned",
  "moss.launch_plan.compiled",
  "moss.config.projected",
  "moss.session.event.normalized",
  "moss.task.started",
  "moss.evidence.recorded",
  "moss.review.completed",
  "moss.memory.updated",
  "moss.release.gated",
]);
export type MossProjectEventType = typeof MossProjectEventType.Type;

export const MossProjectActor = Schema.Struct({
  role: TrimmedNonEmptyStringSchema,
  id: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type MossProjectActor = typeof MossProjectActor.Type;

export const MossProjectEvent = Schema.Struct({
  eventId: EventId,
  type: MossProjectEventType,
  createdAt: IsoDateTime,
  actor: MossProjectActor,
  correlationId: Schema.optional(TrimmedNonEmptyStringSchema),
  causationEventId: Schema.optional(EventId),
  payload: UnknownRecordSchema,
  evidence: Schema.optional(Schema.Array(TrimmedNonEmptyStringSchema)),
});
export type MossProjectEvent = typeof MossProjectEvent.Type;

export const MossNormalizedSessionEventType = Schema.Literals([
  "text",
  "tool-call",
  "tool-result",
  "usage",
  "permission-request",
  "finish",
  "error",
]);
export type MossNormalizedSessionEventType = typeof MossNormalizedSessionEventType.Type;

export const MossNormalizedSessionEvent = Schema.Struct({
  eventId: EventId,
  type: MossNormalizedSessionEventType,
  provider: ProviderKind,
  sessionId: RuntimeSessionId,
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
  rawEventId: Schema.optional(EventId),
  payload: UnknownRecordSchema,
});
export type MossNormalizedSessionEvent = typeof MossNormalizedSessionEvent.Type;

export const MossSubscribeNormalizedSessionEventsInput = Schema.Struct({
  threadId: ThreadId,
  afterEventId: Schema.optional(EventId),
  limit: Schema.optional(NonNegativeInt),
});
export type MossSubscribeNormalizedSessionEventsInput =
  typeof MossSubscribeNormalizedSessionEventsInput.Type;

// ── Projection materializer provenance (SY2) ────────────────────────────────
//
// Schema for the projections manifest (shared layout key `projectionsManifest`),
// the provenance ledger written by the shared projection materializer. Ported from the 1code
// `moss-source/projection.ts` manifest shape with moss engine ids
// (`ProviderKind` instead of 1code AgentEngineId). Schema-only: the runtime
// read/write logic lives in `@synara/shared/mossProjectionMaterializer`.

export const MossProjectionAction = Schema.Literals([
  "native",
  "symlink",
  "copy",
  "prompt-inject",
  "adapter-inject",
  "managed-bridge",
  "unsupported",
]);
export type MossProjectionAction = typeof MossProjectionAction.Type;

export const MossProjectionMaterializeStatus = Schema.Literals([
  "created",
  "updated",
  "skipped",
  "conflict",
  "unsupported",
]);
export type MossProjectionMaterializeStatus = typeof MossProjectionMaterializeStatus.Type;

export const MossProjectionManifestContributor = Schema.Struct({
  resourceId: TrimmedNonEmptyStringSchema,
  sourcePath: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type MossProjectionManifestContributor = typeof MossProjectionManifestContributor.Type;

export const MossProjectionManifestEntry = Schema.Struct({
  engineId: ProviderKind,
  resourceId: TrimmedNonEmptyStringSchema,
  action: MossProjectionAction,
  sourcePath: Schema.optional(TrimmedNonEmptyStringSchema),
  targetPath: TrimmedNonEmptyStringSchema,
  contentHash: Schema.optional(TrimmedNonEmptyStringSchema),
  updatedAt: IsoDateTime,
  /**
   * Every resource that contributed to this target. A single managed-bridge or
   * adapter-inject target (for example `.codex/config.toml`, which carries the
   * mcp bridge and the provider routing bridge) fans in from multiple source
   * resources; the top-level resourceId/sourcePath only reflect the last
   * writer. Recording the full contributor list lets the remover reclaim
   * exactly the resource being removed while other contributors remain.
   */
  contributors: Schema.optional(Schema.Array(MossProjectionManifestContributor)),
});
export type MossProjectionManifestEntry = typeof MossProjectionManifestEntry.Type;

export const MossProjectionManifest = Schema.Struct({
  version: Schema.Literal(MOSS_CONTROL_PLANE_VERSION),
  generatedAt: IsoDateTime,
  entries: Schema.Record(Schema.String, MossProjectionManifestEntry),
});
export type MossProjectionManifest = typeof MossProjectionManifest.Type;

// ── Moss canonical resource creation ─────────────────────────────────────────
// The uniform "Create" surface writes a canonical artifact under `.moss/` (the
// single source of truth). Existing discovery makes it visible everywhere: the
// skills catalog cross-scans `.moss/skills` for every engine, and `.moss/mcp/
// config.json` is injected into Codex/Claude sessions. `plugin` seeds the new
// `.moss/plugins` track. The optional `provider` records which agent the author
// was targeting (for future explicit projection); recognition is automatic.
export const MossCreateResourceKind = Schema.Literals(["skill", "plugin", "mcp"]);
export type MossCreateResourceKind = typeof MossCreateResourceKind.Type;

/** Server-issued identifiers for an immutable canonical mutation plan. */
export const MossCanonicalMutationPlanId = TrimmedNonEmptyStringSchema.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u),
);
export type MossCanonicalMutationPlanId = typeof MossCanonicalMutationPlanId.Type;

export const MossCanonicalMutationOperationId = TrimmedNonEmptyStringSchema.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u),
);
export type MossCanonicalMutationOperationId = typeof MossCanonicalMutationOperationId.Type;

const MossCanonicalMutationIdempotencyKey = TrimmedNonEmptyStringSchema.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u),
);

export const MossCanonicalResourceMutationAction = Schema.Literals(["create", "delete", "update"]);
export type MossCanonicalResourceMutationAction = typeof MossCanonicalResourceMutationAction.Type;

/** Full intent accepted only by the server-side plan RPC. */
export const MossCanonicalResourceMutationPayload = Schema.Struct({
  kind: MossCreateResourceKind,
  cwd: TrimmedNonEmptyStringSchema,
  name: TrimmedNonEmptyStringSchema,
  description: Schema.optional(TrimmedNonEmptyStringSchema),
  provider: Schema.optional(ProviderKind),
  command: Schema.optional(TrimmedNonEmptyStringSchema),
  args: Schema.optional(Schema.Array(TrimmedNonEmptyStringSchema)),
  url: Schema.optional(TrimmedNonEmptyStringSchema),
  plugin: Schema.optional(
    Schema.Struct({
      id: Schema.optional(TrimmedNonEmptyStringSchema),
      marketplaceName: Schema.optional(TrimmedNonEmptyStringSchema),
      marketplacePath: Schema.optional(TrimmedNonEmptyStringSchema),
      sourcePath: Schema.optional(TrimmedNonEmptyStringSchema),
      authPolicy: Schema.optional(ProviderPluginAuthPolicy),
      interface: Schema.optional(ProviderPluginInterface),
      apps: Schema.optional(Schema.Array(ProviderPluginAppSummary)),
      skills: Schema.optional(Schema.Array(ProviderSkillDescriptor)),
      mcpServers: Schema.optional(Schema.Array(TrimmedNonEmptyStringSchema)),
    }),
  ),
  path: Schema.optional(TrimmedNonEmptyStringSchema),
  enabled: Schema.optional(Schema.Boolean),
});
export type MossCanonicalResourceMutationPayload = typeof MossCanonicalResourceMutationPayload.Type;
export type MossCreateResourcePayload = Omit<MossCanonicalResourceMutationPayload, "enabled">;
export type MossDeleteResourcePayload = Omit<MossCanonicalResourceMutationPayload, "enabled">;
export type MossUpdateResourcePayload = MossCanonicalResourceMutationPayload & {
  readonly enabled: boolean;
};

export const MossCanonicalResourceMutationPrepareInput = Schema.Struct({
  action: MossCanonicalResourceMutationAction,
  ...MossCanonicalResourceMutationPayload.fields,
});
export type MossCanonicalResourceMutationPrepareInput =
  typeof MossCanonicalResourceMutationPrepareInput.Type;

export const MossCanonicalResourceMutationPlanResult = Schema.Struct({
  planId: MossCanonicalMutationPlanId,
  operationId: MossCanonicalMutationOperationId,
  planHash: TrimmedNonEmptyStringSchema.check(Schema.isPattern(/^[a-f0-9]{64}$/i)),
  expiresAt: IsoDateTime,
});
export type MossCanonicalResourceMutationPlanResult =
  typeof MossCanonicalResourceMutationPlanResult.Type;

export const MossCreateResourceInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  planId: MossCanonicalMutationPlanId,
  operationId: MossCanonicalMutationOperationId,
});
export type MossCreateResourceInput = typeof MossCreateResourceInput.Type;

export const MossCanonicalResourceMutationReceipt = Schema.Struct({
  schemaVersion: Schema.Literal(3),
  transactionId: TrimmedNonEmptyStringSchema,
  operationId: TrimmedNonEmptyStringSchema,
  /** Server-validated intent identity, bound to the authenticated RPC context. */
  idempotencyKey: MossCanonicalMutationIdempotencyKey,
  planHash: TrimmedNonEmptyStringSchema.check(Schema.isPattern(/^[a-f0-9]{64}$/i)),
  canonicalRoot: Schema.Struct({
    rootPath: TrimmedNonEmptyStringSchema,
    identityFingerprint: TrimmedNonEmptyStringSchema.check(Schema.isPattern(/^[a-f0-9]{64}$/i)),
    ownerId: TrimmedNonEmptyStringSchema,
    projectId: TrimmedNonEmptyStringSchema,
    workspaceId: TrimmedNonEmptyStringSchema,
    principalId: TrimmedNonEmptyStringSchema,
    sessionId: TrimmedNonEmptyStringSchema,
  }),
  targetPath: TrimmedNonEmptyStringSchema,
  expectedBefore: Schema.Struct({
    identityFingerprint: TrimmedNonEmptyStringSchema,
    hash: TrimmedNonEmptyStringSchema.check(Schema.isPattern(/^[a-f0-9]{64}$/i)),
  }),
  expectedAfter: Schema.Struct({
    identityFingerprint: TrimmedNonEmptyStringSchema,
    hash: TrimmedNonEmptyStringSchema.check(Schema.isPattern(/^[a-f0-9]{64}$/i)),
  }),
  observed: Schema.Struct({
    identityFingerprint: TrimmedNonEmptyStringSchema,
    hash: TrimmedNonEmptyStringSchema.check(Schema.isPattern(/^[a-f0-9]{64}$/i)),
  }),
  fencingToken: TrimmedNonEmptyStringSchema,
  generation: TrimmedNonEmptyStringSchema,
  nonce: TrimmedNonEmptyStringSchema,
  manifest: Schema.Struct({
    fileName: TrimmedNonEmptyStringSchema,
    sequence: Schema.Int,
    previousHash: TrimmedNonEmptyStringSchema.check(Schema.isPattern(/^[a-f0-9]{64}$/i)),
    recordHash: TrimmedNonEmptyStringSchema.check(Schema.isPattern(/^[a-f0-9]{64}$/i)),
  }),
  durable: Schema.Literal(true),
  afterState: Schema.Array(
    Schema.Struct({
      operationId: TrimmedNonEmptyStringSchema,
      targetPath: TrimmedNonEmptyStringSchema,
      state: Schema.Literals(["present", "absent"]),
      afterHash: TrimmedNonEmptyStringSchema.check(Schema.isPattern(/^[a-f0-9]{64}$/i)),
      durable: Schema.Literal(true),
    }),
  ).check(Schema.isMaxLength(16)),
});
export type MossCanonicalResourceMutationReceipt = typeof MossCanonicalResourceMutationReceipt.Type;

export const MossCreateResourceResult = Schema.Struct({
  kind: MossCreateResourceKind,
  name: TrimmedNonEmptyStringSchema,
  /** Absolute path of the canonical artifact that was written. */
  path: TrimmedNonEmptyStringSchema,
  created: Schema.Boolean,
  receipt: Schema.optional(MossCanonicalResourceMutationReceipt),
});
export type MossCreateResourceResult = typeof MossCreateResourceResult.Type;

// Uninstall/remove a canonical Moss resource. Only Moss-canonical artifacts are
// deletable (skill dir under `.moss/skills`, plugin dir under `.moss/plugins`,
// or a server entry in `.moss/mcp/config.json`); provider-native copies are left
// untouched and the UI falls back to disabling them instead.
export const MossDeleteResourceInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  planId: MossCanonicalMutationPlanId,
  operationId: MossCanonicalMutationOperationId,
});
export type MossDeleteResourceInput = typeof MossDeleteResourceInput.Type;

export const MossDeleteResourceResult = Schema.Struct({
  kind: MossCreateResourceKind,
  name: TrimmedNonEmptyStringSchema,
  removed: Schema.Boolean,
  /** Absolute path (or config file) that was modified/removed. */
  path: Schema.optional(TrimmedNonEmptyStringSchema),
  receipt: Schema.optional(MossCanonicalResourceMutationReceipt),
});
export type MossDeleteResourceResult = typeof MossDeleteResourceResult.Type;

// Enable/disable a Moss-canonical plugin or MCP server. This is intentionally
// scoped to the portable `.moss` harness source, not provider-native configs.
export const MossUpdateResourceKind = Schema.Literals(["plugin", "mcp"]);
export type MossUpdateResourceKind = typeof MossUpdateResourceKind.Type;

export const MossUpdateResourceInput = Schema.Struct({
  cwd: TrimmedNonEmptyStringSchema,
  planId: MossCanonicalMutationPlanId,
  operationId: MossCanonicalMutationOperationId,
});
export type MossUpdateResourceInput = typeof MossUpdateResourceInput.Type;

export const MossUpdateResourceResult = Schema.Struct({
  kind: MossUpdateResourceKind,
  name: TrimmedNonEmptyStringSchema,
  enabled: Schema.Boolean,
  updated: Schema.Boolean,
  /** Absolute path (or config file) that was modified. */
  path: Schema.optional(TrimmedNonEmptyStringSchema),
  receipt: Schema.optional(MossCanonicalResourceMutationReceipt),
});
export type MossUpdateResourceResult = typeof MossUpdateResourceResult.Type;
