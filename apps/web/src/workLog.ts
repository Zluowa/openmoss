import { applyCodexReplayOrder } from "./lib/codexReplay";
import { orderedActivities, isContextCompactionProgressLabel } from "./lib/orderedThreadActivities";
import { derivePendingApprovalRequestKeys } from "./pendingInteractionDerivation";
export { orderedActivities } from "./lib/orderedThreadActivities";

import {
  type ComputerPermission,
  type ComputerBuildSignature,
  COMPUTER_CONTROL_DENIED_ACTIVITY_KIND,
  COMPUTER_SETUP_REQUIRED_ACTIVITY_KIND,
  isToolLifecycleItemType,
  CODEX_GENERATED_IMAGE_ARTIFACT_KIND,
  MOSS_GENERATED_IMAGE_ARTIFACT_KIND,
  MOSS_IMAGE_GENERATION_FAILURE_KIND,
  type ModelSelection,
  STUDIO_OUTPUTS_ACTIVITY_KIND,
  type OrchestrationLatestTurnState,
  type OrchestrationThreadActivity,
  type OrchestrationPendingInteraction,
  type ProviderInstanceId,
  type ProviderKind,
  type RuntimeCodexErrorInfo,
  type RuntimeWarningStreamRetryPayload,
  type ToolLifecycleItemType,
  type TurnId,
  type CodexReplayTurn,
  type UserInputQuestion,
  INLINE_VISUAL_ACTIVITY_KIND,
  INLINE_VISUAL_ACTIVITY_KIND_UPSTREAM_ALIAS,
  InlineVisualActivityPayload,
  SECRET_REQUEST_ACTIVITY_KIND,
  SECRET_REQUEST_RESOLVED_ACTIVITY_KIND,
  SecretRequestActivityPayload,
} from "@synara/contracts";
import { Option, Schema } from "effect";
import { INLINE_VISUALS_ON } from "./betaFeatures";
import {
  decodeSubagentAgentStates,
  extractSubagentIdentityHints,
  decodeSubagentReceiverAgents,
  decodeSubagentReceiverThreadIds,
} from "@synara/shared/subagents";
import {
  approvalRequestKindFromRequestType,
  pendingRequestInstanceKey,
  type ApprovalRequestKind,
} from "@synara/shared/threadSummary";
import {
  stripTrailingToolExitCode,
  summarizeToolRawOutput,
} from "@synara/shared/toolOutputSummary";
import { isCodexDiagnosticWarningMessage } from "@synara/shared/codexDiagnostics";
import { pluralize, stripTerminalControlSequences } from "@synara/shared/text";
import { suppressCoordinatorCheckinMessages } from "@synara/shared/coordinatorCheckin";
import { PROVIDER_DESCRIPTORS } from "@synara/shared/providerMetadata";
import type { HtmlRenderReference } from "@synara/shared/htmlRender";
import {
  HTML_RENDER_ACTIVITY_KIND,
  htmlRenderFromActivity,
} from "@synara/shared/htmlRenderActivity";
import {
  deriveReadableToolTitle,
  deriveMossMcpToolTitle,
  codexMcpInvocationTitle,
  isHtmlPageToolCall,
  extractMcpServerName,
  isGenericToolTitle,
  normalizeCompactToolLabel,
  normalizeToolTextForComparison,
  type MossMcpToolStatus,
} from "./lib/toolCallLabel";
import { toolArgumentSummaryToolName } from "./lib/toolArgumentSummary";
import { computerToolName, describeComputerToolCall } from "./lib/computerToolPresentation";
import {
  deriveWorkLogToolDetails,
  mergeWorkLogToolDetails,
  parseWorkLogAutomaticApprovalReview,
  parseWorkLogMcpToolResult,
  type WorkLogToolDetails,
  type WorkLogAutomaticApprovalReview,
  type WorkLogMcpToolResult,
} from "./lib/toolCallDetails";
export type { WorkLogMcpToolResult } from "./lib/toolCallDetails";
import {
  FAST_MODE_STATE_ACTIVITY_KIND,
  fastModeNoticeFromActivity,
  type FastModeNotice,
} from "./lib/fastModeState";
import { stripProposedPlanBlocksFromText } from "./proposedPlan";
import { normalizeProviderRuntimeMessage } from "./lib/providerRuntimeMessages";
import {
  isTimelineMultiAgentAction,
  normalizeMultiAgentAction,
  normalizeMultiAgentActionStatus,
} from "./lib/multiAgentAction";
import {
  decodeSubagentActivity,
  normalizeSubagentToolData,
  type SubagentActivityKind,
} from "@synara/shared/subagentTool";

import type { ChatMessage, ProposedPlan } from "./types";

export type WorkLogRequestKind = ApprovalRequestKind;

// Mirrors CHECKPOINT_REVERT_FAILED_ACTIVITY_KIND in
// apps/server/src/orchestration/commandInvariants.ts, which the web app cannot
// import.
const CHECKPOINT_REVERT_FAILED_ACTIVITY_KIND = "checkpoint.revert.failed";
export const PROVIDER_CONTEXT_LIFECYCLE_ACTIVITY_KIND = "provider.context.changed";
const SESSION_CONTEXT_RECAP_PREVIEW_MAX_CHARS = 600;
// Mirror the same-thread Hand off activities in ProviderCommandReactor.ts.
export const PROVIDER_HANDOFF_ACTIVITY_KIND = "provider.handoff";
export const PROVIDER_HANDOFF_FAILED_ACTIVITY_KIND = "provider.handoff.failed";

export interface ProviderHandoffInfo {
  status: "completed" | "failed";
  sourceProvider: ProviderKind;
  sourceModel: string;
  targetProvider: ProviderKind;
  targetModel: string;
  /** Full selections (effort, fast mode); rebuilt from provider + model when absent. */
  sourceModelSelection: ModelSelection;
  targetModelSelection: ModelSelection;
  /** Prior-transcript context the target receives with its first turn. */
  contextText: string | null;
  /** Why the target could not start; only set on failure. */
  failureDetail: string | null;
  /** Set when that side requested fast mode but its session was not serving it. */
  sourceFastModeNotice?: FastModeNotice | null;
  targetFastModeNotice?: FastModeNotice | null;
}

export type ProviderContextLifecycleReason =
  | "conversation-rebuilt"
  | "fork-from-earlier-turn"
  | "fresh-session"
  | "native-history-unavailable"
  | "native-resume-failed";

export interface ProviderContextLifecycleInfo {
  provider: ProviderKind;
  nativeHistory: "available" | "unavailable";
  restartReason: ProviderContextLifecycleReason;
  sessionRestarted: boolean;
  recapInjected: boolean;
  recapCharacters: number;
  recapPreview: string | null;
  recapPreviewTruncated: boolean;
}

export const AUTOMATIC_APPROVAL_REVIEW_ACTIVITY_KIND = "automatic-approval-review.updated";
export interface WorkLogComputerSetupRequired {
  /**
   * The grants the OS is withholding, so the card can name them. Empty when the
   * backend refused without naming one — the card then says what it can.
   */
  missing: readonly ComputerPermission[];
  /**
   * How the running build is signed, when the backend could say. Only an
   * `adhoc` build gets the stale-grant explanation, because only there can
   * System Settings show the switch on while the grant does not apply.
   */
  buildSignature?: ComputerBuildSignature;
  /**
   * The app macOS files this Moss's grants against, when a desktop shell told
   * the server which flavor it is. The card's `tccutil` advice names it, and
   * absent means that advice is withheld rather than guessed — a guessed
   * identifier resets a different Moss's grants.
   */
  bundleId?: string;
}

export interface WorkLogEntry {
  id: string;
  createdAt: string;
  /**
   * Provider runtime sequence, used to break equal-time ties in the timeline.
   * Absent for server-created rows: their orchestration event sequence is a
   * different counter, so they order by `createdAt` instead.
   */
  sequence?: number;
  turnId?: TurnId | null;
  label: string;
  detail?: string;
  command?: string;
  rawCommand?: string;
  preview?: string;
  changedFiles?: ReadonlyArray<string>;
  fileChangeKinds?: Readonly<Record<string, "add" | "delete" | "update">>;
  tone: "thinking" | "tool" | "info" | "error";
  toolTitle?: string;
  toolName?: string;
  /** MCP server that served the call; picks the row's icon (connector, brand). */
  mcpServer?: string;
  toolCallId?: string;
  toolStatus?: MossMcpToolStatus;
  liveActivity?: WorkLogLiveActivity;
  toolDetails?: WorkLogToolDetails;
  /** Derived from the owning turn's settlement and a real provider process ID. */
  backgroundTerminal?: "running" | "finished";
  itemType?: ToolLifecycleItemType;
  requestKind?: WorkLogRequestKind;
  subagents?: ReadonlyArray<WorkLogSubagent>;
  subagentAction?: WorkLogSubagentAction;
  /** Native Codex chip occurrence; its historical status does not follow later child state. */
  subagentActivity?: SubagentActivityKind;
  // Set on the one entry a turn's subagents fold into: the transcript renders
  // it as the subagent card (see SubagentRunCard.logic.ts).
  subagentRun?: WorkLogSubagentRun;
  automation?: WorkLogAutomation;
  mossThreadCreation?: WorkLogMossThreadCreation;
  // Deterministic coordinator-monitor rows (worker settled / stuck /
  // batch roll-up) render as compact centered pills in the coordinator
  // conversation, each carrying a link into the reported thread.
  mossWorkerNotice?: WorkLogMossWorkerNotice;
  // Completion notices and Monitor updates both anchor the response they woke.
  monitorNotification?: {
    taskId: string;
    name: string;
    output: string;
    outcome: "updated" | "completed" | "failed" | "stopped";
  };
  backgroundTaskCompletion?: WorkLogBackgroundTaskCompletion;
  // One background task for its whole life: the row sits where the agent
  // launched it and its status updates in place (running, finished, failed,
  // stopped) instead of adding a row per lifecycle event.
  backgroundTask?: WorkLogBackgroundTask;
  // A subagent's own progress, reported to the thread that launched it. It is
  // that subagent's current step, never the launcher's reasoning.
  subagentProgress?: WorkLogSubagentProgress;
  // Computer-control denial rows render as an actionable card (enable control
  // and retry) instead of a plain error line; carry just what that card needs.
  computerControlDenied?: WorkLogComputerControlDenied;
  computerSetupRequired?: WorkLogComputerSetupRequired;
  // An agent's private secret request. A pending one (no `outcome`) renders the
  // masked input card; a settled one is a one-line result.
  secretRequest?: SecretRequestActivityPayload;
  providerContextLifecycle?: ProviderContextLifecycleInfo;
  providerHandoff?: ProviderHandoffInfo;
  /** Durable terminal feedback; session readiness never clears a failed turn. */
  turnFailure?: { cause: string; message: string; errorCode?: string };
  // An answered agent question, paired with the answers the user submitted. It
  // renders as a question/answer exchange that stays visible outside the
  // collapsed turn instead of as two bare "User input" log lines.
  userInputExchange?: ReadonlyArray<WorkLogUserInputExchangeItem>;
  inlineVisual?: InlineVisualActivityPayload;
  codexNotice?: WorkLogCodexNotice;
  // Source activity kind, kept so the timeline can pick a kind-specific icon
  // (e.g. user-input.requested -> question glyph) instead of the generic
  // tone fallback. Same rationale as `toolName` below.
  activityKind?: OrchestrationThreadActivity["kind"];
  // Provider-native event type carried through the activity payload (e.g.
  // "background_tasks_changed") so the timeline can pick a specific icon.
  nativeEventType?: string;
  /** Codex compaction provenance; compatibility rows stay diagnostic-only. */
  compactionSource?: "manual" | "automatic" | "compatibility";
  /** Optional Codex compaction mode used to choose the exact transcript copy. */
  compactionMode?: "manual" | "automatic" | "work";
  /** Typed provider reroute metadata; only high-risk reroutes reach the transcript. */
  modelRerouted?: WorkLogModelRerouted;
  /** Latest complete checklist snapshot for a `turn.tasks.updated` activity. */
  taskList?: ReadonlyArray<TaskListTaskSnapshot>;
  /** A page the agent's `html_render` call published, shown inline where it was published. */
  htmlRender?: HtmlRenderReference;
  /** Typed Codex generated-image lifecycle state. Never infer this from copy. */
  generatedImage?: WorkLogGeneratedImage;
  /** Typed Codex stream-retry state. Never infer retry progress from copy. */
  streamRetry?: WorkLogStreamRetry;
  /** Typed failed-turn system error. Generic payload text never fills this field. */
  systemError?: WorkLogSystemError;
  /** Typed, bounded native MCP invocation/result. Generic payloads never fill this field. */
  mcpToolResult?: WorkLogMcpToolResult;
  /**
   * Automatic approval reviews targeting this entry's toolCallId (commands) or
   * composed onto mcpToolResult for MCP rows. Never inferred from copy.
   */
  automaticApprovalReviews?: ReadonlyArray<WorkLogAutomaticApprovalReview>;
  /**
   * True only when the provider item status is declined (CHIP tTr/qf left side).
   * Distinct from cancelled/interrupted so Sx can emit auto-review-declined copy.
   */
  declinedByProvider?: boolean;
}

export type WorkLogStreamRetry = RuntimeWarningStreamRetryPayload;

export interface WorkLogSystemError {
  provider: ProviderKind;
  providerInstanceId?: ProviderInstanceId;
  content?: string;
  errorInfo?: RuntimeCodexErrorInfo;
}

export type WorkLogGeneratedImage =
  | {
      state: "completed";
      path: string;
      callId?: string;
    }
  | {
      state: "pending";
      callId?: string;
    }
  | {
      state: "failed";
      callId: string;
    };

export type ModelReroutedReason = "highRiskCyberActivity";

export interface WorkLogModelRerouted {
  fromModel: string;
  toModel: string;
  reason: ModelReroutedReason;
}

export interface WorkLogUserInputExchangeItem {
  id: string;
  header: string;
  question: string;
  options: ReadonlyArray<string>;
  answer: string | null;
}

export type WorkLogLiveActivityState =
  | "starting"
  | "thinking"
  | "running_tool"
  | "waiting"
  | "streaming"
  | "completed"
  | "failed"
  | "cancelled";

export interface WorkLogLiveActivity {
  state: WorkLogLiveActivityState;
  label: string;
  startedAt?: string;
  lastActivityAt: string;
  detail?: string;
  progress?: number;
  elapsedSeconds?: number;
}

// Created-automation rows render as a dedicated card (icon + name + cadence + Open)
// instead of a plain tool-call line, so carry just the fields that card needs.
export interface WorkLogAutomation {
  id: string;
  name: string;
  cadenceLabel: string;
  proposalState?: "pending" | "accepted" | "dismissed";
}

export interface WorkLogComputerControlDenied {
  toolName: string | null;
}

export interface WorkLogMossCreatedThread {
  threadId: string;
  title: string;
  provider: ProviderKind;
  model: string;
  environment: "local" | "worktree";
  status: string;
}

export interface WorkLogMossThreadCreation {
  operationId: string;
  requestedCount: number;
  createdCount: number;
  threads: ReadonlyArray<WorkLogMossCreatedThread>;
}

// Canonical wire name kept on the Moss alias from the upstream rebrand.

export interface WorkLogMossWorkerNoticeThread {
  threadId: string;
  title: string;
  outcome: string | null;
  result: string | null;
  pr: string | null;
  /** Owning group project — the needs-you actions resolve against it. */
  projectId: string | null;
}

export interface WorkLogBackgroundTaskCompletion {
  taskId: string;
  taskType: string | null;
  description: string | null;
  // How the task ended; absent on completions derived before outcomes existed.
  outcome?: WorkLogBackgroundTaskOutcome;
}

export type WorkLogBackgroundTaskOutcome = "finished" | "failed" | "stopped";

export interface WorkLogBackgroundTask {
  taskId: string;
  taskType: string | null;
  description: string | null;
  // The command that runs in the background, from the launching tool call.
  command: string | null;
  status: "running" | WorkLogBackgroundTaskOutcome;
  startedAt: string;
  completedAt: string | null;
  exitCode: number | null;
}

export interface WorkLogSubagentProgress {
  /** The spawning tool call id: the subagent's provider thread id. */
  toolUseId: string;
  /** First progress activity in this invocation, stable across parent turns. */
  invocationId?: string;
  title: string | null;
  /** The subagent's final state, once it ended. */
  outcome?: "completed" | "failed" | "stopped";
}

export interface WorkLogMossWorkerNotice {
  kind: "settled" | "stuck" | "needs-you" | "rollup";
  marker: string | null;
  phrase: string | null;
  threads: ReadonlyArray<WorkLogMossWorkerNoticeThread>;
  /** Moss-native action ids on a needs-you card (retry / stop / open). */
  actions?: ReadonlyArray<"retry" | "stop" | "open">;
}

export interface WorkLogSubagent {
  threadId: string;
  providerThreadId?: string | undefined;
  resolvedThreadId?: string | undefined;
  agentId?: string | undefined;
  nickname?: string | undefined;
  role?: string | undefined;
  model?: string | undefined;
  effort?: string | undefined;
  background?: boolean | undefined;
  prompt?: string | undefined;
  rawStatus?: string | undefined;
  latestUpdate?: string | undefined;
  title?: string | undefined;
  statusLabel?: string | undefined;
  isActive?: boolean | undefined;
  /** Canonical lifecycle hint emitted by provider adapters when available. */
  lifecycle?:
    | "creating"
    | "waiting"
    | "running"
    | "backgrounded"
    | "completed"
    | "failed"
    | "interrupted"
    | undefined;
}

/** What the parent's own log says about one subagent of a folded run. */
export interface WorkLogSubagentRunMember {
  /** The subagent's key in `subagents` (its provider thread id). */
  key: string;
  /** When the launching call first named this subagent. */
  launchedAt: string;
  /** The latest step the subagent reported to its launcher. */
  latestStep: string | null;
  /** Final state from the subagent's task completion, once it ended. */
  outcome: "completed" | "failed" | "stopped" | null;
  /** The launching call's own error, when the launch itself failed. */
  failure: string | null;
  /** When a later collab call first reported it finished (Codex "settled"). */
  settledAt: string | null;
  /** A later launch of the same child bounds evidence for this invocation. */
  nextLaunchedAt?: string;
}

export interface WorkLogSubagentRun {
  // Adjacent transcript calls retain their identities for jump and visibility tracking.
  entryIds?: ReadonlyArray<string>;
  members: ReadonlyArray<WorkLogSubagentRunMember>;
}

export interface WorkLogSubagentAction {
  tool: string;
  status: string;
  summaryText: string;
  model?: string | undefined;
  prompt?: string | undefined;
}

interface DerivedWorkLogEntry extends WorkLogEntry {
  activityKind: OrchestrationThreadActivity["kind"];
  collapseKey?: string;
  collapseCommand?: string;
  toolName?: string;
  runtimeWarningRepeatCount?: number;
  runtimeWarningMessage?: string;
  suppressStandaloneCommandStart?: boolean;
}

// Activity objects are immutable values from the store. Keep the expensive
// payload parsing tied to that identity: append-only updates create one new
// activity object while retaining every historical object by reference.
// WeakMap keeps this optimization bounded by the store's own object lifetime.
const publicWorkLogEntryCache = new WeakMap<DerivedWorkLogEntry, WorkLogEntry>();

export function isFileChangeWorkLogEntry(
  workEntry: Pick<WorkLogEntry, "itemType" | "requestKind">,
): boolean {
  return workEntry.requestKind === "file-change" || workEntry.itemType === "file_change";
}

// Composer live chrome should count actual edit work, not bare file-change approvals.
export function isProviderFileEditWorkLogEntry(
  workEntry: Pick<WorkLogEntry, "changedFiles" | "itemType" | "requestKind">,
): boolean {
  if (workEntry.itemType === "file_change") {
    return true;
  }
  return workEntry.requestKind === "file-change" && (workEntry.changedFiles?.length ?? 0) > 0;
}

export type TimelineEntry =
  | {
      id: string;
      kind: "message";
      createdAt: string;
      message: ChatMessage;
    }
  | {
      /**
       * Synthetic local-turn divider emitted when the prepared model differs
       * from the model remembered for an existing conversation. The message id
       * is the durable anchor, so an optimistic row and its server echo share
       * one identity and cannot render twice.
       */
      id: string;
      kind: "model-changed";
      createdAt: string;
      messageId: ChatMessage["id"];
      fromModel: string;
      toModel: string;
      fromModelDisplayName?: string;
      toModelDisplayName?: string;
      status?: "optimistic" | "durable" | "failed";
    }
  | {
      /** Provider-owned reroute divider; only explicit high-risk reasons render. */
      id: string;
      kind: "model-rerouted";
      createdAt: string;
      sequence?: number;
      turnId?: TurnId | null;
      fromModel: string;
      toModel: string;
      reason: ModelReroutedReason;
    }
  | {
      /** Explicit provider failure attached to the anchored local turn. */
      id: string;
      kind: "turn-error";
      createdAt: string;
      messageId: ChatMessage["id"];
      message: string;
    }
  | {
      /** Durable typed terminal provider failure, rendered outside Worked-for. */
      id: string;
      kind: "system-error";
      createdAt: string;
      sequence?: number;
      turnId?: TurnId | null;
      entry: WorkLogEntry;
    }
  | {
      // One slice of a streamed assistant message that had tool calls inside
      // its text span; positioned at the slice's own start time so reasoning
      // interleaves with the tool rows instead of one block above them.
      id: string;
      kind: "message-segment";
      createdAt: string;
      sequence: number;
      message: ChatMessage;
      segmentIndex: number;
    }
  | {
      id: string;
      kind: "proposed-plan";
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      id: string;
      kind: "work";
      createdAt: string;
      sequence?: number;
      entry: WorkLogEntry;
    }
  | {
      /** Context compaction is a transcript primitive, never turn-work. */
      id: string;
      kind: "context-compaction";
      createdAt: string;
      sequence?: number;
      entry: WorkLogEntry;
    }
  | {
      /** A provider checklist snapshot is a compact transcript primitive. */
      id: string;
      kind: "todo-plan";
      createdAt: string;
      sequence?: number;
      turnId?: TurnId | null;
      tasks: ReadonlyArray<TaskListTaskSnapshot>;
    }
  | {
      /** A page an `html_render` call published, shown where the call happened. */
      id: string;
      kind: "html-render";
      createdAt: string;
      sequence?: number;
      turnId?: TurnId | null;
      htmlRender: HtmlRenderReference;
    };

export interface ModelChangeTranscriptRecord {
  readonly id: string;
  readonly messageId: ChatMessage["id"];
  readonly createdAt: string;
  readonly fromModel: string;
  readonly toModel: string;
  readonly fromModelDisplayName?: string;
  readonly toModelDisplayName?: string;
  readonly status: "optimistic" | "durable" | "failed";
  readonly error?: string;
}

const MODEL_CHANGED_ACTIVITY_KIND = "model.changed";
const MODEL_REROUTED_ACTIVITY_KIND = "model.rerouted";
const HIGH_RISK_CYBER_ACTIVITY_REASON: ModelReroutedReason = "highRiskCyberActivity";

/**
 * Model-rerouted transcript copy is gated exclusively by the typed activity.
 * Legacy snapshots only carried the exact reason in payload.detail; keep
 * that narrow fallback for this activity kind and never infer from picker state
 * or a generic error/label.
 */
export function resolveModelReroutedReason(
  activity: Pick<OrchestrationThreadActivity, "kind" | "payload">,
): ModelReroutedReason | null {
  if (activity.kind !== MODEL_REROUTED_ACTIVITY_KIND) {
    return null;
  }
  const payload = asRecord(activity.payload);
  const explicitReason = asTrimmedString(payload?.reason);
  if (explicitReason !== null) {
    return explicitReason === HIGH_RISK_CYBER_ACTIVITY_REASON
      ? HIGH_RISK_CYBER_ACTIVITY_REASON
      : null;
  }
  return payload?.detail === HIGH_RISK_CYBER_ACTIVITY_REASON
    ? HIGH_RISK_CYBER_ACTIVITY_REASON
    : null;
}

/** Model identity intentionally ignores effort/options; Codex only surfaces a model change. */
export function modelSelectionsHaveDifferentModels(
  previousModel: string | null | undefined,
  nextModel: string | null | undefined,
): boolean {
  const previous = previousModel?.trim();
  const next = nextModel?.trim();
  return Boolean(previous && next && previous !== next);
}

/** Existing turns gate the divider; first-turn model/effort choices are silent. */
export function shouldEmitModelChangedTranscript(input: {
  hasExistingConversation: boolean;
  previousModel: string | null | undefined;
  nextModel: string | null | undefined;
}): boolean {
  return (
    input.hasExistingConversation &&
    modelSelectionsHaveDifferentModels(input.previousModel, input.nextModel)
  );
}

/**
 * Stable, message-anchored id used by both optimistic and durable records.
 * Avoid random ids here: retries and hydration must converge to one row.
 */
export function modelChangedTranscriptId(messageId: ChatMessage["id"]): string {
  return `model-changed:${messageId}`;
}

export function mergeModelChangeTranscriptRecords(
  existing: ReadonlyArray<ModelChangeTranscriptRecord>,
  incoming: ReadonlyArray<ModelChangeTranscriptRecord>,
): ModelChangeTranscriptRecord[] {
  const byId = new Map<string, ModelChangeTranscriptRecord>();
  const statusRank = (status: ModelChangeTranscriptRecord["status"]): number =>
    status === "durable" ? 3 : status === "failed" ? 2 : 1;
  for (const record of [...existing, ...incoming]) {
    const canonicalRecord =
      record.id === modelChangedTranscriptId(record.messageId)
        ? record
        : { ...record, id: modelChangedTranscriptId(record.messageId) };
    // The message anchor is the durable identity. A server echo may carry a
    // different event id, but it must still converge with its optimistic row.
    const anchorKey = String(canonicalRecord.messageId);
    const current = byId.get(anchorKey);
    if (!current) {
      byId.set(anchorKey, canonicalRecord);
      continue;
    }
    const createdAtComparison = canonicalRecord.createdAt.localeCompare(current.createdAt);
    const winner =
      createdAtComparison > 0 ||
      (createdAtComparison === 0 &&
        statusRank(canonicalRecord.status) >= statusRank(current.status))
        ? canonicalRecord
        : current;
    const fallback = winner === canonicalRecord ? current : canonicalRecord;
    const merged = {
      ...fallback,
      ...winner,
      ...(winner.fromModelDisplayName || fallback.fromModelDisplayName
        ? { fromModelDisplayName: winner.fromModelDisplayName ?? fallback.fromModelDisplayName }
        : {}),
      ...(winner.toModelDisplayName || fallback.toModelDisplayName
        ? { toModelDisplayName: winner.toModelDisplayName ?? fallback.toModelDisplayName }
        : {}),
    };
    if (winner.status === "failed") {
      const error = winner.error ?? fallback.error;
      byId.set(anchorKey, error === undefined ? merged : { ...merged, error });
      continue;
    }
    const { error: _staleError, ...withoutStaleError } = merged;
    byId.set(anchorKey, withoutStaleError);
  }
  return [...byId.values()].toSorted((left, right) => {
    const createdAt = left.createdAt.localeCompare(right.createdAt);
    return createdAt !== 0 ? createdAt : left.id.localeCompare(right.id);
  });
}

