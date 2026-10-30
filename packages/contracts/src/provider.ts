import { Option, Schema, SchemaIssue } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";
import {
  ApprovalRequestId,
  EventId,
  IsoDateTime,
  ProviderItemId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
} from "./baseSchemas";
import {
  ChatAttachment,
  ModelSelection,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProviderApprovalDecision,
  ProviderApprovalPolicy,
  ProviderInteractionMode,
  ProviderRequestKind,
  ProviderReviewTarget,
  ProviderSandboxMode,
  ProviderStartOptions,
  ProviderTurnTrigger,
  ProviderUserInputAnswers,
  RuntimeMode,
} from "./orchestration";
import { MossLaunchPlan } from "./moss";
import { MossLoopLedgerDashboardSnapshot } from "./mossLoopLedgerDashboard";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance";
import { ProviderMentionReference, ProviderSkillReference } from "./providerDiscovery";

const ProviderSessionStatus = Schema.Literals([
  "connecting",
  "ready",
  "running",
  "error",
  "closed",
]);

export const ProviderSession = Schema.Struct({
  sessionId: Schema.optional(RuntimeSessionId),
  provider: ProviderDriverKind,
  providerInstanceId: Schema.optional(ProviderInstanceId),
  /**
   * The provider process is still alive, but its Moss gateway bearer was
   * retired at the end of a terminal turn. Such a runtime may be used for
   * teardown and event draining, but must be replaced before dispatching a
   * new turn.
   */
  gatewayCredentialRetired: Schema.optional(Schema.Boolean),
  status: ProviderSessionStatus,
  runtimeMode: RuntimeMode,
  cwd: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  threadId: ThreadId,
  resumeCursor: Schema.optional(Schema.Unknown),
  activeTurnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastError: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderSession = typeof ProviderSession.Type;

export const ProviderListSessionsResult = Schema.Struct({
  sessions: Schema.Array(ProviderSession),
});
export type ProviderListSessionsResult = typeof ProviderListSessionsResult.Type;

export const ProviderSessionStartInput = Schema.Struct({
  threadId: ThreadId,
  provider: Schema.optional(ProviderDriverKind),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  lifecycleGeneration: Schema.optional(TrimmedNonEmptyString),
  cwd: Schema.optional(TrimmedNonEmptyString),
  /**
   * Extra folders of a multi-folder project the session may read and write besides `cwd`.
   * Only providers that can grant them natively (Codex, Claude) receive this.
   */
  additionalDirectories: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  modelSelection: Schema.optional(ModelSelection),
  resumeCursor: Schema.optional(Schema.Unknown),
  forkSourceResumeCursor: Schema.optional(Schema.Unknown),
  resetContinuation: Schema.optional(Schema.Boolean),
  approvalPolicy: Schema.optional(ProviderApprovalPolicy),
  sandboxMode: Schema.optional(ProviderSandboxMode),
  providerOptions: Schema.optional(ProviderStartOptions),
  /** Explicit per-thread provisioning for the Linux computer MCP tools. */
  enableComputerControl: Schema.optional(Schema.Boolean),
  /**
   * Pre-approve the Moss group/gateway MCP tools (`mcp__moss__*`,
   * `moss_*`) for this session even when the runtime mode would normally ask
   * for approval. The gateway already authorizes them server-side; the
   * interactive prompt only adds friction for trusted principals such as a
   * group coordinator. File edits and shell commands still ask.
   */
  autoApproveMossTools: Schema.optional(Schema.Boolean),
  runtimeMode: RuntimeMode,
});
export type ProviderSessionStartInput = typeof ProviderSessionStartInput.Type;

const ProviderSendTurnContentCheck = Schema.makeFilter(
  (rawInput: unknown) => {
    const input =
      typeof rawInput === "object" && rawInput !== null
        ? (rawInput as {
            readonly turnTrigger?: ProviderTurnTrigger;
            readonly input?: string;
            readonly attachments?: ReadonlyArray<unknown>;
            readonly skills?: ReadonlyArray<unknown>;
            readonly mentions?: ReadonlyArray<unknown>;
            readonly modelSelection?: unknown;
            readonly interactionMode?: ProviderInteractionMode;
          })
        : {};
    const hasContent =
      (input.input?.trim().length ?? 0) > 0 || (input.attachments?.length ?? 0) > 0;
    if (input.turnTrigger === "safety_buffer_retry") {
      return (
        (hasContent && input.modelSelection !== undefined) ||
        new SchemaIssue.InvalidValue(Option.some(input.turnTrigger), {
          message:
            "A safety buffering retry must include the preserved input and target model selection.",
        })
      );
    }
    if (input.turnTrigger !== undefined) {
      return (
        (!hasContent &&
          (input.skills?.length ?? 0) === 0 &&
          (input.mentions?.length ?? 0) === 0 &&
          input.modelSelection === undefined &&
          input.interactionMode !== undefined) ||
        new SchemaIssue.InvalidValue(Option.some(input.turnTrigger), {
          message:
            "A triggered empty turn must include the current interaction mode and no input, attachments, skills, mentions, or model selection.",
        })
      );
    }
    return (
      hasContent ||
      new SchemaIssue.InvalidValue(Option.some(input.input ?? ""), {
        message: "Provider turn input must include text or attachments.",
      })
    );
  },
  { identifier: "ProviderSendTurnContent" },
);

export const ProviderSendTurnInput = Schema.Struct({
  threadId: ThreadId,
  input: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  ),
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
  skills: Schema.optional(Schema.Array(ProviderSkillReference)),
  mentions: Schema.optional(Schema.Array(ProviderMentionReference)),
  modelSelection: Schema.optional(ModelSelection),
  interactionMode: Schema.optional(ProviderInteractionMode),
  turnTrigger: Schema.optional(ProviderTurnTrigger),
}).check(ProviderSendTurnContentCheck);
export type ProviderSendTurnInput = typeof ProviderSendTurnInput.Type;
export const ProviderSteerTurnInput = Schema.Struct({
  threadId: ThreadId,
  input: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  ),
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
  skills: Schema.optional(Schema.Array(ProviderSkillReference)),
  mentions: Schema.optional(Schema.Array(ProviderMentionReference)),
  modelSelection: Schema.optional(ModelSelection),
  interactionMode: Schema.optional(ProviderInteractionMode),
}).check(ProviderSendTurnContentCheck);
export type ProviderSteerTurnInput = typeof ProviderSteerTurnInput.Type;

