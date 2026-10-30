import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  symlink,
  rm,
  writeFile,
  realpath,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildMossManagedHomeOwnershipMarker,
  readManagedCodexHomeAuthority,
} from "./account/mossManagedHomeAuthority.ts";
import {
  resolveActiveCodexHomeWritePath,
  resolveCodexHomeOverlayWritePath,
} from "./codexHomePaths.ts";
import { syncMossManagedPluginConfig } from "./account/mossManagedPluginConfig.ts";
import { CodexAppServerManager } from "./codexAppServerManager.ts";
import {
  buildCodexProcessEnv,
  prepareCodexAuthTracking,
  prepareCodexHomeOverlayFromPreparedContinuationSource,
  readCodexAuthFingerprintAsync,
  readCodexPreparedAuthTrackingFingerprint,
  readCodexSharedContinuationGeneration,
} from "./codexProcessEnv.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(useShortPath = false, canonicalSettings = false) {
  // The dedicated 8.3 regression needs an actual short-name-enabled volume.
  // Keep all other fixtures on the ordinary isolated test scratch volume.
  const parent =
    useShortPath && process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Temp")
      : os.tmpdir();
  const originalStateDir = await mkdtemp(path.join(parent, "moss-canonical-win-"));
  roots.push(originalStateDir);
  if (/["%!&|<>]/.test(originalStateDir)) throw new Error("Unsafe test directory spelling");
  const shortPathResult = useShortPath
    ? spawnSync(
        process.env.ComSpec ?? "cmd.exe",
        ["/d", "/s", "/c", `for %I in ("${originalStateDir}") do @echo %~sI`],
        { encoding: "utf8", windowsVerbatimArguments: true },
      )
    : undefined;
  if (shortPathResult && (shortPathResult.error || shortPathResult.status !== 0)) {
    throw new Error("Windows could not resolve the real test directory short name");
  }
  const stateDir = shortPathResult ? shortPathResult.stdout.trim() : originalStateDir;
  if (useShortPath && stateDir.toLowerCase() === originalStateDir.toLowerCase()) {
    throw new Error("This regression requires a real Windows 8.3 directory alias");
  }
  const homePath = path.join(stateDir, "moss-codex-home");
  const nonce = "359a3e2c-e085-4f1b-a0a9-262a5552b512";
  await mkdir(homePath);
  await writeFile(
    path.join(homePath, ".moss-managed-home"),
    buildMossManagedHomeOwnershipMarker(nonce),
  );
  await writeFile(path.join(homePath, "config.toml"), 'cli_auth_credentials_store = "file"\n');
  const settingsHome = canonicalSettings ? await realpath(homePath) : homePath;
  const settings: ServerSettings = {
    ...DEFAULT_SERVER_SETTINGS,
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      codex: {
        ...DEFAULT_SERVER_SETTINGS.providers.codex,
        accounts: [{ id: "moss", label: "Moss", homePath: settingsHome, shadowHomePath: "" }],
      },
    },
    providerInstances: {
      codex_moss: {
        driver: "codex",
        enabled: true,
        config: {
          managed: true,
          accountId: "moss",
          homePath: settingsHome,
          homeOwnershipNonce: nonce,
        },
      },
    },
  };
  const input = {
    accountId: "moss",
    homePath: settingsHome,
    platform: "win32" as const,
    env: { MOSS_HOME: path.join(stateDir, "runtime"), CODEX_HOME: path.join(stateDir, "ambient") },
  };
  const managedHomeAuthority = await readManagedCodexHomeAuthority({
    stateDir,
    readSettings: async () => settings,
    readSettingsSync: () => settings,
    input,
    platform: "win32",
  });
  if (!managedHomeAuthority) throw new Error("Expected server-issued authority");
  return {
    stateDir,
    homePath,
    input,
    authorized: { ...input, managedHomeAuthority },
    legacy: resolveCodexHomeOverlayWritePath(input),
    issue: (env: NodeJS.ProcessEnv = input.env) =>
      readManagedCodexHomeAuthority({
        stateDir,
        readSettings: async () => settings,
        readSettingsSync: () => settings,
        input: { ...input, env },
        platform: "win32",
      }),
  };
}

