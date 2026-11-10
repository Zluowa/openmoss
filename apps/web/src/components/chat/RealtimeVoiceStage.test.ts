import { describe, expect, it } from "vitest";

import {
  realtimeVoiceOrbDragProgress,
  realtimeVoiceStatus,
  realtimeVoiceTranscriptLines,
  shouldDetachRealtimeVoiceOrb,
} from "./RealtimeVoiceStage";

describe("Realtime Voice orb detach threshold", () => {
  it("detaches at 52px of pointer offset", () => {
    expect(shouldDetachRealtimeVoiceOrb({ offset: { x: 51.99, y: 0 }, velocity: null })).toBe(
      false,
    );
    expect(shouldDetachRealtimeVoiceOrb({ offset: { x: 52, y: 0 }, velocity: null })).toBe(true);
  });

  it("detaches at 720px/s even below the distance threshold", () => {
    expect(
      shouldDetachRealtimeVoiceOrb({
        offset: { x: 8, y: 0 },
        velocity: { x: 719.99, y: 0 },
      }),
    ).toBe(false);
    expect(
      shouldDetachRealtimeVoiceOrb({
        offset: { x: 8, y: 0 },
        velocity: { x: 720, y: 0 },
      }),
    ).toBe(true);
  });

  it("uses vector magnitude for diagonal drags and flicks", () => {
    expect(
      shouldDetachRealtimeVoiceOrb({ offset: { x: 36, y: 36 }, velocity: { x: 400, y: 400 } }),
    ).toBe(false);
    expect(
      shouldDetachRealtimeVoiceOrb({ offset: { x: 37, y: 37 }, velocity: { x: 400, y: 400 } }),
    ).toBe(true);
  });

  it("matches Codex's 12px visual dead zone and 52px full detach progress", () => {
    expect(realtimeVoiceOrbDragProgress({ x: 12, y: 0 })).toBe(0);
    expect(realtimeVoiceOrbDragProgress({ x: 32, y: 0 })).toBe(0.5);
    expect(realtimeVoiceOrbDragProgress({ x: 52, y: 0 })).toBe(1);
    expect(realtimeVoiceOrbDragProgress({ x: 104, y: 0 })).toBe(1);
  });
});

describe("Realtime Voice status line", () => {
  const base = {
    phase: "active",
    activity: "listening",
    inputMuted: false,
  } as unknown as Parameters<typeof realtimeVoiceStatus>[0];

  it.each([
    [{ phase: "starting" }, "realtimeVoice.stage.status.connecting", "connecting"],
    [{ phase: "stopping" }, "realtimeVoice.stage.status.ending", "connecting"],
    [{ activity: "listening" }, "realtimeVoice.stage.status.listening", "listening"],
    [{ activity: "thinking" }, "realtimeVoice.stage.status.thinking", "thinking"],
    [{ activity: "speaking" }, "realtimeVoice.stage.status.speaking", "speaking"],
    [{ inputMuted: true }, "realtimeVoice.stage.status.muted", "muted"],
  ] as const)("%o -> %s", (override, key, tone) => {
    expect(realtimeVoiceStatus({ ...base, ...override } as typeof base)).toEqual({ key, tone });
  });

  it("splits the live transcript into non-empty lines", () => {
    expect(realtimeVoiceTranscriptLines(" 你好 \n\n帮我画图\n")).toEqual(["你好", "帮我画图"]);
  });
});
