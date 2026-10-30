import { describe, expect, it } from "vitest";

import {
  RIGHT_DOCK_DEFAULT_WIDTH,
  RIGHT_DOCK_MIN_WIDTH,
  RIGHT_DOCK_WIDTH_STORAGE_KEY,
  clampRightDockWidth,
  normalizeRightDockWidth,
  resolveAdaptiveRightDockDefaultWidth,
  resolvePersistedRightDockWidthRatio,
  resolveRightDockWidthBounds,
  resolveRightDockWidthFromRatio,
} from "./rightDockSizing.logic";

describe("Codex right dock sizing contract", () => {
  it("uses the official minimum, baseline, and v3 storage key", () => {
    expect(RIGHT_DOCK_MIN_WIDTH).toBe(320);
    expect(RIGHT_DOCK_DEFAULT_WIDTH).toBe(600);
    expect(RIGHT_DOCK_WIDTH_STORAGE_KEY).toBe("app-shell:right-panel-width:v3");
  });

  it("applies the Codex adaptive formula only to the 600px baseline", () => {
    expect(
      resolveAdaptiveRightDockDefaultWidth({
        defaultWidth: RIGHT_DOCK_DEFAULT_WIDTH,
        mainContentWidth: 2_000,
        shellHeight: 800,
      }),
    ).toBe(1_280);
    expect(
      resolveAdaptiveRightDockDefaultWidth({
        defaultWidth: RIGHT_DOCK_DEFAULT_WIDTH,
        mainContentWidth: 1_000,
        shellHeight: 800,
      }),
    ).toBe(640);
    expect(
      resolveAdaptiveRightDockDefaultWidth({
        defaultWidth: RIGHT_DOCK_DEFAULT_WIDTH,
        mainContentWidth: 600,
        shellHeight: 100,
      }),
    ).toBe(320);
    expect(
      resolveAdaptiveRightDockDefaultWidth({
        defaultWidth: 480,
        mainContentWidth: 2_000,
        shellHeight: 800,
      }),
    ).toBe(480);
  });

  it("keeps 352px of main content in regular mode and allows the shell in full mode", () => {
    expect(resolveRightDockWidthBounds(1_000, "regular")).toEqual({
      minimum: 320,
      maximum: 648,
    });
    expect(resolveRightDockWidthBounds(1_000, "full")).toEqual({
      minimum: 320,
      maximum: 1_000,
    });
    expect(resolveRightDockWidthBounds(500, "regular")).toEqual({
      minimum: 320,
      maximum: 320,
    });
  });

  it("clamps invalid and out-of-range widths to the available regular panel range", () => {
    expect(clampRightDockWidth(Number.NaN, 1_000, "regular")).toBe(600);
    expect(clampRightDockWidth(200, 1_000, "regular")).toBe(320);
    expect(clampRightDockWidth(800, 1_000, "regular")).toBe(648);
  });

  it("round-trips a panel width through the persisted normalized ratio", () => {
    const ratio = normalizeRightDockWidth(600, 1_600, "regular");
    expect(ratio).toBeCloseTo(280 / 928);
    expect(resolveRightDockWidthFromRatio(ratio, 1_600, "regular")).toBeCloseTo(600);
  });

  it("loads v3 ratios, migrates legacy pixel values, and falls back to adaptive sizing", () => {
    expect(
      resolvePersistedRightDockWidthRatio({
        storedValue: 0.25,
        defaultWidth: RIGHT_DOCK_DEFAULT_WIDTH,
        mainContentWidth: 1_600,
        shellHeight: 900,
        widthMode: "regular",
      }),
    ).toBe(0.25);

    expect(
      resolvePersistedRightDockWidthRatio({
        storedValue: 600,
        defaultWidth: RIGHT_DOCK_DEFAULT_WIDTH,
        mainContentWidth: 1_600,
        shellHeight: 900,
        widthMode: "regular",
      }),
    ).toBeCloseTo(280 / 928);

    const adaptiveWidth = resolveAdaptiveRightDockDefaultWidth({
      defaultWidth: RIGHT_DOCK_DEFAULT_WIDTH,
      mainContentWidth: 1_600,
      shellHeight: 900,
    });
    expect(
      resolvePersistedRightDockWidthRatio({
        storedValue: Number.NaN,
        defaultWidth: RIGHT_DOCK_DEFAULT_WIDTH,
        mainContentWidth: 1_600,
        shellHeight: 900,
        widthMode: "regular",
      }),
    ).toBeCloseTo(normalizeRightDockWidth(adaptiveWidth, 1_600, "regular"));
  });
});