export function deriveDurableModelChangeTranscriptRecords(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ModelChangeTranscriptRecord[] {
  return mergeModelChangeTranscriptRecords(
    [],
    activities.flatMap((activity): ModelChangeTranscriptRecord[] => {
      if (activity.kind !== MODEL_CHANGED_ACTIVITY_KIND) {
        return [];
      }
      const payload = asRecord(activity.payload);
      const messageId =
        asTrimmedString(payload?.anchorMessageId) ?? asTrimmedString(payload?.messageId);
      const fromModel = asTrimmedString(payload?.fromModel);
      const toModel = asTrimmedString(payload?.toModel);
      if (!messageId || !fromModel || !toModel) {
        return [];
      }
      return [
        {
          id: activity.id,
          messageId: messageId as ChatMessage["id"],
          createdAt: activity.createdAt,
          fromModel,
          toModel,
          status: "durable",
        },
      ];
    }),
  );
}

// Routed subagent work (Claude's agent fan-out) belongs to the transcript's
// subagent card and to the child threads themselves, never to plain tool rows.
// The check runs on derived entries rather than raw activities
// because providers stream the tool call first and attach receiver metadata on a
// later lifecycle update that merges into the same entry. Generic OpenCode task
// calls carry no receiver metadata and keep their ordinary chat row.
export function isRoutedSubagentWorkEntry(
  entry: Pick<WorkLogEntry, "itemType" | "subagents" | "subagentAction">,
) {
  if (entry.itemType !== "collab_agent_tool_call") {
    return false;
  }
  if ((entry.subagents?.length ?? 0) > 0) {
    return true;
  }
  // Waiting on, closing, or hearing back from subagents only changes their
  // state, which the card and the child threads already show. Codex sends
  // these without receiver ids, so without this they read as bare "Wait" rows.
  return isSubagentStateOnlyWorkEntry(entry);
}

// A collab call that only reports on subagents already launched (wait, close,
// settled). It may update their state but never launches one.
export function isSubagentStateOnlyWorkEntry(entry: Pick<WorkLogEntry, "subagentAction">): boolean {
  const tool = normalizeCollabIdentifier(entry.subagentAction?.tool ?? null);
  return tool !== null && SUBAGENT_STATE_ONLY_COLLAB_TOOLS.has(tool);
}

const SUBAGENT_STATE_ONLY_COLLAB_TOOLS: ReadonlySet<string> = new Set([
  "wait",
  "waitagent",
  "close",
  "closeagent",
  "subagentsettled",
]);

// Returns the same array when nothing is routed so memoized consumers keep their
// reference identity on the common (no subagents) path.
export function omitRoutedSubagentWorkEntries<Entry extends WorkLogEntry>(
  entries: ReadonlyArray<Entry>,
): ReadonlyArray<Entry> {
  const kept = entries.filter((entry) => !isRoutedSubagentWorkEntry(entry));
  return kept.length === entries.length ? entries : kept;
}

// Codex renders native activity chips and reference-supported actions, but
// excludes wait calls even when they carry no receiver metadata. Unknown routed
// rows stay on the existing composer-strip and child-thread surfaces.
export function selectTranscriptWorkLogEntries<Entry extends WorkLogEntry>(
  entries: ReadonlyArray<Entry>,
): ReadonlyArray<Entry> {
  const kept = entries.filter(
    (entry) =>
      normalizeMultiAgentAction(entry.subagentAction?.tool) !== "waitAgent" &&
      (!isRoutedSubagentWorkEntry(entry) ||
        entry.subagentActivity !== undefined ||
        isTimelineMultiAgentAction(entry.subagentAction?.tool)),
  );
  return kept.length === entries.length ? entries : kept;
}

export function deriveWorkLogEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
  options: {
    visibleTurnIds?: ReadonlySet<TurnId | string>;
    activeTurnId?: TurnId | null;
    activeTurnStartedAt?: string | null;
    latestTurnState?: OrchestrationLatestTurnState | null;
    latestTurnCompletedAt?: string | null;
    pendingInteractions?: ReadonlyArray<OrchestrationPendingInteraction> | undefined;
    authoritativeHasPendingApprovals?: boolean | undefined;
  } = {},
): WorkLogEntry[] {
  const visibleTurnIds = options.visibleTurnIds;
  const ordered = orderedActivities(activities);
  const automaticApprovalReviews = deriveAutomaticApprovalReviewObservations(
    ordered,
    latestTurnId,
    options,
  );
  // Use the same lifecycle/generation replay as the composer. Settled requests
  // disappear instead of leaving an obsolete "Awaiting approval" row after reload.
  const pendingApprovalKeys = derivePendingApprovalRequestKeys(
    ordered,
    options.pendingInteractions,
    latestTurnId !== undefined || options.authoritativeHasPendingApprovals !== undefined
      ? {
          authoritativeHasPending: options.authoritativeHasPendingApprovals,
          latestTurnId,
        }
      : undefined,
  );
  // A settled secret request replaces its pending card: one row per request.
  const settledSecretRequestIds = new Set(
    ordered.flatMap((activity) =>
      activity.kind === SECRET_REQUEST_RESOLVED_ACTIVITY_KIND
        ? [asTrimmedString(asRecord(activity.payload)?.requestId)]
        : [],
    ),
  );
  const entries = ordered
    .filter(
      (activity) =>
        activity.kind !== SECRET_REQUEST_ACTIVITY_KIND ||
        !settledSecretRequestIds.has(asTrimmedString(asRecord(activity.payload)?.requestId)),
    )
    .filter((activity) => {
      // Upstream keeps non-quiet approval.resolved outcomes (declined/cancelled/
      // session-wide grants/computer consent/errors) visible via
      // isQuietApprovalResolutionActivity below; only replay markers are dropped
      // unconditionally here.
      if (activity.kind === "codex.turn.replayed") return false;
      if (activity.kind !== "approval.requested") return true;
      const payload = asRecord(activity.payload);
      const requestId = asTrimmedString(payload?.requestId);
      // Historical Computer consent notices have no interactive request id.
      // Keep these typed facts alongside their resolution; ordinary approval
      // controls still require the current pending request/generation below.
      if (
        requestId === null &&
        (payload?.approvalScope === "computer-task" ||
          payload?.approvalScope === "computer-foreground") &&
        computerToolName(extractToolName(payload)) !== null
      )
        return true;
      const generation = asTrimmedString(payload?.lifecycleGeneration) ?? undefined;
      return (
        requestId !== null &&
        pendingApprovalKeys.has(pendingRequestInstanceKey(requestId, generation))
      );
    })
    // Moss's typed system-error row (provider quota/gateway failures) wins over
    // the generic turn-failure row; those activities stay in the pipeline.
    .filter(
      (activity) =>
        !isTurnFailureActivity(activity) ||
        parseWorkLogSystemError(activity, asRecord(activity.payload)) !== undefined ||
        parseWorkLogUsageNotice(asRecord(activity.payload)) !== undefined,
    )
    .filter((activity) => !isProviderRetryWorkingActivity(activity))
    .filter((activity) => shouldKeepActivityForWorkLog(activity, latestTurnId, visibleTurnIds))
    .filter((activity) => activity.kind !== AUTOMATIC_APPROVAL_REVIEW_ACTIVITY_KIND)
    .filter(
      (activity) =>
        activity.kind !== "task.started" &&
        activity.kind !== "task.updated" &&
        activity.kind !== "task.completed",
    )
    .filter((activity) => !isQuietTurnLifecycleActivity(activity))
    .filter((activity) => !isQuietApprovalResolutionActivity(activity))
    .filter((activity) => activity.kind !== "account.rate-limits.updated")
    .filter(
      (activity) =>
        activity.kind !== "context-window.updated" && activity.kind !== "context-window.configured",
    )
    .filter((activity) => activity.kind !== FAST_MODE_STATE_ACTIVITY_KIND)
    .filter((activity) => activity.summary !== "Checkpoint captured")
    // Server-side Studio output attribution is environment-panel data, not transcript work.
    .filter((activity) => activity.kind !== STUDIO_OUTPUTS_ACTIVITY_KIND)
    .filter((activity) => !isPlanBoundaryToolActivity(activity))
    .map(toDerivedWorkLogEntry)
    .filter(
      (entry) =>
        (entry.activityKind !== INLINE_VISUAL_ACTIVITY_KIND &&
          entry.activityKind !== INLINE_VISUAL_ACTIVITY_KIND_UPSTREAM_ALIAS) ||
        entry.inlineVisual !== undefined,
    );
  const userInputExchangeEntries = withUserInputExchanges(entries, ordered);
  // Strip the derivation-only helpers that exist solely on DerivedWorkLogEntry.
  // `toolName` and `activityKind` are intentionally kept: they are public
  // WorkLogEntry fields that the timeline relies on to pick the right icon (e.g.
  // file-read tools like Claude's `Read` -> search icon, GitHub MCP rows ->
  // GitHub icon, user-input rows -> question / submit glyphs). Stripping
  // `toolName` here previously made those icon checks dead code, leaving the
  // generic wrench.
  const collapsedEntries = attachAutomaticApprovalReviews(
    collapseDerivedWorkLogEntries(userInputExchangeEntries),
    automaticApprovalReviews,
  );
  const derived = reconcileSettledLiveActivities(collapsedEntries, ordered, latestTurnId, options)
    .filter((entry) => !isUninformativeCommandStartEntry(entry))
    .filter((entry) => isRenderableGeneratedImageEntry(entry, options));
  // The page is a first-class timeline item, while the tool call remains in
  // the turn's settled-work disclosure. This matches T3: readers can inspect
  // the work that produced a visual without duplicating the page itself.
  const rendered = derived
    .map(toCachedPublicWorkLogEntry)
    .map((entry) => settleOrphanedSecretRequest(entry, latestTurnId, options.latestTurnState));
  const completions = deriveBackgroundTaskCompletionEntries(ordered, latestTurnId, visibleTurnIds);
  const noticesByActivityId = deriveHandoffFastModeNotices(ordered);
  const withNotices = rendered.map((entry) => {
    const notices = noticesByActivityId.get(entry.id);
    return entry.providerHandoff && notices
      ? { ...entry, providerHandoff: { ...entry.providerHandoff, ...notices } }
      : entry;
  });
  return [
    ...withBackgroundTaskRows(withSubagentProgressOutcomes(withNotices, ordered), ordered),
    ...completions,
    ...deriveTurnFailureEntries(ordered),
  ];
}

interface AutomaticApprovalReviewObservation {
  readonly review: WorkLogAutomaticApprovalReview;
  readonly turnId: TurnId | null;
}

function isTerminalAutomaticApprovalReview(review: WorkLogAutomaticApprovalReview): boolean {
  return review.status !== "inProgress";
}

function interruptedReviewTurnIds(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
  options: {
    activeTurnId?: TurnId | null;
    latestTurnState?: OrchestrationLatestTurnState | null;
  },
): ReadonlySet<TurnId | string> {
  const interrupted = new Set<TurnId | string>();
  for (const activity of activities) {
    if (activity.turnId === null) {
      continue;
    }
    if (activity.kind === "turn.aborted") {
      interrupted.add(activity.turnId);
      continue;
    }
    if (activity.kind !== "turn.completed") {
      continue;
    }
    const payload = asRecord(activity.payload);
    const state = asTrimmedString(payload?.state)?.toLowerCase();
    if (state === "interrupted" || state === "cancelled" || state === "canceled") {
      interrupted.add(activity.turnId);
    }
  }
  if (options.latestTurnState === "interrupted") {
    if (options.activeTurnId !== undefined && options.activeTurnId !== null) {
      interrupted.add(options.activeTurnId);
    }
    if (latestTurnId !== undefined) {
      interrupted.add(latestTurnId);
    }
  }
  return interrupted;
}

function mergeAutomaticApprovalReviewObservation(
  previous: AutomaticApprovalReviewObservation,
  next: AutomaticApprovalReviewObservation,
): AutomaticApprovalReviewObservation {
  // Replayed progress must never erase an already-observed terminal state.
  if (isTerminalAutomaticApprovalReview(previous.review) && next.review.status === "inProgress") {
    return previous;
  }
  return {
    turnId: previous.turnId,
    review: {
      ...next.review,
      reviewId: previous.review.reviewId,
      startedAtMs: previous.review.startedAtMs,
    },
  };
}

function deriveAutomaticApprovalReviewObservations(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
  options: {
    visibleTurnIds?: ReadonlySet<TurnId | string>;
    activeTurnId?: TurnId | null;
    latestTurnState?: OrchestrationLatestTurnState | null;
  },
): ReadonlyArray<AutomaticApprovalReviewObservation> {
  const byReviewId = new Map<string, AutomaticApprovalReviewObservation>();
  for (const activity of activities) {
    if (
      activity.kind !== AUTOMATIC_APPROVAL_REVIEW_ACTIVITY_KIND ||
      !shouldKeepActivityForWorkLog(activity, latestTurnId, options.visibleTurnIds)
    ) {
      continue;
    }
    const review = parseWorkLogAutomaticApprovalReview(activity.payload);
    if (!review) {
      continue;
    }
    const observation: AutomaticApprovalReviewObservation = {
      review,
      turnId: activity.turnId,
    };
    const previous = byReviewId.get(review.reviewId);
    // A stable review id is scoped to the owning turn. A lookalike replay from
    // another turn must not update (or attach to) the first turn's review row.
    if (previous && previous.turnId !== observation.turnId) {
      continue;
    }
    byReviewId.set(
      review.reviewId,
      previous ? mergeAutomaticApprovalReviewObservation(previous, observation) : observation,
    );
  }

  const interruptedTurns = interruptedReviewTurnIds(activities, latestTurnId, options);
  return [...byReviewId.values()].map((observation) => {
    if (
      observation.review.status === "inProgress" &&
      observation.turnId !== null &&
      interruptedTurns.has(observation.turnId)
    ) {
      return {
        ...observation,
        review: { ...observation.review, status: "aborted" },
      };
    }
    return observation;
  });
}

function reviewsForTarget(
  observations: ReadonlyArray<AutomaticApprovalReviewObservation>,
  turnId: DerivedWorkLogEntry["turnId"],
  targetItemId: string | undefined,
): WorkLogAutomaticApprovalReview[] {
  if (turnId === undefined || turnId === null || !targetItemId) {
    return [];
  }
  return observations
    .filter(
      (observation) =>
        observation.turnId !== null &&
        observation.turnId === turnId &&
        observation.review.targetItemId !== null &&
        observation.review.targetItemId === targetItemId,
    )
    .map((observation) => observation.review);
}

function attachAutomaticApprovalReviews(
  entries: ReadonlyArray<DerivedWorkLogEntry>,
  observations: ReadonlyArray<AutomaticApprovalReviewObservation>,
): DerivedWorkLogEntry[] {
  if (observations.length === 0) {
    return [...entries];
  }
  return entries.map((entry) => {
    const mcpToolResult = entry.mcpToolResult;
    if (mcpToolResult) {
      const reviews = reviewsForTarget(observations, entry.turnId, mcpToolResult.callId);
      if (reviews.length === 0) {
        return entry;
      }
      const composedResult: WorkLogMcpToolResult = {
        ...mcpToolResult,
        automaticApprovalReviews: reviews,
      };
      return {
        ...entry,
        mcpToolResult: composedResult,
        automaticApprovalReviews: reviews,
      };
    }

    const isCommandRow = entry.itemType === "command_execution" || entry.requestKind === "command";
    if (!isCommandRow || !entry.toolCallId) {
      return entry;
    }
    const reviews = reviewsForTarget(observations, entry.turnId, entry.toolCallId);
    if (reviews.length === 0) {
      return entry;
    }
    return {
      ...entry,
      automaticApprovalReviews: reviews,
    };
  });
}

/** CHIP tTr/qf: declined status + at least one denied automatic approval review. */
export function wasDeclinedByAutoReview(
  entry: Pick<WorkLogEntry, "declinedByProvider" | "automaticApprovalReviews" | "mcpToolResult">,
): boolean {
  const reviews =
    entry.automaticApprovalReviews ?? entry.mcpToolResult?.automaticApprovalReviews ?? [];
  return entry.declinedByProvider === true && reviews.some((review) => review.status === "denied");
}

function isRenderableGeneratedImageEntry(
  entry: DerivedWorkLogEntry,
  options: {
    activeTurnId?: TurnId | null;
    latestTurnState?: OrchestrationLatestTurnState | null;
  },
): boolean {
  if (entry.generatedImage?.state !== "pending") {
    return true;
  }
  // Pending image UI is intentionally ephemeral. A hydrated/replayed activity
  // is not enough to keep a spinner alive: only the currently running turn may
  // expose an image with no artifact path yet.
  return (
    options.activeTurnId !== undefined &&
    options.activeTurnId !== null &&
    entry.toolStatus === "running" &&
    (options.latestTurnState === undefined ||
      options.latestTurnState === null ||
      options.latestTurnState === "running") &&
    entry.turnId === options.activeTurnId
  );
}

function toCachedPublicWorkLogEntry(entry: DerivedWorkLogEntry): WorkLogEntry {
  const cached = publicWorkLogEntryCache.get(entry);
  if (cached) {
    return cached;
  }
  const {
    collapseCommand: _collapseCommand,
    collapseKey: _collapseKey,
    runtimeWarningMessage: _runtimeWarningMessage,
    runtimeWarningRepeatCount: _runtimeWarningRepeatCount,
    suppressStandaloneCommandStart: _suppressStandaloneCommandStart,
    ...publicEntry
  } = entry;
  publicWorkLogEntryCache.set(entry, publicEntry);
  return publicEntry;
}

export function isLegacyAutomaticDynamicToolApprovalActivity(
  activity: OrchestrationThreadActivity,
): boolean {
  if (activity.kind !== "approval.requested" && activity.kind !== "approval.resolved") {
    return false;
  }
  const payload = asRecord(activity.payload);
  return (
    payload?.requestType === "dynamic_tool_call" && asTrimmedString(payload.requestId) === null
  );
}

function isTurnFailureActivity(activity: OrchestrationThreadActivity): boolean {
  return (
    activity.turnId !== null &&
    (activity.kind === "runtime.error" ||
      (activity.kind === "turn.completed" &&
        (asRecord(activity.payload)?.state === "failed" || activity.tone === "error")))
  );
}

/** Live retry notices only update the working indicator; they must not stack transcript rows. */
function isProviderRetryWorkingActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "runtime.warning") return false;
  const payload = asRecord(activity.payload);
  return payload?.willRetry === true || asRecord(payload?.data)?.willRetry === true;
}

function deriveTurnFailureEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): WorkLogEntry[] {
  const terminalStates = new Map<string, unknown>();
  for (const activity of activities) {
    if (
      activity.turnId &&
      (activity.kind === "turn.completed" || activity.kind === "turn.aborted")
    ) {
      terminalStates.set(
        activity.turnId,
        activity.kind === "turn.aborted" ? "interrupted" : asRecord(activity.payload)?.state,
      );
    }
  }
  const failures = new Map<string, WorkLogEntry>();
  for (const activity of activities) {
    if (!isTurnFailureActivity(activity)) continue;
    // A typed system-error row already narrates this failure with provider context.
    if (parseWorkLogSystemError(activity, asRecord(activity.payload)) !== undefined) continue;
    if (parseWorkLogUsageNotice(asRecord(activity.payload)) !== undefined) continue;
    const payload = asRecord(activity.payload);
    const terminalState = activity.turnId ? terminalStates.get(activity.turnId) : undefined;
    if (
      terminalState === "completed" ||
      terminalState === "cancelled" ||
      terminalState === "interrupted"
    )
      continue;
    const id = activity.turnId ? `turn-failure:${activity.turnId}` : activity.id;
    const previous = failures.get(id);
    const cause =
      asTrimmedString(payload?.errorMessage) ??
      asTrimmedString(payload?.message) ??
      previous?.turnFailure?.cause ??
      "The provider reported an error.";
    const errorCode = asTrimmedString(payload?.errorCode) ?? previous?.turnFailure?.errorCode;
    const overloaded =
      errorCode === "server_overloaded" || /selected model is at capacity/i.test(cause);
    const message = overloaded
      ? "The task was interrupted because the model is at capacity. Work remains incomplete."
      : `The task was interrupted by a provider error. Work remains incomplete. ${cause}`;
    failures.set(id, {
      id,
      createdAt: previous?.createdAt ?? activity.createdAt,
      ...(previous?.sequence !== undefined
        ? { sequence: previous.sequence }
        : withProviderSequence(activity)),
      ...(activity.turnId ? { turnId: activity.turnId } : {}),
      tone: "error",
      label: "Task interrupted",
      activityKind: activity.kind,
      turnFailure: { cause, message, ...(errorCode ? { errorCode } : {}) },
    });
  }
  return [...failures.values()];
}

// Completions of tasks a visible "Moved to background" notice announced. They
// bypass the turn filter once the notice that launched them is visible, and
// belong to the turn that launched the task: a completion can arrive after the
// user already started another turn (a stopped turn's subagents report late).
function deriveBackgroundTaskCompletionEntries(
  ordered: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
  visibleTurnIds: ReadonlySet<TurnId | string> | undefined,
): WorkLogEntry[] {
  const backgroundTasks = new Map<
    string,
    { taskType: string | null; description: string | null; turnId: TurnId | null }
  >();
  const completions: WorkLogEntry[] = [];
  for (const activity of ordered) {
    const payload = asRecord(activity.payload);
    if (
      activity.kind === "runtime.warning" &&
      payload?.nativeEventType === "background_tasks_changed"
    ) {
      if (!shouldKeepActivityForWorkLog(activity, latestTurnId, visibleTurnIds)) continue;
      const tasks = asRecord(payload.data)?.tasks;
      if (!Array.isArray(tasks)) continue;
      for (const task of tasks) {
        const record = asRecord(task);
        if (typeof record?.task_id !== "string") continue;
        backgroundTasks.set(record.task_id, {
          taskType: typeof record.task_type === "string" ? record.task_type : null,
          description: typeof record.description === "string" ? record.description : null,
          turnId: activity.turnId,
        });
      }
      continue;
    }
    if (activity.kind !== "task.completed" || typeof payload?.taskId !== "string") continue;
    const launched = backgroundTasks.get(payload.taskId);
    if (!launched) continue;
    backgroundTasks.delete(payload.taskId);
    const { turnId: launchTurnId, ...task } = launched;
    const turnId = launchTurnId ?? activity.turnId;
    const noun = task.taskType === "local_agent" ? "Subagent" : "Background task";
    const outcome =
      payload.status === "failed"
        ? "failed"
        : payload.status === "stopped"
          ? "stopped"
          : "finished";
    completions.push({
      id: activity.id,
      createdAt: activity.createdAt,
      ...withProviderSequence(activity),
      ...(turnId ? { turnId } : {}),
      // Status first: a trailing "finished" is trimmed as a tool status word.
      label: task.description ? `${noun} ${outcome}: ${task.description}` : `${noun} ${outcome}`,
      tone: payload.status === "failed" ? "error" : "info",
      activityKind: activity.kind,
      backgroundTaskCompletion: { taskId: payload.taskId, ...task, outcome },
    });
  }
  return completions;
}

export function isCodexRuntimeWarningType(nativeEventType: unknown): boolean {
  return nativeEventType === "codex.guardianWarning" || nativeEventType === "codex.warning";
}

function shouldKeepActivityForWorkLog(
  activity: OrchestrationThreadActivity,
  latestTurnId: TurnId | undefined,
  visibleTurnIds: ReadonlySet<TurnId | string> | undefined,
): boolean {
  // Composer connection and safety-buffering metadata are not transcript work.
  // Neither is checkpoint bookkeeping the user did not ask for: a missing
  // baseline or capture only changes what Undo offers, which Undo itself shows.
  if (
    activity.kind === "provider.session.connection" ||
    activity.kind === "model.safety-buffering.updated" ||
    activity.kind === "model.safety-buffering.retry-requested" ||
    activity.kind === "checkpoint.baseline.skipped" ||
    activity.kind === "checkpoint.capture.failed"
  ) {
    return false;
  }
  // Codex's own auth/model-list/transport retries and config notices persisted
  // before the server routed them to its log. The turn carries the outcome.
  if (activity.kind === "runtime.warning") {
    const message = asTrimmedString(asRecord(activity.payload)?.message);
    if (message !== null && isCodexDiagnosticWarningMessage(message)) return false;
  }
  // Compatibility for activities persisted before the server stopped
  // misclassifying Codex's automatic `item/tool/call` envelope as an approval.
  // These rows have no request id and can never be answered; hide them from
  // the transcript while retaining real dynamic-tool approvals that do.
  if (isLegacyAutomaticDynamicToolApprovalActivity(activity)) {
    return false;
  }

  // Context lifecycle evidence must survive message visibility filters. It is
  // the durable explanation for why a turn may behave differently after reload.
  if (
    activity.kind === PROVIDER_CONTEXT_LIFECYCLE_ACTIVITY_KIND ||
    activity.kind === PROVIDER_HANDOFF_ACTIVITY_KIND ||
    activity.kind === PROVIDER_HANDOFF_FAILED_ACTIVITY_KIND
  ) {
    return true;
  }

  if (activity.kind === MODEL_CHANGED_ACTIVITY_KIND) {
    return false;
  }
  // A published page is part of the agent's reply, visible from the moment it
  // is published, before its turn has a turn-stamped assistant message.
  if (activity.kind === HTML_RENDER_ACTIVITY_KIND) {
    return true;
  }
  if (
    activity.kind === MODEL_REROUTED_ACTIVITY_KIND &&
    resolveModelReroutedReason(activity) !== HIGH_RISK_CYBER_ACTIVITY_REASON
  ) {
    return false;
  }
  if (activity.kind === "context-compaction") {
    const payload = asRecord(activity.payload);
    const source = asTrimmedString(payload?.source);
    if (source === "compatibility") {
      return false;
    }
  }

  if (
    activity.kind === "pull-request.auto-fix.paused" ||
    activity.kind === "pull-request.auto-fix.stopped"
  )
    return true;

  // Authentication can start or finish outside a turn. Keep its latest state
  // visible even when the transcript has turn-scoped assistant messages.
  if (activity.kind === "auth.status") return true;

  // Codex Guardian and hook warnings carry no provider turn id.
  if (
    activity.kind === "runtime.warning" &&
    activity.turnId === null &&
    isCodexRuntimeWarningType(asRecord(activity.payload)?.nativeEventType)
  )
    return true;

  // Compaction is a transcript primitive, not turn work: keep it whether it has no
  // provider turn id or ran as its own turn with no assistant reply (a manual Codex
  // compaction), which the visible-turn filter below would otherwise hide.
  if (activity.kind === "context-compaction") {
    return true;
  }

  // Created-automation milestones are thread-scoped and carry no provider turn id;
  // keep them so the transcript card survives once the thread has turn-stamped messages.
  if (activity.kind === "automation.created") {
    return true;
  }

  // The native subagent cap notice can be budgeted outside any visible turn;
  // it is the only sign that more subagents ran than the thread shows.
  if (activity.kind === "subagent.materialization.capped") {
    return true;
  }

  // Failed Undo can precede a provider turn id, or refer to a turn that Undo
  // rolled out of view. It answers the user's own action, so keep it visible.
  if (activity.kind === CHECKPOINT_REVERT_FAILED_ACTIVITY_KIND) {
    return true;
  }

  // A computer-control denial is the only actionable feedback for a desktop
  // tool call rejected mid-turn; never let turn-visibility filtering hide it.
  if (activity.kind === COMPUTER_SETUP_REQUIRED_ACTIVITY_KIND) {
    return true;
  }
  if (activity.kind === COMPUTER_CONTROL_DENIED_ACTIVITY_KIND) {
    return true;
  }
  // A waiting secret card is the only way to answer the agent blocked on it.
  if (activity.kind === SECRET_REQUEST_ACTIVITY_KIND) {
    return true;
  }

  // Coordinator monitor rows are posted server-side with no turn id; a
  // coordinator conversation is all turns, so the turn filter would hide every
  // settle/stuck/roll-up pill.
  if (
    activity.kind === "moss.worker.settled" ||
    activity.kind === "moss.worker.stuck" ||
    activity.kind === "moss.worker.needs-you" ||
    activity.kind === "moss.workers.settled"
  ) {
    return true;
  }

  // An empty set means the transcript has no turn-stamped assistant messages
  // (e.g. providers that never supply turn ids); fall back to the legacy
  // latest-turn filter instead of hiding the whole work log.
  if (visibleTurnIds && visibleTurnIds.size > 0) {
    return activity.turnId !== null && visibleTurnIds.has(activity.turnId);
  }

  return latestTurnId ? activity.turnId === latestTurnId : true;
}

