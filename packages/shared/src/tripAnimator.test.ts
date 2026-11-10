import { describe, expect, it } from "vitest";

import { injectHtmlRenderBootstrap } from "./htmlRender";
import { htmlUsesTripAnimator, TRIP_ANIMATOR_SOURCE } from "./tripAnimator";

describe("trip animator", () => {
  it("is plain script that parses outside any bundle", () => {
    expect(() => new Function(TRIP_ANIMATOR_SOURCE)).not.toThrow();
    expect(TRIP_ANIMATOR_SOURCE).toContain("window.createTripAnimator=createTripAnimator");
  });

  it("ships only with pages that call it", () => {
    const itinerary =
      "<!doctype html><html><head></head><body><script>window.createTripAnimator({stopCount:2,onFrame(){}})</script></body></html>";
    const chart = "<!doctype html><html><head></head><body><svg></svg></body></html>";
    expect(htmlUsesTripAnimator(itinerary)).toBe(true);
    expect(htmlUsesTripAnimator(chart)).toBe(false);
    expect(injectHtmlRenderBootstrap(itinerary)).toContain(TRIP_ANIMATOR_SOURCE);
    expect(injectHtmlRenderBootstrap(chart)).not.toContain(TRIP_ANIMATOR_SOURCE);
  });

  it("drops pins in order and finishes when reduced motion is set", () => {
    const listeners: Record<string, () => void> = {};
    const win = {
      matchMedia: () => ({ matches: true }),
      addEventListener: (name: string, listener: () => void) => (listeners[name] = listener),
      removeEventListener: () => undefined,
    };
    const doc = {
      hidden: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    new Function("window", "document", TRIP_ANIMATOR_SOURCE)(win, doc);
    const pins = [0, 1, 2].map(() => ({ textContent: "", style: { opacity: "", transform: "" } }));
    const frames: Array<{ progress: number; activeStop: number }> = [];
    const states: string[] = [];
    const controller = (
      win as unknown as {
        createTripAnimator: (options: unknown) => { play: () => void };
      }
    ).createTripAnimator({
      stopCount: 3,
      pinElements: pins,
      onFrame: (frame: { progress: number; activeStop: number }) => frames.push(frame),
      onState: (state: string) => states.push(state),
    });
    controller.play();
    expect(pins.map((pin) => pin.textContent)).toEqual(["1", "2", "3"]);
    expect(frames.at(-1)).toMatchObject({ progress: 1, activeStop: 2 });
    expect(pins.every((pin) => pin.style.opacity === "1")).toBe(true);
    expect(states).toEqual(["complete"]);
  });
});