export const ProviderForkThreadInput = Schema.Struct({
  sourceThreadId: ThreadId,
  threadId: ThreadId,
  lifecycleGeneration: Schema.optional(TrimmedNonEmptyString),
  /** External imports must pin a completed native transcript boundary. */
  requireCompletedSource: Schema.optional(Schema.Boolean),
  /**
   * Fork only the native history through the end of this source turn ("Fork
   * from this turn"). Absent = the source's latest point. An adapter that
   * cannot honor the boundary must not fork at the latest point instead; the
   * caller then rebuilds the fork from its imported transcript.
   */
  throughTurnId: Schema.optional(TurnId),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  sourceResumeCursor: Schema.optional(Schema.Unknown),
  sourceCwd: Schema.optional(TrimmedNonEmptyString),
  cwd: Schema.optional(TrimmedNonEmptyString),
  /** Extra folders of a multi-folder project; see `ProviderSessionStartInput`. */
  additionalDirectories: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  modelSelection: Schema.optional(ModelSelection),
  providerOptions: Schema.optional(ProviderStartOptions),
  /**
   * The computer-control fact a start would carry, so a fork leases the same
   * gateway capabilities as its source instead of silently losing
   * `computer:control` at the fork boundary.
   */
  enableComputerControl: Schema.optional(Schema.Boolean),
  /**
   * Same hand-off as `enableComputerControl`: the gateway-approval fact a
   * start would carry, so a fork leases the same pre-approved Moss tools as
   * its source session.
   */
  autoApproveMossTools: Schema.optional(Schema.Boolean),
  runtimeMode: RuntimeMode,
});
export type ProviderForkThreadInput = typeof ProviderForkThreadInput.Type;

export const ProviderForkThreadResult = Schema.Struct({
  threadId: ThreadId,
  resumeCursor: Schema.optional(Schema.Unknown),
});
export type ProviderForkThreadResult = typeof ProviderForkThreadResult.Type;

export const ProviderTurnStartResult = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  resumeCursor: Schema.optional(Schema.Unknown),
});
export type ProviderTurnStartResult = typeof ProviderTurnStartResult.Type;

export const ProviderStartReviewInput = Schema.Struct({
  threadId: ThreadId,
  target: ProviderReviewTarget,
});
export type ProviderStartReviewInput = typeof ProviderStartReviewInput.Type;

export const ProviderInterruptTurnInput = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  providerThreadId: Schema.optional(TrimmedNonEmptyString),
  requireExactTurnId: Schema.optional(Schema.Boolean),
});
export type ProviderInterruptTurnInput = typeof ProviderInterruptTurnInput.Type;

export const ProviderStopTaskInput = Schema.Struct({
  threadId: ThreadId,
  taskId: TrimmedNonEmptyString,
});
export type ProviderStopTaskInput = typeof ProviderStopTaskInput.Type;