/**
 * The server closes every card its wait ends, except across a restart, which
 * drops the wait without a word. A card still waiting once its turn is over
 * can only have ended, so it stops offering a form nobody will receive.
 */
function settleOrphanedSecretRequest(
  entry: WorkLogEntry,
  latestTurnId: TurnId | undefined,
  latestTurnState: OrchestrationLatestTurnState | null | undefined,
): WorkLogEntry {
  if (entry.secretRequest === undefined || entry.secretRequest.outcome !== undefined) return entry;
  if (latestTurnState === null || latestTurnState === undefined || !entry.turnId) return entry;
  if (entry.turnId === latestTurnId && latestTurnState === "running") return entry;
  return { ...entry, secretRequest: { ...entry.secretRequest, outcome: "cancelled" } };
}

function isQuietTurnLifecycleActivity(activity: OrchestrationThreadActivity): boolean {
  // Turn starts only record the model for the turn header.
  if (activity.kind === "turn.started" || activity.kind === "turn.stop-requested") {
    return true;
  }
  if (activity.kind !== "turn.completed" && activity.kind !== "turn.aborted") {
    return false;
  }
  // Provider lifecycle rows close internal state; assistant/result text is rendered from messages.
  return activity.tone !== "error";
}

function isQuietApprovalResolutionActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "approval.resolved" || activity.tone === "error") {
    return false;
  }
  // Keep refusals, cancellations and broader grants visible. Only accepted
  // routine requests are noise; Computer/Device consent remains part of the log,
  // including clipboard consent, which has no task scope.
  const payload = asRecord(activity.payload);
  return (
    payload?.decision === "accept" &&
    payload.approvalScope === undefined &&
    computerToolName(extractToolName(payload)) === null
  );
}

function isUninformativeCommandStartEntry(entry: DerivedWorkLogEntry): boolean {
  return entry.activityKind === "tool.started" && entry.suppressStandaloneCommandStart === true;
}

function isPlanBoundaryToolActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "tool.updated" && activity.kind !== "tool.completed") {
    return false;
  }

  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  return (
    typeof payload?.detail === "string" &&
    toolArgumentSummaryToolName(payload.detail) === "ExitPlanMode"
  );
}

const WORK_LOG_STREAM_RETRY_CONTENT_MAX_CHARS = 500;
const WORK_LOG_STREAM_RETRY_DETAILS_MAX_CHARS = 2_000;
const WORK_LOG_STREAM_RETRY_PROGRESS_MAX = 1_000_000;
const WORK_LOG_CODEX_ERROR_INFO_STRINGS = new Set([
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
]);

