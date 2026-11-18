// FILE: pinnedDownload.ts
// Purpose: Downloads one immutable file whose size and sha256 are pinned in the build, from an
//          ordered list of sources, resuming and switching source mid-file without losing bytes.
// Layer: Shared runtime utility. The transport is injected: the desktop passes Electron's
//        net.fetch (system proxy, PAC, system certificates), tests and Node callers pass fetch.
//
// Contract (D:\ceshi\moss-codex-handoff\domains-20261113\DOWNLOAD-SOURCES.md §5): single-range
// GETs from the current offset; per source a connect timeout and a stall timeout; on either, the
// next source continues from the same offset (safe: size and sha256 are pinned and objects are
// immutable); sha256 at the end with one clean restart on mismatch; the partial file survives a
// restart; one progress figure; a failure only when every source has failed.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat, truncate } from "node:fs/promises";
import { dirname } from "node:path";

export type PinnedDownloadFetch = (
  url: string,
  init: { readonly headers: Record<string, string>; readonly signal: AbortSignal },
) => Promise<Response>;

/** Why a download did not finish. `disk` and `mismatch` stop at once; the others are retried. */
export type PinnedDownloadFailure =
  | "offline"
  | "proxy"
  | "unreachable"
  | "stalled"
  | "http"
  | "disk"
  | "mismatch"
  | "aborted";

export interface PinnedDownloadProgress {
  /** Bytes of the file on disk (resumed bytes included). */
  readonly bytes: number;
  readonly total: number;
}

export interface PinnedDownloadWaiting {
  /** Every source failed this round; the next round starts after `retryInMs`. */
  readonly failure: PinnedDownloadFailure;
  readonly retryInMs: number;
  readonly bytes: number;
  readonly total: number;
}

export interface PinnedDownloadInput {
  /** Full URLs of the same immutable object, in the order to try them. */
  readonly sources: ReadonlyArray<string>;
  readonly size: number;
  readonly sha256: string;
  /** Where the verified file ends up; `<destinationPath>.partial` holds the bytes meanwhile. */
  readonly destinationPath: string;
  readonly fetch: PinnedDownloadFetch;
  readonly connectTimeoutMs?: number;
  readonly stallTimeoutMs?: number;
  /** Pause before each further round over all sources; one entry per extra round. */
  readonly retryDelaysMs?: ReadonlyArray<number>;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: PinnedDownloadProgress) => void;
  readonly onWaiting?: (waiting: PinnedDownloadWaiting) => void;
  /** Test seams. */
  readonly sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
  readonly now?: () => number;
}

/** What happened, for diagnostics: no URL, only the source's position in the list. */
export interface PinnedDownloadReport {
  readonly outcome: "ok" | PinnedDownloadFailure;
  /** Index of the source that delivered the last bytes, or -1. */
  readonly sourceIndex: number;
  /** Bytes transferred in this call (not counting bytes resumed from disk). */
  readonly bytesTransferred: number;
  readonly resumedFromBytes: number;
  readonly durationMs: number;
  /** Rounds over the source list after the first one. */
  readonly retries: number;
  /** Times a source failed and the next one took over. */
  readonly switches: number;
  readonly mismatchRestarts: number;
  /** HTTP status of the last failed answer, when there was one. */
  readonly lastHttpStatus?: number;
}

// Plain fields, not parameter properties: the installer build loads this module with Node's
// type stripping, which refuses TypeScript-only syntax (scripts/lib/plain-node-imports.test.ts).
export class PinnedDownloadError extends Error {
  readonly failure: PinnedDownloadFailure;
  readonly report: PinnedDownloadReport;

  constructor(failure: PinnedDownloadFailure, report: PinnedDownloadReport, message: string) {
    super(message);
    this.name = "PinnedDownloadError";
    this.failure = failure;
    this.report = report;
  }
}

export const PINNED_DOWNLOAD_CONNECT_TIMEOUT_MS = 10_000;
export const PINNED_DOWNLOAD_STALL_TIMEOUT_MS = 15_000;
export const PINNED_DOWNLOAD_RETRY_DELAYS_MS: ReadonlyArray<number> = [
  2_000, 10_000, 30_000, 60_000, 60_000, 60_000, 60_000,
];

class AttemptError extends Error {
  readonly failure: PinnedDownloadFailure;
  readonly httpStatus: number | undefined;

  constructor(failure: PinnedDownloadFailure, message: string, httpStatus?: number) {
    super(message);
    this.failure = failure;
    this.httpStatus = httpStatus;
  }
}

