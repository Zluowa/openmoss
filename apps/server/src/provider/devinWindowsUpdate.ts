// FILE: devinWindowsUpdate.ts
// Purpose: Native in-app updater for Windows Devin installs (`irm | iex`), replacing
//          Devin's Windows no-op self-update command with a SHA-256-verified ZIP download
//          and Windows-safe `.old`/`.new` binary swap.
// Layer: Provider maintenance (server).

import { createHash, randomUUID } from "node:crypto";
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import {
  outboundHttp,
  OutboundHttpError,
  resolveOutboundProxyUrl,
} from "@moss/shared/outboundHttp";
import type { OutboundHttpRequest, OutboundHttpResponse } from "@moss/shared/outboundHttp";
import { withOutboundProxyEnv } from "@moss/shared/outboundProxy";

import { executableCandidates, hasPathSeparator } from "../executableLookup.ts";
import { extractAgentZip } from "./agentInstallZip.ts";

export const DEVIN_WINDOWS_MANUAL_UPDATE_COMMAND = "irm https://cli.devin.ai/install.ps1 | iex";

/**
 * The update dialog's one sentence for a failed Devin update, from the reasons Moss already
 * words for every agent; the updater's own text goes to the server log only.
 */
export function devinWindowsUpdateFailureReason(
  failure: unknown,
): "timed-out" | "verify-failed" | "download-failed" | "disk-full" {
  if (failure === "timed-out") return "timed-out";
  const detail = failure instanceof Error ? failure.message : String(failure);
  if (/\bENOSPC\b|no space left|not enough space|disk (?:is )?full/iu.test(detail)) {
    return "disk-full";
  }
  if (/did not contain bin\/devin\.exe|could not locate the installed devin/iu.test(detail)) {
    return "verify-failed";
  }
  return "download-failed";
}
export const DEVIN_STATIC_ORIGIN = "https://static.devin.ai";
const DEVIN_MANIFEST_BASE_URL = `${DEVIN_STATIC_ORIGIN}/cli/current`;
const DEVIN_MANIFEST_MAX_BYTES = 2 * 1024 * 1024;
const DEVIN_ARCHIVE_MAX_BYTES = 350 * 1024 * 1024;
const DEVIN_BINARY_MAX_BYTES = 450 * 1024 * 1024;
const DEVIN_EXPANDED_MAX_BYTES = 640 * 1024 * 1024;
export const DEVIN_MANIFEST_TIMEOUT_MS = 30_000;
export const DEVIN_CHUNK_TIMEOUT_MS = 180_000;
export const DEVIN_FULL_ARCHIVE_TIMEOUT_MS = 15 * 60_000;
export const DEVIN_RANGE_CHUNK_BYTES = 4 * 1024 * 1024;
export const DEVIN_RANGE_CONCURRENCY = 4;
export const DEVIN_HTTP_MAX_ATTEMPTS = 3;

export type DevinWindowsTargetTriple = "aarch64-pc-windows" | "x86_64-pc-windows";
export type DevinHttpRequester = (request: OutboundHttpRequest) => Promise<OutboundHttpResponse>;

export interface DevinWindowsUpdateInput {
  readonly binaryPath: string;
  readonly arch?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam for offline manifest & ZIP verification. */
  readonly fetchBytes?: (url: string, maxBytes: number) => Promise<Uint8Array>;
  /** Test seam for exercising chunked HTTP range & retry behavior. */
  readonly httpRequest?: DevinHttpRequester;
  /** Test seam for simulating rename failure during swap. */
  readonly renameFile?: (from: string, to: string) => Promise<void>;
}

export interface DevinWindowsUpdateResult {
  readonly version: string;
  readonly targetPath: string;
  readonly triple: DevinWindowsTargetTriple;
  readonly output: string;
}

export function resolveDevinWindowsTargetTriple(
  arch: string = process.arch,
): DevinWindowsTargetTriple {
  return arch === "arm64" ? "aarch64-pc-windows" : "x86_64-pc-windows";
}

