// FILE: rightDockMotion.logic.test.ts
// Purpose: Locks the official Codex regular right-panel motion contract.
// Layer: Pure presentation-state tests

import { describe, expect, it } from "vitest";

import {
  RIGHT_DOCK_CHROME_MOTION_CLASS,
  RIGHT_DOCK_FULL_WIDTH_CONTROL_TOOLTIP_DELAY_MS,
  RIGHT_DOCK_MOTION,
  resolveRightDockChromeMotionClass,
} from "./rightDockMotion.logic";

describe("Codex right dock motion contract", () => {
  it("uses the measured full-width replacement-control tooltip delay", () => {
    expect(RIGHT_DOCK_FULL_WIDTH_CONTROL_TOOLTIP_DELAY_MS).toBe(250);
  });

  it("uses the measured 500ms spring with a restrained 0.1 bounce", () => {
    expect(RIGHT_DOCK_MOTION).toEqual({
      type: "spring",
      durationMs: 500,
      bounce: 0.1,
    });
  });

  it("animates width and opacity without inheriting the 300ms left-sidebar timing", () => {
    expect(RIGHT_DOCK_CHROME_MOTION_CLASS).toContain("transition-[left,right,width,opacity]");
    expect(RIGHT_DOCK_CHROME_MOTION_CLASS).toContain("duration-500");
    expect(RIGHT_DOCK_CHROME_MOTION_CLASS).toContain("ease-[cubic-bezier(0.34,1.1,0.64,1)]");
    expect(RIGHT_DOCK_CHROME_MOTION_CLASS).toContain(
      "group-data-[collapsible=offcanvas]:opacity-0",
    );
    expect(RIGHT_DOCK_CHROME_MOTION_CLASS).toContain("motion-reduce:transition-none");
    expect(RIGHT_DOCK_CHROME_MOTION_CLASS).not.toContain("duration-300");
  });

  it("suppresses remount motion without mutating the regular contract", () => {
    expect(resolveRightDockChromeMotionClass({ suppressMotion: false })).toBe(
      RIGHT_DOCK_CHROME_MOTION_CLASS,
    );
    expect(resolveRightDockChromeMotionClass({ suppressMotion: true })).toBe(
      "transition-none! duration-0!",
    );
  });
});