export const ProviderBackgroundTaskInput = Schema.Struct({
  threadId: ThreadId,
  toolUseId: TrimmedNonEmptyString,
});
export type ProviderBackgroundTaskInput = typeof ProviderBackgroundTaskInput.Type;

export const ProviderSteerSubagentInput = Schema.Struct({
  threadId: ThreadId,
  providerThreadId: TrimmedNonEmptyString,
  input: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  ),
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
  skills: Schema.optional(Schema.Array(ProviderSkillReference)),
  mentions: Schema.optional(Schema.Array(ProviderMentionReference)),
});
export type ProviderSteerSubagentInput = typeof ProviderSteerSubagentInput.Type;

export const ProviderStopSessionInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderStopSessionInput = typeof ProviderStopSessionInput.Type;

export const ProviderCompactThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderCompactThreadInput = typeof ProviderCompactThreadInput.Type;

export const ProviderGetLaunchPlanInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderGetLaunchPlanInput = typeof ProviderGetLaunchPlanInput.Type;

export const ProviderGetLaunchPlanResult = Schema.Struct({
  threadId: ThreadId,
  planHash: Schema.NullOr(TrimmedNonEmptyString),
  launchPlan: Schema.NullOr(MossLaunchPlan),
});
export type ProviderGetLaunchPlanResult = typeof ProviderGetLaunchPlanResult.Type;

export const ProviderGetLoopLedgerDashboardSnapshotInput = Schema.Struct({
  threadId: ThreadId,
  createdAt: Schema.optional(IsoDateTime),
});
export type ProviderGetLoopLedgerDashboardSnapshotInput =
  typeof ProviderGetLoopLedgerDashboardSnapshotInput.Type;

export const ProviderGetLoopLedgerDashboardSnapshotResult = Schema.Struct({
  threadId: ThreadId,
  snapshot: MossLoopLedgerDashboardSnapshot,
});
export type ProviderGetLoopLedgerDashboardSnapshotResult =
  typeof ProviderGetLoopLedgerDashboardSnapshotResult.Type;

export const ProviderPermissionActionIntent = Schema.Literals(["approve", "deny", "defer"]);
export type ProviderPermissionActionIntent = typeof ProviderPermissionActionIntent.Type;

export const ProviderPermissionActionStatus = Schema.Literals([
  "accepted",
  "unsupported",
  "rejected",
]);
export type ProviderPermissionActionStatus = typeof ProviderPermissionActionStatus.Type;

export const ProviderSubmitPermissionActionInput = Schema.Struct({
  threadId: ThreadId,
  sessionId: RuntimeSessionId,
  normalizedEventId: EventId,
  intent: ProviderPermissionActionIntent,
});
export type ProviderSubmitPermissionActionInput = typeof ProviderSubmitPermissionActionInput.Type;

export const ProviderSubmitPermissionActionResult = Schema.Struct({
  threadId: ThreadId,
  sessionId: RuntimeSessionId,
  normalizedEventId: EventId,
  intent: ProviderPermissionActionIntent,
  status: ProviderPermissionActionStatus,
  message: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderSubmitPermissionActionResult = typeof ProviderSubmitPermissionActionResult.Type;

export const ProviderRespondToRequestInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  lifecycleGeneration: Schema.optional(TrimmedNonEmptyString),
  decision: ProviderApprovalDecision,
});
export type ProviderRespondToRequestInput = typeof ProviderRespondToRequestInput.Type;

export const ProviderRespondToUserInputInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  lifecycleGeneration: Schema.optional(TrimmedNonEmptyString),
  answers: ProviderUserInputAnswers,
});
export type ProviderRespondToUserInputInput = typeof ProviderRespondToUserInputInput.Type;

const ProviderEventKind = Schema.Literals(["session", "notification", "request", "error"]);

export const ProviderEvent = Schema.Struct({
  id: EventId,
  sessionId: Schema.optional(RuntimeSessionId),
  kind: ProviderEventKind,
  provider: ProviderDriverKind,
  providerInstanceId: Schema.optional(ProviderInstanceId),
  threadId: ThreadId,
  createdAt: IsoDateTime,
  method: TrimmedNonEmptyString,
  message: Schema.optional(TrimmedNonEmptyString),
  turnId: Schema.optional(TurnId),
  parentTurnId: Schema.optional(TurnId),
  itemId: Schema.optional(ProviderItemId),
  requestId: Schema.optional(ApprovalRequestId),
  requestKind: Schema.optional(ProviderRequestKind),
  lifecycleGeneration: Schema.optional(TrimmedNonEmptyString),
  providerThreadId: Schema.optional(TrimmedNonEmptyString),
  providerParentThreadId: Schema.optional(TrimmedNonEmptyString),
  textDelta: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Unknown),
});
export type ProviderEvent = typeof ProviderEvent.Type;
