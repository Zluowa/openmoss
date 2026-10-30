import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationSidebarOrderItem,
  OrchestrationThread,
  ThreadArchivedSidebarPlacement,
  ThreadRestoredSidebarPlacement,
  ProjectKind,
  ThreadGoalAchievement,
  ThreadHistoryImportEntry,
  ThreadHandoffImportedMessage,
  ThreadMarker,
} from "@synara/contracts";
import {
  ASYNC_USER_INPUT_ALREADY_ANSWERED,
  formatAsyncUserInputResponse,
} from "@synara/shared/asyncUserInput";
import {
  EventId,
  MessageId,
  MAX_PINNED_PROJECTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  PINNED_MESSAGES_MAX_COUNT,
  RESERVED_VOID_SPACE_ID,
  SIDEBAR_SECTION_ITEMS_MAX_COUNT,
  SIDEBAR_SECTIONS_MAX_COUNT,
  SPACES_MAX_COUNT,
  THREAD_GOAL_ACHIEVEMENTS_MAX_COUNT,
  SidebarOrderRevision,
  SidebarSectionId,
  SidebarSectionItemKey,
  ThreadId,
  ThreadMarkerId,
  TurnId,
  isRetryableCodexTurnFailure,
} from "@synara/contracts";
import {
  deriveAssociatedWorktreeMetadata,
  deriveAssociatedWorktreeMetadataPatch,
  workspaceRootsEqual,
} from "@synara/shared/threadWorkspace";
import {
  collectSubagentDescendants,
  resolveThreadPresentationOwners,
} from "@synara/shared/threadHierarchy";
import { doThreadMarkerRangesOverlap } from "@synara/shared/threadMarkers";
import {
  isSafetyBufferingBoundToThread,
  latestSafetyBufferingActivity as readLatestSafetyBufferingActivity,
} from "@synara/shared/safetyBuffering";
import { inferLegacyProviderKindFromModelSelection } from "@synara/shared/providerInstances";
import { isSidechatThread } from "@synara/shared/sidechatThread";
import { autoRuntimeModeSelectionIssue } from "@synara/shared/runtimeMode";
import { isGroupContainerKind } from "@synara/shared/projectContainers";
import { findProjectFolderProblem } from "@synara/shared/projectFolders";
import { providerSupportsNativeTurnSteering } from "@synara/shared/providerMetadata";
import { isManualCompactionTurnActive } from "@synara/shared/contextCompaction";
import {
  collectTailTurnIds,
  resolveTailUserMessageEditTarget,
} from "@synara/shared/conversationEdit";
import { Effect } from "effect";

import { computerActivationMetadata } from "../computer/computerActivation.ts";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { withProjectRelocationEvents } from "./projectRelocation.ts";
import { buildForkThreadTitle } from "./forkThreadTitle.ts";
import { hasNativeHandoffMessages } from "./handoff.ts";
import { resolveStableMessageTurnId } from "./messageTurnId.ts";
import {
  isExpiredSidechat,
  latestSidechatActivityAt,
  SIDECHAT_EXPIRED_EXECUTION_MESSAGE,
  sidechatActivityInstantsEqual,
} from "./sidechatLifecycle.ts";
import {
  compactSidebarOrderItems,
  placeSidebarOrderItem,
  placeSidebarThreadOrder,
  rehomeSidebarSectionItems,
  reorderSidebarProjects,
  reorderSidebarSectionThreads,
  validateSidebarOrderItems,
} from "./sidebarOrder.ts";
import {
  findSpaceById,
  isLegacyHomeChatContainerRow,
  CHECKPOINT_REVERT_STARTED_ACTIVITY_KIND,
  CHECKPOINT_REVERT_SUCCEEDED_ACTIVITY_KIND,
  checkpointRevertActiveTurnDetail,
  checkpointRevertDeleteInProgressDetail,
  checkpointRevertInProgressDetail,
  listActiveProjectsByWorkspaceRoot,
  listActiveSpaces,
  listThreadsByProjectId,
  requireApprovalNotResponded,
  isOrdinaryProjectRow,
  requireProject,
  requireProjectAbsent,
  requireProjectHasNoThreads,
  requireProjectWorkspaceRootAvailable,
  requireSpace,
  requireSpaceAbsent,
  requireSpaceAssignableProject,
  requireSpaceNameAvailable,
  type SpaceAssignmentWorkspacePaths,
  requireThread,
  requireThreadAbsent,
  requireThreadArchived,
  requireThreadNotArchived,
  threadHasInFlightTurn,
  threadHasCheckpointRevertInProgress,
  threadResumePreconditionDetail,
  threadResumePreconditionViolation,
} from "./commandInvariants.ts";

const nowIso = () => new Date().toISOString();
// Commands from the web client always carry an explicit assistantDeliveryMode;
// this default only covers legacy/omitted fields. Streaming is the safe fallback:
// an unrecorded preference should degrade to live output, never to a silent
// buffer that withholds the whole assistant message until turn completion.
const DEFAULT_ASSISTANT_DELIVERY_MODE = "streaming" as const;
const GROUP_CONTAINER_PROJECT_KIND_SET = new Set<ProjectKind>(["studio", "group"]);
// Kinds that claim exclusive ownership of a workspace root. Chat containers are excluded: they
// use placeholder roots (e.g. the home dir) that legitimately coexist with real projects.
const WORKSPACE_OWNING_PROJECT_KIND_SET = new Set<ProjectKind>(["project", "studio", "group"]);

function validateSidechatExecutionAvailable(
  command: Pick<OrchestrationCommand, "type">,
  thread: Pick<OrchestrationThread, "sidechatExpiredAt">,
) {
  return isExpiredSidechat(thread)
    ? Effect.fail(
        new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: SIDECHAT_EXPIRED_EXECUTION_MESSAGE,
        }),
      )
    : Effect.void;
}

// A standalone sidechat is a top-level, user-created thread in the project's own checkout:
// no source thread to fork or return to, no parent, no worktree or branch switch.
function validateStandaloneSidechatCreate(
  command: Extract<OrchestrationCommand, { type: "thread.create" }>,
) {
  const conflict =
    command.sourceThreadId !== undefined ||
    command.sourceTurnId !== undefined ||
    command.creationSource !== undefined ||
    command.parentThreadId != null
      ? "A standalone side chat cannot also have a source or parent thread."
      : (command.envMode ?? "local") !== "local" || command.worktreePath != null
        ? "A standalone side chat runs in the project's local checkout."
        : null;
  return conflict === null
    ? Effect.void
    : Effect.fail(
        new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: conflict,
        }),
      );
}

function validateAutoRuntimeMode(
  command: OrchestrationCommand,
  modelSelection: OrchestrationThread["modelSelection"],
  runtimeMode: OrchestrationThread["runtimeMode"],
) {
  const issue = autoRuntimeModeSelectionIssue({ runtimeMode, modelSelection });
  return issue === null
    ? Effect.void
    : Effect.fail(
        new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: issue,
        }),
      );
}

/**
 * A same-thread provider handoff restarts the session on another provider, so
 * it shares Hand off's preconditions: no running turn, pending approval, or
 * pending question the new session could not settle.
 */
function validateProviderHandoff(
  command: Extract<OrchestrationCommand, { type: "thread.meta.update" }>,
  thread: OrchestrationThread,
) {
  const target = command.modelSelection;
  // A live session cannot switch between instances of one provider in place
  // (the turn path rejects that), so those handoffs keep using a new thread.
  const detail =
    target === undefined
      ? "A provider handoff needs a target model selection."
      : target.provider === thread.modelSelection.provider
        ? `Thread '${command.threadId}' already runs on '${target.provider}'; hand off to a new thread instead.`
        : thread.session?.status === "starting" || thread.session?.status === "running"
          ? `Thread '${command.threadId}' still has a running turn.`
          : thread.hasPendingApprovals || thread.hasPendingUserInput
            ? `Thread '${command.threadId}' is waiting for an approval or an answer.`
            : null;
  return detail === null
    ? Effect.void
    : Effect.fail(new OrchestrationCommandInvariantError({ commandType: command.type, detail }));
}

const defaultMetadata: Omit<OrchestrationEvent, "sequence" | "type" | "payload"> = {
  eventId: crypto.randomUUID() as OrchestrationEvent["eventId"],
  aggregateKind: "thread",
  aggregateId: "" as OrchestrationEvent["aggregateId"],
  occurredAt: nowIso(),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
};

function withEventBase(
  input: Pick<OrchestrationCommand, "commandId"> & {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly aggregateId: OrchestrationEvent["aggregateId"];
    readonly occurredAt: string;
    readonly metadata?: OrchestrationEvent["metadata"];
  },
): Omit<OrchestrationEvent, "sequence" | "type" | "payload"> {
  return {
    ...defaultMetadata,
    eventId: crypto.randomUUID() as OrchestrationEvent["eventId"],
    aggregateKind: input.aggregateKind,
    aggregateId: input.aggregateId,
    occurredAt: input.occurredAt,
    commandId: input.commandId,
    correlationId: input.commandId,
    metadata: input.metadata ?? {},
  };
}

function userMessageUpsertEvent(input: {
  readonly commandId: OrchestrationCommand["commandId"];
  readonly threadId: OrchestrationThread["id"];
  readonly message: OrchestrationThread["messages"][number];
  readonly turnId: OrchestrationThread["messages"][number]["turnId"];
  readonly startsNewTurn?: boolean;
  readonly occurredAt: string;
}): Omit<OrchestrationEvent, "sequence"> {
  return {
    ...withEventBase({
      aggregateKind: "thread",
      aggregateId: input.threadId,
      occurredAt: input.occurredAt,
      commandId: input.commandId,
    }),
    type: "thread.message-sent",
    payload: {
      threadId: input.threadId,
      messageId: input.message.id,
      role: "user",
      text: input.message.text,
      ...(input.message.attachments !== undefined
        ? { attachments: input.message.attachments }
        : {}),
      ...(input.message.skills !== undefined ? { skills: input.message.skills } : {}),
      ...(input.message.mentions !== undefined ? { mentions: input.message.mentions } : {}),
      ...(input.message.dispatchMode !== undefined
        ? { dispatchMode: input.message.dispatchMode }
        : {}),
      ...(input.message.dispatchOrigin !== undefined
        ? { dispatchOrigin: input.message.dispatchOrigin }
        : {}),
      ...(input.startsNewTurn !== undefined
        ? { startsNewTurn: input.startsNewTurn }
        : input.message.startsNewTurn !== undefined
          ? { startsNewTurn: input.message.startsNewTurn }
          : {}),
      turnId: input.turnId,
      streaming: false,
      source: input.message.source,
      createdAt: input.message.createdAt,
      updatedAt: input.message.updatedAt,
    },
  };
}

function checkpointRevertSucceededEvent(input: {
  readonly commandId: OrchestrationCommand["commandId"];
  readonly threadId: Extract<OrchestrationCommand, { type: "thread.revert.complete" }>["threadId"];
  readonly turnCount: number;
  readonly createdAt: string;
  readonly causationEventId: OrchestrationEvent["eventId"];
}): Omit<OrchestrationEvent, "sequence"> {
  return {
    ...withEventBase({
      aggregateKind: "thread",
      aggregateId: input.threadId,
      occurredAt: input.createdAt,
      commandId: input.commandId,
    }),
    causationEventId: input.causationEventId,
    type: "thread.activity-appended",
    payload: {
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "info",
        kind: CHECKPOINT_REVERT_SUCCEEDED_ACTIVITY_KIND,
        summary: "Checkpoint revert completed",
        payload: { turnCount: input.turnCount },
        turnId: null,
        createdAt: input.createdAt,
      },
    },
  };
}

function omitNullUserInputAnswers(
  command: Extract<OrchestrationCommand, { type: "thread.user-input.respond" }>,
) {
  return Object.fromEntries(
    Object.entries(command.answers).filter(([, answer]) => answer !== null && answer !== undefined),
  );
}

function countPinnedProjects(
  readModel: OrchestrationReadModel,
  options?: { readonly excludeProjectIds?: ReadonlySet<string> },
): number {
  return readModel.projects.filter(
    (project) =>
      project.deletedAt === null &&
      project.kind === "project" &&
      project.isPinned === true &&
      !options?.excludeProjectIds?.has(project.id),
  ).length;
}

