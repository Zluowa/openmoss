import { Option, Schema } from "effect";
import { AsyncUserInputQuestions } from "./asyncUserInput";
import {
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProviderItemId,
  PositiveInt,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeSessionId,
  RuntimeTaskId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas";
import { ClaudeCacheObservation } from "./claudeCache";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;
const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown);

const RuntimeEventRawSource = Schema.Literals([
  "codex.app-server.notification",
  "codex.app-server.request",
  "codex.eventmsg",
  "claude.sdk.message",
  "claude.sdk.permission",
  "claude.sdk.hook",
  "codex.sdk.thread-event",
  "gemini.acp.message",
  "gemini.acp.stdout",
  "gemini.acp.stderr",
  "antigravity.cli.event",
  "acp.jsonrpc",
  "acp.cursor.extension",
  "opencode.sdk.event",
  "pi.sdk.event",
]);
export type RuntimeEventRawSource = typeof RuntimeEventRawSource.Type;

export const RuntimeEventRaw = Schema.Struct({
  source: RuntimeEventRawSource,
  method: Schema.optional(TrimmedNonEmptyStringSchema),
  messageType: Schema.optional(TrimmedNonEmptyStringSchema),
  payload: Schema.Unknown,
});
export type RuntimeEventRaw = typeof RuntimeEventRaw.Type;

const ProviderRequestId = TrimmedNonEmptyStringSchema;
export type ProviderRequestId = typeof ProviderRequestId.Type;

const ProviderRefs = Schema.Struct({
  providerThreadId: Schema.optional(TrimmedNonEmptyStringSchema),
  providerParentThreadId: Schema.optional(TrimmedNonEmptyStringSchema),
  providerTurnId: Schema.optional(TrimmedNonEmptyStringSchema),
  parentProviderTurnId: Schema.optional(TrimmedNonEmptyStringSchema),
  providerItemId: Schema.optional(ProviderItemId),
  providerRequestId: Schema.optional(ProviderRequestId),
});
export type ProviderRefs = typeof ProviderRefs.Type;

