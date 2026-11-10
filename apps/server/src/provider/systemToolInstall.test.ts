import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  findReleaseChecksum,
  parseLatestReleaseVersion,
  runSystemToolInstall,
  SYSTEM_TOOL_INSTALLS,
  type SystemToolCommandResult,
  type SystemToolInstallHost,
  type SystemToolInstallPhase,
} from "./systemToolInstall";

const gh = SYSTEM_TOOL_INSTALLS["github-cli"];
const MSI = new TextEncoder().encode("official msi bytes");
const PKG = new TextEncoder().encode("official pkg bytes");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const exit = (exitCode: number, stdout = "", stderr = ""): SystemToolCommandResult => ({
  exitCode,
  stdout,
  stderr,
  timedOut: false,
});

/**
 * A fake computer. Nothing real runs: commands, downloads and files are recorded, and a
 * command "installs" gh by adding it to the fake disk.
 */
function computer(options: {
  platform: NodeJS.Platform;
  architecture?: string;
  files?: string[];
  onPath?: Record<string, string>;
  installs?: Record<string, { exitCode: number; installsTo?: string }>;
  release?: { status: number; tag?: string };
  checksums?: string;
  installer?: Uint8Array;
}) {
  const files = new Set(options.files ?? []);
  const onPath = { ...options.onPath };
  const commands: { command: string; args: ReadonlyArray<string> }[] = [];
  const downloads: string[] = [];
  const pathAdditions: string[] = [];
  const saved: string[] = [];
  const removed: string[] = [];
  const env: NodeJS.ProcessEnv =
    options.platform === "win32"
      ? {
          LOCALAPPDATA: "C:\\Users\\p\\AppData\\Local",
          ProgramFiles: "C:\\Program Files",
          SystemRoot: "C:\\Windows",
        }
      : {};
  const host: SystemToolInstallHost = {
    platform: options.platform,
    architecture: options.architecture ?? "x64",
    env,
    run: async ({ command, args }) => {
      commands.push({ command, args });
      if (args[0] === "--version") {
        return files.has(command) || Object.values(onPath).includes(command)
          ? exit(
              0,
              "gh version 2.83.1 (2025-11-13)\nhttps://github.com/cli/cli/releases/tag/v2.83.1\n",
            )
          : exit(1);
      }
      const key = Object.keys(options.installs ?? {}).find((name) => command.endsWith(name));
      const install = key ? options.installs![key]! : { exitCode: 1 };
      if (install.installsTo) files.add(install.installsTo);
      return exit(install.exitCode, "", install.exitCode === 0 ? "" : "Installer failed");
    },
    download: async (url) => {
      downloads.push(url);
      if (url.endsWith("/releases/latest")) {
        const release = options.release ?? { status: 200, tag: "v2.83.1" };
        return {
          status: release.status,
          body: new TextEncoder().encode(JSON.stringify({ tag_name: release.tag })),
        };
      }
      if (url.endsWith("_checksums.txt"))
        return {
          status: 200,
          body: new TextEncoder().encode(
            options.checksums ??
              [
                `${sha(MSI)}  gh_2.83.1_windows_amd64.msi`,
                `${sha(PKG)}  gh_2.83.1_macOS_universal.pkg`,
                `${"0".repeat(64)}  gh_2.83.1_linux_amd64.tar.gz`,
              ].join("\n"),
          ),
        };
      if (url.endsWith(".msi")) return { status: 200, body: options.installer ?? MSI };
      if (url.endsWith(".pkg")) return { status: 200, body: options.installer ?? PKG };
      return { status: 404, body: new Uint8Array() };
    },
    which: (command) => onPath[command] ?? null,
    fileExists: async (path) => files.has(path),
    saveInstaller: async (name) => {
      const path = `TEMP/${name}`;
      saved.push(path);
      return { path, remove: async () => void removed.push(path) };
    },
    addToPath: (directory) => void pathAdditions.push(directory),
  };
  return { host, commands, downloads, pathAdditions, saved, removed };
}

