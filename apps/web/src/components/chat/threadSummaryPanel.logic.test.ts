// FILE: threadSummaryPanel.logic.test.ts
// Purpose: Locks the current Codex thread-summary responsive state machine.
// Layer: Pure presentation-state tests

import { describe, expect, it } from "vitest";

import {
  THREAD_SUMMARY_MAX_SUBAGENT_PREVIEW,
  THREAD_SUMMARY_OVERLAY_RADIUS_PX,
  THREAD_SUMMARY_POPOVER_OFFSET_PX,
  THREAD_SUMMARY_SECTION_DEFAULT_OPEN,
  THREAD_SUMMARY_SHIFT_PX,
  THREAD_SUMMARY_TOOLTIP_DELAY_MS,
  reduceThreadSummaryPanelState,
  resolveThreadSummaryContentShift,
  resolveThreadSummaryMainContentTargetWidth,
  resolveThreadSummaryPanelDisplayMode,
  resolveThreadSummaryPanelPresentation,
  type ThreadSummaryPanelState,
} from "./threadSummaryPanel.logic";

const state = (overrides: Partial<ThreadSummaryPanelState> = {}): ThreadSummaryPanelState => ({
  displayMode: "overlay",
  isPinned: false,
  isPopoverOpen: false,
  ...overrides,
});

describe("thread summary responsive layout", () => {
  it("locks the measured Codex panel geometry and motion contract", () => {
    expect(THREAD_SUMMARY_OVERLAY_RADIUS_PX).toBe(20);
    expect(THREAD_SUMMARY_POPOVER_OFFSET_PX).toBe(8);
    expect(THREAD_SUMMARY_TOOLTIP_DELAY_MS).toBe(250);
    expect(THREAD_SUMMARY_MAX_SUBAGENT_PREVIEW).toBe(4);
    expect(THREAD_SUMMARY_SECTION_DEFAULT_OPEN).toBe(true);
  });

  it("matches Codex's overlay, shift, and gutter breakpoints", () => {
    expect(resolveThreadSummaryPanelDisplayMode(1095)).toBe("overlay");
    expect(resolveThreadSummaryPanelDisplayMode(1096)).toBe("shift");
    expect(resolveThreadSummaryPanelDisplayMode(1535)).toBe("shift");
    expect(resolveThreadSummaryPanelDisplayMode(1536)).toBe("gutter");
  });

  it("uses the right-dock target width instead of intermediate animated DOM widths", () => {
    expect(
      resolveThreadSummaryMainContentTargetWidth({
        currentContentWidth: 1400,
        shellRowWidth: 1600,
        rightDockOpen: true,
        rightDockFullWidth: false,
        rightDockTargetWidth: 600,
      }),
    ).toBe(1000);
    expect(
      resolveThreadSummaryMainContentTargetWidth({
        currentContentWidth: 1000,
        shellRowWidth: 1600,
        rightDockOpen: false,
        rightDockFullWidth: false,
        rightDockTargetWidth: 600,
      }),
    ).toBe(1600);
    expect(
      resolveThreadSummaryMainContentTargetWidth({
        currentContentWidth: 1000,
        shellRowWidth: 1600,
        rightDockOpen: true,
        rightDockFullWidth: true,
        rightDockTargetWidth: 600,
      }),
    ).toBe(0);
  });

  it("falls back to the current content width when route target geometry is unavailable", () => {
    expect(
      resolveThreadSummaryMainContentTargetWidth({
        currentContentWidth: 1096,
        shellRowWidth: null,
        rightDockOpen: true,
        rightDockFullWidth: false,
        rightDockTargetWidth: null,
      }),
    ).toBe(1096);
  });

  it("shifts the transcript by half the panel plus gap only in pinned shift mode", () => {
    expect(resolveThreadSummaryContentShift(state({ displayMode: "shift", isPinned: true }))).toBe(
      THREAD_SUMMARY_SHIFT_PX,
    );
    expect(resolveThreadSummaryContentShift(state({ displayMode: "gutter", isPinned: true }))).toBe(
      0,
    );
    expect(resolveThreadSummaryContentShift(state({ displayMode: "shift", isPinned: false }))).toBe(
      0,
    );
  });
});

describe("thread summary toggle semantics", () => {
  it("toggles a popover in overlay mode without changing the pinned preference", () => {
    const next = reduceThreadSummaryPanelState(state(), { type: "toggle" });
    expect(next).toEqual(state({ isPopoverOpen: true }));
    expect(reduceThreadSummaryPanelState(next, { type: "toggle" })).toEqual(state());
  });

  it("toggles pinned inline visibility in shift and gutter modes", () => {
    const shift = state({ displayMode: "shift" });
    expect(reduceThreadSummaryPanelState(shift, { type: "toggle" })).toEqual({
      ...shift,
      isPinned: true,
    });

    const gutter = state({ displayMode: "gutter", isPinned: true });
    expect(reduceThreadSummaryPanelState(gutter, { type: "toggle" })).toEqual({
      ...gutter,
      isPinned: false,
    });
  });

  it("closes the popover when the layout leaves overlay mode", () => {
    expect(
      reduceThreadSummaryPanelState(state({ isPopoverOpen: true }), {
        type: "set-display-mode",
        displayMode: "shift",
      }),
    ).toEqual(state({ displayMode: "shift" }));
  });

  it("exposes mutually exclusive popover and inline presentation", () => {
    expect(resolveThreadSummaryPanelPresentation(state({ isPopoverOpen: true }))).toEqual({
      visible: true,
      presentation: "popover",
    });
    expect(
      resolveThreadSummaryPanelPresentation(state({ displayMode: "gutter", isPinned: true })),
    ).toEqual({ visible: true, presentation: "inline" });
    expect(resolveThreadSummaryPanelPresentation(state({ displayMode: "gutter" }))).toEqual({
      visible: false,
      presentation: "inline",
    });
  });
});
