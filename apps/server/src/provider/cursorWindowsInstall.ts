// Installs Cursor's audited native Windows package under Moss's existing install lock.
import * as FS from "node:fs/promises";
import * as Path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { outboundHttp, resolveOutboundProxyUrl } from "@moss/shared/outboundHttp";
import { Duration, Effect, Option } from "effect";
import { AGENT_ZIP_LIMITS, extractAgentZip } from "./agentInstallZip.ts";
import type { AgentInstallCommandRunner, AgentInstallOutcome } from "./providerInstall.ts";
import { makeNativeAgentInstallProbe } from "./nativeAgentInstallProbe.ts";

// Updating this release requires reviewing its layout and launch contract. The
// official installer publishes no independent checksum/signature metadata.
export const CURSOR_WINDOWS_RELEASE = "2026.11.05-86047df";
export const CURSOR_INSTALL_PAGE = "https://docs.cursor.com/en/cli/installation";
export type CursorWindowsArchitecture = "x64" | "arm64";

export function supportsCursorWindowsInstall(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): boolean {
  return platform === "win32" && (arch === "x64" || arch === "arm64");
}

export function cursorWindowsArchiveUrl(arch: CursorWindowsArchitecture): string {
  return `https://downloads.cursor.com/lab/${CURSOR_WINDOWS_RELEASE}/windows/${arch}/agent-cli-package.zip`;
}

/** CIM distinguishes ARM64 Windows even when Moss itself is an x64 process. */
export function parseCursorWindowsArchitecture(
  systemType: string,
): CursorWindowsArchitecture | null {
  const value = systemType.trim();
  if (/^ARM64-based PC$/iu.test(value)) return "arm64";
  if (/^x64-based PC$/iu.test(value)) return "x64";
  return null;
}

async function downloadArchive(url: string, env: NodeJS.ProcessEnv): Promise<Uint8Array> {
  const proxyUrl = resolveOutboundProxyUrl(url, env);
  const response = await outboundHttp.request({
    url,
    policy: {
      service: "moss-agent-install-cursor",
      allowedOrigins: ["https://downloads.cursor.com"],
      timeoutMs: 120_000,
      maxRequestBytes: 0,
      maxResponseBytes: AGENT_ZIP_LIMITS.archive,
      maxRedirects: 0,
      maxConcurrent: 1,
      maxQueued: 2,
      allowBenchmarkAddressRange: true,
      ...(proxyUrl ? { proxyUrl } : {}),
    },
  });
  if (response.status !== 200) throw new Error(`Cursor download answered ${response.status}.`);
  return response.body;
}

export const LAUNCHER_CMD = [
  "@ECHO OFF",
  "SETLOCAL DisableDelayedExpansion",
  'SET "MOSS_CURSOR_VERSION="',
  'FOR /F "usebackq delims=" %%V IN (`""%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0cursor\\resolve-version.ps1""`) DO SET "MOSS_CURSOR_VERSION=%%V"',
  "IF NOT DEFINED MOSS_CURSOR_VERSION EXIT /B 1",
  'SET "CURSOR_INVOKED_AS=cursor-agent"',
  'IF NOT DEFINED NODE_COMPILE_CACHE SET "NODE_COMPILE_CACHE=%~dp0cursor\\compile-cache"',
  '"%~dp0cursor\\versions\\%MOSS_CURSOR_VERSION%\\node.exe" "%~dp0cursor\\versions\\%MOSS_CURSOR_VERSION%\\index.js" %*',
  "EXIT /B %ERRORLEVEL%",
  "",
].join("\r\n");

// PowerShell validates only the fixed version pointer. No CLI arguments pass
// through its legacy native binder; cmd invokes private Node directly like npm.
export const LAUNCHER_PS1 = [
  "$ErrorActionPreference = 'Stop'",
  "$version = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'active-version')).Trim()",
  "if ($version -notmatch '^\\d{4}\\.\\d{2}\\.\\d{2}-[0-9a-f]{7,40}-(x64|arm64)$') { throw 'Invalid Moss Cursor version.' }",
  "Write-Output $version",
  "",
].join("\r\n");

async function ordinaryDirectory(directory: string) {
  await FS.mkdir(directory).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code !== "EEXIST") throw cause;
  });
  const info = await FS.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Agent install directory is linked or not a directory.");
}

async function ordinaryFile(file: string) {
  const info = await FS.lstat(file);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("Agent package file is linked or not a file.");
}

