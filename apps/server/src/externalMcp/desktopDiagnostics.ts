import { createHash } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { access, lstat, open, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { sanitizeDiagnosticValue } from "../agentGateway/diagnosticSanitizer.ts";

export const DESKTOP_DIAGNOSTIC_SOURCES = ["server", "backend", "desktop"] as const;

export type DesktopDiagnosticSource = (typeof DESKTOP_DIAGNOSTIC_SOURCES)[number];

export const DESKTOP_DIAGNOSTIC_DEFAULT_LIMIT = 100;
export const DESKTOP_DIAGNOSTIC_MAX_LIMIT = 200;
export const DESKTOP_DIAGNOSTIC_READ_CHUNK_BYTES = 64 * 1024;
export const DESKTOP_DIAGNOSTIC_MAX_SCAN_BYTES = 1024 * 1024;
export const DESKTOP_DIAGNOSTIC_MAX_LINE_CHARS = 4_096;
export const DESKTOP_DIAGNOSTIC_MAX_CONTAINS_CHARS = 256;
export const DESKTOP_DIAGNOSTIC_MAX_LEVEL_FILTER_ITEMS = 16;

const CURSOR_VERSION = 1;
const MAX_CURSOR_CHARS = 4_096;
const LOG_FILE_NAMES: Readonly<Record<DesktopDiagnosticSource, string>> = {
  server: "server.log",
  backend: "server-child.log",
  desktop: "desktop-main.log",
};
const SUPPORTED_LEVELS = new Set(["TRACE", "DEBUG", "INFO", "NOTICE", "WARN", "ERROR", "FATAL"]);

export type DesktopDiagnosticSourceErrorCode =
  | "log-symlink"
  | "log-not-regular"
  | "log-unreadable"
  | "log-rotated"
  | "log-truncated"
  | "log-line-too-large";

export class DesktopDiagnosticInputError extends Error {
  override readonly name = "DesktopDiagnosticInputError";
}

export class DesktopDiagnosticSourceError extends Error {
  override readonly name = "DesktopDiagnosticSourceError";

  constructor(
    readonly code: DesktopDiagnosticSourceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface DesktopDiagnosticLogStatus {
  readonly source: DesktopDiagnosticSource;
  readonly fileName: string;
  readonly sizeBytes: number | null;
  readonly mtime: string | null;
  readonly private: boolean | null;
  readonly available: boolean;
}

export interface DesktopDiagnosticLogLine {
  readonly byteOffset: number;
  readonly text: string;
  readonly level?: string;
}

export interface DesktopDiagnosticLogCoverage {
  readonly highWaterSizeBytes: number | null;
  readonly beforeByte: number | null;
  readonly scannedBytes: number;
  readonly maxScanBytes: number;
  readonly scanTruncated: boolean;
  readonly sourceComplete: boolean;
  readonly pageHasOlder: boolean;
}

export interface DesktopDiagnosticLogPage {
  readonly source: DesktopDiagnosticSource;
  readonly fileName: string;
  readonly available: boolean;
  readonly lines: ReadonlyArray<DesktopDiagnosticLogLine>;
  readonly coverage: DesktopDiagnosticLogCoverage;
  readonly nextCursor?: string;
}

export interface ReadDesktopDiagnosticLogInput {
  readonly logsDir: string;
  readonly source: DesktopDiagnosticSource;
  readonly cursor?: string;
  readonly limit?: number;
  readonly levels?: ReadonlyArray<string>;
  readonly contains?: string;
}

interface DesktopDiagnosticCursor {
  readonly version: 1;
  readonly kind: "desktop-log";
  readonly source: DesktopDiagnosticSource;
  readonly filterFingerprint: string;
  readonly dev: string;
  readonly ino: string;
  readonly highWaterSizeBytes: number;
  readonly beforeByte: number;
}

interface NormalizedFilters {
  readonly levels: ReadonlyArray<string>;
  readonly containsFolded: string | null;
  readonly fingerprint: string;
}

interface OpenLog {
  readonly handle: FileHandle;
  readonly dev: string;
  readonly ino: string;
  readonly sizeBytes: number;
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function isDesktopDiagnosticSource(value: unknown): value is DesktopDiagnosticSource {
  return (
    typeof value === "string" &&
    (DESKTOP_DIAGNOSTIC_SOURCES as ReadonlyArray<string>).includes(value)
  );
}

function assertLogsDir(logsDir: string): void {
  if (typeof logsDir !== "string" || logsDir.trim().length === 0) {
    throw new DesktopDiagnosticInputError('Argument "logsDir" must be a non-empty string.');
  }
}

function assertSource(source: DesktopDiagnosticSource): void {
  if (!isDesktopDiagnosticSource(source)) {
    throw new DesktopDiagnosticInputError(
      `Argument "source" must be one of: ${DESKTOP_DIAGNOSTIC_SOURCES.join(", ")}.`,
    );
  }
}

function safeStatSize(size: bigint, fileName: string): number {
  if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DesktopDiagnosticSourceError(
      "log-unreadable",
      `Desktop diagnostic log "${fileName}" is too large to read safely.`,
    );
  }
  return Number(size);
}

function canonicalLevel(level: string): string {
  const normalized = level.trim().toUpperCase();
  if (normalized === "WARNING") return "WARN";
  if (normalized === "CRITICAL") return "FATAL";
  return normalized;
}

function normalizeFilters(input: ReadDesktopDiagnosticLogInput): NormalizedFilters {
  if (
    input.levels !== undefined &&
    (!Array.isArray(input.levels) ||
      input.levels.length > DESKTOP_DIAGNOSTIC_MAX_LEVEL_FILTER_ITEMS ||
      input.levels.some((entry) => typeof entry !== "string" || entry.trim().length === 0))
  ) {
    throw new DesktopDiagnosticInputError(
      `Argument "levels" must be an array of at most ${DESKTOP_DIAGNOSTIC_MAX_LEVEL_FILTER_ITEMS} non-empty strings.`,
    );
  }
  const levels = [...new Set((input.levels ?? []).map(canonicalLevel))].toSorted();
  const unsupported = levels.filter((level) => !SUPPORTED_LEVELS.has(level));
  if (unsupported.length > 0) {
    throw new DesktopDiagnosticInputError(
      `Argument "levels" contains unsupported values: ${unsupported.join(", ")}.`,
    );
  }
  if (
    input.contains !== undefined &&
    (typeof input.contains !== "string" ||
      input.contains.trim().length === 0 ||
      input.contains.trim().length > DESKTOP_DIAGNOSTIC_MAX_CONTAINS_CHARS)
  ) {
    throw new DesktopDiagnosticInputError(
      `Argument "contains" must be a non-empty string of at most ${DESKTOP_DIAGNOSTIC_MAX_CONTAINS_CHARS} characters when provided.`,
    );
  }
  const contains = input.contains?.trim() ?? null;
  const containsFolded = contains?.toLowerCase() ?? null;
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ levels, contains: containsFolded }))
    .digest("base64url");
  return {
    levels,
    containsFolded,
    fingerprint,
  };
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DESKTOP_DIAGNOSTIC_DEFAULT_LIMIT;
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    throw new DesktopDiagnosticInputError('Argument "limit" must be a finite number.');
  }
  return Math.max(1, Math.min(Math.floor(limit), DESKTOP_DIAGNOSTIC_MAX_LIMIT));
}

