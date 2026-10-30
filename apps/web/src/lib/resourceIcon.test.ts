import { describe, expect, it } from "vitest";

import {
  MCP_FALLBACK_ICON,
  normalizeIconKey,
  resolveResourceIcon,
  SKILL_FALLBACK_ICON,
} from "./resourceIcon";

describe("normalizeIconKey", () => {
  it("lowercases and hyphenates whitespace", () => {
    expect(normalizeIconKey("  My Cool Skill ")).toBe("my-cool-skill");
  });
});

describe("resolveResourceIcon", () => {
  it("uses the exact-name registry before keyword matching", () => {
    // gh-address-comments and github both resolve to the GitHub glyph, but the
    // exact-name entry must win regardless of keyword order.
    expect(resolveResourceIcon("gh-address-comments")).toBe(
      resolveResourceIcon("something-github"),
    );
  });

  it("matches Codex keyword precedence (codex/openai/linear/review/github/...)", () => {
    // Distinct keywords must yield distinct icons.
    const codex = resolveResourceIcon("codex-helper");
    const linear = resolveResourceIcon("linear-tickets");
    const review = resolveResourceIcon("code-review");
    const github = resolveResourceIcon("gh-sync");
    const chrome = resolveResourceIcon("browser-agent");
    const plan = resolveResourceIcon("plan-mode");
    expect(new Set([codex, linear, review, github, chrome, plan]).size).toBe(6);
  });

  it("reads the description for github/playwright/context7", () => {
    const byDesc = resolveResourceIcon("mystery", "uses GitHub under the hood");
    const byName = resolveResourceIcon("gh-thing");
    expect(byDesc).toBe(byName);
  });

  it("falls back to the provided default when nothing matches", () => {
    expect(resolveResourceIcon("totally-unmatched-name")).toBe(SKILL_FALLBACK_ICON);
    expect(resolveResourceIcon("totally-unmatched-name", null, MCP_FALLBACK_ICON)).toBe(
      MCP_FALLBACK_ICON,
    );
  });

  it("resolves figma to a brand glyph distinct from the default", () => {
    expect(resolveResourceIcon("figma-implement-design")).not.toBe(SKILL_FALLBACK_ICON);
    expect(resolveResourceIcon("figma-mcp")).not.toBe(SKILL_FALLBACK_ICON);
  });
});
