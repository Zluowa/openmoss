// FILE: workingStatus.ts
// Purpose: The desktop chat's working-line wording. A long think escalates its words
//          at fixed points (15/30/45/60 s) so a quiet wait still reads as progress;
//          a send in flight reads "Sending…".
// Layer: Chat transcript presentation logic (pure)
//          A provider start that runs past a few seconds says so, and that Moss keeps waiting.
// Exports: THINKING_TIER_SECONDS, SLOW_PROVIDER_START_NOTICE_MS, startingProviderName,
//          thinkingStatusKey, workingStatusKey

import type { TranslationKey } from "~/localization";

/** Seconds at which the thinking words step up, in order. */
export const THINKING_TIER_SECONDS = [15, 30, 45, 60] as const;

const THINKING_TIER_KEYS = [
  "transcript.working.thinking",
  "transcript.working.stillThinking",
  "transcript.working.thinkingMore",
  "transcript.working.thinkingSomeMore",
  "transcript.working.almostDone",
] as const satisfies ReadonlyArray<TranslationKey>;

export function thinkingStatusKey(elapsedSeconds: number): TranslationKey {
  let tier = 0;
  for (const threshold of THINKING_TIER_SECONDS) {
    if (elapsedSeconds >= threshold) tier += 1;
  }
  return THINKING_TIER_KEYS[tier]!;
}

/**
 * Key for the transcript's working label, or null to keep the label as given
 * (provider start, retry and delivery-check lines carry their own text).
 */
export function workingStatusKey(label: string, elapsedSeconds: number): TranslationKey | null {
  if (label === "Thinking") return thinkingStatusKey(elapsedSeconds);
  if (label === "Loading") return "transcript.working.sending";
  return null;
}

/** A provider start still running after this long reads as slow on the working line. */
export const SLOW_PROVIDER_START_NOTICE_MS = 8_000;

const STARTING_PROVIDER_LABEL = /^Starting (.+)…$/u;

/** The provider named by a "Starting <provider>…" working label, or null. */
export function startingProviderName(label: string): string | null {
  return STARTING_PROVIDER_LABEL.exec(label)?.[1] ?? null;
}