function boundWorkLogStreamRetryText(value: string, maxChars: number): string {
  const trimmed = value.trim();
  return trimmed.length <= maxChars
    ? trimmed
    : `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function parseWorkLogCodexErrorInfo(value: unknown): RuntimeCodexErrorInfo | undefined {
  if (typeof value === "string" && WORK_LOG_CODEX_ERROR_INFO_STRINGS.has(value)) {
    return value as RuntimeCodexErrorInfo;
  }
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const variants = [
    "httpConnectionFailed",
    "responseStreamConnectionFailed",
    "responseStreamDisconnected",
    "responseTooManyFailedAttempts",
  ] as const;
  for (const variant of variants) {
    if (!(variant in record)) {
      continue;
    }
    const detail = asRecord(record[variant]);
    const rawStatus = detail?.httpStatusCode;
    const status =
      rawStatus === null
        ? null
        : typeof rawStatus === "number" &&
            Number.isSafeInteger(rawStatus) &&
            rawStatus >= 0 &&
            rawStatus <= 65_535
          ? rawStatus
          : undefined;
    const projectedDetail = status === undefined ? {} : { httpStatusCode: status };
    switch (variant) {
      case "httpConnectionFailed":
        return { httpConnectionFailed: projectedDetail };
      case "responseStreamConnectionFailed":
        return { responseStreamConnectionFailed: projectedDetail };
      case "responseStreamDisconnected":
        return { responseStreamDisconnected: projectedDetail };
      case "responseTooManyFailedAttempts":
        return { responseTooManyFailedAttempts: projectedDetail };
    }
  }
  const activeTurnNotSteerable = asRecord(record.activeTurnNotSteerable);
  const turnKind = activeTurnNotSteerable?.turnKind;
  if (turnKind === "review" || turnKind === "compact") {
    return { activeTurnNotSteerable: { turnKind } };
  }
  return undefined;
}

function parseWorkLogStreamRetryCount(value: unknown, requirePositive: boolean): number | null {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < (requirePositive ? 1 : 0) ||
    value > WORK_LOG_STREAM_RETRY_PROGRESS_MAX
  ) {
    return null;
  }
  return value;
}

function parseWorkLogStreamRetry(
  payload: Record<string, unknown> | null,
): WorkLogStreamRetry | undefined {
  if (!payload) {
    return undefined;
  }
  const data = asRecord(payload.data);
  const candidates = [payload.streamRetry, data?.streamRetry];
  for (const candidate of candidates) {
    const record = asRecord(candidate);
    if (!record) {
      continue;
    }
    const rawContent = asTrimmedString(record.content);
    if (!rawContent) {
      continue;
    }
    const content = boundWorkLogStreamRetryText(
      rawContent,
      WORK_LOG_STREAM_RETRY_CONTENT_MAX_CHARS,
    );
    const errorInfo = parseWorkLogCodexErrorInfo(record.errorInfo);
    const additionalDetailsValue = asTrimmedString(record.additionalDetails);
    const additionalDetails = additionalDetailsValue
      ? boundWorkLogStreamRetryText(additionalDetailsValue, WORK_LOG_STREAM_RETRY_DETAILS_MAX_CHARS)
      : undefined;
    const reconnectAttempt = parseWorkLogStreamRetryCount(record.reconnectAttempt, true);
    const reconnectMaxAttempts = parseWorkLogStreamRetryCount(record.reconnectMaxAttempts, true);
    const hasProgress =
      reconnectAttempt !== null &&
      reconnectMaxAttempts !== null &&
      reconnectAttempt <= reconnectMaxAttempts;
    return {
      content,
      ...(errorInfo ? { errorInfo } : {}),
      ...(additionalDetails ? { additionalDetails } : {}),
      reconnectAttempt: hasProgress ? reconnectAttempt : null,
      reconnectMaxAttempts: hasProgress ? reconnectMaxAttempts : null,
    };
  }
  return undefined;
}

const WORK_LOG_SYSTEM_ERROR_CONTENT_MAX_CHARS = 500;
const WORK_LOG_SYSTEM_ERROR_SECRET_PATTERN =
  /https?:\/\/|(?:authorization|cookie|x-api-key|api[-_ ]?key|bearer|request[-_ ]?id|account[-_ ]?(?:id|email)|(?:token|secret|password)\s*[:=]|(?:sk|pk|rk|sess|req|acct)_[A-Za-z0-9_-]+)/iu;

function parseSafeSystemErrorContent(value: unknown): string | undefined {
  const raw = asTrimmedString(value);
  if (!raw || WORK_LOG_SYSTEM_ERROR_SECRET_PATTERN.test(raw)) {
    return undefined;
  }
  const normalized = normalizeProviderRuntimeMessage(raw);
  if (WORK_LOG_SYSTEM_ERROR_SECRET_PATTERN.test(normalized)) {
    return undefined;
  }
  return boundWorkLogStreamRetryText(normalized, WORK_LOG_SYSTEM_ERROR_CONTENT_MAX_CHARS);
}

function parseWorkLogProvider(value: unknown): ProviderKind | undefined {
  const provider = asTrimmedString(value);
  if (!provider || !PROVIDER_DESCRIPTORS.some((descriptor) => descriptor.kind === provider)) {
    return undefined;
  }
  return provider as ProviderKind;
}

function parseWorkLogProviderInstanceId(value: unknown): ProviderInstanceId | undefined {
  const instanceId = asTrimmedString(value);
  if (!instanceId || instanceId.length > 64 || !/^[A-Za-z][A-Za-z0-9_-]*$/u.test(instanceId)) {
    return undefined;
  }
  return instanceId as ProviderInstanceId;
}

function parseWorkLogSystemError(
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown> | null,
): WorkLogSystemError | undefined {
  if (
    activity.kind !== "turn.completed" ||
    activity.tone !== "error" ||
    asTrimmedString(payload?.state) !== "failed"
  ) {
    return undefined;
  }
  const provider = parseWorkLogProvider(payload?.provider);
  if (!provider) {
    return undefined;
  }
  const providerInstanceId = parseWorkLogProviderInstanceId(payload?.providerInstanceId);
  const content = parseSafeSystemErrorContent(payload?.errorMessage);
  const errorInfo = parseWorkLogCodexErrorInfo(payload?.errorInfo);
  return {
    provider,
    ...(providerInstanceId ? { providerInstanceId } : {}),
    ...(content ? { content } : {}),
    ...(errorInfo ? { errorInfo } : {}),
  };
}

function extractWorkLogAutomation(
  payload: Record<string, unknown> | null,
): WorkLogAutomation | null {
  if (!payload) {
    return null;
  }
  const id = typeof payload.automationId === "string" ? payload.automationId : null;
  const name = typeof payload.automationName === "string" ? payload.automationName : null;
  if (!id || !name) {
    return null;
  }
  const cadenceLabel = typeof payload.cadenceLabel === "string" ? payload.cadenceLabel : "";
  const proposalState =
    payload.proposalState === "pending" ||
    payload.proposalState === "accepted" ||
    payload.proposalState === "dismissed"
      ? payload.proposalState
      : undefined;
  return {
    id,
    name,
    cadenceLabel,
    ...(proposalState ? { proposalState } : {}),
  };
}

function extractWorkLogMossThreadCreation(
  payload: Record<string, unknown> | null,
): WorkLogMossThreadCreation | null {
  if (!payload) {
    return null;
  }
  const operationId = asTrimmedString(payload.operationId);
  const rawThreads = Array.isArray(payload.threads) ? payload.threads : [];
  if (!operationId || rawThreads.length === 0) {
    return null;
  }
  const threads = rawThreads.flatMap((value): WorkLogMossCreatedThread[] => {
    const thread = asRecord(value);
    const threadId = asTrimmedString(thread?.threadId);
    const title = asTrimmedString(thread?.title);
    const provider = asTrimmedString(thread?.provider);
    const model = asTrimmedString(thread?.model);
    const environment = asTrimmedString(thread?.environment);
    const status = asTrimmedString(thread?.status) ?? "created";
    const providerKind = PROVIDER_DESCRIPTORS.find(
      (descriptor) => descriptor.kind === provider,
    )?.kind;
    if (
      !threadId ||
      !title ||
      !providerKind ||
      !model ||
      (environment !== "local" && environment !== "worktree")
    ) {
      return [];
    }
    return [{ threadId, title, provider: providerKind, model, environment, status }];
  });
  if (threads.length === 0) {
    return null;
  }
  const requestedCount =
    typeof payload.requestedCount === "number" && Number.isInteger(payload.requestedCount)
      ? payload.requestedCount
      : threads.length;
  const createdCount =
    typeof payload.createdCount === "number" && Number.isInteger(payload.createdCount)
      ? payload.createdCount
      : threads.length;
  return { operationId, requestedCount, createdCount, threads };
}

function extractWorkLogMossWorkerNotice(
  payload: Record<string, unknown> | null,
  activityKind: OrchestrationThreadActivity["kind"],
): WorkLogMossWorkerNotice | null {
  if (!payload || payload.source !== "worker_monitor") {
    return null;
  }
  const parseThreads = (values: unknown): WorkLogMossWorkerNoticeThread[] => {
    if (!Array.isArray(values)) {
      return [];
    }
    return values.flatMap((value): WorkLogMossWorkerNoticeThread[] => {
      const thread = asRecord(value);
      const threadId = asTrimmedString(thread?.threadId);
      const title = asTrimmedString(thread?.title);
      if (!threadId || !title) {
        return [];
      }
      return [
        {
          threadId,
          title,
          outcome: asTrimmedString(thread?.outcome) ?? null,
          result: asTrimmedString(thread?.result) ?? null,
          pr: asTrimmedString(thread?.pr) ?? null,
          projectId: asTrimmedString(thread?.projectId) ?? null,
        },
      ];
    });
  };
  if (activityKind === "moss.workers.settled") {
    const threads = parseThreads(payload.threads);
    return threads.length > 0 ? { kind: "rollup", marker: null, phrase: null, threads } : null;
  }
  if (
    activityKind === "moss.worker.settled" ||
    activityKind === "moss.worker.stuck" ||
    activityKind === "moss.worker.needs-you"
  ) {
    const threads = parseThreads([payload.thread]);
    if (threads.length === 0) {
      return null;
    }
    const actions = Array.isArray(payload.actions)
      ? payload.actions.flatMap(
          (action): Array<"retry" | "stop" | "open"> =>
            action === "retry" || action === "stop" || action === "open" ? [action] : [],
        )
      : undefined;
    return {
      kind:
        activityKind === "moss.worker.needs-you"
          ? "needs-you"
          : activityKind === "moss.worker.stuck"
            ? "stuck"
            : "settled",
      marker: asTrimmedString(payload.marker) ?? null,
      phrase: asTrimmedString(payload.phrase) ?? null,
      threads,
      ...(actions ? { actions } : {}),
    };
  }
  return null;
}

export interface TaskListTaskSnapshot {
  task: string;
  status: "pending" | "inProgress" | "completed";
}

// Shared parser for `turn.tasks.updated` payloads. Returns null when the
// payload carries no readable task list (missing/non-array `tasks`, or a
// non-empty list where every entry is malformed); an explicit empty snapshot
// parses to an empty array. Consumed here for transcript rows and by
// session-logic's composer task-list card state.
export function parseTaskListTasks(payload: unknown): TaskListTaskSnapshot[] | null {
  const record =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  const rawTasks = record?.tasks;
  if (!Array.isArray(rawTasks)) {
    return null;
  }
  const tasks = rawTasks
    .map((entry): TaskListTaskSnapshot | null => {
      if (!entry || typeof entry !== "object") return null;
      const taskRecord = entry as Record<string, unknown>;
      if (typeof taskRecord.task !== "string") {
        return null;
      }
      const status =
        taskRecord.status === "completed" || taskRecord.status === "inProgress"
          ? taskRecord.status
          : "pending";
      return { task: taskRecord.task, status };
    })
    .filter((task): task is TaskListTaskSnapshot => task !== null);
  if (rawTasks.length > 0 && tasks.length === 0) {
    return null;
  }
  return tasks;
}

function isProviderContextLifecycleReason(value: unknown): value is ProviderContextLifecycleReason {
  return (
    value === "conversation-rebuilt" ||
    value === "fork-from-earlier-turn" ||
    value === "fresh-session" ||
    value === "native-history-unavailable" ||
    value === "native-resume-failed"
  );
}

function asProviderKind(value: unknown): ProviderKind | undefined {
  return PROVIDER_DESCRIPTORS.find((descriptor) => descriptor.kind === value)?.kind;
}

function asHandoffModelSelection(
  value: unknown,
  fallback: { provider: ProviderKind; model: string },
): ModelSelection {
  if (value && typeof value === "object") {
    const candidate = value as { provider?: unknown; model?: unknown };
    if (candidate.provider === fallback.provider && candidate.model === fallback.model) {
      return value as ModelSelection;
    }
  }
  return fallback as ModelSelection;
}

function extractProviderHandoffInfo(
  payload: Record<string, unknown> | null,
  status: ProviderHandoffInfo["status"],
): ProviderHandoffInfo | null {
  const sourceProvider = asProviderKind(payload?.sourceProvider);
  const targetProvider = asProviderKind(payload?.targetProvider);
  const sourceModel = asTrimmedString(payload?.sourceModel);
  const targetModel = asTrimmedString(payload?.targetModel);
  if (!sourceProvider || !targetProvider || !sourceModel || !targetModel) {
    return null;
  }
  return {
    status,
    sourceProvider,
    sourceModel,
    targetProvider,
    targetModel,
    sourceModelSelection: asHandoffModelSelection(payload?.sourceModelSelection, {
      provider: sourceProvider,
      model: sourceModel,
    }),
    targetModelSelection: asHandoffModelSelection(payload?.targetModelSelection, {
      provider: targetProvider,
      model: targetModel,
    }),
    contextText: asTrimmedString(payload?.contextText),
    failureDetail: asTrimmedString(payload?.detail),
  };
}

function extractProviderContextLifecycleInfo(
  payload: Record<string, unknown> | null,
): ProviderContextLifecycleInfo | null {
  const provider = PROVIDER_DESCRIPTORS.find(
    (descriptor) => descriptor.kind === payload?.provider,
  )?.kind;
  const nativeHistory = payload?.nativeHistory;
  const restartReason = payload?.restartReason;
  const sessionRestarted = payload?.sessionRestarted;
  const recapInjected = payload?.recapInjected;
  const recapCharacters = payload?.recapCharacters;
  const recapPreview = payload?.recapPreview;
  const recapPreviewTruncated = payload?.recapPreviewTruncated;
  if (
    !provider ||
    (nativeHistory !== "available" && nativeHistory !== "unavailable") ||
    !isProviderContextLifecycleReason(restartReason) ||
    typeof sessionRestarted !== "boolean" ||
    typeof recapInjected !== "boolean" ||
    typeof recapCharacters !== "number" ||
    !Number.isInteger(recapCharacters) ||
    recapCharacters < 0 ||
    (recapPreview !== null && typeof recapPreview !== "string") ||
    typeof recapPreviewTruncated !== "boolean"
  ) {
    return null;
  }
  const boundedPreview =
    typeof recapPreview === "string" &&
    recapPreview.length > SESSION_CONTEXT_RECAP_PREVIEW_MAX_CHARS
      ? `…${recapPreview.slice(-(SESSION_CONTEXT_RECAP_PREVIEW_MAX_CHARS - 1)).trimStart()}`
      : recapPreview;
  return {
    provider,
    nativeHistory,
    restartReason,
    sessionRestarted,
    recapInjected,
    recapCharacters,
    recapPreview: boundedPreview,
    recapPreviewTruncated:
      recapPreviewTruncated ||
      (typeof recapPreview === "string" && recapPreview.length > (boundedPreview?.length ?? 0)),
  };
}

// Store activities are immutable. Reuse their pure normalization when a live
// update replaces the containing array; turn filtering and settlement still run
// for each derivation with the current thread context.
export function parseUserInputQuestions(
  payload: Record<string, unknown> | null,
): ReadonlyArray<UserInputQuestion> | null {
  const questions = payload?.questions;
  if (!Array.isArray(questions)) {
    return null;
  }
  const parsed = questions
    .map<UserInputQuestion | null>((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const question = entry as Record<string, unknown>;
      if (
        typeof question.id !== "string" ||
        typeof question.header !== "string" ||
        typeof question.question !== "string" ||
        !Array.isArray(question.options)
      ) {
        return null;
      }
      const options = question.options
        .map<UserInputQuestion["options"][number] | null>((option) => {
          if (!option || typeof option !== "object") return null;
          const optionRecord = option as Record<string, unknown>;
          if (
            typeof optionRecord.label !== "string" ||
            typeof optionRecord.description !== "string"
          ) {
            return null;
          }
          return {
            label: optionRecord.label,
            description: optionRecord.description,
          };
        })
        .filter((option): option is UserInputQuestion["options"][number] => option !== null);
      return {
        id: question.id,
        header: question.header,
        question: question.question,
        options,
        ...(question.multiSelect === true ? { multiSelect: true } : {}),
      };
    })
    .filter((question): question is UserInputQuestion => question !== null);
  return parsed.length > 0 ? parsed : null;
}

// Answers arrive keyed by question id (Codex, Moss UI) or by question text
// (Claude's AskUserQuestion), as a string, a list, or `{ answers: [...] }`.
function formatUserInputAnswer(
  answers: Record<string, unknown> | null,
  question: UserInputQuestion,
): string | null {
  const value = answers?.[question.id] ?? answers?.[question.question];
  const parts =
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value
        : Array.isArray(asRecord(value)?.answers)
          ? (asRecord(value)!.answers as unknown[])
          : [];
  const text = parts
    .filter((part): part is string => typeof part === "string")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(", ");
  return text.length > 0 ? text : null;
}

const userInputExchangeEntryCache = new WeakMap<
  DerivedWorkLogEntry,
  { request: OrchestrationThreadActivity; entry: DerivedWorkLogEntry }
>();

// Replay requests in order so a reused ID cannot pair an old answer with a newer
// question. Only the exact requested row represented by an exchange is removed.
function withUserInputExchanges(
  entries: DerivedWorkLogEntry[],
  ordered: ReadonlyArray<OrchestrationThreadActivity>,
): DerivedWorkLogEntry[] {
  if (!entries.some((entry) => entry.activityKind === "user-input.resolved")) return entries;
  const openRequests = new Map<
    string,
    { request: OrchestrationThreadActivity; questions: ReadonlyArray<UserInputQuestion> }
  >();
  const pairsByResolvedId = new Map<
    string,
    {
      request: OrchestrationThreadActivity;
      questions: ReadonlyArray<UserInputQuestion>;
      answers: Record<string, unknown> | null;
    }
  >();
  for (const activity of ordered) {
    if (activity.kind !== "user-input.requested" && activity.kind !== "user-input.resolved") {
      continue;
    }
    const payload = asRecord(activity.payload);
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
    if (!requestId) continue;
    const generation =
      typeof payload?.lifecycleGeneration === "string" && payload.lifecycleGeneration.length > 0
        ? payload.lifecycleGeneration
        : undefined;
    const key = pendingRequestInstanceKey(requestId, generation);
    if (activity.kind === "user-input.requested") {
      const questions = parseUserInputQuestions(payload);
      // An invalid replacement must not leave an earlier question available to pair.
      openRequests.delete(key);
      if (questions) openRequests.set(key, { request: activity, questions });
    } else {
      const pending = openRequests.get(key);
      if (pending) {
        pairsByResolvedId.set(activity.id, { ...pending, answers: asRecord(payload?.answers) });
        openRequests.delete(key);
      }
    }
  }
  const answeredActivityIds = new Set<string>();
  const withExchanges = entries.map((entry) => {
    if (entry.activityKind !== "user-input.resolved") return entry;
    const pair = pairsByResolvedId.get(entry.id);
    if (!pair) return entry;
    answeredActivityIds.add(pair.request.id);
    const cached = userInputExchangeEntryCache.get(entry);
    if (cached?.request === pair.request) return cached.entry;
    const exchangeEntry: DerivedWorkLogEntry = {
      ...entry,
      userInputExchange: pair.questions.map((question) => ({
        id: question.id,
        header: question.header,
        question: question.question,
        options: question.options.map((option) => option.label),
        answer: formatUserInputAnswer(pair.answers, question),
      })),
    };
    userInputExchangeEntryCache.set(entry, { request: pair.request, entry: exchangeEntry });
    return exchangeEntry;
  });
  return withExchanges.filter((entry) => !answeredActivityIds.has(entry.id));
}

const derivedWorkLogEntryCache = new WeakMap<OrchestrationThreadActivity, DerivedWorkLogEntry>();

// Only provider runtime sequences order transcript rows causally; a fallback
// orchestration event sequence belongs to an unrelated counter.
function withProviderSequence(activity: OrchestrationThreadActivity): { sequence?: number } {
  return activity.sequence !== undefined && activity.sequenceSource !== "orchestration"
    ? { sequence: activity.sequence }
    : {};
}

function toDerivedWorkLogEntry(activity: OrchestrationThreadActivity): DerivedWorkLogEntry {
  const cached = derivedWorkLogEntryCache.get(activity);
  if (cached) {
    return cached;
  }
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  const commandAction = extractPrimaryCommandAction(payload);
  const commandPreview = extractToolCommand(payload, commandAction);
  const changedFiles = extractChangedFiles(payload);
  const title = extractToolTitle(payload);
  const toolName = extractToolName(payload);
  const mcpServer = extractMcpServerName(toolName, payload);
  const toolCallId = extractToolCallId(payload);
  const itemType = extractWorkLogItemType(payload);
  const mcpToolResult = parseWorkLogMcpToolResult(activity.kind, payload, itemType);
  const toolStatus = mcpToolResult
    ? mcpToolResult.status === "failed"
      ? "failed"
      : mcpToolResult.status === "completed"
        ? "completed"
        : "running"
    : deriveToolLifecycleStatus(activity.kind, payload);
  const entry: DerivedWorkLogEntry = {
    id: activity.id,
    createdAt: activity.createdAt,
    ...withProviderSequence(activity),
    ...(activity.turnId !== null ? { turnId: activity.turnId } : {}),
    label: activity.summary,
    tone: activity.tone === "approval" ? "info" : activity.tone,
    activityKind: activity.kind,
    ...(toolName ? { toolName } : {}),
    ...(mcpServer ? { mcpServer } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolStatus ? { toolStatus } : {}),
  };
  const systemError = parseWorkLogSystemError(activity, payload);
  if (systemError) {
    entry.systemError = systemError;
  }
  const modelReroutedReason = resolveModelReroutedReason(activity);
  if (modelReroutedReason) {
    const fromModel = asTrimmedString(payload?.fromModel);
    const toModel = asTrimmedString(payload?.toModel);
    if (fromModel && toModel) {
      entry.modelRerouted = {
        fromModel,
        toModel,
        reason: modelReroutedReason,
      };
    }
  }
  const requestKind = extractWorkLogRequestKind(payload);
  const generatedImage = parseWorkLogGeneratedImage(activity, payload, itemType);
  if (activity.kind === "context-compaction") {
    const source = asTrimmedString(payload?.source);
    if (source === "manual" || source === "automatic" || source === "compatibility") {
      entry.compactionSource = source;
    }
    const mode = asTrimmedString(payload?.mode);
    if (mode === "manual" || mode === "automatic" || mode === "work") {
      entry.compactionMode = mode;
    }
  }
  if (payload && typeof payload.detail === "string" && payload.detail.length > 0) {
    const detail = stripTrailingExitCode(stripTerminalControlSequences(payload.detail)).output;
    if (detail) {
      entry.detail = detail;
    }
  }
  const outputDetail =
    activity.kind === "provider.event.unmapped" ? null : summarizeToolPayloadOutput(payload);
  if (outputDetail && (!entry.detail || toolStatus === "failed")) {
    entry.detail = stripTerminalControlSequences(outputDetail);
  }
  const collabTaskOutputDetail = extractCollabTaskOutputDetail(payload);
  if (collabTaskOutputDetail) {
    entry.detail = stripTerminalControlSequences(collabTaskOutputDetail);
  }
  const nativeEventType =
    payload && typeof payload.nativeEventType === "string" && payload.nativeEventType.length > 0
      ? payload.nativeEventType
      : undefined;
  if (nativeEventType) {
    entry.nativeEventType = nativeEventType;
  }
  const runtimeErrorMessage =
    activity.kind === "runtime.error" && typeof payload?.message === "string"
      ? parseSafeSystemErrorContent(stripTerminalControlSequences(payload.message))
      : undefined;
  if (runtimeErrorMessage && !entry.detail) {
    entry.detail = runtimeErrorMessage;
  }
  const runtimeWarningMessage =
    activity.kind === "runtime.warning" &&
    typeof payload?.message === "string" &&
    payload.message.trim().length > 0
      ? stripTerminalControlSequences(payload.message).trim()
      : undefined;
  if (runtimeWarningMessage) {
    entry.detail = runtimeWarningMessage;
    entry.runtimeWarningMessage = runtimeWarningMessage;
    if (payload?.willRetry === true || asRecord(payload?.data)?.willRetry === true) {
      entry.label = "Provider retrying";
    }
  }
  if (activity.kind === "runtime.warning") {
    const streamRetry = parseWorkLogStreamRetry(payload);
    if (streamRetry) {
      entry.streamRetry = streamRetry;
      entry.codexNotice = { kind: "stream" };
      entry.label = streamRetry.content;
    }
  }
  const usageNotice = parseWorkLogUsageNotice(payload);
  if (usageNotice) {
    entry.codexNotice = usageNotice;
    entry.tone = "error";
    const content = parseSafeSystemErrorContent(payload?.message ?? entry.detail);
    entry.systemError = {
      provider: parseWorkLogProvider(payload) ?? "codex",
      errorInfo: "usageLimitExceeded",
      ...(content ? { content } : {}),
    };
  } else if (isWorkLogSystemError(payload, activity.kind)) {
    entry.codexNotice = { kind: "system" };
  }
  const rawRuntimeErrorMessage =
    activity.kind === "runtime.error" &&
    typeof payload?.message === "string" &&
    payload.message.trim().length > 0
      ? payload.message.trim()
      : undefined;
  const normalizedRuntimeErrorMessage = rawRuntimeErrorMessage
    ? normalizeProviderRuntimeMessage(rawRuntimeErrorMessage)
    : undefined;
  if (
    rawRuntimeErrorMessage &&
    normalizedRuntimeErrorMessage &&
    normalizedRuntimeErrorMessage !== rawRuntimeErrorMessage
  ) {
    // Keep the normalized product copy even when the raw usage-limit
    // diagnostics contain details that the bounded fallback rejected.
    entry.detail = normalizedRuntimeErrorMessage;
  }

  // A Claude Monitor event wakes the agent like a finished background task, so
  // it gets the same standalone row that marks where the new response starts.
  if (activity.kind === "runtime.warning" && nativeEventType === "monitor_event") {
    const taskId = asTrimmedString(asRecord(payload?.data)?.task_id);
    const data = asRecord(payload?.data);
    const outcome =
      data?.outcome === "completed" || data?.outcome === "failed" || data?.outcome === "stopped"
        ? data.outcome
        : "updated";
    const name = asTrimmedString(data?.name) ?? "";
    entry.monitorNotification = {
      taskId: taskId ?? activity.id,
      name,
      output: asTrimmedString(data?.output) ?? runtimeWarningMessage ?? "",
      outcome,
    };
    entry.label = `Monitor${name ? ` · ${name}` : ""} ${outcome === "completed" ? "finished" : outcome}`;
    if (outcome === "failed") entry.tone = "error";
  }
  if (activity.kind === "auth.status") {
    entry.collapseKey = `auth:${asTrimmedString(payload?.provider) ?? "provider"}`;
  }
  if (activity.kind === "task.progress") {
    const subagentToolUseId = asTrimmedString(payload?.toolUseId);
    if (subagentToolUseId) {
      entry.subagentProgress = {
        toolUseId: subagentToolUseId,
        title: asTrimmedString(payload?.subagentTitle),
      };
    }
  }
  if (activity.kind === "turn.tasks.updated") {
    const tasks = parseTaskListTasks(payload);
    if (tasks) {
      // Keep the cached public entry safe from accidental mutation: checklist
      // snapshots are immutable provider facts, not a caller-owned work array.
      entry.taskList = Object.freeze(tasks.map((task) => Object.freeze({ ...task })));
      if (tasks.length > 0) {
        const completedCount = tasks.filter((task) => task.status === "completed").length;
        entry.label = `${completedCount} out of ${tasks.length} ${pluralize(tasks.length, "task")} completed`;
        const inProgressTask = tasks.find((task) => task.status === "inProgress");
        if (inProgressTask) {
          entry.detail = inProgressTask.task;
        } else {
          delete entry.detail;
        }
      }
    }
    // Providers snapshot the whole checklist on every change, so one row per
    // turn (keep-latest) is the entire task history. Without a turn id there is
    // no safe boundary between separate turns, so keep those snapshots
    // independent instead of collapsing the whole thread into one row.
    if (activity.turnId !== null) {
      entry.collapseKey = `taskList:${activity.turnId}`;
    }
  }
  if (commandPreview.command) {
    entry.command = commandPreview.command;
  }
  if (commandPreview.rawCommand) {
    entry.rawCommand = commandPreview.rawCommand;
  }
  const commandActionDisplay = deriveCommandActionDisplay(commandAction, activity.kind);
  if (commandActionDisplay?.preview) {
    entry.preview = commandActionDisplay.preview;
  }
  const toolSearchQuery = extractToolSearchQuery(payload);
  if (toolSearchQuery) {
    // The provider's heading contains a humanized copy of the query. Keep the
    // original structured query separate so localization can change only the
    // heading and never rewrite underscores or casing in the search terms.
    entry.preview = toolSearchQuery;
  }
  const htmlPageTitle = extractHtmlPageToolTitle(payload, toolName, title);
  if (htmlPageTitle) {
    // Grok's transport label ends in `— source file: mcp-render.json`. That is
    // useful diagnostics, but not the page readers just saw. Prefer the
    // agent-supplied title whenever the HTML tool payload includes one.
    entry.preview = htmlPageTitle;
  }
  if (changedFiles.length > 0) {
    entry.changedFiles = changedFiles;
    const item = asRecord(asRecord(payload?.data)?.item);
    const changes = item?.changes;
    const kinds: Record<string, "add" | "delete" | "update"> = {};
    if (Array.isArray(changes)) {
      for (const value of changes) {
        const change = asRecord(value);
        const kindRaw =
          typeof change?.kind === "string"
            ? change.kind
            : typeof change?.type === "string"
              ? change.type
              : asRecord(change?.kind)?.type;
        const kind = kindRaw === "create" ? "add" : kindRaw;
        if (
          typeof change?.path === "string" &&
          (kind === "add" || kind === "delete" || kind === "update")
        )
          kinds[change.path] = kind;
      }
    } else {
      const changeMap = asRecord(changes);
      if (changeMap) {
        for (const [path, value] of Object.entries(changeMap)) {
          if (!isLikelyFilePath(path)) continue;
          const change = asRecord(value);
          const kindRaw =
            typeof change?.type === "string"
              ? change.type
              : typeof change?.kind === "string"
                ? change.kind
                : undefined;
          const kind = kindRaw === "create" ? "add" : kindRaw;
          if (kind === "add" || kind === "delete" || kind === "update") {
            kinds[path] = kind;
          }
        }
      }
    }
    if (Object.keys(kinds).length) entry.fileChangeKinds = kinds;
  }
  if (itemType) {
    entry.itemType = itemType;
  }
  if (generatedImage) {
    entry.generatedImage = generatedImage;
  }
  if (mcpToolResult) {
    entry.mcpToolResult = mcpToolResult;
    entry.toolName = `mcp__${mcpToolResult.server}__${mcpToolResult.tool}`;
    entry.toolCallId = mcpToolResult.callId;
    // Imported/replayed activities often retain the generic native summary.
    // Promote the typed MCP identity (and, for js, its concise invocation title)
    // into both public title fields so all consumers agree with the native UI.
    const invocationTitle = codexMcpInvocationTitle(mcpToolResult.tool, mcpToolResult.arguments);
    const sourceTitle =
      invocationTitle ??
      deriveReadableToolTitle({
        fallbackLabel: "",
        itemType: "mcp_tool_call",
        payload: { data: mcpToolResult },
      });
    if (sourceTitle) {
      entry.label = sourceTitle;
      entry.toolTitle = sourceTitle;
    }
  }
  if (requestKind) {
    entry.requestKind = requestKind;
  }
  if (
    activity.kind === "tool.started" &&
    itemType === "command_execution" &&
    !commandAction &&
    !commandPreview.command &&
    !toolName
  ) {
    entry.suppressStandaloneCommandStart = true;
  }
  const subagents = extractCollabSubagents(payload);
  if (subagents.length > 0) {
    entry.subagents = subagents;
  }
  const subagentAction = extractCollabAction(payload, subagents, toolStatus);
  if (subagentAction) {
    entry.subagentAction = subagentAction;
  }
  const subagentActivity = decodeSubagentActivity(collabPayloadItem(payload));
  if (subagentActivity) entry.subagentActivity = subagentActivity.kind;
  if (activity.kind === "automation.created") {
    const automation = extractWorkLogAutomation(payload);
    if (automation) {
      entry.automation = automation;
    }
  }
  if (
    (activity.kind === INLINE_VISUAL_ACTIVITY_KIND ||
      activity.kind === INLINE_VISUAL_ACTIVITY_KIND_UPSTREAM_ALIAS) &&
    INLINE_VISUALS_ON
  ) {
    const inlineVisual = Option.getOrUndefined(decodeInlineVisualPayload(activity.payload));
    if (inlineVisual) entry.inlineVisual = inlineVisual;
  }
  const htmlRender = htmlRenderFromActivity(activity);
  if (htmlRender) {
    entry.htmlRender = htmlRender;
  }
  if (activity.kind === "moss.threads.created") {
    const mossThreadCreation = extractWorkLogMossThreadCreation(payload);
    if (mossThreadCreation) {
      entry.mossThreadCreation = mossThreadCreation;
    }
  }
  if (
    activity.kind === "moss.worker.settled" ||
    activity.kind === "moss.worker.stuck" ||
    activity.kind === "moss.worker.needs-you" ||
    activity.kind === "moss.workers.settled"
  ) {
    const notice = extractWorkLogMossWorkerNotice(payload, activity.kind);
    if (notice) {
      entry.mossWorkerNotice = notice;
    }
  }
  if (activity.kind === COMPUTER_SETUP_REQUIRED_ACTIVITY_KIND) {
    const buildSignature = asComputerBuildSignature(payload?.buildSignature);
    const bundleId = asTrimmedString(payload?.bundleId);
    entry.computerSetupRequired = {
      missing: asComputerPermissions(payload?.missing),
      ...(buildSignature ? { buildSignature } : {}),
      ...(bundleId ? { bundleId } : {}),
    };
  }
  if (activity.kind === COMPUTER_CONTROL_DENIED_ACTIVITY_KIND) {
    entry.computerControlDenied = { toolName: asTrimmedString(payload?.toolName) };
  }
  if (
    activity.kind === SECRET_REQUEST_ACTIVITY_KIND ||
    activity.kind === SECRET_REQUEST_RESOLVED_ACTIVITY_KIND
  ) {
    const secretRequest = Option.getOrUndefined(decodeSecretRequestPayload(activity.payload));
    if (secretRequest) entry.secretRequest = secretRequest;
  }
  if (activity.kind === PROVIDER_CONTEXT_LIFECYCLE_ACTIVITY_KIND) {
    const providerContextLifecycle = extractProviderContextLifecycleInfo(payload);
    if (providerContextLifecycle) {
      entry.providerContextLifecycle = providerContextLifecycle;
    }
  }
  if (
    activity.kind === PROVIDER_HANDOFF_ACTIVITY_KIND ||
    activity.kind === PROVIDER_HANDOFF_FAILED_ACTIVITY_KIND
  ) {
    const providerHandoff = extractProviderHandoffInfo(
      payload,
      activity.kind === PROVIDER_HANDOFF_ACTIVITY_KIND ? "completed" : "failed",
    );
    if (providerHandoff) {
      entry.providerHandoff = providerHandoff;
    }
  }
  const computerToolDescription = deriveComputerToolDescription({
    activity,
    payload,
    toolName,
    title: commandActionDisplay?.title ?? title,
  });
  const readableTitle = toolSearchQuery
    ? "Search tools:"
    : (extractCollabActionTitle(payload) ??
      computerToolDescription?.summary ??
      (mcpToolResult
        ? (codexMcpInvocationTitle(mcpToolResult.tool, mcpToolResult.arguments) ?? entry.toolTitle)
        : null) ??
      deriveMossMcpToolTitle({
        toolName,
        title: commandActionDisplay?.title ?? title,
        fallbackLabel: activity.summary,
        status: toolStatus,
      }) ??
      deriveReadableToolTitle({
        title: commandActionDisplay?.title ?? title,
        fallbackLabel: activity.summary,
        itemType,
        requestKind: asTimelineToolRequestKind(requestKind),
        command: commandPreview.command,
        payload,
        isRunning: activity.kind !== "tool.completed",
      }));
  // Task-list rows derive their own progress heading above. The generic
  // activity summary ("Tasks updated") would otherwise become toolTitle and
  // take precedence over that progress label in TimelineWorkEntryRow.
  if (readableTitle && activity.kind !== "turn.tasks.updated") {
    entry.toolTitle = readableTitle;
    if (subagentActivity) {
      entry.label = readableTitle;
    }
  }
  const liveActivity = deriveWorkLogLiveActivity(activity, payload, entry);
  if (liveActivity) {
    entry.liveActivity = liveActivity;
  }
  if (isDeclinedToolLifecyclePayload(payload)) {
    entry.declinedByProvider = true;
  }
  if (
    entry.detail &&
    normalizeToolTextForComparison(entry.detail) ===
      normalizeToolTextForComparison(entry.toolTitle ?? entry.label)
  ) {
    delete entry.detail;
  }
  const toolDetails = deriveWorkLogToolDetails({
    payload,
    itemType,
    requestKind: asTimelineToolRequestKind(requestKind),
    command: entry.command,
    rawCommand: entry.rawCommand,
    detail: entry.detail,
    changedFiles: entry.changedFiles ?? changedFiles,
    label: entry.label,
    toolTitle: entry.toolTitle,
  });
  if (toolDetails) {
    entry.toolDetails = toolDetails;
  }
  const collapseKey =
    deriveProviderRuntimeReconciliationCollapseKey(activity, payload) ??
    deriveToolLifecycleCollapseKey(entry, hasTurnScopedProviderToolCallId(payload));
  if (collapseKey) {
    entry.collapseKey = collapseKey;
  }
  const collapseCommand = deriveToolLifecycleCollapseCommand(entry);
  if (collapseCommand) {
    entry.collapseCommand = collapseCommand;
  }
  derivedWorkLogEntryCache.set(activity, entry);
  return entry;
}

function deriveProviderRuntimeReconciliationCollapseKey(
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown> | null,
): string | undefined {
  if (activity.kind !== "provider.runtime.reconciled") {
    return undefined;
  }
  const provider = asTrimmedString(payload?.provider);
  const action = asTrimmedString(payload?.action);
  const projectedTurnId = asTrimmedString(payload?.projectedTurnId) ?? activity.turnId ?? undefined;
  const runtimeTurnId = asTrimmedString(payload?.runtimeTurnId);
  if (
    !provider ||
    !projectedTurnId ||
    (action !== "settle-interrupted" &&
      action !== "settle-terminal-projection" &&
      action !== "settle-error" &&
      action !== "align-running-turn") ||
    (action === "align-running-turn" && !runtimeTurnId)
  ) {
    return undefined;
  }
  // Session and turn projections converge independently. A single stale turn
  // can therefore be observed first as interrupted, then as terminal or
  // failed. Those settlement actions refine one recovery; a runtime
  // realignment remains distinct because its live turn id identifies separate
  // evidence.
  const operation = action === "align-running-turn" ? action : "settle-running-turn";
  return `provider-runtime-reconcile:${JSON.stringify([
    provider,
    operation,
    projectedTurnId,
    runtimeTurnId ?? null,
  ])}`;
}

function deriveToolLifecycleStatus(
  activityKind: OrchestrationThreadActivity["kind"],
  payload: Record<string, unknown> | null,
): MossMcpToolStatus | undefined {
  if (!isRenderableToolLifecycleActivity(activityKind)) return undefined;
  if (isFailedToolLifecyclePayload(payload)) return "failed";
  if (isCancelledToolLifecyclePayload(payload)) return "cancelled";
  return activityKind === "tool.completed" ? "completed" : "running";
}

function deriveWorkLogLiveActivity(
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown> | null,
  entry: WorkLogEntry,
): WorkLogLiveActivity | undefined {
  if (!isRenderableToolLifecycleActivity(activity.kind)) {
    return undefined;
  }

  const data = asRecord(payload?.data);
  const stateRecord = asRecord(data?.state);
  const rawOutput = asRecord(data?.rawOutput);
  const rawStatus = [payload?.status, data?.status, stateRecord?.status, rawOutput?.status].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  const normalizedStatus = rawStatus?.trim().toLowerCase();
  const state: WorkLogLiveActivityState = isFailedToolLifecyclePayload(payload)
    ? "failed"
    : isCancelledToolLifecyclePayload(payload)
      ? "cancelled"
      : activity.kind === "tool.completed" ||
          (normalizedStatus &&
            ["completed", "complete", "success", "succeeded"].includes(normalizedStatus))
        ? "completed"
        : "running_tool";
  const detail =
    asTrimmedString(data?.summary) ??
    (activity.kind === "tool.updated"
      ? asTrimmedString(payload?.detail)
      : state === "failed" || state === "cancelled"
        ? (entry.detail ?? null)
        : null);
  const progress = deriveWorkLogLiveActivityProgress(payload, data);
  const elapsedSeconds = firstFiniteNumber(payload?.elapsedSeconds, data?.elapsedSeconds);

  return {
    state,
    label: entry.toolTitle ?? entry.label,
    lastActivityAt: activity.createdAt,
    ...(activity.kind === "tool.started" ? { startedAt: activity.createdAt } : {}),
    ...(detail ? { detail } : {}),
    ...(progress !== undefined ? { progress } : {}),
    ...(elapsedSeconds !== undefined ? { elapsedSeconds } : {}),
  };
}

function deriveWorkLogLiveActivityProgress(
  payload: Record<string, unknown> | null,
  data: Record<string, unknown> | null,
): number | undefined {
  const progress = firstFiniteNumber(payload?.progress, data?.progress);
  if (progress !== undefined) {
    return progress;
  }

  const percent = firstFiniteNumber(data?.percent);
  return percent === undefined ? undefined : percent / 100;
}

function isFailedToolLifecyclePayload(payload: Record<string, unknown> | null): boolean {
  const data = asRecord(payload?.data);
  const state = asRecord(data?.state);
  const rawOutput = asRecord(data?.rawOutput);
  const statuses = [payload?.status, data?.status, state?.status, rawOutput?.status];
  if (
    statuses.some(
      (status) =>
        typeof status === "string" && ["error", "failed", "failure"].includes(status.toLowerCase()),
    )
  ) {
    return true;
  }
  return [
    payload?.isError,
    payload?.is_error,
    data?.isError,
    data?.is_error,
    rawOutput?.isError,
    rawOutput?.is_error,
  ].some((flag) => flag === true || flag === 1 || flag === "true");
}

function collectToolLifecycleStatuses(payload: Record<string, unknown> | null): string[] {
  const data = asRecord(payload?.data);
  const state = asRecord(data?.state);
  const rawOutput = asRecord(data?.rawOutput);
  const item = asRecord(data?.item);
  return [payload?.status, data?.status, state?.status, rawOutput?.status, item?.status]
    .filter((status): status is string => typeof status === "string")
    .map((status) => status.trim().toLowerCase());
}

function isDeclinedToolLifecyclePayload(payload: Record<string, unknown> | null): boolean {
  return collectToolLifecycleStatuses(payload).includes("declined");
}

function isCancelledToolLifecyclePayload(payload: Record<string, unknown> | null): boolean {
  return collectToolLifecycleStatuses(payload).some((status) =>
    ["cancelled", "canceled", "declined", "interrupted", "killed", "stopped", "aborted"].includes(
      status,
    ),
  );
}

function summarizeToolPayloadOutput(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  return summarizeToolRawOutput(data?.rawOutput) ?? null;
}

function extractCollabTaskOutputDetail(payload: Record<string, unknown> | null): string | null {
  if (extractWorkLogItemType(payload) !== "collab_agent_tool_call") {
    return null;
  }
  const data = asRecord(payload?.data);
  const item = collabPayloadItem(payload);
  const state = asRecord(data?.state) ?? asRecord(item?.state);
  const candidates = [
    state?.output,
    data?.output,
    item?.output,
    data?.rawOutput,
    data?.result,
    item?.result,
  ];
  for (const candidate of candidates) {
    const normalized = extractCollabTaskText(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function extractCollabActionTitle(payload: Record<string, unknown> | null): string | null {
  if (extractWorkLogItemType(payload) !== "collab_agent_tool_call") {
    return null;
  }
  const item = collabPayloadItem(payload);
  const input = asRecord(item?.input);
  const state = asRecord(item?.state);
  const nickname = asTrimmedString(
    item?.agentNickname ??
      item?.agent_nickname ??
      payload?.agentNickname ??
      payload?.agent_nickname,
  );
  const activityKind = asTrimmedString(item?.kind)?.toLowerCase();
  if (nickname && activityKind) {
    const statusLabel =
      activityKind === "completed"
        ? "finished"
        : activityKind === "started"
          ? "started working"
          : activityKind === "interacted"
            ? "updated"
            : activityKind === "interrupted"
              ? "interrupted"
              : activityKind === "failed"
                ? "failed"
                : null;
    return statusLabel ? `${nickname} ${statusLabel}` : nickname;
  }
  const candidates = [
    state?.title,
    item?.title,
    payload?.title,
    input?.description,
    item?.description,
  ];
  for (const candidate of candidates) {
    const title = asTrimmedString(candidate);
    if (title && !isGenericToolTitle(title)) {
      return title.length > 120 ? `${title.slice(0, 117).trimEnd()}...` : title;
    }
  }
  return null;
}

function extractCollabTaskText(value: unknown): string | null {
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => extractCollabTaskText(entry))
      .filter((entry): entry is string => entry !== null);
    return parts.length > 0 ? parts.join("\n") : null;
  }
  const direct = normalizeCollabTaskOutput(asTrimmedString(value));
  if (direct) {
    return direct;
  }
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  return (
    extractCollabTaskText(record.content) ??
    extractCollabTaskText(record.text) ??
    extractCollabTaskText(record.output) ??
    extractCollabTaskText(record.result)
  );
}

function normalizeCollabTaskOutput(value: string | null): string | null {
  const output = value ? stripTrailingExitCode(value).output : null;
  if (!output) {
    return null;
  }
  const taskResultMatch = /<task_result>\s*([\s\S]*?)\s*<\/task_result>/i.exec(output);
  if (taskResultMatch?.[1]) {
    return taskResultMatch[1].trim() || null;
  }
  const unwrappedTask = output
    .replace(/^<task\b[^>]*>\s*/i, "")
    .replace(/\s*<\/task>\s*$/i, "")
    .trim();
  return (unwrappedTask || output).trim() || null;
}

function collapseDerivedWorkLogEntries(
  entries: ReadonlyArray<DerivedWorkLogEntry>,
): DerivedWorkLogEntry[] {
  const collapsed: DerivedWorkLogEntry[] = [];
  // Tools that carry a unique tool-call id (collapseKey "tool:<id>") merge by that
  // id regardless of position. This is what fixes providers that emit every tool's
  // started event before any of their completed events — Claude's parallel tool
  // calls — which the adjacency-only path below renders as a started row plus a
  // separate completed row. The id is unique per call, so distinct calls of the
  // same tool never merge into each other.
  const stableToolIndexByKey = new Map<string, number>();
  // Older servers included the current observation sequence in recovery ids,
  // so the same repair could be persisted more than once while projections
  // converged. Preserve the first row for each semantic repair and hide only
  // exact repeats; different turns and runtime realignments remain independently
  // visible.
  const seenRuntimeReconciliationKeys = new Set<string>();
  // One failed start is recorded by the session, the start and the rejected
  // turn alike; the reader sees it once.
  let lastFailure: { key: string; at: number } | null = null;
  // Task-list snapshots (collapseKey "taskList:<turnId>") fold into one row per
  // turn: each update replaces the row's content while the row itself stays
  // anchored at the first update's position, so the transcript shows a single
  // progressing checklist row instead of one "Tasks updated" row per snapshot.
  // Authentication uses the same replacement rule for its latest provider state.
  const snapshotIndexByKey = new Map<string, number>();
  for (const entry of entries) {
    const runtimeReconciliationKey = entry.collapseKey?.startsWith("provider-runtime-reconcile:")
      ? entry.collapseKey
      : undefined;
    if (runtimeReconciliationKey !== undefined) {
      if (seenRuntimeReconciliationKeys.has(runtimeReconciliationKey)) {
        continue;
      }
      seenRuntimeReconciliationKeys.add(runtimeReconciliationKey);
    }
    const snapshotKey =
      entry.collapseKey?.startsWith("taskList:") || entry.collapseKey?.startsWith("auth:")
        ? entry.collapseKey
        : undefined;
    if (snapshotKey !== undefined) {
      const existingIndex = snapshotIndexByKey.get(snapshotKey);
      if (existingIndex !== undefined) {
        collapsed[existingIndex] = mergeSnapshotEntries(collapsed[existingIndex]!, entry);
        continue;
      }
      snapshotIndexByKey.set(snapshotKey, collapsed.length);
      collapsed.push(entry);
      continue;
    }
    const failure = repeatedFailureKey(entry);
    if (failure !== null) {
      const at = Date.parse(entry.createdAt);
      if (
        lastFailure !== null &&
        lastFailure.key === failure &&
        Math.abs(at - lastFailure.at) <= REPEATED_FAILURE_WINDOW_MS
      ) {
        continue;
      }
      lastFailure = { key: failure, at };
    }
    const previous = collapsed.at(-1);
    if (previous && shouldCollapseStreamRetryEntries(previous, entry)) {
      collapsed[collapsed.length - 1] = mergeStreamRetryEntries(previous, entry);
      continue;
    }
    if (previous && shouldCollapseRuntimeWarningEntries(previous, entry)) {
      collapsed[collapsed.length - 1] = mergeRuntimeWarningEntries(previous, entry);
      continue;
    }
    if (previous && shouldCollapseContextCompactionEntries(previous, entry)) {
      collapsed[collapsed.length - 1] = mergeDerivedWorkLogEntries(previous, entry);
      continue;
    }
    const stableToolKey =
      (entry.collapseKey?.startsWith("tool:") ||
        entry.collapseKey?.startsWith("image-generation:")) &&
      isRenderableToolLifecycleActivity(entry.activityKind)
        ? entry.collapseKey
        : undefined;
    if (stableToolKey !== undefined) {
      const existingIndex = stableToolIndexByKey.get(stableToolKey);
      if (existingIndex !== undefined) {
        collapsed[existingIndex] = mergeDerivedWorkLogEntries(collapsed[existingIndex]!, entry);
        continue;
      }
    }
    if (previous && shouldCollapseToolLifecycleEntries(previous, entry)) {
      collapsed[collapsed.length - 1] = mergeDerivedWorkLogEntries(previous, entry);
      if (stableToolKey !== undefined) {
        stableToolIndexByKey.set(stableToolKey, collapsed.length - 1);
      }
      continue;
    }
    collapsed.push(entry);
    if (stableToolKey !== undefined) {
      stableToolIndexByKey.set(stableToolKey, collapsed.length - 1);
    }
  }
  return collapsed;
}

/** The adapter's prefix names the provider and thread; the failure is what follows it. */
const PROVIDER_FAILURE_PREFIX =
  /^(?:Error:\s*)?Provider adapter (?:process error|request failed) \([^)]+\) for [^:]+:\s*/u;
const REPEATED_FAILURE_WINDOW_MS = 60_000;

function repeatedFailureKey(entry: DerivedWorkLogEntry): string | null {
  if (
    entry.activityKind !== "runtime.error" &&
    entry.activityKind !== "provider.turn.start.failed"
  ) {
    return null;
  }
  const detail = entry.detail?.trim().replace(PROVIDER_FAILURE_PREFIX, "");
  return detail ? normalizeToolTextForComparison(detail) : null;
}

function shouldCollapseStreamRetryEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): boolean {
  if (
    previous.activityKind !== "runtime.warning" ||
    next.activityKind !== "runtime.warning" ||
    previous.turnId === undefined ||
    previous.turnId === null ||
    previous.turnId !== next.turnId
  ) {
    return false;
  }
  return (
    previous.streamRetry?.reconnectAttempt !== null &&
    previous.streamRetry?.reconnectAttempt !== undefined &&
    previous.streamRetry?.reconnectMaxAttempts !== null &&
    previous.streamRetry?.reconnectMaxAttempts !== undefined &&
    next.streamRetry?.reconnectAttempt !== null &&
    next.streamRetry?.reconnectAttempt !== undefined &&
    next.streamRetry?.reconnectMaxAttempts !== null &&
    next.streamRetry?.reconnectMaxAttempts !== undefined
  );
}

function mergeStreamRetryEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): DerivedWorkLogEntry {
  return {
    ...previous,
    ...next,
    id: previous.id,
    createdAt: previous.createdAt,
  };
}

function shouldCollapseRuntimeWarningEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): boolean {
  if (previous.activityKind !== "runtime.warning" || next.activityKind !== "runtime.warning") {
    return false;
  }
  if (previous.turnId !== next.turnId) {
    return false;
  }
  // Typed Codex stream retries have their own progress-aware replacement rule.
  // In particular, unparsed retry notices must remain separate rather than
  // becoming a misleading generic repeat count.
  if (previous.streamRetry || next.streamRetry) {
    return false;
  }
  return (
    normalizeToolTextForComparison(previous.label) === normalizeToolTextForComparison(next.label) &&
    normalizeToolTextForComparison(
      previous.runtimeWarningMessage ?? previous.detail ?? previous.preview ?? "",
    ) ===
      normalizeToolTextForComparison(
        next.runtimeWarningMessage ?? next.detail ?? next.preview ?? "",
      )
  );
}

function mergeRuntimeWarningEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): DerivedWorkLogEntry {
  const repeatCount = (previous.runtimeWarningRepeatCount ?? 1) + 1;
  const runtimeWarningMessage =
    next.runtimeWarningMessage ??
    previous.runtimeWarningMessage ??
    next.detail ??
    next.preview ??
    previous.detail ??
    previous.preview;
  const repeatPreview = runtimeWarningMessage
    ? `${repeatCount} notices - ${runtimeWarningMessage}`
    : `${repeatCount} notices`;
  return {
    ...previous,
    ...next,
    id: previous.id,
    createdAt: previous.createdAt,
    ...(previous.sequence !== undefined ? { sequence: previous.sequence } : {}),
    runtimeWarningRepeatCount: repeatCount,
    ...(runtimeWarningMessage ? { runtimeWarningMessage } : {}),
    detail: repeatPreview,
    preview: repeatPreview,
  };
}

// Authentication and task-list snapshots supersede earlier content wholesale. Task providers
// resend the full checklist, so keep the newest content while preserving the
// first row's id and createdAt: the id keeps React rows stable across updates
// and the createdAt keeps the row anchored where the checklist first appeared.
// A snapshot without readable tasks (explicit clear, or an unreadable payload)
// carries no progress copy, so it must not overwrite a progressed row with the
// generic "Tasks updated" label — keep the previous row's content instead.
function mergeSnapshotEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): DerivedWorkLogEntry {
  // Task-list rows: an unreadable payload (no taskList field) must not overwrite a
  // progressed row with the generic label; an explicit empty array is a valid
  // provider snapshot and intentionally clears the prior list (Codex compact dot).
  const isTaskListRow = previous.taskList !== undefined || next.taskList !== undefined;
  if (isTaskListRow && next.taskList === undefined) {
    return previous;
  }
  return {
    ...next,
    ...(isTaskListRow && next.taskList?.length === 0 && previous.taskList?.length
      ? { label: previous.label, ...(previous.detail ? { detail: previous.detail } : {}) }
      : {}),
    id: previous.id,
    createdAt: previous.createdAt,
    ...(previous.sequence !== undefined ? { sequence: previous.sequence } : {}),
  };
}

// Ingestion emits compaction progress ("Compacting context") and its
// terminal row ("Context compacted" / "... failed" / "... manually") as separate
// activities; fold the terminal row into the in-progress one so the work log
// shows a single resolving compaction entry instead of a stale spinner row.
const CONTEXT_COMPACTION_COMPLETED_LABEL = "Context compacted";
const CONTEXT_COMPACTION_FAILED_LABEL = "Context compaction failed";
const CONTEXT_COMPACTION_CANCELLED_LABEL = "Context compaction cancelled";

type SettledLiveActivityState = Extract<
  WorkLogLiveActivityState,
  "completed" | "failed" | "cancelled"
>;

function contextCompactionTerminalLabel(
  state: SettledLiveActivityState,
  source?: WorkLogEntry["compactionSource"],
): string {
  if (state === "completed") {
    if (source === "manual") return CONTEXT_COMPACTION_COMPLETED_LABEL;
    if (source === "automatic") return "Context automatically compacted";
    return CONTEXT_COMPACTION_COMPLETED_LABEL;
  }
  if (state === "failed") {
    if (source === "manual") return "Manual context compaction failed";
    if (source === "automatic") return "Automatic context compaction failed";
    return CONTEXT_COMPACTION_FAILED_LABEL;
  }
  return CONTEXT_COMPACTION_CANCELLED_LABEL;
}

function normalizeContextCompactionEntryDisplay(entry: DerivedWorkLogEntry): DerivedWorkLogEntry {
  // Timeline rows prefer toolTitle over label. A settled row reconstructed from
  // an older activity snapshot can therefore keep the progress title even after
  // label has already been reconciled to its terminal wording.
  if (
    entry.activityKind !== "context-compaction" ||
    isContextCompactionProgressLabel(entry.label) ||
    !isContextCompactionProgressLabel(entry.toolTitle)
  ) {
    return entry;
  }
  return { ...entry, toolTitle: entry.label };
}

function settleContextCompactionEntry(
  entry: DerivedWorkLogEntry,
  state: SettledLiveActivityState,
): DerivedWorkLogEntry {
  const label = isContextCompactionProgressLabel(entry.label)
    ? contextCompactionTerminalLabel(state, entry.compactionSource)
    : entry.label;
  const toolTitle =
    entry.activityKind === "context-compaction" && isContextCompactionProgressLabel(entry.toolTitle)
      ? label
      : entry.toolTitle;
  if (label === entry.label && toolTitle === entry.toolTitle) {
    return entry;
  }
  return {
    ...entry,
    label,
    ...(toolTitle ? { toolTitle } : {}),
  };
}

function shouldCollapseContextCompactionEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): boolean {
  if (
    previous.activityKind !== "context-compaction" ||
    next.activityKind !== "context-compaction"
  ) {
    return false;
  }
  // Older Codex sessions reported a requested compaction as a turn-less progress
  // row just before its turn started; the next compaction row continues it.
  if (previous.turnId !== next.turnId && previous.turnId != null) {
    return false;
  }
  // Only merge into a row that is still in progress; a terminal row belongs to
  // an earlier compaction and must not swallow the next one's progress row.
  return isContextCompactionProgressLabel(previous.label);
}

function shouldCollapseToolLifecycleEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): boolean {
  if (!isRenderableToolLifecycleActivity(previous.activityKind)) {
    return false;
  }
  if (!isRenderableToolLifecycleActivity(next.activityKind)) {
    return false;
  }
  if (previous.activityKind === "tool.completed") {
    return false;
  }
  if (previous.suppressStandaloneCommandStart && next.toolCallId === undefined) {
    return false;
  }
  if (previous.collapseKey !== undefined && previous.collapseKey === next.collapseKey) {
    if (previous.collapseKey.startsWith("tool:")) {
      return true;
    }
    if (!areToolLifecycleChangedFilesCompatible(previous.changedFiles, next.changedFiles)) {
      return false;
    }
    return areToolLifecycleCommandsCompatible(previous.collapseCommand, next.collapseCommand);
  }
  return (
    previous.toolCallId !== undefined &&
    next.toolCallId === undefined &&
    previous.itemType === next.itemType &&
    normalizeCompactToolLabel(previous.toolTitle ?? previous.label) ===
      normalizeCompactToolLabel(next.toolTitle ?? next.label) &&
    areToolLifecycleChangedFilesCompatible(previous.changedFiles, next.changedFiles) &&
    areToolLifecycleCommandsCompatible(previous.collapseCommand, next.collapseCommand)
  );
}

function mergeDerivedWorkLogEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): DerivedWorkLogEntry {
  const changedFiles = mergeChangedFiles(previous.changedFiles, next.changedFiles);
  const detail = next.detail ?? previous.detail;
  const command = next.command ?? previous.command;
  const rawCommand = next.rawCommand ?? previous.rawCommand;
  const preview = next.preview ?? previous.preview;
  const toolTitle = mergeWorkLogToolTitle(previous, next);
  const preservePreviousToolSemantics =
    next.activityKind === "tool.updated" &&
    next.itemType === "mcp_tool_call" &&
    previous.itemType !== undefined &&
    previous.itemType !== "mcp_tool_call";
  const itemType = preservePreviousToolSemantics
    ? previous.itemType
    : (next.itemType ?? previous.itemType);
  const requestKind = preservePreviousToolSemantics
    ? previous.requestKind
    : (next.requestKind ?? previous.requestKind);
  const subagents = mergeWorkLogSubagents(previous.subagents, next.subagents);
  const subagentAction = mergeWorkLogSubagentAction(previous.subagentAction, next.subagentAction);
  const mossThreadCreation = next.mossThreadCreation ?? previous.mossThreadCreation;
  const collapseKey = next.collapseKey ?? previous.collapseKey;
  const toolName = next.toolName ?? previous.toolName;
  const mcpServer = next.mcpServer ?? previous.mcpServer;
  const toolCallId = next.toolCallId ?? previous.toolCallId;
  const generatedImage = mergeWorkLogGeneratedImage(previous.generatedImage, next.generatedImage);
  const mcpToolResult = mergeWorkLogMcpToolResult(previous.mcpToolResult, next.mcpToolResult);
  const automaticApprovalReviews =
    next.automaticApprovalReviews ?? previous.automaticApprovalReviews;
  const declinedByProvider =
    previous.declinedByProvider === true || next.declinedByProvider === true ? true : undefined;
  const preservePreviousTerminalState =
    previous.liveActivity !== undefined &&
    !isInProgressLiveActivityState(previous.liveActivity.state) &&
    next.liveActivity !== undefined &&
    isInProgressLiveActivityState(next.liveActivity.state);
  const preservePreviousMcpTerminalState =
    previous.mcpToolResult !== undefined &&
    (previous.mcpToolResult.status === "completed" || previous.mcpToolResult.status === "failed") &&
    next.mcpToolResult?.status === "inProgress";
  const toolStatus =
    preservePreviousTerminalState || preservePreviousMcpTerminalState
      ? previous.toolStatus
      : (next.toolStatus ?? previous.toolStatus);
  const liveActivity = mergeWorkLogLiveActivity(previous.liveActivity, next.liveActivity);
  const toolDetails = mergeWorkLogToolDetails(previous.toolDetails, next.toolDetails);
  const turnId = next.turnId ?? previous.turnId;
  return {
    ...previous,
    ...next,
    id: previous.id,
    createdAt: previous.createdAt,
    ...(previous.sequence !== undefined ? { sequence: previous.sequence } : {}),
    ...(turnId !== undefined ? { turnId } : {}),
    ...(detail ? { detail } : {}),
    ...(command ? { command } : {}),
    ...(rawCommand ? { rawCommand } : {}),
    ...(preview ? { preview } : {}),
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(previous.fileChangeKinds || next.fileChangeKinds
      ? { fileChangeKinds: { ...previous.fileChangeKinds, ...next.fileChangeKinds } }
      : {}),
    ...(toolTitle ? { toolTitle } : {}),
    ...(itemType ? { itemType } : {}),
    ...(requestKind ? { requestKind } : {}),
    ...(subagents ? { subagents } : {}),
    ...(subagentAction ? { subagentAction } : {}),
    ...(mossThreadCreation ? { mossThreadCreation } : {}),
    ...(collapseKey ? { collapseKey } : {}),
    ...(toolName ? { toolName } : {}),
    ...(mcpServer ? { mcpServer } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(generatedImage ? { generatedImage } : {}),
    ...(mcpToolResult ? { mcpToolResult } : {}),
    ...(automaticApprovalReviews ? { automaticApprovalReviews } : {}),
    ...(declinedByProvider ? { declinedByProvider } : {}),
    ...(toolStatus ? { toolStatus } : {}),
    ...(liveActivity ? { liveActivity } : {}),
    ...(toolDetails ? { toolDetails } : {}),
  };
}

function workLogSubagentIdentity(subagent: WorkLogSubagent): string {
  return subagent.providerThreadId ?? subagent.threadId;
}

// Lifecycle completions commonly repeat only receiver ids. Preserve nickname,
// role, model, and prompt from the spawn while taking the latest status fields.
function mergeWorkLogSubagents(
  previous: ReadonlyArray<WorkLogSubagent> | undefined,
  next: ReadonlyArray<WorkLogSubagent> | undefined,
): ReadonlyArray<WorkLogSubagent> | undefined {
  if (!previous) return next;
  if (!next) return previous;

  const merged = new Map(previous.map((subagent) => [workLogSubagentIdentity(subagent), subagent]));
  for (const subagent of next) {
    const key = workLogSubagentIdentity(subagent);
    const earlier = merged.get(key);
    merged.set(key, earlier ? { ...earlier, ...subagent } : subagent);
  }
  return [...merged.values()];
}

function mergeWorkLogSubagentAction(
  previous: WorkLogSubagentAction | undefined,
  next: WorkLogSubagentAction | undefined,
): WorkLogSubagentAction | undefined {
  if (!previous) return next;
  if (!next) return previous;
  const previousStatus = normalizeMultiAgentActionStatus(previous.status);
  const staleProgress =
    previousStatus !== null &&
    previousStatus !== "inProgress" &&
    normalizeMultiAgentActionStatus(next.status) === "inProgress";
  return {
    ...previous,
    ...next,
    // Partial lifecycle updates may omit the action; replayed progress must not
    // restart a settled action's shimmer or disclosure.
    tool: next.tool || previous.tool,
    status: staleProgress ? previous.status : next.status,
    summaryText: next.tool ? next.summaryText : previous.summaryText,
    model: next.model ?? previous.model,
    prompt: next.prompt ?? previous.prompt,
  };
}

function mergeWorkLogMcpToolResult(
  previous: WorkLogMcpToolResult | undefined,
  next: WorkLogMcpToolResult | undefined,
): WorkLogMcpToolResult | undefined {
  if (!previous) return next;
  if (!next) return previous;
  const previousTerminal = previous.status === "completed" || previous.status === "failed";
  const nextTerminal = next.status === "completed" || next.status === "failed";
  // A terminal observation is authoritative. Reconnect/replay can deliver a
  // stale in-progress update after completion, but it must not erase result,
  // error or duration data from the durable row.
  if (previousTerminal && !nextTerminal) return previous;
  return next;
}

function mergeWorkLogGeneratedImage(
  previous: WorkLogGeneratedImage | undefined,
  next: WorkLogGeneratedImage | undefined,
): WorkLogGeneratedImage | undefined {
  // A terminal completion is authoritative. Provider replay can deliver a
  // stale in-progress observation after the artifact, and it must not turn a
  // completed image back into a pending placeholder.
  if (next?.state === "completed") return next;
  if (previous?.state === "completed") return previous;
  if (next?.state === "failed") return next;
  if (previous?.state === "failed") return previous;
  return next ?? previous;
}

function mergeWorkLogLiveActivity(
  previous: WorkLogLiveActivity | undefined,
  next: WorkLogLiveActivity | undefined,
): WorkLogLiveActivity | undefined {
  if (!previous) return next;
  if (!next) return previous;
  if (!isInProgressLiveActivityState(previous.state) && isInProgressLiveActivityState(next.state)) {
    return {
      ...previous,
      ...(next.detail || previous.detail ? { detail: next.detail ?? previous.detail } : {}),
      ...(next.progress !== undefined || previous.progress !== undefined
        ? { progress: next.progress ?? previous.progress }
        : {}),
    };
  }
  const startedAt = previous.startedAt ?? next.startedAt;
  const lifecycleElapsedSeconds = startedAt
    ? (Date.parse(next.lastActivityAt) - Date.parse(startedAt)) / 1_000
    : undefined;
  const activityDeltaSeconds =
    (Date.parse(next.lastActivityAt) - Date.parse(previous.lastActivityAt)) / 1_000;
  const carriedElapsedSeconds =
    next.elapsedSeconds === undefined &&
    previous.elapsedSeconds !== undefined &&
    Number.isFinite(activityDeltaSeconds)
      ? previous.elapsedSeconds + Math.max(0, activityDeltaSeconds)
      : previous.elapsedSeconds;
  const elapsedCandidates = [
    lifecycleElapsedSeconds,
    next.elapsedSeconds,
    carriedElapsedSeconds,
  ].filter((value): value is number => value !== undefined && Number.isFinite(value));
  const terminalElapsedSeconds =
    next.state === "completed" || next.state === "failed" || next.state === "cancelled"
      ? elapsedCandidates.length > 0
        ? Math.max(0, ...elapsedCandidates)
        : undefined
      : undefined;
  return {
    state: next.state,
    label: next.label || previous.label,
    lastActivityAt: next.lastActivityAt,
    ...(startedAt ? { startedAt } : {}),
    ...(next.detail || previous.detail ? { detail: next.detail ?? previous.detail } : {}),
    ...(next.progress !== undefined || previous.progress !== undefined
      ? { progress: next.progress ?? previous.progress }
      : {}),
    ...(terminalElapsedSeconds !== undefined
      ? { elapsedSeconds: terminalElapsedSeconds }
      : next.elapsedSeconds !== undefined || carriedElapsedSeconds !== undefined
        ? { elapsedSeconds: next.elapsedSeconds ?? carriedElapsedSeconds }
        : {}),
  };
}

function reconcileSettledLiveActivities(
  entries: ReadonlyArray<DerivedWorkLogEntry>,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
  options: {
    activeTurnId?: TurnId | null;
    activeTurnStartedAt?: string | null;
    latestTurnState?: OrchestrationLatestTurnState | null;
    latestTurnCompletedAt?: string | null;
  },
): DerivedWorkLogEntry[] {
  const terminalByTurnId = new Map<
    TurnId | string,
    {
      state: Extract<WorkLogLiveActivityState, "completed" | "failed" | "cancelled">;
      settledAt: string;
    }
  >();
  for (const activity of activities) {
    if (activity.turnId === null) {
      continue;
    }
    if (activity.kind === "turn.aborted") {
      terminalByTurnId.set(activity.turnId, {
        state: "cancelled",
        settledAt: activity.createdAt,
      });
    } else if (activity.kind === "turn.completed") {
      terminalByTurnId.set(activity.turnId, {
        state: activity.tone === "error" ? "failed" : "completed",
        settledAt: activity.createdAt,
      });
    }
  }

  const latestTerminalState: SettledLiveActivityState | null =
    options.latestTurnState === "completed"
      ? "completed"
      : options.latestTurnState === "error"
        ? "failed"
        : options.latestTurnState === "interrupted"
          ? "cancelled"
          : null;
  // A latest turn the session is still running is not settled, whatever a
  // mid-turn message did to its client-side state.
  if (
    latestTurnId &&
    latestTerminalState &&
    options.latestTurnCompletedAt &&
    options.activeTurnId !== latestTurnId &&
    !terminalByTurnId.has(latestTurnId)
  ) {
    terminalByTurnId.set(latestTurnId, {
      state: latestTerminalState,
      settledAt: options.latestTurnCompletedAt,
    });
  }
  const latestTurnTerminal = latestTurnId ? terminalByTurnId.get(latestTurnId) : undefined;
  const latestTerminalForTurnlessCompaction =
    latestTurnTerminal ??
    (latestTerminalState && options.latestTurnCompletedAt
      ? { state: latestTerminalState, settledAt: options.latestTurnCompletedAt }
      : undefined);

  const hasActiveTurnContext = options.activeTurnId !== undefined;
  const activeTurnStartedAtMs = options.activeTurnStartedAt
    ? Date.parse(options.activeTurnStartedAt)
    : Number.NaN;
  return entries.map((entry) => {
    let displayEntry = normalizeContextCompactionEntryDisplay(entry);
    const liveActivity = displayEntry.liveActivity;
    const owningTurnTerminal = displayEntry.turnId
      ? terminalByTurnId.get(displayEntry.turnId)
      : undefined;
    if (
      displayEntry.toolDetails?.kind === "command" &&
      displayEntry.toolDetails.processId &&
      owningTurnTerminal
    ) {
      const processStillRunning =
        liveActivity !== undefined && isInProgressLiveActivityState(liveActivity.state);
      // A successful parent turn can leave a native process alive. Do not turn
      // that process's partial stdout into a fabricated Success at turn end.
      // Abort/error still settles the command through the existing path below.
      const backgroundRunning = processStillRunning && owningTurnTerminal.state === "completed";
      // processId also exists on ordinary foreground exec calls. A settled
      // command is a background completion only if it outlived its parent turn.
      const backgroundFinished =
        (processStillRunning && owningTurnTerminal.state !== "completed") ||
        (!processStillRunning &&
          liveActivity !== undefined &&
          Date.parse(liveActivity.lastActivityAt) > Date.parse(owningTurnTerminal.settledAt));
      if (backgroundRunning || backgroundFinished) {
        displayEntry = {
          ...displayEntry,
          backgroundTerminal: backgroundRunning ? "running" : "finished",
        };
      }
      if (backgroundRunning) return displayEntry;
    }
    const isContextCompactionProgress =
      displayEntry.activityKind === "context-compaction" &&
      isContextCompactionProgressLabel(displayEntry.label);
    if (
      (!liveActivity || !isInProgressLiveActivityState(liveActivity.state)) &&
      !isContextCompactionProgress
    ) {
      return displayEntry;
    }

    const entryLastActivityAtMs = Date.parse(liveActivity?.lastActivityAt ?? entry.createdAt);
    const turnlessCompactionBelongsToLatestTurn =
      isContextCompactionProgress &&
      Number.isFinite(activeTurnStartedAtMs) &&
      Number.isFinite(entryLastActivityAtMs) &&
      entryLastActivityAtMs >= activeTurnStartedAtMs &&
      (!latestTerminalForTurnlessCompaction ||
        entryLastActivityAtMs <= Date.parse(latestTerminalForTurnlessCompaction.settledAt));

    const terminal = displayEntry.turnId
      ? owningTurnTerminal
      : turnlessCompactionBelongsToLatestTurn
        ? latestTerminalForTurnlessCompaction
        : undefined;
    if (terminal) {
      return {
        ...settleContextCompactionEntry(displayEntry, terminal.state),
        toolStatus:
          terminal.state === "failed"
            ? "failed"
            : terminal.state === "cancelled"
              ? "cancelled"
              : "completed",
        ...(liveActivity
          ? {
              liveActivity: settleWorkLogLiveActivity(
                liveActivity,
                terminal.state,
                terminal.settledAt,
              ),
            }
          : {}),
      };
    }

    if (
      isContextCompactionProgress &&
      latestTerminalForTurnlessCompaction &&
      !turnlessCompactionBelongsToLatestTurn
    ) {
      return displayEntry;
    }

    if (!hasActiveTurnContext) {
      return displayEntry;
    }
    const turnlessEntryBelongsToActiveTurn =
      (entry.turnId === undefined || entry.turnId === null) &&
      Number.isFinite(activeTurnStartedAtMs) &&
      Number.isFinite(entryLastActivityAtMs) &&
      entryLastActivityAtMs >= activeTurnStartedAtMs;
    if (
      (options.activeTurnId !== null || options.latestTurnState === "running") &&
      (displayEntry.turnId === options.activeTurnId || turnlessEntryBelongsToActiveTurn)
    ) {
      return displayEntry;
    }

    const settledState =
      latestTurnId && displayEntry.turnId === latestTurnId && latestTerminalState
        ? latestTerminalState
        : "cancelled";
    return {
      ...settleContextCompactionEntry(displayEntry, settledState),
      toolStatus:
        settledState === "failed"
          ? "failed"
          : settledState === "cancelled"
            ? "cancelled"
            : "completed",
      ...(liveActivity
        ? {
            liveActivity: settleWorkLogLiveActivity(
              liveActivity,
              settledState,
              latestTurnId && displayEntry.turnId === latestTurnId && options.latestTurnCompletedAt
                ? options.latestTurnCompletedAt
                : liveActivity.lastActivityAt,
            ),
          }
        : {}),
    };
  });
}

function isInProgressLiveActivityState(state: WorkLogLiveActivityState): boolean {
  return (
    state === "starting" ||
    state === "thinking" ||
    state === "running_tool" ||
    state === "waiting" ||
    state === "streaming"
  );
}

function settleWorkLogLiveActivity(
  activity: WorkLogLiveActivity,
  state: Extract<WorkLogLiveActivityState, "completed" | "failed" | "cancelled">,
  settledAt: string,
): WorkLogLiveActivity {
  const activityAtMs = Date.parse(activity.lastActivityAt);
  const settledAtMs = Date.parse(settledAt);
  const lastActivityAt =
    Number.isFinite(activityAtMs) && Number.isFinite(settledAtMs) && settledAtMs >= activityAtMs
      ? settledAt
      : activity.lastActivityAt;
  return (
    mergeWorkLogLiveActivity(activity, {
      state,
      label: isContextCompactionProgressLabel(activity.label)
        ? contextCompactionTerminalLabel(state)
        : activity.label,
      lastActivityAt,
    }) ?? activity
  );
}

function mergeWorkLogToolTitle(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): string | undefined {
  const previousTitle = previous.toolTitle;
  const nextTitle = next.toolTitle;
  if (!previousTitle || !nextTitle) {
    return nextTitle ?? previousTitle;
  }
  const isAgentTask =
    previous.itemType === "collab_agent_tool_call" || next.itemType === "collab_agent_tool_call";
  if (isAgentTask && !isGenericToolTitle(previousTitle) && isGenericToolTitle(nextTitle)) {
    return previousTitle;
  }
  return nextTitle;
}

function mergeChangedFiles(
  previous: ReadonlyArray<string> | undefined,
  next: ReadonlyArray<string> | undefined,
): string[] {
  const merged = [...(previous ?? []), ...(next ?? [])];
  if (merged.length === 0) {
    return [];
  }
  return [...new Set(merged)];
}

// ACP providers restart their tool-call ids every turn. The server then scopes
// the runtime item id per turn and records the raw id as `providerToolCallId`,
// while the activity data keeps carrying that raw id as `toolCallId`.
function hasTurnScopedProviderToolCallId(payload: Record<string, unknown> | null): boolean {
  return typeof asRecord(payload?.data)?.providerToolCallId === "string";
}

// Keep a stable lifecycle key so providers like Claude can stream many
// in-progress tool deltas without turning each partial update into its own row.
// Globally unique ids merge across turns on purpose (a background command can
// outlive the turn that started it); per-turn ids only identify a call within
// their turn.
function deriveToolLifecycleCollapseKey(
  entry: DerivedWorkLogEntry,
  turnScopedToolCallId = false,
): string | undefined {
  if (!isRenderableToolLifecycleActivity(entry.activityKind)) {
    return undefined;
  }
  if (entry.itemType === "image_generation" && entry.generatedImage) {
    return `image-generation:${entry.generatedImage.callId ?? entry.id}`;
  }
  if (entry.toolCallId) {
    return turnScopedToolCallId && entry.turnId
      ? `tool:${entry.turnId}\u001f${entry.toolCallId}`
      : `tool:${entry.toolCallId}`;
  }
  const normalizedLabel = normalizeCompactToolLabel(entry.toolTitle ?? entry.label);
  const itemType = entry.itemType ?? "";
  const requestKind = entry.requestKind ?? "";
  const toolName = entry.toolName ?? "";
  const command = normalizeCompactToolLabel(entry.command ?? "");
  const detailHint = normalizeCompactToolLabel(extractDetailCollapseHint(entry.detail));
  if (
    normalizedLabel.length === 0 &&
    itemType.length === 0 &&
    requestKind.length === 0 &&
    toolName.length === 0 &&
    detailHint.length === 0
  ) {
    return command.length > 0 ? `command-only${"\u001f"}${command}` : undefined;
  }
  return [itemType, normalizedLabel, requestKind, toolName, detailHint].join("\u001f");
}

function isRenderableToolLifecycleActivity(
  kind: OrchestrationThreadActivity["kind"],
): kind is "tool.started" | "tool.updated" | "tool.completed" {
  return kind === "tool.started" || kind === "tool.updated" || kind === "tool.completed";
}

function deriveToolLifecycleCollapseCommand(entry: DerivedWorkLogEntry): string | undefined {
  const command = normalizeCompactToolLabel(entry.command ?? "");
  return command.length > 0 ? command : undefined;
}

function areToolLifecycleCommandsCompatible(
  previous: string | undefined,
  next: string | undefined,
): boolean {
  if (!previous || !next) {
    return true;
  }
  return previous === next || previous.startsWith(next) || next.startsWith(previous);
}

function areToolLifecycleChangedFilesCompatible(
  previous: ReadonlyArray<string> | undefined,
  next: ReadonlyArray<string> | undefined,
): boolean {
  if (!previous?.length || !next?.length) {
    return true;
  }
  const nextSet = new Set(next);
  return previous.some((path) => nextSet.has(path));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asComputerPermissions(value: unknown): readonly ComputerPermission[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is ComputerPermission =>
      entry === "accessibility" || entry === "screenRecording",
  );
}

function asComputerBuildSignature(value: unknown): ComputerBuildSignature | undefined {
  return value === "adhoc" || value === "signed" ? value : undefined;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  return values.find(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
}

function normalizeCollabIdentifier(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return value.trim().toLowerCase().replaceAll("_", "").replaceAll("-", "");
}

function collabPayloadItem(
  payload: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item) ?? data;
  return item
    ? normalizeSubagentToolData(asTrimmedString(payload?.provider) ?? undefined, item)
    : null;
}

function inferSubagentActionTool(item: Record<string, unknown> | null): string | null {
  const directTool = asTrimmedString(
    item?.action ?? item?.tool ?? item?.toolName ?? item?.tool_name ?? item?.name,
  );
  // Provider Task/Agent data has already been normalized at the structured boundary.
  if (directTool) return normalizeMultiAgentAction(directTool) ?? directTool;

  const normalizedType = normalizeCollabIdentifier(asTrimmedString(item?.type));
  if (!normalizedType) {
    return null;
  }
  if (normalizedType.includes("spawn")) return "spawnAgent";
  if (normalizedType.includes("wait")) return "waitAgent";
  if (normalizedType.includes("close")) return "closeAgent";
  if (normalizedType.includes("resume")) return "resumeAgent";
  if (normalizedType.includes("interrupt")) return "interruptAgent";
  if (normalizedType.includes("list")) return "listAgents";
  if (normalizedType.includes("followup")) return "followupTask";
  if (normalizedType.includes("sendmessage")) return "sendMessage";
  if (normalizedType.includes("interaction")) return "sendInput";
  return null;
}

function summarizeSubagentAction(tool: string, count: number): string {
  const normalizedTool = normalizeCollabIdentifier(tool) ?? "";
  const effectiveCount = Math.max(1, count);
  const noun = pluralize(effectiveCount, "agent");
  switch (normalizedTool) {
    case "spawnagent":
      return `Spawning ${effectiveCount} ${noun}`;
    case "wait":
    case "waitagent":
      return `Waiting on ${effectiveCount} ${noun}`;
    case "closeagent":
      return `Closing ${effectiveCount} ${noun}`;
    case "resumeagent":
      return `Resuming ${effectiveCount} ${noun}`;
    case "sendinput":
    case "sendmessage":
    case "followuptask":
      return `Updating ${pluralize(effectiveCount, "agent")}`;
    case "interruptagent":
      return `Interrupting ${effectiveCount} ${noun}`;
    case "listagents":
      return `Listing ${effectiveCount} ${noun}`;
    default:
      return effectiveCount === 1 ? "Agent activity" : `Agent activity (${effectiveCount})`;
  }
}

function extractCollabAction(
  payload: Record<string, unknown> | null,
  subagents: ReadonlyArray<WorkLogSubagent>,
  lifecycleStatus: MossMcpToolStatus | undefined,
): WorkLogSubagentAction | undefined {
  const itemType = extractWorkLogItemType(payload);
  if (itemType !== "collab_agent_tool_call") {
    return undefined;
  }

  const item = collabPayloadItem(payload);
  if (decodeSubagentActivity(item)) return undefined;
  const itemInput = asRecord(item?.input);
  const inferredTool =
    inferSubagentActionTool(item) ?? inferSubagentActionTool(asRecord(payload?.data));
  const recordedTool = asTrimmedString(item?.tool);
  const tool =
    recordedTool &&
    normalizeMultiAgentAction(recordedTool) === normalizeMultiAgentAction(inferredTool)
      ? recordedTool
      : inferredTool;
  const rawStatus = asTrimmedString(item?.status ?? payload?.status);
  const status =
    normalizeMultiAgentActionStatus(rawStatus) ??
    normalizeMultiAgentActionStatus(lifecycleStatus) ??
    rawStatus ??
    "inProgress";
  const model = asTrimmedString(
    item?.model ??
      item?.modelName ??
      item?.model_name ??
      item?.requestedModel ??
      item?.requested_model ??
      itemInput?.model,
  );
  const prompt = asTrimmedString(
    item?.prompt ??
      item?.task ??
      item?.message ??
      itemInput?.prompt ??
      itemInput?.message ??
      itemInput?.task ??
      itemInput?.description,
  );
  const agentStates = decodeSubagentAgentStates(item);
  const receiverThreadIds = decodeSubagentReceiverThreadIds(item);
  const count = Math.max(
    subagents.length,
    receiverThreadIds.length,
    Object.keys(agentStates).length,
  );

  if (!tool && !model && !prompt && count === 0 && !lifecycleStatus) {
    return undefined;
  }

  return {
    tool: tool ?? "",
    status,
    summaryText: summarizeSubagentAction(tool ?? "", count),
    ...(model ? { model } : {}),
    ...(prompt ? { prompt } : {}),
  };
}

function extractCollabSubagents(
  payload: Record<string, unknown> | null,
): ReadonlyArray<WorkLogSubagent> {
  const itemType = extractWorkLogItemType(payload);
  if (itemType !== "collab_agent_tool_call") {
    return [];
  }

  const item = collabPayloadItem(payload);
  if (!item) {
    return [];
  }

  const receiverThreadIds = decodeSubagentReceiverThreadIds(item);
  const receiverAgents = decodeSubagentReceiverAgents(item, receiverThreadIds).map((agent) => {
    const receiverAgent: WorkLogSubagent = {
      threadId: agent.providerThreadId,
      providerThreadId: agent.providerThreadId,
    };
    if (agent.agentId) receiverAgent.agentId = agent.agentId;
    if (agent.nickname) receiverAgent.nickname = agent.nickname;
    if (agent.role) receiverAgent.role = agent.role;
    if (agent.model) receiverAgent.model = agent.model;
    if (agent.effort) receiverAgent.effort = agent.effort;
    if (agent.background !== undefined) receiverAgent.background = agent.background;
    if (agent.isActive !== undefined) receiverAgent.isActive = agent.isActive;
    if (agent.prompt) receiverAgent.prompt = agent.prompt;
    if (agent.status) receiverAgent.rawStatus = agent.status;
    if (agent.statusLabel) receiverAgent.statusLabel = agent.statusLabel;
    return receiverAgent;
  });

  const agentStates = decodeSubagentAgentStates(item);
  if (receiverAgents.length > 0 || Object.keys(agentStates).length > 0) {
    const mergedByThreadId = new Map<string, WorkLogSubagent>();
    for (const agent of receiverAgents) {
      mergedByThreadId.set(agent.threadId, agent);
    }
    for (const [threadId, state] of Object.entries(agentStates)) {
      const previous = mergedByThreadId.get(threadId);
      mergedByThreadId.set(threadId, {
        threadId,
        providerThreadId: previous?.providerThreadId ?? threadId,
        ...previous,
        ...(state.agentId ? { agentId: state.agentId } : {}),
        ...(state.nickname ? { nickname: state.nickname } : {}),
        ...(state.role ? { role: state.role } : {}),
        ...(state.model ? { model: state.model } : {}),
        ...(state.prompt ? { prompt: state.prompt } : {}),
        ...(state.background !== undefined ? { background: state.background } : {}),
        ...(state.isActive !== undefined ? { isActive: state.isActive } : {}),
        ...(state.status ? { rawStatus: state.status } : {}),
        ...(state.statusLabel ? { statusLabel: state.statusLabel } : {}),
        ...(state.message ? { latestUpdate: state.message } : {}),
      });
    }
    return [...mergedByThreadId.values()];
  }

  const singularThreadId =
    receiverThreadIds[0] ??
    asTrimmedString(
      item.receiverThreadId ?? item.receiver_thread_id ?? item.threadId ?? item.thread_id,
    );
  if (!singularThreadId) {
    const fallbackIdentity = extractSubagentIdentityHints(item).find(
      (entry) => entry.providerThreadId !== undefined,
    );
    if (!fallbackIdentity?.providerThreadId) {
      return [];
    }
    return [
      {
        threadId: fallbackIdentity.providerThreadId,
        providerThreadId: fallbackIdentity.providerThreadId,
        ...(fallbackIdentity.agentId ? { agentId: fallbackIdentity.agentId } : {}),
        ...(fallbackIdentity.nickname ? { nickname: fallbackIdentity.nickname } : {}),
        ...(fallbackIdentity.role ? { role: fallbackIdentity.role } : {}),
        ...(fallbackIdentity.model ? { model: fallbackIdentity.model } : {}),
        ...(fallbackIdentity.effort ? { effort: fallbackIdentity.effort } : {}),
        ...(fallbackIdentity.background ? { background: fallbackIdentity.background } : {}),
        ...(fallbackIdentity.isActive !== undefined ? { isActive: fallbackIdentity.isActive } : {}),
        ...(fallbackIdentity.prompt ? { prompt: fallbackIdentity.prompt } : {}),
        ...(fallbackIdentity.status ? { rawStatus: fallbackIdentity.status } : {}),
        ...(fallbackIdentity.statusLabel ? { statusLabel: fallbackIdentity.statusLabel } : {}),
        ...(fallbackIdentity.message ? { latestUpdate: fallbackIdentity.message } : {}),
      },
    ];
  }
  return [
    {
      threadId: singularThreadId,
      providerThreadId: singularThreadId,
      agentId:
        asTrimmedString(item.agentId ?? item.agent_id ?? item.newAgentId ?? item.new_agent_id) ??
        undefined,
      nickname:
        asTrimmedString(
          item.newAgentNickname ??
            item.new_agent_nickname ??
            item.agentNickname ??
            item.agent_nickname ??
            item.receiverAgentNickname ??
            item.receiver_agent_nickname,
        ) ?? undefined,
      role:
        asTrimmedString(
          item.receiverAgentRole ??
            item.receiver_agent_role ??
            item.newAgentRole ??
            item.new_agent_role ??
            item.agentRole ??
            item.agent_role ??
            item.agentType ??
            item.agent_type,
        ) ?? undefined,
      model:
        asTrimmedString(
          item.model ??
            item.modelName ??
            item.model_name ??
            item.requestedModel ??
            item.requested_model,
        ) ?? undefined,
      effort: asTrimmedString(item.effort) ?? undefined,
      background:
        typeof item.background === "boolean"
          ? item.background
          : typeof item.backgrounded === "boolean"
            ? item.backgrounded
            : typeof item.isBackgrounded === "boolean"
              ? item.isBackgrounded
              : typeof item.is_backgrounded === "boolean"
                ? item.is_backgrounded
                : undefined,
      isActive:
        typeof item.isActive === "boolean"
          ? item.isActive
          : typeof item.is_active === "boolean"
            ? item.is_active
            : typeof item.active === "boolean"
              ? item.active
              : undefined,
      rawStatus:
        asTrimmedString(item.status ?? item.state ?? item.lifecycle ?? item.phase) ?? undefined,
      statusLabel:
        asTrimmedString(item.statusLabel ?? item.status_label ?? item.label) ?? undefined,
      prompt: asTrimmedString(item.prompt ?? item.task ?? item.message) ?? undefined,
    },
  ];
}

function normalizeCommandValue(value: unknown): string | null {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const parts = value
    .map((entry) => asTrimmedString(entry))
    .filter((entry): entry is string => entry !== null);
  return parts.length > 0 ? parts.join(" ") : null;
}

function asCommandArgumentRecord(value: unknown): Record<string, unknown> | null {
  const direct = asRecord(value);
  if (direct) {
    return direct;
  }
  const text = asTrimmedString(value);
  if (!text || !text.startsWith("{")) {
    return null;
  }
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

function isCommandLikeDetail(payload: Record<string, unknown> | null): boolean {
  if (!payload) {
    return false;
  }
  const itemType = extractWorkLogItemType(payload);
  if (itemType === "command_execution") {
    return true;
  }
  const requestKind = extractWorkLogRequestKind(payload);
  if (requestKind === "command") {
    return true;
  }
  const normalizedTitle = normalizeCompactToolLabel(asTrimmedString(payload.title) ?? "");
  return normalizedTitle === "Ran command" || normalizedTitle === "Command run";
}

interface CommandAction {
  type: string;
  command?: string;
  name?: string;
  path?: string;
  query?: string;
}

interface CommandActionDisplay {
  title: string;
  preview?: string;
}

function makeCommandActionDisplay(
  title: string,
  preview: string | undefined,
): CommandActionDisplay {
  return preview === undefined ? { title } : { title, preview };
}

function extractToolCommand(
  payload: Record<string, unknown> | null,
  commandAction: CommandAction | null = extractPrimaryCommandAction(payload),
): { command: string | null; rawCommand: string | null } {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const itemInput = asRecord(item?.input);
  const itemArguments = asCommandArgumentRecord(item?.arguments ?? item?.args ?? item?.params);
  const itemCall = asRecord(item?.call);
  const itemFunction = asRecord(item?.function);
  const dataInput = asRecord(data?.input);
  const dataArguments = asCommandArgumentRecord(data?.arguments ?? data?.args ?? data?.params);
  const rawInput = asCommandArgumentRecord(data?.rawInput);
  const detailCommand =
    isCommandLikeDetail(payload) && typeof payload?.detail === "string"
      ? stripTrailingExitCode(payload.detail).output
      : null;
  const rawCommandCandidates = [
    item?.command,
    item?.cmd,
    itemInput?.command,
    itemInput?.cmd,
    itemArguments?.command,
    itemArguments?.cmd,
    itemCall?.command,
    itemCall?.cmd,
    itemFunction?.arguments,
    itemResult?.command,
    itemResult?.cmd,
    data?.command,
    data?.cmd,
    dataInput?.command,
    dataInput?.cmd,
    dataArguments?.command,
    dataArguments?.cmd,
    rawInput?.command,
    rawInput?.cmd,
    item?.text,
    item?.summary,
    detailCommand,
  ];
  const rawCommand =
    rawCommandCandidates
      .map((candidate) => normalizeCommandValue(candidate))
      .find((candidate) => candidate !== null) ?? null;
  const command =
    normalizeCommandValue(commandAction?.command) ??
    rawCommandCandidates
      .map((candidate) => normalizeCommandValue(candidate))
      .find((candidate) => candidate !== null) ??
    null;
  return {
    command,
    rawCommand: rawCommand && rawCommand !== command ? rawCommand : null,
  };
}

function extractToolTitle(payload: Record<string, unknown> | null): string | null {
  return asTrimmedString(payload?.title);
}

function extractPrimaryCommandAction(
  payload: Record<string, unknown> | null,
): CommandAction | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const actions = collectCommandActions(payload, data, item);
  for (const action of actions) {
    const actionRecord = asRecord(action);
    if (!actionRecord) {
      continue;
    }
    const type = asTrimmedString(actionRecord.type) ?? "unknown";
    const command = asTrimmedString(actionRecord.command) ?? undefined;
    const name = asTrimmedString(actionRecord.name) ?? undefined;
    const path = asTrimmedString(actionRecord.path) ?? undefined;
    const query = asTrimmedString(actionRecord.query) ?? undefined;
    if (command || name || path || query || type !== "unknown") {
      return {
        type,
        ...(command ? { command } : {}),
        ...(name ? { name } : {}),
        ...(path ? { path } : {}),
        ...(query ? { query } : {}),
      };
    }
  }
  return null;
}

// Codex has emitted commandActions both on the item and on the surrounding raw
// payload; scan the nearby envelopes before falling back to generic command text.
function collectCommandActions(
  payload: Record<string, unknown> | null,
  data: Record<string, unknown> | null,
  item: Record<string, unknown> | null,
): ReadonlyArray<unknown> {
  const candidates = [
    item?.commandActions,
    asCommandArgumentRecord(item?.arguments ?? item?.args ?? item?.params)?.commandActions,
    data?.commandActions,
    asCommandArgumentRecord(data?.arguments ?? data?.args ?? data?.params)?.commandActions,
    asCommandArgumentRecord(data?.rawInput)?.commandActions,
    asCommandArgumentRecord(data?.input)?.commandActions,
    payload?.commandActions,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }
  return [];
}

function deriveCommandActionDisplay(
  action: CommandAction | null,
  activityKind: OrchestrationThreadActivity["kind"],
): CommandActionDisplay | null {
  if (!action) {
    return null;
  }
  const running = activityKind !== "tool.completed";
  switch (normalizeCommandActionType(action.type)) {
    case "read":
    case "readfile":
      return makeCommandActionDisplay(running ? "Reading" : "Read", commandActionTarget(action));
    case "search":
    case "find":
      return makeCommandActionDisplay(
        running ? "Searching" : "Searched",
        commandActionSearchPreview(action),
      );
    case "listfiles":
      return makeCommandActionDisplay(
        running ? "Listing" : "Listed",
        commandActionListPreview(action),
      );
    default:
      return null;
  }
}

function normalizeCommandActionType(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function commandActionTarget(action: CommandAction): string | undefined {
  return action.name ?? compactWorkLogPath(action.path) ?? undefined;
}

function commandActionSearchPreview(action: CommandAction): string | undefined {
  const query = action.query ?? action.name;
  const path = compactWorkLogPath(action.path);
  if (query && path) {
    return `for ${query} in ${path}`;
  }
  if (query) {
    return `for ${query}`;
  }
  if (path) {
    return `in ${path}`;
  }
  return commandActionTarget(action);
}

function commandActionListPreview(action: CommandAction): string | undefined {
  return compactWorkLogPath(action.path) ?? action.name ?? undefined;
}

function compactWorkLogPath(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  if (value === ".") {
    return "current directory";
  }
  if (value === "..") {
    return "parent directory";
  }
  const parts = value.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) {
    return value;
  }
  return parts.slice(-2).join("/");
}

function extractToolName(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const itemInput = asRecord(item?.input);
  const dataInput = asRecord(data?.input);
  const dataRawInput = asRecord(data?.rawInput);
  const dataInvocation = asRecord(data?.invocation);
  const itemInvocation = asRecord(item?.invocation);
  // ACP's generic `use_tool` wrapper carries the actual MCP identifier in its
  // input. Prefer that identity so actual calls and `search_tool` lookups do
  // not share the same HTML-tool presentation path.
  const normalizedComputerName = asTrimmedString(payload?.toolName ?? data?.toolName);
  if (computerToolName(normalizedComputerName)) return normalizedComputerName;
  const nestedToolNames = [
    itemInput?.tool_name,
    itemInput?.toolName,
    dataInput?.tool_name,
    dataInput?.toolName,
    dataRawInput?.tool_name,
    dataRawInput?.toolName,
  ];
  for (const candidate of nestedToolNames) {
    const normalized = asTrimmedString(candidate);
    if (normalized) return normalized;
  }
  const candidates = [
    payload?.toolName,
    data?.toolName,
    data?.tool,
    dataInvocation?.tool,
    dataInvocation?.toolName,
    item?.toolName,
    item?.tool,
    item?.name,
    itemInvocation?.tool,
    itemInvocation?.toolName,
  ];
  for (const candidate of candidates) {
    const normalized = asTrimmedString(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function extractHtmlPageToolTitle(
  payload: Record<string, unknown> | null,
  toolName: string | null,
  title: string | null,
): string | null {
  if (!payload || !isHtmlPageToolCall({ toolName, title, fallbackLabel: null })) {
    return null;
  }
  const data = asRecord(payload.data);
  const item = asRecord(data?.item);
  const itemRawInput = asArgumentRecord(item?.rawInput);
  const dataRawInput = asArgumentRecord(data?.rawInput);
  const dataInvocation = asRecord(data?.invocation);
  const itemInvocation = asRecord(item?.invocation);
  const candidates = [
    item?.input,
    item?.arguments,
    itemInvocation?.input,
    itemInvocation?.arguments,
    data?.input,
    data?.arguments,
    dataInvocation?.input,
    dataInvocation?.arguments,
    itemRawInput?.tool_input,
    itemRawInput?.toolInput,
    dataRawInput?.tool_input,
    dataRawInput?.toolInput,
    payload.input,
    payload.arguments,
  ];
  for (const candidate of candidates) {
    const args = asArgumentRecord(candidate);
    const pageTitle = asTrimmedString(args?.title);
    if (pageTitle) return pageTitle;
    const documentTitle = extractHtmlDocumentTitle(args?.html);
    if (documentTitle) return documentTitle;
  }
  // Grok can put html_render's entire input in tool_input_file. The successful
  // ACP result still contains the canonical page reference, so use that title
  // rather than treating the transport filename as a page subtitle.
  const outputCandidates = [
    item?.rawOutput,
    data?.rawOutput,
    dataInvocation?.rawOutput,
    itemInvocation?.rawOutput,
    payload.rawOutput,
  ];
  for (const candidate of outputCandidates) {
    const pageTitle = extractHtmlPageToolOutputTitle(candidate);
    if (pageTitle) return pageTitle;
  }
  return null;
}

function extractHtmlPageToolOutputTitle(value: unknown): string | null {
  const output = asArgumentRecord(value);
  if (!output) return null;
  const outputRecords = [output, asArgumentRecord(output.output)].filter(
    (candidate): candidate is Record<string, unknown> => candidate !== null,
  );
  for (const outputRecord of outputRecords) {
    // Grok stores MCP output as `rawOutput.output.OkayOutput`, with the
    // successful result encoded as a JSON string rather than an object.
    const okayOutput =
      asArgumentRecord(outputRecord.OkayOutput) ?? asArgumentRecord(outputRecord.okayOutput);
    const candidates = [
      asArgumentRecord(outputRecord.htmlRender),
      asArgumentRecord(okayOutput?.htmlRender),
      asArgumentRecord(outputRecord.structuredContent)?.htmlRender,
      asArgumentRecord(okayOutput?.structuredContent)?.htmlRender,
    ];
    for (const candidate of candidates) {
      const pageTitle = asTrimmedString(asArgumentRecord(candidate)?.title);
      if (pageTitle) return pageTitle;
    }
  }
  return null;
}

function extractHtmlDocumentTitle(value: unknown): string | null {
  const html = asTrimmedString(value);
  if (!html) return null;
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/iu.exec(html);
  const title = match?.[1]
    ?.replace(/<[^>]*>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return asTrimmedString(title);
}

function extractToolSearchQuery(payload: Record<string, unknown> | null): string | null {
  const rawInput = asArgumentRecord(asRecord(payload?.data)?.rawInput);
  if (!rawInput) return null;
  const isSearchTool =
    asTrimmedString(rawInput.variant)?.toLowerCase() === "searchtool" ||
    asTrimmedString(payload?.title)?.toLowerCase() === "search_tool";
  return isSearchTool ? asTrimmedString(rawInput.query) : null;
}

function deriveComputerToolDescription(input: {
  activity: OrchestrationThreadActivity;
  payload: Record<string, unknown> | null;
  toolName: string | null;
  title: string | null;
}) {
  if (input.payload?.approvalScope === "computer-foreground") {
    return {
      summary:
        input.activity.kind === "approval.requested"
          ? "Asked to show Computer on screen"
          : input.payload.decision === "accept"
            ? "Computer allowed on screen"
            : input.payload.decision === "decline"
              ? "Computer kept in the background"
              : "On-screen request cancelled",
    };
  }
  if (
    input.payload?.approvalScope === "computer-task" ||
    input.payload?.approvalScope === "device-task"
  ) {
    const family = input.payload.approvalScope === "device-task" ? "Device" : "Computer";
    return {
      summary:
        input.activity.kind === "approval.requested"
          ? `${family} task approval requested`
          : input.payload.decision === "accept"
            ? `${family} task approved`
            : input.payload.decision === "decline"
              ? `${family} task declined`
              : `${family} task approval cancelled`,
    };
  }
  if (!computerToolName(input.toolName)) {
    return null;
  }
  const explicitTitle = normalizeCompactToolLabel(input.title ?? "");
  if (
    explicitTitle.length > 0 &&
    !isGenericToolTitle(explicitTitle) &&
    !computerToolName(explicitTitle)
  ) {
    return null;
  }
  const progressTitle = normalizeCompactToolLabel(input.activity.summary);
  if (
    input.activity.kind === "tool.updated" &&
    progressTitle.length > 0 &&
    !isGenericToolTitle(progressTitle) &&
    !computerToolName(progressTitle)
  ) {
    return { summary: progressTitle };
  }
  return describeComputerToolCall({
    toolName: input.toolName,
    args: extractComputerToolArgs(input.payload) ?? undefined,
  });
}

function extractComputerToolArgs(
  payload: Record<string, unknown> | null,
): Readonly<Record<string, unknown>> | null {
  if (!payload) {
    return null;
  }
  const data = asRecord(payload.data);
  const item = asRecord(data?.item);
  const dataInvocation = asRecord(data?.invocation);
  const itemInvocation = asRecord(item?.invocation);
  const dataInput = asRecord(data?.input);
  const itemInput = asRecord(item?.input);
  const candidates = [
    item?.arguments,
    itemInput?.arguments,
    itemInput?.args,
    item?.input,
    itemInvocation?.arguments,
    itemInvocation?.input,
    dataInvocation?.arguments,
    dataInvocation?.input,
    data?.arguments,
    dataInput?.arguments,
    dataInput?.args,
    data?.input,
    data?.rawInput,
    payload.arguments,
    payload.input,
  ];
  for (const candidate of candidates) {
    const args = asArgumentRecord(candidate);
    if (args) {
      return args;
    }
  }
  return parseHistoricalToolParamsDisplay(payload.toolParamsDisplay);
}

function asArgumentRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return asArgumentRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseHistoricalToolParamsDisplay(value: unknown): Record<string, unknown> | null {
  const record = asArgumentRecord(value);
  if (record) {
    return record;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const result: Record<string, unknown> = {};
  for (const entry of value) {
    const row = asRecord(entry);
    const name = asTrimmedString(row?.name ?? row?.display_name ?? row?.displayName);
    if (name) {
      result[name] = row?.value;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

function extractToolCallId(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  return asTrimmedString(
    data?.toolCallId ??
      data?.toolUseId ??
      data?.callID ??
      data?.callId ??
      item?.id ??
      payload?.toolCallId ??
      payload?.toolUseId ??
      payload?.callID ??
      payload?.callId,
  );
}

function stripTrailingExitCode(value: string): {
  output: string | null;
  exitCode?: number | undefined;
} {
  return stripTrailingToolExitCode(value.trim());
}

function extractDetailCollapseHint(detail: string | undefined): string {
  if (!detail) {
    return "";
  }
  const firstLine = detail.split("\n", 1)[0]?.trim() ?? "";
  if (firstLine.length === 0) {
    return "";
  }
  const colonIndex = firstLine.indexOf(":");
  if (colonIndex <= 0) {
    return firstLine;
  }
  return firstLine.slice(0, colonIndex);
}

function extractWorkLogItemType(
  payload: Record<string, unknown> | null,
): WorkLogEntry["itemType"] | undefined {
  const topLevel = payload?.itemType;
  if (typeof topLevel === "string" && isToolLifecycleItemType(topLevel)) {
    return topLevel;
  }
  // Defensive: some provider payloads nest the type inside data or data.item
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const nested = data?.itemType ?? item?.type ?? item?.kind ?? payload?.type ?? payload?.kind;
  if (typeof nested === "string" && isToolLifecycleItemType(nested)) {
    return nested;
  }
  return undefined;
}

/**
 * Parses only typed Codex or server-owned Moss image artifacts. In particular, a
 * title, detail string, markdown fragment, or arbitrary nested path is never
 * enough to create an image item.
 */
export function parseWorkLogGeneratedImage(
  activity: Pick<OrchestrationThreadActivity, "kind">,
  payload: Record<string, unknown> | null,
  itemType = extractWorkLogItemType(payload),
): WorkLogGeneratedImage | undefined {
  if (itemType !== "image_generation") {
    return undefined;
  }

  const data = asRecord(payload?.data);
  const path = asTrimmedString(data?.path);
  const callId =
    asTrimmedString(data?.callId) ??
    asTrimmedString(payload?.callId) ??
    extractToolCallId(payload) ??
    undefined;
  if (activity.kind === "tool.completed") {
    if (data?.kind === MOSS_IMAGE_GENERATION_FAILURE_KIND && payload?.status === "failed" && callId)
      return { state: "failed", callId };
    if (
      (data?.kind !== CODEX_GENERATED_IMAGE_ARTIFACT_KIND &&
        data?.kind !== MOSS_GENERATED_IMAGE_ARTIFACT_KIND) ||
      path === null
    ) {
      return undefined;
    }
    return { state: "completed", path, ...(callId ? { callId } : {}) };
  }

  const dataStatus = asTrimmedString(data?.status);
  const state = asRecord(data?.state);
  const stateStatus = asTrimmedString(state?.status);
  const rawOutput = asRecord(data?.rawOutput);
  const rawOutputStatus = asTrimmedString(rawOutput?.status);
  const payloadStatus = asTrimmedString(payload?.status);
  const status = (payloadStatus ?? dataStatus ?? stateStatus ?? rawOutputStatus)?.toLowerCase();
  const isStarted = activity.kind === "tool.started";
  const isInProgress = status === "inprogress" || status === "in_progress";
  // A path on a non-terminal observation is deliberately ignored. The only
  // completed representation accepted above is the exact artifact kind.
  if ((isStarted || activity.kind === "tool.updated") && path === null && isInProgress) {
    return { state: "pending", ...(callId ? { callId } : {}) };
  }
  return undefined;
}

function extractWorkLogRequestKind(
  payload: Record<string, unknown> | null,
): WorkLogEntry["requestKind"] | undefined {
  if (
    payload?.requestKind === "command" ||
    payload?.requestKind === "file-read" ||
    payload?.requestKind === "file-change" ||
    payload?.requestKind === "permissions" ||
    payload?.requestKind === "computer-foreground" ||
    payload?.requestKind === "tool"
  ) {
    return payload.requestKind;
  }
  return approvalRequestKindFromRequestType(payload?.requestType) ?? undefined;
}

function pushChangedFile(target: string[], seen: Set<string>, value: unknown) {
  const normalized = asTrimmedString(value);
  if (!normalized || !isLikelyFilePath(normalized) || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  target.push(normalized);
}

function isLikelyFilePath(value: string): boolean {
  if (/^(?:file|vscode|cursor):\/\//iu.test(value)) {
    return true;
  }
  if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../")) {
    return true;
  }
  if (/^[A-Za-z]:[\\/]/u.test(value)) {
    return true;
  }
  if (value.includes("/") || value.includes("\\")) {
    return true;
  }
  return /^[^\s/\\]+\.[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value);
}

function collectChangedFiles(value: unknown, target: string[], seen: Set<string>, depth: number) {
  if (depth > 4 || target.length >= 12) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChangedFiles(entry, target, seen, depth + 1);
      if (target.length >= 12) {
        return;
      }
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  pushChangedFile(target, seen, record.path);
  pushChangedFile(target, seen, record.file);
  pushChangedFile(target, seen, record.file_path);
  pushChangedFile(target, seen, record.filepath);
  pushChangedFile(target, seen, record.filePath);
  pushChangedFile(target, seen, record.relativePath);
  pushChangedFile(target, seen, record.filename);
  pushChangedFile(target, seen, record.newPath);
  pushChangedFile(target, seen, record.oldPath);

  // Codex/native file_change payloads key `changes` by absolute path:
  // { "/abs/path.ts": { type: "update", unified_diff: "..." } }.
  // Recursing only into known nested fields misses those path keys.
  for (const [key, nested] of Object.entries(record)) {
    if (!isLikelyFilePath(key)) {
      continue;
    }
    const nestedRecord = asRecord(nested);
    if (
      nestedRecord &&
      ("type" in nestedRecord ||
        "kind" in nestedRecord ||
        "unified_diff" in nestedRecord ||
        "unifiedDiff" in nestedRecord ||
        "diff" in nestedRecord ||
        "move_path" in nestedRecord ||
        "movePath" in nestedRecord)
    ) {
      pushChangedFile(target, seen, key);
      if (target.length >= 12) {
        return;
      }
    }
  }

  for (const nestedKey of [
    "item",
    "result",
    "input",
    "rawInput",
    "rawOutput",
    "data",
    "location",
    "locations",
    "changes",
    "files",
    "file",
    "edits",
    "patch",
    "patches",
    "operations",
  ]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectChangedFiles(record[nestedKey], target, seen, depth + 1);
    if (target.length >= 12) {
      return;
    }
  }
}

function extractChangedFiles(payload: Record<string, unknown> | null): string[] {
  const changedFiles: string[] = [];
  const seen = new Set<string>();
  collectChangedFiles(asRecord(payload?.data), changedFiles, seen, 0);
  return changedFiles;
}

type ModelReroutedChronologyReference = {
  readonly id: string;
  readonly createdAt: string;
  readonly turnId?: TurnId | null;
};

function timelineEntryTurnId(entry: TimelineEntry): string | null {
  if (entry.kind === "message") {
    return entry.message.turnId ? String(entry.message.turnId) : null;
  }
  if (entry.kind === "message-segment") {
    return entry.message.turnId ? String(entry.message.turnId) : null;
  }
  if (entry.kind === "work") {
    return entry.entry.turnId ? String(entry.entry.turnId) : null;
  }
  if (entry.kind === "context-compaction") {
    return entry.entry.turnId ? String(entry.entry.turnId) : null;
  }
  if (entry.kind === "todo-plan" || entry.kind === "html-render") {
    return entry.turnId ? String(entry.turnId) : null;
  }
  if (entry.kind === "proposed-plan") {
    return entry.proposedPlan.turnId ? String(entry.proposedPlan.turnId) : null;
  }
  if (entry.kind === "model-rerouted") {
    return entry.turnId ? String(entry.turnId) : null;
  }
  if (entry.kind === "system-error") {
    return entry.entry.turnId ? String(entry.entry.turnId) : null;
  }
  return null;
}

function isModelReroutedRelatedToReference(
  entry: TimelineEntry,
  reference: ModelReroutedChronologyReference,
): boolean {
  if (entry.kind === "model-rerouted") {
    return entry.id === reference.id;
  }
  const entryTurnId = timelineEntryTurnId(entry);
  const referenceTurnId = reference.turnId ? String(reference.turnId) : null;
  if (entryTurnId !== null && referenceTurnId !== null) {
    return entryTurnId === referenceTurnId;
  }
  if (referenceTurnId === null) {
    return entry.createdAt === reference.createdAt;
  }
  // User/model-change entries are the only turn-less items with a frozen
  // same-time relationship to the reroute. Do not pull unrelated turn-less
  // transcript content into the affected turn's special ordering.
  return (
    entry.createdAt === reference.createdAt &&
    ((entry.kind === "message" && entry.message.role === "user") || entry.kind === "model-changed")
  );
}

function useModelReroutedPairOrdering(
  left: TimelineEntry,
  right: TimelineEntry,
  references: ReadonlyArray<ModelReroutedChronologyReference>,
): boolean {
  return references.some(
    (reference) =>
      isModelReroutedRelatedToReference(left, reference) &&
      isModelReroutedRelatedToReference(right, reference),
  );
}

function compareTimelineEntries(
  left: TimelineEntry,
  right: TimelineEntry,
  modelReroutedChronology: ReadonlyArray<ModelReroutedChronologyReference> = [],
): number {
  const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  if (
    "sequence" in left &&
    "sequence" in right &&
    left.sequence !== undefined &&
    right.sequence !== undefined
  ) {
    return left.sequence - right.sequence;
  }

  // Model-change dividers are anchored to the following user item and must
  // remain before it when the optimistic event and message share a timestamp.
  const kindRank = (entry: TimelineEntry): number => {
    if (useModelReroutedPairOrdering(left, right, modelReroutedChronology)) {
      if (entry.kind === "model-changed") return 0;
      if (entry.kind === "message" || entry.kind === "message-segment") {
        return entry.kind === "message" && entry.message.role === "user" ? 1 : 7;
      }
      if (entry.kind === "model-rerouted") return 2;
      if (entry.kind === "turn-error") return 3;
      if (entry.kind === "system-error") return 3;
      if (entry.kind === "proposed-plan") return 4;
      if (entry.kind === "context-compaction") return 5;
      if (entry.kind === "todo-plan") return 6;
      if (entry.kind === "html-render") return 6;
      if (entry.kind === "work") return 6;
    }
    switch (entry.kind) {
      case "model-changed":
        return 0;
      case "message":
      case "message-segment":
        return 1;
      case "turn-error":
        return 2;
      case "system-error":
        return 2;
      case "proposed-plan":
        return 3;
      case "context-compaction":
        return 4;
      case "todo-plan":
      case "html-render":
        return 5;
      case "work":
        return 6;
      case "model-rerouted":
        return 2;
    }
  };
  const rankComparison = kindRank(left) - kindRank(right);
  if (rankComparison !== 0) {
    return rankComparison;
  }
  return left.id.localeCompare(right.id);
}

function areTimelineEntriesOrdered(
  entries: ReadonlyArray<TimelineEntry>,
  modelReroutedChronology: ReadonlyArray<ModelReroutedChronologyReference> = [],
): boolean {
  for (let index = 1; index < entries.length; index += 1) {
    if (compareTimelineEntries(entries[index - 1]!, entries[index]!, modelReroutedChronology) > 0) {
      return false;
    }
  }
  return true;
}

type TimelineEntriesComparator = (left: TimelineEntry, right: TimelineEntry) => number;

function sortedTimelineEntries(
  entries: TimelineEntry[],
  modelReroutedChronology: ReadonlyArray<ModelReroutedChronologyReference> = [],
  compare?: TimelineEntriesComparator,
): TimelineEntry[] {
  const effectiveCompare =
    compare ??
    ((left: TimelineEntry, right: TimelineEntry) =>
      compareTimelineEntries(left, right, modelReroutedChronology));
  for (let index = 1; index < entries.length; index += 1) {
    if (effectiveCompare(entries[index - 1]!, entries[index]!) > 0) {
      return entries.toSorted(effectiveCompare);
    }
  }
  return entries;
}

function mergeTimelineEntries(
  left: ReadonlyArray<TimelineEntry>,
  right: ReadonlyArray<TimelineEntry>,
  modelReroutedChronology: ReadonlyArray<ModelReroutedChronologyReference> = [],
  compare?: TimelineEntriesComparator,
): TimelineEntry[] {
  if (left.length === 0) {
    return [...right];
  }
  if (right.length === 0) {
    return [...left];
  }

  const effectiveCompare =
    compare ??
    ((leftEntry: TimelineEntry, rightEntry: TimelineEntry) =>
      compareTimelineEntries(leftEntry, rightEntry, modelReroutedChronology));
  const merged: TimelineEntry[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftEntry = left[leftIndex]!;
    const rightEntry = right[rightIndex]!;
    if (effectiveCompare(leftEntry, rightEntry) <= 0) {
      merged.push(leftEntry);
      leftIndex += 1;
    } else {
      merged.push(rightEntry);
      rightIndex += 1;
    }
  }
  while (leftIndex < left.length) {
    merged.push(left[leftIndex]!);
    leftIndex += 1;
  }
  while (rightIndex < right.length) {
    merged.push(right[rightIndex]!);
    rightIndex += 1;
  }
  return merged;
}

// Keep one grouping per source message; obsolete snapshots can be collected.
const coalescedMessageCache = new WeakMap<
  ChatMessage,
  { readonly signature: string; readonly displayMessage: ChatMessage }
>();

/** Old snapshots can contain one segment per token. Only a visible intervening
 * row warrants another Markdown document; keep the persisted text untouched. */
function coalesceAdjacentMessageSegments(entries: TimelineEntry[]): TimelineEntry[] {
  if (
    !entries.some((entry, index) => {
      const previous = entries[index - 1];
      return (
        entry.kind === "message-segment" &&
        previous?.kind === "message-segment" &&
        entry.message === previous.message &&
        entry.segmentIndex === previous.segmentIndex + 1
      );
    })
  ) {
    return entries;
  }
  type SegmentEntry = Extract<TimelineEntry, { kind: "message-segment" }>;
  const groupsByMessage = new Map<ChatMessage, SegmentEntry[][]>();
  const runs: Array<TimelineEntry | SegmentEntry[]> = [];
  for (const entry of entries) {
    const previous = runs.at(-1);
    if (entry.kind !== "message-segment") {
      runs.push(entry);
    } else if (
      Array.isArray(previous) &&
      previous[0]!.message === entry.message &&
      previous.at(-1)!.segmentIndex + 1 === entry.segmentIndex
    ) {
      previous.push(entry);
    } else {
      const group = [entry];
      runs.push(group);
      const groups = groupsByMessage.get(entry.message) ?? [];
      groups.push(group);
      groupsByMessage.set(entry.message, groups);
    }
  }

  const replacements = new Map<SegmentEntry[], TimelineEntry>();
  for (const [message, groups] of groupsByMessage) {
    if (!groups.some((group) => group.length > 1)) continue;
    const signature = groups
      .map((group) => `${group[0]!.segmentIndex}:${group.at(-1)!.segmentIndex}`)
      .join(",");
    const cached = coalescedMessageCache.get(message);
    let displayMessage = cached?.signature === signature ? cached.displayMessage : undefined;
    if (displayMessage === undefined) {
      const textSegments = groups.map((group) => {
        const first = message.textSegments![group[0]!.segmentIndex]!;
        const last = message.textSegments![group.at(-1)!.segmentIndex]!;
        return {
          ...first,
          endedAt: last.endedAt,
          text: group.map((entry) => message.textSegments![entry.segmentIndex]!.text).join(""),
        };
      });
      displayMessage =
        groups.length === 1 && textSegments[0]!.text === message.text
          ? message
          : { ...message, textSegments };
      coalescedMessageCache.set(message, { signature, displayMessage });
    }
    if (displayMessage === message) {
      replacements.set(groups[0]!, {
        id: message.id,
        kind: "message",
        createdAt: groups[0]![0]!.createdAt,
        message,
      });
      continue;
    }
    const coalescedMessage = displayMessage;
    groups.forEach((group, segmentIndex) => {
      replacements.set(group, { ...group[0]!, message: coalescedMessage, segmentIndex });
    });
  }
  return runs.map((run) => (Array.isArray(run) ? (replacements.get(run) ?? run[0]!) : run));
}

function startsNewUserTurn(message: ChatMessage): boolean {
  return (
    message.role === "user" &&
    // Effective dispatch semantics are recorded before an emulated steer waits
    // for interruption/promotion. Fall back to turn binding for events written
    // before startsNewTurn existed; native steers remain continuations.
    (message.startsNewTurn ??
      (message.dispatchMode !== "steer" ||
        (message.turnId !== null && message.turnId !== undefined)))
  );
}

function isSequenced(row: TimelineEntry): boolean {
  return row.kind === "work" && row.sequence !== undefined;
}

// The SDK and transcript can report one Monitor termination twice. Coalesce
// adjacent matching native task/outcome notices only; any reply or different
// outcome remains a distinct boundary. Keep the exact output and earlier anchor.
function coalesceMonitorTerminalNotices(entries: TimelineEntry[]): TimelineEntry[] {
  let result: TimelineEntry[] | undefined;
  for (let index = 1; index < entries.length; index += 1) {
    const previous = result?.at(-1) ?? entries[index - 1]!;
    const current = entries[index]!;
    if (previous.kind === "work" && current.kind === "work") {
      const monitorRow = previous.entry.monitorNotification ? previous : current;
      const completionRow = previous.entry.backgroundTaskCompletion ? previous : current;
      const monitor = monitorRow.entry.monitorNotification;
      const completion = completionRow.entry.backgroundTaskCompletion;
      if (
        monitorRow !== completionRow &&
        monitor &&
        completion &&
        monitor.outcome !== "updated" &&
        monitor.taskId === completion.taskId &&
        monitor.outcome ===
          (completion.outcome === "finished" ? "completed" : completion.outcome) &&
        (!previous.entry.turnId ||
          !current.entry.turnId ||
          previous.entry.turnId === current.entry.turnId)
      ) {
        result ??= entries.slice(0, index);
        result[result.length - 1] = { ...monitorRow, createdAt: previous.createdAt };
        continue;
      }
    }
    result?.push(current);
  }
  return result ?? entries;
}

export function deriveTimelineEntries(
  messages: ChatMessage[],
  proposedPlans: ProposedPlan[],
  workEntries: WorkLogEntry[],
  modelChangeRecordsOrOptions:
    | ReadonlyArray<ModelChangeTranscriptRecord>
    | { readonly suppressCoordinatorCheckins?: boolean } = [],
  replayTurns: ReadonlyArray<CodexReplayTurn> = [],
  options?: { readonly suppressCoordinatorCheckins?: boolean },
): TimelineEntry[] {
  const modelChangeRecords: ReadonlyArray<ModelChangeTranscriptRecord> = Array.isArray(
    modelChangeRecordsOrOptions,
  )
    ? modelChangeRecordsOrOptions
    : [];
  const effectiveOptions = Array.isArray(modelChangeRecordsOrOptions)
    ? options
    : (modelChangeRecordsOrOptions as { readonly suppressCoordinatorCheckins?: boolean });

  // Coordinator check-ins (automation-dispatched heartbeat/wake turns) never
  // render: the automation prompt row, its work/plan rows bound to the check-in
  // turn, and the reply when it is a silent "nothing to report". A non-silent
  // reply stays as an ordinary coordinator message.
  const checkinSuppression = effectiveOptions?.suppressCoordinatorCheckins
    ? suppressCoordinatorCheckinMessages(messages)
    : null;
  const visibleMessages = checkinSuppression ? checkinSuppression.messages : messages;
  const checkinTurnIds = checkinSuppression?.checkinTurnIds;
  const visibleProposedPlans = checkinTurnIds
    ? proposedPlans.filter((plan) => plan.turnId == null || !checkinTurnIds.has(plan.turnId))
    : proposedPlans;
  const visibleWorkEntries = checkinTurnIds
    ? workEntries.filter((entry) => entry.turnId == null || !checkinTurnIds.has(entry.turnId))
    : workEntries;
  const proposedPlanTurnIds = new Set(
    visibleProposedPlans.flatMap((proposedPlan) =>
      proposedPlan.turnId ? [proposedPlan.turnId] : [],
    ),
  );
  const messageRows: TimelineEntry[] = visibleMessages.flatMap((message): TimelineEntry[] => {
    const displayMessage =
      message.role === "assistant" && message.turnId && proposedPlanTurnIds.has(message.turnId)
        ? { ...message, text: stripProposedPlanBlocksFromText(message.text) }
        : message;
    if (
      displayMessage.role === "assistant" &&
      displayMessage.text.length === 0 &&
      displayMessage.turnId &&
      proposedPlanTurnIds.has(displayMessage.turnId)
    ) {
      return [];
    }
    // Completed assistant messages whose streamed text was interleaved with
    // tool rows render as one row per text segment, each positioned at its own
    // start time, so the merged timeline shows reasoning next to the tool that
    // interrupted it instead of one block above every tool. While the message
    // is still streaming, keep the single live row (the streaming surface).
    const textSegments = displayMessage.textSegments;
    if (
      displayMessage.role === "assistant" &&
      !displayMessage.streaming &&
      textSegments !== undefined &&
      textSegments.length > 1
    ) {
      return textSegments.map((segment, segmentIndex) => ({
        id: `${displayMessage.id}#seg:${segmentIndex}`,
        kind: "message-segment" as const,
        createdAt: segment.startedAt,
        sequence: segment.sequence,
        message: displayMessage,
        segmentIndex,
      }));
    }
    return [
      {
        id: displayMessage.id,
        kind: "message",
        createdAt: displayMessage.createdAt,
        message: displayMessage,
      },
    ];
  });
  const proposedPlanRows: TimelineEntry[] = visibleProposedPlans.map((proposedPlan) => ({
    id: proposedPlan.id,
    kind: "proposed-plan",
    createdAt: proposedPlan.createdAt,
    proposedPlan,
  }));
  const messageIds = new Set(visibleMessages.map((message) => message.id));
  const modelChangedRows: TimelineEntry[] = modelChangeRecords
    .filter((record) => messageIds.has(record.messageId))
    .map((record) => ({
      id: record.id,
      kind: "model-changed" as const,
      createdAt: record.createdAt,
      messageId: record.messageId,
      fromModel: record.fromModel,
      toModel: record.toModel,
      ...(record.fromModelDisplayName ? { fromModelDisplayName: record.fromModelDisplayName } : {}),
      ...(record.toModelDisplayName ? { toModelDisplayName: record.toModelDisplayName } : {}),
      status: record.status,
    }));
  const turnErrorRows: TimelineEntry[] = modelChangeRecords
    .filter((record) => messageIds.has(record.messageId) && record.status === "failed")
    .filter((record) => Boolean(record.error?.trim()))
    .map((record) => ({
      id: `${record.id}:error`,
      kind: "turn-error" as const,
      createdAt: record.createdAt,
      messageId: record.messageId,
      message: record.error!.trim(),
    }));
  type ModelReroutedTimelineEntry = Extract<TimelineEntry, { kind: "model-rerouted" }>;
  const modelReroutedRows: ModelReroutedTimelineEntry[] = visibleWorkEntries.flatMap((entry) => {
    if (entry.activityKind !== MODEL_REROUTED_ACTIVITY_KIND || !entry.modelRerouted) {
      return [];
    }
    return [
      {
        id: entry.id,
        kind: "model-rerouted" as const,
        createdAt: entry.createdAt,
        ...(entry.sequence !== undefined ? { sequence: entry.sequence } : {}),
        ...(entry.turnId !== undefined ? { turnId: entry.turnId } : {}),
        fromModel: entry.modelRerouted.fromModel,
        toModel: entry.modelRerouted.toModel,
        reason: entry.modelRerouted.reason,
      },
    ];
  });
  type TodoPlanTimelineEntry = Extract<TimelineEntry, { kind: "todo-plan" }>;
  const todoPlanRows: TodoPlanTimelineEntry[] = visibleWorkEntries.flatMap((entry) => {
    if (entry.activityKind !== "turn.tasks.updated" || entry.taskList === undefined) {
      return [];
    }
    return [
      {
        id: entry.id,
        kind: "todo-plan" as const,
        createdAt: entry.createdAt,
        ...(entry.sequence !== undefined ? { sequence: entry.sequence } : {}),
        ...(entry.turnId !== undefined ? { turnId: entry.turnId } : {}),
        tasks: entry.taskList,
      },
    ];
  });
  type HtmlRenderTimelineEntry = Extract<TimelineEntry, { kind: "html-render" }>;
  const htmlRenderRows: HtmlRenderTimelineEntry[] = visibleWorkEntries.flatMap((entry) =>
    entry.htmlRender === undefined
      ? []
      : [
          {
            id: entry.id,
            kind: "html-render" as const,
            createdAt: entry.createdAt,
            ...(entry.sequence !== undefined ? { sequence: entry.sequence } : {}),
            ...(entry.turnId !== undefined ? { turnId: entry.turnId } : {}),
            htmlRender: entry.htmlRender,
          },
        ],
  );
  type SystemErrorTimelineEntry = Extract<TimelineEntry, { kind: "system-error" }>;
  const systemErrorRows: SystemErrorTimelineEntry[] = visibleWorkEntries.flatMap((entry) => {
    if (!entry.systemError) {
      return [];
    }
    return [
      {
        id: entry.id,
        kind: "system-error" as const,
        createdAt: entry.createdAt,
        ...(entry.sequence !== undefined ? { sequence: entry.sequence } : {}),
        ...(entry.turnId !== undefined ? { turnId: entry.turnId } : {}),
        entry,
      },
    ];
  });
  const workRows: TimelineEntry[] = visibleWorkEntries
    .filter(
      (entry) =>
        entry.activityKind !== MODEL_REROUTED_ACTIVITY_KIND &&
        entry.activityKind !== "turn.tasks.updated" &&
        entry.activityKind !== HTML_RENDER_ACTIVITY_KIND &&
        entry.systemError === undefined,
    )
    .map((entry) => ({
      id: entry.id,
      kind:
        entry.activityKind === "context-compaction"
          ? ("context-compaction" as const)
          : ("work" as const),
      createdAt: entry.createdAt,
      ...(entry.sequence !== undefined ? { sequence: entry.sequence } : {}),
      entry,
    }));
  const modelReroutedChronology: ReadonlyArray<ModelReroutedChronologyReference> =
    modelReroutedRows.map((entry) => ({
      id: entry.id,
      createdAt: entry.createdAt,
      ...(entry.turnId !== undefined ? { turnId: entry.turnId } : {}),
    }));

  // Late tool completion/replay timestamps must not move an earlier turn's
  // work below a new user request and inflate that request's tool disclosure.
  const userStarts: string[] = [];
  const messageOrder = new Map<string, number>();
  const turnOrder = new Map<string, number>();
  const messagesOrdered = visibleMessages.every(
    (message, index) =>
      index === 0 || visibleMessages[index - 1]!.createdAt.localeCompare(message.createdAt) <= 0,
  );
  const orderedMessages = messagesOrdered
    ? visibleMessages
    : visibleMessages.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  // A user message bound to its turn owns that turn's block even when it was
  // sent (and queued) while an earlier turn was still running: the earlier
  // turn's answer stays under its own request instead of moving below it.
  let userTurnCount = 0;
  for (const message of orderedMessages) {
    if (!startsNewUserTurn(message)) continue;
    userTurnCount += 1;
    if (message.turnId && !turnOrder.has(message.turnId)) {
      turnOrder.set(message.turnId, userTurnCount);
    }
  }
  for (const message of orderedMessages) {
    if (startsNewUserTurn(message)) {
      userStarts.push(message.createdAt);
    }
    const order =
      message.role !== "user" && message.turnId
        ? (turnOrder.get(message.turnId) ?? userStarts.length)
        : userStarts.length;
    messageOrder.set(message.id, order);
    if (message.turnId && !turnOrder.has(message.turnId)) turnOrder.set(message.turnId, order);
  }
  // Unattributed legacy activity keeps its chronological position.
  const chronologicalOrder = (createdAt: string): number => {
    let low = 0;
    let high = userStarts.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (userStarts[mid]!.localeCompare(createdAt) <= 0) low = mid + 1;
      else high = mid;
    }
    return low;
  };
  const orderByEntry = new Map<TimelineEntry, number>();
  for (const entry of [...messageRows, ...proposedPlanRows, ...htmlRenderRows, ...workRows]) {
    if (entry.kind === "message" || entry.kind === "message-segment") {
      orderByEntry.set(
        entry,
        messageOrder.get(entry.message.id) ?? chronologicalOrder(entry.createdAt),
      );
      continue;
    }
    // A merged work/plan row can carry a newer turnId than its anchor (a
    // background tool's update owns the new turn) while a late replay can carry
    // an old turnId with a fresh timestamp. Anchor it at whichever is earlier.
    const turnId =
      (entry.kind === "work"
        ? entry.entry.turnId
        : entry.kind === "proposed-plan"
          ? entry.proposedPlan.turnId
          : entry.kind === "html-render"
            ? entry.turnId
            : null) ?? undefined;
    const turnBlock = turnId === undefined ? undefined : turnOrder.get(turnId);
    const chronological = chronologicalOrder(entry.createdAt);
    orderByEntry.set(
      entry,
      turnBlock === undefined ? chronological : Math.min(turnBlock, chronological),
    );
  }
  const compareWithTurnBlocks: TimelineEntriesComparator = (left, right) => {
    const leftOrder = orderByEntry.get(left);
    const rightOrder = orderByEntry.get(right);
    if (leftOrder !== undefined && rightOrder !== undefined && leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return compareTimelineEntries(left, right, modelReroutedChronology);
  };

  const merged = mergeTimelineEntries(
    mergeTimelineEntries(
      mergeTimelineEntries(
        sortedTimelineEntries(messageRows, modelReroutedChronology, compareWithTurnBlocks),
        sortedTimelineEntries([...modelChangedRows, ...turnErrorRows], modelReroutedChronology),
        modelReroutedChronology,
        compareWithTurnBlocks,
      ),
      sortedTimelineEntries(proposedPlanRows, modelReroutedChronology, compareWithTurnBlocks),
      modelReroutedChronology,
      compareWithTurnBlocks,
    ),
    sortedTimelineEntries(
      [...modelReroutedRows, ...todoPlanRows, ...htmlRenderRows, ...systemErrorRows, ...workRows],
      modelReroutedChronology,
      compareWithTurnBlocks,
    ),
    modelReroutedChronology,
    compareWithTurnBlocks,
  );
  return coalesceSubagentActivityRows(
    applyCodexReplayOrder(
      coalesceMonitorTerminalNotices(coalesceAdjacentMessageSegments(merged)),
      replayTurns,
    ),
  );
}

