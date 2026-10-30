import { latestSafetyBufferingActivity } from "@synara/shared/safetyBuffering";
import type {
  OrchestrationLatestTurn,
  OrchestrationThreadActivity,
  TurnId,
} from "@synara/contracts";

export interface SafetyBufferingState {
  turnId: TurnId;
  model: string;
  fasterModel: string | null;
  reasons: readonly string[];
  useCases: readonly string[];
}

/** Only the latest update for the active turn can show (or clear) the banner. */
export function deriveSafetyBufferingState(
  activities: readonly OrchestrationThreadActivity[],
  latestTurn: OrchestrationLatestTurn | null,
): SafetyBufferingState | null {
  if (latestTurn?.state !== "running" || latestTurn.completedAt !== null) return null;
  const latest = latestSafetyBufferingActivity(activities, latestTurn.turnId);
  if (!latest?.payload.showBufferingUi) return null;
  const { model, fasterModel, reasons, useCases } = latest.payload;
  return {
    turnId: latestTurn.turnId,
    model,
    fasterModel: fasterModel?.trim() || null,
    reasons,
    useCases,
  };
}
