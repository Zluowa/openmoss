import { describe, expect, it } from "vitest";

import {
  buildRealtimeVoiceHandoffAnimation,
  realtimeVoiceHandoffOriginFromRect,
  type RealtimeVoiceHandoffMotion,
} from "./RealtimeVoiceHandoffTarget";

const target = {
  centerX: 500,
  centerY: 400,
  width: 112,
  height: 112,
} as const;

function handoff(overrides: Partial<RealtimeVoiceHandoffMotion>): RealtimeVoiceHandoffMotion {
  return {
    sequence: 1,
    from: "global-overlay",
    origin: null,
    velocity: null,
    ...overrides,
  };
}

describe("RealtimeVoiceHandoffTarget", () => {
  it("uses the build 6067 native-overlay fade when returning to the main thread", () => {
    const animation = buildRealtimeVoiceHandoffAnimation({
      handoff: handoff({ from: "global-overlay" }),
      surface: "main-thread",
      target,
      usesFadeTransition: true,
    });

    expect(animation.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(animation.options).toEqual({
      duration: 200,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      fill: "backwards",
    });
  });

  it("uses the 90ms opacity bridge from the main thread into the global overlay", () => {
    const animation = buildRealtimeVoiceHandoffAnimation({
      handoff: handoff({ from: "main-thread" }),
      surface: "global-overlay",
      target,
      usesFadeTransition: true,
    });

    expect(animation.keyframes).toEqual([{ opacity: 0.96 }, { opacity: 1 }]);
    expect(animation.options).toEqual({
      duration: 90,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      fill: "backwards",
    });
  });

  it("uses the 120ms blur settle for an effectively stationary main-thread handoff", () => {
    const animation = buildRealtimeVoiceHandoffAnimation({
      handoff: handoff({ origin: target }),
      surface: "main-thread",
      target,
    });

    expect(animation.keyframes).toEqual([
      { filter: "blur(1.5px)", opacity: 0.96 },
      { filter: "blur(0px)", opacity: 1 },
    ]);
    expect(animation.options.duration).toBe(120);
  });

  it("uses the bounded 300ms overshoot into the main thread", () => {
    const animation = buildRealtimeVoiceHandoffAnimation({
      handoff: handoff({
        origin: { centerX: 1_000, centerY: 400, width: 56, height: 56 },
        velocity: { x: 2_000, y: 0 },
      }),
      surface: "main-thread",
      target,
    });

    expect(animation.options).toMatchObject({ delay: 0, duration: 300, fill: "backwards" });
    expect(animation.keyframes).toHaveLength(4);
    expect(animation.keyframes[0]?.transform).toBe(
      "translate3d(300px, 0px, 0) scale(0.82) rotate(3deg)",
    );
    expect(animation.keyframes[1]?.offset).toBe(0.46);
    expect(animation.keyframes[2]?.offset).toBe(0.8);
  });

  it("uses the delayed 280ms path within the global overlay", () => {
    const animation = buildRealtimeVoiceHandoffAnimation({
      handoff: handoff({
        origin: { centerX: 540, centerY: 430, width: 112, height: 112 },
      }),
      surface: "global-overlay",
      target,
    });

    expect(animation.options).toMatchObject({ delay: 24, duration: 280, fill: "backwards" });
    expect(animation.keyframes).toHaveLength(4);
  });

  it("converts a viewport rect into screen coordinates", () => {
    expect(
      realtimeVoiceHandoffOriginFromRect(
        { left: 10, top: 20, width: 112, height: 80 },
        { screenX: 200, screenY: 100 },
      ),
    ).toEqual({ centerX: 266, centerY: 160, width: 112, height: 80 });
  });

  it("converts zoomed CSS geometry into screen DIP coordinates", () => {
    expect(
      realtimeVoiceHandoffOriginFromRect(
        { left: 10, top: 20, width: 112, height: 80 },
        { screenX: 200, screenY: 100 },
        1.25,
      ),
    ).toEqual({ centerX: 282.5, centerY: 175, width: 140, height: 100 });
  });
});