const RuntimeEventActor = Schema.Struct({
  kind: Schema.Literals(["user", "assistant", "provider", "system", "role", "automation"]),
  id: Schema.optional(TrimmedNonEmptyStringSchema),
  displayName: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type RuntimeEventActor = typeof RuntimeEventActor.Type;

const RuntimeEventRedactionState = Schema.Struct({
  state: Schema.Literals(["raw", "redacted", "not-applicable"]),
  redactedFields: Schema.optional(Schema.Array(TrimmedNonEmptyStringSchema)),
});
export type RuntimeEventRedactionState = typeof RuntimeEventRedactionState.Type;

const RuntimeSessionState = Schema.Literals([
  "starting",
  "ready",
  "running",
  "waiting",
  "stopped",
  "error",
]);
export type RuntimeSessionState = typeof RuntimeSessionState.Type;

const RuntimeThreadState = Schema.Literals([
  "active",
  "idle",
  "archived",
  "closed",
  "compacted",
  "error",
]);
export type RuntimeThreadState = typeof RuntimeThreadState.Type;

const RuntimeTurnState = Schema.Literals(["completed", "failed", "interrupted", "cancelled"]);
export type RuntimeTurnState = typeof RuntimeTurnState.Type;

const RuntimeTaskStatus = Schema.Literals(["pending", "inProgress", "completed"]);
export type RuntimeTaskStatus = typeof RuntimeTaskStatus.Type;

const RuntimeItemStatus = Schema.Literals(["inProgress", "completed", "failed", "declined"]);
export type RuntimeItemStatus = typeof RuntimeItemStatus.Type;

const RuntimeContentStreamKind = Schema.Literals([
  "assistant_text",
  "reasoning_text",
  "reasoning_summary_text",
  "plan_text",
  "command_output",
  "file_change_output",
  "unknown",
]);
export type RuntimeContentStreamKind = typeof RuntimeContentStreamKind.Type;

const RuntimeSessionExitKind = Schema.Literals(["graceful", "error"]);
export type RuntimeSessionExitKind = typeof RuntimeSessionExitKind.Type;

const RuntimeErrorClass = Schema.Literals([
  "provider_error",
  "transport_error",
  "permission_error",
  "validation_error",
  "unknown",
]);
export type RuntimeErrorClass = typeof RuntimeErrorClass.Type;

export const TOOL_LIFECYCLE_ITEM_TYPES = [
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "dynamic_tool_call",
  "collab_agent_tool_call",
  "web_search",
  "image_view",
  "image_generation",
] as const;

export const ToolLifecycleItemType = Schema.Literals(TOOL_LIFECYCLE_ITEM_TYPES);
export type ToolLifecycleItemType = typeof ToolLifecycleItemType.Type;

export function isToolLifecycleItemType(value: string): value is ToolLifecycleItemType {
  return TOOL_LIFECYCLE_ITEM_TYPES.includes(value as ToolLifecycleItemType);
}

export const CanonicalItemType = Schema.Literals([
  "user_message",
  "assistant_message",
  "reasoning",
  "plan",
  ...TOOL_LIFECYCLE_ITEM_TYPES,
  "review_entered",
  "review_exited",
  "context_compaction",
  "error",
  "unknown",
]);
export type CanonicalItemType = typeof CanonicalItemType.Type;

export const CanonicalRequestType = Schema.Literals([
  "command_execution_approval",
  "file_read_approval",
  "file_change_approval",
  "permissions_approval",
  "apply_patch_approval",
  "exec_command_approval",
  "tool_approval",
  "tool_user_input",
  "tool_approval",
  "dynamic_tool_call",
  "auth_tokens_refresh",
  "unknown",
]);
export type CanonicalRequestType = typeof CanonicalRequestType.Type;

const ProviderRuntimeEventType = Schema.Literals([
  "session.started",
  "session.configured",
  "session.state.changed",
  "session.exited",
  "thread.started",
  "thread.state.changed",
  "thread.metadata.updated",
  "thread.token-usage.updated",
  "thread.realtime.started",
  "thread.realtime.item-added",
  "thread.realtime.audio.delta",
  "thread.realtime.error",
  "thread.realtime.closed",
  "turn.started",
  "turn.completed",
  "turn.aborted",
  "turn.tasks.updated",
  "turn.proposed.delta",
  "turn.proposed.completed",
  "turn.diff.updated",
  "turn.steered",
  "item.started",
  "item.updated",
  "item.completed",
  "content.delta",
  "request.opened",
  "request.resolved",
  "user-input.requested",
  "user-input.resolved",
  "task.started",
  "task.progress",
  "task.updated",
  "task.completed",
  "hook.started",
  "hook.progress",
  "hook.completed",
  "tool.progress",
  "tool.summary",
  "auth.status",
  "account.updated",
  "account.rate-limits.updated",
  "mcp.status.updated",
  "mcp.oauth.completed",
  "automatic-approval-review.updated",
  "model.rerouted",
  "model.safety-buffering.updated",
  "config.warning",
  "deprecation.notice",
  "files.persisted",
  "vcs.state.changed",
  "runtime.warning",
  "runtime.error",
  "event.unmapped",
]);
export type ProviderRuntimeEventType = typeof ProviderRuntimeEventType.Type;

const SessionStartedType = Schema.Literal("session.started");
const SessionConfiguredType = Schema.Literal("session.configured");
const SessionStateChangedType = Schema.Literal("session.state.changed");
const SessionExitedType = Schema.Literal("session.exited");
const ThreadStartedType = Schema.Literal("thread.started");
const ThreadStateChangedType = Schema.Literal("thread.state.changed");
const ThreadMetadataUpdatedType = Schema.Literal("thread.metadata.updated");
const ThreadTokenUsageUpdatedType = Schema.Literal("thread.token-usage.updated");
const ThreadRealtimeStartedType = Schema.Literal("thread.realtime.started");
const ThreadRealtimeItemAddedType = Schema.Literal("thread.realtime.item-added");
const ThreadRealtimeAudioDeltaType = Schema.Literal("thread.realtime.audio.delta");
const ThreadRealtimeErrorType = Schema.Literal("thread.realtime.error");
const ThreadRealtimeClosedType = Schema.Literal("thread.realtime.closed");
const TurnStartedType = Schema.Literal("turn.started");
const TurnCompletedType = Schema.Literal("turn.completed");
const TurnAbortedType = Schema.Literal("turn.aborted");
const TurnTasksUpdatedType = Schema.Literal("turn.tasks.updated");
const TurnProposedDeltaType = Schema.Literal("turn.proposed.delta");
const TurnProposedCompletedType = Schema.Literal("turn.proposed.completed");
const TurnDiffUpdatedType = Schema.Literal("turn.diff.updated");
const TurnSteeredType = Schema.Literal("turn.steered");
const ItemStartedType = Schema.Literal("item.started");
const ItemUpdatedType = Schema.Literal("item.updated");
const ItemCompletedType = Schema.Literal("item.completed");
const ContentDeltaType = Schema.Literal("content.delta");
const RequestOpenedType = Schema.Literal("request.opened");
const RequestResolvedType = Schema.Literal("request.resolved");
const UserInputRequestedType = Schema.Literal("user-input.requested");
const UserInputResolvedType = Schema.Literal("user-input.resolved");
const TaskStartedType = Schema.Literal("task.started");
const TaskProgressType = Schema.Literal("task.progress");
const TaskUpdatedType = Schema.Literal("task.updated");
const TaskCompletedType = Schema.Literal("task.completed");
const HookStartedType = Schema.Literal("hook.started");
const HookProgressType = Schema.Literal("hook.progress");
const HookCompletedType = Schema.Literal("hook.completed");
const ToolProgressType = Schema.Literal("tool.progress");
const ToolSummaryType = Schema.Literal("tool.summary");
const AuthStatusType = Schema.Literal("auth.status");
const AccountUpdatedType = Schema.Literal("account.updated");
const AccountRateLimitsUpdatedType = Schema.Literal("account.rate-limits.updated");
const McpStatusUpdatedType = Schema.Literal("mcp.status.updated");
const McpOauthCompletedType = Schema.Literal("mcp.oauth.completed");
const AutomaticApprovalReviewUpdatedType = Schema.Literal("automatic-approval-review.updated");
const ModelReroutedType = Schema.Literal("model.rerouted");
const ModelSafetyBufferingUpdatedType = Schema.Literal("model.safety-buffering.updated");
const ConfigWarningType = Schema.Literal("config.warning");
const DeprecationNoticeType = Schema.Literal("deprecation.notice");
const FilesPersistedType = Schema.Literal("files.persisted");
const VcsStateChangedType = Schema.Literal("vcs.state.changed");
const RuntimeWarningType = Schema.Literal("runtime.warning");
const RuntimeErrorType = Schema.Literal("runtime.error");
const EventUnmappedType = Schema.Literal("event.unmapped");

const ProviderRuntimeEventBase = Schema.Struct({
  eventId: EventId,
  provider: ProviderDriverKind,
  providerInstanceId: Schema.optional(ProviderInstanceId),
  sessionId: Schema.optional(RuntimeSessionId),
  threadId: ThreadId,
  createdAt: IsoDateTime,
  turnId: Schema.optional(TurnId),
  parentTurnId: Schema.optional(TurnId),
  itemId: Schema.optional(RuntimeItemId),
  requestId: Schema.optional(RuntimeRequestId),
  lifecycleGeneration: Schema.optional(TrimmedNonEmptyStringSchema),
  providerRefs: Schema.optional(ProviderRefs),
  correlationId: Schema.optional(TrimmedNonEmptyStringSchema),
  causationEventId: Schema.optional(EventId),
  actor: Schema.optional(RuntimeEventActor),
  redaction: Schema.optional(RuntimeEventRedactionState),
  launchPlanHash: Schema.optional(TrimmedNonEmptyStringSchema),
  raw: Schema.optional(RuntimeEventRaw),
});
export type ProviderRuntimeEventBase = typeof ProviderRuntimeEventBase.Type;

const SessionStartedPayload = Schema.Struct({
  message: Schema.optional(TrimmedNonEmptyStringSchema),
  resume: Schema.optional(Schema.Unknown),
});
export type SessionStartedPayload = typeof SessionStartedPayload.Type;

const SessionConfiguredPayload = Schema.Struct({
  config: UnknownRecordSchema,
});
export type SessionConfiguredPayload = typeof SessionConfiguredPayload.Type;

const SessionStateChangedPayload = Schema.Struct({
  state: RuntimeSessionState,
  reason: Schema.optional(TrimmedNonEmptyStringSchema),
  detail: Schema.optional(Schema.Unknown),
});
export type SessionStateChangedPayload = typeof SessionStateChangedPayload.Type;

const SessionExitedPayload = Schema.Struct({
  reason: Schema.optional(TrimmedNonEmptyStringSchema),
  recoverable: Schema.optional(Schema.Boolean),
  exitKind: Schema.optional(RuntimeSessionExitKind),
});
export type SessionExitedPayload = typeof SessionExitedPayload.Type;

const ThreadStartedPayload = Schema.Struct({
  providerThreadId: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type ThreadStartedPayload = typeof ThreadStartedPayload.Type;

const ThreadStateChangedPayload = Schema.Struct({
  state: RuntimeThreadState,
  detail: Schema.optional(Schema.Unknown),
});
export type ThreadStateChangedPayload = typeof ThreadStateChangedPayload.Type;

const ThreadMetadataUpdatedPayload = Schema.Struct({
  name: Schema.optional(TrimmedNonEmptyStringSchema),
  metadata: Schema.optional(UnknownRecordSchema),
});
export type ThreadMetadataUpdatedPayload = typeof ThreadMetadataUpdatedPayload.Type;

export const ThreadTokenUsageSnapshot = Schema.Struct({
  claudeCache: Schema.optional(ClaudeCacheObservation),
  // Provider session totals, distinct from the latest request/context snapshot.
  cumulativeUsage: Schema.optional(
    Schema.Struct({
      inputTokens: NonNegativeInt,
      outputTokens: NonNegativeInt,
      cachedInputTokens: Schema.optional(NonNegativeInt),
      cacheCreationInputTokens: Schema.optional(NonNegativeInt),
    }),
  ),
  usedTokens: NonNegativeInt,
  usedPercent: Schema.optional(
    Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(Schema.isLessThanOrEqualTo(100)),
  ),
  totalProcessedTokens: Schema.optional(NonNegativeInt),
  // Claude v1 counts API responses once; unversioned Claude totals are unreliable.
  tokenAccountingVersion: Schema.optional(Schema.Literal(1)),
  maxTokens: Schema.optional(PositiveInt),
  inputTokens: Schema.optional(NonNegativeInt),
  cachedInputTokens: Schema.optional(NonNegativeInt),
  outputTokens: Schema.optional(NonNegativeInt),
  reasoningOutputTokens: Schema.optional(NonNegativeInt),
  lastUsedTokens: Schema.optional(NonNegativeInt),
  lastInputTokens: Schema.optional(NonNegativeInt),
  lastCachedInputTokens: Schema.optional(NonNegativeInt),
  lastOutputTokens: Schema.optional(NonNegativeInt),
  lastReasoningOutputTokens: Schema.optional(NonNegativeInt),
  toolUses: Schema.optional(NonNegativeInt),
  durationMs: Schema.optional(NonNegativeInt),
  compactsAutomatically: Schema.optional(Schema.Boolean),
});
export type ThreadTokenUsageSnapshot = typeof ThreadTokenUsageSnapshot.Type;

const ThreadTokenUsageUpdatedPayload = Schema.Struct({
  usage: ThreadTokenUsageSnapshot,
});
export type ThreadTokenUsageUpdatedPayload = typeof ThreadTokenUsageUpdatedPayload.Type;

const ThreadRealtimeStartedPayload = Schema.Struct({
  realtimeSessionId: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type ThreadRealtimeStartedPayload = typeof ThreadRealtimeStartedPayload.Type;

export const ThreadRealtimeHandoffMessage = Schema.Struct({
  realtimeHandoffId: TrimmedNonEmptyStringSchema,
  messageId: MessageId,
  role: Schema.Literal("user"),
  text: Schema.String,
});
export type ThreadRealtimeHandoffMessage = typeof ThreadRealtimeHandoffMessage.Type;

const ThreadRealtimeItemAddedPayload = Schema.Struct({
  item: Schema.Unknown,
  /** Source-backed projection of Codex's legacy `handoff_request` item. */
  handoffMessage: Schema.optional(ThreadRealtimeHandoffMessage),
});
export type ThreadRealtimeItemAddedPayload = typeof ThreadRealtimeItemAddedPayload.Type;

const ThreadRealtimeAudioDeltaPayload = Schema.Struct({
  audio: Schema.Unknown,
});
export type ThreadRealtimeAudioDeltaPayload = typeof ThreadRealtimeAudioDeltaPayload.Type;

const ThreadRealtimeErrorPayload = Schema.Struct({
  message: TrimmedNonEmptyStringSchema,
});
export type ThreadRealtimeErrorPayload = typeof ThreadRealtimeErrorPayload.Type;

const ThreadRealtimeClosedPayload = Schema.Struct({
  reason: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type ThreadRealtimeClosedPayload = typeof ThreadRealtimeClosedPayload.Type;

const TurnStartedPayload = Schema.Struct({
  model: Schema.optional(TrimmedNonEmptyStringSchema),
  effort: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type TurnStartedPayload = typeof TurnStartedPayload.Type;

/**
 * Safe Codex error classification shared by transient stream retries and
 * terminal failed turns.
 *
 * Keep this projection deliberately narrower than the native error payload:
 * credentials, headers, URLs, and response bodies never cross the runtime
 * contract boundary. The string variants mirror Codex's public v2
 * `CodexErrorInfo` values; object variants retain only a bounded status code.
 */
const RuntimeWarningStreamRetryContent = TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(500));
const RuntimeWarningStreamRetryDetails = TrimmedNonEmptyStringSchema.check(
  Schema.isMaxLength(2_000),
);
const RuntimeWarningStreamRetryHttpStatusCode = NonNegativeInt.check(
  Schema.isLessThanOrEqualTo(65_535),
);
const RuntimeWarningStreamRetryAttempt = PositiveInt.check(Schema.isLessThanOrEqualTo(1_000_000));

export const RuntimeCodexErrorInfo = Schema.Union([
  Schema.Literals([
    "contextWindowExceeded",
    "sessionBudgetExceeded",
    "usageLimitExceeded",
    "serverOverloaded",
    "rateLimitExceeded",
    "cyberPolicy",
    "misalignmentPolicyViolation",
    "internalServerError",
    "unauthorized",
    "badRequest",
    "threadRollbackFailed",
    "sandboxError",
    "other",
  ]),
  Schema.Struct({
    httpConnectionFailed: Schema.Struct({
      httpStatusCode: Schema.optional(Schema.NullOr(RuntimeWarningStreamRetryHttpStatusCode)),
    }),
  }),
  Schema.Struct({
    responseStreamConnectionFailed: Schema.Struct({
      httpStatusCode: Schema.optional(Schema.NullOr(RuntimeWarningStreamRetryHttpStatusCode)),
    }),
  }),
  Schema.Struct({
    responseStreamDisconnected: Schema.Struct({
      httpStatusCode: Schema.optional(Schema.NullOr(RuntimeWarningStreamRetryHttpStatusCode)),
    }),
  }),
  Schema.Struct({
    responseTooManyFailedAttempts: Schema.Struct({
      httpStatusCode: Schema.optional(Schema.NullOr(RuntimeWarningStreamRetryHttpStatusCode)),
    }),
  }),
  Schema.Struct({
    activeTurnNotSteerable: Schema.Struct({
      turnKind: Schema.Literals(["review", "compact"]),
    }),
  }),
]);
export type RuntimeCodexErrorInfo = typeof RuntimeCodexErrorInfo.Type;

const RETRYABLE_CODEX_ERROR_INFO_STRINGS = new Set([
  "serverOverloaded",
  "rateLimitExceeded",
  "internalServerError",
]);
const RETRYABLE_CODEX_ERROR_INFO_OBJECT_KEYS = new Set([
  "httpConnectionFailed",
  "responseStreamConnectionFailed",
  "responseStreamDisconnected",
  "responseTooManyFailedAttempts",
]);
const CODEX_RETRYABLE_LEGACY_MESSAGE =
  /\bmodel\s+is\s+temporarily\s+unavailable\b|^stream\s+disconnected\s+before\s+completion:\s*we['’]re\s+currently\s+processing\s+too\s+many\s+requests\b/i;
const CODEX_NON_RETRYABLE_LEGACY_TERMS =
  /\b(?:usage|quota|rate[\s_-]+limit(?:s|ed|ing)?|billing|credits?)\b/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedRetryableCodexErrorDetails(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "httpStatusCode")) return false;
  if (!Object.hasOwn(value, "httpStatusCode")) return true;
  const statusCode = value.httpStatusCode;
  return (
    statusCode === null ||
    (typeof statusCode === "number" &&
      Number.isInteger(statusCode) &&
      statusCode >= 0 &&
      statusCode <= 65_535)
  );
}

/**
 * Shared, fail-closed retryability predicate for terminal Codex turns.
 *
 * Callers may pass the terminal state when available; an interrupted state is
 * resumable without an error payload. Unknown or malformed error projections
 * never become retryable. The projection intentionally accepts only the
 * bounded errorInfo and errorMessage fields persisted by Moss.
 */
export function isRetryableCodexTurnFailure(input: {
  readonly state?: unknown;
  readonly errorInfo?: unknown;
  readonly errorMessage?: unknown;
}): boolean {
  if (input.state === "interrupted") return true;
  if (input.state !== undefined && input.state !== "failed") return false;

  if (typeof input.errorInfo === "string") {
    if (RETRYABLE_CODEX_ERROR_INFO_STRINGS.has(input.errorInfo)) {
      return true;
    }
    if (input.errorInfo !== "other") {
      return false;
    }
    if (typeof input.errorMessage !== "string") {
      return false;
    }
    if (CODEX_NON_RETRYABLE_LEGACY_TERMS.test(input.errorMessage)) {
      return false;
    }
    return CODEX_RETRYABLE_LEGACY_MESSAGE.test(input.errorMessage);
  }

  if (!isRecord(input.errorInfo) || Object.keys(input.errorInfo).length !== 1) {
    return false;
  }
  const [variant] = Object.keys(input.errorInfo);
  return (
    variant !== undefined &&
    RETRYABLE_CODEX_ERROR_INFO_OBJECT_KEYS.has(variant) &&
    isBoundedRetryableCodexErrorDetails(input.errorInfo[variant])
  );
}

// Keep the stream-retry name as a source-compatible alias while both transient
// and terminal Codex errors share the same safe projection.
export const RuntimeWarningStreamRetryErrorInfo = RuntimeCodexErrorInfo;
export type RuntimeWarningStreamRetryErrorInfo = RuntimeCodexErrorInfo;

/** Typed, bounded projection for Codex's transient `willRetry` error item. */
export const RuntimeWarningStreamRetryPayload = Schema.Struct({
  content: RuntimeWarningStreamRetryContent,
  errorInfo: Schema.optional(Schema.NullOr(RuntimeCodexErrorInfo)),
  additionalDetails: Schema.optional(RuntimeWarningStreamRetryDetails),
  reconnectAttempt: Schema.optional(Schema.NullOr(RuntimeWarningStreamRetryAttempt)),
  reconnectMaxAttempts: Schema.optional(Schema.NullOr(RuntimeWarningStreamRetryAttempt)),
});
export type RuntimeWarningStreamRetryPayload = typeof RuntimeWarningStreamRetryPayload.Type;

const RuntimeWarningPayload = Schema.Struct({
  message: TrimmedNonEmptyStringSchema,
  willRetry: Schema.optional(Schema.Boolean),
  detail: Schema.optional(Schema.Unknown),
  streamRetry: Schema.optional(RuntimeWarningStreamRetryPayload),
});
export type RuntimeWarningPayload = typeof RuntimeWarningPayload.Type;

const RuntimeErrorPayload = Schema.Struct({
  message: TrimmedNonEmptyStringSchema,
  errorCode: Schema.optional(TrimmedNonEmptyStringSchema),
  class: Schema.optional(RuntimeErrorClass),
  detail: Schema.optional(Schema.Unknown),
});
export type RuntimeErrorPayload = typeof RuntimeErrorPayload.Type;

const AutomaticApprovalReviewId = TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(200));
const AutomaticApprovalReviewTargetItemId = Schema.NullOr(AutomaticApprovalReviewId);
const AutomaticApprovalReviewStatus = Schema.Literals([
  "inProgress",
  "approved",
  "denied",
  "timedOut",
  "aborted",
]);
const AutomaticApprovalReviewRiskLevel = Schema.Literals(["low", "medium", "high", "critical"]);
const AutomaticApprovalReviewAuthorization = Schema.Literals(["unknown", "low", "medium", "high"]);
const AutomaticApprovalReviewTimestamp = Schema.Number.check(Schema.isFinite())
  .check(Schema.makeFilter((value: number) => Number.isSafeInteger(value)))
  .check(Schema.isGreaterThanOrEqualTo(0));

/** Bounded, action-free projection of Codex automatic approval-review updates. */
export const AutomaticApprovalReviewUpdatePayload = Schema.Struct({
  reviewId: AutomaticApprovalReviewId,
  targetItemId: AutomaticApprovalReviewTargetItemId,
  status: AutomaticApprovalReviewStatus,
  rationale: Schema.optional(
    Schema.NullOr(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(2_000))),
  ),
  riskLevel: Schema.optional(Schema.NullOr(AutomaticApprovalReviewRiskLevel)),
  userAuthorization: Schema.optional(Schema.NullOr(AutomaticApprovalReviewAuthorization)),
  startedAtMs: AutomaticApprovalReviewTimestamp,
  completedAtMs: Schema.optional(Schema.NullOr(AutomaticApprovalReviewTimestamp)),
  decisionSource: Schema.optional(Schema.NullOr(Schema.Literal("agent"))),
});
export type AutomaticApprovalReviewUpdatePayload = typeof AutomaticApprovalReviewUpdatePayload.Type;

const TurnCompletedPayload = Schema.Struct({
  state: RuntimeTurnState,
  // Present only for an explicitly requested native compaction operation.
  contextCompacted: Schema.optional(Schema.Boolean),
  stopReason: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  usage: Schema.optional(Schema.Unknown),
  modelUsage: Schema.optional(UnknownRecordSchema),
  tokenAccountingVersion: Schema.optional(Schema.Literal(1)),
  // Per-turn main-loop usage, including observed usage when no result arrives.
  mainLoopTokens: Schema.optional(NonNegativeInt),
  totalCostUsd: Schema.optional(Schema.Number),
  cumulativeCostUsd: Schema.optional(Schema.Number),
  errorMessage: Schema.optional(TrimmedNonEmptyStringSchema),
  // Only the adapter may populate this bounded projection, and only for a
  // failed turn. Keeping the field on the shared payload lets durable
  // projections retain the provider's typed terminal classification without
  // carrying the native error object across the contract boundary.
  errorInfo: Schema.optional(Schema.NullOr(RuntimeCodexErrorInfo)),
  errorCode: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type TurnCompletedPayload = typeof TurnCompletedPayload.Type;

const TurnAbortedPayload = Schema.Struct({
  reason: TrimmedNonEmptyStringSchema,
});
export type TurnAbortedPayload = typeof TurnAbortedPayload.Type;

const RuntimeTaskListItem = Schema.Struct({
  task: TrimmedNonEmptyStringSchema,
  status: RuntimeTaskStatus,
});
export type RuntimeTaskListItem = typeof RuntimeTaskListItem.Type;

const TurnTasksUpdatedPayload = Schema.Struct({
  explanation: Schema.optional(Schema.NullOr(TrimmedNonEmptyStringSchema)),
  tasks: Schema.Array(RuntimeTaskListItem),
});
export type TurnTasksUpdatedPayload = typeof TurnTasksUpdatedPayload.Type;

const TurnProposedDeltaPayload = Schema.Struct({
  delta: Schema.String,
});
export type TurnProposedDeltaPayload = typeof TurnProposedDeltaPayload.Type;

const TurnProposedCompletedPayload = Schema.Struct({
  planMarkdown: TrimmedNonEmptyStringSchema,
});
export type TurnProposedCompletedPayload = typeof TurnProposedCompletedPayload.Type;

const TurnDiffUpdatedPayload = Schema.Struct({
  unifiedDiff: Schema.String,
});
export type TurnDiffUpdatedPayload = typeof TurnDiffUpdatedPayload.Type;

export const ItemLifecyclePayload = Schema.Struct({
  asyncQuestions: Schema.optional(AsyncUserInputQuestions),
  itemType: CanonicalItemType,
  status: Schema.optional(RuntimeItemStatus),
  /** Provenance for Codex context compaction; absent for all other items. */
  source: Schema.optional(Schema.Literals(["manual", "automatic", "compatibility"])),
  /** Stable operation identity used to collapse canonical/replayed lifecycle events. */
  operationId: Schema.optional(TrimmedNonEmptyStringSchema),
  title: Schema.optional(TrimmedNonEmptyStringSchema),
  // Free-form body (e.g. raw tool output), which legitimately carries leading
  // and/or trailing whitespace. Keep it unconstrained so item events from
  // provider adapters (pi, opencode, codex, ...) always pass the durable
  // journal's encode step; a TrimmedNonEmptyString here rejects ordinary
  // tool output and forces the event into quarantine.
  detail: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Unknown),
});
export type ItemLifecyclePayload = typeof ItemLifecyclePayload.Type;

// B5.4a1 keeps non-app MCP results as a small, versioned projection. The
// adapter is responsible for redaction and deterministic compaction before a
// value reaches this schema; these checks make the durable/public boundary
// fail closed when a caller attempts to bypass that projection.
export const CODEX_MCP_TOOL_CALL_PROJECTION_KIND = "codex.mcp_tool_call" as const;
export const CODEX_MCP_TOOL_CALL_PROJECTION_VERSION = 1 as const;
export const MCP_TOOL_RESULT_PROJECTION_KIND = CODEX_MCP_TOOL_CALL_PROJECTION_KIND;
export const MCP_TOOL_RESULT_PROJECTION_VERSION = CODEX_MCP_TOOL_CALL_PROJECTION_VERSION;

const McpProjectionIdentity = TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(200));
const McpProjectionDisplayString = Schema.String.check(Schema.isMaxLength(2_000));
const McpProjectionUri = TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(2_000));
const McpProjectionRepresentation = Schema.String.check(Schema.isMaxLength(4_000));
const McpProjectionMimeType = TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(200));
const McpProjectionJson = Schema.Json;
const McpProjectionBoundedJson = McpProjectionJson.check(
  Schema.makeFilter((value: Schema.Json) => {
    try {
      return (JSON.stringify(value) ?? "null").length <= 4_000;
    } catch {
      return false;
    }
  }),
);

const McpProjectionAnnotations = Schema.Struct({
  audience: Schema.optional(
    Schema.Union([
      McpProjectionDisplayString,
      Schema.Array(McpProjectionDisplayString).check(Schema.isMaxLength(4)),
    ]),
  ),
  priority: Schema.optional(Schema.Union([Schema.Finite, McpProjectionDisplayString])),
  lastModified: Schema.optional(McpProjectionDisplayString),
  truncated: Schema.optional(Schema.Boolean),
  originalChars: Schema.optional(NonNegativeInt),
});
export type McpProjectionAnnotations = typeof McpProjectionAnnotations.Type;

const McpTextContentBlock = Schema.Struct({
  type: Schema.Literal("text"),
  text: McpProjectionDisplayString,
  annotations: Schema.optional(McpProjectionAnnotations),
  truncated: Schema.optional(Schema.Boolean),
  originalChars: Schema.optional(NonNegativeInt),
});

const McpResourceLinkContentBlock = Schema.Struct({
  type: Schema.Literal("resource_link"),
  uri: McpProjectionUri,
  name: Schema.optional(McpProjectionDisplayString),
  title: Schema.optional(McpProjectionDisplayString),
  description: Schema.optional(McpProjectionDisplayString),
  mimeType: Schema.optional(McpProjectionMimeType),
  annotations: Schema.optional(McpProjectionAnnotations),
  truncated: Schema.optional(Schema.Boolean),
  originalChars: Schema.optional(NonNegativeInt),
});

const McpEmbeddedResourceContentBlock = Schema.Struct({
  type: Schema.Literal("embedded_resource"),
  uri: Schema.optional(McpProjectionUri),
  mimeType: Schema.optional(McpProjectionMimeType),
  text: Schema.optional(McpProjectionRepresentation),
  annotations: Schema.optional(McpProjectionAnnotations),
  truncated: Schema.optional(Schema.Boolean),
  originalChars: Schema.optional(NonNegativeInt),
});

const McpBinaryDeferredReason = Schema.Literals([
  "invalid-block-index",
  "invalid-reference",
  "invalid-mime",
  "unsupported-mime",
  "invalid-base64",
  "empty-binary",
  "mime-signature-mismatch",
  "block-size-limit",
  "aggregate-size-limit",
  "block-count-limit",
  "quota-exceeded",
  "storage-failed",
  "claim-rejected",
  "artifact-unavailable",
]);

const McpBinaryDeferredContentBlock = Schema.Struct({
  type: Schema.Literal("binary_deferred"),
  originalType: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(80))),
  uri: Schema.optional(McpProjectionUri),
  mimeType: Schema.optional(McpProjectionMimeType),
  annotations: Schema.optional(McpProjectionAnnotations),
  truncated: Schema.optional(Schema.Boolean),
  originalChars: Schema.optional(NonNegativeInt),
  reason: Schema.optional(McpBinaryDeferredReason),
  state: Schema.Literal("binary_deferred"),
});

const McpLocalArtifactName = TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(255)).check(
  Schema.makeFilter(
    (value: string) =>
      !value.includes("\0") &&
      !value.includes("\r") &&
      !value.includes("\n") &&
      !value.includes("/") &&
      !value.includes("\\"),
  ),
);
const McpLocalArtifactMimeType = Schema.Literals([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "audio/webm",
  "audio/mp4",
]);
const McpLocalArtifactContentBlock = Schema.Struct({
  type: Schema.Literal("local_artifact"),
  state: Schema.Literal("available"),
  mediaKind: Schema.Literals(["image", "audio"]),
  attachmentId: Schema.String.check(Schema.isPattern(/^att_v2_[0-9a-f]{32}$/u)).check(
    Schema.isMaxLength(40),
  ),
  name: McpLocalArtifactName,
  mimeType: McpLocalArtifactMimeType,
  sizeBytes: PositiveInt.check(Schema.isLessThanOrEqualTo(10 * 1024 * 1024)),
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  annotations: Schema.optional(McpProjectionAnnotations),
  truncated: Schema.optional(Schema.Boolean),
  originalChars: Schema.optional(NonNegativeInt),
}).check(
  Schema.makeFilter((value: typeof McpLocalArtifactContentBlock.Type) =>
    value.mediaKind === "image"
      ? value.mimeType.startsWith("image/")
      : value.mimeType.startsWith("audio/"),
  ),
);

const McpUnknownContentBlock = Schema.Struct({
  type: Schema.Literal("unknown"),
  json: McpProjectionRepresentation,
  originalType: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(80))),
  truncated: Schema.optional(Schema.Boolean),
  originalChars: Schema.optional(NonNegativeInt),
});

