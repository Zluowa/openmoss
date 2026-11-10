// FILE: download.ts
// Purpose: Content-checked, cached HTTP downloads for agent runtime bumps.
// Layer: Release/build helper (agent runtime bumps)

import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";
import { Readable } from "node:stream";
import * as Stream from "node:stream/promises";

export interface DownloadExpectation {
  /** Hex SHA-256 the bytes must have (crates.io checksums, pinned upstream sources). */
  readonly sha256?: string;
  /** npm `dist.integrity` (sha512-<base64>) the bytes must have. */
  readonly integrity?: string;
}

export interface DownloadedFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export function sha256Hex(bytes: Buffer | string): string {
  return Crypto.createHash("sha256").update(bytes).digest("hex");
}

export function hashFile(filePath: string, algorithm: "sha256" | "sha512"): Buffer {
  const hash = Crypto.createHash(algorithm);
  const descriptor = FS.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const read = FS.readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    FS.closeSync(descriptor);
  }
  return hash.digest();
}

function checkExpectation(filePath: string, expected: DownloadExpectation, label: string): string {
  const sha256 = hashFile(filePath, "sha256").toString("hex");
  if (expected.sha256 && sha256 !== expected.sha256) {
    throw new Error(`${label}: SHA-256 ${sha256} does not match the pinned ${expected.sha256}.`);
  }
  if (expected.integrity) {
    const [algorithm, digest] = expected.integrity.split("-", 2) as [string, string];
    if (algorithm !== "sha512" || !digest) {
      throw new Error(`${label}: unsupported npm integrity ${expected.integrity}.`);
    }
    const actual = hashFile(filePath, "sha512").toString("base64");
    if (actual !== digest) {
      throw new Error(
        `${label}: npm integrity sha512-${actual} does not match ${expected.integrity}.`,
      );
    }
  }
  return sha256;
}

const USER_AGENT = "moss-runtime-bump (+https://github.com/Zluowa/moss-synara)";

class NotFoundError extends Error {}

/**
 * Runs one whole request (headers, body and any check of it) up to four times. Connection
 * resets also happen while a body streams, so the body read sits inside the retried work.
 */
async function withRetry<T>(
  url: string,
  label: string,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "user-agent": USER_AGENT },
        redirect: "follow",
        signal: AbortSignal.timeout(30 * 60_000),
      });
      if (response.status === 404) throw new NotFoundError(`${label}: ${url} returned 404.`);
      if (!response.ok) throw new Error(`${label}: ${url} returned HTTP ${response.status}.`);
      return await read(response);
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
  }
  throw lastError instanceof Error
    ? new Error(`${label}: ${url} failed after 4 attempts: ${lastError.message}`, {
        cause: lastError,
      })
    : new Error(String(lastError));
}

/** Fetches JSON metadata (not cached: registry metadata is how new versions are found). */
export async function fetchJson(url: string, label: string): Promise<unknown> {
  return withRetry(url, label, (response) => response.json());
}

/** Fetches text, or null on 404 (crates.io sparse index lookups). */
export async function fetchTextOrNull(url: string, label: string): Promise<string | null> {
  try {
    return await withRetry(url, label, (response) => response.text());
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
}

/**
 * Downloads `url` into `cacheDir/cacheKey` unless a cached copy already passes the expectation.
 * The file is written to a temporary name and renamed only after it verifies.
 */
export async function downloadToCache(input: {
  readonly url: string;
  readonly cacheDir: string;
  readonly cacheKey: string;
  readonly expected: DownloadExpectation;
  readonly label: string;
}): Promise<DownloadedFile> {
  const target = Path.join(input.cacheDir, input.cacheKey);
  FS.mkdirSync(Path.dirname(target), { recursive: true });
  if (FS.existsSync(target)) {
    try {
      const sha256 = checkExpectation(target, input.expected, input.label);
      return { path: target, size: FS.statSync(target).size, sha256 };
    } catch {
      FS.rmSync(target, { force: true });
    }
  }
  const temporary = `${target}.${process.pid}.partial`;
  return withRetry(input.url, input.label, async (response) => {
    if (!response.body) throw new Error(`${input.label}: ${input.url} returned no body.`);
    try {
      await Stream.pipeline(
        Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream),
        FS.createWriteStream(temporary),
      );
      const sha256 = checkExpectation(temporary, input.expected, input.label);
      FS.renameSync(temporary, target);
      return { path: target, size: FS.statSync(target).size, sha256 };
    } catch (error) {
      FS.rmSync(temporary, { force: true });
      throw error;
    }
  });
}

/** Runs `work` over `items` with at most `limit` in flight, preserving result order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = Array.from<R>({ length: items.length });
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await work(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}
