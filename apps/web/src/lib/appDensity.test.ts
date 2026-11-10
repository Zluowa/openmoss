import { describe, expect, it } from "vitest";

import { DEFAULT_UI_DENSITY, getDensityCssVariables, normalizeUiDensity } from "./appDensity";

describe("appDensity", () => {
  it("normalizes unknown values to the default density", () => {
    expect(normalizeUiDensity("spacious")).toBe("spacious");
    expect(normalizeUiDensity("invalid")).toBe(DEFAULT_UI_DENSITY);
    expect(normalizeUiDensity(undefined)).toBe(DEFAULT_UI_DENSITY);
  });

  it("derives scaled spacing variables from the active density", () => {
    const compact = getDensityCssVariables("compact");
    const comfortable = getDensityCssVariables("comfortable");

    expect(compact["--density-scale"]).toBe("0.85");
    expect(comfortable["--density-scale"]).toBe("1");
    expect(compact["--app-density-row-height"]).toBe("calc(1.7rem * var(--app-ui-scale, 1))");
    expect(comfortable["--app-density-row-height"]).toBe("calc(2rem * var(--app-ui-scale, 1))");
    expect(compact["--app-density-composer-editor-min-height"]).toBe(
      "calc(var(--min-height-composer, 2.75rem) * 0.85 * var(--app-ui-scale, 1))",
    );
    expect(comfortable["--app-density-composer-footer-padding-end"]).toBe(
      "calc(0.5rem * var(--app-ui-scale, 1))",
    );
  });
});