export const McpToolResultContentBlock = Schema.Union([
  McpTextContentBlock,
  McpResourceLinkContentBlock,
  McpEmbeddedResourceContentBlock,
  McpBinaryDeferredContentBlock,
  McpLocalArtifactContentBlock,
  McpUnknownContentBlock,
]);
export type McpToolResultContentBlock = typeof McpToolResultContentBlock.Type;

const McpProjectionResult = Schema.Struct({
  content: Schema.Array(McpToolResultContentBlock).check(Schema.isMaxLength(12)),
  structuredContent: Schema.optional(McpProjectionBoundedJson),
});

const McpProjectionError = Schema.Struct({
  message: TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(2_000)),
});

const McpProjectionTruncation = Schema.Struct({
  truncated: Schema.Boolean,
  deferredBinary: Schema.Boolean,
  originalJsonChars: Schema.optional(NonNegativeInt),
  omittedBlocks: Schema.optional(NonNegativeInt),
  omittedWebMcpCalls: Schema.optional(NonNegativeInt),
});

// B5.4c1 keeps MCP App provenance beside the existing v1 MCP projection. The
// descriptor is deliberately metadata-only: the HTML resource is fetched on
// demand through the authorized provider runtime and is never persisted here.
export const CodexMcpAppDescriptor = Schema.Struct({
  resourceUri: TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(2_000)),
  source: Schema.Literals(["appContext", "resultMeta", "legacy"]),
  connectorId: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(200))),
  linkId: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(200))),
  appName: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(200))),
  actionName: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(200))),
  pluginId: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(200))),
});
export type CodexMcpAppDescriptor = typeof CodexMcpAppDescriptor.Type;

