import { Effect, Option, Schema, SchemaIssue, SchemaTransformation, Struct } from "effect";
import {
  ProviderOptionSelections,
  AntigravityModelOptions,
  ClaudeModelOptions,
  CodexModelOptions,
  CursorModelOptions,
  DevinModelOptions,
  DroidModelOptions,
  GeminiModelOptions,
  GrokModelOptions,
  HermesModelOptions,
  KimiModelOptions,
  MinimaxModelOptions,
  ZcodeModelOptions,
  OpenCodeModelOptions,
  OmpModelOptions,
  PiModelOptions,
  DEFAULT_MODEL_BY_PROVIDER,
} from "./model";
import { ProviderInstanceId } from "./providerInstance";
import {
  LoadProjectImportHistoryInput,
  LoadProjectImportHistoryResult,
  ImportProjectInput,
  ImportProjectResult,
  ListProjectImportsInput,
  ListProjectImportsResult,
} from "./projectImport";
import { ProviderMentionReference, ProviderSkillReference } from "./providerDiscovery";
import { AsyncUserInput, AsyncUserInputQuestions, AsyncUserInputResponse } from "./asyncUserInput";
import { ProjectKind } from "./project";
import { ThreadMarker, ThreadMarkerId } from "./threadMarkers";
import { ClaudeCacheObservation } from "./claudeCache";
import {
  OrchestrationGetInlineVisualInput,
  OrchestrationGetInlineVisualResult,
} from "./inlineVisual";
import {
  ApprovalRequestId,
  CheckpointRef,
  CommandId,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProcessEnvRecord,
  ProjectId,
  SpaceId,
  ProviderItemId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas";

export const ORCHESTRATION_WS_METHODS = {
  getSnapshot: "orchestration.getSnapshot",
  getShellSnapshot: "orchestration.getShellSnapshot",
  getThreadDetailSnapshot: "orchestration.getThreadDetailSnapshot",
  searchThreads: "orchestration.searchThreads",
  dispatchCommand: "orchestration.dispatchCommand",
  settleTurnDispatch: "orchestration.settleTurnDispatch",
  importThread: "orchestration.importThread",
  listProjectImports: "orchestration.listProjectImports",
  importProject: "orchestration.importProject",
  loadProjectImportHistory: "orchestration.loadProjectImportHistory",
  regenerateThreadTitle: "orchestration.regenerateThreadTitle",
  predictNextMessage: "orchestration.predictNextMessage",
  repairState: "orchestration.repairState",
  getTurnDiff: "orchestration.getTurnDiff",
  getFullThreadDiff: "orchestration.getFullThreadDiff",
  getInlineVisual: "orchestration.getInlineVisual",
  replayEvents: "orchestration.replayEvents",
  listProviderDeliveryBlockers: "orchestration.listProviderDeliveryBlockers",
  reconcileProviderDelivery: "orchestration.reconcileProviderDelivery",
  prepareQuitResume: "orchestration.prepareQuitResume",
  subscribeShell: "orchestration.subscribeShell",
  unsubscribeShell: "orchestration.unsubscribeShell",
  subscribeThread: "orchestration.subscribeThread",
  unsubscribeThread: "orchestration.unsubscribeThread",
} as const;

export const ORCHESTRATION_WS_CHANNELS = {
  domainEvent: "orchestration.domainEvent",
  shellEvent: "orchestration.shellEvent",
  threadEvent: "orchestration.threadEvent",
} as const;

export const ProviderKind = Schema.Literals([
  "codex",
  "claudeAgent",
  "cursor",
  "gemini",
  "antigravity",
  "grok",
  "droid",
  "kilo",
  "opencode",
  "pi",
  "hermes",
  "devin",
  "omp",
  "kimi",
  "minimax",
  "zcode",
]);
export type ProviderKind = typeof ProviderKind.Type;
// Droid and Kilo remain in ProviderKind only so historical events and threads
// continue to decode. They are intentionally absent from every active runtime,
// discovery, settings, and creation surface.
export const RETIRED_PROVIDER_KINDS = ["droid", "kilo"] as const;
export type RetiredProviderKind = (typeof RETIRED_PROVIDER_KINDS)[number];
export const SUPPORTED_PROVIDER_KINDS = [
  "codex",
  "claudeAgent",
  "cursor",
  "gemini",
  "antigravity",
  "grok",
  "opencode",
  "pi",
  "hermes",
  "devin",
  "omp",
  "kimi",
  "minimax",
  "zcode",
] as const satisfies ReadonlyArray<ProviderKind>;
export const SupportedProviderKind = Schema.Literals(SUPPORTED_PROVIDER_KINDS);
export type SupportedProviderKind = typeof SupportedProviderKind.Type;
const supportedProviderKindSet = new Set<ProviderKind>(SUPPORTED_PROVIDER_KINDS);
export const isSupportedProviderKind = (value: unknown): value is SupportedProviderKind =>
  typeof value === "string" && supportedProviderKindSet.has(value as ProviderKind);

/** Legacy provider values are normalized only when decoding persisted payloads. */
export const LEGACY_PROVIDER_MIGRATIONS: Readonly<Record<string, ProviderKind>> = {
  kilo: "opencode",
};

export const PersistedProviderKind = Schema.String.pipe(
  Schema.decodeTo(
    ProviderKind,
    SchemaTransformation.transform({
      decode: (provider) => (LEGACY_PROVIDER_MIGRATIONS[provider] ?? provider) as ProviderKind,
      encode: (provider: ProviderKind) => provider as string,
    }),
  ),
);
export const ProviderApprovalPolicy = Schema.Literals([
  "untrusted",
  "on-failure",
  "on-request",
  "never",
]);
export type ProviderApprovalPolicy = typeof ProviderApprovalPolicy.Type;
export const ProviderSandboxMode = Schema.Literals([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
export type ProviderSandboxMode = typeof ProviderSandboxMode.Type;

const ProviderInstanceIdForDriver = (_provider: ProviderKind) =>
  Schema.optional(ProviderInstanceId);

const isProviderKindValue = Schema.is(ProviderKind);

function inferProviderFromInstanceId(instanceId: string): ProviderKind | undefined {
  if (isProviderKindValue(instanceId)) {
    return instanceId;
  }

  const lowerInstanceId = instanceId.toLowerCase();
  // Moss account ids are legacy aliases for the Codex managed gateway.
  if (
    lowerInstanceId === "moss" ||
    lowerInstanceId.startsWith("moss_") ||
    lowerInstanceId === "mossphone" ||
    lowerInstanceId.startsWith("mossphone_") ||
    lowerInstanceId === "moss_phone" ||
    lowerInstanceId.startsWith("moss_phone_") ||
    lowerInstanceId.startsWith("memfire")
  ) {
    return "codex";
  }
  if (lowerInstanceId.startsWith("claude")) {
    return "claudeAgent";
  }
  if (lowerInstanceId.startsWith("codex")) {
    return "codex";
  }
  if (lowerInstanceId.startsWith("cursor")) {
    return "cursor";
  }
  if (lowerInstanceId.startsWith("gemini")) {
    return "gemini";
  }
  if (lowerInstanceId.startsWith("hermes")) {
    return "hermes";
  }
  if (lowerInstanceId.startsWith("antigravity")) {
    return "antigravity";
  }
  if (lowerInstanceId.startsWith("grok")) {
    return "grok";
  }
  if (lowerInstanceId.startsWith("droid")) {
    return "droid";
  }
  if (lowerInstanceId.startsWith("kilo")) {
    return "opencode";
  }
  if (lowerInstanceId.startsWith("opencode") || lowerInstanceId.startsWith("open_code")) {
    return "opencode";
  }
  if (lowerInstanceId.startsWith("omp")) {
    return "omp";
  }
  if (lowerInstanceId.startsWith("pi")) {
    return "pi";
  }
  if (lowerInstanceId.startsWith("devin")) {
    return "devin";
  }
  if (lowerInstanceId.startsWith("kimi")) {
    return "kimi";
  }
  if (lowerInstanceId.startsWith("minimax") || lowerInstanceId.startsWith("mcode")) {
    return "minimax";
  }
  if (lowerInstanceId.startsWith("zcode")) {
    return "zcode";
  }
  return undefined;
}

function inferProviderFromModel(model: string): ProviderKind {
  const lowerModel = model.toLowerCase();
  if (
    lowerModel.includes("claude") ||
    lowerModel.includes("sonnet") ||
    lowerModel.includes("opus") ||
    lowerModel.includes("haiku")
  ) {
    return "claudeAgent";
  }
  if (lowerModel.includes("gemini")) {
    return "gemini";
  }
  if (lowerModel.includes("grok")) {
    return "grok";
  }
  if (lowerModel.includes("devin")) {
    return "devin";
  }
  if (lowerModel.includes("opencode") || lowerModel.includes("open_code")) {
    return "opencode";
  }
  if (lowerModel.includes("kilo")) {
    return "opencode";
  }
  if (lowerModel.includes("cursor")) {
    return "cursor";
  }
  if (lowerModel.startsWith("pi/") || lowerModel.includes("/pi/")) {
    return "pi";
  }
  return "codex";
}

function inferProviderForModelSelection(input: {
  readonly provider?: unknown;
  readonly instanceId?: unknown;
  readonly model?: unknown;
}): ProviderKind | undefined {
  if (isProviderKindValue(input.provider)) {
    return input.provider;
  }
  if (typeof input.provider === "string") {
    const migrated = LEGACY_PROVIDER_MIGRATIONS[input.provider];
    if (migrated) {
      return migrated;
    }
  }
  if (typeof input.instanceId === "string") {
    const provider = inferProviderFromInstanceId(input.instanceId);
    if (provider) {
      return provider;
    }
  }
  return typeof input.model === "string" ? inferProviderFromModel(input.model) : undefined;
}

function defaultModelForProvider(provider: ProviderKind): string {
  // OMP, Kimi Code, MiniMax Code, and ZCode have no static default model; an
  // empty model fails the per-provider schema below instead of inventing one.
  if (provider === "omp" || provider === "kimi" || provider === "minimax" || provider === "zcode")
    return "";
  if (provider === "pi" || provider === "hermes") return "openai/gpt-5.5";
  // Retired providers keep decoding but fall back to the Codex default.
  if (!isSupportedProviderKind(provider)) return DEFAULT_MODEL_BY_PROVIDER.codex;
  return DEFAULT_MODEL_BY_PROVIDER[provider];
}

export const CodexModelSelection = Schema.Struct({
  provider: Schema.Literal("codex"),
  instanceId: ProviderInstanceIdForDriver("codex"),
  model: TrimmedNonEmptyString,
  options: Schema.optional(CodexModelOptions),
});
export type CodexModelSelection = typeof CodexModelSelection.Type;

export const ClaudeModelSelection = Schema.Struct({
  provider: Schema.Literal("claudeAgent"),
  instanceId: ProviderInstanceIdForDriver("claudeAgent"),
  model: TrimmedNonEmptyString,
  options: Schema.optional(ClaudeModelOptions),
  supportsAutoMode: Schema.optional(Schema.Boolean),
});
export type ClaudeModelSelection = typeof ClaudeModelSelection.Type;

export const CursorModelSelection = Schema.Struct({
  provider: Schema.Literal("cursor"),
  instanceId: ProviderInstanceIdForDriver("cursor"),
  model: TrimmedNonEmptyString,
  options: Schema.optional(CursorModelOptions),
});
export type CursorModelSelection = typeof CursorModelSelection.Type;

export const AntigravityModelSelection = Schema.Struct({
  provider: Schema.Literal("antigravity"),
  instanceId: ProviderInstanceIdForDriver("antigravity"),
  model: TrimmedNonEmptyString,
  options: Schema.optional(AntigravityModelOptions),
});
export type AntigravityModelSelection = typeof AntigravityModelSelection.Type;

export const GrokModelSelection = Schema.Struct({
  provider: Schema.Literal("grok"),
  instanceId: ProviderInstanceIdForDriver("grok"),
  model: TrimmedNonEmptyString,
  options: Schema.optional(GrokModelOptions),
});
export type GrokModelSelection = typeof GrokModelSelection.Type;

export const GeminiModelSelection = Schema.Struct({
  provider: Schema.Literal("gemini"),
  instanceId: ProviderInstanceIdForDriver("gemini"),
  model: TrimmedNonEmptyString,
  options: Schema.optional(GeminiModelOptions),
});
export type GeminiModelSelection = typeof GeminiModelSelection.Type;

export const HermesModelSelection = Schema.Struct({
  provider: Schema.Literal("hermes"),
  instanceId: ProviderInstanceIdForDriver("hermes"),
  model: TrimmedNonEmptyString,
  options: Schema.optional(HermesModelOptions),
});
export type HermesModelSelection = typeof HermesModelSelection.Type;

export const DroidModelSelection = Schema.Struct({
  provider: Schema.Literal("droid"),
  instanceId: ProviderInstanceIdForDriver("droid"),
  model: TrimmedNonEmptyString,
  options: Schema.optional(DroidModelOptions),
});
export type DroidModelSelection = typeof DroidModelSelection.Type;

export const OpenCodeModelSelection = Schema.Struct({
  provider: Schema.Literal("opencode"),
  instanceId: ProviderInstanceIdForDriver("opencode"),
  model: TrimmedNonEmptyString,
  options: Schema.optional(OpenCodeModelOptions),
});
export type OpenCodeModelSelection = typeof OpenCodeModelSelection.Type;

export const PiModelSelection = Schema.Struct({
  provider: Schema.Literal("pi"),
  instanceId: ProviderInstanceIdForDriver("pi"),
  model: TrimmedNonEmptyString,
  options: Schema.optional(PiModelOptions),
});
export type PiModelSelection = typeof PiModelSelection.Type;
export const OmpModelSelection = Schema.Struct({
  provider: Schema.Literal("omp"),
  instanceId: ProviderInstanceIdForDriver("omp"),
  model: TrimmedNonEmptyString,
  options: Schema.optional(OmpModelOptions),
});
export type OmpModelSelection = typeof OmpModelSelection.Type;

export const DevinModelSelection = Schema.Struct({
  provider: Schema.Literal("devin"),
  instanceId: ProviderInstanceIdForDriver("devin"),
  model: TrimmedNonEmptyString,
  options: Schema.optional(DevinModelOptions),
});
export type DevinModelSelection = typeof DevinModelSelection.Type;

export const KimiModelSelection = Schema.Struct({
  provider: Schema.Literal("kimi"),
  instanceId: ProviderInstanceIdForDriver("kimi"),
  model: TrimmedNonEmptyString,
  options: Schema.optional(KimiModelOptions),
});
export type KimiModelSelection = typeof KimiModelSelection.Type;

export const MinimaxModelSelection = Schema.Struct({
  provider: Schema.Literal("minimax"),
  instanceId: ProviderInstanceIdForDriver("minimax"),
  model: TrimmedNonEmptyString,
  options: Schema.optional(MinimaxModelOptions),
});
export type MinimaxModelSelection = typeof MinimaxModelSelection.Type;

export const ZcodeModelSelection = Schema.Struct({
  provider: Schema.Literal("zcode"),
  instanceId: ProviderInstanceIdForDriver("zcode"),
  model: TrimmedNonEmptyString,
  options: Schema.optional(ZcodeModelOptions),
});
export type ZcodeModelSelection = typeof ZcodeModelSelection.Type;

const ModelSelectionByProvider = Schema.Union([
  CodexModelSelection,
  ClaudeModelSelection,
  CursorModelSelection,
  DevinModelSelection,
  AntigravityModelSelection,
  GrokModelSelection,
  GeminiModelSelection,
  HermesModelSelection,
  DroidModelSelection,
  OpenCodeModelSelection,
  PiModelSelection,
  OmpModelSelection,
  KimiModelSelection,
  MinimaxModelSelection,
  ZcodeModelSelection,
]);

// Keep persisted inputs loose so malformed or mixed legacy drafts reach the
// transform; the discriminated target union remains the canonical contract.
const ModelSelectionJsonValue: Schema.Codec<unknown, unknown> = Schema.Json.pipe(
  Schema.decodeTo(
    Schema.Unknown,
    SchemaTransformation.transform({
      decode: (value): unknown => value,
      encode: (value): Schema.Json => value as Schema.Json,
    }),
  ),
);

const ModelSelectionSource = Schema.Struct({
  provider: Schema.optional(ModelSelectionJsonValue),
  instanceId: Schema.optional(ModelSelectionJsonValue),
  model: Schema.optional(ModelSelectionJsonValue),
  options: Schema.optional(ModelSelectionJsonValue),
  supportsAutoMode: Schema.optional(ModelSelectionJsonValue),
});

function normalizeLegacyModelSelectionOptions(input: unknown): unknown {
  if (!Array.isArray(input)) {
    return input;
  }
  const record: Record<string, string | boolean> = {};
  for (const entry of input) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, value } = entry as { readonly id?: unknown; readonly value?: unknown };
    if (typeof id !== "string" || id.length === 0) continue;
    if (typeof value === "string" || typeof value === "boolean") {
      record[id] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      record[id] = String(value);
    }
  }
  return Object.keys(record).length > 0 ? record : undefined;
}

export const ModelSelection: Schema.Codec<typeof ModelSelectionByProvider.Type, unknown> =
  ModelSelectionSource.pipe(
    Schema.decodeTo(
      ModelSelectionByProvider,
      SchemaTransformation.transformOrFail({
        decode: (raw) => {
          const provider = inferProviderForModelSelection(raw) ?? "codex";
          const model =
            typeof raw.model === "string" && raw.model.trim().length > 0
              ? raw.model
              : defaultModelForProvider(provider);
          const instanceId =
            typeof raw.instanceId === "string" && raw.instanceId.trim().length > 0
              ? raw.instanceId.trim()
              : provider;
          const base: Record<string, unknown> = {
            provider,
            instanceId,
            model,
          };
          // Legacy Moss payloads stored options as an ordered
          // [{ id, value }] array; canonicalize to the record form the
          // per-provider selection structs decode.
          const normalizedOptions = normalizeLegacyModelSelectionOptions(raw.options);
          if (normalizedOptions !== undefined) {
            base.options = normalizedOptions;
          }
          if (raw.supportsAutoMode !== undefined) {
            base.supportsAutoMode = raw.supportsAutoMode;
          }
          return Effect.succeed(base as typeof ModelSelectionByProvider.Encoded);
        },
        encode: (value) => Effect.succeed(value as typeof ModelSelectionSource.Encoded),
      }),
    ),
  );
export type ModelSelection = typeof ModelSelection.Type;

export const CodexProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  homePath: Schema.optional(TrimmedNonEmptyString),
  shadowHomePath: Schema.optional(TrimmedNonEmptyString),
  accountId: Schema.optional(TrimmedNonEmptyString),
  runtimeGeneration: Schema.optional(TrimmedNonEmptyString),
  environment: Schema.optional(ProcessEnvRecord),
});