// Native replay groups an uninterrupted run of subagent status observations.
// Keep each agent's latest observation; a command or message is a hard boundary.
function coalesceSubagentActivityRows(rows: TimelineEntry[]): TimelineEntry[] {
  const result: TimelineEntry[] = [];
  for (const row of rows) {
    const previous = result.at(-1);
    if (
      row.kind === "work" &&
      row.entry.subagentActivity &&
      previous?.kind === "work" &&
      previous.entry.subagentActivity &&
      row.entry.turnId === previous.entry.turnId &&
      (row.entry.subagentActivity === previous.entry.subagentActivity ||
        (previous.entry.subagents ?? []).every((old) =>
          (row.entry.subagents ?? []).some(
            (agent) =>
              (agent.providerThreadId ?? agent.threadId) === (old.providerThreadId ?? old.threadId),
          ),
        ))
    ) {
      const agents = new Map(
        (previous.entry.subagents ?? []).map((agent) => [
          agent.providerThreadId ?? agent.threadId,
          agent,
        ]),
      );
      for (const agent of row.entry.subagents ?? [])
        agents.set(agent.providerThreadId ?? agent.threadId, agent);
      result[result.length - 1] = {
        ...previous,
        entry: { ...row.entry, id: previous.entry.id, subagents: [...agents.values()] },
      };
    } else result.push(row);
  }
  return result;
}

