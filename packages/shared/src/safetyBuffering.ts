import {
  ModelSafetyBufferingUpdatedPayload,
  type OrchestrationThreadActivity,
  type TurnId,
} from "@synara/contracts";
import { Schema } from "effect";

const isSafetyBufferingPayload = Schema.is(ModelSafetyBufferingUpdatedPayload);

/** Keep false updates authoritative, including when snapshot activities arrive unordered. */
export function latestSafetyBufferingActivity(
  activities: readonly OrchestrationThreadActivity[],
  turnId: TurnId,
): { activity: OrchestrationThreadActivity; payload: ModelSafetyBufferingUpdatedPayload } | null {
  let latest: OrchestrationThreadActivity | undefined;
  for (const activity of activities) {
    if (activity.kind !== "model.safety-buffering.updated" || activity.turnId !== turnId) continue;
    if (
      !latest ||
      ((activity.sequence ?? -1) - (latest.sequence ?? -1) ||
        activity.createdAt.localeCompare(latest.createdAt) ||
        activity.id.localeCompare(latest.id)) >= 0
    )
      latest = activity;
  }
  return latest && isSafetyBufferingPayload(latest.payload) && latest.payload.turnId === turnId
    ? { activity: latest, payload: latest.payload }
    : null;
}

/**
 * Safety-buffering payload.threadId is bound at the trusted activity route to the
 * canonical Moss thread. Adapter-native provider IDs must not be compared here.
 */
export function isSafetyBufferingBoundToThread(
  payload: Pick<ModelSafetyBufferingUpdatedPayload, "threadId"> | null | undefined,
  mossThreadId: string,
): boolean {
  const claimed = payload?.threadId.trim() ?? "";
  return claimed.length > 0 && claimed === mossThreadId;
}