export const ClaudeProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  homePath: Schema.optional(TrimmedNonEmptyString),
  permissionMode: Schema.optional(TrimmedNonEmptyString),
  maxThinkingTokens: Schema.optional(NonNegativeInt),
  enableArtifacts: Schema.optional(Schema.Boolean),
  environment: Schema.optional(ProcessEnvRecord),
});

export const GeminiProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  environment: Schema.optional(ProcessEnvRecord),
});

export const AntigravityProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  environment: Schema.optional(ProcessEnvRecord),
});

export const CursorProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  apiEndpoint: Schema.optional(TrimmedNonEmptyString),
  environment: Schema.optional(ProcessEnvRecord),
});

export const GrokProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  environment: Schema.optional(ProcessEnvRecord),
});

export const DroidProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  environment: Schema.optional(ProcessEnvRecord),
});

const OpenCodeProviderStartOptionsWire = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  serverUrl: Schema.optional(TrimmedNonEmptyString),
  serverPassword: Schema.optional(TrimmedNonEmptyString),
  experimentalWebSockets: Schema.optional(Schema.Boolean),
  environment: Schema.optional(ProcessEnvRecord),
});

const OpenCodeProviderStartOptionsInternal = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  serverUrl: Schema.optional(TrimmedNonEmptyString),
  serverPassword: Schema.optional(TrimmedNonEmptyString),
  experimentalWebSockets: Schema.optional(Schema.Boolean),
  environment: Schema.optional(ProcessEnvRecord),
});

// Passwords are accepted only for legacy wire compatibility. Decoding and
// encoding both remove them so provider secrets cannot cross a contract
// boundary; server-side instance resolution may still construct this internal
// type with a password before handing it directly to a provider adapter.
export const OpenCodeProviderStartOptions = OpenCodeProviderStartOptionsWire.pipe(
  Schema.decodeTo(
    OpenCodeProviderStartOptionsInternal,
    SchemaTransformation.transform<
      typeof OpenCodeProviderStartOptionsInternal.Encoded,
      typeof OpenCodeProviderStartOptionsWire.Type
    >({
      decode: ({ serverPassword: _serverPassword, ...options }) => options,
      encode: ({ serverPassword: _serverPassword, ...options }) => options,
    }),
  ),
);

const KiloProviderStartOptionsWire = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  serverUrl: Schema.optional(TrimmedNonEmptyString),
  serverPassword: Schema.optional(TrimmedNonEmptyString),
  environment: Schema.optional(ProcessEnvRecord),
});

const KiloProviderStartOptionsInternal = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  serverUrl: Schema.optional(TrimmedNonEmptyString),
  serverPassword: Schema.optional(TrimmedNonEmptyString),
  environment: Schema.optional(ProcessEnvRecord),
});

export const KiloProviderStartOptions = KiloProviderStartOptionsWire.pipe(
  Schema.decodeTo(
    KiloProviderStartOptionsInternal,
    SchemaTransformation.transform<
      typeof KiloProviderStartOptionsInternal.Encoded,
      typeof KiloProviderStartOptionsWire.Type
    >({
      decode: ({ serverPassword: _serverPassword, ...options }) => options,
      encode: ({ serverPassword: _serverPassword, ...options }) => options,
    }),
  ),
);
export const PiProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  agentDir: Schema.optional(TrimmedNonEmptyString),
  environment: Schema.optional(ProcessEnvRecord),
});

export const HermesProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  homePath: Schema.optional(TrimmedNonEmptyString),
  environment: Schema.optional(ProcessEnvRecord),
});

export const DevinProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  environment: Schema.optional(ProcessEnvRecord),
});

export const OmpProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  agentDir: Schema.optional(TrimmedNonEmptyString),
  environment: Schema.optional(ProcessEnvRecord),
});

// Shared by the generic ACP agent drivers (Kimi Code, MiniMax Code, ZCode).
// `homePath` is reserved for a Moss-managed private data dir; own-login
// instances leave it unset so the CLI keeps its real home.
export const AcpAgentProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  homePath: Schema.optional(TrimmedNonEmptyString),
  environment: Schema.optional(ProcessEnvRecord),
});
export type AcpAgentProviderStartOptions = typeof AcpAgentProviderStartOptions.Type;

export const ProviderStartOptions = Schema.Struct({
  codex: Schema.optional(CodexProviderStartOptions),
  claudeAgent: Schema.optional(ClaudeProviderStartOptions),
  cursor: Schema.optional(CursorProviderStartOptions),
  gemini: Schema.optional(GeminiProviderStartOptions),
  devin: Schema.optional(DevinProviderStartOptions),
  antigravity: Schema.optional(AntigravityProviderStartOptions),
  grok: Schema.optional(GrokProviderStartOptions),
  droid: Schema.optional(DroidProviderStartOptions),
  opencode: Schema.optional(OpenCodeProviderStartOptions),
  pi: Schema.optional(PiProviderStartOptions),
  hermes: Schema.optional(HermesProviderStartOptions),
  omp: Schema.optional(OmpProviderStartOptions),
  kimi: Schema.optional(AcpAgentProviderStartOptions),
  minimax: Schema.optional(AcpAgentProviderStartOptions),
  zcode: Schema.optional(AcpAgentProviderStartOptions),
});
export type ProviderStartOptions = typeof ProviderStartOptions.Type;

export const RuntimeMode = Schema.Literals(["approval-required", "auto", "full-access"]);
export type RuntimeMode = typeof RuntimeMode.Type;
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
export const ProviderInteractionMode = Schema.Literals(["default", "plan", "debug"]);
export type ProviderInteractionMode = typeof ProviderInteractionMode.Type;
export const DEFAULT_PROVIDER_INTERACTION_MODE: ProviderInteractionMode = "default";
export const CapacityRetryTrigger = Schema.Literals([
  "capacity_retry_manual",
  "capacity_retry_automatic",
]);
export type CapacityRetryTrigger = typeof CapacityRetryTrigger.Type;
export const ProviderTurnTrigger = Schema.Literals([
  "capacity_retry_manual",
  "capacity_retry_automatic",
  "resume_interrupted_task",
  "safety_buffer_retry",
]);
export type ProviderTurnTrigger = typeof ProviderTurnTrigger.Type;
const SidechatSourceThreadId = Schema.optional(Schema.NullOr(ThreadId)).pipe(
  Schema.withDecodingDefault(() => null),
);
const SidechatLifecycleTimestamp = Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
  Schema.withDecodingDefault(() => null),
);
/**
 * What a standalone sidechat is about. A sidechat either forks a source thread
 * (`sidechatSourceThreadId`) or, with no source thread, carries this context: today only a
 * GitHub pull request or issue asked about from the inbox. Identifiers only; the item's
 * title, body and comments reach the provider as untrusted data in the user's own message.
 */
export const ThreadSidechatContext = Schema.Struct({
  kind: Schema.Literal("github-item"),
  // Same literals as `GitHubInboxItemKind`; importing it here would create a module cycle.
  itemKind: Schema.Literals(["pullRequest", "issue"]),
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  url: TrimmedNonEmptyString,
});
export type ThreadSidechatContext = typeof ThreadSidechatContext.Type;
// Absent on every event and projection written before standalone sidechats existed.
const SidechatContextField = Schema.optional(Schema.NullOr(ThreadSidechatContext)).pipe(
  Schema.withDecodingDefault(() => null),
);
export const ProviderRequestKind = Schema.Literals([
  "command",
  "file-read",
  "file-change",
  "permissions",
  "tool",
  "computer-foreground",
]);
export type ProviderRequestKind = typeof ProviderRequestKind.Type;
export const AssistantDeliveryMode = Schema.Literals(["buffered", "streaming"]);
export type AssistantDeliveryMode = typeof AssistantDeliveryMode.Type;
// Queue is the default "send message" behavior; steer is an urgent redirect.
export const TurnDispatchMode = Schema.Literals(["queue", "steer"]);
export type TurnDispatchMode = typeof TurnDispatchMode.Type;
export const DEFAULT_TURN_DISPATCH_MODE: TurnDispatchMode = "queue";
// Marks who dispatched a user turn: a person typing, an automation run, or
// another agent through the Moss agent gateway (MCP tools).
// Absent is treated as "user"; only server-dispatched turns carry the flag.
export const MessageDispatchOrigin = Schema.Literals(["user", "automation", "agent"]);
export type MessageDispatchOrigin = typeof MessageDispatchOrigin.Type;
// "automation_run" marks only the per-run throwaway threads standalone automations
// create. Dedicated automations' own threads stay unmarked: they are persistent
// conversations the user keeps, not run artifacts.
export const ThreadCreationSource = Schema.Literals([
  "moss_mcp",
  "external_mcp",
  "provider_native",
  "automation_run",
]);
export type ThreadCreationSource = typeof ThreadCreationSource.Type;
export const ProviderReviewTarget = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("uncommittedChanges"),
  }),
  Schema.Struct({
    type: Schema.Literal("baseBranch"),
    branch: TrimmedNonEmptyString,
  }),
]);
export type ProviderReviewTarget = typeof ProviderReviewTarget.Type;
export const ProviderApprovalDecision = Schema.Literals([
  "accept",
  "acceptForSession",
  // A command prefix rule is `{ acceptWithExecpolicyAmendment: { execpolicy_amendment } }`,
  // not a second `acceptForSession`.
  "acceptWithExecpolicyAmendment",
  "decline",
  "cancel",
]);
export type ProviderApprovalDecision = typeof ProviderApprovalDecision.Type;
export const ProviderUserInputAnswer = Schema.NullOr(
  Schema.Union([Schema.String, Schema.Array(Schema.String)]),
);
export type ProviderUserInputAnswer = typeof ProviderUserInputAnswer.Type;
export const ProviderUserInputAnswers = Schema.Record(Schema.String, ProviderUserInputAnswer);
export type ProviderUserInputAnswers = typeof ProviderUserInputAnswers.Type;
export const ThreadHandoffBootstrapStatus = Schema.Literals(["pending", "completed"]);
export type ThreadHandoffBootstrapStatus = typeof ThreadHandoffBootstrapStatus.Type;
export const ThreadEnvironmentMode = Schema.Literals(["local", "worktree"]);
export type ThreadEnvironmentMode = typeof ThreadEnvironmentMode.Type;

export const OrchestrationMessageSource = Schema.Literals([
  "native",
  "async-user-input",
  "handoff-import",
  "fork-import",
]);
export type OrchestrationMessageSource = typeof OrchestrationMessageSource.Type;

export const PROVIDER_SEND_TURN_MAX_INPUT_CHARS = 120_000;
export const PROVIDER_SEND_TURN_MAX_ATTACHMENTS = 8;
export const PROVIDER_SEND_TURN_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
// Raw local images may exceed the provider-safe payload limit when they can be
// normalized on-device before upload (for example Retina PNG screenshots).
export const PROVIDER_SEND_TURN_MAX_IMAGE_IMPORT_BYTES = 32 * 1024 * 1024;
export const PROVIDER_SEND_TURN_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_PINNED_PROJECTS = 3;
const CHAT_ATTACHMENT_ID_MAX_CHARS = 128;
export const CHAT_ASSISTANT_SELECTION_TEXT_MAX_CHARS = 4_000;
export const THREAD_NOTES_MAX_CHARS = 16_384;
// Goals travel the same transport budget as turn input; anything longer than
// THREAD_GOAL_INLINE_MAX_CHARS is materialized to an on-disk file server-side
// and persisted as a "read this file" reference (Codex-style large-input
// handling), so the cap exists only to bound the wire payload.
export const THREAD_GOAL_MAX_CHARS = PROVIDER_SEND_TURN_MAX_INPUT_CHARS;
export const THREAD_GOAL_INLINE_MAX_CHARS = 1_000;
export const PINNED_MESSAGES_MAX_COUNT = 100;
export const PINNED_MESSAGE_LABEL_MAX_CHARS = 60;
// Correlation id is command id by design in this model.
export const CorrelationId = CommandId;
export type CorrelationId = typeof CorrelationId.Type;

const ChatAttachmentId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CHAT_ATTACHMENT_ID_MAX_CHARS),
  Schema.isPattern(/^[a-z0-9_-]+$/i),
);
export type ChatAttachmentId = typeof ChatAttachmentId.Type;

export const ChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
});
export type ChatImageAttachment = typeof ChatImageAttachment.Type;

export const ChatFileAttachment = Schema.Struct({
  type: Schema.Literal("file"),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_FILE_BYTES)),
});
export type ChatFileAttachment = typeof ChatFileAttachment.Type;

export const ChatAssistantSelectionAttachment = Schema.Struct({
  type: Schema.Literal("assistant-selection"),
  id: ChatAttachmentId,
  assistantMessageId: MessageId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(CHAT_ASSISTANT_SELECTION_TEXT_MAX_CHARS)),
});
export type ChatAssistantSelectionAttachment = typeof ChatAssistantSelectionAttachment.Type;

export const UploadChatAssistantSelectionAttachment = Schema.Struct({
  type: Schema.Literal("assistant-selection"),
  assistantMessageId: MessageId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(CHAT_ASSISTANT_SELECTION_TEXT_MAX_CHARS)),
});
export type UploadChatAssistantSelectionAttachment =
  typeof UploadChatAssistantSelectionAttachment.Type;

export const ChatAttachment = Schema.Union([
  ChatImageAttachment,
  ChatFileAttachment,
  ChatAssistantSelectionAttachment,
]);
export type ChatAttachment = typeof ChatAttachment.Type;
const ChatAttachmentList = Schema.Array(ChatAttachment).check(
  Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
);
const UploadChatAttachment = Schema.Union([
  ChatImageAttachment,
  ChatFileAttachment,
  UploadChatAssistantSelectionAttachment,
]);
export type UploadChatAttachment = typeof UploadChatAttachment.Type;
const UploadChatAttachmentList = Schema.Array(UploadChatAttachment).check(
  Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
);
const TurnMessageContentCheck = Schema.makeFilter(
  (input: { readonly text: string; readonly attachments: ReadonlyArray<unknown> }) =>
    input.text.trim().length > 0 ||
    input.attachments.length > 0 ||
    new SchemaIssue.InvalidValue(Option.some(input.text), {
      message: "Turn input must include text or attachments.",
    }),
  { identifier: "TurnMessageContent" },
);

export const ProjectScriptIcon = Schema.Literals([
  "play",
  "test",
  "lint",
  "configure",
  "build",
  "debug",
]);
export type ProjectScriptIcon = typeof ProjectScriptIcon.Type;

export const ProjectScript = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  icon: ProjectScriptIcon,
  runOnWorktreeCreate: Schema.Boolean,
});
export type ProjectScript = typeof ProjectScript.Type;

export const SPACE_NAME_MAX_LENGTH = 32;
export const SPACES_MAX_COUNT = 50;
/** Reserved client-side identity for the virtual collection of unassigned projects. */
export const RESERVED_VOID_SPACE_ID = "void";
/** Per-command cap for bulk assignment; clients chunk larger selections. */
export const SPACE_PROJECTS_ASSIGN_MAX_COUNT = 200;
export const SIDEBAR_SECTION_NAME_MAX_LENGTH = 48;
export const SIDEBAR_SECTIONS_MAX_COUNT = 32;
export const SIDEBAR_SECTION_ITEMS_MAX_COUNT = 256;
export const SIDEBAR_SECTION_ITEM_KEY_MAX_LENGTH = 256;
export const SIDEBAR_SECTION_ID_MAX_LENGTH = 128;
const SidebarSectionIdentifier = TrimmedNonEmptyString.check(
  Schema.isMaxLength(SIDEBAR_SECTION_ID_MAX_LENGTH),
).pipe(Schema.brand("SidebarSectionId"));
export const SidebarSectionId = SidebarSectionIdentifier;
export type SidebarSectionId = typeof SidebarSectionId.Type;
export const SidebarSectionName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(SIDEBAR_SECTION_NAME_MAX_LENGTH),
);
export type SidebarSectionName = typeof SidebarSectionName.Type;
export const SidebarSectionItemType = Schema.Literals(["thread", "project"]);
export type SidebarSectionItemType = typeof SidebarSectionItemType.Type;
export const SidebarSectionItemKey = TrimmedNonEmptyString.check(
  Schema.isMaxLength(SIDEBAR_SECTION_ITEM_KEY_MAX_LENGTH),
)
  .check(Schema.isPattern(/^(?:thread|project):.+$/u))
  .pipe(Schema.brand("SidebarSectionItemKey"));
export type SidebarSectionItemKey = typeof SidebarSectionItemKey.Type;