export function manifestUrlForDevinDistribution(distribution: string | null | undefined): string {
  const normalized = distribution?.trim();
  if (normalized === "enterprise-portal") {
    throw new Error(
      "This Devin CLI installation is managed by an enterprise portal and must be updated through that portal.",
    );
  }
  switch (normalized) {
    case "irm-iex-enterprise":
      return `${DEVIN_MANIFEST_BASE_URL}/manifest-enterprise.json`;
    case "irm-iex-windsurfcom":
      return `${DEVIN_MANIFEST_BASE_URL}/manifest-windsurfcom.json`;
    case "irm-iex-federal":
      return `${DEVIN_MANIFEST_BASE_URL}/manifest-federal.json`;
    default:
      return `${DEVIN_MANIFEST_BASE_URL}/manifest.json`;
  }
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    return (await FS.stat(targetPath)).isFile();
  } catch {
    return false;
  }
}

async function dirExists(targetPath: string): Promise<boolean> {
  try {
    return (await FS.stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}

async function resolveTargetExecutablePath(
  binaryPath: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const trimmed = binaryPath.trim();
  if (trimmed && hasPathSeparator(trimmed)) {
    return Path.win32.isAbsolute(trimmed) ? trimmed : Path.resolve(trimmed);
  }
  const commandName = trimmed || "devin";
  for (const candidate of executableCandidates(commandName, { platform: "win32", env })) {
    if (await fileExists(candidate.path)) {
      return candidate.path;
    }
  }
  const localAppData = env.LOCALAPPDATA?.trim();
  if (localAppData) {
    const defaultExe = Path.win32.join(localAppData, "devin", "cli", "bin", "devin.exe");
    if (await fileExists(defaultExe)) {
      return defaultExe;
    }
  }
  throw new Error("Could not locate the installed Devin executable to update on Windows.");
}

function resolveInstallRoot(targetExecutablePath: string): string {
  const binDir = Path.dirname(targetExecutablePath);
  return Path.basename(binDir).toLowerCase() === "bin" ? Path.dirname(binDir) : binDir;
}

async function readDistributionMarker(installRoot: string): Promise<string | null> {
  try {
    const raw = await FS.readFile(Path.join(installRoot, "distribution"), "utf8");
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

const defaultHttpRequest: DevinHttpRequester = (request) => outboundHttp.request(request);

async function defaultRetryDelay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

class DevinNonRetryableError extends Error {}

class DevinHttpStatusError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

class DevinRangeUnsupportedError extends Error {}

function assertTrustedDevinStaticUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DevinNonRetryableError(`Invalid Devin update URL: ${url}`);
  }
  if (parsed.protocol !== "https:" || parsed.origin !== DEVIN_STATIC_ORIGIN) {
    throw new DevinNonRetryableError(`Rejected untrusted Devin update origin: ${parsed.origin}`);
  }
  return parsed;
}

function resolveDevinProxyUrl(url: string, env: NodeJS.ProcessEnv): string | undefined {
  return resolveOutboundProxyUrl(url, withOutboundProxyEnv(env));
}

function isRetryableDevinHttpError(cause: unknown): boolean {
  if (cause instanceof DevinNonRetryableError || cause instanceof DevinRangeUnsupportedError) {
    return false;
  }
  if (cause instanceof DevinHttpStatusError) {
    return cause.status === 408 || cause.status === 429 || cause.status >= 500;
  }
  if (cause instanceof OutboundHttpError) {
    return (
      cause.code !== "aborted" &&
      cause.code !== "invalid-redirect" &&
      cause.code !== "request-too-large" &&
      cause.code !== "response-too-large"
    );
  }
  return true;
}

async function retryDevinHttp<T>(
  run: () => Promise<T>,
  maxAttempts: number = DEVIN_HTTP_MAX_ATTEMPTS,
  delayFn: (ms: number) => Promise<void> = defaultRetryDelay,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await run();
    } catch (cause) {
      lastError = cause;
      if (attempt >= maxAttempts || !isRetryableDevinHttpError(cause)) {
        throw cause;
      }
      await delayFn(1_000 * attempt);
    }
  }
  throw lastError;
}

