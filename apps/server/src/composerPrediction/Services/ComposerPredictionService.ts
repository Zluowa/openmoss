import type {
  ServerGenerateComposerPredictionInput,
  ServerGenerateComposerPredictionResult,
} from "@moss/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

/**
 * Composer predictions: one predicted next user message for a thread's settled latest turn,
 * generated on the chat's own provider instance through the isolated text-generation path,
 * or, for a Codex chat that path refuses on this platform, through Codex's native prediction
 * fork of the live thread.
 */
export interface ComposerPredictionServiceShape {
  /**
   * Always sets `outcome`: `suggested` with a suggestion, `none` when the model answered
   * with no suggestion or when no route can serve the chat for the rest of the turn, and
   * `unavailable` for every other miss (a busy or moved-on turn, a route that may still
   * appear, a timeout, or a failed generation), which a later call for the same turn may
   * still turn into an answer. Concurrent calls for the same thread and turn share one
   * generation, which is interrupted once every caller has stopped waiting. It starts
   * after a short delay, so a caller that stops waiting sooner starts no provider
   * process, and the model's answer is reused for later calls about the same turn.
   */
  readonly generate: (
    input: ServerGenerateComposerPredictionInput,
  ) => Effect.Effect<ServerGenerateComposerPredictionResult>;
}

export class ComposerPredictionService extends ServiceMap.Service<
  ComposerPredictionService,
  ComposerPredictionServiceShape
>()("moss/composerPrediction/Services/ComposerPredictionService") {}
