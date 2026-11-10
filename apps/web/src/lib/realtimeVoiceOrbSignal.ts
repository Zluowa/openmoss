// FILE: realtimeVoiceOrbSignal.ts
// Purpose: Blend the microphone level into the orb's audio signal so the orb visibly reacts
//          while the person talks, not only while Moss speaks.
// Layer: Realtime Voice presentation utility
// Exports: mergeRealtimeVoiceOrbSignal

import type { RealtimeVoiceActivity } from "@moss/contracts";

import type { RealtimeVoiceOutputSignal } from "./realtimeVoiceWebRtc";

/** Below this the output is treated as silent and the microphone drives the orb. */
const OUTPUT_AUDIBLE_LEVEL = 0.02;

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

/**
 * Moss's own voice always wins while it is speaking. Otherwise, the microphone level (already
 * normalised to 0..1) is spread across the bands, weighted to the low and mid bands where speech
 * energy sits. A muted microphone contributes nothing.
 */
export function mergeRealtimeVoiceOrbSignal(input: {
  readonly output: RealtimeVoiceOutputSignal;
  readonly inputLevel: number;
  readonly activity: RealtimeVoiceActivity | null;
  readonly inputMuted: boolean;
}): RealtimeVoiceOutputSignal {
  const output = input.output;
  if (input.activity === "speaking" || output.overall >= OUTPUT_AUDIBLE_LEVEL) return output;
  const level = input.inputMuted ? 0 : clamp01(input.inputLevel);
  if (level <= 0) return output;
  return {
    low: Math.max(output.low, level),
    mid: Math.max(output.mid, level * 0.8),
    high: Math.max(output.high, level * 0.45),
    overall: Math.max(output.overall, level),
  };
}