const CodexWebMcpName = TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(200));
const CodexWebMcpTitle = TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(200));
const CodexWebMcpDescription = TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(1_000));
const CODEX_WEB_MCP_HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.?$/u;
const CodexWebMcpHostname = Schema.String.check(Schema.isNonEmpty())
  .check(Schema.isMaxLength(253))
  .check(Schema.isPattern(CODEX_WEB_MCP_HOSTNAME_PATTERN));
const CodexWebMcpJson = Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(2_000));

const CodexWebMcpSharedFields = {
  title: Schema.optional(CodexWebMcpTitle),
  description: Schema.optional(CodexWebMcpDescription),
  readOnlyHint: Schema.optional(Schema.Boolean),
  sourceHostname: Schema.optional(CodexWebMcpHostname),
  outputJson: Schema.optional(CodexWebMcpJson),
  outputTruncated: Schema.optional(Schema.Literal(true)),
} as const;

const CodexWebMcpListToolsCall = Schema.Struct({
  kind: Schema.Literal("listTools"),
  name: Schema.Literal("webmcp_list_tools"),
  ...CodexWebMcpSharedFields,
});

const CodexWebMcpInvokeToolCall = Schema.Struct({
  kind: Schema.Literal("invokeTool"),
  name: CodexWebMcpName,
  ...CodexWebMcpSharedFields,
  inputJson: Schema.optional(CodexWebMcpJson),
  inputTruncated: Schema.optional(Schema.Literal(true)),
});

