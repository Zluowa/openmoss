// FILE: systemToolInstall.ts
// Purpose: One-click install of tools that are not npm packages (GitHub CLI): the system's own
//          package manager first (winget, Homebrew), then the tool's official installer.
// Layer: Provider maintenance (server). The npm-based agent installs live in providerInstall.ts.
// Exports: SYSTEM_TOOL_INSTALLS, runSystemToolInstall, createSystemToolInstallHost and the
//          release helpers used by its tests.
//
// Nothing here asks for administrator rights on purpose: winget installs for the person, the
// Windows MSI runs per-user and silently, and macOS's package opens in the system Installer,
// where the person confirms it. Every download is checked against the release's SHA-256 list.

import { createHash } from "node:crypto";
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { envPathKeyFor, resolveExecutable } from "@moss/shared/executable";
import { outboundHttp, resolveOutboundProxyUrl } from "@moss/shared/outboundHttp";
import { mergePathEntries } from "@moss/shared/shell";

import { runProcess } from "../processRunner.ts";
import { parseGenericCliVersion } from "./providerMaintenance.ts";

export type SystemToolId = "github-cli";

/** A tool Moss installs through the system package manager or the vendor's own installer. */
export interface SystemToolInstall {
  readonly command: string;
  readonly versionArgs: ReadonlyArray<string>;
  /** The page the person can install it from when Moss cannot. */
  readonly officialPage: string;
  readonly wingetId: string;
  readonly brewFormula: string;
  /** GitHub `owner/repo` whose latest release carries the official installers. */
  readonly releaseRepository: string;
  /** The installer asset in a release, or null when there is none for this computer. */
  readonly releaseAsset: (
    version: string,
    platform: NodeJS.Platform,
    architecture: string,
  ) => string | null;
  /** The release's SHA-256 list. */
  readonly checksumsAsset: (version: string) => string;
  /** Where the installers put the command, for when the running server's PATH predates it. */
  readonly installDirectories: (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => string[];
}

const WINDOWS_ARCHITECTURES: Record<string, string> = { x64: "amd64", arm64: "arm64", ia32: "386" };

export const SYSTEM_TOOL_INSTALLS: Record<SystemToolId, SystemToolInstall> = {
  "github-cli": {
    command: "gh",
    versionArgs: ["--version"],
    officialPage: "https://cli.github.com/",
    wingetId: "GitHub.cli",
    brewFormula: "gh",
    releaseRepository: "cli/cli",
    releaseAsset: (version, platform, architecture) => {
      if (platform === "win32") {
        const arch = WINDOWS_ARCHITECTURES[architecture];
        return arch ? `gh_${version}_windows_${arch}.msi` : null;
      }
      return platform === "darwin" ? `gh_${version}_macOS_universal.pkg` : null;
    },
    checksumsAsset: (version) => `gh_${version}_checksums.txt`,
    installDirectories: (env, platform) => {
      if (platform === "win32") {
        return [
          env.LOCALAPPDATA && Path.win32.join(env.LOCALAPPDATA, "Programs", "GitHub CLI"),
          env.ProgramFiles && Path.win32.join(env.ProgramFiles, "GitHub CLI"),
          env["ProgramFiles(x86)"] && Path.win32.join(env["ProgramFiles(x86)"], "GitHub CLI"),
          env.LOCALAPPDATA && Path.win32.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links"),
        ].filter((entry): entry is string => Boolean(entry));
      }
      return platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin"] : [];
    },
  },
};

export type SystemToolInstallPhase = "downloading" | "installing" | "verifying";
export type SystemToolInstallFailure =
  | "unsupported"
  | "download-failed"
  | "install-failed"
  | "verify-failed";

export type SystemToolInstallOutcome =
  | {
      readonly ok: true;
      readonly version: string;
      /** The folder holding the command; already on the server's PATH when this returns. */
      readonly binDirectory: string;
      readonly method: "present" | "winget" | "msi" | "homebrew" | "pkg";
    }
  | {
      readonly ok: false;
      readonly reason: SystemToolInstallFailure;
      /** Short diagnostic for the server log only; never shown to a person. */
      readonly detail: string;
    };

export interface SystemToolCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** What the install touches outside itself; tests replace every part. */
export interface SystemToolInstallHost {
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly env: NodeJS.ProcessEnv;
  /** Runs one command to completion; rejects only when it cannot start. */
  readonly run: (input: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly env: NodeJS.ProcessEnv;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  }) => Promise<SystemToolCommandResult>;
  /** GETs a URL from GitHub and its download hosts. */
  readonly download: (
    url: string,
    options: { readonly maxBytes: number; readonly accept?: string; readonly signal?: AbortSignal },
  ) => Promise<{ readonly status: number; readonly body: Uint8Array }>;
  /** A command on PATH, or null. */
  readonly which: (command: string, env: NodeJS.ProcessEnv) => string | null;
  readonly fileExists: (path: string) => Promise<boolean>;
  /** Writes an installer into a fresh private folder; `remove` deletes the folder. */
  readonly saveInstaller: (
    name: string,
    bytes: Uint8Array,
  ) => Promise<{ readonly path: string; readonly remove: () => Promise<void> }>;
  /** Puts a folder on the server's PATH so the new command is found without a restart. */
  readonly addToPath: (directory: string) => void;
}