export function desktopDiagnosticLogFileName(source: DesktopDiagnosticSource): string {
  assertSource(source);
  return LOG_FILE_NAMES[source];
}

function logFilePath(logsDir: string, source: DesktopDiagnosticSource): string {
  return path.join(logsDir, desktopDiagnosticLogFileName(source));
}

function isPrivateMode(mode: number): boolean {
  return process.platform === "win32" || (mode & 0o077) === 0;
}

async function statusForSource(
  logsDir: string,
  source: DesktopDiagnosticSource,
): Promise<DesktopDiagnosticLogStatus> {
  const fileName = desktopDiagnosticLogFileName(source);
  try {
    const stats = await lstat(logFilePath(logsDir, source));
    if (!stats.isFile() || stats.isSymbolicLink()) {
      return {
        source,
        fileName,
        sizeBytes: null,
        mtime: null,
        private: null,
        available: false,
      };
    }
    try {
      await access(logFilePath(logsDir, source), fsConstants.R_OK);
    } catch {
      return {
        source,
        fileName,
        sizeBytes: stats.size,
        mtime: stats.mtime.toISOString(),
        private: isPrivateMode(stats.mode),
        available: false,
      };
    }
    return {
      source,
      fileName,
      sizeBytes: stats.size,
      mtime: stats.mtime.toISOString(),
      private: isPrivateMode(stats.mode),
      available: true,
    };
  } catch (error) {
    if (!isNodeErrorWithCode(error, "ENOENT")) {
      // Status is deliberately non-throwing: an inaccessible parent directory is
      // represented as unavailable without exposing its absolute path.
    }
    return {
      source,
      fileName,
      sizeBytes: null,
      mtime: null,
      private: null,
      available: false,
    };
  }
}

