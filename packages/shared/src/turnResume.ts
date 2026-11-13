// FILE: turnResume.ts
// Purpose: The one rule for "may this chat continue its latest turn now", shared by the
//          server's admission check and every client that offers Continue.
// Layer: Shared orchestration policy
// Exports: threadHasInFlightTurn, threadHasActiveOrQueuedTurn, INTERRUPTED_TASK_CONTINUATION_PROMPT,
//          isInterruptedTaskContinuationPrompt
// Why: The server refused Continue after Stop because it counted every person message
//      without a turn id as queued work, while clients offered the button. Both sides now
//      read the same predicate, and it looks only at turn and session state, which the
//      server and the clients see alike.

import type {
  OrchestrationLatestTurn,
  OrchestrationSession,
  OrchestrationThreadActivity,
} from "@moss/contracts";

/**
 * The text of the turn that continues an interrupted task. The model reads it; the
 * person sees it as their own message, the same one the "Continue task" card sends.
 */
export const INTERRUPTED_TASK_CONTINUATION_PROMPT =
  "Continue the interrupted task from the existing conversation and working state. First verify which operations have already completed; avoid repeating them and resume the remaining work.";

/**
 * True for a person message that is exactly the continuation instruction. Clients
 * show their own localized line in its place, the way an image-only send shows a
 * placeholder instead of its bootstrap prompt.
 */
export function isInterruptedTaskContinuationPrompt(text: string): boolean {
  return text.trim() === INTERRUPTED_TASK_CONTINUATION_PROMPT;
}

/**
 * Activity kinds that mark a turn as still waiting in a queue. Imported and replayed
 * snapshots may carry them; live queues reach the session state before they matter.
 */
const QUEUED_TURN_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  "turn.queued",
  "turn.dispatch-queued",
  "provider.turn.queued",
]);

/**
 * True when the thread still has an in-flight / unsettled turn:
 * session mid-lifecycle ("starting"/"running"), a non-error session with an
 * activeTurnId, or a latestTurn still projected as "running".
 *
 * Runtime errors can retain the failed turn id for attribution even though the
 * session and turn are terminal, so an errored session's activeTurnId is stale.
 */
export function threadHasInFlightTurn(thread: {
  readonly session: Pick<OrchestrationSession, "status" | "activeTurnId"> | null;
  readonly latestTurn: Pick<OrchestrationLatestTurn, "state"> | null;
}): boolean {
  const session = thread.session;
  return (
    (session?.status !== "error" && session?.activeTurnId != null) ||
    session?.status === "starting" ||
    session?.status === "running" ||
    thread.latestTurn?.state === "running"
  );
}

/**
 * True while another turn is running, about to start, or waiting in a queue, so
 * continuing the latest turn now would race it.
 *
 * A queued follow-up exists only while a turn runs (a send to an idle chat starts at
 * once), and the server promotes it the moment that turn settles; the promotion's
 * start request puts the session back in "starting". A person's Stop cancels queued
 * follow-ups outright. So the session and the latest turn already say everything
 * about queued work. Person messages are deliberately not inspected: a message never
 * gets a turn id on most start paths, so "no turn id" does not mean "still queued".
 */
export function threadHasActiveOrQueuedTurn(thread: {
  readonly session: Pick<OrchestrationSession, "status" | "activeTurnId"> | null;
  readonly latestTurn: Pick<OrchestrationLatestTurn, "turnId" | "state" | "completedAt"> | null;
  readonly activities: ReadonlyArray<Pick<OrchestrationThreadActivity, "kind" | "turnId">>;
}): boolean {
  if (threadHasInFlightTurn(thread)) return true;
  const latestTurn = thread.latestTurn;
  if (latestTurn !== null && latestTurn.completedAt == null) return true;
  return thread.activities.some(
    (activity) =>
      latestTurn !== null &&
      activity.turnId === latestTurn.turnId &&
      QUEUED_TURN_ACTIVITY_KINDS.has(activity.kind),
  );
}
