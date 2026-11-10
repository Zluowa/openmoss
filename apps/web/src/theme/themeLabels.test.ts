import { describe, expect, it } from "vitest";

import { CODE_THEME_OPTIONS, codeThemeLabel } from "./theme.logic";

const OTHER_BRANDS = /Codex|GitHub|Linear|Notion|Raycast|Vercel|VS Code|Sentry/;

describe("theme names", () => {
  it("never names a theme after another company's product", () => {
    for (const option of CODE_THEME_OPTIONS) {
      expect(option.label).not.toMatch(OTHER_BRANDS);
      expect(codeThemeLabel(option.id, "zh-CN")).not.toMatch(OTHER_BRANDS);
    }
  });

  it("keeps the stored ids, so saved themes still resolve", () => {
    const ids = CODE_THEME_OPTIONS.map((option) => option.id);
    for (const id of ["codex", "github", "linear", "notion", "raycast", "vercel", "vscode-plus"]) {
      expect(ids).toContain(id);
    }
  });

  it("shows look-based names in each language", () => {
    expect(codeThemeLabel("vercel")).toBe("Monochrome");
    expect(codeThemeLabel("vercel", "zh-CN")).toBe("黑白");
    expect(codeThemeLabel("codex", "zh-CN")).toBe("经典");
    expect(codeThemeLabel("dracula", "zh-CN")).toBe("Dracula");
    expect(codeThemeLabel("unknown-theme", "zh-CN")).toBe("unknown-theme");
  });
});
