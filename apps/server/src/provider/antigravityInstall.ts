// FILE: antigravityInstall.ts
// Purpose: Direct one-click install of Antigravity CLI (`agy`) from its official release
//          manifest with SHA-512 verification and bounded streaming into Moss's managed folder.
// Layer: Provider maintenance (server).

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import * as FS from "node:fs/promises";
import * as Path from "node:path";
import { createGunzip } from "node:zlib";

import {
  decodeOutboundJson,
  OutboundHttpError,
  outboundHttp,
  resolveOutboundProxyUrl,
} from "@moss/shared/outboundHttp";
import { withOutboundProxyEnv } from "@moss/shared/outboundProxy";
import { Duration, Effect, Option } from "effect";

import { managedAgentBinDirectory, managedAgentInstallPrefix } from "./managedAgentPaths.ts";
import { makeNativeAgentInstallProbe } from "./nativeAgentInstallProbe.ts";
import type { AgentInstallCommandRunner, AgentInstallOutcome } from "./providerInstall.ts";
import { compareSemverVersions, parseGenericCliVersion } from "./providerMaintenance.ts";

export const ANTIGRAVITY_MANIFEST_ORIGIN =
  "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app";
export const ANTIGRAVITY_DOWNLOAD_ORIGINS = [
  "https://storage.googleapis.com",
  ANTIGRAVITY_MANIFEST_ORIGIN,
] as const;
export const ANTIGRAVITY_INSTALL_PAGE = "https://antigravity.google/docs/cli/using";
// `agy acp`, which Moss drives Antigravity through, shipped in 1.5.0.
export const MINIMUM_ANTIGRAVITY_CLI_VERSION = "1.5.0";
/** File name of the Antigravity CLI binary Moss installs for `platform`. */
export function antigravityBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "agy.exe" : "agy";
}

export const ANTIGRAVITY_INSTALL_METADATA_FILE = "moss-install-source.json";

const ANTIGRAVITY_MANIFEST_MAX_BYTES = 64 * 1024;
const ANTIGRAVITY_PAYLOAD_MAX_BYTES = 512 * 1024 * 1024;
const ANTIGRAVITY_EXTRACTED_MAX_BYTES = 512 * 1024 * 1024;
const ANTIGRAVITY_MANIFEST_TIMEOUT_MS = 30_000;
const ANTIGRAVITY_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const ANTIGRAVITY_PROBE_TIMEOUT_MS = 20_000;
const TAR_BLOCK_BYTES = 512;
const TAR_META_MAX_BYTES = 64 * 1024;

export type AntigravityPlatformKey =
  | "windows_amd64"
  | "windows_arm64"
  | "darwin_arm64"
  | "darwin_amd64"
  | "linux_amd64"
  | "linux_arm64"
  | "linux_amd64_musl"
  | "linux_arm64_musl";

export interface AntigravityReleaseManifest {
  readonly version: string;
  readonly url: string;
  readonly sha512: string;
}

export function supportsAntigravityInstall(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): boolean {
  return (
    (platform === "win32" || platform === "darwin" || platform === "linux") &&
    (arch === "x64" || arch === "arm64")
  );
}

export function antigravityManifestUrl(platformKey: AntigravityPlatformKey): string {
  return `${ANTIGRAVITY_MANIFEST_ORIGIN}/manifests/${platformKey}.json`;
}