export async function getDesktopDiagnosticLogStatus(input: {
  readonly logsDir: string;
}): Promise<ReadonlyArray<DesktopDiagnosticLogStatus>> {
  assertLogsDir(input.logsDir);
  return Promise.all(
    DESKTOP_DIAGNOSTIC_SOURCES.map((source) => statusForSource(input.logsDir, source)),
  );
}

function invalidCursor(
  message = "is malformed or has invalid bounds",
): DesktopDiagnosticInputError {
  return new DesktopDiagnosticInputError(`Argument "cursor" ${message}.`);
}

function decodeCursor(
  raw: string | undefined,
  expected: { readonly source: DesktopDiagnosticSource; readonly filterFingerprint: string },
): DesktopDiagnosticCursor | undefined {
  if (raw === undefined) return undefined;
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > MAX_CURSOR_CHARS ||
    !/^[A-Za-z0-9_-]+$/.test(raw)
  ) {
    throw invalidCursor();
  }
  try {
    const decoded = Buffer.from(raw, "base64url");
    if (decoded.toString("base64url") !== raw) throw invalidCursor();
    const value = JSON.parse(decoded.toString("utf8")) as Partial<DesktopDiagnosticCursor>;
    if (value.source !== expected.source) {
      throw invalidCursor(`belongs to a different desktop diagnostic source`);
    }
    if (value.filterFingerprint !== expected.filterFingerprint) {
      throw invalidCursor(`does not match the current levels and contains filters`);
    }
    if (
      value.version !== CURSOR_VERSION ||
      value.kind !== "desktop-log" ||
      typeof value.dev !== "string" ||
      !/^\d+$/.test(value.dev) ||
      typeof value.ino !== "string" ||
      !/^\d+$/.test(value.ino) ||
      !Number.isSafeInteger(value.highWaterSizeBytes) ||
      !Number.isSafeInteger(value.beforeByte) ||
      (value.highWaterSizeBytes ?? -1) < 0 ||
      (value.beforeByte ?? -1) < 0 ||
      (value.beforeByte ?? Number.POSITIVE_INFINITY) >
        (value.highWaterSizeBytes ?? Number.NEGATIVE_INFINITY)
    ) {
      throw invalidCursor();
    }
    return value as DesktopDiagnosticCursor;
  } catch (error) {
    if (error instanceof DesktopDiagnosticInputError) throw error;
    throw invalidCursor();
  }
}

