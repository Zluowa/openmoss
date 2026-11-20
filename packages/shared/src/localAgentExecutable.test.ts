import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  isCommandOnPath,
  resetLocalAgentPathLookupCache,
  resolveLocalAgentExecutable,
} from "./localAgentExecutable";

describe("resolveLocalAgentExecutable", () => {
  afterEach(() => resetLocalAgentPathLookupCache());

  it("runs a configured path first", () => {
    expect(
      resolveLocalAgentExecutable({
        command: "claude",
        configuredBinaryPath: " /opt/claude ",
        bundledBinaryPath: "/app/claude",
        isOnPath: () => true,
      }),
    ).toMatchObject({ binaryPath: "/opt/claude", source: "configured" });
  });

  it("prefers the person's own install, then the bundled copy", () => {
    const input = { command: "claude", bundledBinaryPath: "/app/claude" } as const;
    expect(resolveLocalAgentExecutable({ ...input, isOnPath: () => true })).toMatchObject({
      binaryPath: "claude",
      source: "path",
    });
    expect(resolveLocalAgentExecutable({ ...input, isOnPath: () => false })).toMatchObject({
      binaryPath: "/app/claude",
      source: "bundled",
    });
    expect(
      resolveLocalAgentExecutable({
        ...input,
        configuredBinaryPath: "claude",
        isOnPath: () => false,
      }),
    ).toMatchObject({ binaryPath: "/app/claude", source: "bundled" });
  });

  it("runs the copy an in-app update installed before the person's own and the bundled one", () => {
    const input = {
      command: "codex",
      bundledBinaryPath: "/app/codex",
      updatedBinaryPath: "/moss/agents/versions/codex/0.171.0-x/bin/codex",
      isOnPath: () => true,
    } as const;
    expect(resolveLocalAgentExecutable(input)).toMatchObject({
      binaryPath: "/moss/agents/versions/codex/0.171.0-x/bin/codex",
      source: "path",
    });
    // A program chosen in Settings, or the bundled one chosen explicitly, still wins.
    expect(
      resolveLocalAgentExecutable({ ...input, configuredBinaryPath: "/opt/codex" }),
    ).toMatchObject({ binaryPath: "/opt/codex", source: "configured" });
    expect(
      resolveLocalAgentExecutable({ ...input, configuredBinaryPath: "/app/codex" }),
    ).toMatchObject({ binaryPath: "/app/codex", source: "bundled" });
  });

  it("keeps a missing relative configured program bound to the server directory", () => {
    const configured = "./missing-runtime15-program/cli";
    expect(
      resolveLocalAgentExecutable({
        command: "codex",
        configuredBinaryPath: configured,
        env: { PATH: "" },
      }),
    ).toMatchObject({ binaryPath: path.resolve(configured), source: "configured" });
  });

  it("keeps the bare command when nothing is bundled, without a PATH walk", () => {
    expect(
      resolveLocalAgentExecutable({
        command: "claude",
        isOnPath: () => {
          throw new Error("must not look up PATH");
        },
      }),
    ).toMatchObject({ binaryPath: "claude", source: "path", bundledAvailable: false });
  });

  it("finds a command on PATH", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "moss-agent-path-"));
    try {
      const platform = process.platform;
      const name = platform === "win32" ? "fake-agent.cmd" : "fake-agent";
      writeFileSync(path.join(dir, name), "", { mode: 0o755 });
      const env = { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
      expect(isCommandOnPath("fake-agent", { env, platform })).toBe(true);
      expect(resolveLocalAgentExecutable({ command: "fake-agent", env, platform })).toMatchObject({
        binaryPath: path.join(dir, platform === "win32" ? "fake-agent.CMD" : name),
        source: "path",
      });
      expect(isCommandOnPath("missing-agent", { env, platform })).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