async function defaultPathExists(filePath: string): Promise<boolean> {
  try {
    await FS.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Resolves the manifest key matching the official `install.ps1` / `install.sh` rules. */
export async function resolveAntigravityPlatformKey(input: {
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly pathExists?: (filePath: string) => Promise<boolean> | boolean;
}): Promise<AntigravityPlatformKey | null> {
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const env = input.env ?? process.env;
  if (platform === "win32") {
    const nativeArch = (env.PROCESSOR_ARCHITEW6432 || env.PROCESSOR_ARCHITECTURE || "").trim();
    if (/^arm64$/iu.test(nativeArch) || (!nativeArch && arch === "arm64")) {
      return "windows_arm64";
    }
    if (/^amd64$/iu.test(nativeArch) || arch === "x64") {
      return "windows_amd64";
    }
    if (arch === "arm64") return "windows_arm64";
    return null;
  }
  if (platform === "darwin") {
    if (arch === "arm64") return "darwin_arm64";
    if (arch === "x64") return "darwin_amd64";
    return null;
  }
  if (platform === "linux") {
    if (arch !== "x64" && arch !== "arm64") return null;
    const goArch = arch === "x64" ? "amd64" : "arm64";
    const pathExists = input.pathExists ?? defaultPathExists;
    const muslLoader =
      arch === "x64" ? "/lib/libc.musl-x86_64.so.1" : "/lib/libc.musl-aarch64.so.1";
    const isMusl = await pathExists(muslLoader);
    return (isMusl ? `linux_${goArch}_musl` : `linux_${goArch}`) as AntigravityPlatformKey;
  }
  return null;
}

export function parseAntigravityManifest(raw: unknown): AntigravityReleaseManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Antigravity release manifest is not an object.");
  }
  const record = raw as { version?: unknown; url?: unknown; sha512?: unknown };
  const version = typeof record.version === "string" ? record.version.trim() : "";
  const urlString = typeof record.url === "string" ? record.url.trim() : "";
  const sha512 = typeof record.sha512 === "string" ? record.sha512.trim().toLowerCase() : "";
  if (!version || !/^[0-9][0-9A-Za-z.+-]{0,63}$/u.test(version)) {
    throw new Error("Antigravity release manifest has an invalid version.");
  }
  if (!/^[0-9a-f]{128}$/u.test(sha512)) {
    throw new Error("Antigravity release manifest has an invalid SHA-512 checksum.");
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlString);
  } catch {
    throw new Error("Antigravity release manifest has an invalid download URL.");
  }
  if (
    parsedUrl.protocol !== "https:" ||
    !(ANTIGRAVITY_DOWNLOAD_ORIGINS as ReadonlyArray<string>).includes(parsedUrl.origin)
  ) {
    throw new Error("Antigravity release manifest points to an untrusted origin.");
  }
  if (
    parsedUrl.origin === "https://storage.googleapis.com" &&
    !parsedUrl.pathname.startsWith("/antigravity-public/antigravity-cli/")
  ) {
    throw new Error("Antigravity release manifest points outside the official bucket path.");
  }
  return { version, url: parsedUrl.href, sha512 };
}

async function fetchManifest(
  platformKey: AntigravityPlatformKey,
  env: NodeJS.ProcessEnv,
): Promise<AntigravityReleaseManifest> {
  const url = antigravityManifestUrl(platformKey);
  const proxyUrl = resolveOutboundProxyUrl(url, withOutboundProxyEnv(env));
  const response = await outboundHttp.request({
    url,
    policy: {
      service: "moss-agent-install-antigravity-manifest",
      allowedOrigins: [ANTIGRAVITY_MANIFEST_ORIGIN],
      timeoutMs: ANTIGRAVITY_MANIFEST_TIMEOUT_MS,
      maxRequestBytes: 0,
      maxResponseBytes: ANTIGRAVITY_MANIFEST_MAX_BYTES,
      maxRedirects: 0,
      maxConcurrent: 1,
      maxQueued: 2,
      allowBenchmarkAddressRange: true,
      ...(proxyUrl ? { proxyUrl } : {}),
    },
  });
  if (response.status !== 200) {
    throw new Error(`Antigravity manifest answered ${response.status}.`);
  }
  return parseAntigravityManifest(decodeOutboundJson(response, { maxDepth: 4, maxNodes: 32 }));
}

async function writeBufferFully(handle: FS.FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (written.bytesWritten <= 0) {
      throw new Error("Short write while saving Antigravity download.");
    }
    offset += written.bytesWritten;
  }
}

async function downloadPayloadToFile(
  url: string,
  destinationPath: string,
  env: NodeJS.ProcessEnv,
): Promise<{ readonly sha512: string; readonly bytes: number }> {
  const proxyUrl = resolveOutboundProxyUrl(url, withOutboundProxyEnv(env));
  const hash = createHash("sha512");
  let bytes = 0;
  const handle = await FS.open(destinationPath, "wx");
  try {
    const response = await outboundHttp.request({
      url,
      policy: {
        service: "moss-agent-install-antigravity",
        allowedOrigins: [...ANTIGRAVITY_DOWNLOAD_ORIGINS],
        timeoutMs: ANTIGRAVITY_DOWNLOAD_TIMEOUT_MS,
        maxRequestBytes: 0,
        maxResponseBytes: ANTIGRAVITY_PAYLOAD_MAX_BYTES,
        maxRedirects: 0,
        maxConcurrent: 1,
        maxQueued: 2,
        allowBenchmarkAddressRange: true,
        ...(proxyUrl ? { proxyUrl } : {}),
      },
      onChunk: async (chunk) => {
        hash.update(chunk);
        bytes += chunk.byteLength;
        await writeBufferFully(handle, chunk);
      },
    });
    if (response.status !== 200) {
      throw new Error(`Antigravity download answered ${response.status}.`);
    }
    return { sha512: hash.digest("hex").toLowerCase(), bytes };
  } finally {
    await handle.close();
  }
}

