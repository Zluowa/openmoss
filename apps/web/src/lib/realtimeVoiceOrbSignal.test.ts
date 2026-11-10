import { describe, expect, it } from "vitest";

import { mergeRealtimeVoiceOrbSignal } from "./realtimeVoiceOrbSignal";

const SILENT = { low: 0, mid: 0, high: 0, overall: 0 };

describe("mergeRealtimeVoiceOrbSignal", () => {
  it("lets the microphone drive the orb while the person talks", () => {
    expect(
      mergeRealtimeVoiceOrbSignal({
        output: SILENT,
        inputLevel: 0.4,
        activity: "listening",
        inputMuted: false,
      }),
    ).toEqual({ low: 0.4, mid: 0.4 * 0.8, high: 0.4 * 0.45, overall: 0.4 });
  });

  it("keeps Moss's own voice while it is speaking", () => {
    const output = { low: 0.1, mid: 0.2, high: 0.05, overall: 0.15 };
    expect(
      mergeRealtimeVoiceOrbSignal({
        output,
        inputLevel: 0.9,
        activity: "speaking",
        inputMuted: false,
      }),
    ).toBe(output);
  });

  it("ignores a muted microphone and clamps bad levels", () => {
    expect(
      mergeRealtimeVoiceOrbSignal({
        output: SILENT,
        inputLevel: 0.8,
        activity: "listening",
        inputMuted: true,
      }),
    ).toBe(SILENT);
    expect(
      mergeRealtimeVoiceOrbSignal({
        output: SILENT,
        inputLevel: Number.NaN,
        activity: "listening",
        inputMuted: false,
      }),
    ).toBe(SILENT);
    expect(
      mergeRealtimeVoiceOrbSignal({
        output: SILENT,
        inputLevel: 4,
        activity: "thinking",
        inputMuted: false,
      }).overall,
    ).toBe(1);
  });
});
