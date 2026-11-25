import { splitPosixQuotedArgv } from "@moss/shared/shellCommandShape";
import { describe, expect, it } from "vitest";

import { codexCommandText } from "./codexCommandText.ts";

/** A line the way Codex joins argv (Rust shlex): a backslash forces "…" with `\` doubled. */
const b = "\\";
const doubled = (text: string) => text.replaceAll(b, b + b);

describe("codexCommandText", () => {
  it("writes each backslash of a Windows path once", () => {
    const path = ["C:", "Windows", "System32", "cmd.exe"].join(b);
    expect(codexCommandText(`"${doubled(path)}" /c dir`)).toBe(`"${path}" /c dir`);
  });

  it("keeps Codex's quotes, spacing and every escape that keeps an argument the same", () => {
    const cases = [
      // A UNC path: a backslash next to a backslash keeps its escape.
      `"${b}${b}${b}${b}server${b}${b}share" -Command 'x'`,
      // A backslash before the closing quote: written once it would escape the quote.
      `"C:${b}${b}" -x`,
      // Before an escaped quote, `$` or a backtick.
      `"Get-Content ${b}${b}${b}"a b${b}${b}${b}""`,
      `"a${b}${b}${b}$HOME"`,
      // Single quotes are literal already.
      `'C:${b}x' -Command 'Get-ChildItem   -Name'`,
    ];
    for (const line of cases) {
      const shown = codexCommandText(line);
      expect(splitPosixQuotedArgv(shown)).toEqual(splitPosixQuotedArgv(line));
    }
    expect(codexCommandText(cases[0]!)).toBe(cases[0]);
    expect(codexCommandText(cases[1]!)).toBe(cases[1]);
    expect(codexCommandText(cases[4]!)).toBe(cases[4]);
    // A UNC path with deeper segments also keeps all its escaped backslashes consistent.
    const uncWithFile = `"${b}${b}${b}${b}server${b}${b}share${b}${b}dir${b}${b}file.txt" -Command 'x'`;
    expect(codexCommandText(uncWithFile)).toBe(uncWithFile);
  });

  it("drops only lone escaped backslashes inside an argument with other escapes", () => {
    const line = `"Get-Content ${b}"C:${b}${b}a b${b}${b}x.txt${b}""`;
    const shown = codexCommandText(line);
    expect(shown).toBe(`"Get-Content ${b}"C:${b}a b${b}x.txt${b}""`);
    expect(splitPosixQuotedArgv(shown)).toEqual([`Get-Content "C:${b}a b${b}x.txt"`]);
  });

  it("returns a line that is not Codex's quoting exactly as it came", () => {
    for (const line of [`dir C:${b}Users`, `"unclosed ${b}${b}x`, "git status"]) {
      expect(codexCommandText(line)).toBe(line);
    }
  });
});