function encodeCursor(cursor: DesktopDiagnosticCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

async function openRegularLog(
  logsDir: string,
  source: DesktopDiagnosticSource,
  cursorPresent: boolean,
): Promise<OpenLog | null> {
  const fileName = desktopDiagnosticLogFileName(source);
  const filePath = logFilePath(logsDir, source);
  let pathStats: BigIntStats;
  try {
    pathStats = await lstat(filePath, { bigint: true });
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      if (cursorPresent) {
        throw new DesktopDiagnosticSourceError(
          "log-rotated",
          `Desktop diagnostic log "${fileName}" disappeared after this cursor was issued; start again without a cursor.`,
        );
      }
      return null;
    }
    throw new DesktopDiagnosticSourceError(
      "log-unreadable",
      `Desktop diagnostic log "${fileName}" cannot be inspected.`,
    );
  }
  if (pathStats.isSymbolicLink()) {
    throw new DesktopDiagnosticSourceError(
      "log-symlink",
      `Desktop diagnostic log "${fileName}" is a symbolic link; refusing to read it.`,
    );
  }
  if (!pathStats.isFile()) {
    throw new DesktopDiagnosticSourceError(
      "log-not-regular",
      `Desktop diagnostic log "${fileName}" is not a regular file; refusing to read it.`,
    );
  }

  let handle: FileHandle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (isNodeErrorWithCode(error, "ELOOP")) {
      throw new DesktopDiagnosticSourceError(
        "log-symlink",
        `Desktop diagnostic log "${fileName}" became a symbolic link; refusing to read it.`,
      );
    }
    if (isNodeErrorWithCode(error, "ENOENT") && cursorPresent) {
      throw new DesktopDiagnosticSourceError(
        "log-rotated",
        `Desktop diagnostic log "${fileName}" disappeared after this cursor was issued; start again without a cursor.`,
      );
    }
    if (isNodeErrorWithCode(error, "ENOENT")) return null;
    throw new DesktopDiagnosticSourceError(
      "log-unreadable",
      `Desktop diagnostic log "${fileName}" cannot be opened for reading.`,
    );
  }

  try {
    const handleStats = await handle.stat({ bigint: true });
    if (!handleStats.isFile()) {
      throw new DesktopDiagnosticSourceError(
        "log-not-regular",
        `Desktop diagnostic log "${fileName}" is not a regular file; refusing to read it.`,
      );
    }
    if (pathStats.dev !== handleStats.dev || pathStats.ino !== handleStats.ino) {
      throw new DesktopDiagnosticSourceError(
        "log-rotated",
        `Desktop diagnostic log "${fileName}" changed while it was being opened; retry from the first page.`,
      );
    }
    return {
      handle,
      dev: handleStats.dev.toString(),
      ino: handleStats.ino.toString(),
      sizeBytes: safeStatSize(handleStats.size, fileName),
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (error instanceof DesktopDiagnosticSourceError) throw error;
    throw new DesktopDiagnosticSourceError(
      "log-unreadable",
      `Desktop diagnostic log "${fileName}" cannot be inspected after opening.`,
    );
  }
}