/** Strict, version-1 projection of a successful native WebMCP child activity. */
export const CodexWebMcpCall = Schema.Union([CodexWebMcpListToolsCall, CodexWebMcpInvokeToolCall]);
export type CodexWebMcpCall = typeof CodexWebMcpCall.Type;

const CodexWebMcpCalls = Schema.Array(CodexWebMcpCall)
  .check(Schema.isNonEmpty())
  .check(Schema.isMaxLength(8));
const CodexWebMcpFallbackHostname = CodexWebMcpHostname;

export const CodexMcpToolCallProjection = Schema.Struct({
  kind: Schema.Literal(CODEX_MCP_TOOL_CALL_PROJECTION_KIND),
  version: Schema.Literal(CODEX_MCP_TOOL_CALL_PROJECTION_VERSION),
  callId: McpProjectionIdentity,
  server: McpProjectionIdentity,
  tool: McpProjectionIdentity,
  status: Schema.Literals(["inProgress", "completed", "failed"]),
  durationMs: Schema.optional(NonNegativeInt),
  arguments: McpProjectionBoundedJson,
  result: Schema.optional(McpProjectionResult),
  error: Schema.optional(McpProjectionError),
  truncation: McpProjectionTruncation,
  app: Schema.optional(CodexMcpAppDescriptor),
  webMcpCalls: Schema.optional(CodexWebMcpCalls),
  webMcpFallbackHostname: Schema.optional(CodexWebMcpFallbackHostname),
}).check(
  Schema.makeFilter((value: typeof CodexMcpToolCallProjection.Type) => {
    if (value.status === "failed" && value.error === undefined) {
      return false;
    }
    const hasWebMcpSignal =
      value.webMcpCalls !== undefined || value.truncation.omittedWebMcpCalls !== undefined;
    if (hasWebMcpSignal) {
      if (
        value.status !== "completed" ||
        (value.server !== "node_repl" && value.server !== "cua_repl") ||
        value.tool !== "js"
      ) {
        return false;
      }
    }
    if (value.webMcpFallbackHostname !== undefined && value.webMcpCalls === undefined) {
      return false;
    }
    const webMcpChildTruncated =
      value.webMcpCalls?.some(
        (call) => Reflect.get(call, "inputTruncated") === true || call.outputTruncated === true,
      ) ?? false;
    if (
      ((value.truncation.omittedWebMcpCalls ?? 0) > 0 || webMcpChildTruncated) &&
      !value.truncation.truncated
    ) {
      return false;
    }
    try {
      return (JSON.stringify(value) ?? "null").length <= 12_000;
    } catch {
      return false;
    }
  }),
);
export type CodexMcpToolCallProjection = typeof CodexMcpToolCallProjection.Type;

// Short aliases keep the contract discoverable to non-Codex consumers while
// retaining the Codex-native name at the adapter boundary.
export const McpToolCallProjection = CodexMcpToolCallProjection;
export type McpToolCallProjection = CodexMcpToolCallProjection;
export const McpToolResultProjection = CodexMcpToolCallProjection;
export type McpToolResultProjection = CodexMcpToolCallProjection;

// Codex reports image-generation quota exhaustion as a structured item failure.
// Keep this projection deliberately small: it is safe to persist and contains
// no account credentials, provider URLs, checkout details, or native payloads.
export const CODEX_IMAGE_GENERATION_USAGE_LIMIT_KIND =
  "codex.image_generation.usage_limit" as const;
const CodexImageGenerationUsageLimitReset = Schema.NullOr(
  Schema.Number.check(Schema.isFinite()).check(Schema.isGreaterThanOrEqualTo(0)),
);
export const CodexImageGenerationUsageLimit = Schema.Struct({
  kind: Schema.Literal(CODEX_IMAGE_GENERATION_USAGE_LIMIT_KIND),
  type: Schema.Literal("usageLimitExceeded"),
  limitId: Schema.Literal("image_gen"),
  resetsAt: CodexImageGenerationUsageLimitReset,
});
export type CodexImageGenerationUsageLimit = typeof CodexImageGenerationUsageLimit.Type;

