import { MOSS_DARK_THEME_COLORS } from "@synara/shared/themePalettes";
import { describe, expect, it } from "vitest";

import { DEFAULT_THEME_STATE, resolveThemePack } from "../theme/theme.logic";
import { mossHtmlRenderTheme } from "./useHtmlRenderTheme";

describe("mossHtmlRenderTheme", () => {
  it("hands a page the active Moss accent and surface instead of the stock palette", () => {
    const state = { ...DEFAULT_THEME_STATE, mode: "dark" as const };
    const theme = mossHtmlRenderTheme(state, "dark");
    const pack = resolveThemePack(state, "dark");

    expect(theme.appearance).toBe("dark");
    expect(theme.variables["--accent"]).toBe(pack.theme.accent);
    expect(theme.variables["--accent"]).not.toBe(MOSS_DARK_THEME_COLORS.accent);
    expect(theme.variables["--background"]).not.toBe(MOSS_DARK_THEME_COLORS.canvas);
    expect(theme.variables["--font-sans"]?.length).toBeGreaterThan(0);
    expect(theme.variables["--chart-1"]).toBe(pack.theme.accent);
  });

  it("hands pages plain sRGB colors that chart libraries can parse", () => {
    // T3 converts its OKLCH palette to hex for the same reason (pingdotgg/t3code#16325).
    for (const mode of ["light", "dark"] as const) {
      const { variables } = mossHtmlRenderTheme({ ...DEFAULT_THEME_STATE, mode }, mode);
      for (const [name, value] of Object.entries(variables)) {
        if (name.startsWith("--font-") || name === "--radius") continue;
        expect(value, name).toMatch(/^(?:#[0-9a-f]{3,8}|rgba?\([^()]*\))$/i);
      }
    }
  });
});
