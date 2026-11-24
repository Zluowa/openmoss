// FILE: terminalFontStacks.test.ts
// Purpose: Every fixed-width stack (terminal, code, a configured terminal face) reaches a
//          fixed-width face that ships with Windows, macOS and Linux before any Chinese or
//          proportional face (WALK-8 N8-1).
// Layer: Unit test

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveTerminalFontFamilyStack } from "~/appSettings";
import { FALLBACK_MONO_FONT_FAMILY } from "./terminalRuntimeAppearance";

/** Fixed-width faces a stock machine has: what xterm measures with when JetBrains Mono is missing. */
const SYSTEM_MONO = {
  windows: ["Cascadia Mono", "Consolas"],
  macos: ["SF Mono", "SFMono-Regular", "Menlo"],
  linux: ["DejaVu Sans Mono", "Liberation Mono"],
} as const;
const OPTIONAL_MONO = /^(?:JetBrains ?Mono|JetBrainsMono)/u;
const CHINESE_OR_PROPORTIONAL =
  /PingFang|YaHei|CJK|Noto Sans SC|Hiragino|Inter|system-ui|sans-serif/u;

function families(stack: string): string[] {
  return stack
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .split(",")
    .map((face) => face.trim().replace(/^["']|["']$/gu, ""))
    .filter((face) => face.length > 0 && !face.startsWith("var(") && face !== ")");
}

function cssStacks(name: string): string[] {
  const css = readFileSync(resolve(__dirname, "../../index.css"), "utf8");
  const stacks = [...css.matchAll(new RegExp(`${name}:([^;]+);`, "gu"))].map((match) =>
    match[1]!.replace(/var\(\s*--theme-font-code-family,/u, "").replace(/\)\s*$/u, ""),
  );
  expect(stacks.length).toBeGreaterThan(0);
  return stacks;
}

/** As a PC without JetBrains Mono sees the stack: the first face it has decides the cell width. */
function expectSystemMonoBeforeChinese(stack: string) {
  const faces = families(stack).filter((face) => !OPTIONAL_MONO.test(face));
  const firstChinese = faces.findIndex((face) => CHINESE_OR_PROPORTIONAL.test(face));
  expect(firstChinese).toBeGreaterThan(-1);
  for (const [platform, mono] of Object.entries(SYSTEM_MONO)) {
    const at = faces.findIndex((face) => (mono as readonly string[]).includes(face));
    expect(at, `${platform} has no fixed-width face before ${faces[firstChinese]}`).toBeGreaterThan(
      -1,
    );
    expect(
      at,
      `${platform}: ${faces[firstChinese]} comes before its fixed-width face`,
    ).toBeLessThan(firstChinese);
  }
  // The generic monospace stays last: Chrome maps it to a Song face (NSimSun) for Chinese.
  expect(faces.at(-1)).toBe("monospace");
}

describe("WALK-8 N8-1: the terminal on a PC without JetBrains Mono", () => {
  it("measures its cells with a fixed-width face, not Microsoft YaHei", () => {
    expectSystemMonoBeforeChinese(FALLBACK_MONO_FONT_FAMILY);
    for (const stack of cssStacks("--terminal-font-family")) expectSystemMonoBeforeChinese(stack);
  });

  it("keeps a configured face that is not installed on a fixed-width fallback", () => {
    expectSystemMonoBeforeChinese(resolveTerminalFontFamilyStack("Fira Code")!);
    expectSystemMonoBeforeChinese(resolveTerminalFontFamilyStack('"Fira Code", Menlo')!);
  });

  it("keeps code blocks and the diff view on the same order", () => {
    for (const stack of cssStacks("--font-mono-family")) expectSystemMonoBeforeChinese(stack);
  });
});
