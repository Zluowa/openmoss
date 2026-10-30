// FILE: composerPrediction.ts
// Purpose: Model-backed gray completion for the shared composer, accepted with Tab.
// Layer: Chat composer
// Exports: deriveModelComposerPrediction, applyComposerPrediction,
//   createPredictionTriggerTracker, COMPOSER_PREDICTION_ACCEPTED_STORAGE_KEY

import type { NextMessagePredictionGenerationTrigger } from "@synara/contracts";

export const COMPOSER_PREDICTION_ACCEPTED_STORAGE_KEY = "moss:composer-prediction-accepted:v1";

/**
 * Codex labels a prediction `live` when the composer watched the thread's latest turn run and
 * settle, and `catch_up` when it is requested for an already idle thread (mount, thread switch,
 * window focus). Only the first request for that turn is live; later ones catch up.
 */
export function createPredictionTriggerTracker() {
  let observedActiveKey: string | null = null;
  return {
    observeActiveTurn(predictionKey: string): void {
      observedActiveKey = predictionKey;
    },
    takeTrigger(predictionKey: string): NextMessagePredictionGenerationTrigger {
      const trigger = observedActiveKey === predictionKey ? "live" : "catch_up";
      observedActiveKey = null;
      return trigger;
    },
  };
}

export interface ComposerPrediction {
  readonly value: string;
  readonly suffix: string;
}

/** Convert a server prediction into the empty-composer gray-completion shape. */
export function deriveModelComposerPrediction(input: {
  readonly prompt: string;
  readonly text: string | null | undefined;
}): ComposerPrediction | null {
  const text = input.text ?? "";
  if (input.prompt.length > 0 || text.trim().length === 0) {
    return null;
  }
  return { value: text, suffix: text };
}

/** Reject a stale completion instead of appending it to a draft that changed. */
export function applyComposerPrediction(prompt: string, prediction: ComposerPrediction): string {
  if (
    prompt.length > 0 ||
    prediction.value.length <= prompt.length ||
    !prediction.value.toLocaleLowerCase().startsWith(prompt.toLocaleLowerCase())
  ) {
    return prompt;
  }
  return `${prompt}${prediction.value.slice(prompt.length)}`;
}