function validateProjectPinLimit(input: {
  readonly command: Extract<
    OrchestrationCommand,
    { type: "project.create" | "project.meta.update" }
  >;
  readonly readModel: OrchestrationReadModel;
  readonly projectId: OrchestrationEvent["aggregateId"];
  readonly nextKind: ProjectKind;
  readonly nextDeletedAt?: string | null;
  readonly wasPinned?: boolean;
  readonly staleProjectIds?: ReadonlySet<string>;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  // The kind invariant must hold for the EFFECTIVE pin state, not only when the command sets
  // isPinned: a kind-only update (e.g. project -> studio) would otherwise carry an existing pin
  // onto a kind that can never be pinned.
  const nextIsPinned = input.command.isPinned ?? input.wasPinned ?? false;
  if (nextIsPinned && input.nextKind !== "project") {
    return Effect.fail(
      new OrchestrationCommandInvariantError({
        commandType: input.command.type,
        detail: `Only projects can be pinned.`,
      }),
    );
  }

  if (input.command.isPinned !== true) {
    return Effect.void;
  }

  if (input.nextDeletedAt !== undefined && input.nextDeletedAt !== null) {
    return Effect.fail(
      new OrchestrationCommandInvariantError({
        commandType: input.command.type,
        detail: `Deleted project '${input.projectId}' cannot be pinned.`,
      }),
    );
  }

  if (input.wasPinned === true) {
    return Effect.void;
  }

  const excludeProjectIds = new Set<string>([input.projectId, ...(input.staleProjectIds ?? [])]);
  const pinnedProjectCount = countPinnedProjects(input.readModel, { excludeProjectIds });
  if (pinnedProjectCount < MAX_PINNED_PROJECTS) {
    return Effect.void;
  }

  return Effect.fail(
    new OrchestrationCommandInvariantError({
      commandType: input.command.type,
      detail: `Only ${MAX_PINNED_PROJECTS} projects can be pinned at once.`,
    }),
  );
}

function deriveCommandAssociatedWorktreeMetadata(input: {
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly associatedWorktreePath?: string | null;
  readonly associatedWorktreeBranch?: string | null;
  readonly associatedWorktreeRef?: string | null;
}) {
  return deriveAssociatedWorktreeMetadata({
    branch: input.branch,
    worktreePath: input.worktreePath,
    ...(input.associatedWorktreePath !== undefined
      ? { associatedWorktreePath: input.associatedWorktreePath }
      : {}),
    ...(input.associatedWorktreeBranch !== undefined
      ? { associatedWorktreeBranch: input.associatedWorktreeBranch }
      : {}),
    ...(input.associatedWorktreeRef !== undefined
      ? { associatedWorktreeRef: input.associatedWorktreeRef }
      : {}),
  });
}

function deriveCommandAssociatedWorktreeMetadataPatch(input: {
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
  readonly associatedWorktreePath?: string | null;
  readonly associatedWorktreeBranch?: string | null;
  readonly associatedWorktreeRef?: string | null;
}) {
  return deriveAssociatedWorktreeMetadataPatch({
    ...(input.branch !== undefined ? { branch: input.branch } : {}),
    ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
    ...(input.associatedWorktreePath !== undefined
      ? { associatedWorktreePath: input.associatedWorktreePath }
      : {}),
    ...(input.associatedWorktreeBranch !== undefined
      ? { associatedWorktreeBranch: input.associatedWorktreeBranch }
      : {}),
    ...(input.associatedWorktreeRef !== undefined
      ? { associatedWorktreeRef: input.associatedWorktreeRef }
      : {}),
  });
}

type CreatedThreadWorkspaceCommand = Pick<
  Extract<
    OrchestrationCommand,
    { type: "thread.create" | "thread.handoff.create" | "thread.fork.create" }
  >,
  | "envMode"
  | "branch"
  | "worktreePath"
  | "workingDirectory"
  | "associatedWorktreePath"
  | "associatedWorktreeBranch"
  | "associatedWorktreeRef"
>;

function resolveCreatedThreadWorkspaceMetadata(
  projectKind: ProjectKind | undefined,
  command: CreatedThreadWorkspaceCommand,
) {
  if (isGroupContainerKind(projectKind)) {
    return {
      envMode: "local" as const,
      branch: null,
      worktreePath: null,
      // Backward compatibility: older Studio clients sent "Use a folder" through
      // worktreePath. Preserve that folder while stripping its worktree semantics.
      workingDirectory:
        command.workingDirectory !== undefined ? command.workingDirectory : command.worktreePath,
      associatedWorktreePath: null,
      associatedWorktreeBranch: null,
      associatedWorktreeRef: null,
    };
  }

  return {
    envMode: command.envMode,
    branch: command.branch,
    worktreePath: command.worktreePath,
    workingDirectory: command.workingDirectory ?? null,
    ...deriveCommandAssociatedWorktreeMetadata({
      branch: command.branch,
      worktreePath: command.worktreePath,
      ...(command.associatedWorktreePath !== undefined
        ? { associatedWorktreePath: command.associatedWorktreePath }
        : {}),
      ...(command.associatedWorktreeBranch !== undefined
        ? { associatedWorktreeBranch: command.associatedWorktreeBranch }
        : {}),
      ...(command.associatedWorktreeRef !== undefined
        ? { associatedWorktreeRef: command.associatedWorktreeRef }
        : {}),
    }),
  };
}

/**
 * Stamps authoritative goal timestamps for `thread.meta.update`. `goalAchieved`
 * takes precedence over everything: it records a ThreadGoalAchievement (with
 * pause-adjusted elapsed time, anchored to the thread's latest turn) and clears
 * the goal in the same event. A goal change takes precedence over `goalPaused`
 * in the same command: a newly set goal starts the pursuit clock, an edit of an
 * existing goal keeps the running clock and pause state, and clearing resets
 * everything. Pause freezes the clock at `goalPausedAt`; resume rebases
 * `goalStartedAt` so the paused span is excluded from the elapsed time.
 */
function resolveThreadGoalPatch(
  command: Extract<OrchestrationCommand, { type: "thread.meta.update" }>,
  currentThread: OrchestrationThread,
  occurredAt: string,
): {
  goal?: string;
  goalStartedAt?: string | null;
  goalPausedAt?: string | null;
  goalAchievements?: readonly ThreadGoalAchievement[];
} {
  const activeGoal = (currentThread.goal ?? "").trim();
  if (command.goalAchieved === true) {
    if (activeGoal.length === 0) {
      return {};
    }
    const startedMs = Date.parse(currentThread.goalStartedAt ?? "");
    const pausedMs = Date.parse(currentThread.goalPausedAt ?? "");
    const occurredMs = Date.parse(occurredAt);
    const endMs = Number.isFinite(pausedMs) ? pausedMs : occurredMs;
    const elapsedMs =
      Number.isFinite(startedMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startedMs) : null;
    const achievement: ThreadGoalAchievement = {
      goal: activeGoal,
      achievedAt: occurredAt,
      elapsedMs,
      turnId: currentThread.latestTurn?.turnId ?? null,
    };
    return {
      goal: "",
      goalStartedAt: null,
      goalPausedAt: null,
      goalAchievements: [...(currentThread.goalAchievements ?? []), achievement].slice(
        -THREAD_GOAL_ACHIEVEMENTS_MAX_COUNT,
      ),
    };
  }
  if (command.goal !== undefined) {
    if (command.goal.trim().length === 0) {
      return { goal: command.goal, goalStartedAt: null, goalPausedAt: null };
    }
    if (activeGoal.length > 0) {
      return { goal: command.goal };
    }
    return { goal: command.goal, goalStartedAt: occurredAt, goalPausedAt: null };
  }
  if (command.goalPaused === undefined || activeGoal.length === 0) {
    return {};
  }
  const pausedAt = currentThread.goalPausedAt ?? null;
  if (command.goalPaused) {
    return pausedAt === null ? { goalPausedAt: occurredAt } : {};
  }
  if (pausedAt === null) {
    return {};
  }
  const startedMs = Date.parse(currentThread.goalStartedAt ?? "");
  const pausedMs = Date.parse(pausedAt);
  const occurredMs = Date.parse(occurredAt);
  const rebasedStartedAt =
    Number.isFinite(startedMs) && Number.isFinite(pausedMs) && Number.isFinite(occurredMs)
      ? new Date(occurredMs - Math.max(0, pausedMs - startedMs)).toISOString()
      : occurredAt;
  return { goalStartedAt: rebasedStartedAt, goalPausedAt: null };
}

function resolveThreadWorkspaceMetadataPatch(
  projectKind: ProjectKind | undefined,
  command: Extract<OrchestrationCommand, { type: "thread.meta.update" }>,
  currentThread: OrchestrationThread,
) {
  if (isGroupContainerKind(projectKind)) {
    return {
      envMode: "local" as const,
      branch: null,
      worktreePath: null,
      workingDirectory:
        command.workingDirectory !== undefined
          ? command.workingDirectory
          : command.worktreePath
            ? command.worktreePath
            : (currentThread.workingDirectory ?? currentThread.worktreePath),
      associatedWorktreePath: null,
      associatedWorktreeBranch: null,
      associatedWorktreeRef: null,
      createBranchFlowCompleted: false,
    };
  }

  return {
    ...(command.envMode !== undefined ? { envMode: command.envMode } : {}),
    ...(command.branch !== undefined ? { branch: command.branch } : {}),
    ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
    ...(command.workingDirectory !== undefined
      ? { workingDirectory: command.workingDirectory }
      : {}),
    ...deriveCommandAssociatedWorktreeMetadataPatch({
      ...(command.branch !== undefined ? { branch: command.branch } : {}),
      ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
      ...(command.associatedWorktreePath !== undefined
        ? { associatedWorktreePath: command.associatedWorktreePath }
        : {}),
      ...(command.associatedWorktreeBranch !== undefined
        ? { associatedWorktreeBranch: command.associatedWorktreeBranch }
        : {}),
      ...(command.associatedWorktreeRef !== undefined
        ? { associatedWorktreeRef: command.associatedWorktreeRef }
        : {}),
    }),
    ...(command.createBranchFlowCompleted !== undefined
      ? { createBranchFlowCompleted: command.createBranchFlowCompleted }
      : {}),
  };
}

function deriveConversationRollbackTarget(
  messages: OrchestrationReadModel["threads"][number]["messages"],
  messageId: string,
): {
  readonly role: OrchestrationReadModel["threads"][number]["messages"][number]["role"];
  readonly removedTurnIds: ReadonlySet<string>;
} | null {
  const targetIndex = messages.findIndex((message) => message.id === messageId);
  if (targetIndex < 0) {
    return null;
  }

  return {
    role: messages[targetIndex]!.role,
    removedTurnIds: new Set(collectTailTurnIds({ messages, messageId })),
  };
}

function shouldEmitThreadModelChangedActivity(input: {
  readonly thread: OrchestrationReadModel["threads"][number];
  readonly nextModelSelection: { readonly model: string };
}): boolean {
  const previousModel = input.thread.modelSelection.model.trim();
  const nextModel = input.nextModelSelection.model.trim();
  if (previousModel.length === 0 || nextModel.length === 0 || previousModel === nextModel) {
    return false;
  }
  return (
    input.thread.latestTurn !== null ||
    input.thread.messages.length > 0 ||
    input.thread.session !== null
  );
}

function asJsonRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function latestFailedServerOverloadActivity(
  thread: OrchestrationReadModel["threads"][number],
  turnId: TurnId,
): boolean {
  const latest = thread.activities
    .filter((activity) => activity.kind === "turn.completed" && activity.turnId === turnId)
    .toSorted(
      (left, right) =>
        (right.sequence ?? -1) - (left.sequence ?? -1) ||
        right.createdAt.localeCompare(left.createdAt) ||
        right.id.localeCompare(left.id),
    )
    .at(0);
  if (!latest) return false;
  const payload = asJsonRecord(latest.payload);
  return payload?.state === "failed" && payload.errorInfo === "serverOverloaded";
}

function latestSafetyBufferingActivity(
  thread: OrchestrationReadModel["threads"][number],
  turnId: TurnId,
): {
  readonly activity: OrchestrationReadModel["threads"][number]["activities"][number];
  readonly targetModel: string;
} | null {
  const latest = readLatestSafetyBufferingActivity(thread.activities, turnId);
  const targetModel = latest?.payload.fasterModel?.trim() ?? "";
  return latest &&
    isSafetyBufferingBoundToThread(latest.payload, thread.id) &&
    latest.payload.showBufferingUi &&
    targetModel
    ? { activity: latest.activity, targetModel }
    : null;
}

function latestTurnCompletionPayload(
  thread: OrchestrationReadModel["threads"][number],
  turnId: TurnId,
): Record<string, unknown> | null {
  const latest = thread.activities
    .filter((activity) => activity.kind === "turn.completed" && activity.turnId === turnId)
    .toSorted(
      (left, right) =>
        (right.sequence ?? -1) - (left.sequence ?? -1) ||
        right.createdAt.localeCompare(left.createdAt) ||
        right.id.localeCompare(left.id),
    )
    .at(0);
  return asJsonRecord(latest?.payload);
}

function latestTurnIsRetryableFailure(
  thread: OrchestrationReadModel["threads"][number],
  turnId: TurnId,
): boolean {
  const payload = latestTurnCompletionPayload(thread, turnId);
  return (
    payload?.state === "failed" &&
    isRetryableCodexTurnFailure({
      state: payload.state,
      errorInfo: payload.errorInfo,
      errorMessage: payload.errorMessage,
    })
  );
}

function hasPendingThreadInteraction(thread: OrchestrationReadModel["threads"][number]): boolean {
  if (thread.hasPendingApprovals === true || thread.hasPendingUserInput === true) {
    return true;
  }
  return (thread.pendingInteractions ?? []).some(
    (interaction) => interaction.status !== "confirmed",
  );
}

function hasQueuedTurnConflict(thread: OrchestrationReadModel["threads"][number]): boolean {
  const latestCompletedAt = thread.latestTurn?.completedAt;
  if (latestCompletedAt === null || latestCompletedAt === undefined) return true;
  // A queued user turn is represented durably by a user message whose turn has
  // not been bound yet. It must not be hidden behind the provider queue table,
  // which is deliberately outside this serialized command read model.
  if (
    typeof thread.latestUserMessageAt === "string" &&
    thread.latestUserMessageAt > latestCompletedAt
  ) {
    return true;
  }
  if (
    thread.messages.some(
      (message) =>
        message.role === "user" &&
        message.source === "native" &&
        (message.turnId === null || message.turnId === undefined),
    )
  ) {
    return true;
  }
  // Imported/replayed snapshots may carry a typed queue lifecycle activity;
  // retain the fail-closed check for that representation as well.
  return thread.activities.some(
    (activity) =>
      activity.turnId === thread.latestTurn?.turnId &&
      (activity.kind === "turn.queued" ||
        activity.kind === "turn.dispatch-queued" ||
        activity.kind === "provider.turn.queued"),
  );
}

function isCodexForegroundThread(thread: OrchestrationReadModel["threads"][number]): boolean {
  if (thread.parentThreadId != null || thread.subagentAgentId != null) {
    return false;
  }
  if (thread.session && thread.session.threadId !== thread.id) {
    return false;
  }
  const provider =
    thread.session?.providerName ??
    inferLegacyProviderKindFromModelSelection(thread.modelSelection);
  return provider === "codex";
}

/**
 * A positioned drop can legitimately be an exact no-op.  Keep that outcome
 * separate from the event union so the engine can acknowledge it without
 * fabricating an order event or advancing the durable revision.
 */
export interface SidebarOrderNoopDecision {
  readonly _tag: "SidebarOrderNoopDecision";
  readonly sidebarOrderRevision: SidebarOrderRevision;
}

/** Matches the historical Moss contract cap for thread markers per thread. */
const THREAD_MARKERS_MAX_COUNT = 200;

function sidebarOrderRevisionOrZero(
  revision: SidebarOrderRevision | number | undefined,
): SidebarOrderRevision {
  return SidebarOrderRevision.makeUnsafe(revision ?? 0);
}

function nextSidebarOrderRevision(
  revision: SidebarOrderRevision | number | undefined,
): SidebarOrderRevision {
  return SidebarOrderRevision.makeUnsafe((revision ?? 0) + 1);
}

function currentSidebarOrderItems(
  readModel: OrchestrationReadModel,
  workspacePaths?: SpaceAssignmentWorkspacePaths,
): OrchestrationSidebarOrderItem[] {
  const items: OrchestrationSidebarOrderItem[] = readModel.sidebarOrderItems
    ? [...readModel.sidebarOrderItems]
    : [];
  if (readModel.sidebarOrderItems === undefined) {
    for (const section of readModel.sidebarSections ?? []) {
      for (const item of section.items) {
        items.push({
          key: item.key,
          itemType: item.itemType,
          destination: "custom",
          sectionId: section.id,
          sectionCreatedAt: section.createdAt,
          sortOrder: item.sortOrder,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        });
      }
    }
  }
  const existingProjectKeys = new Set(
    items.filter((item) => item.itemType === "project").map((item) => item.key),
  );
  for (const project of readModel.projects) {
    if (
      project.deletedAt !== null ||
      !isOrdinaryProjectRow({
        projectKind: project.kind,
        projectTitle: project.title,
        projectWorkspaceRoot: project.workspaceRoot,
        workspacePaths,
      })
    ) {
      continue;
    }
    const key = `project:${project.id}` as OrchestrationSidebarOrderItem["key"];
    if (existingProjectKeys.has(key)) continue;
    const destination = project.isPinned ? "pinned" : "default";
    items.push({
      key,
      itemType: "project",
      destination,
      sectionId: null,
      sectionCreatedAt: null,
      sortOrder: items.filter((item) => item.destination === destination).length,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    });
  }
  for (const thread of readModel.threads) {
    if (thread.deletedAt !== null || thread.archivedAt !== null) continue;
    const key = `thread:${thread.id}`;
    if (items.some((item) => item.key === key)) continue;
    if (thread.parentThreadId !== null && thread.parentThreadId !== undefined && !thread.isPinned) {
      continue;
    }
    const destination = thread.isPinned ? "pinned" : "default";
    items.push({
      key: key as OrchestrationSidebarOrderItem["key"],
      itemType: "thread",
      destination,
      sectionId: null,
      sectionCreatedAt: null,
      sortOrder: items.filter((item) => item.destination === destination).length,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    });
  }
  return compactSidebarOrderItems(items);
}

function requireSidebarOrderAdmission(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly expectedRevision?: SidebarOrderRevision | undefined;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const migrationState = input.readModel.sidebarOrderMigrationState ?? "ready";
  if (
    migrationState === "legacy_import_required" &&
    input.command.type !== "sidebar-order.legacy.import"
  ) {
    return Effect.fail(
      new OrchestrationCommandInvariantError({
        commandType: input.command.type,
        detail: "SIDEBAR_ORDER_MIGRATION_REQUIRED: hydrate the legacy sidebar before ordering it.",
      }),
    );
  }
  const expected = input.expectedRevision;
  const current = sidebarOrderRevisionOrZero(input.readModel.sidebarOrderRevision);
  // Revision fencing is required for explicit sidebar-ordering commands. Thread
  // lifecycle commands (archive/unarchive/delete) also move the order, but
  // server-internal issuers (retention sweeps, reactor cleanup, recovery) do
  // not track the revision, so they are admitted without one and simply bump it.
  const revisionRequired =
    input.command.type !== "sidebar-order.legacy.import" &&
    (input.command.type.startsWith("sidebar-section.") ||
      input.command.type.startsWith("sidebar-projects.") ||
      input.command.type.startsWith("sidebar-order."));
  if (revisionRequired && expected === undefined) {
    return Effect.fail(
      new OrchestrationCommandInvariantError({
        commandType: input.command.type,
        detail:
          "SIDEBAR_ORDER_REVISION_REQUIRED: ordered commands must carry the current revision.",
      }),
    );
  }
  if (expected !== undefined && expected !== current) {
    return Effect.fail(
      new OrchestrationCommandInvariantError({
        commandType: input.command.type,
        detail: `SIDEBAR_ORDER_REVISION_CONFLICT: current revision ${current}.`,
      }),
    );
  }
  return Effect.void;
}

function listActiveSidebarSections(readModel: OrchestrationReadModel) {
  return (readModel.sidebarSections ?? [])
    .filter((section) => section.deletedAt === null)
    .toSorted((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
}

function findSidebarSection(readModel: OrchestrationReadModel, sectionId: string) {
  return listActiveSidebarSections(readModel).find((section) => section.id === sectionId);
}

function findThreadSidebarSection(readModel: OrchestrationReadModel, threadId: string) {
  return listActiveSidebarSections(readModel).find((section) =>
    section.items.some((item) => item.key === "thread:" + threadId),
  );
}

function archiveThreadPlacement(
  threadId: OrchestrationThread["id"],
  sections: ReadonlyArray<NonNullable<OrchestrationReadModel["sidebarSections"]>[number]>,
  explicitSectionByThreadId: ReadonlyMap<OrchestrationThread["id"], string>,
  orderItems?: ReadonlyArray<OrchestrationSidebarOrderItem>,
): ThreadArchivedSidebarPlacement | undefined {
  const durableItem = orderItems?.find((item) => item.key === `thread:${threadId}`);
  if (durableItem !== undefined) {
    return {
      destination: durableItem.destination,
      sectionId: durableItem.sectionId,
      sectionCreatedAt: durableItem.sectionCreatedAt,
      sortOrder: durableItem.sortOrder,
    };
  }
  const sectionId = explicitSectionByThreadId.get(threadId);
  if (sectionId === undefined) return undefined;
  const section = sections.find((candidate) => candidate.id === sectionId);
  const item = section?.items.find((candidate) => candidate.key === `thread:${threadId}`);
  if (section === undefined || item === undefined) return undefined;
  return {
    destination: "custom",
    sectionId: section.id,
    sectionCreatedAt: section.createdAt,
    sortOrder: item.sortOrder,
  };
}

function activeThreadHasInactiveAncestor(input: {
  readonly threadId: OrchestrationThread["id"];
  readonly rootThreadId: OrchestrationThread["id"];
  readonly threadsById: ReadonlyMap<OrchestrationThread["id"], OrchestrationThread>;
}): boolean {
  const visited = new Set<OrchestrationThread["id"]>();
  let currentThreadId = input.threadId;
  while (currentThreadId !== input.rootThreadId) {
    if (visited.has(currentThreadId)) return true;
    visited.add(currentThreadId);
    const current = input.threadsById.get(currentThreadId);
    if (current === undefined) return true;
    const parentThreadId = current.parentThreadId ?? null;
    if (parentThreadId === null) return true;
    const parent = input.threadsById.get(parentThreadId);
    if (parent === undefined || parent.deletedAt !== null || (parent.archivedAt ?? null) !== null) {
      return true;
    }
    currentThreadId = parentThreadId;
  }
  return false;
}

function rejectArchiveDetail(threadId: string, reason: string): string {
  return `Thread archive cascade for '${threadId}' was rejected: ${reason}`;
}

function requireSidebarSection(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly sectionId: string;
}) {
  const section = findSidebarSection(input.readModel, input.sectionId);
  return section === undefined
    ? Effect.fail(
        new OrchestrationCommandInvariantError({
          commandType: input.command.type,
          detail: "Sidebar section '" + input.sectionId + "' does not exist.",
        }),
      )
    : Effect.succeed(section);
}

function requireSidebarSectionNameAvailable(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly name: string;
  readonly excludeSectionId?: string;
}) {
  const normalizedName = input.name.trim().toLocaleLowerCase();
  const duplicate = listActiveSidebarSections(input.readModel).find(
    (section) =>
      section.id !== input.excludeSectionId &&
      section.name.trim().toLocaleLowerCase() === normalizedName,
  );
  return duplicate === undefined
    ? Effect.void
    : Effect.fail(
        new OrchestrationCommandInvariantError({
          commandType: input.command.type,
          detail: "Sidebar section name '" + input.name + "' is already in use.",
        }),
      );
}

export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(function* ({
  command,
  readModel,
  workspacePaths,
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
  /** Reserved container roots; when provided, space assignment rejects legacy chat containers. */
  readonly workspacePaths?: SpaceAssignmentWorkspacePaths | undefined;
}): Effect.fn.Return<
  | Omit<OrchestrationEvent, "sequence">
  | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>
  | SidebarOrderNoopDecision,
  OrchestrationCommandInvariantError
> {
  switch (command.type) {
    case "space.create": {
      yield* requireSpaceAbsent({ readModel, command, spaceId: command.spaceId });
      if (command.spaceId === RESERVED_VOID_SPACE_ID) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "The reserved Void identity cannot be used for a custom space.",
        });
      }
      yield* requireSpaceNameAvailable({ readModel, command, name: command.name });
      const activeSpaces = listActiveSpaces(readModel);
      if (activeSpaces.length >= SPACES_MAX_COUNT) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `A maximum of ${SPACES_MAX_COUNT} custom spaces is supported.`,
        });
      }
      const sortOrder = activeSpaces.reduce(
        (maximum, space) => Math.max(maximum, space.sortOrder + 1),
        0,
      );
      return {
        ...withEventBase({
          aggregateKind: "space",
          aggregateId: command.spaceId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "space.created",
        payload: {
          spaceId: command.spaceId,
          name: command.name,
          icon: command.icon,
          sortOrder,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "space.meta.update": {
      const existingSpace = yield* requireSpace({ readModel, command, spaceId: command.spaceId });
      // Fields equal to the current value are not changes: a Save with nothing edited (or a
      // rename that resends the icon) must not append an event or bump updatedAt.
      const nextName =
        command.name !== undefined && command.name !== existingSpace.name
          ? command.name
          : undefined;
      const nextIcon =
        command.icon !== undefined && command.icon !== existingSpace.icon
          ? command.icon
          : undefined;
      if (nextName === undefined && nextIcon === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Space metadata update must change a name or icon.",
        });
      }
      if (nextName !== undefined) {
        yield* requireSpaceNameAvailable({
          readModel,
          command,
          name: nextName,
          excludeSpaceId: command.spaceId,
        });
      }
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "space",
          aggregateId: command.spaceId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "space.meta-updated",
        payload: {
          spaceId: command.spaceId,
          ...(nextName !== undefined ? { name: nextName } : {}),
          ...(nextIcon !== undefined ? { icon: nextIcon } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "space.reorder": {
      yield* requireSpace({ readModel, command, spaceId: command.spaceId });
      const activeSpaceIds = listActiveSpaces(readModel).map((space) => space.id);
      const orderedSpaceIds = command.orderedSpaceIds;
      const orderedSpaceIdSet = new Set(orderedSpaceIds);
      const hasExactActiveSet =
        orderedSpaceIds.length === activeSpaceIds.length &&
        orderedSpaceIdSet.size === activeSpaceIds.length &&
        activeSpaceIds.every((spaceId) => orderedSpaceIdSet.has(spaceId));
      if (!hasExactActiveSet) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Space order must contain every active custom space exactly once.",
        });
      }
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "space",
          aggregateId: command.spaceId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "space.order-updated",
        payload: {
          spaceId: command.spaceId,
          orderedSpaceIds,
          updatedAt: occurredAt,
        },
      };
    }

    case "space.delete": {
      yield* requireSpace({ readModel, command, spaceId: command.spaceId });
      const occurredAt = nowIso();
      // The deletion event owns the re-filing invariant. Projectors clear every matching
      // assignment in one pass, avoiding an unbounded event fanout for large spaces while
      // still including soft-deleted projects that a recovery flow could resurrect.
      return {
        ...withEventBase({
          aggregateKind: "space",
          aggregateId: command.spaceId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "space.deleted",
        payload: { spaceId: command.spaceId, deletedAt: occurredAt },
      };
    }

    case "space.projects.assign": {
      yield* requireSpace({ readModel, command, spaceId: command.spaceId });
      const occurredAt = nowIso();
      const seenProjectIds = new Set<string>();
      const events: Array<Omit<OrchestrationEvent, "sequence">> = [];
      for (const projectId of command.projectIds) {
        if (seenProjectIds.has(projectId)) continue;
        seenProjectIds.add(projectId);
        const project = yield* requireProject({ readModel, command, projectId });
        // Already-filed and concurrently-deleted projects are settled, not errors: the
        // batch stays atomic for real failures without rejecting a raced retry.
        if (project.deletedAt !== null || project.spaceId === command.spaceId) continue;
        if ((project.kind ?? "project") !== "project") {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "Only ordinary projects can be assigned to a space.",
          });
        }
        yield* requireSpaceAssignableProject({
          command,
          projectTitle: project.title,
          projectWorkspaceRoot: project.workspaceRoot,
          workspacePaths,
        });
        events.push({
          ...withEventBase({
            aggregateKind: "project",
            aggregateId: project.id,
            occurredAt,
            commandId: command.commandId,
          }),
          type: "project.meta-updated" as const,
          payload: {
            projectId: project.id,
            spaceId: command.spaceId,
            updatedAt: occurredAt,
          },
        });
      }
      if (events.length === 0) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "None of the selected projects need to be assigned to this space.",
        });
      }
      return events;
    }

    case "project.create": {
      yield* requireProjectAbsent({
        readModel,
        command,
        projectId: command.projectId,
      });
      const events: Array<Omit<OrchestrationEvent, "sequence">> = [];
      const staleProjects: Array<OrchestrationReadModel["projects"][number]> = [];
      const nextProjectKind = command.kind ?? "project";
      const additionalFolders = command.additionalFolders ?? [];
      if (additionalFolders.length > 0) {
        if (nextProjectKind !== "project") {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "Only ordinary projects can have additional folders.",
          });
        }
        const folderProblem = findProjectFolderProblem(
          [command.workspaceRoot, ...additionalFolders],
          { platform: process.platform },
        );
        if (folderProblem !== null) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: folderProblem,
          });
        }
      }
      if (nextProjectKind === "project") {
        // The app-managed Studio container owns its root exclusively and is never retired here:
        // silently deleting it would orphan Studio threads, so adding its folder as a project
        // is rejected outright.
        const existingStudioProject = listActiveProjectsByWorkspaceRoot(
          readModel,
          command.workspaceRoot,
          { kinds: GROUP_CONTAINER_PROJECT_KIND_SET },
        )[0];
        if (existingStudioProject) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Project '${existingStudioProject.id}' already uses workspace root '${existingStudioProject.workspaceRoot}'.`,
          });
        }
        const existingProjects = listActiveProjectsByWorkspaceRoot(
          readModel,
          command.workspaceRoot,
        );
        for (const existingProject of existingProjects) {
          const remainingThreads = listThreadsByProjectId(readModel, existingProject.id).filter(
            (thread) => thread.deletedAt === null,
          );
          if (remainingThreads.length > 0 || command.preserveExistingProject) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `Project '${existingProject.id}' already uses workspace root '${existingProject.workspaceRoot}'.`,
            });
          }
          staleProjects.push(existingProject);
        }

        for (const staleProject of staleProjects) {
          // A removed folder can leave an active project shell with no live threads.
          // Retire that stale shell so re-adding the same folder creates a fresh project.
          events.push({
            ...withEventBase({
              aggregateKind: "project",
              aggregateId: staleProject.id,
              occurredAt: command.createdAt,
              commandId: command.commandId,
            }),
            type: "project.deleted",
            payload: {
              projectId: staleProject.id,
              deletedAt: command.createdAt,
            },
          });
        }
      }
      if (isGroupContainerKind(nextProjectKind)) {
        // Cross-kind on purpose: a regular project already using this root would otherwise
        // coexist with the group container, breaking workspace-root-to-project uniqueness
        // that shell snapshot mapping and duplicate recovery rely on.
        const existingOwningProject = listActiveProjectsByWorkspaceRoot(
          readModel,
          command.workspaceRoot,
          { kinds: WORKSPACE_OWNING_PROJECT_KIND_SET },
        )[0];
        if (existingOwningProject) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Project '${existingOwningProject.id}' already uses workspace root '${existingOwningProject.workspaceRoot}'.`,
          });
        }
      }
      yield* validateProjectPinLimit({
        command,
        readModel,
        projectId: command.projectId,
        nextKind: nextProjectKind,
        staleProjectIds: new Set(staleProjects.map((project) => project.id)),
      });

      // Filing a new project into the requested space is best-effort: creation must never
      // fail because the space raced a delete, so an unusable target degrades to Void.
      const requestedSpace =
        command.spaceId != null ? findSpaceById(readModel, command.spaceId) : undefined;
      const creationSpaceId =
        command.spaceId != null &&
        nextProjectKind === "project" &&
        requestedSpace !== undefined &&
        requestedSpace.deletedAt === null &&
        !isLegacyHomeChatContainerRow({
          projectTitle: command.title,
          projectWorkspaceRoot: command.workspaceRoot,
          workspacePaths,
        })
          ? command.spaceId
          : null;

      events.push({
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "project.created",
        payload: {
          projectId: command.projectId,
          kind: nextProjectKind,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          defaultModelSelection: command.defaultModelSelection ?? null,
          scripts: [],
          isPinned: command.isPinned,
          spaceId: creationSpaceId,
          additionalFolders,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      });
      return events.length === 1 ? events[0]! : events;
    }

    case "project.meta.update": {
      const existingProject = yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const nextProjectKind = command.kind ?? existingProject.kind ?? "project";
      const requestedSpaceId =
        command.spaceId !== undefined
          ? command.spaceId
          : nextProjectKind !== "project" && existingProject.spaceId !== null
            ? null
            : undefined;
      const effectiveSpaceId =
        requestedSpaceId !== undefined ? requestedSpaceId : existingProject.spaceId;
      const changedSpaceId =
        requestedSpaceId !== undefined && requestedSpaceId !== existingProject.spaceId
          ? requestedSpaceId
          : undefined;
      const hasOtherMetadataInput =
        command.kind !== undefined ||
        command.title !== undefined ||
        command.workspaceRoot !== undefined ||
        command.defaultModelSelection !== undefined ||
        command.scripts !== undefined ||
        command.isPinned !== undefined;
      const isLegacyHomeChatContainer = isLegacyHomeChatContainerRow({
        projectTitle: existingProject.title,
        projectWorkspaceRoot: existingProject.workspaceRoot,
        workspacePaths,
      });
      if (
        command.title !== undefined &&
        command.title !== existingProject.title &&
        isLegacyHomeChatContainer
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "The legacy Chats container cannot be renamed.",
        });
      }
      if (
        command.workspaceRoot !== undefined &&
        !workspaceRootsEqual(command.workspaceRoot, existingProject.workspaceRoot, {
          platform: process.platform,
        }) &&
        isLegacyHomeChatContainer
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "The legacy Chats container workspace root cannot be changed.",
        });
      }
      // Relocating the primary folder must keep the folder set distinct and un-nested.
      if (
        command.workspaceRoot !== undefined &&
        (existingProject.additionalFolders ?? []).length > 0
      ) {
        const folderProblem = findProjectFolderProblem(
          [command.workspaceRoot, ...(existingProject.additionalFolders ?? [])],
          { platform: process.platform },
        );
        if (folderProblem !== null) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: folderProblem,
          });
        }
      }
      if (effectiveSpaceId !== null) {
        // Assignability is an invariant of the resulting row, not only of commands that
        // explicitly set spaceId. Metadata-only updates must not turn an already-filed
        // project into the legacy Home/Chats container while retaining its space.
        yield* requireSpaceAssignableProject({
          command,
          projectTitle: command.title ?? existingProject.title,
          projectWorkspaceRoot: command.workspaceRoot ?? existingProject.workspaceRoot,
          workspacePaths,
        });
      }
      if (command.spaceId !== undefined && command.spaceId !== null) {
        if (existingProject.deletedAt !== null) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "Deleted projects cannot be assigned to a space.",
          });
        }
        if (nextProjectKind !== "project") {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "Only ordinary projects can be assigned to a space.",
          });
        }
        yield* requireSpace({ readModel, command, spaceId: command.spaceId });
      }
      if (
        requestedSpaceId !== undefined &&
        changedSpaceId === undefined &&
        !hasOtherMetadataInput
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Project is already assigned to this space.",
        });
      }
      // Ownership must hold for the project's *effective* root, not only when the root field is
      // present on the command: a kind-only update (e.g. chat -> studio) would otherwise slip a
      // second workspace-owning project onto a root that a project- or studio-kind row already
      // claims, bypassing the same cross-kind rule project.create enforces.
      const ownershipMayChange =
        command.workspaceRoot !== undefined ||
        (command.kind !== undefined && command.kind !== (existingProject.kind ?? "project"));
      if (ownershipMayChange && nextProjectKind !== "chat") {
        yield* requireProjectWorkspaceRootAvailable({
          readModel,
          command,
          workspaceRoot: command.workspaceRoot ?? existingProject.workspaceRoot,
          excludeProjectId: command.projectId,
          kinds: WORKSPACE_OWNING_PROJECT_KIND_SET,
        });
      }
      yield* validateProjectPinLimit({
        command,
        readModel,
        projectId: command.projectId,
        nextKind: nextProjectKind,
        nextDeletedAt: existingProject.deletedAt,
        wasPinned: existingProject.isPinned === true,
      });
      const occurredAt = nowIso();
      const event = {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(command.kind !== undefined ? { kind: command.kind } : {}),
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.workspaceRoot !== undefined ? { workspaceRoot: command.workspaceRoot } : {}),
          ...(command.defaultModelSelection !== undefined
            ? { defaultModelSelection: command.defaultModelSelection }
            : {}),
          ...(command.scripts !== undefined ? { scripts: command.scripts } : {}),
          ...(command.isPinned !== undefined ? { isPinned: command.isPinned } : {}),
          ...(changedSpaceId !== undefined ? { spaceId: changedSpaceId } : {}),
          updatedAt: occurredAt,
        },
      } satisfies Omit<Extract<OrchestrationEvent, { type: "project.meta-updated" }>, "sequence">;
      return yield* withProjectRelocationEvents({
        event,
        previousProject: existingProject,
        readModel,
      });
    }

    case "project.delete": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireProjectHasNoThreads({
        readModel,
        command,
        projectId: command.projectId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "project.deleted",
        payload: {
          projectId: command.projectId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.create": {
      const project = yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Provider-native threads mirror subagents the provider already runs;
      // Moss never starts a session for them, so the Auto-mode capability
      // check can only reject the projection (and durably poison the runtime
      // journal replaying it), never prevent an unverified Auto session.
      if (command.creationSource !== "provider_native") {
        yield* validateAutoRuntimeMode(command, command.modelSelection, command.runtimeMode);
      }
      const sidechatContext = command.sidechatContext ?? null;
      if (sidechatContext !== null) {
        yield* validateStandaloneSidechatCreate(command);
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          ...resolveCreatedThreadWorkspaceMetadata(project.kind, command),
          createBranchFlowCompleted: isGroupContainerKind(project.kind)
            ? false
            : command.createBranchFlowCompleted,
          isPinned: command.isPinned,
          parentThreadId: command.parentThreadId,
          ...(command.creationSource !== undefined
            ? {
                creationSource: command.creationSource,
                sourceThreadId: command.sourceThreadId ?? null,
                sourceTurnId: command.sourceTurnId ?? null,
                gatewayOperationId: command.gatewayOperationId ?? null,
                gatewayOperationIndex: command.gatewayOperationIndex ?? null,
              }
            : {}),
          subagentAgentId: command.subagentAgentId,
          subagentNickname: command.subagentNickname,
          subagentRole: command.subagentRole,
          forkSourceThreadId: null,
          // A standalone sidechat starts its inactivity clock at creation, like a forked one.
          ...(sidechatContext !== null
            ? {
                sidechatContext,
                sidechatLastActivityAt: command.createdAt,
                sidechatExpiredAt: null,
              }
            : {}),
          lastKnownPr: command.lastKnownPr,
          handoff: null,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.handoff.create": {
      const project = yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireThread({
        readModel,
        command,
        threadId: command.sourceThreadId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      yield* validateAutoRuntimeMode(command, command.modelSelection, command.runtimeMode);

      const sourceThread = yield* requireThread({
        readModel,
        command,
        threadId: command.sourceThreadId,
      });
      if (sourceThread.projectId !== command.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Source thread '${command.sourceThreadId}' belongs to a different project.`,
        });
      }
      if (sourceThread.handoff !== null && !hasNativeHandoffMessages(sourceThread)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Source thread '${command.sourceThreadId}' must contain at least one native chat message after handoff before it can be handed off again.`,
        });
      }

      const createdEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          ...resolveCreatedThreadWorkspaceMetadata(project.kind, command),
          createBranchFlowCompleted: isGroupContainerKind(project.kind)
            ? false
            : command.createBranchFlowCompleted,
          isPinned: false,
          parentThreadId: null,
          subagentAgentId: null,
          subagentNickname: null,
          subagentRole: null,
          forkSourceThreadId: null,
          handoff: {
            sourceThreadId: command.sourceThreadId,
            sourceProvider: sourceThread.modelSelection.provider,
            importedAt: command.createdAt,
            bootstrapStatus: "pending",
          },
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };

      // Imported messages keep their source-thread timestamps so the transcript still
      // reads chronologically. They are not activity in this thread: the retention
      // clock floors on the new thread's own createdAt/updatedAt (see
      // `threadRetention.getThreadLastActivityMs`) so a handoff of an old
      // conversation is never born past the retention cutoff.
      const importedMessageEvents: ReadonlyArray<Omit<OrchestrationEvent, "sequence">> = (
        command.importedMessages ?? []
      ).map((message) => ({
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: message.messageId,
          role: message.role,
          text: message.text,
          ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
          turnId: null,
          streaming: false,
          source: "handoff-import",
          createdAt: message.createdAt,
          updatedAt: message.updatedAt,
        },
      }));

      return [createdEvent, ...importedMessageEvents];
    }

    case "thread.fork.create": {
      const project = yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireThread({
        readModel,
        command,
        threadId: command.sourceThreadId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      yield* validateAutoRuntimeMode(command, command.modelSelection, command.runtimeMode);

      const sourceThread = yield* requireThread({
        readModel,
        command,
        threadId: command.sourceThreadId,
      });
      if (sourceThread.projectId !== command.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Source thread '${command.sourceThreadId}' belongs to a different project.`,
        });
      }

      const createdEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          title: command.sidechatSourceThreadId
            ? command.title
            : buildForkThreadTitle(
                sourceThread,
                listThreadsByProjectId(readModel, command.projectId),
              ),
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          ...resolveCreatedThreadWorkspaceMetadata(project.kind, command),
          createBranchFlowCompleted: isGroupContainerKind(project.kind)
            ? false
            : command.createBranchFlowCompleted,
          isPinned: false,
          parentThreadId: null,
          subagentAgentId: null,
          subagentNickname: null,
          subagentRole: null,
          forkSourceThreadId: command.sourceThreadId,
          // Resolved against the source lazily, at the provider fork: an
          // unknown or mid-turn point falls back to the imported transcript.
          ...(command.throughMessageId !== undefined
            ? { forkSourceMessageId: command.throughMessageId }
            : {}),
          sidechatSourceThreadId: command.sidechatSourceThreadId,
          sidechatLastActivityAt: command.sidechatSourceThreadId ? command.createdAt : null,
          sidechatExpiredAt: null,
          handoff: null,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };

      // Imported messages keep their source-thread timestamps so the transcript still
      // reads chronologically. They are not activity in this thread: the retention
      // clock floors on the new thread's own createdAt/updatedAt (see
      // `threadRetention.getThreadLastActivityMs`) so a fork of an old conversation
      // is never born past the retention cutoff.
      // New clients send only `throughMessageId`: materialize the bounded prefix
      // from the canonical server projection instead of trusting renderer payloads.
      const materializedImportedMessages: ReadonlyArray<ThreadHandoffImportedMessage> =
        (command.importedMessages ?? []).length > 0
          ? (command.importedMessages ?? [])
          : command.throughMessageId != null
            ? (() => {
                const boundaryIndex = sourceThread.messages.findIndex(
                  (message) => message.id === command.throughMessageId,
                );
                if (boundaryIndex === -1) return [];
                return sourceThread.messages.slice(0, boundaryIndex + 1).map((message) => ({
                  // Fresh ids keep the fork transcript independent from the source.
                  messageId: MessageId.makeUnsafe(crypto.randomUUID()),
                  role: message.role === "user" ? ("user" as const) : ("assistant" as const),
                  text: message.text,
                  ...(message.attachments !== undefined
                    ? { attachments: message.attachments }
                    : {}),
                  createdAt: message.createdAt,
                  updatedAt: message.updatedAt,
                }));
              })()
            : [];
      const importedMessageEvents: ReadonlyArray<Omit<OrchestrationEvent, "sequence">> =
        materializedImportedMessages.map((message) => ({
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.message-sent",
          payload: {
            threadId: command.threadId,
            messageId: message.messageId,
            role: message.role,
            text: message.text,
            ...(message.dispatchOrigin !== undefined
              ? { dispatchOrigin: message.dispatchOrigin }
              : {}),
            ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
            turnId: null,
            streaming: false,
            source: "fork-import",
            createdAt: message.createdAt,
            updatedAt: message.updatedAt,
          },
        }));

      return [createdEvent, ...importedMessageEvents];
    }

    case "thread.sidechat.activity.record": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      if (!isSidechatThread(thread)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' is not a side chat.`,
        });
      }
      if (thread.sidechatExpiredAt) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Side chat '${command.threadId}' already expired.`,
        });
      }
      const lastActivityAt = latestSidechatActivityAt(
        thread.sidechatLastActivityAt,
        command.activityAt,
      );
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: lastActivityAt,
          commandId: command.commandId,
        }),
        type: "thread.sidechat-activity-recorded",
        payload: { threadId: command.threadId, lastActivityAt },
      };
    }

    case "thread.sidechat.expire": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      if (!isSidechatThread(thread)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' is not a side chat.`,
        });
      }
      if (thread.sidechatExpiredAt) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Side chat '${command.threadId}' already expired.`,
        });
      }
      const lastActivityAt = thread.sidechatLastActivityAt ?? thread.updatedAt ?? thread.createdAt;
      if (!sidechatActivityInstantsEqual(lastActivityAt, command.expectedLastActivityAt)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Side chat '${command.threadId}' became active before expiry.`,
        });
      }
      if (
        thread.latestTurn?.state === "running" ||
        thread.session?.status === "starting" ||
        thread.session?.status === "running"
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Side chat '${command.threadId}' still has a running turn.`,
        });
      }
      if (thread.hasPendingApprovals || thread.hasPendingUserInput) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Side chat '${command.threadId}' still has a pending interaction.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.expiredAt,
          commandId: command.commandId,
        }),
        type: "thread.sidechat-expired",
        payload: {
          threadId: command.threadId,
          expectedLastActivityAt: command.expectedLastActivityAt,
          expiredAt: command.expiredAt,
        },
      };
    }

    case "thread.delete": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (threadHasCheckpointRevertInProgress(thread)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: checkpointRevertDeleteInProgressDetail(command.threadId),
        });
      }
      const occurredAt = nowIso();
      const deleteEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.deleted",
        payload: {
          threadId: command.threadId,
          deletedAt: occurredAt,
        },
      };
      return thread.claudeCacheReview
        ? [
            {
              ...withEventBase({
                aggregateKind: "thread",
                aggregateId: command.threadId,
                occurredAt,
                commandId: command.commandId,
              }),
              type: "thread.claude-cache-set" as const,
              payload: { threadId: command.threadId, review: null, updatedAt: occurredAt },
            },
            deleteEvent,
          ]
        : deleteEvent;
    }

    case "thread.archive": {
      yield* requireSidebarOrderAdmission({
        readModel,
        command,
        expectedRevision: command.expectedSidebarOrderRevision,
      });
      const rootThread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      // Subagent threads are only reachable through their parent, so archiving a
      // thread archives its still-active subagent subtree with it. The commanded
      // thread goes last: the command receipt records the final event's aggregate.
      const allDescendants = collectSubagentDescendants(readModel.threads, command.threadId);
      const activeThreads = [
        rootThread,
        ...allDescendants.filter(
          (thread) => thread.deletedAt === null && (thread.archivedAt ?? null) === null,
        ),
      ];
      const threadsById = new Map<OrchestrationThread["id"], OrchestrationThread>();
      for (const thread of readModel.threads) {
        if (!threadsById.has(thread.id)) threadsById.set(thread.id, thread);
      }
      // Archive is the user's cancel-everything escape hatch: the reactor
      // settles in-flight turns and cache reviews when the archived events
      // land, so an in-flight turn must not block the cascade (matches the
      // shipped Moss behavior the ProviderCommandReactor flows rely on).
      for (const thread of activeThreads) {
        if (
          thread.id !== rootThread.id &&
          activeThreadHasInactiveAncestor({
            threadId: thread.id,
            rootThreadId: rootThread.id,
            threadsById,
          })
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: rejectArchiveDetail(
              thread.id,
              "an active descendant is reachable through an archived or deleted ancestor",
            ),
          });
        }
      }

      const activeSections = listActiveSidebarSections(readModel);
      const durableOrderItems = currentSidebarOrderItems(readModel, workspacePaths);
      const ownerSections =
        readModel.sidebarOrderItems === undefined
          ? activeSections
          : activeSections.map((section) => ({
              ...section,
              items: durableOrderItems
                .filter(
                  (item) =>
                    item.itemType === "thread" &&
                    item.destination === "custom" &&
                    item.sectionId === section.id &&
                    item.sectionCreatedAt === section.createdAt,
                )
                .map((item) => ({
                  key: item.key,
                  itemType: "thread" as const,
                  sortOrder: item.sortOrder,
                  createdAt: item.createdAt,
                  updatedAt: item.updatedAt,
                })),
            }));
      const durablePinnedThreadIds =
        readModel.sidebarOrderItems === undefined
          ? readModel.threads
              .filter((thread) => thread.deletedAt === null && thread.isPinned === true)
              .map((thread) => thread.id)
          : durableOrderItems
              .filter(
                (item) =>
                  item.itemType === "thread" &&
                  item.destination === "pinned" &&
                  item.sectionId === null &&
                  item.sectionCreatedAt === null,
              )
              .map((item) => item.key.slice("thread:".length) as OrchestrationThread["id"]);
      const ownerResolution = resolveThreadPresentationOwners({
        sections: ownerSections,
        threads: readModel.threads.filter((thread) => thread.deletedAt === null),
        pinnedThreadIds: durablePinnedThreadIds,
      });
      const rootOwner = ownerResolution.owners.get(rootThread.id);
      if (
        rootOwner === undefined ||
        ownerResolution.unresolvedThreadIds.has(rootThread.id) ||
        ownerResolution.cycleThreadIds.has(rootThread.id) ||
        ownerResolution.duplicateThreadIds.has(rootThread.id) ||
        ownerResolution.corruptMembershipThreadIds.has(rootThread.id)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: rejectArchiveDetail(rootThread.id, "the root presentation owner is unresolved"),
        });
      }
      for (const thread of activeThreads) {
        if (
          ownerResolution.owners.get(thread.id) !== rootOwner ||
          ownerResolution.unresolvedThreadIds.has(thread.id) ||
          ownerResolution.cycleThreadIds.has(thread.id) ||
          ownerResolution.duplicateThreadIds.has(thread.id) ||
          ownerResolution.corruptMembershipThreadIds.has(thread.id)
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: rejectArchiveDetail(
              thread.id,
              "the affected cascade crosses a custom, pinned, default, or corrupt owner boundary",
            ),
          });
        }
      }

      const activeDescendantIds = activeThreads.slice(1).map((thread) => thread.id);
      const sidebarOrderRevision = nextSidebarOrderRevision(readModel.sidebarOrderRevision);
      return [...activeDescendantIds, rootThread.id].flatMap(
        (threadId): Array<Omit<OrchestrationEvent, "sequence">> => {
          const events: Array<Omit<OrchestrationEvent, "sequence">> = [];
          const review = readModel.threads.find(
            (entry) => entry.id === threadId,
          )?.claudeCacheReview;
          if (review) {
            events.push({
              ...withEventBase({
                aggregateKind: "thread",
                aggregateId: threadId,
                occurredAt,
                commandId: command.commandId,
              }),
              type: "thread.claude-cache-set",
              payload: { threadId, review: null, updatedAt: occurredAt },
            });
          }
          events.push({
            ...withEventBase({
              aggregateKind: "thread",
              aggregateId: threadId,
              occurredAt,
              commandId: command.commandId,
            }),
            type: "thread.archived",
            payload: {
              threadId,
              archivedAt: occurredAt,
              updatedAt: occurredAt,
              sidebarOrderRevision,
              ...(() => {
                const placement = archiveThreadPlacement(
                  threadId,
                  activeSections,
                  ownerResolution.explicitCustomSectionByThreadId,
                  currentSidebarOrderItems(readModel, workspacePaths),
                );
                return placement === undefined ? {} : { placement };
              })(),
            },
          });
          return events;
        },
      );
    }

    case "thread.unarchive": {
      yield* requireSidebarOrderAdmission({
        readModel,
        command,
        expectedRevision: command.expectedSidebarOrderRevision,
      });
      const rootThread = yield* requireThreadArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      // Restoring a parent brings back the subagent subtree that was archived with
      // it. The commanded thread goes last: the command receipt records the final
      // event's aggregate.
      const cohortId = rootThread.archivedByCommandId ?? null;
      const restoredThreads = [
        rootThread,
        ...(cohortId === null
          ? []
          : collectSubagentDescendants(readModel.threads, command.threadId).filter(
              (thread) =>
                thread.deletedAt === null &&
                thread.archivedAt !== null &&
                thread.archivedByCommandId === cohortId,
            )),
      ];
      const activeSections = listActiveSidebarSections(readModel);
      const placements = new Map<OrchestrationThread["id"], ThreadArchivedSidebarPlacement>();
      for (const thread of restoredThreads) {
        if (
          (thread.archivedSidebarDestination === "pinned" ||
            thread.archivedSidebarDestination === "default") &&
          thread.archivedSidebarSortOrder != null
        ) {
          placements.set(thread.id, {
            destination: thread.archivedSidebarDestination,
            sectionId: null,
            sectionCreatedAt: null,
            sortOrder: thread.archivedSidebarSortOrder,
          });
          continue;
        }
        if (
          thread.archivedSidebarSectionId === null ||
          thread.archivedSidebarSectionCreatedAt === null ||
          thread.archivedSidebarSortOrder == null
        ) {
          continue;
        }
        const section = activeSections.find(
          (candidate) =>
            candidate.id === thread.archivedSidebarSectionId &&
            candidate.createdAt === thread.archivedSidebarSectionCreatedAt,
        );
        if (section === undefined) continue;
        placements.set(thread.id, {
          destination: "custom",
          sectionId: section.id,
          sectionCreatedAt: section.createdAt,
          sortOrder: thread.archivedSidebarSortOrder,
        });
      }

      // A root that inherited an ancestor's custom owner, or whose old custom
      // section incarnation no longer exists, still needs one deterministic
      // active slot after restore.  Keep independently placed children on
      // their valid destinations, but return the final root to default.
      if (!placements.has(rootThread.id)) {
        const defaultSortOrder = currentSidebarOrderItems(readModel, workspacePaths).filter(
          (item) => item.destination === "default",
        ).length;
        placements.set(rootThread.id, {
          destination: "default",
          sectionId: null,
          sectionCreatedAt: null,
          sortOrder: defaultSortOrder,
        });
      }

      const restoreCountsBySectionId = new Map<string, number>();
      for (const placement of placements.values()) {
        if (placement.sectionId === null) continue;
        restoreCountsBySectionId.set(
          placement.sectionId,
          (restoreCountsBySectionId.get(placement.sectionId) ?? 0) + 1,
        );
      }
      for (const [sectionId, restoreCount] of restoreCountsBySectionId) {
        const section = activeSections.find((candidate) => candidate.id === sectionId);
        if (section === undefined) continue;
        const restoredItemKeys = new Set(
          [...placements]
            .filter(([, placement]) => placement.sectionId === sectionId)
            .map(([threadId]) => `thread:${threadId}`),
        );
        const existingItemCount = section.items.filter(
          (item) => !restoredItemKeys.has(item.key),
        ).length;
        if (existingItemCount + restoreCount > SIDEBAR_SECTION_ITEMS_MAX_COUNT) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Sidebar section '${sectionId}' cannot accept the archived cohort without exceeding its item limit.`,
          });
        }
      }

      const restoredSidebarPlacements: ThreadRestoredSidebarPlacement[] = [...placements]
        .map(([threadId, placement]) => ({ threadId, placement }))
        .toSorted(
          (left, right) =>
            (left.placement.destination ?? "custom").localeCompare(
              right.placement.destination ?? "custom",
            ) ||
            (left.placement.sectionId ?? "").localeCompare(right.placement.sectionId ?? "") ||
            left.placement.sortOrder - right.placement.sortOrder ||
            left.threadId.localeCompare(right.threadId),
        );

      const restoredThreadIds = restoredThreads.slice(1).map((thread) => thread.id);
      const sidebarOrderRevision = nextSidebarOrderRevision(readModel.sidebarOrderRevision);
      return [...restoredThreadIds, rootThread.id].map(
        (threadId): Omit<OrchestrationEvent, "sequence"> => ({
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt,
            commandId: command.commandId,
          }),
          type: "thread.unarchived",
          payload: {
            threadId,
            updatedAt: occurredAt,
            restoredSidebarPlacement: placements.get(threadId) ?? null,
            isArchiveCohortFinal: threadId === rootThread.id,
            restoredSidebarPlacements: threadId === rootThread.id ? restoredSidebarPlacements : [],
            sidebarOrderRevision,
          },
        }),
      );
    }

    case "thread.meta.update": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const expectedSnoozedUntil = command.expectedSnoozedUntil;
      const expiresSnooze = expectedSnoozedUntil !== undefined;
      if (command.snoozedUntil != null || expiresSnooze) {
        yield* requireThreadNotArchived({ readModel, command, threadId: command.threadId });
      }
      if (expectedSnoozedUntil !== undefined) {
        if (
          command.snoozedUntil !== null ||
          expectedSnoozedUntil === null ||
          thread.snoozedUntil == null ||
          Date.parse(thread.snoozedUntil) !== Date.parse(expectedSnoozedUntil)
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Thread '${command.threadId}' snooze deadline changed before expiry.`,
          });
        }
        if (Date.parse(thread.snoozedUntil) > Date.now()) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Thread '${command.threadId}' snooze reminder is not due.`,
          });
        }
      }
      const project = readModel.projects.find((candidate) => candidate.id === thread.projectId);
      // Provider-native threads: see thread.create — the selection mirrors the
      // provider's own subagent, so the Auto-mode capability check doesn't apply.
      if (command.modelSelection !== undefined && thread.creationSource !== "provider_native") {
        yield* validateAutoRuntimeMode(command, command.modelSelection, thread.runtimeMode);
      }
      if (command.providerHandoff === true) {
        yield* validateProviderHandoff(command, thread);
      }
      const occurredAt = nowIso();
      const goalPatch = resolveThreadGoalPatch(command, thread, occurredAt);
      // Recheck admission inside the serialized command: stale clients may now
      // be editing an existing goal or a thread that has already started work.
      const startsWithMessage =
        command.goalStartBehavior === "start-with-message" &&
        command.goal !== undefined &&
        command.goal.trim().length > 0 &&
        !thread.goal?.trim() &&
        goalPatch.goalStartedAt != null &&
        command.goalAchieved !== true &&
        thread.archivedAt == null &&
        thread.parentThreadId == null &&
        thread.interactionMode !== "plan" &&
        !threadHasInFlightTurn(thread) &&
        !isExpiredSidechat(thread);
      const metadataEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...resolveThreadWorkspaceMetadataPatch(project?.kind, command, thread),
          ...(command.isPinned !== undefined ? { isPinned: command.isPinned } : {}),
          ...(command.isSettled !== undefined
            ? { settledAt: command.isSettled ? occurredAt : null }
            : {}),
          ...(command.snoozedUntil !== undefined
            ? { snoozedUntil: command.snoozedUntil, snoozeReminderAt: null }
            : {}),
          ...(expiresSnooze ? { snoozeReminderAt: occurredAt, settledAt: null } : {}),
          ...(command.parentThreadId !== undefined
            ? { parentThreadId: command.parentThreadId }
            : {}),
          ...(command.subagentAgentId !== undefined
            ? { subagentAgentId: command.subagentAgentId }
            : {}),
          ...(command.subagentNickname !== undefined
            ? { subagentNickname: command.subagentNickname }
            : {}),
          ...(command.subagentRole !== undefined ? { subagentRole: command.subagentRole } : {}),
          ...(command.handoff !== undefined ? { handoff: command.handoff } : {}),
          ...(command.lastKnownPr !== undefined ? { lastKnownPr: command.lastKnownPr } : {}),
          ...(command.pinnedMessages !== undefined
            ? { pinnedMessages: command.pinnedMessages }
            : {}),
          ...(command.notes !== undefined ? { notes: command.notes } : {}),
          ...(command.goalStartBehavior !== undefined
            ? { goalStartBehavior: startsWithMessage ? "defer" : command.goalStartBehavior }
            : {}),
          ...goalPatch,
          ...(command.providerHandoff === true
            ? { providerHandoff: { sourceModelSelection: thread.modelSelection } }
            : {}),
          updatedAt: occurredAt,
        },
      };
      if (!startsWithMessage) return metadataEvent;

      // The engine has already materialized large objectives. The same bounded
      // reference is recorded in the message; no second raw-goal payload is sent.
      const goal = goalPatch.goal!;
      const messageId = MessageId.makeUnsafe(`goal:${command.commandId}`);
      const messageEvent = userMessageUpsertEvent({
        commandId: command.commandId,
        threadId: command.threadId,
        message: {
          id: messageId,
          role: "user",
          text: `/goal ${/^(?:clear|pause|resume|edit)$|^--(?:\s|$)/i.test(goal.trim()) ? "-- " : ""}${goal}`,
          dispatchMode: "queue",
          dispatchOrigin: "user",
          turnId: null,
          streaming: false,
          source: "native",
          createdAt: occurredAt,
          updatedAt: occurredAt,
        },
        turnId: null,
        startsNewTurn: true,
        occurredAt,
      });
      return [
        metadataEvent,
        messageEvent,
        {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          }),
          causationEventId: messageEvent.eventId,
          type: "thread.turn-queued",
          payload: {
            threadId: command.threadId,
            messageId,
            initialGoalStartedAt: goalPatch.goalStartedAt!,
            dispatchMode: "queue",
            dispatchOrigin: "user",
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
            createdAt: occurredAt,
          },
        },
      ];
    }

    case "thread.pinned-message.add": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const existingPin = thread.pinnedMessages?.find((pin) => pin.messageId === command.messageId);
      if (!existingPin && (thread.pinnedMessages?.length ?? 0) >= PINNED_MESSAGES_MAX_COUNT) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' already has the maximum of ${PINNED_MESSAGES_MAX_COUNT} pinned messages.`,
        });
      }
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.pinned-message-added",
        payload: {
          threadId: command.threadId,
          pin: existingPin ?? {
            messageId: command.messageId,
            label: null,
            done: false,
            pinnedAt: occurredAt,
          },
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.pinned-message.remove": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.pinned-message-removed",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.pinned-message.done.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.pinned-message-done-set",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          done: command.done,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.pinned-message.label.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.pinned-message-label-set",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          label: command.label,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.marker.add": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (command.endOffset <= command.startOffset) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Marker end offset must be greater than start offset.`,
        });
      }
      let existingMarker: ThreadMarker | undefined = undefined;
      let replacedMarkerCount = 0;
      for (const marker of thread.threadMarkers ?? []) {
        if (
          marker.id === command.markerId ||
          (marker.messageId === command.messageId &&
            marker.startOffset === command.startOffset &&
            marker.endOffset === command.endOffset &&
            marker.style === command.style)
        ) {
          existingMarker = marker;
        }
        if (
          doThreadMarkerRangesOverlap(marker, {
            messageId: command.messageId,
            startOffset: command.startOffset,
            endOffset: command.endOffset,
          })
        ) {
          replacedMarkerCount += 1;
        }
      }
      if (
        !existingMarker &&
        (thread.threadMarkers?.length ?? 0) - replacedMarkerCount >= THREAD_MARKERS_MAX_COUNT
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' already has the maximum of ${THREAD_MARKERS_MAX_COUNT} markers.`,
        });
      }
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.marker-added",
        payload: {
          threadId: command.threadId,
          marker: existingMarker ?? {
            id: ThreadMarkerId.makeUnsafe(command.markerId),
            messageId: command.messageId,
            startOffset: command.startOffset,
            endOffset: command.endOffset,
            selectedText: command.selectedText,
            style: command.style,
            color: command.color,
            label: null,
            done: false,
            createdAt: occurredAt,
            updatedAt: occurredAt,
          },
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.marker.remove": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.marker-removed",
        payload: {
          threadId: command.threadId,
          markerId: ThreadMarkerId.makeUnsafe(command.markerId),
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.marker.done.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.marker-done-set",
        payload: {
          threadId: command.threadId,
          markerId: ThreadMarkerId.makeUnsafe(command.markerId),
          done: command.done,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.marker.label.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.marker-label-set",
        payload: {
          threadId: command.threadId,
          markerId: ThreadMarkerId.makeUnsafe(command.markerId),
          label: command.label,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.runtime-mode.set": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      yield* validateAutoRuntimeMode(command, thread.modelSelection, command.runtimeMode);
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.runtime-mode-set",
        payload: {
          threadId: command.threadId,
          runtimeMode: command.runtimeMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.interaction-mode.set": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.interaction-mode-set",
        payload: {
          threadId: command.threadId,
          previousInteractionMode: thread.interactionMode,
          interactionMode: command.interactionMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.turn.start": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      yield* validateSidechatExecutionAvailable(command, targetThread);
      if (command.resumePrecondition !== undefined) {
        // Quit-resume continuations are only valid while the thread is exactly as
        // it was recorded; checked here so it holds inside the serialized dispatch.
        const violation = threadResumePreconditionViolation(
          targetThread,
          command.resumePrecondition,
        );
        if (violation !== null) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: threadResumePreconditionDetail(command.threadId, violation),
          });
        }
      }
      if (threadHasCheckpointRevertInProgress(targetThread)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: checkpointRevertInProgressDetail(command.threadId),
        });
      }
      const sourceProposedPlan = command.sourceProposedPlan;
      const questionResponse = command.asyncUserInputResponse;
      const questionMessage = questionResponse
        ? targetThread.messages.find((message) => message.id === questionResponse.messageId)
        : undefined;
      if (questionResponse) {
        if (
          !questionMessage?.asyncUserInput ||
          questionMessage.role !== "assistant" ||
          targetThread.modelSelection.provider !== "codex" ||
          (targetThread.session?.providerName != null &&
            targetThread.session.providerName !== "codex") ||
          (command.modelSelection && command.modelSelection.provider !== "codex") ||
          targetThread.parentThreadId !== null
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "This asynchronous question is unavailable in this Codex thread.",
          });
        }
        // Serialized command admission makes concurrent answers from multiple
        // clients a single durable submission, even with different command ids.
        if (questionMessage.asyncUserInput.response) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: ASYNC_USER_INPUT_ALREADY_ANSWERED,
          });
        }
        if (
          questionResponse.answers.length !== questionMessage.asyncUserInput.questions.length ||
          targetThread.messages.some((message) => message.id === command.message.messageId)
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "Provide one answer per question and a new response message id.",
          });
        }
      }
      const messageText =
        questionResponse && questionMessage?.asyncUserInput
          ? formatAsyncUserInputResponse(
              questionMessage.asyncUserInput.questions,
              questionResponse.answers,
            )
          : command.message.text;
      if (messageText.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "The question response exceeds the maximum message length.",
        });
      }
      // A quit-resume command is planned just before commands are admitted.
      // Respect settings changed before its serialized dispatch instead of
      // replaying the planner's stale permission or interaction mode.
      const runtimeMode =
        command.resumePrecondition === undefined && !questionResponse
          ? command.runtimeMode
          : targetThread.runtimeMode;
      const interactionMode =
        command.resumePrecondition === undefined && !questionResponse
          ? command.interactionMode
          : targetThread.interactionMode;
      yield* validateAutoRuntimeMode(
        command,
        command.modelSelection ?? targetThread.modelSelection,
        runtimeMode,
      );
      const sourceThread = sourceProposedPlan
        ? yield* requireThread({
            readModel,
            command,
            threadId: sourceProposedPlan.threadId,
          })
        : null;
      const sourcePlan =
        sourceProposedPlan && sourceThread
          ? sourceThread.proposedPlans.find((entry) => entry.id === sourceProposedPlan.planId)
          : null;
      const dispatchMode = questionResponse ? "steer" : (command.dispatchMode ?? "queue");
      if (sourceProposedPlan && !sourcePlan) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan.planId}' does not exist on thread '${sourceProposedPlan.threadId}'.`,
        });
      }
      if (sourceThread && sourceThread.projectId !== targetThread.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan?.planId}' belongs to thread '${sourceThread.id}' in a different project.`,
        });
      }
      const activeProvider =
        targetThread.session?.providerName ?? targetThread.modelSelection.provider;
      const isThreadRunning =
        targetThread.session?.status === "running" && targetThread.session.activeTurnId !== null;
      // Subagent threads never queue: their messages steer the running child task
      // through the parent session, so deferring until the turn settles would
      // deliver the message only after the subagent already finished.
      // Steers ride the live turn natively only on providers whose runtime can
      // inject mid-turn input; everywhere else they queue and interrupt below.
      // A manual compaction turn takes no steering input on any provider, so a
      // steer skips the compaction the same way.
      const steersLiveTurnNatively =
        providerSupportsNativeTurnSteering(activeProvider) &&
        !isManualCompactionTurnActive({
          activeTurnId: targetThread.session?.activeTurnId,
          activities: targetThread.activities,
        });
      const shouldQueue =
        targetThread.parentThreadId === null &&
        (targetThread.claudeCacheReview != null ||
          (isThreadRunning && (dispatchMode === "queue" || !steersLiveTurnNatively)));
      const snoozeEvents: Array<Omit<OrchestrationEvent, "sequence">> =
        (command.dispatchOrigin ?? "user") === "user" &&
        (targetThread.snoozedUntil != null || targetThread.snoozeReminderAt != null)
          ? [
              {
                ...withEventBase({
                  aggregateKind: "thread",
                  aggregateId: command.threadId,
                  occurredAt: command.createdAt,
                  commandId: command.commandId,
                }),
                type: "thread.meta-updated",
                payload: {
                  threadId: command.threadId,
                  snoozedUntil: null,
                  snoozeReminderAt: null,
                  updatedAt: command.createdAt,
                },
              },
            ]
          : [];
      const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          text: messageText,
          attachments: command.message.attachments,
          ...(command.message.skills !== undefined ? { skills: command.message.skills } : {}),
          ...(command.message.mentions !== undefined ? { mentions: command.message.mentions } : {}),
          dispatchMode,
          // Explicit "user" (not absent): edit-resends replay through a fresh
          // server-side turn.start without an origin, and the projection
          // upsert coalesces absent origins — a human resend of a message
          // originally dispatched by an automation/agent must overwrite the
          // stale origin instead of inheriting it.
          dispatchOrigin: command.dispatchOrigin ?? "user",
          startsNewTurn: dispatchMode !== "steer" || !isThreadRunning || shouldQueue,
          turnId: null,
          streaming: false,
          source: questionResponse ? "async-user-input" : "native",
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const nextModelSelection = command.modelSelection ?? targetThread.modelSelection;
      const modelChangedEvent: Omit<OrchestrationEvent, "sequence"> | null =
        shouldEmitThreadModelChangedActivity({
          thread: targetThread,
          nextModelSelection,
        })
          ? {
              ...withEventBase({
                aggregateKind: "thread",
                aggregateId: command.threadId,
                occurredAt: command.createdAt,
                commandId: command.commandId,
              }),
              type: "thread.activity-appended",
              payload: {
                threadId: command.threadId,
                activity: {
                  // Event ids stay unique for the append log; the web transcript
                  // converges durable echoes by this activity's message anchor.
                  id: EventId.makeUnsafe(crypto.randomUUID()),
                  tone: "info",
                  kind: "model.changed",
                  summary: `Model changed from ${targetThread.modelSelection.model.trim()} to ${nextModelSelection.model.trim()}.`,
                  payload: {
                    source: "local-turn-model-change",
                    messageId: command.message.messageId,
                    anchorMessageId: command.message.messageId,
                    fromModel: targetThread.modelSelection.model.trim(),
                    toModel: nextModelSelection.model.trim(),
                  },
                  turnId: null,
                  createdAt: command.createdAt,
                },
              },
            }
          : null;
      const emittedUserMessageEvent: Omit<OrchestrationEvent, "sequence"> = modelChangedEvent
        ? { ...userMessageEvent, causationEventId: modelChangedEvent.eventId }
        : userMessageEvent;
      const turnRequestPayload = {
        threadId: command.threadId,
        messageId: command.message.messageId,
        ...(command.modelSelection !== undefined ? { modelSelection: command.modelSelection } : {}),
        ...(command.providerOptions !== undefined
          ? { providerOptions: command.providerOptions }
          : {}),
        ...(command.reviewTarget !== undefined ? { reviewTarget: command.reviewTarget } : {}),
        ...computerActivationMetadata({ ...command, userMessageText: command.message.text }),
        assistantDeliveryMode: command.assistantDeliveryMode ?? DEFAULT_ASSISTANT_DELIVERY_MODE,
        dispatchMode,
        dispatchOrigin: command.dispatchOrigin ?? "user",
        runtimeMode,
        interactionMode,
        ...(sourceProposedPlan !== undefined ? { sourceProposedPlan } : {}),
        createdAt: command.createdAt,
      } as const;
      const queuedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        causationEventId: emittedUserMessageEvent.eventId,
        type: shouldQueue ? "thread.turn-queued" : "thread.turn-start-requested",
        payload: turnRequestPayload,
      };
      if (shouldQueue && dispatchMode === "steer" && targetThread.claudeCacheReview == null) {
        return [
          ...snoozeEvents,
          userMessageEvent,
          queuedEvent,
          {
            ...withEventBase({
              aggregateKind: "thread",
              aggregateId: command.threadId,
              occurredAt: command.createdAt,
              commandId: command.commandId,
            }),
            causationEventId: queuedEvent.eventId,
            type: "thread.turn-interrupt-requested",
            payload: {
              threadId: command.threadId,
              turnId: targetThread.session?.activeTurnId ?? undefined,
              createdAt: command.createdAt,
            },
          },
        ];
      }
      if (questionResponse && questionMessage?.asyncUserInput) {
        return [
          ...snoozeEvents,
          {
            ...withEventBase({
              aggregateKind: "thread",
              aggregateId: command.threadId,
              occurredAt: command.createdAt,
              commandId: command.commandId,
            }),
            type: "thread.async-user-input-answered",
            payload: {
              threadId: command.threadId,
              messageId: questionMessage.id,
              response: {
                messageId: command.message.messageId,
                answers: questionResponse.answers,
              },
            },
          },
          userMessageEvent,
          queuedEvent,
        ];
      }
      return [
        ...snoozeEvents,
        ...(modelChangedEvent ? [modelChangedEvent, emittedUserMessageEvent] : [userMessageEvent]),
        queuedEvent,
      ];
    }

    case "thread.claude-cache.set": {
      if (command.hold) {
        const target = readModel.threads.find((thread) => thread.id === command.threadId);
        if (
          !target ||
          target.deletedAt != null ||
          target.archivedAt != null ||
          isExpiredSidechat(target) ||
          command.hold.session.threadId !== command.threadId ||
          command.hold.session.status !== "ready" ||
          (command.review !== null &&
            (command.review.status !== "pending" ||
              !target.messages.some(
                (message) => message.id === command.review?.messageId && message.role === "user",
              )))
        )
          return [];
      }
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      if (
        command.expectedReviewId !== undefined &&
        (thread.claudeCacheReview?.reviewId ?? null) !== command.expectedReviewId
      )
        return [];
      const reviewEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.claude-cache-set",
        payload: {
          threadId: command.threadId,
          review: command.review,
          updatedAt: command.createdAt,
        },
      };
      return command.hold
        ? [
            reviewEvent,
            {
              ...withEventBase({
                aggregateKind: "thread",
                aggregateId: command.threadId,
                occurredAt: command.createdAt,
                commandId: command.commandId,
              }),
              type: "thread.session-set",
              payload: { threadId: command.threadId, session: command.hold.session },
            },
          ]
        : reviewEvent;
    }

    case "thread.claude-cache.compacted": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      const review = thread.claudeCacheReview;
      if (
        !review ||
        review.reviewId !== command.reviewId ||
        (review.status !== "compacting" && review.status !== "uncertain") ||
        review.compactionTurnId !== command.turnId ||
        thread.archivedAt != null
      )
        return [];
      const base = {
        aggregateKind: "thread" as const,
        aggregateId: command.threadId,
        occurredAt: command.createdAt,
        commandId: command.commandId,
      };
      return [
        {
          ...withEventBase(base),
          type: "thread.claude-cache-set",
          payload: {
            threadId: command.threadId,
            review: { ...review, status: "responding" as const },
            updatedAt: command.createdAt,
          },
        },
        {
          ...withEventBase(base),
          type: "thread.claude-cache-response-requested",
          payload: {
            threadId: command.threadId,
            review,
            decision: "continue" as const,
            createdAt: command.createdAt,
          },
        },
      ];
    }

    case "thread.claude-cache.respond": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      const review = thread.claudeCacheReview;
      if (
        !review ||
        review.reviewId !== command.reviewId ||
        review.messageId !== command.messageId ||
        (review.status !== "pending" && review.status !== "failed")
      )
        return [];
      const base = {
        aggregateKind: "thread" as const,
        aggregateId: command.threadId,
        occurredAt: command.createdAt,
        commandId: command.commandId,
      };
      return [
        {
          ...withEventBase(base),
          type: "thread.claude-cache-set",
          payload: {
            threadId: command.threadId,
            review: { ...review, status: "responding" as const, error: undefined },
            updatedAt: command.createdAt,
          },
        },
        {
          ...withEventBase(base),
          type: "thread.claude-cache-response-requested",
          payload: {
            threadId: command.threadId,
            review,
            decision: command.decision,
            createdAt: command.createdAt,
          },
        },
      ];
    }

    case "thread.turn.dispatch-queued": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      yield* validateSidechatExecutionAvailable(command, thread);
      if (threadHasCheckpointRevertInProgress(thread)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: checkpointRevertInProgressDetail(command.threadId),
        });
      }
      yield* validateAutoRuntimeMode(
        command,
        command.modelSelection ?? thread.modelSelection,
        command.runtimeMode,
      );
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-start-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          ...(command.initialGoalStartedAt !== undefined
            ? { initialGoalStartedAt: command.initialGoalStartedAt }
            : {}),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.providerOptions !== undefined
            ? { providerOptions: command.providerOptions }
            : {}),
          ...(command.reviewTarget !== undefined ? { reviewTarget: command.reviewTarget } : {}),
          ...computerActivationMetadata(command),
          assistantDeliveryMode: command.assistantDeliveryMode ?? DEFAULT_ASSISTANT_DELIVERY_MODE,
          dispatchMode: command.dispatchMode ?? "queue",
          dispatchOrigin: command.dispatchOrigin ?? "user",
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          ...(command.sourceProposedPlan !== undefined
            ? { sourceProposedPlan: command.sourceProposedPlan }
            : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.turn.capacity-retry": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const latestTurn = thread.latestTurn;
      if (!latestTurn || latestTurn.turnId !== command.turnId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Capacity retry '${command.turnId}' is not the latest turn on thread '${command.threadId}'.`,
        });
      }
      if (latestTurn.state !== "error" || latestTurn.completedAt === null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Capacity retry requires a terminal failed latest turn on thread '${command.threadId}'.`,
        });
      }
      if (!latestFailedServerOverloadActivity(thread, command.turnId)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Latest turn '${command.turnId}' is not a typed serverOverloaded failure.`,
        });
      }
      if (threadHasInFlightTurn(thread) || hasQueuedTurnConflict(thread)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' already has an active or queued turn.`,
        });
      }
      if (!isCodexForegroundThread(thread)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Capacity retry is only available for the bound foreground Codex driver on thread '${command.threadId}'.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-capacity-retry-requested",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          trigger: command.trigger,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.turn.safety-buffer-retry": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const latestTurn = thread.latestTurn;
      if (
        !latestTurn ||
        latestTurn.turnId !== command.turnId ||
        latestTurn.completedAt !== null ||
        latestTurn.state !== "running" ||
        thread.session?.status !== "running" ||
        thread.session.activeTurnId !== command.turnId
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Safety buffering retry '${command.turnId}' is not the exact active latest turn on thread '${command.threadId}'.`,
        });
      }
      if (!isCodexForegroundThread(thread)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Safety buffering retry is only available for the bound foreground Codex driver on thread '${command.threadId}'.`,
        });
      }
      const safety = latestSafetyBufferingActivity(thread, command.turnId);
      if (!safety) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Latest turn '${command.turnId}' has no active typed safety-buffering target.`,
        });
      }
      if (
        thread.activities.some(
          (activity) =>
            activity.kind === "model.safety-buffering.retry-requested" &&
            activity.turnId === command.turnId,
        )
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Safety buffering retry '${command.turnId}' was already requested.`,
        });
      }
      const sourceMessage = thread.messages
        .filter(
          (message) =>
            message.role === "user" &&
            message.source === "native" &&
            message.createdAt <= latestTurn.requestedAt,
        )
        .at(-1);
      const tailTurnIds = sourceMessage
        ? collectTailTurnIds<TurnId>({ messages: thread.messages, messageId: sourceMessage.id })
        : [];
      if (!sourceMessage || tailTurnIds.some((tailTurnId) => tailTurnId !== command.turnId)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Safety buffering retry cannot reconstruct the exact source input for turn '${command.turnId}'.`,
        });
      }
      const targetSelection = { ...thread.modelSelection, model: safety.targetModel };
      const requestedActivity: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: {
            id: EventId.makeUnsafe(crypto.randomUUID()),
            tone: "info",
            kind: "model.safety-buffering.retry-requested",
            summary: `Retrying with ${safety.targetModel}`,
            payload: {
              sourceActivityId: safety.activity.id,
              targetModel: safety.targetModel,
            },
            turnId: command.turnId,
            createdAt: command.createdAt,
          },
        },
      };
      const requestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        causationEventId: requestedActivity.eventId,
        type: "thread.turn-safety-buffer-retry-requested",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          messageId: sourceMessage.id,
          sourceActivityId: safety.activity.id,
          targetModel: safety.targetModel,
          modelSelection: targetSelection,
          runtimeMode: thread.session.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: command.createdAt,
        },
      };
      return [requestedActivity, requestedEvent];
    }

    case "thread.turn.resume": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const latestTurn = thread.latestTurn;
      if (!latestTurn || latestTurn.turnId !== command.turnId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Resume turn '${command.turnId}' is not the latest turn on thread '${command.threadId}'.`,
        });
      }
      if (latestTurn.completedAt === null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Resume requires a terminal latest turn on thread '${command.threadId}'.`,
        });
      }
      const resumable =
        latestTurn.state === "interrupted" ||
        (latestTurn.state === "error" && latestTurnIsRetryableFailure(thread, command.turnId));
      if (!resumable) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Latest turn '${command.turnId}' is not interrupted or backed by a retryable Codex failure.`,
        });
      }
      if (threadHasInFlightTurn(thread) || hasQueuedTurnConflict(thread)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' already has an active or queued turn.`,
        });
      }
      if (hasPendingThreadInteraction(thread)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' has a pending approval or user input interaction.`,
        });
      }
      if ((thread.goal ?? "").trim().length > 0 && thread.goalPausedAt == null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' has an active goal continuation.`,
        });
      }
      if (!isCodexForegroundThread(thread)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Resume is only available for the bound foreground Codex driver on thread '${command.threadId}'.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-resume-requested",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.turn.interrupt": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const interruptEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId: command.threadId,
          ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
          ...(command.requestedBy !== undefined ? { requestedBy: command.requestedBy } : {}),
          createdAt: command.createdAt,
        },
      };
      if ((thread.goal ?? "").trim().length === 0 || thread.goalPausedAt != null) {
        return interruptEvent;
      }

      const pausedAt = nowIso();
      const pauseEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: pausedAt,
          commandId: command.commandId,
        }),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          goalPausedAt: pausedAt,
          updatedAt: pausedAt,
        },
      };
      return [
        pauseEvent,
        {
          ...interruptEvent,
          causationEventId: pauseEvent.eventId,
        },
      ];
    }

    case "thread.task.stop": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.task-stop-requested",
        payload: {
          threadId: command.threadId,
          taskId: command.taskId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.task.background": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.task-background-requested",
        payload: {
          threadId: command.threadId,
          toolUseId: command.toolUseId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.approval.respond": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      yield* validateSidechatExecutionAvailable(command, thread);
      yield* requireApprovalNotResponded({
        readModel,
        command,
        threadId: command.threadId,
        requestId: command.requestId,
        ...(command.lifecycleGeneration !== undefined
          ? { lifecycleGeneration: command.lifecycleGeneration }
          : {}),
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        }),
        type: "thread.approval-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          ...(command.lifecycleGeneration !== undefined
            ? { lifecycleGeneration: command.lifecycleGeneration }
            : {}),
          decision: command.decision,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.user-input.respond": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      yield* validateSidechatExecutionAvailable(command, thread);
      const answers = omitNullUserInputAnswers(command);
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        }),
        type: "thread.user-input-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          ...(command.lifecycleGeneration !== undefined
            ? { lifecycleGeneration: command.lifecycleGeneration }
            : {}),
          answers,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.checkpoint.revert": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (threadHasInFlightTurn(thread)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: checkpointRevertActiveTurnDetail(command.threadId),
        });
      }
      if (threadHasCheckpointRevertInProgress(thread)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: checkpointRevertInProgressDetail(command.threadId),
        });
      }
      const startedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: {
            id: EventId.makeUnsafe(crypto.randomUUID()),
            tone: "info",
            kind: CHECKPOINT_REVERT_STARTED_ACTIVITY_KIND,
            summary: "Checkpoint revert started",
            payload: {
              turnCount: command.turnCount,
              scope: command.scope ?? "thread",
            },
            turnId: null,
            createdAt: command.createdAt,
          },
        },
      };
      const requestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.checkpoint-revert-requested",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
          scope: command.scope ?? "thread",
          createdAt: command.createdAt,
        },
      };
      return [startedEvent, requestedEvent];
    }

    case "thread.conversation.rollback": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (threadHasCheckpointRevertInProgress(thread)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: checkpointRevertInProgressDetail(command.threadId),
        });
      }
      const rollbackTarget = deriveConversationRollbackTarget(thread.messages, command.messageId);
      if (!rollbackTarget || rollbackTarget.role !== "user") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Conversation rollback must target an existing user message.",
        });
      }
      if (command.numTurns <= 0 || rollbackTarget.removedTurnIds.size !== command.numTurns) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Conversation rollback requested ${command.numTurns} turn(s), but target message '${command.messageId}' would remove ${rollbackTarget.removedTurnIds.size} turn(s).`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.conversation-rollback-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          numTurns: command.numTurns,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.message.edit-and-resend": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      yield* validateSidechatExecutionAvailable(command, thread);
      if (threadHasCheckpointRevertInProgress(thread)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: checkpointRevertInProgressDetail(command.threadId),
        });
      }
      yield* validateAutoRuntimeMode(
        command,
        command.modelSelection ?? thread.modelSelection,
        command.runtimeMode,
      );
      const editTarget = resolveTailUserMessageEditTarget({
        messages: thread.messages,
        messageId: command.messageId,
        activeTurnId:
          thread.session?.status === "running" ? (thread.session.activeTurnId ?? null) : null,
      });
      if (!editTarget.editable) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Only the latest rollbackable user message can be edited and resent (${editTarget.reason}).`,
        });
      }
      const requestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-edit-resend-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          text: command.text,
          rollbackTurnCount: editTarget.rollbackTurnCount,
          removedTurnIds: editTarget.removedTurnIds.map((turnId) => TurnId.makeUnsafe(turnId)),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.providerOptions !== undefined
            ? { providerOptions: command.providerOptions }
            : {}),
          ...computerActivationMetadata({ ...command, userMessageText: command.text }),
          ...(command.assistantDeliveryMode !== undefined
            ? { assistantDeliveryMode: command.assistantDeliveryMode }
            : {}),
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          createdAt: command.createdAt,
        },
      };
      if (thread.session?.status === "starting" || thread.session?.status === "running") {
        return requestedEvent;
      }
      const startingSessionEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.session-set",
        payload: {
          threadId: command.threadId,
          session: {
            threadId: command.threadId,
            status: "starting",
            providerName: thread.session?.providerName ?? thread.modelSelection.provider,
            runtimeMode: command.runtimeMode,
            activeTurnId: null,
            lastError: null,
            updatedAt: command.createdAt,
          },
        },
      };
      return [
        startingSessionEvent,
        { ...requestedEvent, causationEventId: startingSessionEvent.eventId },
      ];
    }

    case "thread.session.stop": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const stopEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.session-stop-requested",
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      };
      const review = thread.claudeCacheReview;
      return review
        ? [
            {
              ...withEventBase({
                aggregateKind: "thread",
                aggregateId: command.threadId,
                occurredAt: command.createdAt,
                commandId: command.commandId,
              }),
              type: "thread.claude-cache-set" as const,
              payload: { threadId: command.threadId, review: null, updatedAt: command.createdAt },
            },
            stopEvent,
          ]
        : stopEvent;
    }

    case "thread.goal.continue": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      yield* validateSidechatExecutionAvailable(command, thread);
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.goal-continuation-requested",
        payload: {
          threadId: command.threadId,
          goalStartedAt: command.goalStartedAt,
          trigger: command.trigger,
          ...(command.sourceTurnId !== undefined ? { sourceTurnId: command.sourceTurnId } : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.set": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const sessionChanged =
        (command.expectedSessionStatus !== undefined &&
          thread.session?.status !== command.expectedSessionStatus) ||
        (command.expectedSessionUpdatedAt !== undefined &&
          thread.session?.updatedAt !== command.expectedSessionUpdatedAt);
      if (sessionChanged) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' session changed before the conditional update.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        }),
        type: "thread.session-set",
        payload: {
          threadId: command.threadId,
          session: command.session,
        },
      };
    }

    case "thread.messages.import":
    case "thread.history.import": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const entries: ReadonlyArray<ThreadHistoryImportEntry> =
        command.type === "thread.history.import"
          ? command.entries
          : command.messages.map((message) => ({ kind: "message", message }));
      return entries.map((entry): Omit<OrchestrationEvent, "sequence"> => {
        const base = withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        });
        if (entry.kind === "activity") {
          return {
            ...base,
            type: "thread.activity-appended",
            payload: { threadId: command.threadId, activity: entry.activity },
          };
        }
        if (entry.kind === "proposed-plan") {
          return {
            ...base,
            type: "thread.proposed-plan-upserted",
            payload: { threadId: command.threadId, proposedPlan: entry.proposedPlan },
          };
        }
        const message = entry.message;
        return {
          ...base,
          type: "thread.message-sent",
          payload: {
            threadId: command.threadId,
            messageId: message.messageId,
            ...(message.realtimeHandoffId !== undefined
              ? { realtimeHandoffId: message.realtimeHandoffId }
              : {}),
            role: message.role,
            text: message.text,
            ...(message.dispatchOrigin !== undefined
              ? { dispatchOrigin: message.dispatchOrigin }
              : {}),
            ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
            turnId: message.turnId ?? null,
            streaming: false,
            source: "native" as const,
            createdAt: message.createdAt,
            updatedAt: message.updatedAt,
          },
        };
      });
    }

    case "thread.message.assistant.delta": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const existingMessage = thread.messages.find((message) => message.id === command.messageId);
      const turnId = resolveStableMessageTurnId({
        existingTurnId: existingMessage?.turnId,
        incomingTurnId: command.turnId,
      });
      const deltaEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: command.delta,
          ...(command.segmentStartedAt ? { segmentStartedAt: command.segmentStartedAt } : {}),
          ...(command.segmentSequence !== undefined
            ? { segmentSequence: command.segmentSequence }
            : {}),
          turnId,
          streaming: true,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      if (existingMessage?.role !== "assistant" || existingMessage.streaming) {
        return deltaEvent;
      }
      // A finalized message stays finalized. A late provider delta (after its
      // item or turn already completed) is appended and settled again in the
      // same command, because nothing would ever complete a reopened row.
      return [
        deltaEvent,
        {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.message-sent",
          payload: {
            threadId: command.threadId,
            messageId: command.messageId,
            role: "assistant",
            text: `${existingMessage.text}${command.delta}`,
            turnId,
            streaming: false,
            createdAt: command.createdAt,
            updatedAt: command.createdAt,
          },
        },
      ];
    }

    case "thread.message.assistant.complete": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const existingMessage = thread.messages.find((message) => message.id === command.messageId);
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: existingMessage?.text ?? "",
          ...(command.asyncQuestions
            ? {
                asyncUserInput: existingMessage?.asyncUserInput ?? {
                  questions: command.asyncQuestions,
                },
              }
            : {}),
          turnId: resolveStableMessageTurnId({
            existingTurnId: existingMessage?.turnId,
            incomingTurnId: command.turnId,
          }),
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.user.bind-turn": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const message = thread.messages.find((entry) => entry.id === command.messageId);
      if (!message || message.role !== "user") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `User message '${command.messageId}' does not exist on thread '${command.threadId}'.`,
        });
      }
      if (
        message.turnId !== null &&
        message.turnId !== undefined &&
        message.turnId !== command.turnId
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `User message '${command.messageId}' is already bound to turn '${message.turnId}'.`,
        });
      }
      // The command engine requires at least one event per accepted command.
      // Re-emit the canonical upsert when already bound to this exact turn so
      // recovery retries with a fresh command id remain safely idempotent.
      return userMessageUpsertEvent({
        commandId: command.commandId,
        threadId: command.threadId,
        message,
        turnId: command.turnId,
        occurredAt: command.createdAt,
      });
    }

    case "thread.message.user.set-turn-boundary": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const message = thread.messages.find((entry) => entry.id === command.messageId);
      if (!message || message.role !== "user") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `User message '${command.messageId}' does not exist on thread '${command.threadId}'.`,
        });
      }
      return userMessageUpsertEvent({
        commandId: command.commandId,
        threadId: command.threadId,
        message,
        turnId: message.turnId,
        startsNewTurn: command.startsNewTurn,
        occurredAt: command.createdAt,
      });
    }

    case "thread.proposed-plan.upsert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: command.threadId,
          proposedPlan: command.proposedPlan,
        },
      };
    }

    case "thread.turn.diff.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const diffCompletedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-diff-completed",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          checkpointTurnCount: command.checkpointTurnCount,
          checkpointRef: command.checkpointRef,
          status: command.status,
          files: command.files,
          assistantMessageId: command.assistantMessageId ?? null,
          completedAt: command.completedAt,
          ...(command.preserveLatestTurn ? { preserveLatestTurn: true } : {}),
        },
      };
      return command.checkpointRevertTurnCount === undefined
        ? diffCompletedEvent
        : [
            diffCompletedEvent,
            checkpointRevertSucceededEvent({
              commandId: command.commandId,
              threadId: command.threadId,
              turnCount: command.checkpointRevertTurnCount,
              createdAt: command.createdAt,
              causationEventId: diffCompletedEvent.eventId,
            }),
          ];
    }

    case "thread.revert.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const revertedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.reverted",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
        },
      };
      return [
        revertedEvent,
        checkpointRevertSucceededEvent({
          commandId: command.commandId,
          threadId: command.threadId,
          turnCount: command.turnCount,
          createdAt: command.createdAt,
          causationEventId: revertedEvent.eventId,
        }),
      ];
    }

    case "thread.conversation.rollback.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.conversation-rolled-back",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          numTurns: command.numTurns,
          ...(command.removedTurnIds !== undefined
            ? { removedTurnIds: command.removedTurnIds }
            : {}),
          ...(command.skipAttachmentPrune !== undefined
            ? { skipAttachmentPrune: command.skipAttachmentPrune }
            : {}),
        },
      };
    }

    case "thread.activity.append": {
      yield* (command.requireUnarchived ? requireThreadNotArchived : requireThread)({
        readModel,
        command,
        threadId: command.threadId,
      });
      const activity = command.activity;
      const requestId =
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        "requestId" in activity.payload &&
        typeof (activity.payload as { requestId?: unknown }).requestId === "string"
          ? ((activity.payload as { requestId: string })
              .requestId as OrchestrationEvent["metadata"]["requestId"])
          : undefined;
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          ...(requestId !== undefined ? { metadata: { requestId } } : {}),
        }),
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity,
        },
      };
    }

    case "sidebar-section.create": {
      yield* requireSidebarOrderAdmission({
        readModel,
        command,
        expectedRevision: command.expectedSidebarOrderRevision,
      });
      yield* requireSidebarSectionNameAvailable({
        readModel,
        command,
        name: command.name,
      });
      if (findSidebarSection(readModel, command.sectionId) !== undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Sidebar section '" + command.sectionId + "' already exists.",
        });
      }
      const activeSections = listActiveSidebarSections(readModel);
      if (activeSections.length >= SIDEBAR_SECTIONS_MAX_COUNT) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail:
            "A maximum of " + SIDEBAR_SECTIONS_MAX_COUNT + " custom sidebar sections is supported.",
        });
      }
      if (command.initialThreadId !== undefined) {
        const initialThread = yield* requireThread({
          readModel,
          command,
          threadId: command.initialThreadId,
        });
        if (initialThread.deletedAt !== null || initialThread.archivedAt !== null) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "An archived or deleted thread cannot start a sidebar section.",
          });
        }
      }
      const occurredAt = command.createdAt;
      const sidebarOrderRevision = nextSidebarOrderRevision(readModel.sidebarOrderRevision);
      const createdEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "sidebar-section",
          aggregateId: command.sectionId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "sidebar-section.created",
        payload: {
          sectionId: command.sectionId,
          name: command.name,
          sortOrder: activeSections.length,
          isCollapsed: false,
          sidebarOrderRevision,
          createdAt: occurredAt,
          updatedAt: occurredAt,
        },
      };
      if (command.initialThreadId === undefined) {
        return createdEvent;
      }
      const initialThread = readModel.threads.find(
        (thread) => thread.id === command.initialThreadId,
      )!;
      return [
        createdEvent,
        {
          ...withEventBase({
            aggregateKind: "sidebar-section",
            aggregateId: command.sectionId,
            occurredAt,
            commandId: command.commandId,
          }),
          type: "sidebar-section.thread-placed",
          payload: {
            sectionId: command.sectionId,
            threadId: initialThread.id,
            destination: "custom",
            beforeThreadId: null,
            sectionCreatedAt: occurredAt,
            sortOrder: 0,
            sidebarOrderRevision,
            updatedAt: occurredAt,
          },
        },
      ];
    }

    case "sidebar-section.rename": {
      const section = yield* requireSidebarSection({
        readModel,
        command,
        sectionId: command.sectionId,
      });
      if (section.name === command.name) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Sidebar section rename must change the name.",
        });
      }
      yield* requireSidebarSectionNameAvailable({
        readModel,
        command,
        name: command.name,
        excludeSectionId: section.id,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "sidebar-section",
          aggregateId: section.id,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "sidebar-section.renamed",
        payload: {
          sectionId: section.id,
          name: command.name,
          updatedAt: occurredAt,
        },
      };
    }

    case "sidebar-section.collapse": {
      const section = yield* requireSidebarSection({
        readModel,
        command,
        sectionId: command.sectionId,
      });
      if (section.isCollapsed === command.isCollapsed) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Sidebar section collapse state is already current.",
        });
      }
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "sidebar-section",
          aggregateId: section.id,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "sidebar-section.collapsed",
        payload: {
          sectionId: section.id,
          isCollapsed: command.isCollapsed,
          updatedAt: occurredAt,
        },
      };
    }

    case "sidebar-section.delete": {
      yield* requireSidebarOrderAdmission({
        readModel,
        command,
        expectedRevision: command.expectedSidebarOrderRevision,
      });
      const section = yield* requireSidebarSection({
        readModel,
        command,
        sectionId: command.sectionId,
      });
      const occurredAt = nowIso();
      let rehomed: ReturnType<typeof rehomeSidebarSectionItems>;
      try {
        rehomed = rehomeSidebarSectionItems(currentSidebarOrderItems(readModel, workspacePaths), {
          sectionId: section.id,
          sectionCreatedAt: section.createdAt,
          now: occurredAt,
        });
      } catch (error) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: error instanceof Error ? error.message : "Invalid sidebar section order.",
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "sidebar-section",
          aggregateId: section.id,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "sidebar-section.deleted",
        payload: {
          sectionId: section.id,
          sidebarOrderRevision: nextSidebarOrderRevision(readModel.sidebarOrderRevision),
          sectionCreatedAt: section.createdAt,
          sidebarOrderItems: rehomed.items,
          deletedAt: occurredAt,
        },
      };
    }

    case "sidebar-order.legacy.import": {
      yield* requireSidebarOrderAdmission({
        readModel,
        command,
        expectedRevision: command.expectedSidebarOrderRevision,
      });
      const activeSections = listActiveSidebarSections(readModel);
      const sectionById = new Map(activeSections.map((section) => [section.id, section] as const));
      try {
        validateSidebarOrderItems(command.items, SIDEBAR_SECTION_ITEMS_MAX_COUNT);
      } catch (error) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: error instanceof Error ? error.message : "Invalid legacy sidebar order.",
        });
      }
      const activeThreads = readModel.threads.filter(
        (thread) => thread.deletedAt === null && thread.archivedAt === null,
      );
      const activeThreadById = new Map(activeThreads.map((thread) => [thread.id, thread] as const));
      const itemByKey = new Map(command.items.map((item) => [item.key, item] as const));
      const authoritativeItems = currentSidebarOrderItems(readModel, workspacePaths);
      const authoritativeByKey = new Map(
        authoritativeItems.map((item) => [item.key, item] as const),
      );
      if (
        command.items.length !== authoritativeItems.length ||
        command.items.some((item) => !authoritativeByKey.has(item.key)) ||
        authoritativeItems.some((item) => !itemByKey.has(item.key))
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Legacy sidebar import must contain the complete authoritative key set.",
        });
      }
      for (const item of command.items) {
        if (item.itemType === "thread") {
          const threadId = item.key.startsWith("thread:")
            ? ThreadId.makeUnsafe(item.key.slice("thread:".length))
            : ThreadId.makeUnsafe("");
          const thread = activeThreadById.get(threadId);
          if (thread === undefined) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `Legacy sidebar import references an unknown, archived, or deleted thread '${threadId}'.`,
            });
          }
        } else if (item.itemType === "project") {
          const projectId = item.key.startsWith("project:")
            ? item.key.slice("project:".length)
            : "";
          const project = readModel.projects.find((entry) => entry.id === projectId);
          if (project === undefined || project.deletedAt !== null) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `Legacy sidebar import references an unknown or deleted project '${projectId}'.`,
            });
          }
        }
        if (item.destination === "custom") {
          const section = item.sectionId === null ? undefined : sectionById.get(item.sectionId);
          if (section === undefined || section.createdAt !== item.sectionCreatedAt) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "Legacy sidebar import references a stale custom-section incarnation.",
            });
          }
        } else if (item.sectionId !== null || item.sectionCreatedAt !== null) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "Pinned/default legacy imports cannot carry custom-section identity.",
          });
        }
        const authoritative = authoritativeByKey.get(item.key)!;
        // Projects and existing custom placements are server-owned. Legacy
        // hydration may only change the pinned/default destination of a thread.
        const preservesMembership =
          authoritative.itemType === "project" || authoritative.destination === "custom";
        if (
          preservesMembership &&
          (item.itemType !== authoritative.itemType ||
            item.destination !== authoritative.destination ||
            item.sectionId !== authoritative.sectionId ||
            item.sectionCreatedAt !== authoritative.sectionCreatedAt)
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Legacy sidebar import changed authoritative membership for '${item.key}'.`,
          });
        }
      }
      // Every active root or explicitly independent thread must be represented
      // once. Ordinary descendants inherit their owner's container and do not
      // need a second slot of their own.
      const requiredThreadIds = activeThreads.filter((thread) => {
        if (thread.parentThreadId === null || thread.parentThreadId === undefined) return true;
        return authoritativeByKey.has(SidebarSectionItemKey.makeUnsafe(`thread:${thread.id}`));
      });
      for (const thread of requiredThreadIds) {
        if (!itemByKey.has(SidebarSectionItemKey.makeUnsafe(`thread:${thread.id}`))) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Legacy sidebar import omitted active explicit thread '${thread.id}'.`,
          });
        }
      }
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "sidebar-section",
          aggregateId: "sidebar-order" as OrchestrationEvent["aggregateId"],
          occurredAt,
          commandId: command.commandId,
        }),
        type: "sidebar-order.legacy-imported",
        payload: {
          ...(command.expectedSidebarOrderRevision !== undefined
            ? { expectedSidebarOrderRevision: command.expectedSidebarOrderRevision }
            : {}),
          sidebarOrderRevision: nextSidebarOrderRevision(readModel.sidebarOrderRevision),
          items: compactSidebarOrderItems(command.items),
          updatedAt: occurredAt,
        },
      };
    }

    case "sidebar-section.reorder": {
      yield* requireSidebarOrderAdmission({
        readModel,
        command,
        expectedRevision: command.expectedSidebarOrderRevision,
      });
      yield* requireSidebarSection({
        readModel,
        command,
        sectionId: command.sectionId,
      });
      const activeSectionIds = listActiveSidebarSections(readModel).map((section) => section.id);
      const orderedSectionIds = command.orderedSectionIds;
      const orderedSectionIdSet = new Set(orderedSectionIds);
      const hasExactActiveSet =
        orderedSectionIds.length === activeSectionIds.length &&
        orderedSectionIdSet.size === activeSectionIds.length &&
        activeSectionIds.every((sectionId) => orderedSectionIdSet.has(sectionId));
      if (!hasExactActiveSet) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Sidebar section order must contain every active section exactly once.",
        });
      }
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "sidebar-section",
          aggregateId: command.sectionId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "sidebar-section.order-updated",
        payload: {
          sectionId: command.sectionId,
          orderedSectionIds,
          sidebarOrderRevision: nextSidebarOrderRevision(readModel.sidebarOrderRevision),
          updatedAt: occurredAt,
        },
      };
    }

    case "sidebar-section.thread.place": {
      yield* requireSidebarOrderAdmission({
        readModel,
        command,
        expectedRevision: command.expectedSidebarOrderRevision,
      });
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      let targetSection: NonNullable<OrchestrationReadModel["sidebarSections"]>[number] | undefined;
      const orderItems = currentSidebarOrderItems(readModel, workspacePaths);
      try {
        validateSidebarOrderItems(orderItems, SIDEBAR_SECTION_ITEMS_MAX_COUNT);
      } catch (error) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: error instanceof Error ? error.message : "Sidebar order membership is corrupt.",
        });
      }
      if (command.destination === "custom") {
        if (command.sectionId === null) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "Custom placement requires a target sidebar section.",
          });
        }
        targetSection = yield* requireSidebarSection({
          readModel,
          command,
          sectionId: command.sectionId,
        });
        if (thread.deletedAt !== null || thread.archivedAt !== null) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "An archived or deleted thread cannot be placed in a custom section.",
          });
        }
        if (command.sectionCreatedAt === null) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "Custom placement requires the exact section incarnation.",
          });
        }
        if (command.sectionCreatedAt !== targetSection.createdAt) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "SIDEBAR_ORDER_REVISION_CONFLICT: target section incarnation changed.",
          });
        }
      } else if (command.sectionId !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Pinned and default placement cannot target a custom section.",
        });
      } else if (command.sectionCreatedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Pinned and default placement require a null section incarnation.",
        });
      }

      const sectionCreatedAt = command.destination === "custom" ? command.sectionCreatedAt : null;
      const targetItems = orderItems.filter(
        (item) =>
          item.key !== `thread:${thread.id}` &&
          item.destination === command.destination &&
          item.sectionId === (command.destination === "custom" ? command.sectionId : null) &&
          item.sectionCreatedAt === sectionCreatedAt,
      );
      if (targetItems.length >= SIDEBAR_SECTION_ITEMS_MAX_COUNT) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "The target sidebar placement is at capacity.",
        });
      }
      let placed;
      try {
        placed = placeSidebarThreadOrder(orderItems, {
          itemKey: `thread:${thread.id}`,
          itemType: "thread",
          destination: command.destination,
          sectionId: command.destination === "custom" ? command.sectionId : null,
          sectionCreatedAt,
          beforeThreadId: command.beforeThreadId,
          now: nowIso(),
        });
      } catch (error) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: error instanceof Error ? error.message : "Invalid sidebar drop target.",
        });
      }
      if (!placed.changed) {
        return {
          _tag: "SidebarOrderNoopDecision",
          sidebarOrderRevision: sidebarOrderRevisionOrZero(readModel.sidebarOrderRevision),
        } satisfies SidebarOrderNoopDecision;
      }

      const occurredAt = nowIso();
      const aggregateKind = command.destination === "custom" ? "sidebar-section" : "thread";
      const aggregateId = command.destination === "custom" ? command.sectionId! : command.threadId;
      const nextRevision = nextSidebarOrderRevision(readModel.sidebarOrderRevision);
      return {
        ...withEventBase({
          aggregateKind,
          aggregateId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "sidebar-section.thread-placed",
        payload: {
          sectionId: command.destination === "custom" ? command.sectionId : null,
          threadId: command.threadId,
          destination: command.destination,
          beforeThreadId: command.beforeThreadId,
          sectionCreatedAt,
          sortOrder: placed.next.sortOrder,
          sidebarOrderRevision: nextRevision,
          sidebarOrderItems: placed.items,
          updatedAt: occurredAt,
        },
      };
    }

    case "sidebar-section.project.place": {
      yield* requireSidebarOrderAdmission({
        readModel,
        command,
        expectedRevision: command.expectedSidebarOrderRevision,
      });
      const project = yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      if (
        project.deletedAt !== null ||
        !isOrdinaryProjectRow({
          projectKind: project.kind,
          projectTitle: project.title,
          projectWorkspaceRoot: project.workspaceRoot,
          workspacePaths,
        })
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Only active ordinary projects can be placed in the sidebar.",
        });
      }
      const orderItems = currentSidebarOrderItems(readModel, workspacePaths);
      try {
        validateSidebarOrderItems(orderItems, SIDEBAR_SECTION_ITEMS_MAX_COUNT);
      } catch (error) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: error instanceof Error ? error.message : "Sidebar order membership is corrupt.",
        });
      }
      let targetSection: NonNullable<OrchestrationReadModel["sidebarSections"]>[number] | undefined;
      if (command.destination === "custom") {
        if (command.sectionId === null || command.sectionCreatedAt === null) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "Custom project placement requires the exact target section incarnation.",
          });
        }
        targetSection = yield* requireSidebarSection({
          readModel,
          command,
          sectionId: command.sectionId,
        });
        if (targetSection.createdAt !== command.sectionCreatedAt) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "SIDEBAR_ORDER_REVISION_CONFLICT: target section incarnation changed.",
          });
        }
      } else if (command.sectionId !== null || command.sectionCreatedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Pinned and default project placement cannot carry custom-section identity.",
        });
      }
      const sectionCreatedAt = command.destination === "custom" ? command.sectionCreatedAt : null;
      const targetCount = orderItems.filter(
        (item) =>
          item.destination === command.destination &&
          item.sectionId === (command.destination === "custom" ? command.sectionId : null) &&
          item.sectionCreatedAt === sectionCreatedAt &&
          item.key !== `project:${project.id}`,
      ).length;
      if (targetCount >= SIDEBAR_SECTION_ITEMS_MAX_COUNT) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "The target sidebar placement is at capacity.",
        });
      }
      let placed;
      try {
        placed = placeSidebarOrderItem(orderItems, {
          itemKey: `project:${project.id}`,
          itemType: "project",
          destination: command.destination,
          sectionId: command.destination === "custom" ? command.sectionId : null,
          sectionCreatedAt,
          beforeItemKey: command.beforeItemKey,
          now: nowIso(),
        });
      } catch (error) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: error instanceof Error ? error.message : "Invalid sidebar drop target.",
        });
      }
      if (!placed.changed) {
        return {
          _tag: "SidebarOrderNoopDecision",
          sidebarOrderRevision: sidebarOrderRevisionOrZero(readModel.sidebarOrderRevision),
        } satisfies SidebarOrderNoopDecision;
      }
      const occurredAt = nowIso();
      const nextRevision = nextSidebarOrderRevision(readModel.sidebarOrderRevision);
      return {
        ...withEventBase({
          aggregateKind: command.destination === "custom" ? "sidebar-section" : "project",
          aggregateId: command.destination === "custom" ? command.sectionId! : project.id,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "sidebar-section.project-placed",
        payload: {
          sectionId: command.destination === "custom" ? command.sectionId : null,
          projectId: project.id,
          destination: command.destination,
          beforeItemKey: command.beforeItemKey,
          sortOrder: placed.next.sortOrder,
          sectionCreatedAt,
          sidebarOrderRevision: nextRevision,
          sidebarOrderItems: placed.items,
          updatedAt: occurredAt,
        },
      };
    }

    case "sidebar-section.thread.reorder": {
      yield* requireSidebarOrderAdmission({
        readModel,
        command,
        expectedRevision: command.expectedSidebarOrderRevision,
      });
      const section = yield* requireSidebarSection({
        readModel,
        command,
        sectionId: command.sectionId,
      });
      if (section.createdAt !== command.sectionCreatedAt) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "SIDEBAR_ORDER_REVISION_CONFLICT: target section incarnation changed.",
        });
      }
      const orderItems = currentSidebarOrderItems(readModel, workspacePaths);
      const sectionThreadItems = orderItems.filter(
        (item) =>
          item.itemType === "thread" &&
          item.destination === "custom" &&
          item.sectionId === section.id &&
          item.sectionCreatedAt === section.createdAt,
      );
      for (const item of sectionThreadItems) {
        const threadId = item.key.slice("thread:".length);
        const thread = readModel.threads.find((candidate) => candidate.id === threadId);
        if (thread === undefined || thread.deletedAt !== null || thread.archivedAt !== null) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "The target section contains an inactive thread and must be rehydrated.",
          });
        }
      }
      let reordered;
      try {
        reordered = reorderSidebarSectionThreads(orderItems, {
          sectionId: section.id,
          sectionCreatedAt: section.createdAt,
          orderedThreadIds: command.orderedThreadIds,
          now: nowIso(),
        });
      } catch (error) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: error instanceof Error ? error.message : "Invalid section thread order.",
        });
      }
      if (!reordered.changed) {
        return {
          _tag: "SidebarOrderNoopDecision",
          sidebarOrderRevision: sidebarOrderRevisionOrZero(readModel.sidebarOrderRevision),
        } satisfies SidebarOrderNoopDecision;
      }
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "sidebar-section",
          aggregateId: section.id,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "sidebar-section.thread-order-updated",
        payload: {
          sectionId: section.id,
          sectionCreatedAt: section.createdAt,
          orderedThreadIds: command.orderedThreadIds,
          sidebarOrderRevision: nextSidebarOrderRevision(readModel.sidebarOrderRevision),
          sidebarOrderItems: reordered.items,
          updatedAt: occurredAt,
        },
      };
    }

    case "sidebar-projects.reorder": {
      yield* requireSidebarOrderAdmission({
        readModel,
        command,
        expectedRevision: command.expectedSidebarOrderRevision,
      });
      const orderItems = currentSidebarOrderItems(readModel, workspacePaths);
      for (const projectId of command.orderedProjectIds) {
        const project = readModel.projects.find((candidate) => candidate.id === projectId);
        if (
          project === undefined ||
          project.deletedAt !== null ||
          !isOrdinaryProjectRow({
            projectKind: project.kind,
            projectTitle: project.title,
            projectWorkspaceRoot: project.workspaceRoot,
            workspacePaths,
          })
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Project '${projectId}' is not an active ordinary project.`,
          });
        }
      }
      let reordered;
      try {
        reordered = reorderSidebarProjects(orderItems, {
          orderedProjectIds: command.orderedProjectIds,
          now: nowIso(),
        });
      } catch (error) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: error instanceof Error ? error.message : "Invalid default project order.",
        });
      }
      if (!reordered.changed) {
        return {
          _tag: "SidebarOrderNoopDecision",
          sidebarOrderRevision: sidebarOrderRevisionOrZero(readModel.sidebarOrderRevision),
        } satisfies SidebarOrderNoopDecision;
      }
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "sidebar-section",
          aggregateId: "sidebar-order" as OrchestrationEvent["aggregateId"],
          occurredAt,
          commandId: command.commandId,
        }),
        type: "sidebar-projects.order-updated",
        payload: {
          orderedProjectIds: command.orderedProjectIds,
          sidebarOrderRevision: nextSidebarOrderRevision(readModel.sidebarOrderRevision),
          sidebarOrderItems: reordered.items,
          updatedAt: occurredAt,
        },
      };
    }

    default: {
      command satisfies never;
      const fallback = command as never as { type: string };
      return yield* new OrchestrationCommandInvariantError({
        commandType: fallback.type,
        detail: `Unknown command type: ${fallback.type}`,
      });
    }
  }
});
