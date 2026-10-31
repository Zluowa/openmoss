/**
 * What of the owner's thread a guest receives. The guest page renders the same thread stream
 * items as the owner's `subscribeThread`, so the transcript (messages, activities, plans, turn
 * and session lifecycle, title and model) passes through, while owner-private state (notes,
 * pins, markers, goals, handoffs, cache reviews, pending interactions, local paths, gateway and
 * pull-request bookkeeping) is cleared from the snapshot and its events are not forwarded.
 */
import {
  SECRET_REQUEST_ACTIVITY_KIND,
  SECRET_REQUEST_RESOLVED_ACTIVITY_KIND,
  type ModelSelection,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadDetailSnapshot,
  type TurnId,
} from "@synara/contracts";

import { sanitizeOrchestrationEventProviderOptions } from "../orchestration/providerOptionsSecurity.ts";

type ThreadMetaUpdatedEvent = Extract<OrchestrationEvent, { type: "thread.meta-updated" }>;

/** Transcript events a guest follows; the owner subscription's other detail events stay home. */
export const GUEST_FORWARDED_EVENT_TYPES: ReadonlySet<OrchestrationEvent["type"]> = new Set<
  OrchestrationEvent["type"]
>([
  "thread.message-sent",
  "thread.turn-start-requested",
  "thread.session-stop-requested",
  "thread.async-user-input-answered",
  "thread.proposed-plan-upserted",
  "thread.activity-appended",
  "thread.turn-diff-completed",
  "thread.reverted",
  "thread.conversation-rolled-back",
  "thread.session-set",
  "thread.meta-updated",
]);

/** A secret request is between the owner and the agent: a guest has no way to answer it. */
const OWNER_ONLY_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  SECRET_REQUEST_ACTIVITY_KIND,
  SECRET_REQUEST_RESOLVED_ACTIVITY_KIND,
]);

/** Of a metadata update, only the title, the model, and the environment mode reach a guest. */
function sanitizeMetaUpdated(event: ThreadMetaUpdatedEvent): ThreadMetaUpdatedEvent | null {
  const { threadId, title, modelSelection, envMode, updatedAt } = event.payload;
  if (title === undefined && modelSelection === undefined && envMode === undefined) return null;
  return {
    ...event,
    payload: {
      threadId,
      ...(title === undefined ? {} : { title }),
      ...(modelSelection === undefined ? {} : { modelSelection }),
      ...(envMode === undefined ? {} : { envMode }),
      updatedAt,
    },
  };
}

/** The event as a guest may see it, or null when it is not forwarded at all. */
export function sanitizeGuestThreadEvent(event: OrchestrationEvent): OrchestrationEvent | null {
  if (!GUEST_FORWARDED_EVENT_TYPES.has(event.type)) return null;
  if (
    event.type === "thread.activity-appended" &&
    OWNER_ONLY_ACTIVITY_KINDS.has(event.payload.activity.kind)
  ) {
    return null;
  }
  const sanitized = sanitizeOrchestrationEventProviderOptions(event);
  return sanitized.type === "thread.meta-updated" ? sanitizeMetaUpdated(sanitized) : sanitized;
}

/** The model a thread event switched to, when it carries one. */
export function modelSelectionOfEvent(event: OrchestrationEvent): ModelSelection | null {
  if (event.type === "thread.meta-updated" || event.type === "thread.session-set") {
    return event.payload.modelSelection ?? null;
  }
  return null;
}

/** Clears owner-private fields; the transcript collections are left to the window below. */
export function sanitizeGuestThread(thread: OrchestrationThread): OrchestrationThread {
  const {
    notes: _notes,
    pinnedMessages: _pinnedMessages,
    threadMarkers: _threadMarkers,
    goal: _goal,
    goalStartedAt: _goalStartedAt,
    goalPausedAt: _goalPausedAt,
    goalAchievements: _goalAchievements,
    pendingInteractions: _pendingInteractions,
    ...visible
  } = thread;
  return {
    ...visible,
    activities: visible.activities.filter(
      (activity) => !OWNER_ONLY_ACTIVITY_KINDS.has(activity.kind),
    ),
    branch: null,
    worktreePath: null,
    workingDirectory: null,
    associatedWorktreePath: null,
    associatedWorktreeBranch: null,
    associatedWorktreeRef: null,
    gatewayOperationId: null,
    gatewayOperationIndex: null,
    lastKnownPr: null,
    handoff: null,
    claudeCacheReview: null,
  };
}

export interface GuestSnapshotBounds {
  /** Newest user turns kept; everything older is cut and not pageable. */
  readonly userTurnLimit: number;
  readonly messageLimit: number;
}

/**
 * The owner's detail snapshot as a guest receives it: scrubbed, and cut to the newest user
 * turns. Activities, plans, and checkpoints of cut turns go with them. The history reports no
 * older cursor, so the page shows no "load older" control.
 */
export function sanitizeGuestThreadSnapshot(
  detail: OrchestrationThreadDetailSnapshot,
  bounds: GuestSnapshotBounds,
): OrchestrationThreadDetailSnapshot {
  const thread = sanitizeGuestThread(detail.thread);
  const windowed = thread.messages.slice(-bounds.messageLimit);
  let start = 0;
  let userTurns = 0;
  for (let index = windowed.length - 1; index >= 0; index -= 1) {
    if (windowed[index]!.role !== "user") continue;
    userTurns += 1;
    if (userTurns === bounds.userTurnLimit) {
      start = index;
      break;
    }
  }
  const messages = windowed.slice(start);
  const cut = messages.length < thread.messages.length;
  const keptTurnIds = new Set(
    messages.flatMap((message) => (message.turnId === null ? [] : [message.turnId])),
  );
  const oldestKeptAt = messages[0]?.createdAt ?? null;
  const keepsTurn = (turnId: TurnId | null, createdAt: string) =>
    !cut ||
    (turnId !== null
      ? keptTurnIds.has(turnId)
      : oldestKeptAt === null || createdAt >= oldestKeptAt);
  const activities = thread.activities.filter((activity) =>
    keepsTurn(activity.turnId, activity.createdAt),
  );
  const proposedPlans = thread.proposedPlans.filter((plan) =>
    keepsTurn(plan.turnId, plan.createdAt),
  );
  const checkpoints = cut
    ? thread.checkpoints.filter((checkpoint) => keptTurnIds.has(checkpoint.turnId))
    : thread.checkpoints;
  return {
    snapshotSequence: detail.snapshotSequence,
    thread: { ...thread, messages, activities, proposedPlans, checkpoints },
    history: {
      totalMessageCount: messages.length,
      olderCursor: null,
      olderActivityCursor: null,
      totalActivityCount: activities.length,
      ...(detail.history?.revisionSequence === undefined
        ? {}
        : { revisionSequence: detail.history.revisionSequence }),
    },
    ...(detail.historyRevisionSequence === undefined
      ? {}
      : { historyRevisionSequence: detail.historyRevisionSequence }),
  };
}