/** Durable placement containers for every sidebar item. */
export const SidebarOrderDestination = Schema.Literals(["pinned", "default", "custom"]);
export type SidebarOrderDestination = typeof SidebarOrderDestination.Type;
export const SidebarOrderMigrationState = Schema.Literals(["ready", "legacy_import_required"]);
export type SidebarOrderMigrationState = typeof SidebarOrderMigrationState.Type;
export const SidebarOrderRevision = NonNegativeInt.pipe(Schema.brand("SidebarOrderRevision"));
export type SidebarOrderRevision = typeof SidebarOrderRevision.Type;
export const SPACE_ICON_NAMES = [
  "bag",
  "home",
  "code-brackets",
  "rocket",
  "light-bulb",
  "color-palette",
  "book",
  "lab",
  "heart",
  "star",
  "globe",
  "cloud",
  "hammer",
  "chart-2",
  "gamecontroller",
  "camera-1",
  "target",
  "tree",
  "school",
  "backpack",
] as const;
export const SpaceIconName = Schema.Literals(SPACE_ICON_NAMES);
export type SpaceIconName = typeof SpaceIconName.Type;
export const SpaceName = TrimmedNonEmptyString.check(Schema.isMaxLength(SPACE_NAME_MAX_LENGTH));
export type SpaceName = typeof SpaceName.Type;