async function install(machine: ReturnType<typeof computer>) {
  const phases: SystemToolInstallPhase[] = [];
  const outcome = await runSystemToolInstall({
    tool: gh,
    host: machine.host,
    onProgress: (phase) => phases.push(phase),
  });
  return { outcome, phases };
}

const WINGET = "C:\\Users\\p\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe";
const GH_PROGRAM_FILES = "C:\\Program Files\\GitHub CLI\\gh.exe";
const GH_PER_USER = "C:\\Users\\p\\AppData\\Local\\Programs\\GitHub CLI\\gh.exe";

describe("GitHub CLI one-click install on Windows", () => {
  it("installs with winget, finds gh outside the stale PATH and puts it on the server's PATH", async () => {
    const machine = computer({
      platform: "win32",
      onPath: { winget: WINGET },
      installs: { "winget.exe": { exitCode: 0, installsTo: GH_PROGRAM_FILES } },
    });
    const { outcome, phases } = await install(machine);
    expect(outcome).toEqual({
      ok: true,
      version: "2.83.1",
      binDirectory: "C:\\Program Files\\GitHub CLI",
      method: "winget",
    });
    expect(machine.commands[0]).toEqual({
      command: WINGET,
      args: [
        "install",
        "--id",
        "GitHub.cli",
        "-e",
        "--silent",
        "--accept-package-agreements",
        "--accept-source-agreements",
      ],
    });
    expect(machine.pathAdditions).toEqual(["C:\\Program Files\\GitHub CLI"]);
    expect(machine.downloads).toEqual([]);
    expect(phases).toEqual(["installing", "verifying"]);
  });

  it("falls back to the official MSI, checked against the release checksums, installed per user and silently", async () => {
    const machine = computer({
      platform: "win32",
      onPath: { winget: WINGET },
      installs: {
        "winget.exe": { exitCode: 1 },
        "msiexec.exe": { exitCode: 0, installsTo: GH_PER_USER },
      },
    });
    const { outcome, phases } = await install(machine);
    expect(outcome).toMatchObject({ ok: true, method: "msi", version: "2.83.1" });
    expect(machine.downloads).toEqual([
      "https://api.github.com/repos/cli/cli/releases/latest",
      "https://github.com/cli/cli/releases/download/v2.83.1/gh_2.83.1_checksums.txt",
      "https://github.com/cli/cli/releases/download/v2.83.1/gh_2.83.1_windows_amd64.msi",
    ]);
    expect(machine.commands.at(-2)).toEqual({
      command: "C:\\Windows\\System32\\msiexec.exe",
      args: [
        "/i",
        "TEMP/gh_2.83.1_windows_amd64.msi",
        "/qn",
        "/norestart",
        "ALLUSERS=2",
        "MSIINSTALLPERUSER=1",
      ],
    });
    expect(machine.removed).toEqual(machine.saved);
    expect(phases).toEqual(["installing", "verifying", "downloading", "installing", "verifying"]);
  });

  it("uses the MSI directly when the computer has no winget, and picks the ARM build on ARM", async () => {
    const machine = computer({
      platform: "win32",
      architecture: "arm64",
      checksums: `${sha(MSI)}  gh_2.83.1_windows_arm64.msi`,
      installs: { "msiexec.exe": { exitCode: 0, installsTo: GH_PER_USER } },
    });
    const { outcome } = await install(machine);
    expect(outcome).toMatchObject({ ok: true, method: "msi" });
    expect(machine.downloads.at(-1)).toMatch(/gh_2\.83\.1_windows_arm64\.msi$/);
    expect(machine.commands.some(({ command }) => command.includes("winget"))).toBe(false);
  });

  it("never runs an installer that does not match its published checksum", async () => {
    const machine = computer({
      platform: "win32",
      installer: new TextEncoder().encode("tampered"),
      installs: { "msiexec.exe": { exitCode: 0, installsTo: GH_PER_USER } },
    });
    const { outcome } = await install(machine);
    expect(outcome).toMatchObject({ ok: false, reason: "download-failed" });
    expect(machine.commands.some(({ command }) => command.endsWith("msiexec.exe"))).toBe(false);
    expect(machine.saved).toEqual([]);
  });

  it("reports a download failure when GitHub cannot be reached", async () => {
    const machine = computer({ platform: "win32", release: { status: 503 } });
    expect((await install(machine)).outcome).toMatchObject({
      ok: false,
      reason: "download-failed",
    });
  });

  it("reports the installer failing, and an install that leaves no gh behind", async () => {
    const failing = computer({
      platform: "win32",
      installs: { "msiexec.exe": { exitCode: 1603 } },
    });
    expect((await install(failing)).outcome).toMatchObject({ ok: false, reason: "install-failed" });
    const silent = computer({ platform: "win32", installs: { "msiexec.exe": { exitCode: 0 } } });
    expect((await install(silent)).outcome).toMatchObject({ ok: false, reason: "verify-failed" });
  });

  it("counts gh that is installed but missing from the server's PATH as done, without installing", async () => {
    const machine = computer({ platform: "win32", files: [GH_PROGRAM_FILES] });
    const { outcome } = await install(machine);
    expect(outcome).toMatchObject({ ok: true, method: "present" });
    expect(machine.commands.map(({ args }) => args[0])).toEqual(["--version"]);
    expect(machine.downloads).toEqual([]);
  });
});