function unwrapInstallError(cause: unknown): unknown {
  let current = cause;
  for (let depth = 0; depth < 4; depth += 1) {
    if (
      current instanceof Error &&
      current.name === "UnknownException" &&
      "cause" in current &&
      current.cause !== undefined
    ) {
      current = current.cause;
      continue;
    }
    break;
  }
  return current;
}

function formatAntigravityInstallError(cause: unknown): string {
  const unwrapped = unwrapInstallError(cause);
  if (unwrapped instanceof OutboundHttpError) {
    const inner =
      unwrapped.cause instanceof Error
        ? unwrapped.cause.message.trim() || (unwrapped.cause as NodeJS.ErrnoException).code
        : undefined;
    return inner
      ? `${unwrapped.message} (${unwrapped.code}: ${inner})`
      : `${unwrapped.message} (${unwrapped.code})`;
  }
  return unwrapped instanceof Error ? unwrapped.message : String(unwrapped);
}

function isRetryableAntigravityDownloadError(cause: unknown): boolean {
  const unwrapped = unwrapInstallError(cause);
  return unwrapped instanceof OutboundHttpError && unwrapped.code === "request";
}

function readTarString(block: Uint8Array, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return Buffer.from(end >= 0 ? slice.subarray(0, end) : slice).toString("utf8");
}