export const OrchestrationSpace = Schema.Struct({
  id: SpaceId,
  name: SpaceName,
  icon: SpaceIconName,
  sortOrder: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationSpace = typeof OrchestrationSpace.Type;

export const OrchestrationSpaceShell = Schema.Struct({
  id: SpaceId,
  name: SpaceName,
  icon: SpaceIconName,
  sortOrder: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationSpaceShell = typeof OrchestrationSpaceShell.Type;

/** Upper bound on extra source folders a project may list next to its primary `workspaceRoot`. */
export const PROJECT_ADDITIONAL_FOLDERS_MAX_COUNT = 16;

/**
 * Extra source folders a project spans besides its primary `workspaceRoot`, in display
 * order. Absolute, canonical paths. Empty for an ordinary single-folder project.
 */
export const ProjectAdditionalFolders = Schema.Array(TrimmedNonEmptyString).check(
  Schema.isMaxLength(PROJECT_ADDITIONAL_FOLDERS_MAX_COUNT),
);
export type ProjectAdditionalFolders = typeof ProjectAdditionalFolders.Type;

const ProjectAdditionalFoldersField = Schema.optional(ProjectAdditionalFolders).pipe(
  Schema.withDecodingDefault(() => []),
);

export const OrchestrationProject = Schema.Struct({
  id: ProjectId,
  kind: Schema.optional(ProjectKind).pipe(Schema.withDecodingDefault(() => "project")),
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  defaultModelSelection: Schema.NullOr(ModelSelection),
  scripts: Schema.Array(ProjectScript),
  isPinned: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  spaceId: Schema.optional(Schema.NullOr(SpaceId)).pipe(Schema.withDecodingDefault(() => null)),
  additionalFolders: ProjectAdditionalFoldersField,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationProject = typeof OrchestrationProject.Type;

export const OrchestrationProjectShell = Schema.Struct({
  id: ProjectId,
  kind: Schema.optional(ProjectKind).pipe(Schema.withDecodingDefault(() => "project")),
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  defaultModelSelection: Schema.NullOr(ModelSelection),
  scripts: Schema.Array(ProjectScript),
  isPinned: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  spaceId: Schema.optional(Schema.NullOr(SpaceId)).pipe(Schema.withDecodingDefault(() => null)),
  additionalFolders: ProjectAdditionalFoldersField,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationProjectShell = typeof OrchestrationProjectShell.Type;

export const OrchestrationMessageRole = Schema.Literals(["user", "assistant", "system"]);
export type OrchestrationMessageRole = typeof OrchestrationMessageRole.Type;

export const OrchestrationMessageTextSegment = Schema.Struct({
  /** Causal orchestration-event order; disambiguates equal timestamps. */
  sequence: NonNegativeInt,
  startedAt: IsoDateTime,
  endedAt: IsoDateTime,
  text: Schema.String,
});
export type OrchestrationMessageTextSegment = typeof OrchestrationMessageTextSegment.Type;

// One contiguous run of assistant text deltas between row-making provider
// events (tool calls, warnings, ...). The web timeline interleaves these
// segments with tool rows so streamed reasoning renders in execution order
// instead of one block above every tool call.
export const OrchestrationMessage = Schema.Struct({
  id: MessageId,
  /** Provider realtime handoff block id; never a voice session or motion id. */
  realtimeHandoffId: Schema.optional(TrimmedNonEmptyString),
  role: OrchestrationMessageRole,
  text: Schema.String,
  textSegments: Schema.optional(Schema.Array(OrchestrationMessageTextSegment)),
  asyncUserInput: Schema.optional(AsyncUserInput),
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  skills: Schema.optional(Schema.Array(ProviderSkillReference)),
  mentions: Schema.optional(Schema.Array(ProviderMentionReference)),
  dispatchMode: Schema.optional(TurnDispatchMode),
  dispatchOrigin: Schema.optional(MessageDispatchOrigin),
  startsNewTurn: Schema.optional(Schema.Boolean),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  source: OrchestrationMessageSource.pipe(Schema.withDecodingDefault(() => "native")),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationMessage = typeof OrchestrationMessage.Type;

export const ThreadHandoff = Schema.Struct({
  sourceThreadId: ThreadId,
  // Handoff metadata is durable: a removed source provider must not make the
  // whole thread row (and with it the thread list) undecodable.
  sourceProvider: PersistedProviderKind,
  importedAt: IsoDateTime,
  bootstrapStatus: ThreadHandoffBootstrapStatus,
});
export type ThreadHandoff = typeof ThreadHandoff.Type;

export const OrchestrationProposedPlanId = TrimmedNonEmptyString;
export type OrchestrationProposedPlanId = typeof OrchestrationProposedPlanId.Type;

export const OrchestrationProposedPlan = Schema.Struct({
  id: OrchestrationProposedPlanId,
  turnId: Schema.NullOr(TurnId),
  planMarkdown: TrimmedNonEmptyString,
  implementedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(() => null)),
  implementationThreadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(() => null)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationProposedPlan = typeof OrchestrationProposedPlan.Type;

const SourceProposedPlanReference = Schema.Struct({
  threadId: ThreadId,
  planId: OrchestrationProposedPlanId,
});

export const OrchestrationSessionStatus = Schema.Literals([
  "idle",
  "starting",
  "running",
  "ready",
  "interrupted",
  "stopped",
  "error",
]);
export type OrchestrationSessionStatus = typeof OrchestrationSessionStatus.Type;

export const OrchestrationSession = Schema.Struct({
  threadId: ThreadId,
  status: OrchestrationSessionStatus,
  providerName: Schema.NullOr(TrimmedNonEmptyString),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(() => DEFAULT_RUNTIME_MODE)),
  activeTurnId: Schema.NullOr(TurnId),
  lastError: Schema.NullOr(TrimmedNonEmptyString),
  /** Last provider-runtime activity of any kind observed on the thread
   * (streamed output, tool lifecycle, messages, requests). Maintained by
   * runtime ingestion, not by session lifecycle events. */
  lastActivityAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  /** Last activity that produced real work (agent output, tool lifecycle,
   * turn boundaries) — a steer/nudge echo does not advance it. */
  lastProgressAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  updatedAt: IsoDateTime,
});
export type OrchestrationSession = typeof OrchestrationSession.Type;

export const OrchestrationCheckpointFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: TrimmedNonEmptyString,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type OrchestrationCheckpointFile = typeof OrchestrationCheckpointFile.Type;

export const OrchestrationCheckpointStatus = Schema.Literals(["ready", "missing", "error"]);
export type OrchestrationCheckpointStatus = typeof OrchestrationCheckpointStatus.Type;

export const OrchestrationCheckpointSummary = Schema.Struct({
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  /** When the provider started the turn; lets clients report its real duration. */
  startedAt: Schema.optional(IsoDateTime),
  completedAt: IsoDateTime,
});
export type OrchestrationCheckpointSummary = typeof OrchestrationCheckpointSummary.Type;

export const OrchestrationThreadActivityTone = Schema.Literals([
  "info",
  "tool",
  "approval",
  "error",
]);
export type OrchestrationThreadActivityTone = typeof OrchestrationThreadActivityTone.Type;

export const OrchestrationThreadActivity = Schema.Struct({
  id: EventId,
  tone: OrchestrationThreadActivityTone,
  kind: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  payload: Schema.Json,
  turnId: Schema.NullOr(TurnId),
  /** Provider runtime sequence, or the orchestration event sequence when `sequenceSource` says so. */
  sequence: Schema.optional(NonNegativeInt),
  /**
   * "orchestration" when the activity was created by the server and `sequence`
   * fell back to the orchestration event sequence. That counter is unrelated to
   * provider runtime sequences, so the two must not be compared for ordering.
   */
  sequenceSource: Schema.optional(Schema.Literal("orchestration")),
  createdAt: IsoDateTime,
});
export type OrchestrationThreadActivity = typeof OrchestrationThreadActivity.Type;

const OrchestrationLatestTurnState = Schema.Literals([
  "running",
  "interrupted",
  "completed",
  "error",
]);
export type OrchestrationLatestTurnState = typeof OrchestrationLatestTurnState.Type;

export const OrchestrationLatestTurn = Schema.Struct({
  turnId: TurnId,
  state: OrchestrationLatestTurnState,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
});
export type OrchestrationLatestTurn = typeof OrchestrationLatestTurn.Type;

export const OrchestrationThreadPullRequest = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: Schema.String,
  baseBranch: TrimmedNonEmptyString,
  headBranch: TrimmedNonEmptyString,
  state: Schema.Literals(["open", "closed", "merged"]),
  // Optional so `last_known_pr_json` rows persisted before these fields existed still
  // decode. Literals stay inline: importing git.ts here would create an import cycle.
  isDraft: Schema.optional(Schema.Boolean),
  mergeability: Schema.optional(Schema.Literals(["mergeable", "conflicting", "unknown"])),
  additions: Schema.optional(Schema.NullOr(NonNegativeInt)),
  deletions: Schema.optional(Schema.NullOr(NonNegativeInt)),
  changedFiles: Schema.optional(Schema.NullOr(NonNegativeInt)),
});
export type OrchestrationThreadPullRequest = typeof OrchestrationThreadPullRequest.Type;

/**
 * A message the user pinned to the chat's sidebar checklist. `label` is an
 * optional user override; when null the UI derives a label from the message
 * text. `done` tracks the checklist "addressed" state. Decoding defaults keep
 * older/partial persisted entries decodable as the shape evolves.
 */
export const ThreadNotes = Schema.String.check(Schema.isMaxLength(THREAD_NOTES_MAX_CHARS));
export type ThreadNotes = typeof ThreadNotes.Type;
export const ThreadGoal = Schema.String.check(Schema.isMaxLength(THREAD_GOAL_MAX_CHARS));
export type ThreadGoal = typeof ThreadGoal.Type;
// The visible start atomically records the goal message and its first turn intent.
export const ThreadGoalStartBehavior = Schema.Literals([
  "start-if-idle",
  "start-with-message",
  "defer",
]);
export type ThreadGoalStartBehavior = typeof ThreadGoalStartBehavior.Type;
export const ThreadGoalContinuationTrigger = Schema.Literals([
  "goal-updated",
  "interaction-mode-updated",
  "turn-completed",
  "startup-recovery",
]);
export type ThreadGoalContinuationTrigger = typeof ThreadGoalContinuationTrigger.Type;
/**
 * Goal pursuit timing. `goalStartedAt` is (re)stamped by the decider whenever a
 * non-empty goal is set and rebased on resume so `now - goalStartedAt` is always
 * the active pursuit duration. A non-null `goalPausedAt` means the goal is
 * paused: injection stops and the elapsed clock freezes at `goalPausedAt`.
 */
export const ThreadGoalTimingFields = {
  goalStartedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  goalPausedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
};
/**
 * A completed goal, recorded when the decider processes a `goalAchieved` intent.
 * `elapsedMs` is the pause-adjusted pursuit duration (null for legacy goals with
 * no recorded start) and `turnId` anchors the transcript "Goal achieved" badge to
 * the turn that was live when the goal completed.
 */
export const ThreadGoalAchievement = Schema.Struct({
  goal: ThreadGoal,
  achievedAt: IsoDateTime,
  elapsedMs: Schema.NullOr(Schema.Number),
  turnId: Schema.NullOr(TurnId),
});
export type ThreadGoalAchievement = typeof ThreadGoalAchievement.Type;
export const THREAD_GOAL_ACHIEVEMENTS_MAX_COUNT = 20;
export const ThreadGoalAchievements = Schema.Array(ThreadGoalAchievement).check(
  Schema.isMaxLength(THREAD_GOAL_ACHIEVEMENTS_MAX_COUNT),
);
export type ThreadGoalAchievements = typeof ThreadGoalAchievements.Type;
export const PinnedMessageLabel = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PINNED_MESSAGE_LABEL_MAX_CHARS),
);
export type PinnedMessageLabel = typeof PinnedMessageLabel.Type;
export const PinnedMessage = Schema.Struct({
  messageId: MessageId,
  label: Schema.optional(Schema.NullOr(PinnedMessageLabel)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  done: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  pinnedAt: IsoDateTime,
});
export type PinnedMessage = typeof PinnedMessage.Type;
export const ThreadPinnedMessages = Schema.Array(PinnedMessage).check(
  Schema.isMaxLength(PINNED_MESSAGES_MAX_COUNT),
);
export type ThreadPinnedMessages = typeof ThreadPinnedMessages.Type;

export const ProjectionPendingInteractionKind = Schema.Literals(["approval", "userInput"]);
export type ProjectionPendingInteractionKind = typeof ProjectionPendingInteractionKind.Type;

export const ProjectionPendingInteractionStatus = Schema.Literals([
  "pending",
  "responding",
  "confirmed",
  "retryable",
  "uncertain",
]);
export type ProjectionPendingInteractionStatus = typeof ProjectionPendingInteractionStatus.Type;

export const ProjectionPendingInteractionDecision = Schema.NullOr(ProviderApprovalDecision);
export type ProjectionPendingInteractionDecision = typeof ProjectionPendingInteractionDecision.Type;

/** Unresolved provider interaction settlement exposed to thread-detail consumers. */
export const OrchestrationPendingInteraction = Schema.Struct({
  interactionKind: ProjectionPendingInteractionKind,
  requestId: ApprovalRequestId,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  lifecycleGeneration: Schema.NullOr(TrimmedNonEmptyString),
  status: ProjectionPendingInteractionStatus,
  decision: ProjectionPendingInteractionDecision,
  responseCommandId: Schema.NullOr(CommandId),
  responseRequestedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationPendingInteraction = typeof OrchestrationPendingInteraction.Type;

export const PendingClaudeCacheReview = Schema.Struct({
  reviewId: TrimmedNonEmptyString,
  messageId: MessageId,
  sourceEventSequence: PositiveInt,
  assessment: ClaudeCacheObservation,
  status: Schema.Literals(["pending", "responding", "compacting", "failed", "uncertain"]),
  compactionTurnId: Schema.optional(TurnId),
  compactionResponseEventSequence: Schema.optional(PositiveInt),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  requestedAt: Schema.optional(IsoDateTime),
  error: Schema.optional(Schema.String),
  createdAt: IsoDateTime,
});
export type PendingClaudeCacheReview = typeof PendingClaudeCacheReview.Type;

export const OrchestrationThread = Schema.Struct({
  /** Durable project-import provenance; ordinary chats never request imported history. */
  isProjectImport: Schema.optional(Schema.Boolean),
  claudeCacheReview: Schema.optional(Schema.NullOr(PendingClaudeCacheReview)),
  id: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  envMode: Schema.optional(ThreadEnvironmentMode).pipe(Schema.withDecodingDefault(() => "local")),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  workingDirectory: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  associatedWorktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  associatedWorktreeBranch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  associatedWorktreeRef: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  createBranchFlowCompleted: Schema.optional(Schema.Boolean).pipe(
    Schema.withDecodingDefault(() => false),
  ),
  isPinned: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  creationSource: Schema.optional(Schema.NullOr(ThreadCreationSource)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  sourceThreadId: Schema.optional(Schema.NullOr(ThreadId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  sourceTurnId: Schema.optional(Schema.NullOr(TurnId)).pipe(Schema.withDecodingDefault(() => null)),
  gatewayOperationId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  gatewayOperationIndex: Schema.optional(Schema.NullOr(NonNegativeInt)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  subagentAgentId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  subagentNickname: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  subagentRole: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  forkSourceThreadId: Schema.optional(Schema.NullOr(ThreadId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  /**
   * Source message a fork was taken from ("Fork from this turn"). The provider
   * fork must not carry native history past it. Null/absent = whole thread.
   */
  forkSourceMessageId: Schema.optional(Schema.NullOr(MessageId)),
  sidechatSourceThreadId: SidechatSourceThreadId,
  sidechatContext: SidechatContextField,
  sidechatLastActivityAt: SidechatLifecycleTimestamp,
  sidechatExpiredAt: SidechatLifecycleTimestamp,
  lastKnownPr: Schema.optional(Schema.NullOr(OrchestrationThreadPullRequest)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  latestUserMessageAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  latestHumanMessageAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  hasPendingApprovals: Schema.optional(Schema.Boolean),
  hasPendingUserInput: Schema.optional(Schema.Boolean),
  hasActionableProposedPlan: Schema.optional(Schema.Boolean),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  /** Internal archive provenance used only by the command read model. */
  archivedByCommandId: Schema.optional(Schema.NullOr(CommandId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  archivedSidebarDestination: Schema.optional(Schema.NullOr(SidebarOrderDestination)),
  archivedSidebarSectionId: Schema.optional(Schema.NullOr(SidebarSectionId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  archivedSidebarSectionCreatedAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  archivedSidebarSortOrder: Schema.optional(Schema.NullOr(NonNegativeInt)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  settledAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  snoozedUntil: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  snoozeReminderAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  deletedAt: Schema.NullOr(IsoDateTime),
  handoff: Schema.NullOr(ThreadHandoff).pipe(Schema.withDecodingDefault(() => null)),
  pinnedMessages: Schema.optional(ThreadPinnedMessages),
  threadMarkers: Schema.optional(Schema.Array(ThreadMarker)),
  notes: Schema.optional(ThreadNotes),
  goal: Schema.optional(ThreadGoal),
  ...ThreadGoalTimingFields,
  goalAchievements: Schema.optional(ThreadGoalAchievements),
  messages: Schema.Array(OrchestrationMessage),
  proposedPlans: Schema.Array(OrchestrationProposedPlan).pipe(Schema.withDecodingDefault(() => [])),
  activities: Schema.Array(OrchestrationThreadActivity),
  pendingInteractions: Schema.optional(Schema.Array(OrchestrationPendingInteraction)),
  checkpoints: Schema.Array(OrchestrationCheckpointSummary),
  session: Schema.NullOr(OrchestrationSession),
});
export type OrchestrationThread = typeof OrchestrationThread.Type;

export const OrchestrationThreadShell = Schema.Struct({
  /** Durable project-import provenance; ordinary chats never request imported history. */
  isProjectImport: Schema.optional(Schema.Boolean),
  claudeCacheReview: Schema.optional(Schema.NullOr(PendingClaudeCacheReview)),
  id: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  envMode: Schema.optional(ThreadEnvironmentMode).pipe(Schema.withDecodingDefault(() => "local")),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  workingDirectory: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  associatedWorktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  associatedWorktreeBranch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  associatedWorktreeRef: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  createBranchFlowCompleted: Schema.optional(Schema.Boolean).pipe(
    Schema.withDecodingDefault(() => false),
  ),
  isPinned: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  creationSource: Schema.optional(Schema.NullOr(ThreadCreationSource)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  sourceThreadId: Schema.optional(Schema.NullOr(ThreadId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  sourceTurnId: Schema.optional(Schema.NullOr(TurnId)).pipe(Schema.withDecodingDefault(() => null)),
  gatewayOperationId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  gatewayOperationIndex: Schema.optional(Schema.NullOr(NonNegativeInt)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  subagentAgentId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  subagentNickname: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  subagentRole: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  forkSourceThreadId: Schema.optional(Schema.NullOr(ThreadId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  forkSourceMessageId: Schema.optional(Schema.NullOr(MessageId)),
  sidechatSourceThreadId: SidechatSourceThreadId,
  sidechatContext: SidechatContextField,
  sidechatLastActivityAt: SidechatLifecycleTimestamp,
  sidechatExpiredAt: SidechatLifecycleTimestamp,
  lastKnownPr: Schema.optional(Schema.NullOr(OrchestrationThreadPullRequest)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  latestUserMessageAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  latestHumanMessageAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  hasPendingApprovals: Schema.optional(Schema.Boolean),
  hasPendingUserInput: Schema.optional(Schema.Boolean),
  hasActionableProposedPlan: Schema.optional(Schema.Boolean),
  threadMarkers: Schema.optional(Schema.Array(ThreadMarker)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  settledAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  snoozedUntil: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  snoozeReminderAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  handoff: Schema.NullOr(ThreadHandoff).pipe(Schema.withDecodingDefault(() => null)),
  goal: Schema.optional(ThreadGoal),
  ...ThreadGoalTimingFields,
  session: Schema.NullOr(OrchestrationSession),
});
export type OrchestrationThreadShell = typeof OrchestrationThreadShell.Type;

export const OrchestrationSidebarSectionItem = Schema.Struct({
  key: SidebarSectionItemKey,
  itemType: SidebarSectionItemType,
  sortOrder: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationSidebarSectionItem = typeof OrchestrationSidebarSectionItem.Type;

export const OrchestrationSidebarSection = Schema.Struct({
  id: SidebarSectionId,
  name: SidebarSectionName,
  sortOrder: NonNegativeInt,
  isCollapsed: Schema.Boolean,
  items: Schema.Array(OrchestrationSidebarSectionItem).check(
    Schema.isMaxLength(SIDEBAR_SECTION_ITEMS_MAX_COUNT),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationSidebarSection = typeof OrchestrationSidebarSection.Type;

export const OrchestrationSidebarSectionShell = Schema.Struct({
  id: SidebarSectionId,
  name: SidebarSectionName,
  sortOrder: NonNegativeInt,
  isCollapsed: Schema.Boolean,
  items: Schema.Array(OrchestrationSidebarSectionItem).check(
    Schema.isMaxLength(SIDEBAR_SECTION_ITEMS_MAX_COUNT),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationSidebarSectionShell = typeof OrchestrationSidebarSectionShell.Type;

/** One durable, incarnation-aware sidebar placement row. */
export const OrchestrationSidebarOrderItem = Schema.Struct({
  key: SidebarSectionItemKey,
  itemType: SidebarSectionItemType,
  destination: SidebarOrderDestination,
  sectionId: Schema.NullOr(SidebarSectionId),
  sectionCreatedAt: Schema.NullOr(IsoDateTime),
  sortOrder: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationSidebarOrderItem = typeof OrchestrationSidebarOrderItem.Type;

export const OrchestrationSidebarOrder = Schema.Struct({
  revision: SidebarOrderRevision,
  migrationState: SidebarOrderMigrationState,
  items: Schema.Array(OrchestrationSidebarOrderItem).check(
    Schema.isMaxLength(SIDEBAR_SECTION_ITEMS_MAX_COUNT * (SIDEBAR_SECTIONS_MAX_COUNT + 2)),
  ),
});
export type OrchestrationSidebarOrder = typeof OrchestrationSidebarOrder.Type;

export const OrchestrationReadModel = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  spaces: Schema.Array(OrchestrationSpace),
  projects: Schema.Array(OrchestrationProject),
  threads: Schema.Array(OrchestrationThread),
  sidebarSections: Schema.optional(
    Schema.Array(OrchestrationSidebarSection).check(Schema.isMaxLength(SIDEBAR_SECTIONS_MAX_COUNT)),
  ).pipe(Schema.withDecodingDefault(() => [])),
  /** New installs and migrated snapshots expose the durable order directly. */
  sidebarOrderRevision: Schema.optional(SidebarOrderRevision),
  sidebarOrderMigrationState: Schema.optional(SidebarOrderMigrationState),
  sidebarOrderItems: Schema.optional(Schema.Array(OrchestrationSidebarOrderItem)),
  updatedAt: IsoDateTime,
});
export type OrchestrationReadModel = typeof OrchestrationReadModel.Type;

export const OrchestrationShellSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  requiresEmptyProjectShellRepair: Schema.optional(Schema.Boolean),
  spaces: Schema.Array(OrchestrationSpaceShell),
  projects: Schema.Array(OrchestrationProjectShell),
  threads: Schema.Array(OrchestrationThreadShell),
  sidebarSections: Schema.optional(
    Schema.Array(OrchestrationSidebarSectionShell).check(
      Schema.isMaxLength(SIDEBAR_SECTIONS_MAX_COUNT),
    ),
  ).pipe(Schema.withDecodingDefault(() => [])),
  sidebarOrderRevision: Schema.optional(SidebarOrderRevision),
  sidebarOrderMigrationState: Schema.optional(SidebarOrderMigrationState),
  sidebarOrderItems: Schema.optional(Schema.Array(OrchestrationSidebarOrderItem)),
  updatedAt: IsoDateTime,
});
export type OrchestrationShellSnapshot = typeof OrchestrationShellSnapshot.Type;

export const OrchestrationShellStreamEvent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("space-upserted"),
    sequence: NonNegativeInt,
    space: OrchestrationSpaceShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("space-removed"),
    sequence: NonNegativeInt,
    spaceId: SpaceId,
    updatedAt: IsoDateTime,
  }),
  Schema.Struct({
    kind: Schema.Literal("space-order-updated"),
    sequence: NonNegativeInt,
    orderedSpaceIds: Schema.Array(SpaceId),
  }),
  Schema.Struct({
    kind: Schema.Literal("project-upserted"),
    sequence: NonNegativeInt,
    project: OrchestrationProjectShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("project-removed"),
    sequence: NonNegativeInt,
    projectId: ProjectId,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-upserted"),
    sequence: NonNegativeInt,
    thread: OrchestrationThreadShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-removed"),
    sequence: NonNegativeInt,
    threadId: ThreadId,
    sidebarOrderRevision: Schema.optional(SidebarOrderRevision),
    sidebarOrderMigrationState: Schema.optional(SidebarOrderMigrationState),
    sidebarOrderItems: Schema.optional(Schema.Array(OrchestrationSidebarOrderItem)),
  }),
  Schema.Struct({
    kind: Schema.Literal("sidebar-sections-updated"),
    sequence: NonNegativeInt,
    sections: Schema.Array(OrchestrationSidebarSectionShell).check(
      Schema.isMaxLength(SIDEBAR_SECTIONS_MAX_COUNT),
    ),
    sidebarOrderRevision: Schema.optional(SidebarOrderRevision),
    sidebarOrderMigrationState: Schema.optional(SidebarOrderMigrationState),
    sidebarOrderItems: Schema.optional(Schema.Array(OrchestrationSidebarOrderItem)),
    thread: Schema.optional(OrchestrationThreadShell),
  }),
]);
export type OrchestrationShellStreamEvent = typeof OrchestrationShellStreamEvent.Type;

export const OrchestrationShellStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationShellSnapshot,
  }),
  OrchestrationShellStreamEvent,
]);
export type OrchestrationShellStreamItem = typeof OrchestrationShellStreamItem.Type;

export const SpaceCreateCommand = Schema.Struct({
  type: Schema.Literal("space.create"),
  commandId: CommandId,
  spaceId: SpaceId,
  name: SpaceName,
  icon: SpaceIconName,
  createdAt: IsoDateTime,
});

export const SpaceMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("space.meta.update"),
  commandId: CommandId,
  spaceId: SpaceId,
  name: Schema.optional(SpaceName),
  icon: Schema.optional(SpaceIconName),
});

export const SpaceReorderCommand = Schema.Struct({
  type: Schema.Literal("space.reorder"),
  commandId: CommandId,
  spaceId: SpaceId,
  orderedSpaceIds: Schema.Array(SpaceId).check(Schema.isMaxLength(SPACES_MAX_COUNT)),
});

export const SpaceDeleteCommand = Schema.Struct({
  type: Schema.Literal("space.delete"),
  commandId: CommandId,
  spaceId: SpaceId,
});

/**
 * Bulk assignment into one target space, applied atomically in a single transaction.
 * Moving projects out to Void stays per-project via `project.meta.update` — the only
 * bulk surface in the app files projects *into* a space.
 */
export const SpaceProjectsAssignCommand = Schema.Struct({
  type: Schema.Literal("space.projects.assign"),
  commandId: CommandId,
  spaceId: SpaceId,
  projectIds: Schema.Array(ProjectId).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(SPACE_PROJECTS_ASSIGN_MAX_COUNT),
  ),
});

export const SidebarSectionCreateCommand = Schema.Struct({
  type: Schema.Literal("sidebar-section.create"),
  commandId: CommandId,
  sectionId: SidebarSectionId,
  name: SidebarSectionName,
  initialThreadId: Schema.optional(ThreadId),
  expectedSidebarOrderRevision: Schema.optionalKey(SidebarOrderRevision),
  createdAt: IsoDateTime,
});

export const SidebarSectionRenameCommand = Schema.Struct({
  type: Schema.Literal("sidebar-section.rename"),
  commandId: CommandId,
  sectionId: SidebarSectionId,
  name: SidebarSectionName,
});

export const SidebarSectionCollapseCommand = Schema.Struct({
  type: Schema.Literal("sidebar-section.collapse"),
  commandId: CommandId,
  sectionId: SidebarSectionId,
  isCollapsed: Schema.Boolean,
});

export const SidebarSectionDeleteCommand = Schema.Struct({
  type: Schema.Literal("sidebar-section.delete"),
  commandId: CommandId,
  sectionId: SidebarSectionId,
  expectedSidebarOrderRevision: Schema.optionalKey(SidebarOrderRevision),
});

export const SidebarSectionReorderCommand = Schema.Struct({
  type: Schema.Literal("sidebar-section.reorder"),
  commandId: CommandId,
  sectionId: SidebarSectionId,
  orderedSectionIds: Schema.Array(SidebarSectionId).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(SIDEBAR_SECTIONS_MAX_COUNT),
  ),
  expectedSidebarOrderRevision: Schema.optionalKey(SidebarOrderRevision),
});

export const SidebarSectionThreadPlaceCommand = Schema.Struct({
  type: Schema.Literal("sidebar-section.thread.place"),
  commandId: CommandId,
  threadId: ThreadId,
  sectionId: Schema.NullOr(SidebarSectionId),
  destination: Schema.Literals(["custom", "pinned", "default"]),
  /** Explicit target after the moved thread, or null to append. */
  beforeThreadId: Schema.NullOr(ThreadId),
  expectedSidebarOrderRevision: Schema.optionalKey(SidebarOrderRevision),
  /** Required for custom placement; null for pinned/default. */
  sectionCreatedAt: Schema.NullOr(IsoDateTime),
});

/** Revision-guarded placement for an ordinary project in the mixed sidebar order. */
export const SidebarSectionProjectPlaceCommand = Schema.Struct({
  type: Schema.Literal("sidebar-section.project.place"),
  commandId: CommandId,
  projectId: ProjectId,
  destination: Schema.Literals(["custom", "pinned", "default"]),
  sectionId: Schema.NullOr(SidebarSectionId),
  /** Mixed-item anchor; either a thread or project key, or null to append. */
  beforeItemKey: Schema.NullOr(SidebarSectionItemKey),
  expectedSidebarOrderRevision: Schema.optionalKey(SidebarOrderRevision),
  /** Required for custom placement; null for pinned/default. */
  sectionCreatedAt: Schema.NullOr(IsoDateTime),
});

/** Atomically rewrites thread slots while preserving every project slot. */
export const SidebarSectionThreadReorderCommand = Schema.Struct({
  type: Schema.Literal("sidebar-section.thread.reorder"),
  commandId: CommandId,
  sectionId: SidebarSectionId,
  sectionCreatedAt: IsoDateTime,
  orderedThreadIds: Schema.Array(ThreadId).check(
    Schema.isMaxLength(SIDEBAR_SECTION_ITEMS_MAX_COUNT),
  ),
  expectedSidebarOrderRevision: Schema.optionalKey(SidebarOrderRevision),
});

/** Partial project ordering for the default unpinned container. */
export const SidebarProjectsReorderCommand = Schema.Struct({
  type: Schema.Literal("sidebar-projects.reorder"),
  commandId: CommandId,
  orderedProjectIds: Schema.Array(ProjectId).check(
    Schema.isMaxLength(SIDEBAR_SECTION_ITEMS_MAX_COUNT),
  ),
  expectedSidebarOrderRevision: Schema.optionalKey(SidebarOrderRevision),
});

/** One-time, explicit migration of the hydrated legacy sidebar seed. */
export const SidebarOrderLegacyImportCommand = Schema.Struct({
  type: Schema.Literal("sidebar-order.legacy.import"),
  commandId: CommandId,
  expectedSidebarOrderRevision: Schema.optionalKey(SidebarOrderRevision),
  items: Schema.Array(OrchestrationSidebarOrderItem).check(
    Schema.isMaxLength(SIDEBAR_SECTION_ITEMS_MAX_COUNT * (SIDEBAR_SECTIONS_MAX_COUNT + 2)),
  ),
});

export const ProjectCreateCommand = Schema.Struct({
  type: Schema.Literal("project.create"),
  commandId: CommandId,
  projectId: ProjectId,
  kind: Schema.optional(ProjectKind).pipe(Schema.withDecodingDefault(() => "project")),
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  /** Importing into an existing folder must preserve even an empty project shell. */
  preserveExistingProject: Schema.optional(Schema.Boolean),
  createWorkspaceRootIfMissing: Schema.optional(Schema.Boolean).pipe(
    Schema.withDecodingDefault(() => false),
  ),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  isPinned: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  /**
   * Space the project is born into (usually the client's active space). Best-effort:
   * an unusable target (deleted space, non-ordinary kind) degrades to Void rather
   * than failing creation.
   */
  spaceId: Schema.optional(Schema.NullOr(SpaceId)),
  /**
   * Extra source folders for a multi-folder project; `workspaceRoot` stays the primary
   * folder. Only ordinary projects accept them, and each one must already exist.
   */
  additionalFolders: Schema.optional(ProjectAdditionalFolders),
  createdAt: IsoDateTime,
});

const ProjectMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("project.meta.update"),
  commandId: CommandId,
  projectId: ProjectId,
  kind: Schema.optional(ProjectKind),
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  createWorkspaceRootIfMissing: Schema.optional(Schema.Boolean).pipe(
    Schema.withDecodingDefault(() => false),
  ),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
  isPinned: Schema.optional(Schema.Boolean),
  spaceId: Schema.optional(Schema.NullOr(SpaceId)),
});

const ProjectDeleteCommand = Schema.Struct({
  type: Schema.Literal("project.delete"),
  commandId: CommandId,
  projectId: ProjectId,
});

const ThreadCreateCommand = Schema.Struct({
  type: Schema.Literal("thread.create"),
  commandId: CommandId,
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  envMode: Schema.optional(ThreadEnvironmentMode).pipe(Schema.withDecodingDefault(() => "local")),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  workingDirectory: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  associatedWorktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  associatedWorktreeBranch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  associatedWorktreeRef: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  createBranchFlowCompleted: Schema.optional(Schema.Boolean).pipe(
    Schema.withDecodingDefault(() => false),
  ),
  isPinned: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  creationSource: Schema.optional(ThreadCreationSource),
  sourceThreadId: Schema.optional(ThreadId),
  sourceTurnId: Schema.optional(TurnId),
  gatewayOperationId: Schema.optional(TrimmedNonEmptyString),
  gatewayOperationIndex: Schema.optional(NonNegativeInt),
  subagentAgentId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  subagentNickname: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  subagentRole: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  lastKnownPr: Schema.optional(Schema.NullOr(OrchestrationThreadPullRequest)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  /** Makes the thread a standalone sidechat (no source thread). */
  sidechatContext: Schema.optional(ThreadSidechatContext),
  createdAt: IsoDateTime,
});

export const ThreadHandoffImportedMessage = Schema.Struct({
  messageId: MessageId,
  realtimeHandoffId: Schema.optional(TrimmedNonEmptyString),
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  turnId: Schema.optional(TurnId),
  // Who wrote an imported user message. "agent" marks a subagent's brief from
  // the agent that launched it, so it never counts as a human message.
  dispatchOrigin: Schema.optional(MessageDispatchOrigin),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadHandoffImportedMessage = typeof ThreadHandoffImportedMessage.Type;

/**
 * Native Codex item provenance retained by same-session history imports.
 *
 * The visible activity payload is intentionally still provider-shaped, while
 * this small descriptor gives the replay projection a stable graph edge and
 * lifecycle/timing identity without reconstructing rows from assistant text.
 */
export const CodexReplayItem = Schema.Struct({
  itemId: TrimmedNonEmptyString,
  itemType: TrimmedNonEmptyString,
  lifecycle: Schema.Literals(["started", "updated", "completed"]),
  status: Schema.NullOr(TrimmedNonEmptyString),
  parentTurnId: Schema.NullOr(TurnId),
  parentItemId: Schema.NullOr(TrimmedNonEmptyString),
  childThreadIds: Schema.Array(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  durationMs: Schema.NullOr(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type CodexReplayItem = typeof CodexReplayItem.Type;

// Durable replay provenance. Kept on a typed activity so existing message and
// activity projections can retain native structure without a second transcript
// store. Source order is authoritative when a snapshot has only turn timestamps.
export const CodexReplayTurn = Schema.Struct({
  version: Schema.Literal(1),
  turnId: TurnId,
  status: TrimmedNonEmptyString,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  durationMs: Schema.NullOr(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
  terminalMessageId: Schema.NullOr(MessageId),
  entries: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      kind: Schema.Literals(["message", "activity", "proposed-plan"]),
      phase: Schema.optional(Schema.NullOr(Schema.Literals(["commentary", "final_answer"]))),
      item: Schema.optional(CodexReplayItem),
    }),
  ),
});
export type CodexReplayTurn = typeof CodexReplayTurn.Type;

export const ThreadHistoryImportEntry = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("message"), message: ThreadHandoffImportedMessage }),
  Schema.Struct({ kind: Schema.Literal("activity"), activity: OrchestrationThreadActivity }),
  Schema.Struct({ kind: Schema.Literal("proposed-plan"), proposedPlan: OrchestrationProposedPlan }),
]);
export type ThreadHistoryImportEntry = typeof ThreadHistoryImportEntry.Type;

const ThreadHandoffCreateCommand = Schema.Struct({
  type: Schema.Literal("thread.handoff.create"),
  commandId: CommandId,
  threadId: ThreadId,
  sourceThreadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  envMode: Schema.optional(ThreadEnvironmentMode).pipe(Schema.withDecodingDefault(() => "local")),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  workingDirectory: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  associatedWorktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  associatedWorktreeBranch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  associatedWorktreeRef: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  createBranchFlowCompleted: Schema.optional(Schema.Boolean).pipe(
    Schema.withDecodingDefault(() => false),
  ),
  importedMessages: Schema.Array(ThreadHandoffImportedMessage),
  createdAt: IsoDateTime,
});

const ThreadForkCreateCommand = Schema.Struct({
  type: Schema.Literal("thread.fork.create"),
  commandId: CommandId,
  threadId: ThreadId,
  sourceThreadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  envMode: Schema.optional(ThreadEnvironmentMode).pipe(Schema.withDecodingDefault(() => "local")),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  workingDirectory: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  associatedWorktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  associatedWorktreeBranch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  associatedWorktreeRef: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  createBranchFlowCompleted: Schema.optional(Schema.Boolean).pipe(
    Schema.withDecodingDefault(() => false),
  ),
  sidechatSourceThreadId: SidechatSourceThreadId,
  // New clients send only the source boundary; the server materializes the
  // prefix from its canonical projection so the renderer never serializes a
  // multi-megabyte transcript. The array remains as a compatibility fallback.
  importedMessages: Schema.optional(Schema.Array(ThreadHandoffImportedMessage)),
  throughMessageId: Schema.optional(Schema.NullOr(MessageId)),
  createdAt: IsoDateTime,
});

const ThreadDeleteCommand = Schema.Struct({
  type: Schema.Literal("thread.delete"),
  commandId: CommandId,
  threadId: ThreadId,
  expectedSidebarOrderRevision: Schema.optionalKey(SidebarOrderRevision),
});

const ThreadArchiveCommand = Schema.Struct({
  type: Schema.Literal("thread.archive"),
  commandId: CommandId,
  threadId: ThreadId,
  expectedSidebarOrderRevision: Schema.optionalKey(SidebarOrderRevision),
});

const ThreadUnarchiveCommand = Schema.Struct({
  type: Schema.Literal("thread.unarchive"),
  commandId: CommandId,
  threadId: ThreadId,
  expectedSidebarOrderRevision: Schema.optionalKey(SidebarOrderRevision),
});

const ThreadMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("thread.meta.update"),
  commandId: CommandId,
  threadId: ThreadId,
  title: Schema.optional(TrimmedNonEmptyString),
  /** Apply the title only while no newer durable title event exists. */
  expectedTitleSequence: Schema.optional(NonNegativeInt),
  modelSelection: Schema.optional(ModelSelection),
  envMode: Schema.optional(ThreadEnvironmentMode),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  workingDirectory: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  associatedWorktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  associatedWorktreeBranch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  associatedWorktreeRef: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  createBranchFlowCompleted: Schema.optional(Schema.Boolean),
  isPinned: Schema.optional(Schema.Boolean),
  // Desired settled state; the decider stamps the authoritative settledAt timestamp.
  isSettled: Schema.optional(Schema.Boolean),
  snoozedUntil: Schema.optional(Schema.NullOr(IsoDateTime)),
  /** A matching due deadline authorizes the server to deliver the reminder. */
  expectedSnoozedUntil: Schema.optional(Schema.NullOr(IsoDateTime)),
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  subagentAgentId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  subagentNickname: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  subagentRole: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  handoff: Schema.optional(Schema.NullOr(ThreadHandoff)),
  lastKnownPr: Schema.optional(Schema.NullOr(OrchestrationThreadPullRequest)),
  pinnedMessages: Schema.optional(ThreadPinnedMessages),
  notes: Schema.optional(ThreadNotes),
  goal: Schema.optional(ThreadGoal),
  goalStartBehavior: Schema.optional(ThreadGoalStartBehavior),
  // Desired paused state; the decider stamps the authoritative goal timestamps.
  goalPaused: Schema.optional(Schema.Boolean),
  // Marks the active goal accomplished: the decider records a ThreadGoalAchievement
  // (with pause-adjusted elapsed time) and clears the goal in the same event.
  goalAchieved: Schema.optional(Schema.Boolean),
  // Applies `modelSelection` as a same-thread provider handoff: the server starts
  // the target session now and records the handoff (or reverts) in the timeline.
  providerHandoff: Schema.optional(Schema.Boolean),
});

const ThreadPinnedMessageAddCommand = Schema.Struct({
  type: Schema.Literal("thread.pinned-message.add"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
});

const ThreadPinnedMessageRemoveCommand = Schema.Struct({
  type: Schema.Literal("thread.pinned-message.remove"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
});

const ThreadPinnedMessageDoneSetCommand = Schema.Struct({
  type: Schema.Literal("thread.pinned-message.done.set"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  done: Schema.Boolean,
});

const ThreadPinnedMessageLabelSetCommand = Schema.Struct({
  type: Schema.Literal("thread.pinned-message.label.set"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  label: Schema.NullOr(PinnedMessageLabel),
});

const ThreadRuntimeModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.runtime-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  createdAt: IsoDateTime,
});

const ThreadInteractionModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.interaction-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode,
  createdAt: IsoDateTime,
});

export const ComputerControlMode = Schema.Literals(["off", "request", "chat"]);
export type ComputerControlMode = typeof ComputerControlMode.Type;

export const ThreadTurnStartCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.start"),
  asyncUserInputResponse: Schema.optional(AsyncUserInputResponse),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
    attachments: ChatAttachmentList,
    skills: Schema.optional(Schema.Array(ProviderSkillReference)),
    mentions: Schema.optional(Schema.Array(ProviderMentionReference)),
  }).check(TurnMessageContentCheck),
  modelSelection: Schema.optional(ModelSelection),
  providerOptions: Schema.optional(ProviderStartOptions),
  enableComputerControl: Schema.optional(Schema.Boolean),
  computerControlMode: Schema.optional(ComputerControlMode),
  computerControlGeneration: Schema.optional(NonNegativeInt),
  reviewTarget: Schema.optional(ProviderReviewTarget),
  assistantDeliveryMode: Schema.optional(AssistantDeliveryMode),
  dispatchMode: Schema.optional(TurnDispatchMode).pipe(
    Schema.withDecodingDefault(() => DEFAULT_TURN_DISPATCH_MODE),
  ),
  // Set by the automation engine when it dispatches a turn. Clients cannot set it:
  // ClientThreadTurnStartCommand omits the field, so decoding strips any spoofed value.
  dispatchOrigin: Schema.optional(MessageDispatchOrigin),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(() => DEFAULT_RUNTIME_MODE)),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  // Server-only (quit resume): accept the turn only while the thread is not archived,
  // has nothing in flight, and no turn finished on its own since the record was
  // taken (the recorded turn itself, or any later one). Clients cannot set it:
  // ClientThreadTurnStartCommand omits the field, so decoding strips a spoofed value.
  resumePrecondition: Schema.optional(
    Schema.Struct({
      /** Turn in flight when the chat was recorded; null while the provider was still connecting. */
      recordedTurnId: Schema.NullOr(TurnId),
      recordedAt: IsoDateTime,
    }),
  ),
  // Server-only replay marker. Edit-and-resend intentionally reuses the
  // original message id after rolling the prior projection back.
  editResend: Schema.optional(Schema.Boolean),
  // Server-only marker for a replay initiated by the typed safety-buffering flow.
  turnTrigger: Schema.optional(ProviderTurnTrigger),
  createdAt: IsoDateTime,
});

const ClientThreadTurnStartCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.start"),
  asyncUserInputResponse: Schema.optional(AsyncUserInputResponse),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
    attachments: UploadChatAttachmentList,
    skills: Schema.optional(Schema.Array(ProviderSkillReference)),
    mentions: Schema.optional(Schema.Array(ProviderMentionReference)),
  }).check(TurnMessageContentCheck),
  modelSelection: Schema.optional(ModelSelection),
  providerOptions: Schema.optional(ProviderStartOptions),
  enableComputerControl: Schema.optional(Schema.Boolean),
  computerControlMode: Schema.optional(ComputerControlMode),
  computerControlGeneration: Schema.optional(NonNegativeInt),
  reviewTarget: Schema.optional(ProviderReviewTarget),
  assistantDeliveryMode: Schema.optional(AssistantDeliveryMode),
  dispatchMode: Schema.optional(TurnDispatchMode).pipe(
    Schema.withDecodingDefault(() => DEFAULT_TURN_DISPATCH_MODE),
  ),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

export const ThreadTurnCapacityRetryCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.capacity-retry"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  trigger: CapacityRetryTrigger,
  createdAt: IsoDateTime,
});

export const ThreadTurnSafetyBufferRetryCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.safety-buffer-retry"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  createdAt: IsoDateTime,
});

export const ThreadTurnResumeCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.resume"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  createdAt: IsoDateTime,
});

const ThreadClaudeCacheRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.claude-cache.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  reviewId: TrimmedNonEmptyString,
  decision: Schema.Literals(["continue", "compact", "cancel"]),
  createdAt: IsoDateTime,
});

const ThreadClaudeCacheSetCommand = Schema.Struct({
  type: Schema.Literal("thread.claude-cache.set"),
  commandId: CommandId,
  threadId: ThreadId,
  review: Schema.NullOr(PendingClaudeCacheReview),
  expectedReviewId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  hold: Schema.optional(
    Schema.Struct({ sourceEventSequence: PositiveInt, session: OrchestrationSession }),
  ),
  createdAt: IsoDateTime,
});

const ThreadClaudeCacheCompactedCommand = Schema.Struct({
  type: Schema.Literal("thread.claude-cache.compacted"),
  commandId: CommandId,
  threadId: ThreadId,
  reviewId: TrimmedNonEmptyString,
  turnId: TurnId,
  createdAt: IsoDateTime,
});

const TurnInterruptRequestedBy = Schema.Literals(["user", "agent", "system"]);

const ThreadTurnInterruptCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.interrupt"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  // Explicit intent provenance. Historical/automatic requests may omit it.
  requestedBy: Schema.optional(TurnInterruptRequestedBy),
  createdAt: IsoDateTime,
});

const ThreadTaskStopCommand = Schema.Struct({
  type: Schema.Literal("thread.task.stop"),
  commandId: CommandId,
  threadId: ThreadId,
  taskId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

const ThreadTaskBackgroundCommand = Schema.Struct({
  type: Schema.Literal("thread.task.background"),
  commandId: CommandId,
  threadId: ThreadId,
  toolUseId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

const ThreadDispatchQueuedTurnCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.dispatch-queued"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  initialGoalStartedAt: Schema.optional(IsoDateTime),
  modelSelection: Schema.optional(ModelSelection),
  providerOptions: Schema.optional(ProviderStartOptions),
  enableComputerControl: Schema.optional(Schema.Boolean),
  computerControlMode: Schema.optional(ComputerControlMode),
  computerControlGeneration: Schema.optional(NonNegativeInt),
  reviewTarget: Schema.optional(ProviderReviewTarget),
  assistantDeliveryMode: Schema.optional(AssistantDeliveryMode),
  dispatchMode: Schema.optional(TurnDispatchMode).pipe(
    Schema.withDecodingDefault(() => DEFAULT_TURN_DISPATCH_MODE),
  ),
  dispatchOrigin: Schema.optional(MessageDispatchOrigin),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(() => DEFAULT_RUNTIME_MODE)),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

const ThreadApprovalRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.approval.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  lifecycleGeneration: Schema.optional(TrimmedNonEmptyString),
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});

const ThreadUserInputRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.user-input.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  lifecycleGeneration: Schema.optional(TrimmedNonEmptyString),
  answers: ProviderUserInputAnswers,
  createdAt: IsoDateTime,
});

const ThreadCheckpointRevertCommand = Schema.Struct({
  type: Schema.Literal("thread.checkpoint.revert"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  scope: Schema.optional(Schema.Literals(["thread", "files"])),
  createdAt: IsoDateTime,
});

const ThreadConversationRollbackCommand = Schema.Struct({
  type: Schema.Literal("thread.conversation.rollback"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  numTurns: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadMessageEditAndResendCommand = Schema.Struct({
  type: Schema.Literal("thread.message.edit-and-resend"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  modelSelection: Schema.optional(ModelSelection),
  providerOptions: Schema.optional(ProviderStartOptions),
  enableComputerControl: Schema.optional(Schema.Boolean),
  computerControlMode: Schema.optional(ComputerControlMode),
  computerControlGeneration: Schema.optional(NonNegativeInt),
  assistantDeliveryMode: Schema.optional(AssistantDeliveryMode),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  createdAt: IsoDateTime,
});

const ThreadSessionStopCommand = Schema.Struct({
  type: Schema.Literal("thread.session.stop"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

const ThreadActivityAppendCommand = Schema.Struct({
  requireUnarchived: Schema.optional(Schema.Boolean),
  type: Schema.Literal("thread.activity.append"),
  commandId: CommandId,
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
  createdAt: IsoDateTime,
});

// Legacy Moss transcript marker commands retained during the 0.8.4 bridge.
const ThreadMarkerAddCommand = Schema.Struct({
  type: Schema.Literal("thread.marker.add"),
  commandId: CommandId,
  threadId: ThreadId,
  markerId: TrimmedNonEmptyString,
  messageId: MessageId,
  startOffset: Schema.Int,
  endOffset: Schema.Int,
  selectedText: Schema.String,
  style: Schema.Literals(["highlight", "underline"]),
  color: Schema.Literals(["yellow", "blue", "green", "pink", "purple"]),
});
const ThreadMarkerRemoveCommand = Schema.Struct({
  type: Schema.Literal("thread.marker.remove"),
  commandId: CommandId,
  threadId: ThreadId,
  markerId: TrimmedNonEmptyString,
});
const ThreadMarkerDoneSetCommand = Schema.Struct({
  type: Schema.Literal("thread.marker.done.set"),
  commandId: CommandId,
  threadId: ThreadId,
  markerId: TrimmedNonEmptyString,
  done: Schema.Boolean,
});
const ThreadMarkerLabelSetCommand = Schema.Struct({
  type: Schema.Literal("thread.marker.label.set"),
  commandId: CommandId,
  threadId: ThreadId,
  markerId: TrimmedNonEmptyString,
  label: Schema.NullOr(Schema.String),
});

const DispatchableClientOrchestrationCommand = Schema.Union([
  SpaceCreateCommand,
  SpaceMetaUpdateCommand,
  SpaceReorderCommand,
  SpaceDeleteCommand,
  SpaceProjectsAssignCommand,
  SidebarSectionCreateCommand,
  SidebarSectionRenameCommand,
  SidebarSectionCollapseCommand,
  SidebarSectionDeleteCommand,
  SidebarSectionReorderCommand,
  SidebarSectionThreadPlaceCommand,
  SidebarSectionProjectPlaceCommand,
  SidebarSectionThreadReorderCommand,
  SidebarProjectsReorderCommand,
  SidebarOrderLegacyImportCommand,
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  ThreadCreateCommand,
  ThreadHandoffCreateCommand,
  ThreadForkCreateCommand,
  ThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadMetaUpdateCommand,
  ThreadPinnedMessageAddCommand,
  ThreadPinnedMessageRemoveCommand,
  ThreadPinnedMessageDoneSetCommand,
  ThreadPinnedMessageLabelSetCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ThreadTurnStartCommand,
  ThreadTurnCapacityRetryCommand,
  ThreadTurnSafetyBufferRetryCommand,
  ThreadTurnResumeCommand,
  ThreadClaudeCacheRespondCommand,
  ThreadTurnInterruptCommand,
  ThreadTaskStopCommand,
  ThreadTaskBackgroundCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadCheckpointRevertCommand,
  ThreadMessageEditAndResendCommand,
  ThreadActivityAppendCommand,
  ThreadSessionStopCommand,
  ThreadMarkerAddCommand,
  ThreadMarkerRemoveCommand,
  ThreadMarkerDoneSetCommand,
  ThreadMarkerLabelSetCommand,
]);
export type DispatchableClientOrchestrationCommand =
  typeof DispatchableClientOrchestrationCommand.Type;

export const ClientOrchestrationCommand = Schema.Union([
  SpaceCreateCommand,
  SpaceMetaUpdateCommand,
  SpaceReorderCommand,
  SpaceDeleteCommand,
  SpaceProjectsAssignCommand,
  SidebarSectionCreateCommand,
  SidebarSectionRenameCommand,
  SidebarSectionCollapseCommand,
  SidebarSectionDeleteCommand,
  SidebarSectionReorderCommand,
  SidebarSectionThreadPlaceCommand,
  SidebarSectionProjectPlaceCommand,
  SidebarSectionThreadReorderCommand,
  SidebarProjectsReorderCommand,
  SidebarOrderLegacyImportCommand,
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  ThreadCreateCommand,
  ThreadHandoffCreateCommand,
  ThreadForkCreateCommand,
  ThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadMetaUpdateCommand,
  ThreadPinnedMessageAddCommand,
  ThreadPinnedMessageRemoveCommand,
  ThreadPinnedMessageDoneSetCommand,
  ThreadPinnedMessageLabelSetCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ClientThreadTurnStartCommand,
  ThreadTurnCapacityRetryCommand,
  ThreadTurnSafetyBufferRetryCommand,
  ThreadTurnResumeCommand,
  ThreadClaudeCacheRespondCommand,
  ThreadTurnInterruptCommand,
  ThreadTaskStopCommand,
  ThreadTaskBackgroundCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadCheckpointRevertCommand,
  ThreadMessageEditAndResendCommand,
  ThreadActivityAppendCommand,
  ThreadSessionStopCommand,
  ThreadMarkerAddCommand,
  ThreadMarkerRemoveCommand,
  ThreadMarkerDoneSetCommand,
  ThreadMarkerLabelSetCommand,
]);
export type ClientOrchestrationCommand = typeof ClientOrchestrationCommand.Type;

const ThreadSessionSetCommand = Schema.Struct({
  type: Schema.Literal("thread.session.set"),
  commandId: CommandId,
  threadId: ThreadId,
  session: OrchestrationSession,
  modelSelection: Schema.optional(ModelSelection),
  expectedSessionStatus: Schema.optional(OrchestrationSessionStatus),
  expectedSessionUpdatedAt: Schema.optional(IsoDateTime),
  createdAt: IsoDateTime,
});

const ThreadGoalContinueCommand = Schema.Struct({
  type: Schema.Literal("thread.goal.continue"),
  commandId: CommandId,
  threadId: ThreadId,
  goalStartedAt: Schema.NullOr(IsoDateTime),
  trigger: ThreadGoalContinuationTrigger,
  sourceTurnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadMessagesImportCommand = Schema.Struct({
  type: Schema.Literal("thread.messages.import"),
  commandId: CommandId,
  threadId: ThreadId,
  messages: Schema.Array(ThreadHandoffImportedMessage),
  createdAt: IsoDateTime,
});

const ThreadHistoryImportCommand = Schema.Struct({
  type: Schema.Literal("thread.history.import"),
  commandId: CommandId,
  threadId: ThreadId,
  entries: Schema.Array(ThreadHistoryImportEntry),
  createdAt: IsoDateTime,
});

const ThreadMessageAssistantDeltaCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.delta"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  delta: Schema.String,
  turnId: Schema.optional(TurnId),
  // Present only when this delta starts a NEW text segment: a row-making
  // provider event (tool call, warning, ...) intervened since the previous
  // assistant delta. Positions the segment in the merged timeline.
  segmentStartedAt: Schema.optional(IsoDateTime),
  segmentSequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
});

const ThreadMessageAssistantCompleteCommand = Schema.Struct({
  asyncQuestions: Schema.optional(AsyncUserInputQuestions),
  type: Schema.Literal("thread.message.assistant.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadMessageUserBindTurnCommand = Schema.Struct({
  type: Schema.Literal("thread.message.user.bind-turn"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  turnId: TurnId,
  createdAt: IsoDateTime,
});

const ThreadMessageUserSetTurnBoundaryCommand = Schema.Struct({
  type: Schema.Literal("thread.message.user.set-turn-boundary"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  startsNewTurn: Schema.Boolean,
  createdAt: IsoDateTime,
});

const ThreadProposedPlanUpsertCommand = Schema.Struct({
  type: Schema.Literal("thread.proposed-plan.upsert"),
  commandId: CommandId,
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
  createdAt: IsoDateTime,
});

const ThreadTurnDiffCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.diff.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  completedAt: IsoDateTime,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.optional(MessageId),
  checkpointTurnCount: NonNegativeInt,
  preserveLatestTurn: Schema.optional(Schema.Boolean),
  checkpointRevertTurnCount: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
});

const ThreadRevertCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.revert.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadConversationRollbackCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.conversation.rollback.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  numTurns: NonNegativeInt,
  removedTurnIds: Schema.optional(Schema.Array(TurnId)),
  skipAttachmentPrune: Schema.optional(Schema.Boolean),
  preserveUnboundMessages: Schema.optional(Schema.Boolean),
  createdAt: IsoDateTime,
});

const ThreadSidechatActivityRecordCommand = Schema.Struct({
  type: Schema.Literal("thread.sidechat.activity.record"),
  commandId: CommandId,
  threadId: ThreadId,
  activityAt: IsoDateTime,
});

const ThreadSidechatExpireCommand = Schema.Struct({
  type: Schema.Literal("thread.sidechat.expire"),
  commandId: CommandId,
  threadId: ThreadId,
  expectedLastActivityAt: IsoDateTime,
  expiredAt: IsoDateTime,
});

const InternalOrchestrationCommand = Schema.Union([
  ThreadClaudeCacheCompactedCommand,
  ThreadClaudeCacheSetCommand,
  ThreadSessionSetCommand,
  ThreadGoalContinueCommand,
  ThreadMessagesImportCommand,
  ThreadHistoryImportCommand,
  ThreadMessageAssistantDeltaCommand,
  ThreadMessageAssistantCompleteCommand,
  ThreadMessageUserBindTurnCommand,
  ThreadMessageUserSetTurnBoundaryCommand,
  ThreadProposedPlanUpsertCommand,
  ThreadTurnDiffCompleteCommand,
  ThreadActivityAppendCommand,
  ThreadRevertCompleteCommand,
  ThreadConversationRollbackCommand,
  ThreadConversationRollbackCompleteCommand,
  ThreadDispatchQueuedTurnCommand,
  ThreadSidechatActivityRecordCommand,
  ThreadSidechatExpireCommand,
]);
export type InternalOrchestrationCommand = typeof InternalOrchestrationCommand.Type;

export const OrchestrationCommand = Schema.Union([
  DispatchableClientOrchestrationCommand,
  InternalOrchestrationCommand,
]);
export type OrchestrationCommand = typeof OrchestrationCommand.Type;

export const OrchestrationEventType = Schema.Literals([
  "space.created",
  "space.meta-updated",
  "space.order-updated",
  "space.deleted",
  "project.created",
  "project.meta-updated",
  "project.deleted",
  "sidebar-section.created",
  "sidebar-section.renamed",
  "sidebar-section.collapsed",
  "sidebar-section.deleted",
  "sidebar-section.order-updated",
  "sidebar-section.thread-placed",
  "sidebar-section.project-placed",
  "sidebar-section.thread-order-updated",
  "sidebar-projects.order-updated",
  "sidebar-order.legacy-imported",
  "thread.created",
  "thread.deleted",
  // Legacy desktop installs can still contain these rows in orchestration_events.
  "thread.archived",
  "thread.unarchived",
  "thread.meta-updated",
  "thread.pinned-message-added",
  "thread.pinned-message-removed",
  "thread.pinned-message-done-set",
  "thread.pinned-message-label-set",
  "thread.runtime-mode-set",
  "thread.interaction-mode-set",
  "thread.message-sent",
  "thread.async-user-input-answered",
  "thread.turn-queued",
  "thread.turn-start-requested",
  "thread.turn-capacity-retry-requested",
  "thread.turn-safety-buffer-retry-requested",
  "thread.turn-resume-requested",
  "thread.claude-cache-set",
  "thread.claude-cache-response-requested",
  "thread.goal-continuation-requested",
  "thread.turn-interrupt-requested",
  "thread.task-stop-requested",
  "thread.task-background-requested",
  "thread.approval-response-requested",
  "thread.user-input-response-requested",
  "thread.checkpoint-revert-requested",
  "thread.reverted",
  "thread.conversation-rollback-requested",
  "thread.conversation-rolled-back",
  "thread.message-edit-resend-requested",
  "thread.session-stop-requested",
  "thread.session-set",
  "thread.proposed-plan-upserted",
  "thread.turn-diff-completed",
  "thread.activity-appended",
  "thread.sidechat-activity-recorded",
  "thread.sidechat-expired",
]);
export type OrchestrationEventType = typeof OrchestrationEventType.Type;

export const OrchestrationAggregateKind = Schema.Literals([
  "space",
  "project",
  "thread",
  "sidebar-section",
]);
export type OrchestrationAggregateKind = typeof OrchestrationAggregateKind.Type;
export const OrchestrationActorKind = Schema.Literals(["client", "server", "provider"]);

export const SpaceCreatedPayload = Schema.Struct({
  spaceId: SpaceId,
  name: SpaceName,
  icon: SpaceIconName,
  sortOrder: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const SpaceMetaUpdatedPayload = Schema.Struct({
  spaceId: SpaceId,
  name: Schema.optional(SpaceName),
  icon: Schema.optional(SpaceIconName),
  updatedAt: IsoDateTime,
});

export const SpaceOrderUpdatedPayload = Schema.Struct({
  spaceId: SpaceId,
  orderedSpaceIds: Schema.Array(SpaceId).check(Schema.isMaxLength(SPACES_MAX_COUNT)),
  updatedAt: IsoDateTime,
});

export const SpaceDeletedPayload = Schema.Struct({
  spaceId: SpaceId,
  deletedAt: IsoDateTime,
});

export const ProjectCreatedPayload = Schema.Struct({
  projectId: ProjectId,
  kind: Schema.optional(ProjectKind).pipe(Schema.withDecodingDefault(() => "project")),
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  defaultModelSelection: Schema.NullOr(ModelSelection),
  scripts: Schema.Array(ProjectScript),
  isPinned: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  spaceId: Schema.optional(Schema.NullOr(SpaceId)).pipe(Schema.withDecodingDefault(() => null)),
  additionalFolders: ProjectAdditionalFoldersField,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ProjectMetaUpdatedPayload = Schema.Struct({
  projectId: ProjectId,
  kind: Schema.optional(ProjectKind),
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
  isPinned: Schema.optional(Schema.Boolean),
  spaceId: Schema.optional(Schema.NullOr(SpaceId)),
  updatedAt: IsoDateTime,
});

export const ProjectDeletedPayload = Schema.Struct({
  projectId: ProjectId,
  deletedAt: IsoDateTime,
});

export const SidebarSectionCreatedPayload = Schema.Struct({
  sectionId: SidebarSectionId,
  name: SidebarSectionName,
  sortOrder: NonNegativeInt,
  isCollapsed: Schema.Boolean,
  initialThreadId: Schema.optional(ThreadId),
  /** Revision reserved by a revision-bearing section-create command. */
  sidebarOrderRevision: Schema.optional(SidebarOrderRevision),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const SidebarSectionRenamedPayload = Schema.Struct({
  sectionId: SidebarSectionId,
  name: SidebarSectionName,
  updatedAt: IsoDateTime,
});

export const SidebarSectionCollapsedPayload = Schema.Struct({
  sectionId: SidebarSectionId,
  isCollapsed: Schema.Boolean,
  updatedAt: IsoDateTime,
});

export const SidebarSectionDeletedPayload = Schema.Struct({
  sectionId: SidebarSectionId,
  /** Revision reserved by a revision-bearing section-delete command. */
  sidebarOrderRevision: Schema.optional(SidebarOrderRevision),
  /** Exact section incarnation removed by this event, when emitted by the current writer. */
  sectionCreatedAt: Schema.optional(IsoDateTime),
  /** Complete post-delete order; old events omit this and remain replayable. */
  sidebarOrderItems: Schema.optional(Schema.Array(OrchestrationSidebarOrderItem)),
  deletedAt: IsoDateTime,
});

export const SidebarSectionOrderUpdatedPayload = Schema.Struct({
  sectionId: SidebarSectionId,
  orderedSectionIds: Schema.Array(SidebarSectionId).check(
    Schema.isMaxLength(SIDEBAR_SECTIONS_MAX_COUNT),
  ),
  sidebarOrderRevision: Schema.optional(SidebarOrderRevision),
  updatedAt: IsoDateTime,
});

export const SidebarSectionThreadPlacedPayload = Schema.Struct({
  sectionId: Schema.NullOr(SidebarSectionId),
  threadId: ThreadId,
  destination: Schema.Literals(["custom", "pinned", "default"]),
  sortOrder: Schema.optional(NonNegativeInt),
  beforeThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  sectionCreatedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  sidebarOrderRevision: Schema.optional(SidebarOrderRevision),
  sidebarOrderItems: Schema.optional(Schema.Array(OrchestrationSidebarOrderItem)),
  updatedAt: IsoDateTime,
});

export const SidebarSectionProjectPlacedPayload = Schema.Struct({
  sectionId: Schema.NullOr(SidebarSectionId),
  projectId: ProjectId,
  destination: Schema.Literals(["custom", "pinned", "default"]),
  beforeItemKey: Schema.NullOr(SidebarSectionItemKey),
  sortOrder: Schema.optional(NonNegativeInt),
  sectionCreatedAt: Schema.NullOr(IsoDateTime),
  sidebarOrderRevision: SidebarOrderRevision,
  sidebarOrderItems: Schema.Array(OrchestrationSidebarOrderItem),
  updatedAt: IsoDateTime,
});

export const SidebarSectionThreadOrderUpdatedPayload = Schema.Struct({
  sectionId: SidebarSectionId,
  sectionCreatedAt: IsoDateTime,
  orderedThreadIds: Schema.Array(ThreadId),
  sidebarOrderRevision: SidebarOrderRevision,
  sidebarOrderItems: Schema.Array(OrchestrationSidebarOrderItem),
  updatedAt: IsoDateTime,
});

export const SidebarProjectsOrderUpdatedPayload = Schema.Struct({
  orderedProjectIds: Schema.Array(ProjectId),
  sidebarOrderRevision: SidebarOrderRevision,
  sidebarOrderItems: Schema.Array(OrchestrationSidebarOrderItem),
  updatedAt: IsoDateTime,
});

export const SidebarOrderLegacyImportedPayload = Schema.Struct({
  expectedSidebarOrderRevision: Schema.optionalKey(SidebarOrderRevision),
  sidebarOrderRevision: SidebarOrderRevision,
  items: Schema.Array(OrchestrationSidebarOrderItem),
  updatedAt: IsoDateTime,
});

export const ThreadCreatedPayload = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(() => DEFAULT_RUNTIME_MODE)),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  envMode: Schema.optional(ThreadEnvironmentMode).pipe(Schema.withDecodingDefault(() => "local")),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  workingDirectory: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  associatedWorktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  associatedWorktreeBranch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  associatedWorktreeRef: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  createBranchFlowCompleted: Schema.optional(Schema.Boolean).pipe(
    Schema.withDecodingDefault(() => false),
  ),
  isPinned: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  creationSource: Schema.optional(Schema.NullOr(ThreadCreationSource)),
  sourceThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  sourceTurnId: Schema.optional(Schema.NullOr(TurnId)),
  gatewayOperationId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  gatewayOperationIndex: Schema.optional(Schema.NullOr(NonNegativeInt)),
  subagentAgentId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  subagentNickname: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  subagentRole: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  forkSourceThreadId: Schema.optional(Schema.NullOr(ThreadId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  /**
   * Source message a fork was taken from ("Fork from this turn"). The provider
   * fork must not carry native history past it. Null/absent = whole thread.
   */
  forkSourceMessageId: Schema.optional(Schema.NullOr(MessageId)),
  sidechatSourceThreadId: SidechatSourceThreadId,
  sidechatContext: SidechatContextField,
  sidechatLastActivityAt: SidechatLifecycleTimestamp,
  sidechatExpiredAt: SidechatLifecycleTimestamp,
  lastKnownPr: Schema.optional(Schema.NullOr(OrchestrationThreadPullRequest)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  handoff: Schema.NullOr(ThreadHandoff).pipe(Schema.withDecodingDefault(() => null)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadDeletedPayload = Schema.Struct({
  threadId: ThreadId,
  /** Revision reserved when deletion removes an explicit sidebar item. */
  sidebarOrderRevision: Schema.optional(SidebarOrderRevision),
  deletedAt: IsoDateTime,
});

/** The exact custom-section incarnation and item order saved for archive Undo. */
export const ThreadArchivedSidebarPlacement = Schema.Struct({
  destination: Schema.optional(SidebarOrderDestination),
  sectionId: Schema.NullOr(SidebarSectionId),
  sectionCreatedAt: Schema.NullOr(IsoDateTime),
  sortOrder: NonNegativeInt,
});
export type ThreadArchivedSidebarPlacement = typeof ThreadArchivedSidebarPlacement.Type;

/** A custom placement restored by one final archive-cohort Undo event. */
export const ThreadRestoredSidebarPlacement = Schema.Struct({
  threadId: ThreadId,
  placement: ThreadArchivedSidebarPlacement,
});
export type ThreadRestoredSidebarPlacement = typeof ThreadRestoredSidebarPlacement.Type;
export const ThreadSidechatActivityRecordedPayload = Schema.Struct({
  threadId: ThreadId,
  lastActivityAt: IsoDateTime,
});

export const ThreadSidechatExpiredPayload = Schema.Struct({
  threadId: ThreadId,
  expectedLastActivityAt: IsoDateTime,
  expiredAt: IsoDateTime,
});

export const ThreadArchivedPayload = Schema.Struct({
  threadId: ThreadId,
  // Required for new events, optional for legacy events
  archivedAt: Schema.optional(IsoDateTime),
  updatedAt: Schema.optional(IsoDateTime),
  // Only explicit custom-section membership is captured. Inherited descendants
  // intentionally omit this field and restore to their normal presentation.
  placement: Schema.optional(ThreadArchivedSidebarPlacement),
  /** One revision shared by every event in an archive cohort batch. */
  sidebarOrderRevision: Schema.optional(SidebarOrderRevision),
});

export const ThreadUnarchivedPayload = Schema.Struct({
  threadId: ThreadId,
  // Legacy field - kept for backward compatibility with old events
  unarchivedAt: Schema.optional(IsoDateTime),
  // Required for new events
  updatedAt: Schema.optional(IsoDateTime),
  // The server selects this only when the saved section incarnation still exists.
  restoredSidebarPlacement: Schema.optional(Schema.NullOr(ThreadArchivedSidebarPlacement)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  // New cohort restores mark the root-last event and carry the complete set of
  // explicit placements so projectors and shell publication can apply one
  // atomic batch even when the root itself has no custom item.
  isArchiveCohortFinal: Schema.optional(Schema.Boolean).pipe(
    Schema.withDecodingDefault(() => false),
  ),
  restoredSidebarPlacements: Schema.optional(
    Schema.Array(ThreadRestoredSidebarPlacement).check(
      Schema.isMaxLength(SIDEBAR_SECTION_ITEMS_MAX_COUNT),
    ),
  ).pipe(Schema.withDecodingDefault(() => [])),
  /** One revision shared by every event in an archive-cohort restore batch. */
  sidebarOrderRevision: Schema.optional(SidebarOrderRevision),
});

export const ThreadProviderHandoff = Schema.Struct({
  sourceModelSelection: ModelSelection,
});
export type ThreadProviderHandoff = typeof ThreadProviderHandoff.Type;

export const ThreadMetaUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  title: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  envMode: Schema.optional(ThreadEnvironmentMode),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  workingDirectory: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  associatedWorktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  associatedWorktreeBranch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  associatedWorktreeRef: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  createBranchFlowCompleted: Schema.optional(Schema.Boolean),
  isPinned: Schema.optional(Schema.Boolean),
  settledAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  snoozedUntil: Schema.optional(Schema.NullOr(IsoDateTime)),
  snoozeReminderAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  subagentAgentId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  subagentNickname: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  subagentRole: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  handoff: Schema.optional(Schema.NullOr(ThreadHandoff)),
  lastKnownPr: Schema.optional(Schema.NullOr(OrchestrationThreadPullRequest)),
  pinnedMessages: Schema.optional(ThreadPinnedMessages),
  threadMarkers: Schema.optional(Schema.Array(ThreadMarker)),
  notes: Schema.optional(ThreadNotes),
  goal: Schema.optional(ThreadGoal),
  goalStartBehavior: Schema.optional(ThreadGoalStartBehavior),
  goalStartedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  goalPausedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  goalAchievements: Schema.optional(ThreadGoalAchievements),
  providerHandoff: Schema.optional(ThreadProviderHandoff),
  updatedAt: IsoDateTime,
});

export const ThreadPinnedMessageAddedPayload = Schema.Struct({
  threadId: ThreadId,
  pin: PinnedMessage,
  updatedAt: IsoDateTime,
});

export const ThreadPinnedMessageRemovedPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  updatedAt: IsoDateTime,
});

export const ThreadPinnedMessageDoneSetPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  done: Schema.Boolean,
  updatedAt: IsoDateTime,
});

export const ThreadPinnedMessageLabelSetPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  label: Schema.NullOr(PinnedMessageLabel),
  updatedAt: IsoDateTime,
});

export const ThreadRuntimeModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  updatedAt: IsoDateTime,
});

export const ThreadInteractionModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  previousInteractionMode: Schema.optional(ProviderInteractionMode),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  updatedAt: IsoDateTime,
});

export const ThreadMessageSentPayload = Schema.Struct({
  asyncUserInput: Schema.optional(AsyncUserInput),
  threadId: ThreadId,
  messageId: MessageId,
  realtimeHandoffId: Schema.optional(TrimmedNonEmptyString),
  role: OrchestrationMessageRole,
  text: Schema.String,
  // Mirrors ThreadMessageAssistantDeltaCommand.segmentStartedAt: set on the
  // first delta of a new text segment (after a row-making event). The message
  // projection persists segment boundaries into the message's textSegments.
  segmentStartedAt: Schema.optional(IsoDateTime),
  segmentSequence: Schema.optional(NonNegativeInt),
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  skills: Schema.optional(Schema.Array(ProviderSkillReference)),
  mentions: Schema.optional(Schema.Array(ProviderMentionReference)),
  dispatchMode: Schema.optional(TurnDispatchMode),
  dispatchOrigin: Schema.optional(MessageDispatchOrigin),
  startsNewTurn: Schema.optional(Schema.Boolean),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  source: OrchestrationMessageSource.pipe(Schema.withDecodingDefault(() => "native")),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadAsyncUserInputAnsweredPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  response: AsyncUserInputResponse,
});

export const ThreadClaudeCacheSetPayload = Schema.Struct({
  threadId: ThreadId,
  review: Schema.NullOr(PendingClaudeCacheReview),
  updatedAt: IsoDateTime,
});
export const ThreadClaudeCacheResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  review: PendingClaudeCacheReview,
  decision: Schema.Literals(["continue", "compact", "cancel"]),
  createdAt: IsoDateTime,
});

export const ThreadTurnStartRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  // Server-owned pursuit identity for the visible first goal turn, retained by queue replay.
  initialGoalStartedAt: Schema.optional(IsoDateTime),
  modelSelection: Schema.optional(ModelSelection),
  providerOptions: Schema.optional(ProviderStartOptions),
  enableComputerControl: Schema.optional(Schema.Boolean),
  computerControlMode: Schema.optional(ComputerControlMode),
  computerControlGeneration: Schema.optional(NonNegativeInt),
  reviewTarget: Schema.optional(ProviderReviewTarget),
  assistantDeliveryMode: Schema.optional(AssistantDeliveryMode),
  dispatchMode: TurnDispatchMode.pipe(Schema.withDecodingDefault(() => DEFAULT_TURN_DISPATCH_MODE)),
  dispatchOrigin: Schema.optional(MessageDispatchOrigin),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(() => DEFAULT_RUNTIME_MODE)),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  turnTrigger: Schema.optional(ProviderTurnTrigger),
  createdAt: IsoDateTime,
});

export const ThreadTurnCapacityRetryRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  trigger: CapacityRetryTrigger,
  createdAt: IsoDateTime,
});

export const ThreadTurnSafetyBufferRetryRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  messageId: MessageId,
  sourceActivityId: EventId,
  targetModel: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

export const ThreadTurnResumeRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  createdAt: IsoDateTime,
});

export const ThreadTurnQueuedPayload = ThreadTurnStartRequestedPayload;

export const ThreadGoalContinuationRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  goalStartedAt: Schema.NullOr(IsoDateTime),
  trigger: ThreadGoalContinuationTrigger,
  sourceTurnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

export const ThreadTurnInterruptRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  requestedBy: Schema.optional(TurnInterruptRequestedBy),
  createdAt: IsoDateTime,
});

export const ThreadTaskStopRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  taskId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

export const ThreadTaskBackgroundRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  toolUseId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

export const ThreadApprovalResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  lifecycleGeneration: Schema.optional(TrimmedNonEmptyString),
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});

const ThreadUserInputResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  lifecycleGeneration: Schema.optional(TrimmedNonEmptyString),
  answers: ProviderUserInputAnswers,
  createdAt: IsoDateTime,
});

export const ThreadCheckpointRevertRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  scope: Schema.optional(Schema.Literals(["thread", "files"])).pipe(
    Schema.withDecodingDefault(() => "thread"),
  ),
  createdAt: IsoDateTime,
});

