// FILE: claudeRuntimeSelection.test.ts
// Purpose: Pins one actual Claude program across local and Moss account configurations.
// Layer: Provider runtime tests

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetLocalAgentPathLookupCache } from "@moss/shared/localAgentExecutable";

import { resolveClaudeCodeRuntime } from "./claudeEnvironment.ts";

describe("shared Claude program selection", () => {
  const directories: string[] = [];
  afterEach(() => {
    resetLocalAgentPathLookupCache();
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  it("resolves the same absolute user program before applying either account's environment", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "moss-claude-program-"));
    directories.push(directory);
    const executable = path.join(directory, process.platform === "win32" ? "claude.cmd" : "claude");
    writeFileSync(executable, "", { mode: 0o755 });
    const env = { PATH: directory, PATHEXT: ".EXE;.CMD", MOSS_BUNDLED_CLAUDE_PATH: "/app/claude" };
    for (const providerInstanceId of ["claudeAgent", "claude_work", "claude_moss"]) {
      expect(resolveClaudeCodeRuntime({ providerInstanceId, env })).toEqual({
        binaryPath: process.platform === "win32" ? path.join(directory, "claude.CMD") : executable,
        source: "path",
      });
    }
  });

  it("uses the same SDK fallback when neither account has an installed program", () => {
    for (const providerInstanceId of ["claudeAgent", "claude_moss"]) {
      expect(
        resolveClaudeCodeRuntime({
          providerInstanceId,
          env: { PATH: "" },
          sdkExecutablePath: "/app/sdk/claude",
        }),
      ).toEqual({ binaryPath: "/app/sdk/claude", source: "bundled" });
    }
  });
});
