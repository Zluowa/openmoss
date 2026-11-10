import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveCodexExecutable } from "@moss/shared/codexExecutable";
import {
  resetLocalAgentPathLookupCache,
  resolveLocalAgentExecutable,
} from "@moss/shared/localAgentExecutable";
import { spawnProcessSync } from "@moss/shared/processRuntime";
import { describe, expect, it, vi } from "vitest";

import * as DesktopInstalls from "./agentDesktopInstalls.ts";

import {
  agentCliInstallDirectories,
  appendAgentCliDirectoriesToPath,
  applyAgentCliPathFloor,
  ensureAgentCliPath,
  makeAgentCliPathMaintainer,
  parseNpmPrefixOutput,
  readNpmrcGlobalPrefix,
} from "./agentCliPathFloor.ts";

it.skipIf(process.platform !== "win32")(
  "discovers and runs existing Windows CLIs on first launch, then finds a new CLI without restarting",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "moss-first-cli-"));
    const profile = join(root, "profile");
    const npmBin = join(profile, "AppData", "Roaming", "npm");
    const originalEnv = { ...process.env };
    const desktopScan = vi
      .spyOn(DesktopInstalls, "refreshAgentDesktopInstalls")
      .mockResolvedValue([]);
    try {
      // Every filesystem lookup and executable belongs to this synthetic profile.
      for (const name of Object.keys(process.env)) {
        if (
          /^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PNPM_HOME|BUN_INSTALL|VOLTA_HOME|SCOOP|NVM_SYMLINK|NPM_CONFIG_.*)$/i.test(
            name,
          )
        )
          delete process.env[name];
      }
      Object.assign(process.env, {
        HOME: profile,
        USERPROFILE: profile,
        APPDATA: join(profile, "AppData", "Roaming"),
        LOCALAPPDATA: join(profile, "AppData", "Local"),
        PATH: join(process.env.SystemRoot ?? "C:\\Windows", "System32"),
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        MOSS_BUNDLED_CODEX_PATH: join(root, "bundled", "codex.exe"),
      });
      mkdirSync(npmBin, { recursive: true });
      writeFileSync(join(npmBin, "codex.cmd"), "@echo off\r\necho codex-cli 0.166.0\r\n");
      writeFileSync(join(npmBin, "opencode.cmd"), "@echo off\r\necho 1.18.31\r\n");
      resetLocalAgentPathLookupCache();
      expect(resolveCodexExecutable({}).source).toBe("bundled");
      const first = ensureAgentCliPath(join(root, "moss"), { force: true });
      const probe = ensureAgentCliPath(join(root, "moss")).then(() => resolveCodexExecutable({}));
      await first;
      const selected = await probe;
      expect(selected.source).toBe("path");
      expect(selected.binaryPath.toLowerCase()).toBe(join(npmBin, "codex.cmd").toLowerCase());
      const result = spawnProcessSync(selected.binaryPath, ["--version"], {
        env: process.env,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("codex-cli 0.166.0");
      expect(
        spawnProcessSync("opencode", ["--version"], {
          env: process.env,
          encoding: "utf8",
        }).stdout.trim(),
      ).toBe("1.18.31");

      const bundledClaude = join(root, "bundled", "claude.exe");
      expect(
        resolveLocalAgentExecutable({ command: "claude", bundledBinaryPath: bundledClaude }).source,
      ).toBe("bundled");
      writeFileSync(join(npmBin, "claude.cmd"), "@echo off\r\necho 2.1.318\r\n");
      // PATH stays unchanged, so a cached miss must be cleared by Re-detect.
      await ensureAgentCliPath(join(root, "moss"), { force: true });
      const claude = resolveLocalAgentExecutable({
        command: "claude",
        bundledBinaryPath: bundledClaude,
      });
      expect(claude.source).toBe("path");
      expect(claude.binaryPath.toLowerCase()).toBe(join(npmBin, "claude.cmd").toLowerCase());
    } finally {
      desktopScan.mockRestore();
      for (const name of Object.keys(process.env))
        if (!(name in originalEnv)) delete process.env[name];
      Object.assign(process.env, originalEnv);
      resetLocalAgentPathLookupCache();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

describe("agent CLI path refresh coordination", () => {
  it("makes concurrent startup probes wait for the same discovery before using PATH", async () => {
    let complete!: (directories: string[]) => void;
    const scan = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          complete = resolve;
        }),
    );
    const ensure = makeAgentCliPathMaintainer(scan);
    const startup = ensure("profile", { now: 0, force: true });
    let probed = false;
    const healthProbe = ensure("profile", { now: 1 }).then(() => {
      probed = true;
    });
    await Promise.resolve();
    expect(scan).toHaveBeenCalledTimes(1);
    expect(probed).toBe(false);
    complete(["existing-cli-bin"]);
    await expect(startup).resolves.toEqual(["existing-cli-bin"]);
    await healthProbe;
    expect(probed).toBe(true);
  });

  it("forces an immediate re-detect after installation while automatic refresh remains throttled", async () => {
    const scan = vi.fn(async () => ["bin"]);
    const ensure = makeAgentCliPathMaintainer(scan);
    await ensure("profile", { now: 0 });
    await expect(ensure("profile", { now: 1 })).resolves.toEqual([]);
    await expect(ensure("profile", { now: 1, force: true })).resolves.toEqual(["bin"]);
    await ensure("profile", { now: 15_001 });
    expect(scan).toHaveBeenCalledTimes(3);
  });

  it("shares a forced re-detect already in flight", async () => {
    let complete!: (directories: string[]) => void;
    const scan = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          complete = resolve;
        }),
    );
    const ensure = makeAgentCliPathMaintainer(scan);
    const first = ensure("profile", { force: true });
    const joined = ensure("profile", { force: true });
    await Promise.resolve();
    expect(scan).toHaveBeenCalledTimes(1);
    complete([]);
    await Promise.all([first, joined]);
  });

  it("replays an automatic scan when Re-detect arrives after its old directory snapshot", async () => {
    let complete!: (directories: string[]) => void;
    const scan = vi
      .fn<(home: string, options: { force?: boolean }) => Promise<string[]>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      )
      .mockResolvedValue(["new-install"]);
    const ensure = makeAgentCliPathMaintainer(scan);
    const automatic = ensure("profile", { now: 0 });
    await Promise.resolve();
    const manual = ensure("profile", { now: 1, force: true });
    const joined = ensure("profile", { now: 1, force: true });
    complete([]);
    await expect(manual).resolves.toEqual(["new-install"]);
    await Promise.all([automatic, joined]);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(scan.mock.calls[1]?.[1].force).toBe(true);
  });

  it("retries a failed first scan immediately and keeps profiles independent", async () => {
    const scan = vi
      .fn<(home: string) => Promise<string[]>>()
      .mockRejectedValueOnce(new Error("scan failed"))
      .mockResolvedValue(["bin"]);
    const ensure = makeAgentCliPathMaintainer(scan);
    await expect(ensure("profile", { now: 0 })).rejects.toThrow("scan failed");
    await expect(ensure("profile", { now: 1 })).resolves.toEqual(["bin"]);
    await expect(ensure("other-profile", { now: 2 })).resolves.toEqual(["bin"]);
    expect(scan).toHaveBeenCalledTimes(3);
  });
});