async function fetchDevinManifestBytes(
  url: string,
  maxBytes: number,
  env: NodeJS.ProcessEnv,
  httpRequest: DevinHttpRequester,
  delayFn: (ms: number) => Promise<void> = defaultRetryDelay,
): Promise<Uint8Array> {
  assertTrustedDevinStaticUrl(url);
  const proxyUrl = resolveDevinProxyUrl(url, env);
  return await retryDevinHttp(
    async () => {
      const response = await httpRequest({
        url,
        headers: { "accept-encoding": "identity" },
        policy: {
          service: "moss-devin-windows-update",
          allowedOrigins: [DEVIN_STATIC_ORIGIN],
          timeoutMs: DEVIN_MANIFEST_TIMEOUT_MS,
          maxRequestBytes: 0,
          maxResponseBytes: maxBytes,
          maxRedirects: 2,
          maxConcurrent: 2,
          maxQueued: 2,
          // Fake-IP proxies (Clash, Surge) hand out 198.18.0.0/15 for proxied hosts.
          allowBenchmarkAddressRange: true,
          ...(proxyUrl ? { proxyUrl } : {}),
        },
      });
      if (response.status < 200 || response.status >= 300) {
        throw new DevinHttpStatusError(
          response.status,
          `Devin update server answered HTTP ${response.status} for ${url}`,
        );
      }
      return response.body;
    },
    DEVIN_HTTP_MAX_ATTEMPTS,
    delayFn,
  );
}

