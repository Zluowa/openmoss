import type { OrchestrationEvent, OrchestrationThreadActivity, TurnId } from "@moss/contracts";

// Explicit manual Stop (`user`) certifies "Stopped by you", while steer
// interrupts (`steer`) certify a neutral steer-cutoff boundary so the timeline
// never renders a fake error or alarming warning icon. Automatic, agent and
// historical requests remain neutral without an activity.
export function deriveTurnStopActivity(
  event: Extract<OrchestrationEvent, { type: "thread.turn-interrupt-requested" }>,
  activeTurnId: TurnId | null,
): OrchestrationThreadActivity | null {
  const requestedBy = event.payload.requestedBy;
  if (requestedBy !== "user" && requestedBy !== "steer") return null;
  const turnId = event.payload.turnId ?? activeTurnId;
  if (turnId === null) return null;
  return {
    id: event.eventId,
    turnId,
    createdAt: event.payload.createdAt,
    tone: "info",
    kind: "turn.stop-requested",
    summary: requestedBy === "steer" ? "Steer interrupt requested" : "Stop requested",
    payload: { requestedBy },
    sequence: event.sequence,
    sequenceSource: "orchestration",
  };
}
