import { describe, expect, it } from "vitest";
import {
  DEFAULT_THEME_SKIN,
  PATTERNS,
  nextThemeSkinPattern,
  normalizeThemeSkin,
  themeSkinPatternLayerOpacity,
  themeSkinToAppSurfaceCssVariables,
} from "./themeSkin.logic";

describe("normalizeThemeSkin", () => {
  it("uses the selectable white preset as the unstored editor default", () => {
    expect(normalizeThemeSkin(null)).toEqual(DEFAULT_THEME_SKIN);
    expect(DEFAULT_THEME_SKIN).toMatchObject({
      pattern: "none",
      patternOpacity: 100,
      saturation: 100,
    });
  });

  it("fills partial snapshots from the same default", () => {
    expect(normalizeThemeSkin({ pattern: "stripe" })).toMatchObject({
      pattern: "stripe",
      patternOpacity: 100,
      saturation: 100,
    });
  });
});

describe("theme skin texture projection", () => {
  it("maps the texture slider directly to layer opacity", () => {
    expect(themeSkinPatternLayerOpacity("none", 100)).toBe(0);
    expect(themeSkinPatternLayerOpacity("stripe", 0)).toBe(0);
    expect(themeSkinPatternLayerOpacity("stripe", 33)).toBe(0.33);
    expect(themeSkinPatternLayerOpacity("stripe", 100)).toBe(1);
  });

  it("cycles through the reference texture order and wraps", () => {
    for (let index = 0; index < PATTERNS.length; index += 1) {
      expect(nextThemeSkinPattern(PATTERNS[index] ?? "none")).toBe(
        PATTERNS[(index + 1) % PATTERNS.length],
      );
    }
  });
});

describe("theme skin sidebar projection", () => {
  it("uses the heavy swatch and the reference opacity curve in light mode", () => {
    const skin = normalizeThemeSkin({
      c: 0.075,
      h: 15.66,
      l: 0.88,
      opacity: 0,
    });

    expect(themeSkinToAppSurfaceCssVariables(skin, "light")).toEqual({
      "--moss-theme-skin-sidebar-surface": "oklch(88.00% 0.075 15.66 / 0.5)",
    });

    expect(themeSkinToAppSurfaceCssVariables({ ...skin, opacity: 100 }, "light")).toEqual({
      "--moss-theme-skin-sidebar-surface": "oklch(88.00% 0.075 15.66 / 0.96)",
    });
  });
});