describe("GitHub CLI one-click install on macOS", () => {
  it("uses Homebrew when it is there", async () => {
    const machine = computer({
      platform: "darwin",
      files: ["/opt/homebrew/bin/brew"],
      installs: { "/brew": { exitCode: 0, installsTo: "/opt/homebrew/bin/gh" } },
    });
    const { outcome } = await install(machine);
    expect(outcome).toMatchObject({
      ok: true,
      method: "homebrew",
      binDirectory: "/opt/homebrew/bin",
    });
    expect(machine.commands[0]).toEqual({
      command: "/opt/homebrew/bin/brew",
      args: ["install", "gh"],
    });
  });

  it("opens the official package in the system Installer when there is no Homebrew", async () => {
    const machine = computer({
      platform: "darwin",
      installs: { "/usr/bin/open": { exitCode: 0, installsTo: "/usr/local/bin/gh" } },
    });
    const { outcome } = await install(machine);
    expect(outcome).toMatchObject({ ok: true, method: "pkg", binDirectory: "/usr/local/bin" });
    expect(machine.commands.find(({ command }) => command === "/usr/bin/open")?.args).toEqual([
      "-W",
      "TEMP/gh_2.83.1_macOS_universal.pkg",
    ]);
  });
});

describe("GitHub CLI one-click install elsewhere", () => {
  it("says Linux is not supported instead of guessing a package manager", async () => {
    const machine = computer({ platform: "linux" });
    expect((await install(machine)).outcome).toMatchObject({ ok: false, reason: "unsupported" });
    expect(machine.downloads).toEqual([]);
  });
});

describe("release metadata", () => {
  it("reads the latest version and an asset's checksum", () => {
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    expect(parseLatestReleaseVersion(encode({ tag_name: "v2.83.1" }))).toBe("2.83.1");
    expect(parseLatestReleaseVersion(encode({ tag_name: "nightly" }))).toBeNull();
    expect(parseLatestReleaseVersion(new TextEncoder().encode("<html>"))).toBeNull();
    const list = `${"a".repeat(64)}  gh_1_windows_amd64.msi\n${"B".repeat(64)} *gh_1.pkg\n`;
    expect(findReleaseChecksum(list, "gh_1_windows_amd64.msi")).toBe("a".repeat(64));
    expect(findReleaseChecksum(list, "gh_1.pkg")).toBe("b".repeat(64));
    expect(findReleaseChecksum(list, "gh_1_windows_amd64.msi.sig")).toBeNull();
  });
});