const WINDOWS_ENV = {
  USERPROFILE: "C:\\Users\\ada",
  APPDATA: "C:\\Users\\ada\\AppData\\Roaming",
  LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
};

function fakeFolders(folders: Record<string, ReadonlyArray<string>>) {
  const byKey = new Map(
    Object.entries(folders).map(([folder, names]) => [folder.toLowerCase(), names]),
  );
  return {
    listDirectory: (directory: string) => byKey.get(directory.toLowerCase()) ?? null,
    isExecutable: () => true,
  };
}

function readAdaNpmrc(filePath: string): string | null {
  return filePath === "C:\\Users\\ada\\.npmrc"
    ? "registry=https://r.example\nprefix=D:\\npm-global\n"
    : null;
}

describe("agentCliInstallDirectories", () => {
  it("looks where Windows installers and npm put agent CLIs", async () => {
    const directories = await agentCliInstallDirectories({
      platform: "win32",
      env: WINDOWS_ENV,
      readTextFile: () => null,
    });
    expect(directories).toEqual(
      expect.arrayContaining([
        "C:\\Users\\ada\\.local\\bin",
        "C:\\Users\\ada\\AppData\\Local\\cursor-agent",
        "C:\\Users\\ada\\.grok\\bin",
        "C:\\Users\\ada\\AppData\\Roaming\\npm",
        "C:\\Users\\ada\\.bun\\bin",
        "C:\\Users\\ada\\scoop\\shims",
        "C:\\Users\\ada\\AppData\\Local\\pnpm",
        "C:\\Users\\ada\\AppData\\Local\\Volta\\bin",
      ]),
    );
  });

  it("looks in Homebrew and the per-user folders on macOS", async () => {
    const directories = await agentCliInstallDirectories({
      platform: "darwin",
      env: { HOME: "/Users/ada" },
      readTextFile: () => null,
    });
    expect(directories).toEqual(
      expect.arrayContaining([
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/Users/ada/.local/bin",
        "/Users/ada/.claude/local",
        "/Users/ada/.bun/bin",
      ]),
    );
  });

  it("follows a custom npm prefix from the person's .npmrc", async () => {
    const readTextFile = readAdaNpmrc;
    expect(await readNpmrcGlobalPrefix({ platform: "win32", env: WINDOWS_ENV, readTextFile })).toBe(
      "D:\\npm-global",
    );
    expect(
      await agentCliInstallDirectories({ platform: "win32", env: WINDOWS_ENV, readTextFile }),
    ).toContain("D:\\npm-global");
    expect(
      await readNpmrcGlobalPrefix({
        platform: "linux",
        env: { HOME: "/home/ada" },
        readTextFile: () => "prefix=~/.npm-packages",
      }),
    ).toBe("/home/ada/.npm-packages");
  });
});

