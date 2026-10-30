import { describe, expect, it, vi } from "vitest";

import {
  REALTIME_VOICE_ORB_WEBGL_CONTEXT_ATTRIBUTES,
  RealtimeVoiceOrbRenderer,
  advanceRealtimeVoiceOrbState,
  realtimeVoiceOrbBackingStoreSize,
  realtimeVoiceOrbCorePhase,
  realtimeVoiceOrbSmoothingFactor,
  realtimeVoiceOrbStateTargets,
  syntheticRealtimeVoiceOrbAudio,
  type RealtimeVoiceOrbAnimationRuntime,
} from "./realtimeVoiceOrbRenderer";

describe("Realtime Voice orb phase projection", () => {
  it.each([
    ["inactive", "inactive"],
    ["reserving", "starting"],
    ["presenting", "starting"],
    ["starting", "starting"],
    ["active", "active"],
    ["stopping", "stopping"],
    ["failed", "inactive"],
  ] as const)("maps Moss %s to the Codex %s core phase", (phase, expected) => {
    expect(realtimeVoiceOrbCorePhase(phase)).toBe(expected);
  });

  it("uses the captured listen/think/speak weights for every core state", () => {
    expect(realtimeVoiceOrbStateTargets("inactive", null)).toEqual({
      listen: 0,
      speak: 0,
      think: 0,
    });
    expect(realtimeVoiceOrbStateTargets("starting", null)).toEqual({
      listen: 0,
      speak: 0,
      think: 1,
    });
    expect(realtimeVoiceOrbStateTargets("stopping", null)).toEqual({
      listen: 0.35,
      speak: 0,
      think: 0,
    });
    expect(realtimeVoiceOrbStateTargets("active", "listening")).toEqual({
      listen: 1,
      speak: 0,
      think: 0,
    });
    expect(realtimeVoiceOrbStateTargets("active", "thinking")).toEqual({
      listen: 0.65,
      speak: 0,
      think: 1,
    });
    expect(realtimeVoiceOrbStateTargets("active", "speaking")).toEqual({
      listen: 0.2,
      speak: 1,
      think: 0,
    });
  });

  it("uses 280ms exponential state smoothing, a 0.6 starting floor, and exact previews", () => {
    expect(realtimeVoiceOrbSmoothingFactor(0.28, 0.28)).toBeCloseTo(1 - Math.exp(-1), 12);
    const live = advanceRealtimeVoiceOrbState(
      { listen: 0, speak: 0, think: 0 },
      "presenting",
      null,
      0.01,
      false,
    );
    expect(live.think).toBe(0.6);
    expect(advanceRealtimeVoiceOrbState(live, "active", "speaking", 0.016, true)).toEqual({
      listen: 0.2,
      speak: 1,
      think: 0,
    });
  });
});

describe("Realtime Voice orb audio response", () => {
  it("keeps idle silent and gives live speaking the captured 0.42 activity floor", () => {
    expect([...syntheticRealtimeVoiceOrbAudio(null, 0, true, 2)]).toEqual([0, 0, 0, 0]);
    const speaking = syntheticRealtimeVoiceOrbAudio("speaking", 0, true, 2);
    expect(speaking[3]).toBeGreaterThan(0);
    expect(speaking[0]).toBeGreaterThan(0);
    expect(speaking[1]).toBeGreaterThan(0);
    expect(speaking[2]).toBeGreaterThan(0);
  });

  it("is deterministic at a fixed preview time and clamps invalid preview levels", () => {
    const first = syntheticRealtimeVoiceOrbAudio("thinking", 0.7, false, 4.25);
    const second = syntheticRealtimeVoiceOrbAudio("thinking", 0.7, false, 4.25);
    expect([...second]).toEqual([...first]);
    expect(syntheticRealtimeVoiceOrbAudio("listening", Number.NaN, false, 1)[3]).toBe(0);
    expect(syntheticRealtimeVoiceOrbAudio("listening", 10, false, 1)[3]).toBeLessThanOrEqual(1);
  });
});

