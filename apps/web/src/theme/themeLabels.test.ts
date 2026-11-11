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
    expect(codeThemeLabel("dracula", "zh-CN")).toBe("樱夜");
    expect(codeThemeLabel("dracula")).toBe("Dracula");
    expect(codeThemeLabel("unknown-theme", "zh-CN")).toBe("unknown-theme");
  });

  it("gives every theme its own Chinese name, so the zh list never mixes in English", () => {
    const zhLabels = CODE_THEME_OPTIONS.map((option) => codeThemeLabel(option.id, "zh-CN"));
    for (const [index, label] of zhLabels.entries()) {
      // Moss is the product's own name and stays as written.
      if (CODE_THEME_OPTIONS[index]?.id === "moss") continue;
      expect(label).toMatch(/^\p{Script=Han}+$/u);
    }
    expect(new Set(zhLabels).size).toBe(zhLabels.length);
  });
});