describe("canonical Windows managed Codex runtime", () => {
  it.runIf(process.platform === "win32")(
    "uses a real 8.3 source spelling through legacy migration and auth revalidation",
    async () => {
      const f = await fixture(true);
      expect(await realpath(f.homePath)).not.toBe(f.homePath);
      await mkdir(path.join(f.legacy, "plugins"), { recursive: true });
      await writeFile(path.join(f.legacy, "plugins", "kept.json"), "legacy");
      const env = await buildCodexProcessEnv(f.authorized);
      expect(await realpath(env.CODEX_HOME!)).toBe(await realpath(f.homePath));
      expect(await readFile(path.join(f.homePath, "plugins", "kept.json"), "utf8")).toBe("legacy");
      const tracking = prepareCodexAuthTracking(f.authorized);
      expect(readCodexPreparedAuthTrackingFingerprint(tracking)).toBeTruthy();
      await expect(readCodexAuthFingerprintAsync(f.authorized)).resolves.toBeTruthy();
      await buildCodexProcessEnv(f.authorized);
    },
  );

  it.runIf(process.platform === "win32")(
    "rechecks mixed short and canonical reservation paths without synchronous filesystem reads",
    async () => {
      const f = await fixture(true, true);
      expect(f.input.homePath).not.toBe(f.homePath);
      const tracking = prepareCodexAuthTracking(f.authorized);
      expect(readCodexPreparedAuthTrackingFingerprint(tracking)).toBeTruthy();
      vi.spyOn(fs.realpathSync, "native").mockImplementation(() => {
        throw new Error("blocking realpathSync.native");
      });
      for (const method of [
        "realpathSync",
        "lstatSync",
        "statSync",
        "openSync",
        "readFileSync",
        "fstatSync",
        "readSync",
        "closeSync",
      ] as const) {
        vi.spyOn(fs, method).mockImplementation(() => {
          throw new Error(`blocking ${method}`);
        });
      }
      const reissued = await f.issue();
      expect(reissued?.homePath).toBe(f.input.homePath);
      await reissued!.assertCurrent();
      await expect(readCodexAuthFingerprintAsync(f.authorized)).resolves.toBeTruthy();
    },
  );

  it.runIf(process.platform === "win32")(
    "rejects ambient managed-home aliases regardless of short name or environment key casing",
    async () => {
      const f = await fixture(true, true);
      for (const alias of [f.homePath, f.input.homePath]) {
        await expect(
          f.issue({ CODEX_HOME: f.input.env.CODEX_HOME, codex_home: alias }),
        ).rejects.toThrow("ambient CODEX_HOME");
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "does not treat a junction to the authorized source as an 8.3 spelling",
    async () => {
      const f = await fixture();
      const alias = path.join(f.stateDir, "redirected-home");
      await symlink(f.homePath, alias, "junction");
      expect(await realpath(alias)).toBe(await realpath(f.homePath));
      await expect(buildCodexProcessEnv({ ...f.authorized, homePath: alias })).rejects.toThrow();
      expect(await readdir(f.homePath)).toEqual([".moss-managed-home", "config.toml"]);
    },
  );

  it.runIf(process.platform === "win32")(
    "rejects an ancestor junction even when the source directory has the authorized inode",
    async () => {
      const f = await fixture();
      const aliasParent = path.join(f.stateDir, "redirected-parent");
      await symlink(f.stateDir, aliasParent, "junction");
      const alias = path.join(aliasParent, "moss-codex-home");
      expect(await realpath(alias)).toBe(await realpath(f.homePath));
      await expect(buildCodexProcessEnv({ ...f.authorized, homePath: alias })).rejects.toThrow(
        "server-issued authority",
      );
      expect(await readdir(f.homePath)).toEqual([".moss-managed-home", "config.toml"]);
    },
  );

  it("requires server authority even when the account and marker look managed", async () => {
    const f = await fixture();
    expect(resolveActiveCodexHomeWritePath(f.input)).toBe(f.homePath);
    await expect(buildCodexProcessEnv(f.input)).rejects.toThrow("server-verified");
    await expect(
      buildCodexProcessEnv({
        ...f.input,
        managedHomeAuthority: {
          homePath: f.homePath,
          ownershipMarker: "fake",
          assertCurrent: async () => undefined,
        },
      }),
    ).rejects.toThrow("not issued");
    expect(await readdir(f.homePath)).toEqual([".moss-managed-home", "config.toml"]);
  });

  it.runIf(process.platform === "win32")(
    "rejects manager discovery without server authority before creating native state",
    async () => {
      const f = await fixture();
      const manager = new CodexAppServerManager(undefined, { managedCodexHomePath: f.homePath });
      await expect(
        manager.listPlugins({
          codexOptions: { homePath: f.homePath, accountId: "moss", environment: f.input.env },
        }),
      ).rejects.toThrow("server reservation authority");
      expect(await readdir(f.homePath)).toEqual([".moss-managed-home", "config.toml"]);
      await manager.stopAll();
    },
  );

  it("uses one real home through append, native atomic index replacement, and restart", async () => {
    const f = await fixture();
    const env = await buildCodexProcessEnv({
      ...f.authorized,
      overlayEntryLinker: {
        symlink: async () => {
          throw new Error("No symlinks are permitted in this regression");
        },
        copyFile: async () => {
          throw new Error("No copies are permitted in this regression");
        },
      },
    });
    expect(env.CODEX_HOME).toBe(f.homePath);
    expect(env.CODEX_SQLITE_HOME).toBe(f.homePath);
    const generation = readCodexSharedContinuationGeneration(f.authorized);
    expect(generation).toMatch(/^[a-f0-9-]{36}$/);
    for (const name of ["history.jsonl", "session_index.jsonl", "sessions", "archived_sessions"]) {
      expect((await lstat(path.join(f.homePath, name))).isSymbolicLink()).toBe(false);
    }
    await appendFile(path.join(env.CODEX_HOME!, "history.jsonl"), '{"text":"kept"}\n');
    await writeFile(path.join(env.CODEX_HOME!, "session_index.jsonl.tmp"), '{"id":"remaining"}\n');
    await rename(
      path.join(env.CODEX_HOME!, "session_index.jsonl.tmp"),
      path.join(env.CODEX_HOME!, "session_index.jsonl"),
    );
    const restarted = await buildCodexProcessEnv(f.authorized);
    expect(restarted.CODEX_HOME).toBe(env.CODEX_HOME);
    expect(await readFile(path.join(f.homePath, "history.jsonl"), "utf8")).toContain("kept");
    expect(
      await readFile(path.join(restarted.CODEX_HOME!, "session_index.jsonl"), "utf8"),
    ).toContain("remaining");
    expect(readCodexSharedContinuationGeneration(f.authorized)).toBe(generation);
    await expect(lstat(f.legacy)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not recreate damaged prepared continuation state on explicit resume", async () => {
    const f = await fixture();
    await buildCodexProcessEnv(f.authorized);
    const generation = readCodexSharedContinuationGeneration(f.authorized)!;
    await rm(path.join(f.homePath, "session_index.jsonl"));
    await expect(
      prepareCodexHomeOverlayFromPreparedContinuationSource({
        ...f.authorized,
        expectedSharedContinuationGeneration: generation,
      }),
    ).rejects.toThrow();
    await expect(lstat(path.join(f.homePath, "session_index.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rechecks ownership on prepared synchronous and asynchronous auth reads", async () => {
    const f = await fixture();
    await buildCodexProcessEnv(f.authorized);
    const tracking = prepareCodexAuthTracking(f.authorized);
    await writeFile(path.join(f.homePath, ".moss-managed-home"), "moss-managed-codex-home-v1\n");
    expect(() => readCodexPreparedAuthTrackingFingerprint(tracking)).toThrow("ownership");
    await expect(readCodexAuthFingerprintAsync(f.authorized)).rejects.toThrow("ownership");
    await expect(buildCodexProcessEnv(f.authorized)).rejects.toThrow("ownership");
  });

  it("moves an unshared old plugin store and preferences without overwriting source data", async () => {
    const f = await fixture();
    await mkdir(path.join(f.legacy, "plugins"), { recursive: true });
    await writeFile(path.join(f.legacy, "plugins", "native-choice.json"), "retained");
    await writeFile(
      path.join(f.legacy, "config.toml"),
      '[plugins."sample@local"]\nenabled = false\n',
    );
    await buildCodexProcessEnv(f.authorized);
    expect(await readFile(path.join(f.homePath, "plugins", "native-choice.json"), "utf8")).toBe(
      "retained",
    );
    expect(await readFile(path.join(f.homePath, "config.toml"), "utf8")).toContain(
      "enabled = false",
    );
    await expect(lstat(path.join(f.legacy, "plugins"))).rejects.toMatchObject({ code: "ENOENT" });
    // Native toggles in the new home survive the still-preserved old config.
    await writeFile(
      path.join(f.homePath, "config.toml"),
      '[plugins."sample@local"]\nenabled = true\n',
    );
    await buildCodexProcessEnv(f.authorized);
    expect(await readFile(path.join(f.homePath, "config.toml"), "utf8")).toContain(
      "enabled = true",
    );
    await writeFile(
      path.join(f.legacy, "config.toml"),
      '[plugins."different@local"]\nenabled = true\n',
    );
    await expect(buildCodexProcessEnv(f.authorized)).rejects.toThrow("changed after migration");
  });

  it("accepts an empty old store while retaining populated canonical defaults", async () => {
    const f = await fixture();
    await mkdir(path.join(f.legacy, "plugins"), { recursive: true });
    await mkdir(path.join(f.homePath, "plugins"));
    await writeFile(path.join(f.homePath, "plugins", "default.json"), "default");
    await buildCodexProcessEnv(f.authorized);
    expect(await readFile(path.join(f.homePath, "plugins", "default.json"), "utf8")).toBe(
      "default",
    );
    expect(await readdir(path.join(f.legacy, "plugins"))).toEqual([]);
  });

  it("does not overwrite a native preference changed after the migration snapshot", async () => {
    const f = await fixture();
    await mkdir(f.legacy, { recursive: true });
    await writeFile(path.join(f.legacy, "config.toml"), '[plugins."old@local"]\nenabled = false\n');
    const freshChoice = '[plugins."new@local"]\nenabled = true\n';
    await writeFile(path.join(f.homePath, "config.toml"), freshChoice);
    await expect(
      syncMossManagedPluginConfig({
        managedHomePath: f.homePath,
        runtimeHomePath: f.legacy,
        expectedSourcePluginConfig: "",
        assertCurrent: f.authorized.managedHomeAuthority.assertCurrent,
      }),
    ).rejects.toThrow("choices changed");
    expect(await readFile(path.join(f.homePath, "config.toml"), "utf8")).toBe(freshChoice);
  });

  it("refuses conflicting legacy plugin settings before touching either config", async () => {
    const f = await fixture();
    await mkdir(f.legacy, { recursive: true });
    const current = '[plugins."sample@local"]\nenabled = true\n';
    const previous = '[plugins."sample@local"]\nenabled = false\n';
    await writeFile(path.join(f.homePath, "config.toml"), current);
    await writeFile(path.join(f.legacy, "config.toml"), previous);
    await expect(buildCodexProcessEnv(f.authorized)).rejects.toThrow("settings conflict");
    expect(await readFile(path.join(f.homePath, "config.toml"), "utf8")).toBe(current);
    expect(await readFile(path.join(f.legacy, "config.toml"), "utf8")).toBe(previous);
  });

  it("does not migrate plugin data through a redirected legacy home", async () => {
    const f = await fixture();
    const foreign = path.join(f.stateDir, "foreign-home");
    await mkdir(path.join(foreign, "plugins"), { recursive: true });
    await writeFile(path.join(foreign, "plugins", "keep.json"), "foreign");
    await mkdir(path.dirname(f.legacy), { recursive: true });
    await symlink(foreign, f.legacy, process.platform === "win32" ? "junction" : "dir");
    await expect(buildCodexProcessEnv(f.authorized)).rejects.toThrow("real directory");
    expect(await readFile(path.join(foreign, "plugins", "keep.json"), "utf8")).toBe("foreign");
    await expect(lstat(path.join(f.homePath, "plugins"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses private legacy history rather than discarding or copying it", async () => {
    const f = await fixture();
    await mkdir(f.legacy, { recursive: true });
    await writeFile(path.join(f.legacy, "history.jsonl"), "legacy private history\n");
    await expect(buildCodexProcessEnv(f.authorized)).rejects.toThrow("reconciliation is required");
    expect(await readFile(path.join(f.legacy, "history.jsonl"), "utf8")).toBe(
      "legacy private history\n",
    );
    await expect(lstat(path.join(f.homePath, "history.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