export const ThreadRevertedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
});

export const ThreadConversationRollbackRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  numTurns: NonNegativeInt,
  createdAt: IsoDateTime,
});

export const ThreadConversationRolledBackPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  numTurns: NonNegativeInt,
  removedTurnIds: Schema.optional(Schema.Array(TurnId)),
  skipAttachmentPrune: Schema.optional(Schema.Boolean),
  preserveUnboundMessages: Schema.optional(Schema.Boolean),
});

export const ThreadMessageEditResendRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  rollbackTurnCount: Schema.optional(NonNegativeInt),
  removedTurnIds: Schema.optional(Schema.Array(TurnId)),
  modelSelection: Schema.optional(ModelSelection),
  providerOptions: Schema.optional(ProviderStartOptions),
  enableComputerControl: Schema.optional(Schema.Boolean),
  computerControlMode: Schema.optional(ComputerControlMode),
  computerControlGeneration: Schema.optional(NonNegativeInt),
  assistantDeliveryMode: Schema.optional(AssistantDeliveryMode),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  createdAt: IsoDateTime,
});

export const ThreadSessionStopRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

export const ThreadSessionSetPayload = Schema.Struct({
  threadId: ThreadId,
  session: OrchestrationSession,
  modelSelection: Schema.optional(ModelSelection),
});