describe("appendAgentCliDirectoriesToPath", () => {
  it("adds only folders holding an agent CLI, after the person's PATH and before Moss's own", async () => {
    const env: NodeJS.ProcessEnv = {
      ...WINDOWS_ENV,
      Path: "C:\\Windows\\System32;C:\\Users\\ada\\.moss\\agents",
    };
    const added = await appendAgentCliDirectoriesToPath(
      [
        "C:\\Users\\ada\\AppData\\Roaming\\npm",
        "C:\\Users\\ada\\.bun\\bin",
        "C:\\Users\\ada\\.local\\bin",
        "C:\\Users\\ada\\scoop\\shims",
      ],
      {
        env,
        platform: "win32",
        keepLast: ["C:\\Users\\ada\\.moss\\agents"],
        ...fakeFolders({
          "C:\\Users\\ada\\AppData\\Roaming\\npm": ["codex.cmd", "codex.ps1", "node_modules"],
          // A folder of unrelated tools stays off PATH.
          "C:\\Users\\ada\\.bun\\bin": ["bun.exe"],
          "C:\\Users\\ada\\.local\\bin": ["claude.exe"],
        }),
      },
    );
    expect(added).toEqual(["C:\\Users\\ada\\AppData\\Roaming\\npm", "C:\\Users\\ada\\.local\\bin"]);
    expect(env.Path).toBe(
      "C:\\Windows\\System32;C:\\Users\\ada\\AppData\\Roaming\\npm;C:\\Users\\ada\\.local\\bin;C:\\Users\\ada\\.moss\\agents",
    );
    expect(env.PATH).toBeUndefined();
  });

  it("leaves a folder already on PATH where the person put it", async () => {
    const env: NodeJS.ProcessEnv = {
      ...WINDOWS_ENV,
      Path: "C:\\Users\\ada\\AppData\\Roaming\\npm\\",
    };
    const added = await appendAgentCliDirectoriesToPath(["C:\\Users\\ada\\AppData\\Roaming\\npm"], {
      env,
      platform: "win32",
      ...fakeFolders({ "C:\\Users\\ada\\AppData\\Roaming\\npm": ["codex.cmd"] }),
    });
    expect(added).toEqual([]);
    expect(env.Path).toBe("C:\\Users\\ada\\AppData\\Roaming\\npm\\");
  });

  it("finds a codex installed into the default global npm folder that is not on PATH", async () => {
    const env: NodeJS.ProcessEnv = { ...WINDOWS_ENV, Path: "C:\\Windows\\System32" };
    const added = await applyAgentCliPathFloor({
      env,
      platform: "win32",
      readTextFile: () => null,
      ...fakeFolders({ "C:\\Users\\ada\\AppData\\Roaming\\npm": ["codex.cmd", "claude.cmd"] }),
    });
    expect(added).toEqual(["C:\\Users\\ada\\AppData\\Roaming\\npm"]);
  });
});

describe("parseNpmPrefixOutput", () => {
  it("accepts one absolute path and nothing else", async () => {
    expect(parseNpmPrefixOutput("C:\\Users\\ada\\AppData\\Roaming\\npm\r\n", "win32")).toBe(
      "C:\\Users\\ada\\AppData\\Roaming\\npm",
    );
    expect(parseNpmPrefixOutput("/usr/local\n", "darwin")).toBe("/usr/local");
    expect(parseNpmPrefixOutput("undefined\n", "darwin")).toBeUndefined();
    expect(parseNpmPrefixOutput("", "win32")).toBeUndefined();
  });
});
