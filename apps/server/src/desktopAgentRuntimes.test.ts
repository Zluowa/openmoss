import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyDesktopAgentRuntimesNotice,
  parseDesktopAgentRuntimesNotice,
} from "./desktopAgentRuntimes";

// A profile path with a space and non-ASCII characters, as real Windows user names have.
const absolute = path.join(os.tmpdir(), "张 三", "Moss", "runtimes");
const codex = path.join(absolute, "codex.exe");
const claude = path.join(absolute, "claude.exe");

describe("desktop agent runtimes notice", () => {
  it("accepts only codex and claude with an absolute path, once each", () => {
    expect(
      parseDesktopAgentRuntimesNotice({ ready: [{ name: "codex", executablePath: codex }] }),
    ).toEqual([{ name: "codex", executablePath: codex }]);
    for (const body of [
      null,
      {},
      { ready: [] },
      { ready: [{ name: "opencode", executablePath: codex }] },
      { ready: [{ name: "codex", executablePath: "codex.exe" }] },
      { ready: [{ name: "codex", executablePath: `${codex}\n` }] },
      {
        ready: [
          { name: "codex", executablePath: codex },
          { name: "codex", executablePath: codex },
        ],
      },
    ])
      expect(parseDesktopAgentRuntimesNotice(body), JSON.stringify(body)).toBeNull();
  });

  it("points the server at a ready runtime and keeps the other one pending", async () => {
    const env: NodeJS.ProcessEnv = {
      MOSS_AGENT_RUNTIMES_PENDING: "codex,claude",
      MOSS_BUNDLED_CODEX_ERROR: "stale",
    };
    const applied = await applyDesktopAgentRuntimesNotice({
      env,
      ready: [{ name: "codex", executablePath: codex }],
      isFile: async () => true,
    });
    expect(applied).toEqual(["codex"]);
    expect(env.MOSS_BUNDLED_CODEX_PATH).toBe(codex);
    expect(env.MOSS_BUNDLED_CODEX_ERROR).toBeUndefined();
    expect(env.MOSS_AGENT_RUNTIMES_PENDING).toBe("claude");

    await applyDesktopAgentRuntimesNotice({
      env,
      ready: [{ name: "claude", executablePath: claude }],
      isFile: async () => true,
    });
    expect(env.MOSS_BUNDLED_CLAUDE_PATH).toBe(claude);
    expect(env.MOSS_AGENT_RUNTIMES_PENDING).toBeUndefined();
  });

  it("changes nothing for a path that is not a file", async () => {
    const env: NodeJS.ProcessEnv = { MOSS_AGENT_RUNTIMES_PENDING: "codex" };
    const applied = await applyDesktopAgentRuntimesNotice({
      env,
      ready: [{ name: "codex", executablePath: codex }],
      isFile: async () => false,
    });
    expect(applied).toEqual([]);
    expect(env.MOSS_BUNDLED_CODEX_PATH).toBeUndefined();
    expect(env.MOSS_AGENT_RUNTIMES_PENDING).toBe("codex");
  });
});