async function checkLauncher(file: string, source: string) {
  try {
    await ordinaryFile(file);
    if ((await FS.readFile(file, "utf8")) !== source)
      throw new Error("Existing agent launcher is not Moss-owned.");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
}

async function createLauncher(file: string, source: string) {
  await FS.writeFile(file, source, { flag: "wx" }).catch(async (cause: NodeJS.ErrnoException) => {
    if (cause.code !== "EEXIST") throw cause;
    await checkLauncher(file, source);
  });
}

export async function writeCursorManagedLaunchers(prefix: string): Promise<void> {
  const root = Path.join(prefix, "cursor");
  await ordinaryDirectory(root);
  await checkLauncher(Path.join(root, "resolve-version.ps1"), LAUNCHER_PS1);
  await checkLauncher(Path.join(prefix, "cursor-agent.cmd"), LAUNCHER_CMD);
  await createLauncher(Path.join(root, "resolve-version.ps1"), LAUNCHER_PS1);
  await createLauncher(Path.join(prefix, "cursor-agent.cmd"), LAUNCHER_CMD);
}

function probeEnvironment(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (
      /^(SystemRoot|SystemDrive|windir|ComSpec|PATHEXT|PATH|OS|PROCESSOR_.*|NUMBER_OF_PROCESSORS|ProgramFiles.*|CommonProgramFiles.*)$/iu.test(
        name,
      )
    )
      clean[name] = value;
  }
  return {
    ...clean,
    HOME: home,
    USERPROFILE: home,
    APPDATA: Path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: Path.join(home, "AppData", "Local"),
    TEMP: home,
    TMP: home,
    CURSOR_CONFIG_DIR: Path.join(home, ".cursor"),
    NODE_COMPILE_CACHE: Path.join(home, "compile-cache"),
    CURSOR_API_KEY: "moss-isolated-version-probe",
  };
}

function exactVersion(output: string): boolean {
  return (
    output.length <= 4_096 &&
    output
      .trim()
      .split(/\s+/u)
      .some((part) => part === CURSOR_WINDOWS_RELEASE)
  );
}

function cleanupUnproven(): AgentInstallOutcome {
  return {
    ok: false,
    reason: "cleanup-unproven",
    detail:
      "Cursor probe cleanup is unproven; staging was retained when present. Restart Moss before retrying.",
  };
}