function parseHeadContentLength(headers: Headers): number | null {
  const raw = headers.get("content-length")?.trim();
  if (!raw || !/^\d+$/u.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function acceptsByteRanges(headers: Headers): boolean {
  const raw = headers.get("accept-ranges");
  return typeof raw === "string" && raw.toLowerCase().includes("bytes");
}

function copyBytesIntoBuffer(bytes: Uint8Array, destination: Buffer, offset: number): void {
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).copy(destination, offset);
}

/**
 * Downloads the Devin Windows ZIP archive from `static.devin.ai`. Uses 4-way
 * concurrent 4 MiB HTTP Range requests when `HEAD` advertises `Accept-Ranges: bytes`
 * and a valid `Content-Length` (bypassing single-stream proxy bottlenecks), and falls
 * back transparently to a single bounded `GET` when range requests are unavailable.
 */
export async function downloadDevinArchiveBytes(
  url: string,
  maxBytes: number,
  env: NodeJS.ProcessEnv = process.env,
  httpRequest: DevinHttpRequester = defaultHttpRequest,
  options?: { readonly delayMs?: (ms: number) => Promise<void> },
): Promise<Uint8Array> {
  assertTrustedDevinStaticUrl(url);
  const proxyUrl = resolveDevinProxyUrl(url, env);
  const delayFn = options?.delayMs ?? defaultRetryDelay;

  let contentLength: number | null = null;
  let rangeSupported = false;
  try {
    const headResponse = await httpRequest({
      url,
      method: "HEAD",
      headers: { "accept-encoding": "identity" },
      policy: {
        service: "moss-devin-windows-update",
        allowedOrigins: [DEVIN_STATIC_ORIGIN],
        timeoutMs: DEVIN_MANIFEST_TIMEOUT_MS,
        maxRequestBytes: 0,
        maxResponseBytes: 0,
        maxRedirects: 2,
        maxConcurrent: 2,
        maxQueued: 2,
        allowBenchmarkAddressRange: true,
        ...(proxyUrl ? { proxyUrl } : {}),
      },
    });
    if (headResponse.status >= 200 && headResponse.status < 300) {
      contentLength = parseHeadContentLength(headResponse.headers);
      if (contentLength !== null && contentLength > maxBytes) {
        throw new DevinNonRetryableError(
          `Devin update archive (${contentLength} bytes) exceeds the ${maxBytes}-byte limit.`,
        );
      }
      rangeSupported = acceptsByteRanges(headResponse.headers);
    }
  } catch (cause) {
    if (cause instanceof DevinNonRetryableError) {
      throw cause;
    }
    contentLength = null;
    rangeSupported = false;
  }

  const fetchRangeChunk = async (
    start: number,
    end: number,
    treatNon206AsUnsupported: boolean,
  ): Promise<Uint8Array> => {
    const expectedLength = end - start + 1;
    return await retryDevinHttp(
      async () => {
        let response: OutboundHttpResponse;
        try {
          response = await httpRequest({
            url,
            method: "GET",
            headers: {
              "accept-encoding": "identity",
              range: `bytes=${start}-${end}`,
            },
            policy: {
              service: "moss-devin-windows-update-chunk",
              allowedOrigins: [DEVIN_STATIC_ORIGIN],
              timeoutMs: DEVIN_CHUNK_TIMEOUT_MS,
              maxRequestBytes: 0,
              maxResponseBytes: DEVIN_RANGE_CHUNK_BYTES + 1024,
              maxRedirects: 2,
              maxConcurrent: 6,
              maxQueued: 32,
              allowBenchmarkAddressRange: true,
              ...(proxyUrl ? { proxyUrl } : {}),
            },
          });
        } catch (cause) {
          if (
            treatNon206AsUnsupported &&
            cause instanceof OutboundHttpError &&
            cause.code === "response-too-large"
          ) {
            throw new DevinRangeUnsupportedError("Server ignored HTTP Range header.");
          }
          throw cause;
        }
        if (response.status !== 206) {
          if (treatNon206AsUnsupported && response.status >= 200 && response.status < 300) {
            throw new DevinRangeUnsupportedError(`Expected HTTP 206, received ${response.status}.`);
          }
          throw new DevinHttpStatusError(
            response.status,
            `Devin update chunk bytes=${start}-${end} answered HTTP ${response.status} for ${url}`,
          );
        }
        if (response.body.byteLength !== expectedLength) {
          if (treatNon206AsUnsupported) {
            throw new DevinRangeUnsupportedError(
              `Expected ${expectedLength} bytes for initial chunk, received ${response.body.byteLength}.`,
            );
          }
          throw new Error(
            `Devin update chunk bytes=${start}-${end} returned ${response.body.byteLength} bytes, expected ${expectedLength}.`,
          );
        }
        return response.body;
      },
      DEVIN_HTTP_MAX_ATTEMPTS,
      delayFn,
    );
  };

  if (rangeSupported && contentLength !== null && contentLength > DEVIN_RANGE_CHUNK_BYTES) {
    let chunk0: Uint8Array | null = null;
    try {
      chunk0 = await fetchRangeChunk(0, DEVIN_RANGE_CHUNK_BYTES - 1, true);
    } catch (cause) {
      if (!(cause instanceof DevinRangeUnsupportedError)) {
        throw cause;
      }
    }

    if (chunk0 !== null) {
      const archive = Buffer.allocUnsafe(contentLength);
      copyBytesIntoBuffer(chunk0, archive, 0);

      const remainingRanges: Array<readonly [number, number]> = [];
      for (
        let offset = DEVIN_RANGE_CHUNK_BYTES;
        offset < contentLength;
        offset += DEVIN_RANGE_CHUNK_BYTES
      ) {
        const end = Math.min(contentLength - 1, offset + DEVIN_RANGE_CHUNK_BYTES - 1);
        remainingRanges.push([offset, end]);
      }

      let nextIndex = 0;
      const workerCount = Math.min(DEVIN_RANGE_CONCURRENCY, remainingRanges.length);
      await Promise.all(
        Array.from({ length: workerCount }, async () => {
          while (nextIndex < remainingRanges.length) {
            const range = remainingRanges[nextIndex];
            nextIndex += 1;
            if (!range) continue;
            const [start, end] = range;
            const chunk = await fetchRangeChunk(start, end, false);
            copyBytesIntoBuffer(chunk, archive, start);
          }
        }),
      );
      return archive;
    }
  }

  return await retryDevinHttp(
    async () => {
      const response = await httpRequest({
        url,
        method: "GET",
        headers: { "accept-encoding": "identity" },
        policy: {
          service: "moss-devin-windows-update",
          allowedOrigins: [DEVIN_STATIC_ORIGIN],
          timeoutMs: DEVIN_FULL_ARCHIVE_TIMEOUT_MS,
          maxRequestBytes: 0,
          maxResponseBytes: maxBytes,
          maxRedirects: 2,
          maxConcurrent: 2,
          maxQueued: 2,
          allowBenchmarkAddressRange: true,
          ...(proxyUrl ? { proxyUrl } : {}),
        },
      });
      if (response.status < 200 || response.status >= 300) {
        throw new DevinHttpStatusError(
          response.status,
          `Devin update server answered HTTP ${response.status} for ${url}`,
        );
      }
      return response.body;
    },
    2,
    delayFn,
  );
}

interface ParsedDevinManifest {
  readonly version: string;
  readonly bundleUrl: string;
  readonly sha256: string;
}

function parseDevinManifest(
  rawBytes: Uint8Array,
  triple: DevinWindowsTargetTriple,
): ParsedDevinManifest {
  const parsed = JSON.parse(Buffer.from(rawBytes).toString("utf8")) as {
    version?: unknown;
    platforms?: Record<string, { url?: unknown; sha256?: unknown } | undefined>;
  };
  const version = typeof parsed.version === "string" ? parsed.version.trim() : "";
  if (!version || !/^[0-9]+(?:\.[0-9A-Za-z.-]+)+$/u.test(version)) {
    throw new Error("Devin update manifest is missing a valid release version.");
  }
  const platformEntry = parsed.platforms?.[triple];
  const bundleUrl = typeof platformEntry?.url === "string" ? platformEntry.url.trim() : "";
  const sha256 =
    typeof platformEntry?.sha256 === "string" ? platformEntry.sha256.trim().toLowerCase() : "";
  if (!bundleUrl || !/^[0-9a-f]{64}$/u.test(sha256)) {
    throw new Error(`Devin update manifest is missing a valid Windows bundle for ${triple}.`);
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(bundleUrl);
  } catch {
    throw new Error(`Devin update manifest supplied an invalid bundle URL: ${bundleUrl}`);
  }
  if (parsedUrl.protocol !== "https:" || parsedUrl.origin !== DEVIN_STATIC_ORIGIN) {
    throw new Error(`Rejected Devin bundle outside static.devin.ai: ${parsedUrl.origin}`);
  }
  return { version, bundleUrl: parsedUrl.toString(), sha256 };
}

async function locateExtractedExecutable(extractDir: string): Promise<string> {
  for (const relativePath of [Path.join("bin", "devin.exe"), "devin.exe"]) {
    const candidate = Path.join(extractDir, relativePath);
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  throw new Error("Extracted Devin update archive did not contain bin/devin.exe.");
}

async function updateCachedVersionJson(installRoot: string, version: string): Promise<void> {
  const cachedPath = Path.join(installRoot, "cached_version.json");
  if (!(await fileExists(cachedPath))) return;
  try {
    const raw = await FS.readFile(cachedPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const nextRecord: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
    if (typeof nextRecord.latest === "string") nextRecord.latest = version;
    if (typeof nextRecord.version === "string") nextRecord.version = version;
    if (typeof nextRecord.latest_version === "string") nextRecord.latest_version = version;
    if (typeof nextRecord.latestVersion === "string") nextRecord.latestVersion = version;
    if (typeof nextRecord.current_version === "string") nextRecord.current_version = version;
    if (typeof nextRecord.checked_at === "string") nextRecord.checked_at = new Date().toISOString();
    const tempPath = `${cachedPath}.tmp-${randomUUID()}`;
    await FS.writeFile(tempPath, `${JSON.stringify(nextRecord)}\n`, { mode: 0o600 });
    await FS.rename(tempPath, cachedPath);
  } catch {
    // Best-effort metadata update only; binary replacement already succeeded.
  }
}

/**
 * Downloads the verified Windows Devin release archive from `static.devin.ai`
 * and atomically swaps the installed `devin.exe` in place using `.new`/`.old`
 * renames so locked running executables do not fail or silently no-op.
 */
export async function updateDevinWindowsNative(
  input: DevinWindowsUpdateInput,
): Promise<DevinWindowsUpdateResult> {
  const env = input.env ?? process.env;
  const httpRequest = input.httpRequest ?? defaultHttpRequest;
  const fetchManifest =
    input.fetchBytes ??
    ((url: string, maxBytes: number) => fetchDevinManifestBytes(url, maxBytes, env, httpRequest));
  const fetchArchive =
    input.fetchBytes ??
    ((url: string, maxBytes: number) => downloadDevinArchiveBytes(url, maxBytes, env, httpRequest));
  const renameFile = input.renameFile ?? ((from, to) => FS.rename(from, to));
  const triple = resolveDevinWindowsTargetTriple(input.arch);
  const targetPath = await resolveTargetExecutablePath(input.binaryPath, env);
  const installRoot = resolveInstallRoot(targetPath);
  const distribution = await readDistributionMarker(installRoot);
  const manifestUrl = manifestUrlForDevinDistribution(distribution);

  const manifestBytes = await fetchManifest(manifestUrl, DEVIN_MANIFEST_MAX_BYTES);
  const manifest = parseDevinManifest(manifestBytes, triple);
  const archiveBytes = await fetchArchive(manifest.bundleUrl, DEVIN_ARCHIVE_MAX_BYTES);

  const actualSha256 = createHash("sha256").update(archiveBytes).digest("hex").toLowerCase();
  if (actualSha256 !== manifest.sha256) {
    throw new Error(
      `Devin update SHA-256 verification failed: expected ${manifest.sha256}, got ${actualSha256}.`,
    );
  }

  const stagingBase = (await dirExists(installRoot)) ? installRoot : OS.tmpdir();
  const extractDir = Path.join(stagingBase, `.moss-devin-update-${randomUUID()}`);
  await FS.mkdir(extractDir, { recursive: true });

  const targetDir = Path.dirname(targetPath);
  await FS.mkdir(targetDir, { recursive: true });
  const stagedExePath = `${targetPath}.new-${randomUUID()}`;
  const backupExePath = `${targetPath}.old-${randomUUID()}`;
  let renamedExistingToBackup = false;

  try {
    await extractAgentZip(archiveBytes, extractDir, {
      packageRoot: null,
      limits: {
        archive: DEVIN_ARCHIVE_MAX_BYTES,
        file: DEVIN_BINARY_MAX_BYTES,
        expanded: DEVIN_EXPANDED_MAX_BYTES,
      },
    });
    const extractedExe = await locateExtractedExecutable(extractDir);

    // Keep Devin's `_versions/<version>/bin/devin.exe` folder populated when present.
    const versionsDir = Path.join(installRoot, "_versions");
    if (await dirExists(versionsDir)) {
      const versionBinDir = Path.join(versionsDir, manifest.version, "bin");
      await FS.mkdir(versionBinDir, { recursive: true }).catch(() => undefined);
      await FS.copyFile(extractedExe, Path.join(versionBinDir, Path.basename(targetPath))).catch(
        () => undefined,
      );
    }

    await FS.copyFile(extractedExe, stagedExePath);

    if (await fileExists(targetPath)) {
      await renameFile(targetPath, backupExePath);
      renamedExistingToBackup = true;
    }

    try {
      await renameFile(stagedExePath, targetPath);
    } catch (swapError) {
      if (renamedExistingToBackup) {
        await renameFile(backupExePath, targetPath).catch(() => undefined);
      }
      throw swapError;
    }

    if (renamedExistingToBackup) {
      // On Windows an active process may still hold the `.old` handle until exit; ignore EBUSY/EPERM.
      await FS.unlink(backupExePath).catch(() => undefined);
    }

    await updateCachedVersionJson(installRoot, manifest.version);

    return {
      version: manifest.version,
      targetPath,
      triple,
      output: `Downloaded Devin CLI ${manifest.version} (${triple}) and updated ${targetPath}.`,
    };
  } finally {
    await FS.unlink(stagedExePath).catch(() => undefined);
    await FS.rm(extractDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
