// FILE: initialProviderSettings.test.ts
// Purpose: Verifies first-run choices without touching user installations or credentials.
// Layer: Server provider tests
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { DEFAULT_SERVER_SETTINGS } from "@moss/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialProviderSettings } from "./initialProviderSettings.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("initialProviderSettings", () => {
  it("finds a launchable command on PATH and skips a file that cannot be launched", async () => {
    const dir = await FS.mkdtemp(Path.join(OS.tmpdir(), "moss-first-run-"));
    try {
      const windows = process.platform === "win32";
      // pi is launchable; opencode exists but is not (no launch extension / no execute bit).
      await FS.writeFile(Path.join(dir, windows ? "pi.cmd" : "pi"), "", { mode: 0o755 });
      await FS.writeFile(Path.join(dir, windows ? "opencode.txt" : "opencode"), "", {
        mode: 0o644,
      });
      vi.stubEnv("PATH", dir);
      if (windows) {
        vi.stubEnv("Path", dir);
        vi.stubEnv("PATHEXT", ".COM;.EXE;.BAT;.CMD");
      }
      const result = await initialProviderSettings(DEFAULT_SERVER_SETTINGS, "/isolated", {
        preparePath: async () => undefined,
      });
      expect(
        Object.entries(result.providers)
          .filter(([, value]) => value.enabled)
          .map(([key]) => key)
          .toSorted(),
      ).toEqual(["claudeAgent", "codex", "pi"]);
    } finally {
      await FS.rm(dir, { recursive: true, force: true });
    }
  });

  it("still opens with bundled agents when optional path discovery fails", async () => {
    const result = await initialProviderSettings(DEFAULT_SERVER_SETTINGS, "/isolated", {
      preparePath: async () => {
        throw new Error("Registry unavailable");
      },
      hasCommand: async () => false,
    });
    expect(
      Object.entries(result.providers)
        .filter(([, value]) => value.enabled)
        .map(([key]) => key)
        .toSorted(),
    ).toEqual(["claudeAgent", "codex"]);
  });
  it("selects Codex, Claude and actual local commands, including signed-out agents", async () => {
    const preparePath = vi.fn(async () => undefined);
    const hasCommand = vi.fn(async (command: string) => ["pi", "opencode"].includes(command));
    const result = await initialProviderSettings(DEFAULT_SERVER_SETTINGS, "/isolated", {
      preparePath,
      hasCommand,
    });
    expect(preparePath).toHaveBeenCalledOnce();
    expect(
      Object.entries(result.providers)
        .filter(([, value]) => value.enabled)
        .map(([key]) => key)
        .toSorted(),
    ).toEqual(["claudeAgent", "codex", "opencode", "pi"]);
    expect(result.providers.zcode.enabled).toBe(false);
    expect(result.providers.cursor.enabled).toBe(false);
    expect(DEFAULT_SERVER_SETTINGS.providers.opencode.enabled).toBe(true);
  });

  it("keeps every optional agent off on an empty computer", async () => {
    const result = await initialProviderSettings(DEFAULT_SERVER_SETTINGS, "/isolated", {
      preparePath: async () => undefined,
      hasCommand: async () => false,
    });
    expect(
      Object.entries(result.providers)
        .filter(([, value]) => value.enabled)
        .map(([key]) => key)
        .toSorted(),
    ).toEqual(["claudeAgent", "codex"]);
  });
});