interface BackgroundTaskState extends WorkLogBackgroundTask {
  toolUseId: string | null;
  // The "Moved to background" notice that first announced the task.
  noticeActivityId: string | null;
}

function backgroundTaskOutcome(status: unknown): WorkLogBackgroundTaskOutcome | null {
  switch (typeof status === "string" ? status.trim().toLowerCase() : null) {
    case "completed":
      return "finished";
    case "failed":
    case "error":
      return "failed";
    case "stopped":
    case "killed":
    case "cancelled":
    case "interrupted":
      return "stopped";
    default:
      return null;
  }
}

function parseBackgroundTaskExitCode(detail: string | null): number | null {
  const match = detail ? /exit code (\d+)/i.exec(detail) : null;
  return match ? Number.parseInt(match[1]!, 10) : null;
}

// Folds a thread's task lifecycle into one state per background task: the
// "Moved to background" notice (or a user's move to background) makes a task
// a background task, task.started links it to the call that launched it, and
// task.updated/task.completed settle it. Subagents (`local_agent`) keep their
// own rows, so they are left out.
function deriveBackgroundTaskStates(ordered: ReadonlyArray<OrchestrationThreadActivity>): {
  tasks: Map<string, BackgroundTaskState>;
  // Notices that first announced a subagent: those keep their own row.
  noticesAnnouncingSubagents: Set<string>;
} {
  const tasks = new Map<string, BackgroundTaskState>();
  const noticesAnnouncingSubagents = new Set<string>();
  const seenTaskIds = new Set<string>();
  const started = new Map<
    string,
    { toolUseId: string | null; taskType: string | null; startedAt: string }
  >();
  const admit = (
    taskId: string,
    activity: OrchestrationThreadActivity,
    info: { taskType: string | null; description: string | null; noticeActivityId: string | null },
  ) => {
    const launch = started.get(taskId);
    const taskType = info.taskType ?? launch?.taskType ?? null;
    if (taskType === "monitor") return;
    if (taskType === "local_agent") {
      // An untyped update can precede both the start and the first notice.
      // Once identified, the subagent keeps its own row and first notice.
      const provisional = tasks.get(taskId);
      if (provisional) {
        tasks.delete(taskId);
        seenTaskIds.delete(taskId);
      }
      const noticeActivityId = provisional?.noticeActivityId ?? info.noticeActivityId;
      if (noticeActivityId && !seenTaskIds.has(taskId)) {
        noticesAnnouncingSubagents.add(noticeActivityId);
        seenTaskIds.add(taskId);
      }
      return;
    }
    if (seenTaskIds.has(taskId)) return;
    seenTaskIds.add(taskId);
    tasks.set(taskId, {
      taskId,
      taskType,
      description: info.description,
      command: null,
      status: "running",
      startedAt: launch?.startedAt ?? activity.createdAt,
      completedAt: null,
      exitCode: null,
      toolUseId: launch?.toolUseId ?? null,
      noticeActivityId: info.noticeActivityId,
    });
  };
  for (const activity of ordered) {
    const payload = asRecord(activity.payload);
    if (
      activity.kind === "runtime.warning" &&
      payload?.nativeEventType === "background_tasks_changed"
    ) {
      const announced = asRecord(payload.data)?.tasks;
      if (!Array.isArray(announced)) continue;
      for (const task of announced) {
        const record = asRecord(task);
        const taskId = asTrimmedString(record?.task_id);
        if (!taskId) continue;
        admit(taskId, activity, {
          taskType: asTrimmedString(record?.task_type),
          description: asTrimmedString(record?.description),
          noticeActivityId: activity.id,
        });
      }
      continue;
    }
    const taskId = asTrimmedString(payload?.taskId);
    if (!taskId) continue;
    if (activity.kind === "task.started") {
      const launch = {
        toolUseId: asTrimmedString(payload?.toolUseId),
        taskType: asTrimmedString(payload?.taskType),
        startedAt: activity.createdAt,
      };
      started.set(taskId, launch);
      const task = tasks.get(taskId);
      if (task) {
        if (launch.taskType === "local_agent") {
          admit(taskId, activity, {
            taskType: launch.taskType,
            description: null,
            noticeActivityId: null,
          });
          continue;
        }
        task.toolUseId ??= launch.toolUseId;
        task.description ??= asTrimmedString(payload?.detail);
      }
      continue;
    }
    if (activity.kind === "task.updated" && payload?.isBackgrounded === true) {
      admit(taskId, activity, {
        taskType: asTrimmedString(payload?.taskType),
        description: asTrimmedString(payload?.detail),
        noticeActivityId: null,
      });
    }
    const task = tasks.get(taskId);
    if (!task || task.status !== "running") continue;
    if (activity.kind === "task.updated" || activity.kind === "task.completed") {
      const outcome = backgroundTaskOutcome(payload?.status);
      if (!outcome) continue;
      const detail = asTrimmedString(payload?.detail);
      task.status = outcome;
      task.completedAt = activity.createdAt;
      task.exitCode = parseBackgroundTaskExitCode(detail);
    }
  }
  return { tasks, noticesAnnouncingSubagents };
}