const INSTALL_TIMEOUT_MS = 15 * 60_000;
/** The macOS Installer waits for the person, so it gets longer. */
const INTERACTIVE_INSTALL_TIMEOUT_MS = 30 * 60_000;
const VERSION_TIMEOUT_MS = 15_000;
const INSTALLER_MAX_BYTES = 120 * 1024 * 1024;
const METADATA_MAX_BYTES = 2 * 1024 * 1024;

/** The latest release's version, e.g. "2.83.1", from the GitHub API's `tag_name`. */
export function parseLatestReleaseVersion(body: Uint8Array): string | null {
  try {
    const release = JSON.parse(new TextDecoder().decode(body)) as { tag_name?: unknown };
    const tag = typeof release.tag_name === "string" ? release.tag_name : "";
    return /^v(\d+\.\d+\.\d+)$/.exec(tag)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The SHA-256 a release's checksum list gives for `fileName`, or null. */
export function findReleaseChecksum(list: string, fileName: string): string | null {
  for (const line of list.split(/\r?\n/u)) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)$/i.exec(line.trim());
    if (match?.[2] === fileName) return match[1]!.toLowerCase();
  }
  return null;
}

const failed = (reason: SystemToolInstallFailure, detail: string): SystemToolInstallOutcome => ({
  ok: false,
  reason,
  detail,
});

