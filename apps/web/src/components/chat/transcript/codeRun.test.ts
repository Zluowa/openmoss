import { describe, expect, it } from "vitest";

import { isRunnableShellFence, prepareShellCommand } from "./codeRun";

describe("isRunnableShellFence", () => {
  it("runs shell fences only", () => {
    expect(isRunnableShellFence("bash")).toBe(true);
    expect(isRunnableShellFence("PowerShell")).toBe(true);
    expect(isRunnableShellFence("ts")).toBe(false);
    expect(isRunnableShellFence("text")).toBe(false);
  });
});

describe("prepareShellCommand", () => {
  it("drops prompt marks, comments and blank lines", () => {
    expect(
      prepareShellCommand("# install\n$ bun install\n\n$ bun run test\r\nPS C:\\repo> git status"),
    ).toBe("bun install\nbun run test\ngit status");
  });
});