export const ThreadProposedPlanUpsertedPayload = Schema.Struct({
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
});

export const ThreadTurnDiffCompletedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
  preserveLatestTurn: Schema.optional(Schema.Boolean),
});

export const ThreadActivityAppendedPayload = Schema.Struct({
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
});

export const OrchestrationEventMetadata = Schema.Struct({
  checkpointRuntimeSequence: Schema.optional(NonNegativeInt),
  providerTurnId: Schema.optional(TrimmedNonEmptyString),
  providerItemId: Schema.optional(ProviderItemId),
  adapterKey: Schema.optional(TrimmedNonEmptyString),
  requestId: Schema.optional(ApprovalRequestId),
  ingestedAt: Schema.optional(IsoDateTime),
});
export type OrchestrationEventMetadata = typeof OrchestrationEventMetadata.Type;

const EventBaseFields = {
  sequence: NonNegativeInt,
  eventId: EventId,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([SpaceId, ProjectId, ThreadId, SidebarSectionId]),
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  metadata: OrchestrationEventMetadata,
} as const;

export const OrchestrationEvent = Schema.Union([
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("space.created"),
    payload: SpaceCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("space.meta-updated"),
    payload: SpaceMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("space.order-updated"),
    payload: SpaceOrderUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("space.deleted"),
    payload: SpaceDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.created"),
    payload: ProjectCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.meta-updated"),
    payload: ProjectMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.deleted"),
    payload: ProjectDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("sidebar-section.created"),
    payload: SidebarSectionCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("sidebar-section.renamed"),
    payload: SidebarSectionRenamedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("sidebar-section.collapsed"),
    payload: SidebarSectionCollapsedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("sidebar-section.deleted"),
    payload: SidebarSectionDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("sidebar-section.order-updated"),
    payload: SidebarSectionOrderUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("sidebar-section.thread-placed"),
    payload: SidebarSectionThreadPlacedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("sidebar-section.project-placed"),
    payload: SidebarSectionProjectPlacedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("sidebar-section.thread-order-updated"),
    payload: SidebarSectionThreadOrderUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("sidebar-projects.order-updated"),
    payload: SidebarProjectsOrderUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("sidebar-order.legacy-imported"),
    payload: SidebarOrderLegacyImportedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.created"),
    payload: ThreadCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.deleted"),
    payload: ThreadDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.archived"),
    payload: ThreadArchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unarchived"),
    payload: ThreadUnarchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.meta-updated"),
    payload: ThreadMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.pinned-message-added"),
    payload: ThreadPinnedMessageAddedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.pinned-message-removed"),
    payload: ThreadPinnedMessageRemovedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.pinned-message-done-set"),
    payload: ThreadPinnedMessageDoneSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.pinned-message-label-set"),
    payload: ThreadPinnedMessageLabelSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.runtime-mode-set"),
    payload: ThreadRuntimeModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.interaction-mode-set"),
    payload: ThreadInteractionModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.message-sent"),
    payload: ThreadMessageSentPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.async-user-input-answered"),
    payload: ThreadAsyncUserInputAnsweredPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.claude-cache-set"),
    payload: ThreadClaudeCacheSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.claude-cache-response-requested"),
    payload: ThreadClaudeCacheResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-queued"),
    payload: ThreadTurnQueuedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-start-requested"),
    payload: ThreadTurnStartRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-capacity-retry-requested"),
    payload: ThreadTurnCapacityRetryRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-safety-buffer-retry-requested"),
    payload: ThreadTurnSafetyBufferRetryRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-resume-requested"),
    payload: ThreadTurnResumeRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.goal-continuation-requested"),
    payload: ThreadGoalContinuationRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-interrupt-requested"),
    payload: ThreadTurnInterruptRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.task-stop-requested"),
    payload: ThreadTaskStopRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.task-background-requested"),
    payload: ThreadTaskBackgroundRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.approval-response-requested"),
    payload: ThreadApprovalResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.user-input-response-requested"),
    payload: ThreadUserInputResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.checkpoint-revert-requested"),
    payload: ThreadCheckpointRevertRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.reverted"),
    payload: ThreadRevertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.conversation-rollback-requested"),
    payload: ThreadConversationRollbackRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.conversation-rolled-back"),
    payload: ThreadConversationRolledBackPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.message-edit-resend-requested"),
    payload: ThreadMessageEditResendRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-stop-requested"),
    payload: ThreadSessionStopRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-set"),
    payload: ThreadSessionSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.proposed-plan-upserted"),
    payload: ThreadProposedPlanUpsertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-diff-completed"),
    payload: ThreadTurnDiffCompletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.activity-appended"),
    payload: ThreadActivityAppendedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.sidechat-activity-recorded"),
    payload: ThreadSidechatActivityRecordedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.sidechat-expired"),
    payload: ThreadSidechatExpiredPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.marker-added"),
    payload: Schema.Struct({ threadId: ThreadId, marker: ThreadMarker, updatedAt: IsoDateTime }),
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.marker-removed"),
    payload: Schema.Struct({
      threadId: ThreadId,
      markerId: ThreadMarkerId,
      updatedAt: IsoDateTime,
    }),
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.marker-done-set"),
    payload: Schema.Struct({
      threadId: ThreadId,
      markerId: ThreadMarkerId,
      done: Schema.Boolean,
      updatedAt: IsoDateTime,
    }),
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.marker-label-set"),
    payload: Schema.Struct({
      threadId: ThreadId,
      markerId: ThreadMarkerId,
      label: Schema.NullOr(Schema.String),
      updatedAt: IsoDateTime,
    }),
  }),
]);
export type OrchestrationEvent = typeof OrchestrationEvent.Type;

/** Stable message-order boundary; sequence is null for imported/legacy rows. */
export const OrchestrationThreadHistoryCursor = Schema.Struct({
  messageId: MessageId,
  createdAt: IsoDateTime,
  sequence: Schema.NullOr(NonNegativeInt),
});
export type OrchestrationThreadHistoryCursor = typeof OrchestrationThreadHistoryCursor.Type;
export const OrchestrationThreadActivityHistoryCursor = Schema.Struct({
  activityId: EventId,
  createdAt: IsoDateTime,
});
export type OrchestrationThreadActivityHistoryCursor =
  typeof OrchestrationThreadActivityHistoryCursor.Type;
export const OrchestrationThreadMessageWindow = Schema.Struct({
  limit: NonNegativeInt.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(500)),
  before: Schema.optional(OrchestrationThreadHistoryCursor),
  beforeActivity: Schema.optional(OrchestrationThreadActivityHistoryCursor),
});
export type OrchestrationThreadMessageWindow = typeof OrchestrationThreadMessageWindow.Type;
export const OrchestrationThreadHistory = Schema.Struct({
  totalMessageCount: NonNegativeInt,
  olderCursor: Schema.NullOr(OrchestrationThreadHistoryCursor),
  olderActivityCursor: Schema.optional(Schema.NullOr(OrchestrationThreadActivityHistoryCursor)),
  totalActivityCount: Schema.optional(NonNegativeInt),
  /** Existing rollback/revert event fence; invalidates retained historical rows. */
  revisionSequence: Schema.optional(NonNegativeInt),
});
export type OrchestrationThreadHistory = typeof OrchestrationThreadHistory.Type;

export const OrchestrationThreadDetailSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  thread: OrchestrationThread,
  history: Schema.optional(OrchestrationThreadHistory),
  /**
   * Highest applied rollback/revert sequence included in `thread`. A later
   * value tells the client to replace transcript history instead of merging
   * rows the server removed.
   */
  historyRevisionSequence: Schema.optional(NonNegativeInt),
});
export type OrchestrationThreadDetailSnapshot = typeof OrchestrationThreadDetailSnapshot.Type;

// The whole cursor-resume gap in one item, sent only when the subscriber
// opted in with `batchReplay`. Clients apply it as one store update, so a
// stale cached turn jumps straight to its current state instead of
// rendering every intermediate step of the catch-up. The named interface
// keeps declaration emit from inlining the event union into the RPC groups,
// which otherwise exceeds the compiler's serialization limit (TS7056).
export interface OrchestrationThreadReplayItemSchema extends Schema.Struct<{
  readonly kind: Schema.Literal<"replay">;
  readonly events: Schema.$Array<typeof OrchestrationEvent>;
  readonly threadId: Schema.optional<typeof ThreadId>;
}> {}
export const OrchestrationThreadReplayItem: OrchestrationThreadReplayItemSchema = Schema.Struct({
  kind: Schema.Literal("replay"),
  events: Schema.Array(OrchestrationEvent),
  threadId: Schema.optional(ThreadId),
});
export type OrchestrationThreadReplayItem = typeof OrchestrationThreadReplayItem.Type;