function parsePaxPath(data: Uint8Array): string | undefined {
  const text = Buffer.from(data).toString("utf8");
  for (const record of text.split("\n")) {
    const match = /^\d+ path=(.*)$/u.exec(record);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function normalizeTarEntryName(rawPath: string): string | null {
  const normalized = rawPath.replace(/^\.\/+/u, "").replace(/\/+$/u, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    normalized.includes("\0")
  ) {
    return null;
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return null;
  }
  return normalized;
}

/**
 * Streams a `.tar.gz` release archive and extracts only the standalone `antigravity`
 * (or `agy`) regular-file binary directly to `destinationPath` without buffering the
 * archive in memory.
 */
export async function extractAntigravityBinaryFromTarGz(
  archivePath: string,
  destinationPath: string,
): Promise<number> {
  const gunzip = createGunzip();
  const source = createReadStream(archivePath);
  source.on("error", (error) => gunzip.destroy(error));
  source.pipe(gunzip);

  type Mode = "header" | "file" | "meta-pax" | "meta-gnu" | "skip";
  let mode: Mode = "header";
  let headerBuf = Buffer.alloc(0);
  let metaChunks: Uint8Array[] = [];
  let remaining = 0;
  let padBytes = 0;
  let pendingPath: string | undefined;
  let extractedBytes = 0;
  let extracted = false;
  let outputHandle: FS.FileHandle | null = null;

  const finishEntry = async () => {
    if (mode === "file" && outputHandle) {
      await outputHandle.close();
      outputHandle = null;
      extracted = true;
    } else if (mode === "meta-pax") {
      pendingPath = parsePaxPath(Buffer.concat(metaChunks));
      metaChunks = [];
    } else if (mode === "meta-gnu") {
      const merged = Buffer.concat(metaChunks);
      pendingPath = readTarString(merged, 0, merged.length);
      metaChunks = [];
    }
    mode = "header";
  };

  try {
    for await (const rawChunk of gunzip) {
      let chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      let cursor = 0;
      while (cursor < chunk.length) {
        if (mode === "header") {
          const needed = TAR_BLOCK_BYTES - headerBuf.length;
          const take = Math.min(needed, chunk.length - cursor);
          headerBuf =
            headerBuf.length === 0 && take === TAR_BLOCK_BYTES
              ? chunk.subarray(cursor, cursor + take)
              : Buffer.concat([headerBuf, chunk.subarray(cursor, cursor + take)]);
          cursor += take;
          if (headerBuf.length < TAR_BLOCK_BYTES) continue;

          const header = headerBuf;
          headerBuf = Buffer.alloc(0);
          if (header.every((byte) => byte === 0)) {
            source.destroy();
            gunzip.destroy();
            if (!extracted) {
              throw new Error("Antigravity archive did not contain the CLI binary.");
            }
            return extractedBytes;
          }
          const name = readTarString(header, 0, 100);
          const rawSize = readTarString(header, 124, 12).trim();
          const size = rawSize ? Number.parseInt(rawSize, 8) : 0;
          if (!Number.isSafeInteger(size) || size < 0) {
            throw new Error("Antigravity archive contains an invalid entry size.");
          }
          const type = String.fromCharCode(header[156] ?? 0);
          const prefix = readTarString(header, 257, 6).startsWith("ustar")
            ? readTarString(header, 345, 155)
            : "";
          const pad = (TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;

          if (type === "x" || type === "L") {
            if (size > TAR_META_MAX_BYTES) {
              throw new Error("Antigravity archive metadata entry exceeds limit.");
            }
            mode = type === "x" ? "meta-pax" : "meta-gnu";
            metaChunks = [];
            remaining = size;
            padBytes = pad;
            if (remaining === 0 && padBytes === 0) await finishEntry();
            continue;
          }
          if (type === "g") {
            mode = "skip";
            remaining = size + pad;
            padBytes = 0;
            if (remaining === 0) mode = "header";
            continue;
          }

          const rawEntryPath = pendingPath ?? (prefix ? `${prefix}/${name}` : name);
          pendingPath = undefined;
          const entryName = normalizeTarEntryName(rawEntryPath);
          const isRegularFile = type === "0" || type === "\0" || type === "7";
          if (isRegularFile && (entryName === "antigravity" || entryName === "agy") && !extracted) {
            if (size === 0 || size > ANTIGRAVITY_EXTRACTED_MAX_BYTES) {
              throw new Error("Antigravity archive binary size is out of bounds.");
            }
            outputHandle = await FS.open(destinationPath, "wx", 0o755);
            mode = "file";
            remaining = size;
            padBytes = pad;
          } else {
            mode = "skip";
            remaining = size + pad;
            padBytes = 0;
            if (remaining === 0) mode = "header";
          }
          continue;
        }

        if (remaining > 0) {
          const take = Math.min(remaining, chunk.length - cursor);
          const slice = chunk.subarray(cursor, cursor + take);
          cursor += take;
          remaining -= take;
          if (mode === "file" && outputHandle) {
            await writeBufferFully(outputHandle, slice);
            extractedBytes += slice.byteLength;
          } else if (mode === "meta-pax" || mode === "meta-gnu") {
            metaChunks.push(Buffer.from(slice));
          }
        }
        if (remaining === 0 && padBytes > 0 && cursor < chunk.length) {
          const skip = Math.min(padBytes, chunk.length - cursor);
          cursor += skip;
          padBytes -= skip;
        }
        if (remaining === 0 && padBytes === 0) {
          await finishEntry();
        }
      }
    }
  } finally {
    if (outputHandle) {
      await outputHandle.close();
    }
    source.destroy();
  }

  if (!extracted || extractedBytes <= 0) {
    throw new Error("Antigravity archive did not contain the CLI binary.");
  }
  return extractedBytes;
}

async function ordinaryDirectory(directory: string): Promise<void> {
  await FS.mkdir(directory, { recursive: true });
  const info = await FS.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Agent install directory is linked or not a directory.");
  }
}

async function ensureReplaceableTargetFile(filePath: string): Promise<void> {
  try {
    const info = await FS.lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("Existing Antigravity target path is linked or not a regular file.");
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
}

function probeEnvironment(
  env: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (
      /^(SystemRoot|SystemDrive|windir|ComSpec|PATHEXT|PATH|OS|PROCESSOR_.*|NUMBER_OF_PROCESSORS|ProgramFiles.*|CommonProgramFiles.*|LANG|LC_.*|TERM)$/iu.test(
        name,
      )
    ) {
      clean[name] = value;
    }
  }
  return {
    ...clean,
    HOME: home,
    USERPROFILE: home,
    ...(platform === "win32"
      ? {
          APPDATA: Path.join(home, "AppData", "Roaming"),
          LOCALAPPDATA: Path.join(home, "AppData", "Local"),
        }
      : {
          XDG_CONFIG_HOME: Path.join(home, ".config"),
          XDG_CACHE_HOME: Path.join(home, ".cache"),
        }),
    TEMP: home,
    TMP: home,
    TMPDIR: home,
    NO_BROWSER: "true",
    AGY_CLI_DISABLE_AUTO_UPDATE: "true",
  };
}

function cleanupUnproven(): AgentInstallOutcome {
  return {
    ok: false,
    reason: "cleanup-unproven",
    detail:
      "Antigravity probe cleanup is unproven; staging was retained when present. Restart Moss before retrying.",
  };
}

export const runAntigravityInstall = Effect.fn("runAntigravityInstall")(function* (input: {
  readonly mossHomeDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  /** Test seams. */
  readonly run?: AgentInstallCommandRunner;
  readonly pathExists?: (filePath: string) => Promise<boolean> | boolean;
  readonly fetchManifest?: (
    platformKey: AntigravityPlatformKey,
  ) => Promise<AntigravityReleaseManifest>;
  readonly downloadPayload?: (
    url: string,
    destinationPath: string,
  ) => Promise<{ readonly sha512: string; readonly bytes: number }>;
  readonly onProgress?: (progress: {
    readonly phase: "installing" | "verifying";
    readonly source: "official";
  }) => Effect.Effect<void>;
  readonly onCleanupUnproven?: Effect.Effect<void>;
}) {
  const platform = input.platform ?? process.platform;
  const architecture = input.architecture ?? process.arch;
  let phase: "installing" | "verifying" = "installing";
  let cleanupSafe = true;

  const run =
    input.run ??
    makeNativeAgentInstallProbe(
      Effect.gen(function* () {
        cleanupSafe = false;
        yield* input.onCleanupUnproven ?? Effect.void;
      }),
      { timeoutMs: ANTIGRAVITY_PROBE_TIMEOUT_MS },
    );

  const work = Effect.gen(function* () {
    const platformKey = yield* Effect.tryPromise(() =>
      resolveAntigravityPlatformKey({
        platform,
        arch: architecture,
        env: input.env,
        ...(input.pathExists ? { pathExists: input.pathExists } : {}),
      }),
    );
    if (!platformKey) {
      return {
        ok: false,
        reason: "not-installable",
        detail: `Antigravity CLI has no native package for ${platform}/${architecture}.`,
      } satisfies AgentInstallOutcome;
    }

    const prefix = managedAgentInstallPrefix(input.mossHomeDir);
    const binDirectory = managedAgentBinDirectory(prefix, platform);
    const metadataRoot = Path.join(prefix, "antigravity");
    const binaryName = antigravityBinaryName(platform);
    const targetBinary = Path.join(binDirectory, binaryName);

    yield* Effect.tryPromise(async () => {
      await ordinaryDirectory(prefix);
      await ordinaryDirectory(binDirectory);
      await ordinaryDirectory(metadataRoot);
      await ensureReplaceableTargetFile(targetBinary);
    }).pipe(Effect.uninterruptible);

    const staging = yield* Effect.acquireRelease(
      Effect.tryPromise(() => FS.mkdtemp(Path.join(metadataRoot, ".partial-"))),
      (directory) =>
        Effect.gen(function* () {
          if (!cleanupSafe) return;
          yield* Effect.tryPromise(async () => {
            if (
              Path.dirname(directory) !== metadataRoot ||
              !Path.basename(directory).startsWith(".partial-")
            ) {
              throw new Error("Invalid Antigravity staging cleanup path.");
            }
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

    yield* input.onProgress?.({ phase: "installing", source: "official" }) ?? Effect.void;
    const manifest = yield* Effect.tryPromise({
      try: () =>
        input.fetchManifest
          ? input.fetchManifest(platformKey)
          : fetchManifest(platformKey, input.env),
      catch: (cause) => cause,
    });
    const validatedManifest = parseAntigravityManifest(manifest);

    const isTarGz = /\.tar\.gz(?:$|\?)/iu.test(validatedManifest.url);
    const stagedDownload = Path.join(staging, isTarGz ? "agy.tar.gz" : binaryName);
    const stagedBinary = Path.join(staging, binaryName);
    const downloadAttempt = () =>
      Effect.tryPromise({
        try: () =>
          input.downloadPayload
            ? input.downloadPayload(validatedManifest.url, stagedDownload)
            : downloadPayloadToFile(validatedManifest.url, stagedDownload, input.env),
        catch: (cause) => cause,
      });
    const download = yield* downloadAttempt().pipe(
      Effect.catch((firstCause) => {
        if (!isRetryableAntigravityDownloadError(firstCause)) {
          return Effect.fail(firstCause);
        }
        return Effect.tryPromise({
          try: () => FS.rm(stagedDownload, { force: true }),
          catch: (cause) => cause,
        }).pipe(Effect.andThen(downloadAttempt()));
      }),
    );
    if (download.sha512.toLowerCase() !== validatedManifest.sha512.toLowerCase()) {
      return {
        ok: false,
        reason: "download-failed",
        detail: "Antigravity download SHA-512 checksum did not match the release manifest.",
      } satisfies AgentInstallOutcome;
    }

    if (isTarGz) {
      yield* Effect.tryPromise(() =>
        extractAntigravityBinaryFromTarGz(stagedDownload, stagedBinary),
      ).pipe(Effect.uninterruptible);
    }

    const probeHome = Path.join(staging, ".probe-profile");
    yield* Effect.tryPromise(async () => {
      if (platform !== "win32") {
        await FS.chmod(stagedBinary, 0o755);
      }
      await ordinaryDirectory(probeHome);
      if (platform === "win32") {
        await ordinaryDirectory(Path.join(probeHome, "AppData", "Roaming"));
        await ordinaryDirectory(Path.join(probeHome, "AppData", "Local"));
      }
    }).pipe(Effect.uninterruptible);

    phase = "verifying";
    yield* input.onProgress?.({ phase: "verifying", source: "official" }) ?? Effect.void;
    const verify = yield* run({
      command: stagedBinary,
      args: ["--version"],
      env: probeEnvironment(input.env, probeHome, platform),
    }).pipe(Effect.timeoutOption(Duration.millis(ANTIGRAVITY_PROBE_TIMEOUT_MS)));
    if (!cleanupSafe) return cleanupUnproven();
    if (Option.isNone(verify) || Option.isNone(verify.value)) {
      return {
        ok: false,
        reason: "timed-out",
        detail: "Antigravity CLI version probe timed out.",
      } satisfies AgentInstallOutcome;
    }
    const probeResult = verify.value.value;
    const verifiedVersion =
      probeResult.exitCode === 0
        ? parseGenericCliVersion(`${probeResult.stdout}\n${probeResult.stderr}`)
        : null;
    if (
      !verifiedVersion ||
      compareSemverVersions(verifiedVersion, MINIMUM_ANTIGRAVITY_CLI_VERSION) < 0
    ) {
      return {
        ok: false,
        reason: "verify-failed",
        detail: verifiedVersion
          ? `Downloaded Antigravity CLI ${verifiedVersion} is older than ${MINIMUM_ANTIGRAVITY_CLI_VERSION}.`
          : "Downloaded Antigravity CLI did not report a usable version.",
      } satisfies AgentInstallOutcome;
    }

    yield* Effect.tryPromise(async () => {
      await FS.rm(probeHome, { recursive: true, force: true });
      await ensureReplaceableTargetFile(targetBinary);
      await FS.rename(stagedBinary, targetBinary);
      if (platform !== "win32") {
        await FS.chmod(targetBinary, 0o755);
      }
      const metadataPath = Path.join(metadataRoot, ANTIGRAVITY_INSTALL_METADATA_FILE);
      await ensureReplaceableTargetFile(metadataPath);
      const pendingMetadata = Path.join(metadataRoot, `.source-${randomUUID()}.json`);
      try {
        await FS.writeFile(
          pendingMetadata,
          JSON.stringify(
            {
              schemaVersion: 1,
              provider: "antigravity",
              version: verifiedVersion,
              manifestVersion: validatedManifest.version,
              platform: platformKey,
              url: validatedManifest.url,
              payloadSha512: validatedManifest.sha512,
              payloadBytes: download.bytes,
              receivedAt: new Date().toISOString(),
            },
            null,
            2,
          ),
          { flag: "wx" },
        );
        await FS.rename(pendingMetadata, metadataPath);
      } finally {
        await FS.rm(pendingMetadata, { force: true });
      }
    }).pipe(Effect.uninterruptible);

    return {
      ok: true,
      version: verifiedVersion,
      source: "official",
      binDirectory,
    } satisfies AgentInstallOutcome;
  }).pipe(Effect.scoped);

  const outcome = yield* work.pipe(
    Effect.catch((cause) => {
      const unwrapped = unwrapInstallError(cause);
      const timedOut = unwrapped instanceof OutboundHttpError && unwrapped.code === "timeout";
      return Effect.succeed({
        ok: false,
        reason: timedOut
          ? "timed-out"
          : phase === "verifying"
            ? "verify-failed"
            : "download-failed",
        detail: formatAntigravityInstallError(unwrapped),
      } satisfies AgentInstallOutcome);
    }),
  );
  return cleanupSafe ? outcome : cleanupUnproven();
});