function describe(result: SystemToolCommandResult): string {
  if (result.timedOut) return "timed out";
  const last = `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .findLast(Boolean);
  return `exit ${result.exitCode ?? "null"}${last ? `: ${last.slice(0, 200)}` : ""}`;
}

/**
 * Installs `tool` and proves the command runs. Already installed (only missing from this
 * server's PATH) counts as done. Never throws; a failure says which step failed.
 */
export async function runSystemToolInstall(input: {
  readonly tool: SystemToolInstall;
  readonly host: SystemToolInstallHost;
  readonly onProgress?: (phase: SystemToolInstallPhase) => void;
  readonly signal?: AbortSignal;
}): Promise<SystemToolInstallOutcome> {
  const { tool, host, signal } = input;
  const progress = (phase: SystemToolInstallPhase) => input.onProgress?.(phase);
  const executableName = host.platform === "win32" ? `${tool.command}.exe` : tool.command;
  // Paths follow the computer being installed on, not the one running the tests.
  const paths = host.platform === "win32" ? Path.win32 : Path.posix;
  const run = (command: string, args: ReadonlyArray<string>, timeoutMs: number) =>
    host.run({ command, args, env: host.env, timeoutMs, ...(signal ? { signal } : {}) });

  async function locate(): Promise<string | null> {
    const onPath = host.which(tool.command, host.env);
    if (onPath) return onPath;
    for (const directory of tool.installDirectories(host.env, host.platform)) {
      const candidate = paths.join(directory, executableName);
      if (await host.fileExists(candidate)) return candidate;
    }
    return null;
  }

  async function verify(
    method: Extract<SystemToolInstallOutcome, { ok: true }>["method"],
  ): Promise<SystemToolInstallOutcome | null> {
    const executable = await locate();
    if (!executable) return null;
    const result = await run(executable, tool.versionArgs, VERSION_TIMEOUT_MS).catch(() => null);
    const version =
      result && result.exitCode === 0
        ? parseGenericCliVersion(`${result.stdout}\n${result.stderr}`)
        : null;
    if (!version) return null;
    const binDirectory = paths.dirname(executable);
    host.addToPath(binDirectory);
    return { ok: true, version, binDirectory, method };
  }

  try {
    const present = await verify("present");
    if (present) return present;
    if (host.platform !== "win32" && host.platform !== "darwin")
      return failed("unsupported", `No one-click install on ${host.platform}.`);

    // 1. The system package manager, when the computer has one.
    const manager =
      host.platform === "win32"
        ? (host.which("winget", host.env) ??
          (host.env.LOCALAPPDATA &&
          (await host.fileExists(
            paths.join(host.env.LOCALAPPDATA, "Microsoft", "WindowsApps", "winget.exe"),
          ))
            ? paths.join(host.env.LOCALAPPDATA, "Microsoft", "WindowsApps", "winget.exe")
            : null))
        : (host.which("brew", host.env) ??
          (await firstExisting(host, ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"])));
    let managerFailure = "";
    if (manager) {
      progress("installing");
      const args =
        host.platform === "win32"
          ? [
              "install",
              "--id",
              tool.wingetId,
              "-e",
              "--silent",
              "--accept-package-agreements",
              "--accept-source-agreements",
            ]
          : ["install", tool.brewFormula];
      const result = await run(manager, args, INSTALL_TIMEOUT_MS).catch(
        (error: unknown): SystemToolCommandResult => ({
          exitCode: null,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          timedOut: false,
        }),
      );
      if (signal?.aborted) return failed("install-failed", "Cancelled.");
      progress("verifying");
      // winget answers non-zero when the package was already there; the command decides.
      const installed = await verify(host.platform === "win32" ? "winget" : "homebrew");
      if (installed) return installed;
      managerFailure = `${paths.basename(manager)} ${describe(result)}; `;
    }

    // 2. The official installer from the tool's latest release, checked against its checksums.
    progress("downloading");
    const release = await host
      .download(`https://api.github.com/repos/${tool.releaseRepository}/releases/latest`, {
        maxBytes: METADATA_MAX_BYTES,
        accept: "application/vnd.github+json",
        ...(signal ? { signal } : {}),
      })
      .catch(() => null);
    const version = release?.status === 200 ? parseLatestReleaseVersion(release.body) : null;
    if (!version) return failed("download-failed", `${managerFailure}latest release unavailable.`);
    const asset = tool.releaseAsset(version, host.platform, host.architecture);
    if (!asset)
      return failed("unsupported", `${managerFailure}no installer for ${host.architecture}.`);
    const base = `https://github.com/${tool.releaseRepository}/releases/download/v${version}`;
    const [checksums, installer] = await Promise.all([
      host
        .download(`${base}/${tool.checksumsAsset(version)}`, {
          maxBytes: METADATA_MAX_BYTES,
          ...(signal ? { signal } : {}),
        })
        .catch(() => null),
      host
        .download(`${base}/${asset}`, {
          maxBytes: INSTALLER_MAX_BYTES,
          ...(signal ? { signal } : {}),
        })
        .catch(() => null),
    ]);
    if (checksums?.status !== 200 || installer?.status !== 200)
      return failed("download-failed", `${managerFailure}${asset} could not be downloaded.`);
    const expected = findReleaseChecksum(new TextDecoder().decode(checksums.body), asset);
    const actual = createHash("sha256").update(installer.body).digest("hex");
    if (!expected || expected !== actual)
      return failed("download-failed", `${managerFailure}${asset} failed its checksum.`);
    if (signal?.aborted) return failed("install-failed", "Cancelled.");

    progress("installing");
    const saved = await host.saveInstaller(asset, installer.body);
    try {
      const result =
        host.platform === "win32"
          ? await run(
              Path.win32.join(host.env.SystemRoot ?? "C:\\Windows", "System32", "msiexec.exe"),
              ["/i", saved.path, "/qn", "/norestart", "ALLUSERS=2", "MSIINSTALLPERUSER=1"],
              INSTALL_TIMEOUT_MS,
            )
          : // The system Installer asks the person to confirm; -W waits until it closes.
            await run("/usr/bin/open", ["-W", saved.path], INTERACTIVE_INSTALL_TIMEOUT_MS);
      if (signal?.aborted) return failed("install-failed", "Cancelled.");
      progress("verifying");
      const installed = await verify(host.platform === "win32" ? "msi" : "pkg");
      if (installed) return installed;
      return result.exitCode === 0 && !result.timedOut
        ? failed("verify-failed", `${managerFailure}${tool.command} not found after install.`)
        : failed("install-failed", `${managerFailure}installer ${describe(result)}.`);
    } finally {
      await saved.remove().catch(() => {});
    }
  } catch (error) {
    return failed(
      "install-failed",
      error instanceof Error ? error.message.slice(0, 300) : "Unexpected install error.",
    );
  }
}