export const OrchestrationThreadStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationThreadDetailSnapshot,
  }),
  Schema.Struct({
    kind: Schema.Literal("event"),
    event: OrchestrationEvent,
  }),
  OrchestrationThreadReplayItem,
]);
export type OrchestrationThreadStreamItem = typeof OrchestrationThreadStreamItem.Type;

export const OrchestrationCommandReceiptStatus = Schema.Literals(["accepted", "rejected"]);
export type OrchestrationCommandReceiptStatus = typeof OrchestrationCommandReceiptStatus.Type;

export const TurnCountRange = Schema.Struct({
  fromTurnCount: NonNegativeInt,
  toTurnCount: NonNegativeInt,
}).check(
  Schema.makeFilter(
    (input) =>
      input.fromTurnCount <= input.toTurnCount ||
      new SchemaIssue.InvalidValue(Option.some(input.fromTurnCount), {
        message: "fromTurnCount must be less than or equal to toTurnCount",
      }),
    { identifier: "OrchestrationTurnDiffRange" },
  ),
);

export const ThreadTurnDiff = TurnCountRange.mapFields(
  Struct.assign({
    threadId: ThreadId,
    diff: Schema.String,
  }),
  { unsafePreserveChecks: true },
);

export const ProviderSessionRuntimeStatus = Schema.Literals([
  "starting",
  "running",
  "stopped",
  "error",
]);
export type ProviderSessionRuntimeStatus = typeof ProviderSessionRuntimeStatus.Type;

const ProjectionThreadTurnStatus = Schema.Literals([
  "running",
  "completed",
  "interrupted",
  "error",
]);
export type ProjectionThreadTurnStatus = typeof ProjectionThreadTurnStatus.Type;

const ProjectionCheckpointRow = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type ProjectionCheckpointRow = typeof ProjectionCheckpointRow.Type;

export const DispatchResult = Schema.Struct({
  sequence: NonNegativeInt,
  sidebarOrderRevision: Schema.optional(SidebarOrderRevision),
});
export type DispatchResult = typeof DispatchResult.Type;

// Resolves a lost turn-start acknowledgement without starting a new turn. If
// the command was never accepted, the server durably rejects late arrivals.
export const OrchestrationSettleTurnDispatchInput = Schema.Struct({
  command: ClientThreadTurnStartCommand,
});
export const OrchestrationSettleTurnDispatchResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("accepted"), sequence: NonNegativeInt }),
  Schema.Struct({ status: Schema.Literal("rejected"), message: Schema.String }),
]);
export type OrchestrationSettleTurnDispatchResult =
  typeof OrchestrationSettleTurnDispatchResult.Type;

export const OrchestrationGetSnapshotInput = Schema.Struct({});
export type OrchestrationGetSnapshotInput = typeof OrchestrationGetSnapshotInput.Type;
const OrchestrationGetSnapshotResult = OrchestrationReadModel;
export type OrchestrationGetSnapshotResult = typeof OrchestrationGetSnapshotResult.Type;

export const OrchestrationGetShellSnapshotInput = Schema.Struct({});
export type OrchestrationGetShellSnapshotInput = typeof OrchestrationGetShellSnapshotInput.Type;
const OrchestrationGetShellSnapshotResult = OrchestrationShellSnapshot;
export type OrchestrationGetShellSnapshotResult = typeof OrchestrationGetShellSnapshotResult.Type;

export const OrchestrationRepairStateInput = Schema.Struct({});
export type OrchestrationRepairStateInput = typeof OrchestrationRepairStateInput.Type;
const OrchestrationRepairStateResult = OrchestrationReadModel;
export type OrchestrationRepairStateResult = typeof OrchestrationRepairStateResult.Type;

export const OrchestrationGetTurnDiffInput = TurnCountRange.mapFields(
  Struct.assign({
    threadId: ThreadId,
    ignoreWhitespace: Schema.optional(Schema.Boolean),
  }),
  { unsafePreserveChecks: true },
);
export type OrchestrationGetTurnDiffInput = typeof OrchestrationGetTurnDiffInput.Type;

export const OrchestrationGetTurnDiffResult = ThreadTurnDiff;
export type OrchestrationGetTurnDiffResult = typeof OrchestrationGetTurnDiffResult.Type;

export const OrchestrationGetFullThreadDiffInput = Schema.Struct({
  threadId: ThreadId,
  toTurnCount: NonNegativeInt,
  ignoreWhitespace: Schema.optional(Schema.Boolean),
});
export type OrchestrationGetFullThreadDiffInput = typeof OrchestrationGetFullThreadDiffInput.Type;

export const OrchestrationGetFullThreadDiffResult = ThreadTurnDiff;
export type OrchestrationGetFullThreadDiffResult = typeof OrchestrationGetFullThreadDiffResult.Type;

export const OrchestrationReplayEventsInput = Schema.Struct({
  fromSequenceExclusive: NonNegativeInt,
  threadId: Schema.optional(ThreadId),
});
export type OrchestrationReplayEventsInput = typeof OrchestrationReplayEventsInput.Type;

const OrchestrationReplayEventsResult = Schema.Array(OrchestrationEvent);
export type OrchestrationReplayEventsResult = typeof OrchestrationReplayEventsResult.Type;

export const ProviderDeliveryReconciliationOutcome = Schema.Literals([
  "accepted",
  "safe_retry",
  "abandon",
]);
export type ProviderDeliveryReconciliationOutcome =
  typeof ProviderDeliveryReconciliationOutcome.Type;

export const ProviderDeliveryBlockingEvidence = Schema.Struct({
  consumerName: Schema.String,
  eventSequence: NonNegativeInt,
  eventId: EventId,
  eventType: Schema.String,
  occurredAt: IsoDateTime,
  threadId: ThreadId,
  state: Schema.Literals(["dead", "uncertain"]),
  attemptCount: NonNegativeInt,
  lastError: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
  lastReconciliationOutcome: Schema.NullOr(ProviderDeliveryReconciliationOutcome),
  lastReconciledAt: Schema.NullOr(IsoDateTime),
  lastReconciledBy: Schema.NullOr(Schema.String),
  lastReconciliationNote: Schema.NullOr(Schema.String),
});
export type ProviderDeliveryBlockingEvidence = typeof ProviderDeliveryBlockingEvidence.Type;

export const OrchestrationListProviderDeliveryBlockersInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  limit: Schema.optional(PositiveInt),
});
export type OrchestrationListProviderDeliveryBlockersInput =
  typeof OrchestrationListProviderDeliveryBlockersInput.Type;

export const OrchestrationListProviderDeliveryBlockersResult = Schema.Array(
  ProviderDeliveryBlockingEvidence,
);
export type OrchestrationListProviderDeliveryBlockersResult =
  typeof OrchestrationListProviderDeliveryBlockersResult.Type;

export const OrchestrationReconcileProviderDeliveryInput = Schema.Struct({
  eventSequence: NonNegativeInt,
  threadId: ThreadId,
  expectedState: Schema.Literals(["dead", "uncertain"]),
  outcome: ProviderDeliveryReconciliationOutcome,
  note: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2_000))),
});
export type OrchestrationReconcileProviderDeliveryInput =
  typeof OrchestrationReconcileProviderDeliveryInput.Type;

export const OrchestrationReconcileProviderDeliveryResult = Schema.Struct({
  eventSequence: NonNegativeInt,
  threadId: ThreadId,
  outcome: ProviderDeliveryReconciliationOutcome,
  state: Schema.Literals(["retry", "succeeded", "dead", "uncertain"]),
  reconciledAt: IsoDateTime,
});
export type OrchestrationReconcileProviderDeliveryResult =
  typeof OrchestrationReconcileProviderDeliveryResult.Type;

/**
 * Desktop quit with "Resume chats automatically": the server durably records the
 * listed threads (plus their current turn) and interrupts them in one step, so
 * the renderer can reply to the quit request only after the record exists.
 */
export const QUIT_RESUME_MAX_THREADS = 256;
export const QUIT_RESUME_MAX_PROMPT_CHARS = 2_000;

export const OrchestrationPrepareQuitResumeInput = Schema.Struct({
  threadIds: Schema.Array(ThreadId).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(QUIT_RESUME_MAX_THREADS),
  ),
  /** User-turn text dispatched on each recorded thread at the next server start. */
  continuationPrompt: TrimmedNonEmptyString.check(Schema.isMaxLength(QUIT_RESUME_MAX_PROMPT_CHARS)),
});
export type OrchestrationPrepareQuitResumeInput = typeof OrchestrationPrepareQuitResumeInput.Type;

export const OrchestrationPrepareQuitResumeResult = Schema.Struct({
  /** Threads durably recorded for resume (unknown or deleted threads are dropped). */
  recordedThreadIds: Schema.Array(ThreadId),
  recordedAt: IsoDateTime,
});
export type OrchestrationPrepareQuitResumeResult = typeof OrchestrationPrepareQuitResumeResult.Type;

export const OrchestrationSubscribeShellInput = Schema.Struct({});
export type OrchestrationSubscribeShellInput = typeof OrchestrationSubscribeShellInput.Type;

export const OrchestrationUnsubscribeShellInput = Schema.Struct({});
export type OrchestrationUnsubscribeShellInput = typeof OrchestrationUnsubscribeShellInput.Type;

export const OrchestrationSubscribeThreadInput = Schema.Struct({
  threadId: ThreadId,
  // Cursor of the last event the client already applied. When present and the
  // gap fits the server's replay limit, the stream replays only the gap and
  // skips the full-history snapshot. Optional so older clients keep the
  // snapshot-first behavior unchanged.
  afterSequence: Schema.optional(NonNegativeInt),
  // Asks the server to deliver a cursor-resume gap as one `replay` stream item
  // instead of one `event` item per event. Opt-in so older clients, which do
  // not know the `replay` item, keep per-event replay.
  batchReplay: Schema.optional(Schema.Boolean),
  /** Opt-in bounded text history. Omission retains the legacy snapshot shape. */
  messageWindow: Schema.optional(OrchestrationThreadMessageWindow),
});
export type OrchestrationSubscribeThreadInput = typeof OrchestrationSubscribeThreadInput.Type;

export const OrchestrationGetThreadDetailSnapshotInput = Schema.Struct({
  threadId: ThreadId,
  messageWindow: Schema.optional(OrchestrationThreadMessageWindow),
});
export type OrchestrationGetThreadDetailSnapshotInput =
  typeof OrchestrationGetThreadDetailSnapshotInput.Type;

export const OrchestrationGetThreadDetailSnapshotResult = Schema.NullOr(
  OrchestrationThreadDetailSnapshot,
);
export type OrchestrationGetThreadDetailSnapshotResult =
  typeof OrchestrationGetThreadDetailSnapshotResult.Type;

// Exported so server and web enforce the same bounds the schema validates.
export const ORCHESTRATION_SEARCH_THREADS_MIN_QUERY_LENGTH = 2;
export const ORCHESTRATION_SEARCH_THREADS_MAX_LIMIT = 50;
export const ORCHESTRATION_SEARCH_THREADS_MAX_EXCERPT_LENGTH = 320;

/** Message-content search over persisted history, independent of what a client has hydrated. */
export const OrchestrationSearchThreadsInput = Schema.Struct({
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(200)).check(
    Schema.isMinLength(ORCHESTRATION_SEARCH_THREADS_MIN_QUERY_LENGTH),
  ),
  limit: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(ORCHESTRATION_SEARCH_THREADS_MAX_LIMIT)),
  ),
});
export type OrchestrationSearchThreadsInput = typeof OrchestrationSearchThreadsInput.Type;

export const OrchestrationThreadSearchMatch = Schema.Struct({
  threadId: ThreadId,
  /** Text around the first hit of the thread's best matching message. */
  excerpt: Schema.String.check(Schema.isMaxLength(ORCHESTRATION_SEARCH_THREADS_MAX_EXCERPT_LENGTH)),
  matchCount: PositiveInt,
});
export type OrchestrationThreadSearchMatch = typeof OrchestrationThreadSearchMatch.Type;

export const OrchestrationSearchThreadsResult = Schema.Struct({
  matches: Schema.Array(OrchestrationThreadSearchMatch),
});
export type OrchestrationSearchThreadsResult = typeof OrchestrationSearchThreadsResult.Type;

export const OrchestrationImportThreadInput = Schema.Struct({
  threadId: ThreadId,
  externalId: TrimmedNonEmptyString,
});
export type OrchestrationImportThreadInput = typeof OrchestrationImportThreadInput.Type;

export const OrchestrationImportThreadResult = Schema.Struct({
  threadId: ThreadId,
});
export type OrchestrationImportThreadResult = typeof OrchestrationImportThreadResult.Type;

export const OrchestrationRegenerateThreadTitleInput = Schema.Struct({
  threadId: ThreadId,
});
export type OrchestrationRegenerateThreadTitleInput =
  typeof OrchestrationRegenerateThreadTitleInput.Type;

export const OrchestrationRegenerateThreadTitleResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literals(["renamed", "unchanged"]),
    title: TrimmedNonEmptyString,
  }),
  Schema.Struct({ status: Schema.Literals(["no-context", "stale"]), title: Schema.Null }),
]);
export type OrchestrationRegenerateThreadTitleResult =
  typeof OrchestrationRegenerateThreadTitleResult.Type;

/**
 * Why a prediction was requested: `live` right after the thread's latest turn completes,
 * `catch_up` when the composer mounts or the window regains focus on an already idle thread.
 */
export const NextMessagePredictionGenerationTrigger = Schema.Literals(["live", "catch_up"]);
export type NextMessagePredictionGenerationTrigger =
  typeof NextMessagePredictionGenerationTrigger.Type;

export const OrchestrationPredictNextMessageInput = Schema.Struct({
  threadId: ThreadId,
  latestTurnId: TurnId,
  // Retained for wire compatibility with older clients; the server always uses
  // the active thread model, matching Codex's model:null prediction fork.
  model: Schema.optional(TrimmedNonEmptyString),
  // Older clients omit it; the server then treats the request as a catch-up.
  generationTrigger: Schema.optional(NextMessagePredictionGenerationTrigger),
});
export type OrchestrationPredictNextMessageInput = typeof OrchestrationPredictNextMessageInput.Type;

export const OrchestrationPredictNextMessageResult = Schema.Struct({
  text: Schema.String,
  latestTurnId: TurnId,
});
export type OrchestrationPredictNextMessageResult =
  typeof OrchestrationPredictNextMessageResult.Type;

export const OrchestrationUnsubscribeThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type OrchestrationUnsubscribeThreadInput = typeof OrchestrationUnsubscribeThreadInput.Type;

export const OrchestrationRpcSchemas = {
  getSnapshot: {
    input: OrchestrationGetSnapshotInput,
    output: OrchestrationGetSnapshotResult,
  },
  getShellSnapshot: {
    input: OrchestrationGetShellSnapshotInput,
    output: OrchestrationGetShellSnapshotResult,
  },
  getThreadDetailSnapshot: {
    input: OrchestrationGetThreadDetailSnapshotInput,
    output: OrchestrationGetThreadDetailSnapshotResult,
  },
  searchThreads: {
    input: OrchestrationSearchThreadsInput,
    output: OrchestrationSearchThreadsResult,
  },
  repairState: {
    input: OrchestrationRepairStateInput,
    output: OrchestrationRepairStateResult,
  },
  dispatchCommand: {
    input: ClientOrchestrationCommand,
    output: DispatchResult,
  },
  settleTurnDispatch: {
    input: OrchestrationSettleTurnDispatchInput,
    output: OrchestrationSettleTurnDispatchResult,
  },
  importThread: {
    input: OrchestrationImportThreadInput,
    output: OrchestrationImportThreadResult,
  },
  listProjectImports: { input: ListProjectImportsInput, output: ListProjectImportsResult },
  importProject: { input: ImportProjectInput, output: ImportProjectResult },
  loadProjectImportHistory: {
    input: LoadProjectImportHistoryInput,
    output: LoadProjectImportHistoryResult,
  },
  regenerateThreadTitle: {
    input: OrchestrationRegenerateThreadTitleInput,
    output: OrchestrationRegenerateThreadTitleResult,
  },
  predictNextMessage: {
    input: OrchestrationPredictNextMessageInput,
    output: OrchestrationPredictNextMessageResult,
  },
  getTurnDiff: {
    input: OrchestrationGetTurnDiffInput,
    output: OrchestrationGetTurnDiffResult,
  },
  getFullThreadDiff: {
    input: OrchestrationGetFullThreadDiffInput,
    output: OrchestrationGetFullThreadDiffResult,
  },
  getInlineVisual: {
    input: OrchestrationGetInlineVisualInput,
    output: OrchestrationGetInlineVisualResult,
  },
  replayEvents: {
    input: OrchestrationReplayEventsInput,
    output: OrchestrationReplayEventsResult,
  },
  listProviderDeliveryBlockers: {
    input: OrchestrationListProviderDeliveryBlockersInput,
    output: OrchestrationListProviderDeliveryBlockersResult,
  },
  reconcileProviderDelivery: {
    input: OrchestrationReconcileProviderDeliveryInput,
    output: OrchestrationReconcileProviderDeliveryResult,
  },
  prepareQuitResume: {
    input: OrchestrationPrepareQuitResumeInput,
    output: OrchestrationPrepareQuitResumeResult,
  },
  subscribeShell: {
    input: OrchestrationSubscribeShellInput,
    output: Schema.Void,
  },
  unsubscribeShell: {
    input: OrchestrationUnsubscribeShellInput,
    output: Schema.Void,
  },
  subscribeThread: {
    input: OrchestrationSubscribeThreadInput,
    output: Schema.Void,
  },
  unsubscribeThread: {
    input: OrchestrationUnsubscribeThreadInput,
    output: Schema.Void,
  },
} as const;