// One row per background task, in place of the call that launched it (or of
// its "Moved to background" notice when that call is not visible). The row's
// status follows the task, so the transcript never stacks a launch notice,
// a launching command and a completion line for the same work.
function withBackgroundTaskRows<Entry extends WorkLogEntry>(
  entries: ReadonlyArray<Entry>,
  ordered: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<WorkLogEntry> {
  if (
    !ordered.some(
      (activity) =>
        (activity.kind === "runtime.warning" &&
          asRecord(activity.payload)?.nativeEventType === "background_tasks_changed") ||
        (activity.kind === "task.updated" && asRecord(activity.payload)?.isBackgrounded === true),
    )
  ) {
    return entries;
  }
  const { tasks, noticesAnnouncingSubagents } = deriveBackgroundTaskStates(ordered);
  if (tasks.size === 0) {
    return entries;
  }
  const launchEntryByToolUseId = new Map<string, Entry>();
  for (const entry of entries) {
    if (entry.toolCallId) launchEntryByToolUseId.set(entry.toolCallId, entry);
  }
  const taskByToolUseId = new Map<string, BackgroundTaskState>();
  const tasksByNoticeId = new Map<string, BackgroundTaskState[]>();
  for (const task of tasks.values()) {
    const launchEntry = task.toolUseId ? launchEntryByToolUseId.get(task.toolUseId) : undefined;
    if (launchEntry && task.toolUseId) {
      task.command = launchEntry.rawCommand ?? launchEntry.command ?? null;
      taskByToolUseId.set(task.toolUseId, task);
    } else if (task.noticeActivityId) {
      const noticeTasks = tasksByNoticeId.get(task.noticeActivityId) ?? [];
      noticeTasks.push(task);
      tasksByNoticeId.set(task.noticeActivityId, noticeTasks);
    }
  }
  const rowFor = (task: BackgroundTaskState, anchor: WorkLogEntry, id: string): WorkLogEntry => {
    const { toolUseId: _toolUseId, noticeActivityId: _noticeActivityId, ...backgroundTask } = task;
    return {
      id,
      createdAt: anchor.createdAt,
      ...(anchor.sequence !== undefined ? { sequence: anchor.sequence } : {}),
      ...(anchor.turnId ? { turnId: anchor.turnId } : {}),
      label: "Background task",
      tone: "tool",
      ...(anchor.activityKind ? { activityKind: anchor.activityKind } : {}),
      backgroundTask,
    };
  };
  const rows: WorkLogEntry[] = [];
  for (const entry of entries) {
    const launchedTask = entry.toolCallId ? taskByToolUseId.get(entry.toolCallId) : undefined;
    if (launchedTask) {
      rows.push(rowFor(launchedTask, entry, entry.id));
      continue;
    }
    if (entry.nativeEventType === "background_tasks_changed") {
      for (const task of tasksByNoticeId.get(entry.id) ?? []) {
        rows.push(rowFor(task, entry, `${entry.id}:${task.taskId}`));
      }
      // The notice only stays for work this model does not cover (subagents).
      if (noticesAnnouncingSubagents.has(entry.id)) {
        rows.push(entry);
      }
      continue;
    }
    rows.push(entry);
  }
  return rows;
}

function subagentOutcomeFromStatus(
  status: string | null | undefined,
): "completed" | "failed" | "stopped" | undefined {
  switch (status?.trim().toLowerCase()) {
    case "completed":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "stopped":
    case "interrupted":
    case "cancelled":
    case "killed":
      return "stopped";
    default:
      return undefined;
  }
}

export interface SubagentTaskEnd {
  outcome: "completed" | "failed" | "stopped";
  endedAt: string;
  /** The same provider task's previous, already settled invocation. */
  previous?: SubagentTaskEnd;
}

/**
 * When and how each subagent task ended, keyed by its launching tool call id,
 * from the parent's task completions. A background subagent's own thread ends
 * its first turn at launch, so this is the only reliable end it has.
 */
export function deriveSubagentTaskEnds(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyMap<string, SubagentTaskEnd> {
  const ends = new Map<string, SubagentTaskEnd>();
  const resumed = new Set<string>();
  for (const activity of activities) {
    const payload = asRecord(activity.payload);
    const toolUseId = asTrimmedString(payload?.toolUseId);
    if (activity.kind === "task.started" && toolUseId && ends.has(toolUseId)) {
      resumed.add(toolUseId);
    }
    if (activity.kind !== "task.completed") continue;
    const outcome = subagentOutcomeFromStatus(asTrimmedString(payload?.status));
    if (toolUseId && outcome) {
      const previous = resumed.has(toolUseId) ? ends.get(toolUseId) : ends.get(toolUseId)?.previous;
      ends.set(toolUseId, {
        outcome,
        endedAt: activity.createdAt,
        ...(previous ? { previous } : {}),
      });
      resumed.delete(toolUseId);
    }
  }
  return ends;
}

// Keep terminal outcomes within one invocation. A resumed task reuses its tool
// id, but a task.started after settlement opens a new scope. Background progress
// can span parent turns without starting a new invocation.
function withSubagentProgressOutcomes<Entry extends WorkLogEntry>(
  entries: ReadonlyArray<Entry>,
  ordered: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<Entry> {
  if (!entries.some((entry) => entry.subagentProgress !== undefined)) {
    return entries;
  }
  type Invocation = { id?: string; outcome?: WorkLogSubagentProgress["outcome"] };
  const invocationByToolUseId = new Map<string, Invocation>();
  const invocationByProgressId = new Map<string, Invocation>();
  const currentInvocation = (toolUseId: string): Invocation => {
    let invocation = invocationByToolUseId.get(toolUseId);
    if (!invocation) {
      invocation = {};
      invocationByToolUseId.set(toolUseId, invocation);
    }
    return invocation;
  };
  for (const activity of ordered) {
    const payload = asRecord(activity.payload);
    if (activity.kind === "task.started") {
      const toolUseId = asTrimmedString(payload?.toolUseId);
      if (toolUseId && invocationByToolUseId.get(toolUseId)?.outcome !== undefined) {
        // Older progress retains its settled invocation object. A repeated
        // start while still live leaves the existing invocation intact.
        invocationByToolUseId.set(toolUseId, {});
      }
      continue;
    }
    if (activity.kind === "task.progress") {
      const toolUseId = asTrimmedString(payload?.toolUseId);
      if (toolUseId) {
        const invocation = currentInvocation(toolUseId);
        invocation.id ??= activity.id;
        invocationByProgressId.set(activity.id, invocation);
      }
      continue;
    }
    if (activity.kind === "task.completed") {
      const toolUseId = asTrimmedString(payload?.toolUseId);
      const outcome = subagentOutcomeFromStatus(asTrimmedString(payload?.status));
      if (toolUseId && outcome) currentInvocation(toolUseId).outcome = outcome;
      continue;
    }
    if (
      (activity.kind === "tool.updated" || activity.kind === "tool.completed") &&
      extractWorkLogItemType(payload) === "collab_agent_tool_call"
    ) {
      for (const [threadId, state] of Object.entries(
        decodeSubagentAgentStates(collabPayloadItem(payload)),
      )) {
        const outcome = subagentOutcomeFromStatus(state.status);
        if (outcome) currentInvocation(threadId).outcome = outcome;
      }
    }
  }
  return entries.map((entry) => {
    const invocation = entry.subagentProgress ? invocationByProgressId.get(entry.id) : undefined;
    return invocation && entry.subagentProgress
      ? {
          ...entry,
          subagentProgress: {
            ...entry.subagentProgress,
            invocationId: invocation.id ?? entry.id,
            ...(invocation.outcome ? { outcome: invocation.outcome } : {}),
          },
        }
      : entry;
  });
}

// A handoff row summarizes two sessions. Each side reads the fast-mode state its own
// session reported: the source up to the handoff, the target from there to the next one.
function deriveHandoffFastModeNotices(
  ordered: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyMap<string, Pick<ProviderHandoffInfo, "sourceFastModeNotice" | "targetFastModeNotice">> {
  const notices = new Map<
    string,
    Pick<ProviderHandoffInfo, "sourceFastModeNotice" | "targetFastModeNotice">
  >();
  let sessionNotice: FastModeNotice | null = null;
  let openHandoffId: string | null = null;
  for (const activity of ordered) {
    if (activity.kind === FAST_MODE_STATE_ACTIVITY_KIND) {
      sessionNotice = fastModeNoticeFromActivity(activity);
      if (openHandoffId !== null) {
        notices.set(openHandoffId, {
          ...notices.get(openHandoffId),
          targetFastModeNotice: sessionNotice,
        });
      }
      continue;
    }
    if (activity.kind === PROVIDER_HANDOFF_FAILED_ACTIVITY_KIND) {
      // The target never started, so the source session keeps running.
      if (sessionNotice) notices.set(activity.id, { sourceFastModeNotice: sessionNotice });
      continue;
    }
    if (activity.kind === PROVIDER_HANDOFF_ACTIVITY_KIND) {
      if (sessionNotice) notices.set(activity.id, { sourceFastModeNotice: sessionNotice });
      openHandoffId = activity.id;
      sessionNotice = null;
    }
  }
  return notices;
}

function compareActivitiesByOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  const lifecycleRankComparison =
    compareActivityLifecycleRank(left.kind) - compareActivityLifecycleRank(right.kind);
  if (lifecycleRankComparison !== 0) {
    return lifecycleRankComparison;
  }

  // Compaction progress and terminal rows can share a millisecond; keep the
  // progress row first so the work-log collapse can fold the pair (event ids
  // are random and would otherwise order them arbitrarily).
  if (left.kind === "context-compaction" && right.kind === "context-compaction") {
    const compactionRankComparison =
      contextCompactionOrderRank(left.summary) - contextCompactionOrderRank(right.summary);
    if (compactionRankComparison !== 0) {
      return compactionRankComparison;
    }
  }

  return left.id.localeCompare(right.id);
}

function contextCompactionOrderRank(summary: string): number {
  return isContextCompactionProgressLabel(summary) ? 0 : 1;
}

function compareActivityLifecycleRank(kind: string): number {
  if (kind.endsWith(".started") || kind === "tool.started") {
    return 0;
  }
  if (kind.endsWith(".progress") || kind.endsWith(".updated")) {
    return 1;
  }
  if (kind.endsWith(".completed") || kind.endsWith(".resolved")) {
    return 2;
  }
  return 1;
}

type TimelineComparator = (left: TimelineEntry, right: TimelineEntry) => number;

export type WorkLogCodexNotice =
  | { kind: "stream" }
  | { kind: "system" }
  | { kind: "usage"; resetsAt?: string | null };

function parseWorkLogUsageNotice(
  payload: Record<string, unknown> | null,
): WorkLogCodexNotice | undefined {
  const errorInfo =
    payload?.errorInfo ??
    asRecord(payload?.data)?.errorInfo ??
    asRecord(payload?.detail)?.errorInfo;
  if (errorInfo !== "usageLimitExceeded") return undefined;
  const resetsAt = asTrimmedString(
    payload?.resetsAt ?? asRecord(payload?.data)?.resetsAt ?? asRecord(payload?.detail)?.resetsAt,
  );
  return { kind: "usage", ...(resetsAt ? { resetsAt } : {}) };
}

function isWorkLogSystemError(payload: Record<string, unknown> | null, _kind: string): boolean {
  // A generic runtime.error stays a provider error row (quota copy, start
  // diagnostics). Only an explicit system-error marker becomes Codex's
  // "Task encountered a system error" notice.
  const errorClass = payload?.class ?? asRecord(payload?.data)?.class;
  const nativeEventType = payload?.nativeEventType ?? asRecord(payload?.data)?.nativeEventType;
  return errorClass === "system" || nativeEventType === "system-error";
}

type TimelineToolRequestKind = "command" | "file-read" | "file-change" | "permissions" | "tool";

function asTimelineToolRequestKind(
  requestKind: WorkLogEntry["requestKind"] | undefined,
): TimelineToolRequestKind | undefined {
  if (
    requestKind === "command" ||
    requestKind === "file-read" ||
    requestKind === "file-change" ||
    requestKind === "permissions" ||
    requestKind === "tool"
  ) {
    return requestKind;
  }
  return requestKind === undefined ? undefined : "tool";
}

const decodeInlineVisualPayload = Schema.decodeUnknownOption(InlineVisualActivityPayload);
const decodeSecretRequestPayload = Schema.decodeUnknownOption(SecretRequestActivityPayload);