// Codex-generated images are persisted as local file references, never inline bytes.
export const CODEX_GENERATED_IMAGE_ARTIFACT_KIND = "codex.generated_image" as const;
export const CodexGeneratedImageArtifact = Schema.Struct({
  kind: Schema.Literal(CODEX_GENERATED_IMAGE_ARTIFACT_KIND),
  path: TrimmedNonEmptyStringSchema,
  callId: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type CodexGeneratedImageArtifact = typeof CodexGeneratedImageArtifact.Type;

// Official Moss media uses the same local-file gallery lifecycle for every CLI.
// Keep a distinct kind so a Moss result never clears a Codex account quota banner.
export const MOSS_GENERATED_IMAGE_ARTIFACT_KIND = "moss.generated_image" as const;
export const MOSS_IMAGE_GENERATION_FAILURE_KIND = "moss.image_generation.failure" as const;
export const MossGeneratedImageArtifact = Schema.Struct({
  kind: Schema.Literal(MOSS_GENERATED_IMAGE_ARTIFACT_KIND),
  path: TrimmedNonEmptyStringSchema,
  callId: TrimmedNonEmptyStringSchema,
  jobId: TrimmedNonEmptyStringSchema,
  outputIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(Schema.isLessThan(32)),
});
export type MossGeneratedImageArtifact = typeof MossGeneratedImageArtifact.Type;

const ContentDeltaPayload = Schema.Struct({
  streamKind: RuntimeContentStreamKind,
  delta: Schema.String,
  contentIndex: Schema.optional(Schema.Int),
  summaryIndex: Schema.optional(Schema.Int),
});
export type ContentDeltaPayload = typeof ContentDeltaPayload.Type;

const RequestOpenedPayload = Schema.Struct({
  requestType: CanonicalRequestType,
  detail: Schema.optional(TrimmedNonEmptyStringSchema),
  args: Schema.optional(Schema.Unknown),
});
export type RequestOpenedPayload = typeof RequestOpenedPayload.Type;

const RequestResolvedPayload = Schema.Struct({
  requestType: CanonicalRequestType,
  decision: Schema.optional(TrimmedNonEmptyStringSchema),
  resolution: Schema.optional(Schema.Unknown),
});
export type RequestResolvedPayload = typeof RequestResolvedPayload.Type;

const UserInputQuestionOption = Schema.Struct({
  label: TrimmedNonEmptyStringSchema,
  description: TrimmedNonEmptyStringSchema,
});
export type UserInputQuestionOption = typeof UserInputQuestionOption.Type;

export const UserInputQuestion = Schema.Struct({
  id: TrimmedNonEmptyStringSchema,
  header: TrimmedNonEmptyStringSchema,
  question: TrimmedNonEmptyStringSchema,
  options: Schema.Array(UserInputQuestionOption),
  multiSelect: Schema.optional(Schema.Boolean).pipe(
    Schema.withConstructorDefault(() => Option.some(false)),
  ),
});
export type UserInputQuestion = typeof UserInputQuestion.Type;

const UserInputRequestedPayload = Schema.Struct({
  questions: Schema.Array(UserInputQuestion),
});
export type UserInputRequestedPayload = typeof UserInputRequestedPayload.Type;

const UserInputResolvedPayload = Schema.Struct({
  answers: UnknownRecordSchema,
});
export type UserInputResolvedPayload = typeof UserInputResolvedPayload.Type;

// Phase declared in a workflow script's `meta.phases` literal.
const WorkflowPhase = Schema.Struct({
  title: TrimmedNonEmptyStringSchema,
  detail: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type WorkflowPhase = typeof WorkflowPhase.Type;

// Final per-agent snapshot from a settled workflow's progress file.
const WorkflowAgentSnapshot = Schema.Struct({
  label: TrimmedNonEmptyStringSchema,
  phaseIndex: Schema.optional(Schema.Int),
  // Authoritative phase name from the progress file; phaseIndex is 1-based in
  // recent CLI output files, so prefer the title when both are present.
  phaseTitle: Schema.optional(TrimmedNonEmptyStringSchema),
  agentId: Schema.optional(TrimmedNonEmptyStringSchema),
  model: Schema.optional(TrimmedNonEmptyStringSchema),
  // Backfilled from the live runtime snapshots at settle when the progress
  // file itself carries no effort.
  effort: Schema.optional(TrimmedNonEmptyStringSchema),
  state: Schema.optional(TrimmedNonEmptyStringSchema),
  tokens: Schema.optional(Schema.Int),
  toolCalls: Schema.optional(Schema.Int),
  durationMs: Schema.optional(Schema.Int),
  lastToolName: Schema.optional(TrimmedNonEmptyStringSchema),
  promptPreview: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type WorkflowAgentSnapshot = typeof WorkflowAgentSnapshot.Type;

// Live per-agent snapshot polled from a running workflow's transcript directory
// (journal.jsonl + agent-<id>.jsonl). The label is a best-effort join against
// the workflow's progress descriptions and may be absent.
const WorkflowAgentRuntimeSnapshot = Schema.Struct({
  agentId: TrimmedNonEmptyStringSchema,
  label: Schema.optional(TrimmedNonEmptyStringSchema),
  model: Schema.optional(TrimmedNonEmptyStringSchema),
  // Top-level `effort` field on the transcript's assistant lines.
  effort: Schema.optional(TrimmedNonEmptyStringSchema),
  state: Schema.optional(Schema.Literals(["running", "completed"])),
  tokens: Schema.optional(Schema.Int),
  toolCalls: Schema.optional(Schema.Int),
  recentToolNames: Schema.optional(Schema.Array(TrimmedNonEmptyStringSchema)),
  promptPreview: Schema.optional(TrimmedNonEmptyStringSchema),
  startedAt: Schema.optional(TrimmedNonEmptyStringSchema),
  lastActivityAt: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type WorkflowAgentRuntimeSnapshot = typeof WorkflowAgentRuntimeSnapshot.Type;

// Per-agent() opts scanned statically from a workflow script (string literals
// only): planned phase/model/effort for an agent label before it runs live.
const WorkflowAgentPlan = Schema.Struct({
  phase: Schema.optional(TrimmedNonEmptyStringSchema),
  model: Schema.optional(TrimmedNonEmptyStringSchema),
  effort: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type WorkflowAgentPlan = typeof WorkflowAgentPlan.Type;

const TaskStartedPayload = Schema.Struct({
  taskId: RuntimeTaskId,
  description: Schema.optional(TrimmedNonEmptyStringSchema),
  taskType: Schema.optional(TrimmedNonEmptyStringSchema),
  subagentType: Schema.optional(TrimmedNonEmptyStringSchema),
  workflowName: Schema.optional(TrimmedNonEmptyStringSchema),
  workflowTaskId: Schema.optional(RuntimeTaskId),
  // Parsed statically from the workflow script (task_started.prompt or the
  // Workflow tool input); absent when the meta literal is not parseable.
  workflowPhases: Schema.optional(Schema.Array(WorkflowPhase)),
  // agent() label -> phase title pairs scanned from the script text.
  workflowAgentPhases: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  // agent() label -> planned {phase, model, effort} opts scanned from the script
  // text. Superset of workflowAgentPhases (kept for already-persisted events).
  workflowAgentPlans: Schema.optional(Schema.Record(Schema.String, WorkflowAgentPlan)),
  toolUseId: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type TaskStartedPayload = typeof TaskStartedPayload.Type;

const TaskProgressPayload = Schema.Struct({
  taskId: RuntimeTaskId,
  description: TrimmedNonEmptyStringSchema,
  summary: Schema.optional(TrimmedNonEmptyStringSchema),
  usage: Schema.optional(Schema.Unknown),
  lastToolName: Schema.optional(TrimmedNonEmptyStringSchema),
  workflowTaskId: Schema.optional(RuntimeTaskId),
  // Live per-agent snapshots for workflow tasks, polled from the run's
  // transcript directory while the workflow is running.
  workflowAgents: Schema.optional(Schema.Array(WorkflowAgentRuntimeSnapshot)),
  // Set when the task is a provider-native subagent: the spawning tool call id
  // (the child thread's provider thread id) and the subagent's own title, so
  // progress is attributed to that subagent instead of the parent's reasoning.
  toolUseId: Schema.optional(TrimmedNonEmptyStringSchema),
  subagentTitle: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type TaskProgressPayload = typeof TaskProgressPayload.Type;

const TaskUpdatedPayload = Schema.Struct({
  taskId: RuntimeTaskId,
  status: Schema.optional(
    Schema.Literals(["pending", "running", "completed", "failed", "killed", "paused"]),
  ),
  error: Schema.optional(TrimmedNonEmptyStringSchema),
  // Set when the SDK moves a blocking Task call between foreground and background.
  isBackgrounded: Schema.optional(Schema.Boolean),
  toolUseId: Schema.optional(TrimmedNonEmptyStringSchema),
  workflowTaskId: Schema.optional(RuntimeTaskId),
  // Persisted launch identifiers from the Workflow tool result; re-invoking the
  // tool with {scriptPath, resumeFromRunId} resumes the run.
  workflowRunId: Schema.optional(TrimmedNonEmptyStringSchema),
  workflowScriptPath: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type TaskUpdatedPayload = typeof TaskUpdatedPayload.Type;

const TaskCompletedPayload = Schema.Struct({
  taskId: RuntimeTaskId,
  status: Schema.Literals(["completed", "failed", "stopped"]),
  summary: Schema.optional(TrimmedNonEmptyStringSchema),
  usage: Schema.optional(Schema.Unknown),
  workflowTaskId: Schema.optional(RuntimeTaskId),
  workflowAgents: Schema.optional(Schema.Array(WorkflowAgentSnapshot)),
  // Spawning tool call id when the task is a provider-native subagent.
  toolUseId: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type TaskCompletedPayload = typeof TaskCompletedPayload.Type;

// A user message was injected into running work without interrupting it.
// `target` says where it landed, which decides whether the message needs its own
// transcript marker: a `"subagent"` steer is delivered on the child thread where
// nothing else shows it, while a `"turn"` steer is already rendered as the sent
// user message on the thread it steers. Absent means `"subagent"` (the only
// producer before turn steering existed).
const TurnSteeredPayload = Schema.Struct({
  message: TrimmedNonEmptyStringSchema,
  target: Schema.optional(Schema.Literals(["turn", "subagent"])),
});
export type TurnSteeredPayload = typeof TurnSteeredPayload.Type;

const HookStartedPayload = Schema.Struct({
  hookId: TrimmedNonEmptyStringSchema,
  hookName: TrimmedNonEmptyStringSchema,
  hookEvent: TrimmedNonEmptyStringSchema,
  statusMessage: Schema.optional(TrimmedNonEmptyStringSchema),
  data: Schema.optional(Schema.Unknown),
});
export type HookStartedPayload = typeof HookStartedPayload.Type;

const HookProgressPayload = Schema.Struct({
  hookId: TrimmedNonEmptyStringSchema,
  output: Schema.optional(Schema.String),
  stdout: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
});
export type HookProgressPayload = typeof HookProgressPayload.Type;

const HookCompletedPayload = Schema.Struct({
  hookId: TrimmedNonEmptyStringSchema,
  hookName: Schema.optional(TrimmedNonEmptyStringSchema),
  hookEvent: Schema.optional(TrimmedNonEmptyStringSchema),
  outcome: Schema.Literals(["success", "error", "cancelled"]),
  status: Schema.optional(Schema.Literals(["completed", "failed", "blocked", "stopped"])),
  statusMessage: Schema.optional(TrimmedNonEmptyStringSchema),
  durationMs: Schema.optional(NonNegativeInt),
  output: Schema.optional(Schema.String),
  stdout: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.Int),
  data: Schema.optional(Schema.Unknown),
});
export type HookCompletedPayload = typeof HookCompletedPayload.Type;

const ToolProgressPayload = Schema.Struct({
  toolUseId: Schema.optional(TrimmedNonEmptyStringSchema),
  toolName: Schema.optional(TrimmedNonEmptyStringSchema),
  summary: Schema.optional(TrimmedNonEmptyStringSchema),
  elapsedSeconds: Schema.optional(Schema.Number),
});
export type ToolProgressPayload = typeof ToolProgressPayload.Type;

const ToolSummaryPayload = Schema.Struct({
  summary: TrimmedNonEmptyStringSchema,
  precedingToolUseIds: Schema.optional(Schema.Array(TrimmedNonEmptyStringSchema)),
});
export type ToolSummaryPayload = typeof ToolSummaryPayload.Type;

const AuthStatusPayload = Schema.Struct({
  isAuthenticating: Schema.optional(Schema.Boolean),
  output: Schema.optional(Schema.Array(Schema.String)),
  error: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type AuthStatusPayload = typeof AuthStatusPayload.Type;

const AccountUpdatedPayload = Schema.Struct({
  account: Schema.Unknown,
});
export type AccountUpdatedPayload = typeof AccountUpdatedPayload.Type;

const AccountRateLimitsUpdatedPayload = Schema.Struct({
  rateLimits: Schema.Unknown,
});
export type AccountRateLimitsUpdatedPayload = typeof AccountRateLimitsUpdatedPayload.Type;

const McpStatusUpdatedPayload = Schema.Struct({
  status: Schema.Unknown,
});
export type McpStatusUpdatedPayload = typeof McpStatusUpdatedPayload.Type;

const McpOauthCompletedPayload = Schema.Struct({
  success: Schema.Boolean,
  name: Schema.optional(TrimmedNonEmptyStringSchema),
  error: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type McpOauthCompletedPayload = typeof McpOauthCompletedPayload.Type;

const ModelReroutedPayload = Schema.Struct({
  fromModel: TrimmedNonEmptyStringSchema,
  toModel: TrimmedNonEmptyStringSchema,
  reason: TrimmedNonEmptyStringSchema,
});
export type ModelReroutedPayload = typeof ModelReroutedPayload.Type;

export const ModelSafetyBufferingUpdatedPayload = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.String,
  model: Schema.String,
  reasons: Schema.Array(Schema.String),
  showBufferingUi: Schema.Boolean,
  useCases: Schema.Array(Schema.String),
  fasterModel: Schema.optional(Schema.NullOr(Schema.String)),
});
export type ModelSafetyBufferingUpdatedPayload = typeof ModelSafetyBufferingUpdatedPayload.Type;

const ConfigWarningPayload = Schema.Struct({
  summary: TrimmedNonEmptyStringSchema,
  details: Schema.optional(TrimmedNonEmptyStringSchema),
  path: Schema.optional(TrimmedNonEmptyStringSchema),
  range: Schema.optional(Schema.Unknown),
});
export type ConfigWarningPayload = typeof ConfigWarningPayload.Type;

const DeprecationNoticePayload = Schema.Struct({
  summary: TrimmedNonEmptyStringSchema,
  details: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type DeprecationNoticePayload = typeof DeprecationNoticePayload.Type;

const FilesPersistedPayload = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      filename: TrimmedNonEmptyStringSchema,
      fileId: TrimmedNonEmptyStringSchema,
    }),
  ),
  failed: Schema.optional(
    Schema.Array(
      Schema.Struct({
        filename: TrimmedNonEmptyStringSchema,
        error: TrimmedNonEmptyStringSchema,
      }),
    ),
  ),
});
export type FilesPersistedPayload = typeof FilesPersistedPayload.Type;

const VcsStateChangedPayload = Schema.Struct({
  kind: Schema.optional(TrimmedNonEmptyStringSchema),
  cwd: Schema.optional(TrimmedNonEmptyStringSchema),
});
export type VcsStateChangedPayload = typeof VcsStateChangedPayload.Type;

// Forward-compatible diagnostic for provider events without an explicit mapping.
// The adapter bounds and redacts `data`; `detail` is a safe readable one-liner.
const EventUnmappedPayload = Schema.Struct({
  nativeType: TrimmedNonEmptyStringSchema,
  detail: Schema.optional(TrimmedNonEmptyStringSchema),
  data: Schema.optional(Schema.Unknown),
});
export type EventUnmappedPayload = typeof EventUnmappedPayload.Type;

const ProviderRuntimeSessionStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: SessionStartedType,
  payload: SessionStartedPayload,
});
export type ProviderRuntimeSessionStartedEvent = typeof ProviderRuntimeSessionStartedEvent.Type;

const ProviderRuntimeSessionConfiguredEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: SessionConfiguredType,
  payload: SessionConfiguredPayload,
});
export type ProviderRuntimeSessionConfiguredEvent =
  typeof ProviderRuntimeSessionConfiguredEvent.Type;

const ProviderRuntimeSessionStateChangedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: SessionStateChangedType,
  payload: SessionStateChangedPayload,
});
export type ProviderRuntimeSessionStateChangedEvent =
  typeof ProviderRuntimeSessionStateChangedEvent.Type;

const ProviderRuntimeSessionExitedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: SessionExitedType,
  payload: SessionExitedPayload,
});
export type ProviderRuntimeSessionExitedEvent = typeof ProviderRuntimeSessionExitedEvent.Type;

const ProviderRuntimeThreadStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ThreadStartedType,
  payload: ThreadStartedPayload,
});
export type ProviderRuntimeThreadStartedEvent = typeof ProviderRuntimeThreadStartedEvent.Type;

const ProviderRuntimeThreadStateChangedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ThreadStateChangedType,
  payload: ThreadStateChangedPayload,
});
export type ProviderRuntimeThreadStateChangedEvent =
  typeof ProviderRuntimeThreadStateChangedEvent.Type;

const ProviderRuntimeThreadMetadataUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ThreadMetadataUpdatedType,
  payload: ThreadMetadataUpdatedPayload,
});
export type ProviderRuntimeThreadMetadataUpdatedEvent =
  typeof ProviderRuntimeThreadMetadataUpdatedEvent.Type;

const ProviderRuntimeThreadTokenUsageUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ThreadTokenUsageUpdatedType,
  payload: ThreadTokenUsageUpdatedPayload,
});
export type ProviderRuntimeThreadTokenUsageUpdatedEvent =
  typeof ProviderRuntimeThreadTokenUsageUpdatedEvent.Type;

const ProviderRuntimeThreadRealtimeStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ThreadRealtimeStartedType,
  payload: ThreadRealtimeStartedPayload,
});
export type ProviderRuntimeThreadRealtimeStartedEvent =
  typeof ProviderRuntimeThreadRealtimeStartedEvent.Type;

const ProviderRuntimeThreadRealtimeItemAddedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ThreadRealtimeItemAddedType,
  payload: ThreadRealtimeItemAddedPayload,
});
export type ProviderRuntimeThreadRealtimeItemAddedEvent =
  typeof ProviderRuntimeThreadRealtimeItemAddedEvent.Type;

const ProviderRuntimeThreadRealtimeAudioDeltaEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ThreadRealtimeAudioDeltaType,
  payload: ThreadRealtimeAudioDeltaPayload,
});
export type ProviderRuntimeThreadRealtimeAudioDeltaEvent =
  typeof ProviderRuntimeThreadRealtimeAudioDeltaEvent.Type;

const ProviderRuntimeThreadRealtimeErrorEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ThreadRealtimeErrorType,
  payload: ThreadRealtimeErrorPayload,
});
export type ProviderRuntimeThreadRealtimeErrorEvent =
  typeof ProviderRuntimeThreadRealtimeErrorEvent.Type;

const ProviderRuntimeThreadRealtimeClosedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ThreadRealtimeClosedType,
  payload: ThreadRealtimeClosedPayload,
});
export type ProviderRuntimeThreadRealtimeClosedEvent =
  typeof ProviderRuntimeThreadRealtimeClosedEvent.Type;

const ProviderRuntimeTurnStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TurnStartedType,
  payload: TurnStartedPayload,
});
export type ProviderRuntimeTurnStartedEvent = typeof ProviderRuntimeTurnStartedEvent.Type;

const ProviderRuntimeTurnCompletedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TurnCompletedType,
  payload: TurnCompletedPayload,
});
export type ProviderRuntimeTurnCompletedEvent = typeof ProviderRuntimeTurnCompletedEvent.Type;

const ProviderRuntimeTurnAbortedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TurnAbortedType,
  payload: TurnAbortedPayload,
});
export type ProviderRuntimeTurnAbortedEvent = typeof ProviderRuntimeTurnAbortedEvent.Type;

const ProviderRuntimeTurnTasksUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TurnTasksUpdatedType,
  payload: TurnTasksUpdatedPayload,
});
export type ProviderRuntimeTurnTasksUpdatedEvent = typeof ProviderRuntimeTurnTasksUpdatedEvent.Type;

const ProviderRuntimeTurnProposedDeltaEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TurnProposedDeltaType,
  payload: TurnProposedDeltaPayload,
});
export type ProviderRuntimeTurnProposedDeltaEvent =
  typeof ProviderRuntimeTurnProposedDeltaEvent.Type;

const ProviderRuntimeTurnProposedCompletedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TurnProposedCompletedType,
  payload: TurnProposedCompletedPayload,
});
export type ProviderRuntimeTurnProposedCompletedEvent =
  typeof ProviderRuntimeTurnProposedCompletedEvent.Type;

const ProviderRuntimeTurnDiffUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TurnDiffUpdatedType,
  payload: TurnDiffUpdatedPayload,
});
export type ProviderRuntimeTurnDiffUpdatedEvent = typeof ProviderRuntimeTurnDiffUpdatedEvent.Type;

const ProviderRuntimeTurnSteeredEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TurnSteeredType,
  payload: TurnSteeredPayload,
});
export type ProviderRuntimeTurnSteeredEvent = typeof ProviderRuntimeTurnSteeredEvent.Type;

const ProviderRuntimeItemStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ItemStartedType,
  payload: ItemLifecyclePayload,
});
export type ProviderRuntimeItemStartedEvent = typeof ProviderRuntimeItemStartedEvent.Type;

const ProviderRuntimeItemUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ItemUpdatedType,
  payload: ItemLifecyclePayload,
});
export type ProviderRuntimeItemUpdatedEvent = typeof ProviderRuntimeItemUpdatedEvent.Type;

const ProviderRuntimeItemCompletedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ItemCompletedType,
  payload: ItemLifecyclePayload,
});
export type ProviderRuntimeItemCompletedEvent = typeof ProviderRuntimeItemCompletedEvent.Type;

const ProviderRuntimeContentDeltaEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ContentDeltaType,
  payload: ContentDeltaPayload,
});
export type ProviderRuntimeContentDeltaEvent = typeof ProviderRuntimeContentDeltaEvent.Type;

const ProviderRuntimeRequestOpenedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: RequestOpenedType,
  payload: RequestOpenedPayload,
});
export type ProviderRuntimeRequestOpenedEvent = typeof ProviderRuntimeRequestOpenedEvent.Type;

const ProviderRuntimeRequestResolvedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: RequestResolvedType,
  payload: RequestResolvedPayload,
});
export type ProviderRuntimeRequestResolvedEvent = typeof ProviderRuntimeRequestResolvedEvent.Type;

const ProviderRuntimeUserInputRequestedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: UserInputRequestedType,
  payload: UserInputRequestedPayload,
});
export type ProviderRuntimeUserInputRequestedEvent =
  typeof ProviderRuntimeUserInputRequestedEvent.Type;

const ProviderRuntimeUserInputResolvedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: UserInputResolvedType,
  payload: UserInputResolvedPayload,
});
export type ProviderRuntimeUserInputResolvedEvent =
  typeof ProviderRuntimeUserInputResolvedEvent.Type;

const ProviderRuntimeTaskStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TaskStartedType,
  payload: TaskStartedPayload,
});
export type ProviderRuntimeTaskStartedEvent = typeof ProviderRuntimeTaskStartedEvent.Type;

const ProviderRuntimeTaskProgressEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TaskProgressType,
  payload: TaskProgressPayload,
});
export type ProviderRuntimeTaskProgressEvent = typeof ProviderRuntimeTaskProgressEvent.Type;

const ProviderRuntimeTaskUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TaskUpdatedType,
  payload: TaskUpdatedPayload,
});
export type ProviderRuntimeTaskUpdatedEvent = typeof ProviderRuntimeTaskUpdatedEvent.Type;

const ProviderRuntimeTaskCompletedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: TaskCompletedType,
  payload: TaskCompletedPayload,
});
export type ProviderRuntimeTaskCompletedEvent = typeof ProviderRuntimeTaskCompletedEvent.Type;

const ProviderRuntimeHookStartedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: HookStartedType,
  payload: HookStartedPayload,
});
export type ProviderRuntimeHookStartedEvent = typeof ProviderRuntimeHookStartedEvent.Type;

const ProviderRuntimeHookProgressEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: HookProgressType,
  payload: HookProgressPayload,
});
export type ProviderRuntimeHookProgressEvent = typeof ProviderRuntimeHookProgressEvent.Type;

const ProviderRuntimeHookCompletedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: HookCompletedType,
  payload: HookCompletedPayload,
});
export type ProviderRuntimeHookCompletedEvent = typeof ProviderRuntimeHookCompletedEvent.Type;

const ProviderRuntimeToolProgressEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ToolProgressType,
  payload: ToolProgressPayload,
});
export type ProviderRuntimeToolProgressEvent = typeof ProviderRuntimeToolProgressEvent.Type;

const ProviderRuntimeToolSummaryEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ToolSummaryType,
  payload: ToolSummaryPayload,
});
export type ProviderRuntimeToolSummaryEvent = typeof ProviderRuntimeToolSummaryEvent.Type;

const ProviderRuntimeAuthStatusEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: AuthStatusType,
  payload: AuthStatusPayload,
});
export type ProviderRuntimeAuthStatusEvent = typeof ProviderRuntimeAuthStatusEvent.Type;

const ProviderRuntimeAccountUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: AccountUpdatedType,
  payload: AccountUpdatedPayload,
});
export type ProviderRuntimeAccountUpdatedEvent = typeof ProviderRuntimeAccountUpdatedEvent.Type;

const ProviderRuntimeAccountRateLimitsUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: AccountRateLimitsUpdatedType,
  payload: AccountRateLimitsUpdatedPayload,
});
export type ProviderRuntimeAccountRateLimitsUpdatedEvent =
  typeof ProviderRuntimeAccountRateLimitsUpdatedEvent.Type;

const ProviderRuntimeMcpStatusUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: McpStatusUpdatedType,
  payload: McpStatusUpdatedPayload,
});
export type ProviderRuntimeMcpStatusUpdatedEvent = typeof ProviderRuntimeMcpStatusUpdatedEvent.Type;

const ProviderRuntimeMcpOauthCompletedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: McpOauthCompletedType,
  payload: McpOauthCompletedPayload,
});
export type ProviderRuntimeMcpOauthCompletedEvent =
  typeof ProviderRuntimeMcpOauthCompletedEvent.Type;

const ProviderRuntimeAutomaticApprovalReviewUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: AutomaticApprovalReviewUpdatedType,
  payload: AutomaticApprovalReviewUpdatePayload,
});
export type ProviderRuntimeAutomaticApprovalReviewUpdatedEvent =
  typeof ProviderRuntimeAutomaticApprovalReviewUpdatedEvent.Type;

const ProviderRuntimeModelReroutedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ModelReroutedType,
  payload: ModelReroutedPayload,
});
export type ProviderRuntimeModelReroutedEvent = typeof ProviderRuntimeModelReroutedEvent.Type;

const ProviderRuntimeModelSafetyBufferingUpdatedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ModelSafetyBufferingUpdatedType,
  payload: ModelSafetyBufferingUpdatedPayload,
});
export type ProviderRuntimeModelSafetyBufferingUpdatedEvent =
  typeof ProviderRuntimeModelSafetyBufferingUpdatedEvent.Type;

const ProviderRuntimeConfigWarningEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ConfigWarningType,
  payload: ConfigWarningPayload,
});
export type ProviderRuntimeConfigWarningEvent = typeof ProviderRuntimeConfigWarningEvent.Type;

const ProviderRuntimeDeprecationNoticeEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: DeprecationNoticeType,
  payload: DeprecationNoticePayload,
});
export type ProviderRuntimeDeprecationNoticeEvent =
  typeof ProviderRuntimeDeprecationNoticeEvent.Type;

const ProviderRuntimeFilesPersistedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: FilesPersistedType,
  payload: FilesPersistedPayload,
});
export type ProviderRuntimeFilesPersistedEvent = typeof ProviderRuntimeFilesPersistedEvent.Type;

const ProviderRuntimeVcsStateChangedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: VcsStateChangedType,
  payload: VcsStateChangedPayload,
});
export type ProviderRuntimeVcsStateChangedEvent = typeof ProviderRuntimeVcsStateChangedEvent.Type;

const ProviderRuntimeWarningEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: RuntimeWarningType,
  payload: RuntimeWarningPayload,
});
export type ProviderRuntimeWarningEvent = typeof ProviderRuntimeWarningEvent.Type;

const ProviderRuntimeEventUnmappedEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: EventUnmappedType,
  payload: EventUnmappedPayload,
});
export type ProviderRuntimeEventUnmappedEvent = typeof ProviderRuntimeEventUnmappedEvent.Type;

const ProviderRuntimeErrorEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: RuntimeErrorType,
  payload: RuntimeErrorPayload,
});
export type ProviderRuntimeErrorEvent = typeof ProviderRuntimeErrorEvent.Type;

export const ProviderRuntimeEventV2 = Schema.Union([
  ProviderRuntimeSessionStartedEvent,
  ProviderRuntimeSessionConfiguredEvent,
  ProviderRuntimeSessionStateChangedEvent,
  ProviderRuntimeSessionExitedEvent,
  ProviderRuntimeThreadStartedEvent,
  ProviderRuntimeThreadStateChangedEvent,
  ProviderRuntimeThreadMetadataUpdatedEvent,
  ProviderRuntimeThreadTokenUsageUpdatedEvent,
  ProviderRuntimeThreadRealtimeStartedEvent,
  ProviderRuntimeThreadRealtimeItemAddedEvent,
  ProviderRuntimeThreadRealtimeAudioDeltaEvent,
  ProviderRuntimeThreadRealtimeErrorEvent,
  ProviderRuntimeThreadRealtimeClosedEvent,
  ProviderRuntimeTurnStartedEvent,
  ProviderRuntimeTurnCompletedEvent,
  ProviderRuntimeTurnAbortedEvent,
  ProviderRuntimeTurnTasksUpdatedEvent,
  ProviderRuntimeTurnProposedDeltaEvent,
  ProviderRuntimeTurnProposedCompletedEvent,
  ProviderRuntimeTurnDiffUpdatedEvent,
  ProviderRuntimeTurnSteeredEvent,
  ProviderRuntimeItemStartedEvent,
  ProviderRuntimeItemUpdatedEvent,
  ProviderRuntimeItemCompletedEvent,
  ProviderRuntimeContentDeltaEvent,
  ProviderRuntimeRequestOpenedEvent,
  ProviderRuntimeRequestResolvedEvent,
  ProviderRuntimeUserInputRequestedEvent,
  ProviderRuntimeUserInputResolvedEvent,
  ProviderRuntimeTaskStartedEvent,
  ProviderRuntimeTaskProgressEvent,
  ProviderRuntimeTaskUpdatedEvent,
  ProviderRuntimeTaskCompletedEvent,
  ProviderRuntimeHookStartedEvent,
  ProviderRuntimeHookProgressEvent,
  ProviderRuntimeHookCompletedEvent,
  ProviderRuntimeToolProgressEvent,
  ProviderRuntimeToolSummaryEvent,
  ProviderRuntimeAuthStatusEvent,
  ProviderRuntimeAccountUpdatedEvent,
  ProviderRuntimeAccountRateLimitsUpdatedEvent,
  ProviderRuntimeMcpStatusUpdatedEvent,
  ProviderRuntimeMcpOauthCompletedEvent,
  ProviderRuntimeAutomaticApprovalReviewUpdatedEvent,
  ProviderRuntimeModelReroutedEvent,
  ProviderRuntimeModelSafetyBufferingUpdatedEvent,
  ProviderRuntimeConfigWarningEvent,
  ProviderRuntimeDeprecationNoticeEvent,
  ProviderRuntimeFilesPersistedEvent,
  ProviderRuntimeVcsStateChangedEvent,
  ProviderRuntimeWarningEvent,
  ProviderRuntimeErrorEvent,
  ProviderRuntimeEventUnmappedEvent,
]);
export type ProviderRuntimeEventV2 = typeof ProviderRuntimeEventV2.Type;

export const ProviderRuntimeEvent = ProviderRuntimeEventV2;
export type ProviderRuntimeEvent = ProviderRuntimeEventV2;

// Compatibility aliases for call sites still importing legacy names.
const ProviderRuntimeMessageDeltaEvent = ProviderRuntimeContentDeltaEvent;
export type ProviderRuntimeMessageDeltaEvent = ProviderRuntimeContentDeltaEvent;
const ProviderRuntimeMessageCompletedEvent = ProviderRuntimeItemCompletedEvent;
export type ProviderRuntimeMessageCompletedEvent = ProviderRuntimeItemCompletedEvent;
const ProviderRuntimeToolStartedEvent = ProviderRuntimeItemStartedEvent;
export type ProviderRuntimeToolStartedEvent = ProviderRuntimeItemStartedEvent;
const ProviderRuntimeToolCompletedEvent = ProviderRuntimeItemCompletedEvent;
export type ProviderRuntimeToolCompletedEvent = ProviderRuntimeItemCompletedEvent;
const ProviderRuntimeApprovalRequestedEvent = ProviderRuntimeRequestOpenedEvent;
export type ProviderRuntimeApprovalRequestedEvent = ProviderRuntimeRequestOpenedEvent;
const ProviderRuntimeApprovalResolvedEvent = ProviderRuntimeRequestResolvedEvent;
export type ProviderRuntimeApprovalResolvedEvent = ProviderRuntimeRequestResolvedEvent;

// Legacy helper aliases retained for adapters/tests.
const ProviderRuntimeToolKind = Schema.Literals(["command", "file-read", "file-change", "other"]);
export type ProviderRuntimeToolKind = typeof ProviderRuntimeToolKind.Type;

export const ProviderRuntimeTurnStatus = RuntimeTurnState;
export type ProviderRuntimeTurnStatus = RuntimeTurnState;