async function firstExisting(
  host: SystemToolInstallHost,
  candidates: ReadonlyArray<string>,
): Promise<string | null> {
  for (const candidate of candidates) if (await host.fileExists(candidate)) return candidate;
  return null;
}

/** GitHub and the hosts its release downloads redirect to. */
const DOWNLOAD_ORIGINS = [
  "https://api.github.com",
  "https://github.com",
  "https://objects.githubusercontent.com",
  "https://release-assets.githubusercontent.com",
];

/** The real computer: child processes, GitHub downloads, a private temp folder, process PATH. */
export function createSystemToolInstallHost(
  env: NodeJS.ProcessEnv = process.env,
): SystemToolInstallHost {
  return {
    platform: process.platform,
    architecture: process.arch,
    env,
    run: async ({ command, args, env: runEnv, timeoutMs, signal }) => {
      const result = await runProcess(command, args, {
        env: runEnv,
        timeoutMs,
        allowNonZeroExit: true,
        maxBufferBytes: 64 * 1024,
        outputMode: "truncate",
        ...(signal ? { signal } : {}),
      });
      return {
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
      };
    },
    download: async (url, options) => {
      const proxyUrl = resolveOutboundProxyUrl(url, env);
      const response = await outboundHttp.request({
        url,
        headers: {
          "user-agent": "Moss",
          ...(options.accept ? { accept: options.accept } : {}),
        },
        ...(options.signal ? { signal: options.signal } : {}),
        policy: {
          service: "moss-system-tool-install",
          allowedOrigins: DOWNLOAD_ORIGINS,
          timeoutMs: 10 * 60_000,
          maxRequestBytes: 0,
          maxResponseBytes: options.maxBytes,
          maxRedirects: 5,
          maxConcurrent: 2,
          maxQueued: 4,
          allowBenchmarkAddressRange: true,
          ...(proxyUrl ? { proxyUrl } : {}),
        },
      });
      return { status: response.status, body: response.body };
    },
    which: (command, lookupEnv) => resolveExecutable(command, { env: lookupEnv }),
    fileExists: (path) =>
      FS.access(path).then(
        () => true,
        () => false,
      ),
    saveInstaller: async (name, bytes) => {
      const folder = await FS.mkdtemp(Path.join(OS.tmpdir(), "moss-tool-install-"));
      const path = Path.join(folder, Path.basename(name));
      await FS.writeFile(path, bytes);
      return { path, remove: () => FS.rm(folder, { recursive: true, force: true }) };
    },
    addToPath: (directory) => {
      const key = envPathKeyFor(env, process.platform);
      env[key] = mergePathEntries(env[key], directory, process.platform) ?? directory;
    },
  };
}