export const runCursorWindowsInstall = Effect.fn("runCursorWindowsInstall")(function* (input: {
  readonly mossHomeDir: string;
  readonly env: NodeJS.ProcessEnv;
  /** Synthetic command seam only; production uses a Node owner with close proof. */
  readonly run?: AgentInstallCommandRunner;
  readonly fetchArchive?: (url: string) => Promise<Uint8Array>;
  readonly onProgress?: (progress: {
    phase: "installing" | "verifying";
    source: "official";
  }) => Effect.Effect<void>;
  readonly onCleanupUnproven?: Effect.Effect<void>;
}) {
  let phase: "installing" | "verifying" = "installing";
  let cleanupSafe = true;
  const run =
    input.run ??
    makeNativeAgentInstallProbe(
      Effect.gen(function* () {
        cleanupSafe = false;
        yield* input.onCleanupUnproven ?? Effect.void;
      }),
    );
  const work = Effect.gen(function* () {
    // Fixed, local OS query only; never a downloaded script or provider binary.
    const systemRoot = input.env.SystemRoot ?? input.env.SYSTEMROOT;
    if (!systemRoot || !Path.win32.isAbsolute(systemRoot)) {
      return yield* Effect.fail(new Error("Windows system directory unavailable."));
    }
    const architectureProbe = yield* run({
      command: Path.win32.join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-CimInstance -ClassName Win32_ComputerSystem -Property SystemType -ErrorAction Stop).SystemType",
      ],
      env: probeEnvironment(input.env, input.mossHomeDir),
    }).pipe(Effect.timeoutOption(Duration.seconds(10)));
    if (!cleanupSafe) return cleanupUnproven();
    const architectureResult =
      Option.isSome(architectureProbe) && Option.isSome(architectureProbe.value)
        ? architectureProbe.value.value
        : null;
    const arch =
      architectureResult?.exitCode === 0
        ? parseCursorWindowsArchitecture(architectureResult.stdout)
        : null;
    if (!arch)
      return yield* Effect.fail(new Error("Native Windows architecture could not be verified."));

    const prefix = Path.join(input.mossHomeDir, "agents");
    const root = Path.join(prefix, "cursor");
    const versions = Path.join(root, "versions");
    const versionName = `${CURSOR_WINDOWS_RELEASE}-${arch}`;
    const finalDirectory = Path.join(versions, versionName);
    const cmd = Path.join(prefix, "cursor-agent.cmd");
    const ps1 = Path.join(root, "resolve-version.ps1");
    yield* Effect.tryPromise(async () => {
      await ordinaryDirectory(prefix);
      await ordinaryDirectory(root);
      await ordinaryDirectory(versions);
      await checkLauncher(cmd, LAUNCHER_CMD);
      await checkLauncher(ps1, LAUNCHER_PS1);
    }).pipe(Effect.uninterruptible);
    const staging = yield* Effect.acquireRelease(
      Effect.tryPromise(() => FS.mkdtemp(Path.join(versions, ".partial-"))),
      (directory) =>
        Effect.gen(function* () {
          if (!cleanupSafe) return;
          yield* Effect.tryPromise(async () => {
            // Only this install's checked mkdtemp child can be recursively removed.
            if (
              Path.dirname(directory) !== versions ||
              !Path.basename(directory).startsWith(".partial-")
            )
              throw new Error("Invalid staging cleanup path.");
            await FS.rm(directory, { recursive: true, force: true });
          }).pipe(
            Effect.catch(() =>
              Effect.gen(function* () {
                cleanupSafe = false;
                yield* input.onCleanupUnproven ?? Effect.void;
              }),
            ),
          );
        }),
    );
    const probeHome = Path.join(staging, ".probe-profile");
    let existing = false;
    yield* Effect.tryPromise(async () => {
      try {
        const info = await FS.lstat(finalDirectory);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error("Existing Cursor version is not an ordinary directory.");
        existing = true;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
    });
    if (!existing) {
      yield* input.onProgress?.({ phase, source: "official" }) ?? Effect.void;
      const fetch = input.fetchArchive ?? ((url: string) => downloadArchive(url, input.env));
      const archive = yield* Effect.tryPromise(() => fetch(cursorWindowsArchiveUrl(arch)));
      yield* Effect.tryPromise(() => extractAgentZip(archive, staging)).pipe(
        Effect.uninterruptible,
      );
      yield* Effect.tryPromise(() =>
        FS.writeFile(
          Path.join(staging, "moss-install-source.json"),
          JSON.stringify(
            {
              schemaVersion: 1,
              provider: "cursor",
              version: CURSOR_WINDOWS_RELEASE,
              architecture: arch,
              url: cursorWindowsArchiveUrl(arch),
              archiveSha256: createHash("sha256").update(archive).digest("hex"),
              archiveBytes: archive.byteLength,
              receivedAt: new Date().toISOString(),
              publisherSignature: "not-provided",
              verification:
                "HTTPS origin and ZIP structure/CRC; SHA-256 records downloaded bytes, not publisher authenticity.",
            },
            null,
            2,
          ),
          { flag: "wx" },
        ),
      ).pipe(Effect.uninterruptible);
    }
    const candidate = existing ? finalDirectory : staging;
    yield* Effect.tryPromise(async () => {
      await ordinaryFile(Path.join(candidate, "node.exe"));
      await ordinaryFile(Path.join(candidate, "index.js"));
      await ordinaryFile(Path.join(candidate, "package.json"));
      if ((await FS.stat(Path.join(candidate, "package.json"))).size > 65_536)
        throw new Error("Cursor package metadata exceeds its size limit.");
      const metadata = JSON.parse(
        await FS.readFile(Path.join(candidate, "package.json"), "utf8"),
      ) as { name?: unknown };
      if (metadata.name !== "@anysphere/agent-cli-runtime")
        throw new Error("Unexpected Cursor package identity.");
      for (const dir of [
        probeHome,
        Path.join(probeHome, "AppData"),
        Path.join(probeHome, "AppData", "Roaming"),
        Path.join(probeHome, "AppData", "Local"),
      ])
        await ordinaryDirectory(dir);
    }).pipe(Effect.uninterruptible);
    phase = "verifying";
    yield* input.onProgress?.({ phase, source: "official" }) ?? Effect.void;
    const verify = yield* run({
      command: Path.join(candidate, "node.exe"),
      args: [Path.join(candidate, "index.js"), "--version"],
      env: probeEnvironment(input.env, probeHome),
    }).pipe(Effect.timeoutOption(Duration.seconds(15)));
    if (!cleanupSafe) {
      return cleanupUnproven();
    }
    if (Option.isNone(verify) || Option.isNone(verify.value)) {
      return {
        ok: false,
        reason: "timed-out",
        detail: "Cursor version probe timed out.",
      } satisfies AgentInstallOutcome;
    }
    const result = verify.value.value;
    if (result.exitCode !== 0 || !exactVersion(`${result.stdout}\n${result.stderr}`)) {
      return {
        ok: false,
        reason: "verify-failed",
        detail: "Private Cursor package did not report the exact requested release.",
      } satisfies AgentInstallOutcome;
    }
    yield* Effect.tryPromise(async () => {
      await FS.rm(probeHome, { recursive: true, force: true });
      if (!existing) await FS.rename(staging, finalDirectory);
      await writeCursorManagedLaunchers(prefix);
      const pointer = Path.join(root, "active-version");
      try {
        await ordinaryFile(pointer);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
      const pending = Path.join(root, `.active-${randomUUID()}`);
      try {
        await FS.writeFile(pending, `${versionName}\n`, { flag: "wx" });
        await FS.rename(pending, pointer);
      } finally {
        await FS.rm(pending, { force: true });
      }
    }).pipe(Effect.uninterruptible);
    return {
      ok: true,
      version: CURSOR_WINDOWS_RELEASE,
      source: "official",
      binDirectory: prefix,
    } satisfies AgentInstallOutcome;
  }).pipe(Effect.scoped);
  const outcome = yield* work.pipe(
    Effect.catch((cause) =>
      Effect.succeed({
        ok: false,
        reason: phase === "verifying" ? "verify-failed" : "download-failed",
        detail: cause instanceof Error ? cause.message : String(cause),
      } satisfies AgentInstallOutcome),
    ),
  );
  return cleanupSafe ? outcome : cleanupUnproven();
});