const OFFLINE_CODES =
  /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED|ERR_ADDRESS_UNREACHABLE|ENOTFOUND|EAI_AGAIN|ENETUNREACH|ENETDOWN/u;
const PROXY_CODES =
  /ERR_PROXY|ERR_TUNNEL_CONNECTION_FAILED|ERR_CERT_|ERR_SSL_|CERT_|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/u;
const DISK_CODES = /ENOSPC|EDQUOT/u;

function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.message, String((current as NodeJS.ErrnoException).code ?? ""));
      current = (current as { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(" ");
}

/** Sorts a transport failure into what the person can act on. */
export function classifyPinnedDownloadError(error: unknown): PinnedDownloadFailure {
  if (error instanceof AttemptError) return error.failure;
  const text = errorText(error);
  if (DISK_CODES.test(text)) return "disk";
  if (PROXY_CODES.test(text)) return "proxy";
  if (OFFLINE_CODES.test(text)) return "offline";
  return "unreachable";
}

function defaultSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AttemptError("aborted", "aborted"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AttemptError("aborted", "aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** `bytes <start>-<end>/<total>` → start and total (total null for `*`). */
function parseContentRange(value: string | null): { start: number; total: number | null } | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/u.exec(value?.trim() ?? "");
  if (!match) return null;
  return { start: Number(match[1]), total: match[3] === "*" ? null : Number(match[3]) };
}

/**
 * Downloads the pinned file to `destinationPath` and verifies it. Resolves with the report;
 * rejects with a PinnedDownloadError carrying the same report.
 */
export async function downloadPinnedFile(
  input: PinnedDownloadInput,
): Promise<PinnedDownloadReport> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? defaultSleep;
  const connectTimeoutMs = input.connectTimeoutMs ?? PINNED_DOWNLOAD_CONNECT_TIMEOUT_MS;
  const stallTimeoutMs = input.stallTimeoutMs ?? PINNED_DOWNLOAD_STALL_TIMEOUT_MS;
  const retryDelays = input.retryDelaysMs ?? PINNED_DOWNLOAD_RETRY_DELAYS_MS;
  const partialPath = `${input.destinationPath}.partial`;
  const expectedSha = input.sha256.toLowerCase();
  const started = now();

  let sourceIndex = -1;
  let bytesTransferred = 0;
  let switches = 0;
  let retries = 0;
  let mismatchRestarts = 0;
  let lastHttpStatus: number | undefined;
  let resumedFromBytes = 0;

  const report = (outcome: PinnedDownloadReport["outcome"]): PinnedDownloadReport => ({
    outcome,
    sourceIndex,
    bytesTransferred,
    resumedFromBytes,
    durationMs: now() - started,
    retries,
    switches,
    mismatchRestarts,
    ...(lastHttpStatus === undefined ? {} : { lastHttpStatus }),
  });
  const fail = (failure: PinnedDownloadFailure, message: string): never => {
    throw new PinnedDownloadError(failure, report(failure), message);
  };

  if (input.sources.length === 0) fail("unreachable", "No download source is configured.");
  await mkdir(dirname(input.destinationPath), { recursive: true });

  // A destination already verified by an earlier run is reused as it is.
  if ((await fileSize(input.destinationPath)) === input.size) {
    if ((await sha256OfFile(input.destinationPath)) === expectedSha) return report("ok");
    await rm(input.destinationPath, { force: true });
  }

  let offset = await fileSize(partialPath);
  if (offset > input.size) {
    await rm(partialPath, { force: true });
    offset = 0;
  }
  resumedFromBytes = offset;
  input.onProgress?.({ bytes: offset, total: input.size });

  /** One request to one source from the current offset; resolves when the file is complete. */
  const attempt = async (url: string): Promise<void> => {
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    input.signal?.addEventListener("abort", onOuterAbort, { once: true });
    let timeoutFailure: PinnedDownloadFailure | null = null;
    let timer = setTimeout(() => {
      timeoutFailure = "unreachable";
      controller.abort();
    }, connectTimeoutMs);
    const armStall = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timeoutFailure = "stalled";
        controller.abort();
      }, stallTimeoutMs);
    };
    try {
      let response: Response;
      try {
        response = await input.fetch(url, {
          headers: { Range: `bytes=${offset}-`, "Accept-Encoding": "identity" },
          signal: controller.signal,
        });
      } catch (error) {
        if (input.signal?.aborted) throw new AttemptError("aborted", "aborted");
        if (timeoutFailure) throw new AttemptError(timeoutFailure, "No answer from the source.");
        throw new AttemptError(classifyPinnedDownloadError(error), errorText(error));
      }
      armStall();
      if (response.status === 416 && offset === input.size) {
        await response.body?.cancel();
        return;
      }
      if (response.status === 407) {
        await response.body?.cancel();
        throw new AttemptError("proxy", "The proxy asks for a sign-in.", 407);
      }
      if (response.status === 206) {
        const range = parseContentRange(response.headers.get("content-range"));
        if (
          !range ||
          range.start !== offset ||
          (range.total !== null && range.total !== input.size)
        ) {
          await response.body?.cancel();
          throw new AttemptError("http", "The source answered with another byte range.", 206);
        }
      } else if (response.status === 200 && offset === 0) {
        const length = Number(response.headers.get("content-length") ?? Number.NaN);
        if (Number.isFinite(length) && length !== input.size) {
          await response.body?.cancel();
          throw new AttemptError("http", "The source has a file of another size.", 200);
        }
      } else {
        // A 200 to a request from the middle of the file starts at byte 0 (seen on the R2 host
        // about once in ten ranged requests): never append it, try the next source instead.
        await response.body?.cancel();
        throw new AttemptError("http", `The source answered ${response.status}.`, response.status);
      }
      if (!response.body)
        throw new AttemptError("http", "The source sent no body.", response.status);

      const handle = await open(partialPath, "a");
      try {
        const reader = response.body.getReader();
        for (;;) {
          let chunk: Awaited<ReturnType<typeof reader.read>>;
          try {
            chunk = await reader.read();
          } catch (error) {
            if (input.signal?.aborted) throw new AttemptError("aborted", "aborted");
            if (timeoutFailure)
              throw new AttemptError(timeoutFailure, "The source stopped sending.");
            throw new AttemptError(classifyPinnedDownloadError(error), errorText(error));
          }
          if (chunk.done) break;
          armStall();
          const bytes = chunk.value;
          if (offset + bytes.length > input.size) {
            await reader.cancel();
            throw new AttemptError("http", "The source sent more bytes than the file has.");
          }
          try {
            await handle.write(bytes);
          } catch (error) {
            await reader.cancel().catch(() => undefined);
            throw new AttemptError(classifyPinnedDownloadError(error), errorText(error));
          }
          offset += bytes.length;
          bytesTransferred += bytes.length;
          input.onProgress?.({ bytes: offset, total: input.size });
        }
      } finally {
        await handle.close();
      }
      if (offset !== input.size)
        throw new AttemptError("stalled", "The source closed the file early.");
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onOuterAbort);
    }
  };

  for (let restart = 0; ; restart += 1) {
    let round = 0;
    let lastFailure: PinnedDownloadFailure = "unreachable";
    let lastMessage = "";
    let complete = offset === input.size;
    while (!complete) {
      const roundFailures: PinnedDownloadFailure[] = [];
      for (let index = 0; index < input.sources.length && !complete; index += 1) {
        if (input.signal?.aborted) fail("aborted", "The download was cancelled.");
        if (roundFailures.length > 0) switches += 1;
        sourceIndex = index;
        try {
          await attempt(input.sources[index]!);
          complete = true;
        } catch (error) {
          const failure = classifyPinnedDownloadError(error);
          if (error instanceof AttemptError && error.httpStatus !== undefined)
            lastHttpStatus = error.httpStatus;
          if (failure === "aborted") fail("aborted", "The download was cancelled.");
          if (failure === "disk") fail("disk", errorText(error));
          roundFailures.push(failure);
          lastMessage = errorText(error);
        }
      }
      if (complete) break;
      // Every source failed: name the most useful reason for the person.
      lastFailure = roundFailures.every((failure) => failure === "offline")
        ? "offline"
        : roundFailures.includes("proxy")
          ? "proxy"
          : (roundFailures.at(-1) ?? "unreachable");
      const delay = retryDelays[round];
      if (delay === undefined) fail(lastFailure, lastMessage);
      input.onWaiting?.({
        failure: lastFailure,
        retryInMs: delay!,
        bytes: offset,
        total: input.size,
      });
      try {
        await sleep(delay!, input.signal);
      } catch {
        fail("aborted", "The download was cancelled.");
      }
      round += 1;
      retries += 1;
    }

    if ((await sha256OfFile(partialPath)) === expectedSha) {
      await rename(partialPath, input.destinationPath);
      return report("ok");
    }
    // Same size, other bytes: one clean restart from the first byte, then give up.
    await truncate(partialPath, 0);
    offset = 0;
    if (restart >= 1) {
      await rm(partialPath, { force: true });
      fail("mismatch", "The downloaded file does not match its pinned sha256.");
    }
    mismatchRestarts += 1;
    input.onProgress?.({ bytes: 0, total: input.size });
  }
}