describe("Realtime Voice orb rendering contract", () => {
  it("caps Retina backing storage at 1.5x", () => {
    expect(realtimeVoiceOrbBackingStoreSize(152, 152, 2)).toEqual({
      width: 228,
      height: 228,
      pixelRatio: 1.5,
    });
    expect(realtimeVoiceOrbBackingStoreSize(0, 0, Number.NaN)).toEqual({
      width: 1,
      height: 1,
      pixelRatio: 1,
    });
  });

  it("requests the exact transparent WebGL contract and paints Canvas2D when unavailable", () => {
    const contextRequests: Array<{ readonly type: string; readonly options?: unknown }> = [];
    const addColorStop = vi.fn();
    const fallbackContext = {
      arc: vi.fn(),
      beginPath: vi.fn(),
      clearRect: vi.fn(),
      createLinearGradient: vi.fn(() => ({ addColorStop })),
      fill: vi.fn(),
      fillStyle: "",
    };
    const canvas = {
      clientHeight: 152,
      clientWidth: 152,
      height: 152,
      width: 152,
      getContext(type: string, options?: unknown) {
        contextRequests.push({ type, ...(options === undefined ? {} : { options }) });
        return type === "2d" ? fallbackContext : null;
      },
    } as unknown as HTMLCanvasElement;
    const runtime: RealtimeVoiceOrbAnimationRuntime = {
      nowMs: () => 2_000,
      devicePixelRatio: () => 2,
      requestAnimationFrame: vi.fn(() => 1),
      cancelAnimationFrame: vi.fn(),
    };
    const renderer = new RealtimeVoiceOrbRenderer(canvas, runtime);

    renderer.setInputs({
      phase: "inactive",
      activity: null,
      previewAudioLevel: 0,
      readPublishedAudioLevels: () => ({ high: 1, low: 1, mid: 1, overall: 1 }),
    });

    expect(contextRequests[0]).toEqual({
      type: "webgl",
      options: REALTIME_VOICE_ORB_WEBGL_CONTEXT_ATTRIBUTES,
    });
    expect(contextRequests[1]).toEqual({ type: "2d" });
    expect(canvas.width).toBe(228);
    expect(canvas.height).toBe(228);
    expect(fallbackContext.clearRect).toHaveBeenCalledWith(0, 0, 228, 228);
    expect(addColorStop.mock.calls).toEqual([
      [0, "rgba(1, 129, 254, 1)"],
      [0.46, "rgba(164, 239, 255, 0.98)"],
      [1, "rgba(255, 253, 239, 0.98)"],
    ]);
    expect(runtime.requestAnimationFrame).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it("renders a fixed synthetic preview without a published-audio reader", () => {
    const arc = vi.fn();
    const fallbackContext = {
      arc,
      beginPath: vi.fn(),
      clearRect: vi.fn(),
      createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
      fill: vi.fn(),
      fillStyle: "",
    };
    const canvas = {
      clientHeight: 152,
      clientWidth: 152,
      height: 152,
      width: 152,
      getContext(type: string) {
        return type === "2d" ? fallbackContext : null;
      },
    } as unknown as HTMLCanvasElement;
    const runtime: RealtimeVoiceOrbAnimationRuntime = {
      nowMs: () => 2_000,
      devicePixelRatio: () => 1,
      requestAnimationFrame: vi.fn(() => 1),
      cancelAnimationFrame: vi.fn(),
    };
    const renderer = new RealtimeVoiceOrbRenderer(canvas, runtime);

    renderer.setInputs({
      phase: "active",
      activity: "speaking",
      previewAudioLevel: 0.48,
      previewTimeMs: 2_000,
    });

    const radius = arc.mock.calls.at(-1)?.[2] as number | undefined;
    expect(radius).toBeGreaterThan(152 * 0.29);
    expect(runtime.requestAnimationFrame).not.toHaveBeenCalled();
    renderer.dispose();
  });
});