function extractLogLevel(line: string): string | undefined {
  const explicit = line.match(/\blevel\s*[=:]\s*["']?([a-z]+)/iu)?.[1];
  const bracketed = line.match(
    /\[(trace|debug|info|notice|warn(?:ing)?|error|fatal|critical)\]/iu,
  )?.[1];
  const raw = explicit ?? bracketed;
  if (!raw) return undefined;
  const normalized = canonicalLevel(raw);
  return SUPPORTED_LEVELS.has(normalized) ? normalized.toLowerCase() : undefined;
}

function sanitizeLine(raw: Buffer): { readonly text: string; readonly level?: string } | null {
  const withoutCarriageReturn =
    raw.length > 0 && raw[raw.length - 1] === 0x0d ? raw.subarray(0, raw.length - 1) : raw;
  if (withoutCarriageReturn.length === 0) return null;
  const sanitized = sanitizeDiagnosticValue(withoutCarriageReturn.toString("utf8"));
  let text = typeof sanitized === "string" ? sanitized : String(sanitized);
  if (text.length > DESKTOP_DIAGNOSTIC_MAX_LINE_CHARS) {
    const marker = "… [line truncated]";
    text = `${text.slice(0, DESKTOP_DIAGNOSTIC_MAX_LINE_CHARS - marker.length)}${marker}`;
  }
  const level = extractLogLevel(text);
  return level === undefined ? { text } : { text, level };
}

function matchesFilters(
  line: { readonly text: string; readonly level?: string },
  filters: NormalizedFilters,
): boolean {
  if (
    filters.levels.length > 0 &&
    (line.level === undefined || !filters.levels.includes(line.level.toUpperCase()))
  ) {
    return false;
  }
  return (
    filters.containsFolded === null || line.text.toLowerCase().includes(filters.containsFolded)
  );
}

function unavailablePage(source: DesktopDiagnosticSource): DesktopDiagnosticLogPage {
  return {
    source,
    fileName: desktopDiagnosticLogFileName(source),
    available: false,
    lines: [],
    coverage: {
      highWaterSizeBytes: null,
      beforeByte: null,
      scannedBytes: 0,
      maxScanBytes: DESKTOP_DIAGNOSTIC_MAX_SCAN_BYTES,
      scanTruncated: false,
      sourceComplete: false,
      pageHasOlder: false,
    },
  };
}

export async function readDesktopDiagnosticLog(
  input: ReadDesktopDiagnosticLogInput,
): Promise<DesktopDiagnosticLogPage> {
  assertLogsDir(input.logsDir);
  assertSource(input.source);
  const limit = normalizeLimit(input.limit);
  const filters = normalizeFilters(input);
  const cursor = decodeCursor(input.cursor, {
    source: input.source,
    filterFingerprint: filters.fingerprint,
  });
  const opened = await openRegularLog(input.logsDir, input.source, cursor !== undefined);
  if (opened === null) return unavailablePage(input.source);

  const { handle } = opened;
  try {
    if (cursor && (cursor.dev !== opened.dev || cursor.ino !== opened.ino)) {
      throw new DesktopDiagnosticSourceError(
        "log-rotated",
        `Desktop diagnostic log "${desktopDiagnosticLogFileName(input.source)}" was rotated or replaced after this cursor was issued; start again without a cursor.`,
      );
    }
    const highWaterSizeBytes = cursor?.highWaterSizeBytes ?? opened.sizeBytes;
    if (opened.sizeBytes < highWaterSizeBytes) {
      throw new DesktopDiagnosticSourceError(
        "log-truncated",
        `Desktop diagnostic log "${desktopDiagnosticLogFileName(input.source)}" was truncated after this cursor was issued; start again without a cursor.`,
      );
    }
    const beforeByte = cursor?.beforeByte ?? highWaterSizeBytes;
    if (beforeByte > opened.sizeBytes) {
      throw new DesktopDiagnosticSourceError(
        "log-truncated",
        `Desktop diagnostic log "${desktopDiagnosticLogFileName(input.source)}" no longer contains this cursor boundary; start again without a cursor.`,
      );
    }

    const matches: DesktopDiagnosticLogLine[] = [];
    let position = beforeByte;
    let scannedBytes = 0;
    let pending = Buffer.alloc(0);
    let safeResumeBeforeByte: number | undefined;
    let pageFilled = false;

    const processLine = (raw: Buffer, byteOffset: number): boolean => {
      const line = sanitizeLine(raw);
      if (line !== null && matchesFilters(line, filters)) {
        matches.push({ byteOffset, ...line });
        if (matches.length > limit) return true;
      }
      return false;
    };

    while (position > 0 && scannedBytes < DESKTOP_DIAGNOSTIC_MAX_SCAN_BYTES && !pageFilled) {
      const readLength = Math.min(
        DESKTOP_DIAGNOSTIC_READ_CHUNK_BYTES,
        DESKTOP_DIAGNOSTIC_MAX_SCAN_BYTES - scannedBytes,
        position,
      );
      const start = position - readLength;
      const chunk = Buffer.allocUnsafe(readLength);
      const { bytesRead } = await handle.read(chunk, 0, readLength, start);
      scannedBytes += bytesRead;
      if (bytesRead !== readLength) {
        throw new DesktopDiagnosticSourceError(
          "log-truncated",
          `Desktop diagnostic log "${desktopDiagnosticLogFileName(input.source)}" changed while it was being read; start again without a cursor.`,
        );
      }

      const combined = pending.length === 0 ? chunk : Buffer.concat([chunk, pending]);
      const firstNewline = combined.indexOf(0x0a);
      if (firstNewline >= 0) {
        safeResumeBeforeByte = start + firstNewline + 1;
        let segmentEnd = combined.length;
        let isRightmostSegment = true;
        for (
          let newline = combined.lastIndexOf(0x0a);
          newline >= firstNewline;
          newline = combined.lastIndexOf(0x0a, newline - 1)
        ) {
          const segmentStart = newline + 1;
          if (!(isRightmostSegment && segmentStart === segmentEnd)) {
            pageFilled = processLine(
              combined.subarray(segmentStart, segmentEnd),
              start + segmentStart,
            );
            if (pageFilled) break;
          }
          isRightmostSegment = false;
          segmentEnd = newline;
          if (newline === firstNewline) break;
        }
        pending = Buffer.from(combined.subarray(0, firstNewline));
      } else {
        pending = combined;
      }
      position = start;
    }

    if (!pageFilled && position === 0) {
      pageFilled = processLine(pending, 0);
    }

    const scanTruncated =
      !pageFilled && position > 0 && scannedBytes === DESKTOP_DIAGNOSTIC_MAX_SCAN_BYTES;
    if (
      scanTruncated &&
      (safeResumeBeforeByte === undefined || safeResumeBeforeByte >= beforeByte)
    ) {
      throw new DesktopDiagnosticSourceError(
        "log-line-too-large",
        `Desktop diagnostic log "${desktopDiagnosticLogFileName(input.source)}" contains a line exceeding the ${DESKTOP_DIAGNOSTIC_MAX_SCAN_BYTES}-byte scan boundary.`,
      );
    }

    const pageNewestFirst = matches.slice(0, limit);
    const oldestReturned = pageNewestFirst[pageNewestFirst.length - 1];
    const hasExtraMatch = matches.length > limit;
    const pageHasOlder = hasExtraMatch || scanTruncated;
    const nextBeforeByte = hasExtraMatch ? oldestReturned?.byteOffset : safeResumeBeforeByte;
    const nextCursor =
      pageHasOlder && nextBeforeByte !== undefined
        ? encodeCursor({
            version: CURSOR_VERSION,
            kind: "desktop-log",
            source: input.source,
            filterFingerprint: filters.fingerprint,
            dev: opened.dev,
            ino: opened.ino,
            highWaterSizeBytes,
            beforeByte: nextBeforeByte,
          })
        : undefined;

    const afterStats = await handle.stat({ bigint: true });
    if (
      afterStats.dev.toString() !== opened.dev ||
      afterStats.ino.toString() !== opened.ino ||
      safeStatSize(afterStats.size, desktopDiagnosticLogFileName(input.source)) < highWaterSizeBytes
    ) {
      throw new DesktopDiagnosticSourceError(
        "log-truncated",
        `Desktop diagnostic log "${desktopDiagnosticLogFileName(input.source)}" changed while it was being read; start again without a cursor.`,
      );
    }

    return {
      source: input.source,
      fileName: desktopDiagnosticLogFileName(input.source),
      available: true,
      lines: pageNewestFirst.toReversed(),
      coverage: {
        highWaterSizeBytes,
        beforeByte,
        scannedBytes,
        maxScanBytes: DESKTOP_DIAGNOSTIC_MAX_SCAN_BYTES,
        scanTruncated,
        sourceComplete: !pageHasOlder,
        pageHasOlder,
      },
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  } finally {
    await handle.close();
  }
}
