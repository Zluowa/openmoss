// FILE: providerUsageSnapshot.ts
// Purpose: Read provider-specific local usage archives for recent usage snapshots.

import {
  constants as fsConstants,
  createReadStream,
  type Dir,
  type Dirent,
  type Stats,
} from "node:fs";
import fs from "node:fs/promises";
import nodePath from "node:path";

import type {
  ProviderKind,
  ServerGetProviderUsageSnapshotInput,
  ServerGetProviderUsageSnapshotResult,
  ServerProviderUsageLimit,
  ServerProviderUsageLine,
} from "@synara/contracts";
import { Effect } from "effect";

import { ServerConfig } from "./config";
import { expandProviderAccountHomePath } from "./providerAccountHomePath";
import { ServerSettingsService } from "./serverSettings";

const LOOKBACK_DAYS = 30;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const LOOKBACK_7D_MS = 7 * ONE_DAY_MS;
const LOOKBACK_30D_MS = LOOKBACK_DAYS * ONE_DAY_MS;
const USAGE_CACHE_TTL_MS = 5 * 60_000;
const MAX_CLAUDE_TRANSCRIPT_LINE_BYTES = 1024 * 1024;
const DEFAULT_ARCHIVE_SCAN_LIMITS = {
  // Discovery and stat work are independently bounded; opendir iteration stops
  // before the process materializes an unbounded directory listing.
  maxDirectoryEntries: 4_096,
  maxCandidateFiles: 2_048,
  maxFiles: 2_000,
  // A file may contribute at most 256 KiB and a whole refresh at most 32 MiB.
  // The aggregate budget is shared fairly across selected files, so one giant
  // transcript cannot consume the whole scan before newer peers are inspected.
  maxBytesPerFile: 256 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  // JSON.parse calls are also work: cap them separately from bytes.
  maxRecords: 100_000,
  maxElapsedMs: 500,
  yieldEveryRecords: 128,
  concurrency: 4,
  readChunkBytes: 64 * 1024,
} satisfies ProviderUsageArchiveScanLimits;
const MAX_FILE_SUMMARY_INDEX_ENTRIES = 4_096;

export interface ProviderUsageArchiveScanLimits {
  readonly maxDirectoryEntries: number;
  readonly maxCandidateFiles: number;
  readonly maxFiles: number;
  readonly maxBytesPerFile: number;
  readonly maxTotalBytes: number;
  readonly maxRecords: number;
  readonly maxElapsedMs: number;
  readonly yieldEveryRecords: number;
  readonly concurrency: number;
  readonly readChunkBytes: number;
}
const CODEX_SESSION_READ_CHUNK_BYTES = 64 * 1024;
const MAX_CODEX_SESSION_LINE_BYTES = 1024 * 1024;

type UsageSnapshot = Exclude<ServerGetProviderUsageSnapshotResult, null>;

interface CachedUsageSnapshot {
  expiresAtMs: number;
  value: ServerGetProviderUsageSnapshotResult;
  pending: Promise<ServerGetProviderUsageSnapshotResult> | null;
}

interface CodexSessionSummary {
  timestampMs: number;
  totalTokens: number;
  limits: ReadonlyArray<ServerProviderUsageLimit>;
}

interface ClaudeUsageSample {
  sessionId: string;
  timestampMs: number;
  totalTokens: number;
  model: string | null;
}

interface ArchiveFileCandidate {
  path: string;
  approvedRoot: ApprovedArchiveRootIdentity;
  parentPath: string;
  parentRealPath: string;
  parentDev: number;
  parentIno: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
}

interface ArchiveCandidatePath {
  path: string;
  approvedRoot: ApprovedArchiveRootIdentity;
  parentPath: string;
  parentRealPath: string;
  parentDev: number;
  parentIno: number;
}

interface ValidatedArchiveDirectory {
  path: string;
  realPath: string;
  dev: number;
  ino: number;
}

interface ApprovedArchiveRootIdentity {
  readonly provider: ProviderKind;
  readonly configuredPath: string;
  readonly canonicalPath: string;
  readonly dev: number;
  readonly ino: number;
}

interface ArchiveDirectoryValidationResult {
  directory: ValidatedArchiveDirectory | null;
  incomplete: boolean;
}

interface ArchiveDiscovery {
  candidates: ReadonlyArray<ArchiveFileCandidate>;
  filesDiscovered: number;
  incomplete: boolean;
}

interface ArchiveScanDiagnostics {
  bytesRead: number;
  readOperations: number;
  recordsInspected: number;
  directoryEntriesInspected: number;
  filesOpened: number;
  peakFileReadConcurrency: number;
  maxBytesReadForSingleFile: number;
  maxSingleReadBytes: number;
  fileIndexHits: number;
  elapsedMs: number;
  cooperativeYields: number;
  deadlineExceeded: boolean;
  bytesReadByFile: Record<string, number>;
}

interface ArchiveScanContext {
  readonly limits: ProviderUsageArchiveScanLimits;
  readonly diagnostics: ArchiveScanDiagnostics;
  readonly startedAtMs: number;
  readonly deadlineAtMs: number;
  activeFileReads: number;
}

interface BoundedTailRead {
  text: string;
  startedAtByte: number;
  fileSize: number;
  bytesRead: number;
  unchanged: boolean;
  budgetExhausted: boolean;
}

interface CodexFileScanResult {
  kind: "codex";
  summary: CodexSessionSummary | null;
  resolved: boolean;
}

interface ClaudeFileScanResult {
  kind: "claude";
  samples: ReadonlyArray<ClaudeUsageSample>;
  resolved: boolean;
}

type IndexedArchiveFileResult = CodexFileScanResult | ClaudeFileScanResult;

export interface ProviderUsageArchiveScanTestResult {
  snapshot: ServerGetProviderUsageSnapshotResult;
  diagnostics: Readonly<ArchiveScanDiagnostics>;
}

const usageSnapshotCache = new Map<string, CachedUsageSnapshot>();
const fileSummaryIndex = new Map<string, IndexedArchiveFileResult>();
let providerUsageArchiveScanRuns = 0;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asNonNegativeNumber(value: unknown): number | undefined {
  const parsed = asFiniteNumber(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const timestampMs = Date.parse(value);
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

function toIsoString(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

function formatCompactNumber(value: number): string {
  const absoluteValue = Math.abs(value);
  if (absoluteValue < 1_000) {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
  }
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: absoluteValue < 1_000_000 ? 1 : 0,
  }).format(value);
}

function formatTokenValue(tokens: number): string {
  return `${formatCompactNumber(tokens)} tokens`;
}

function formatRecentSessionsSubtitle(
  sessionCount: number,
  lowerBound: boolean,
): string | undefined {
  if (sessionCount <= 0) {
    return undefined;
  }
  const formatted = new Intl.NumberFormat(undefined).format(sessionCount);
  return lowerBound
    ? `≥${formatted} recent ${sessionCount === 1 ? "session" : "sessions"} found`
    : `${formatted} recent ${sessionCount === 1 ? "session" : "sessions"}`;
}

async function safeLstat(path: string): Promise<Stats | null> {
  try {
    return await fs.lstat(path);
  } catch {
    return null;
  }
}

async function mapWithConcurrency<T, R>(
  items: ReadonlyArray<T>,
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: Array<{ index: number; value: R }> = [];
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) {
          return;
        }
        const item = items[index];
        if (item === undefined) {
          continue;
        }
        results.push({ index, value: await mapper(item) });
      }
    }),
  );

  return results.toSorted((left, right) => left.index - right.index).map((entry) => entry.value);
}

function createArchiveScanDiagnostics(): ArchiveScanDiagnostics {
  return {
    bytesRead: 0,
    readOperations: 0,
    recordsInspected: 0,
    directoryEntriesInspected: 0,
    filesOpened: 0,
    peakFileReadConcurrency: 0,
    maxBytesReadForSingleFile: 0,
    maxSingleReadBytes: 0,
    fileIndexHits: 0,
    elapsedMs: 0,
    cooperativeYields: 0,
    deadlineExceeded: false,
    bytesReadByFile: {},
  };
}

function normalizeArchiveScanLimits(
  limits: ProviderUsageArchiveScanLimits,
): ProviderUsageArchiveScanLimits {
  const positiveInteger = (value: number): number =>
    Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
  const nonNegativeInteger = (value: number): number =>
    Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  return {
    maxDirectoryEntries: positiveInteger(limits.maxDirectoryEntries),
    maxCandidateFiles: positiveInteger(limits.maxCandidateFiles),
    maxFiles: positiveInteger(limits.maxFiles),
    maxBytesPerFile: positiveInteger(limits.maxBytesPerFile),
    maxTotalBytes: positiveInteger(limits.maxTotalBytes),
    maxRecords: positiveInteger(limits.maxRecords),
    maxElapsedMs: nonNegativeInteger(limits.maxElapsedMs),
    yieldEveryRecords: positiveInteger(limits.yieldEveryRecords),
    concurrency: positiveInteger(limits.concurrency),
    readChunkBytes: positiveInteger(limits.readChunkBytes),
  };
}

function archiveScanDeadlineExceeded(context: ArchiveScanContext): boolean {
  if (performance.now() < context.deadlineAtMs) {
    return false;
  }
  context.diagnostics.deadlineExceeded = true;
  return true;
}

async function cooperativeArchiveScanYield(context: ArchiveScanContext): Promise<void> {
  context.diagnostics.cooperativeYields += 1;
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function isPathContainedByRoot(approvedRoot: string, candidate: string): boolean {
  const relative = nodePath.relative(approvedRoot, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${nodePath.sep}`) &&
      !nodePath.isAbsolute(relative))
  );
}

function isMissingPathError(error: unknown): boolean {
  const code = asRecord(error)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function resolveApprovedArchiveRootIdentity(input: {
  provider: ProviderKind;
  path: string;
  context?: ArchiveScanContext;
}): Promise<ApprovedArchiveRootIdentity | null> {
  if (input.context && archiveScanDeadlineExceeded(input.context)) {
    return null;
  }
  try {
    // The configured root itself is authoritative and may legitimately be a
    // symlink. Resolve it once, then perform all discovery from the canonical
    // target without walking or listing any of its parent directories.
    const canonicalPath = await fs.realpath(input.path);
    const stats = await fs.lstat(canonicalPath);
    if (
      (input.context && archiveScanDeadlineExceeded(input.context)) ||
      stats.isSymbolicLink() ||
      !stats.isDirectory()
    ) {
      return null;
    }
    return Object.freeze({
      provider: input.provider,
      configuredPath: input.path,
      canonicalPath,
      dev: stats.dev,
      ino: stats.ino,
    });
  } catch {
    return null;
  }
}

async function validateApprovedArchiveRootIdentity(input: {
  approvedRoot: ApprovedArchiveRootIdentity;
  context: ArchiveScanContext;
}): Promise<boolean> {
  if (archiveScanDeadlineExceeded(input.context)) {
    return false;
  }
  try {
    // Never re-resolve the configured lexical path here. The canonical target
    // selected for this scan also owns its cache and pending single-flight key.
    const canonicalPath = await fs.realpath(input.approvedRoot.canonicalPath);
    const stats = await fs.lstat(input.approvedRoot.canonicalPath);
    return (
      !archiveScanDeadlineExceeded(input.context) &&
      canonicalPath === input.approvedRoot.canonicalPath &&
      !stats.isSymbolicLink() &&
      stats.isDirectory() &&
      stats.dev === input.approvedRoot.dev &&
      stats.ino === input.approvedRoot.ino
    );
  } catch {
    return false;
  }
}

async function validateArchiveDirectoryPath(input: {
  approvedRoot: ApprovedArchiveRootIdentity;
  path: string;
  context: ArchiveScanContext;
}): Promise<ArchiveDirectoryValidationResult> {
  if (
    archiveScanDeadlineExceeded(input.context) ||
    !isPathContainedByRoot(input.approvedRoot.canonicalPath, input.path)
  ) {
    return { directory: null, incomplete: true };
  }
  try {
    const before = await fs.lstat(input.path);
    if (before.isSymbolicLink() || !before.isDirectory()) {
      return { directory: null, incomplete: true };
    }
    const realPath = await fs.realpath(input.path);
    const after = await fs.lstat(input.path);
    if (
      archiveScanDeadlineExceeded(input.context) ||
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      !isPathContainedByRoot(input.approvedRoot.canonicalPath, realPath)
    ) {
      return { directory: null, incomplete: true };
    }
    return {
      directory: {
        path: input.path,
        realPath,
        dev: after.dev,
        ino: after.ino,
      },
      incomplete: false,
    };
  } catch (error) {
    return { directory: null, incomplete: !isMissingPathError(error) };
  }
}

async function validateArchiveDirectoryChain(input: {
  approvedRoot: ApprovedArchiveRootIdentity;
  startPath: string;
  segments: ReadonlyArray<string>;
  context: ArchiveScanContext;
}): Promise<ArchiveDirectoryValidationResult> {
  let currentPath = input.startPath;
  let finalDirectory: ValidatedArchiveDirectory | null = null;
  for (const segment of input.segments) {
    if (archiveScanDeadlineExceeded(input.context)) {
      return { directory: null, incomplete: true };
    }
    currentPath = nodePath.join(currentPath, segment);
    const validated = await validateArchiveDirectoryPath({
      approvedRoot: input.approvedRoot,
      path: currentPath,
      context: input.context,
    });
    if (!validated.directory) {
      return validated;
    }
    finalDirectory = validated.directory;
    currentPath = validated.directory.realPath;
  }
  return { directory: finalDirectory, incomplete: false };
}

async function revalidateCandidateParent(input: {
  candidate: ArchiveFileCandidate;
  context: ArchiveScanContext;
}): Promise<boolean> {
  if (
    !(await validateApprovedArchiveRootIdentity({
      approvedRoot: input.candidate.approvedRoot,
      context: input.context,
    }))
  ) {
    return false;
  }
  const validated = await validateArchiveDirectoryPath({
    approvedRoot: input.candidate.approvedRoot,
    path: input.candidate.parentPath,
    context: input.context,
  });
  const parent = validated.directory;
  return Boolean(
    parent &&
    parent.realPath === input.candidate.parentRealPath &&
    parent.dev === input.candidate.parentDev &&
    parent.ino === input.candidate.parentIno,
  );
}

async function safeOpenDir(path: string): Promise<Dir | null> {
  try {
    return await fs.opendir(path);
  } catch {
    return null;
  }
}

async function closeDirQuietly(directory: Dir): Promise<void> {
  try {
    await directory.close();
  } catch {
    // Iteration closes an exhausted directory automatically.
  }
}

async function collectBoundedDirectoryEntries(input: {
  path: string;
  context: ArchiveScanContext;
  visit: (entry: Dirent) => boolean | void | Promise<boolean | void>;
}): Promise<{ opened: boolean; incomplete: boolean }> {
  if (archiveScanDeadlineExceeded(input.context)) {
    return { opened: false, incomplete: true };
  }
  const directory = await safeOpenDir(input.path);
  if (!directory) {
    return { opened: false, incomplete: false };
  }

  let incomplete = false;
  try {
    while (true) {
      if (archiveScanDeadlineExceeded(input.context)) {
        incomplete = true;
        break;
      }
      if (
        input.context.diagnostics.directoryEntriesInspected >=
        input.context.limits.maxDirectoryEntries
      ) {
        // Conservatively mark an exact-at-budget directory partial: determining
        // whether another entry exists would itself exceed the work budget.
        incomplete = true;
        break;
      }
      const next = await directory.read();
      if (!next) {
        break;
      }
      input.context.diagnostics.directoryEntriesInspected += 1;
      if ((await input.visit(next)) === false) {
        incomplete = true;
        break;
      }
    }
  } catch {
    incomplete = true;
  } finally {
    await closeDirQuietly(directory);
  }
  return { opened: true, incomplete };
}

async function statAndSortRecentCandidates(input: {
  paths: ReadonlyArray<ArchiveCandidatePath>;
  context: ArchiveScanContext;
}): Promise<{ candidates: ReadonlyArray<ArchiveFileCandidate>; incomplete: boolean }> {
  const stats = await mapWithConcurrency(
    input.paths,
    input.context.limits.concurrency,
    async (candidatePath): Promise<ArchiveFileCandidate | null> => {
      if (archiveScanDeadlineExceeded(input.context)) {
        return null;
      }
      const value = await safeLstat(candidatePath.path);
      if (!value || !value.isFile()) {
        return null;
      }
      return {
        ...candidatePath,
        size: value.size,
        mtimeMs: value.mtimeMs,
        ctimeMs: value.ctimeMs,
        dev: value.dev,
        ino: value.ino,
      };
    },
  );
  const candidates = stats
    .filter((candidate): candidate is ArchiveFileCandidate => candidate !== null)
    .toSorted((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path));
  return { candidates, incomplete: candidates.length !== input.paths.length };
}

function allocateFileByteBudgets(input: {
  fileCount: number;
  limits: ProviderUsageArchiveScanLimits;
}): number[] {
  let bytesRemaining = input.limits.maxTotalBytes;
  return Array.from({ length: input.fileCount }, (_, index) => {
    const filesRemaining = input.fileCount - index;
    const fairShare = Math.floor(bytesRemaining / filesRemaining);
    const allocation = Math.min(input.limits.maxBytesPerFile, fairShare);
    bytesRemaining -= allocation;
    return allocation;
  });
}

function fileIndexKey(input: {
  provider: "codex" | "claude";
  candidate: ArchiveFileCandidate;
  byteBudget: number;
}): string {
  const candidate = input.candidate;
  return [
    input.provider,
    candidate.path,
    candidate.size,
    candidate.mtimeMs,
    candidate.ctimeMs,
    candidate.dev,
    candidate.ino,
    input.byteBudget,
  ].join(":");
}

function writeFileSummaryIndex(key: string, value: IndexedArchiveFileResult): void {
  if (fileSummaryIndex.size >= MAX_FILE_SUMMARY_INDEX_ENTRIES) {
    const oldestKey = fileSummaryIndex.keys().next().value;
    if (typeof oldestKey === "string") {
      fileSummaryIndex.delete(oldestKey);
    }
  }
  fileSummaryIndex.set(key, value);
}

function buildUsageLines(input: {
  tokens24h: number;
  tokens7d: number;
  tokens30d: number;
  sessions24h: number;
  sessions7d: number;
  sessions30d: number;
  lowerBound: boolean;
}): ReadonlyArray<ServerProviderUsageLine> {
  const tokenValue = (tokens: number): string =>
    `${input.lowerBound ? "≥" : ""}${formatTokenValue(tokens)}`;
  return [
    {
      label: "24h",
      value: tokenValue(input.tokens24h),
      ...(formatRecentSessionsSubtitle(input.sessions24h, input.lowerBound)
        ? { subtitle: formatRecentSessionsSubtitle(input.sessions24h, input.lowerBound) }
        : {}),
    },
    {
      label: "7d",
      value: tokenValue(input.tokens7d),
      ...(formatRecentSessionsSubtitle(input.sessions7d, input.lowerBound)
        ? { subtitle: formatRecentSessionsSubtitle(input.sessions7d, input.lowerBound) }
        : {}),
    },
    {
      label: "30d",
      value: tokenValue(input.tokens30d),
      ...(formatRecentSessionsSubtitle(input.sessions30d, input.lowerBound)
        ? { subtitle: formatRecentSessionsSubtitle(input.sessions30d, input.lowerBound) }
        : {}),
    },
  ];
}

function normalizeCodexUsageLimits(value: unknown): ReadonlyArray<ServerProviderUsageLimit> {
  const rateLimits = asRecord(value);
  if (!rateLimits) {
    return [];
  }

  const parseLimit = (
    label: string,
    source: Record<string, unknown> | null,
  ): ServerProviderUsageLimit | null => {
    if (!source) {
      return null;
    }

    const usedPercent = asNonNegativeNumber(source.used_percent ?? source.usedPercent);
    const windowDurationMins = asNonNegativeNumber(source.window_minutes ?? source.windowMinutes);
    const resetsAt =
      asString(source.resets_at ?? source.resetsAt) ??
      asString(source.next_reset_at ?? source.nextResetAt);
    if (usedPercent === undefined && windowDurationMins === undefined && !resetsAt) {
      return null;
    }

    return {
      window: label,
      ...(usedPercent !== undefined ? { usedPercent } : {}),
      ...(windowDurationMins !== undefined ? { windowDurationMins } : {}),
      ...(resetsAt ? { resetsAt } : {}),
    };
  };

  const primary = parseLimit("5h", asRecord(rateLimits.primary));
  const secondary = parseLimit("Weekly", asRecord(rateLimits.secondary));

  return [primary, secondary].filter((limit): limit is ServerProviderUsageLimit => limit !== null);
}

function readCodexTotalTokens(payload: Record<string, unknown>): number {
  const info = asRecord(payload.info);
  const totalUsage =
    asRecord(info?.total_token_usage) ??
    asRecord(info?.totalTokenUsage) ??
    asRecord(info?.total) ??
    asRecord(payload.total_token_usage) ??
    asRecord(payload.totalTokenUsage) ??
    asRecord(payload.total);

  return (
    asNonNegativeNumber(totalUsage?.total_tokens) ??
    asNonNegativeNumber(totalUsage?.totalTokens) ??
    asNonNegativeNumber(info?.total_tokens) ??
    asNonNegativeNumber(info?.totalTokens) ??
    asNonNegativeNumber(payload.total_tokens) ??
    asNonNegativeNumber(payload.totalTokens) ??
    0
  );
}

function resolveCodexHomeDir(input: { homeDir: string; homePath?: string }): string {
  const configuredPath =
    input.homePath?.trim() || process.env.CODEX_HOME || nodePath.join(input.homeDir, ".codex");
  return nodePath.resolve(configuredPath);
}

async function discoverRecentCodexSessionFiles(input: {
  approvedRoot: ApprovedArchiveRootIdentity;
  nowMs: number;
  context: ArchiveScanContext;
}): Promise<ArchiveDiscovery> {
  const paths: ArchiveCandidatePath[] = [];
  let incomplete = false;
  const now = new Date(input.nowMs);
  const sessions = await validateArchiveDirectoryChain({
    approvedRoot: input.approvedRoot,
    startPath: input.approvedRoot.canonicalPath,
    segments: ["sessions"],
    context: input.context,
  });
  if (!sessions.directory) {
    return { candidates: [], filesDiscovered: 0, incomplete: sessions.incomplete };
  }

  for (let offset = 0; offset <= LOOKBACK_DAYS; offset += 1) {
    if (
      archiveScanDeadlineExceeded(input.context) ||
      paths.length >= input.context.limits.maxCandidateFiles ||
      input.context.diagnostics.directoryEntriesInspected >=
        input.context.limits.maxDirectoryEntries
    ) {
      incomplete = true;
      break;
    }
    const current = new Date(now);
    current.setDate(now.getDate() - offset);
    const day = await validateArchiveDirectoryChain({
      approvedRoot: input.approvedRoot,
      startPath: sessions.directory.realPath,
      segments: [
        `${current.getFullYear()}`,
        `${String(current.getMonth() + 1).padStart(2, "0")}`,
        `${String(current.getDate()).padStart(2, "0")}`,
      ],
      context: input.context,
    });
    if (!day.directory) {
      incomplete ||= day.incomplete;
      if (day.incomplete) {
        break;
      }
      continue;
    }
    const collected = await collectBoundedDirectoryEntries({
      path: day.directory.realPath,
      context: input.context,
      visit: (entry) => {
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          paths.push({
            path: nodePath.join(day.directory!.realPath, entry.name),
            approvedRoot: input.approvedRoot,
            parentPath: day.directory!.path,
            parentRealPath: day.directory!.realPath,
            parentDev: day.directory!.dev,
            parentIno: day.directory!.ino,
          });
          if (paths.length >= input.context.limits.maxCandidateFiles) {
            return false;
          }
        }
      },
    });
    incomplete ||= collected.incomplete;
    if (collected.incomplete) {
      break;
    }
  }

  const statResult = await statAndSortRecentCandidates({ paths, context: input.context });
  return {
    candidates: statResult.candidates,
    filesDiscovered: paths.length,
    incomplete: incomplete || statResult.incomplete,
  };
}

async function readBoundedFileTail(input: {
  candidate: ArchiveFileCandidate;
  byteBudget: number;
  context: ArchiveScanContext;
}): Promise<BoundedTailRead | null> {
  if (archiveScanDeadlineExceeded(input.context)) {
    return null;
  }
  const bytesToRead = Math.min(input.candidate.size, input.byteBudget);
  if (bytesToRead <= 0) {
    return null;
  }

  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  input.context.activeFileReads += 1;
  input.context.diagnostics.peakFileReadConcurrency = Math.max(
    input.context.diagnostics.peakFileReadConcurrency,
    input.context.activeFileReads,
  );
  try {
    handle = await fs.open(input.candidate.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    input.context.diagnostics.filesOpened += 1;
    const initialStats = await handle.stat();
    if (
      !initialStats.isFile() ||
      initialStats.dev !== input.candidate.dev ||
      initialStats.ino !== input.candidate.ino ||
      initialStats.size !== input.candidate.size ||
      initialStats.mtimeMs !== input.candidate.mtimeMs
    ) {
      return null;
    }
    const startedAtByte = Math.max(0, input.candidate.size - bytesToRead);
    const target = Buffer.allocUnsafe(bytesToRead);
    let totalRead = 0;
    let budgetExhausted = false;
    while (totalRead < bytesToRead) {
      if (archiveScanDeadlineExceeded(input.context)) {
        budgetExhausted = true;
        break;
      }
      const requestedBytes = Math.min(input.context.limits.readChunkBytes, bytesToRead - totalRead);
      const { bytesRead } = await handle.read(
        target,
        totalRead,
        requestedBytes,
        startedAtByte + totalRead,
      );
      if (bytesRead <= 0) {
        break;
      }
      totalRead += bytesRead;
      input.context.diagnostics.bytesRead += bytesRead;
      input.context.diagnostics.readOperations += 1;
      input.context.diagnostics.maxSingleReadBytes = Math.max(
        input.context.diagnostics.maxSingleReadBytes,
        bytesRead,
      );
      input.context.diagnostics.bytesReadByFile[input.candidate.path] = totalRead;
    }
    input.context.diagnostics.maxBytesReadForSingleFile = Math.max(
      input.context.diagnostics.maxBytesReadForSingleFile,
      totalRead,
    );
    const finalStats = await handle.stat();
    budgetExhausted ||= archiveScanDeadlineExceeded(input.context);
    return {
      text: target.subarray(0, totalRead).toString("utf8"),
      startedAtByte,
      fileSize: input.candidate.size,
      bytesRead: totalRead,
      unchanged:
        finalStats.isFile() &&
        finalStats.dev === input.candidate.dev &&
        finalStats.ino === input.candidate.ino &&
        finalStats.size === input.candidate.size &&
        finalStats.mtimeMs === input.candidate.mtimeMs,
      budgetExhausted,
    };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
    input.context.activeFileReads -= 1;
  }
}

function completeJsonlLines(tail: BoundedTailRead): string[] {
  const lines = tail.text.split(/\r?\n/u);
  if (tail.startedAtByte > 0 && !tail.text.startsWith("\n") && !tail.text.startsWith("\r\n")) {
    // A bounded tail usually begins inside an older record. Never parse that
    // fragment as though it were a complete JSONL row.
    lines.shift();
  }
  return lines;
}

async function claimRecordWork(context: ArchiveScanContext): Promise<boolean> {
  if (
    archiveScanDeadlineExceeded(context) ||
    context.diagnostics.recordsInspected >= context.limits.maxRecords
  ) {
    return false;
  }
  if (
    context.diagnostics.recordsInspected > 0 &&
    context.diagnostics.recordsInspected % context.limits.yieldEveryRecords === 0
  ) {
    await cooperativeArchiveScanYield(context);
    if (
      archiveScanDeadlineExceeded(context) ||
      context.diagnostics.recordsInspected >= context.limits.maxRecords
    ) {
      return false;
    }
  }
  context.diagnostics.recordsInspected += 1;
  return true;
}

async function readCodexSessionSummaryCandidate(input: {
  candidate: ArchiveFileCandidate;
  byteBudget: number;
  context: ArchiveScanContext;
}): Promise<CodexFileScanResult> {
  if (archiveScanDeadlineExceeded(input.context)) {
    return {
      kind: "codex",
      summary: null,
      resolved: false,
    };
  }
  if (!(await revalidateCandidateParent(input))) {
    return {
      kind: "codex",
      summary: null,
      resolved: false,
    };
  }
  const indexKey = fileIndexKey({
    provider: "codex",
    candidate: input.candidate,
    byteBudget: input.byteBudget,
  });
  const indexed = fileSummaryIndex.get(indexKey);
  if (indexed?.kind === "codex") {
    input.context.diagnostics.fileIndexHits += 1;
    return indexed;
  }

  const tail = await readBoundedFileTail(input);
  if (!tail) {
    return {
      kind: "codex",
      summary: null,
      resolved: false,
    };
  }

  const lines = completeJsonlLines(tail);
  let workBudgetExhausted = false;
  let summary: CodexSessionSummary | null = null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line || !line.trim()) {
      continue;
    }
    if (!(await claimRecordWork(input.context))) {
      workBudgetExhausted = true;
      break;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const record = asRecord(parsed);
    if (!record || record.type !== "event_msg") {
      continue;
    }
    const payload = asRecord(record.payload);
    if (!payload || payload.type !== "token_count") {
      continue;
    }
    const timestampMs = parseTimestampMs(record.timestamp ?? payload.timestamp);
    if (timestampMs === null) {
      continue;
    }
    summary = {
      timestampMs,
      totalTokens: readCodexTotalTokens(payload),
      limits: normalizeCodexUsageLimits(payload.rate_limits ?? payload.rateLimits),
    };
    break;
  }

  // Codex token_count rows are cumulative and chronological. Finding the first
  // one while walking backward fully resolves that session even if the older
  // prefix was outside the byte budget.
  workBudgetExhausted ||= archiveScanDeadlineExceeded(input.context);
  const resolved =
    tail.unchanged &&
    !tail.budgetExhausted &&
    (summary !== null || (tail.startedAtByte === 0 && !workBudgetExhausted));
  const result = {
    kind: "codex",
    summary,
    resolved,
  } satisfies CodexFileScanResult;
  if (tail.unchanged && !tail.budgetExhausted && !workBudgetExhausted) {
    writeFileSummaryIndex(indexKey, result);
  }
  return result;
}

async function readFileRange(
  handle: Awaited<ReturnType<typeof fs.open>>,
  position: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let bytesRead = 0;
  while (bytesRead < length) {
    const result = await handle.read(buffer, bytesRead, length - bytesRead, position + bytesRead);
    if (result.bytesRead === 0) {
      break;
    }
    bytesRead += result.bytesRead;
  }
  return buffer.subarray(0, bytesRead);
}

function parseCodexSessionSummaryLine(line: string): CodexSessionSummary | null {
  if (!line.trim()) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  const record = asRecord(parsed);
  if (!record || record.type !== "event_msg") {
    return null;
  }

  const payload = asRecord(record.payload);
  if (!payload || payload.type !== "token_count") {
    return null;
  }

  const timestampMs = parseTimestampMs(record.timestamp ?? payload.timestamp);
  if (timestampMs === null) {
    return null;
  }

  return {
    timestampMs,
    totalTokens: readCodexTotalTokens(payload),
    limits: normalizeCodexUsageLimits(payload.rate_limits ?? payload.rateLimits),
  };
}

export async function readCodexSessionSummary(path: string): Promise<CodexSessionSummary | null> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(path, "r");
  } catch {
    return null;
  }

  try {
    const { size } = await handle.stat();
    let position = size;
    let partialLine = Buffer.alloc(0);
    let skippingOversizedLine = false;

    while (position > 0) {
      const length = Math.min(CODEX_SESSION_READ_CHUNK_BYTES, position);
      position -= length;
      const bytes = await readFileRange(handle, position, length);
      let lineEnd = bytes.length;

      for (let index = bytes.length - 1; index >= 0; index -= 1) {
        if (bytes[index] !== 0x0a) {
          continue;
        }

        const linePrefix = bytes.subarray(index + 1, lineEnd);
        if (skippingOversizedLine) {
          skippingOversizedLine = false;
        } else {
          const lineLength = linePrefix.length + partialLine.length;
          if (lineLength <= MAX_CODEX_SESSION_LINE_BYTES) {
            const summary = parseCodexSessionSummaryLine(
              Buffer.concat([linePrefix, partialLine], lineLength).toString("utf8"),
            );
            if (summary) {
              return summary;
            }
          }
        }

        partialLine = Buffer.alloc(0);
        lineEnd = index;
      }

      if (skippingOversizedLine) {
        continue;
      }

      const linePrefix = bytes.subarray(0, lineEnd);
      const lineLength = linePrefix.length + partialLine.length;
      if (lineLength > MAX_CODEX_SESSION_LINE_BYTES) {
        partialLine = Buffer.alloc(0);
        skippingOversizedLine = true;
        continue;
      }
      partialLine = Buffer.concat([linePrefix, partialLine], lineLength);
    }

    return skippingOversizedLine
      ? null
      : parseCodexSessionSummaryLine(partialLine.toString("utf8"));
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function readClaudeTotalTokens(value: unknown): number {
  const usage = asRecord(value);
  if (!usage) {
    return 0;
  }

  const inputTokens =
    (asNonNegativeNumber(usage.input_tokens) ?? 0) +
    (asNonNegativeNumber(usage.cache_creation_input_tokens) ?? 0) +
    (asNonNegativeNumber(usage.cache_read_input_tokens) ?? 0);
  const outputTokens = asNonNegativeNumber(usage.output_tokens) ?? 0;
  return asNonNegativeNumber(usage.total_tokens) ?? inputTokens + outputTokens;
}

function readClaudeAssistantSample(input: {
  record: Record<string, unknown>;
  fallbackKey: string;
}): { dedupeKey: string; sample: ClaudeUsageSample } | null {
  if (input.record.type !== "assistant") {
    return null;
  }

  const message = asRecord(input.record.message);
  const usage = asRecord(message?.usage);
  const totalTokens = readClaudeTotalTokens(usage);
  const timestampMs = parseTimestampMs(input.record.timestamp);
  if (!usage || totalTokens <= 0 || timestampMs === null) {
    return null;
  }

  const sessionId = asString(input.record.sessionId) ?? input.fallbackKey;
  const model = asString(message?.model) ?? null;
  const dedupeKey =
    `${sessionId}:assistant:` +
    (asString(input.record.requestId) ??
      asString(message?.id) ??
      asString(input.record.uuid) ??
      input.fallbackKey);

  return {
    dedupeKey,
    sample: {
      sessionId,
      timestampMs,
      totalTokens,
      model,
    },
  };
}

function readClaudeToolResultSample(input: {
  record: Record<string, unknown>;
  fallbackKey: string;
}): { dedupeKey: string; sample: ClaudeUsageSample } | null {
  const toolUseResult = asRecord(input.record.toolUseResult);
  const usage = asRecord(toolUseResult?.usage);
  const totalTokens = readClaudeTotalTokens(usage);
  const timestampMs = parseTimestampMs(input.record.timestamp);
  if (!toolUseResult || !usage || totalTokens <= 0 || timestampMs === null) {
    return null;
  }

  const sessionId = asString(input.record.sessionId) ?? input.fallbackKey;
  const dedupeKey =
    `${sessionId}:tool-result:` +
    (asString(input.record.uuid) ??
      asString(toolUseResult.agentId) ??
      asString(input.record.requestId) ??
      input.fallbackKey);

  return {
    dedupeKey,
    sample: {
      sessionId,
      timestampMs,
      totalTokens,
      model: null,
    },
  };
}

// Claude Code stores transcripts under `<CLAUDE_CONFIG_DIR>/projects`, defaulting to
// `~/.claude/projects`. Honor the override so the Profile reads the SAME transcripts
// the active Claude provider does (the adapter inherits `process.env`).
function resolveClaudeProjectsRoot(input: { homeDir: string; homePath?: string }): string {
  const configuredHome = input.homePath?.trim();
  if (configuredHome) {
    // The legacy Claude provider setting is an account HOME (the same value
    // passed to buildClaudeProcessEnv), not CLAUDE_CONFIG_DIR itself. An
    // explicit account home deliberately takes precedence over ambient
    // CLAUDE_CONFIG_DIR inherited by the Moss server process.
    return nodePath.join(
      expandProviderAccountHomePath(configuredHome, input.homeDir),
      ".claude",
      "projects",
    );
  }
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  return nodePath.join(configDir || nodePath.join(input.homeDir, ".claude"), "projects");
}

function resolveConfiguredArchiveRoot(input: {
  provider: ProviderKind;
  homeDir: string;
  homePath?: string;
}): string | null {
  switch (input.provider) {
    case "codex":
      return resolveCodexHomeDir(input);
    case "claudeAgent":
      return nodePath.resolve(resolveClaudeProjectsRoot(input));
    case "gemini":
    case "antigravity":
    case "cursor":
    case "grok":
    case "devin":
    case "droid":
    case "kilo":
    case "opencode":
    case "pi":
    default:
      return null;
  }
}

async function discoverRecentClaudeTranscriptFiles(input: {
  approvedRoot: ApprovedArchiveRootIdentity;
  context: ArchiveScanContext;
}): Promise<ArchiveDiscovery> {
  const paths: ArchiveCandidatePath[] = [];
  let incomplete = false;
  if (archiveScanDeadlineExceeded(input.context)) {
    return { candidates: [], filesDiscovered: 0, incomplete: true };
  }
  const projects = await collectBoundedDirectoryEntries({
    path: input.approvedRoot.canonicalPath,
    context: input.context,
    visit: async (projectEntry) => {
      if (projectEntry.isSymbolicLink()) {
        incomplete = true;
        return false;
      }
      if (!projectEntry.isDirectory()) {
        return;
      }
      const project = await validateArchiveDirectoryChain({
        approvedRoot: input.approvedRoot,
        startPath: input.approvedRoot.canonicalPath,
        segments: [projectEntry.name],
        context: input.context,
      });
      if (!project.directory) {
        incomplete = true;
        return false;
      }
      const transcripts = await collectBoundedDirectoryEntries({
        path: project.directory.realPath,
        context: input.context,
        visit: (transcriptEntry) => {
          if (transcriptEntry.isFile() && transcriptEntry.name.endsWith(".jsonl")) {
            paths.push({
              path: nodePath.join(project.directory!.realPath, transcriptEntry.name),
              approvedRoot: input.approvedRoot,
              parentPath: project.directory!.path,
              parentRealPath: project.directory!.realPath,
              parentDev: project.directory!.dev,
              parentIno: project.directory!.ino,
            });
            if (paths.length >= input.context.limits.maxCandidateFiles) {
              return false;
            }
          }
        },
      });
      incomplete ||= transcripts.incomplete;
      if (
        transcripts.incomplete ||
        paths.length >= input.context.limits.maxCandidateFiles ||
        input.context.diagnostics.directoryEntriesInspected >=
          input.context.limits.maxDirectoryEntries
      ) {
        return false;
      }
    },
  });
  incomplete ||= projects.incomplete;

  const statResult = await statAndSortRecentCandidates({ paths, context: input.context });
  return {
    candidates: statResult.candidates,
    filesDiscovered: paths.length,
    incomplete: incomplete || statResult.incomplete,
  };
}

/**
 * Stream a complete Claude transcript without materializing the file in memory.
 * This helper backs focused regression tests and callers that intentionally need
 * the whole file; the snapshot scanner below additionally enforces global byte,
 * record, elapsed-time, and candidate budgets.
 */
export async function readClaudeUsageSamples(
  path: string,
): Promise<ReadonlyArray<ClaudeUsageSample>> {
  const samples: ClaudeUsageSample[] = [];
  const seenKeys = new Set<string>();
  const stream = createReadStream(path);
  let lineChunks: Buffer[] = [];
  let lineBytes = 0;
  let lineIndex = 0;
  let skippingOversizedLine = false;

  const collectLine = (line: Buffer, index: number): void => {
    if (line.length === 0) return;
    const contents = line.toString("utf8");
    if (!contents.trim()) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      return;
    }
    const record = asRecord(parsed);
    if (!record) return;

    const fallbackKey = `${path}:${index}`;
    const assistantSample = readClaudeAssistantSample({ record, fallbackKey });
    if (assistantSample && !seenKeys.has(assistantSample.dedupeKey)) {
      seenKeys.add(assistantSample.dedupeKey);
      samples.push(assistantSample.sample);
    }
    const toolResultSample = readClaudeToolResultSample({ record, fallbackKey });
    if (toolResultSample && !seenKeys.has(toolResultSample.dedupeKey)) {
      seenKeys.add(toolResultSample.dedupeKey);
      samples.push(toolResultSample.sample);
    }
  };

  const appendLineChunk = (chunk: Buffer): void => {
    if (skippingOversizedLine || chunk.length === 0) return;
    if (lineBytes + chunk.length > MAX_CLAUDE_TRANSCRIPT_LINE_BYTES) {
      lineChunks = [];
      lineBytes = 0;
      skippingOversizedLine = true;
      return;
    }
    lineChunks.push(chunk);
    lineBytes += chunk.length;
  };

  const finishLine = (): void => {
    if (!skippingOversizedLine) {
      collectLine(Buffer.concat(lineChunks, lineBytes), lineIndex);
    }
    lineChunks = [];
    lineBytes = 0;
    lineIndex += 1;
    skippingOversizedLine = false;
  };

  try {
    for await (const chunk of stream) {
      let lineStart = 0;
      for (let index = 0; index < chunk.length; index += 1) {
        if (chunk[index] !== 0x0a) continue;
        appendLineChunk(chunk.subarray(lineStart, index));
        finishLine();
        lineStart = index + 1;
      }
      appendLineChunk(chunk.subarray(lineStart));
    }
    if (lineBytes > 0 && !skippingOversizedLine) {
      collectLine(Buffer.concat(lineChunks, lineBytes), lineIndex);
    }
  } catch {
    // A transcript that vanishes or fails partway through yields the complete
    // records read before the failure, like a truncated archive.
  } finally {
    stream.destroy();
  }

  return samples;
}

async function readClaudeUsageSamplesFromCandidate(input: {
  candidate: ArchiveFileCandidate;
  byteBudget: number;
  context: ArchiveScanContext;
}): Promise<ClaudeFileScanResult> {
  if (archiveScanDeadlineExceeded(input.context)) {
    return {
      kind: "claude",
      samples: [],
      resolved: false,
    };
  }
  if (!(await revalidateCandidateParent(input))) {
    return {
      kind: "claude",
      samples: [],
      resolved: false,
    };
  }
  const indexKey = fileIndexKey({
    provider: "claude",
    candidate: input.candidate,
    byteBudget: input.byteBudget,
  });
  const indexed = fileSummaryIndex.get(indexKey);
  if (indexed?.kind === "claude") {
    input.context.diagnostics.fileIndexHits += 1;
    return indexed;
  }

  const tail = await readBoundedFileTail(input);
  if (!tail) {
    return {
      kind: "claude",
      samples: [],
      resolved: false,
    };
  }
  const samples: ClaudeUsageSample[] = [];
  const seenKeys = new Set<string>();
  const lines = completeJsonlLines(tail);
  let workBudgetExhausted = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || !line.trim()) continue;
    if (!(await claimRecordWork(input.context))) {
      workBudgetExhausted = true;
      break;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    if (!record) continue;

    const fallbackKey = `${input.candidate.path}:${tail.startedAtByte}:${index}`;
    const assistantSample = readClaudeAssistantSample({ record, fallbackKey });
    if (assistantSample && !seenKeys.has(assistantSample.dedupeKey)) {
      seenKeys.add(assistantSample.dedupeKey);
      samples.push(assistantSample.sample);
    }
    const toolResultSample = readClaudeToolResultSample({ record, fallbackKey });
    if (toolResultSample && !seenKeys.has(toolResultSample.dedupeKey)) {
      seenKeys.add(toolResultSample.dedupeKey);
      samples.push(toolResultSample.sample);
    }
  }

  // Claude rows are per-message rather than cumulative, so a tail is exact only
  // when the complete file fit in the byte/work budget.
  workBudgetExhausted ||= archiveScanDeadlineExceeded(input.context);
  const resolved =
    tail.unchanged && !tail.budgetExhausted && tail.startedAtByte === 0 && !workBudgetExhausted;
  const result = {
    kind: "claude",
    samples,
    resolved,
  } satisfies ClaudeFileScanResult;
  if (tail.unchanged && !tail.budgetExhausted && !workBudgetExhausted) {
    writeFileSummaryIndex(indexKey, result);
  }
  return result;
}

const INCOMPLETE_ARCHIVE_DETAIL =
  "Local archive totals are lower bounds because the bounded scan could not inspect every eligible archive entry.";

function archiveScanCoverage(input: {
  discovery: ArchiveDiscovery;
  selectedCount: number;
  results: ReadonlyArray<IndexedArchiveFileResult>;
  context: ArchiveScanContext;
}): NonNullable<UsageSnapshot["archiveScan"]> {
  const filesResolved = input.results.filter((result) => result.resolved).length;
  const complete =
    !input.discovery.incomplete &&
    input.selectedCount === input.discovery.candidates.length &&
    input.results.length === input.selectedCount &&
    filesResolved === input.selectedCount;
  return {
    complete,
    filesDiscovered: input.discovery.filesDiscovered,
    filesSelected: input.selectedCount,
    filesResolved,
    filesIncomplete: Math.max(
      input.discovery.filesDiscovered - filesResolved,
      input.discovery.incomplete ? 1 : 0,
    ),
    // These are work counters for this scan. An unchanged in-memory index hit
    // legitimately resolves a file while contributing zero current I/O/parse work.
    bytesRead: input.context.diagnostics.bytesRead,
    recordsInspected: input.context.diagnostics.recordsInspected,
  };
}

function emptyIncompleteArchiveSnapshot(input: {
  provider: "codex" | "claudeAgent";
  source: string;
  nowMs: number;
  context: ArchiveScanContext;
}): UsageSnapshot {
  return {
    provider: input.provider,
    updatedAt: toIsoString(input.nowMs),
    limits: [],
    usageLines: [],
    source: input.source,
    detail: INCOMPLETE_ARCHIVE_DETAIL,
    archiveScan: archiveScanCoverage({
      discovery: { candidates: [], filesDiscovered: 0, incomplete: true },
      selectedCount: 0,
      results: [],
      context: input.context,
    }),
  };
}

async function loadCodexUsageSnapshot(input: {
  approvedRoot: ApprovedArchiveRootIdentity | null;
  nowMs: number;
  context: ArchiveScanContext;
}): Promise<UsageSnapshot | null> {
  if (
    !input.approvedRoot ||
    input.approvedRoot.provider !== "codex" ||
    !(await validateApprovedArchiveRootIdentity({
      approvedRoot: input.approvedRoot,
      context: input.context,
    }))
  ) {
    return input.context.diagnostics.deadlineExceeded
      ? emptyIncompleteArchiveSnapshot({
          provider: "codex",
          source: "codex-session-archive",
          nowMs: input.nowMs,
          context: input.context,
        })
      : null;
  }
  const discovery = await discoverRecentCodexSessionFiles({
    approvedRoot: input.approvedRoot,
    nowMs: input.nowMs,
    context: input.context,
  });
  if (discovery.filesDiscovered === 0 && !discovery.incomplete) {
    return null;
  }
  const selected = discovery.candidates.slice(0, input.context.limits.maxFiles);
  const allocations = allocateFileByteBudgets({
    fileCount: selected.length,
    limits: input.context.limits,
  });
  const results = await mapWithConcurrency(
    selected.map((candidate, index) => ({
      candidate,
      byteBudget: allocations[index] ?? 0,
    })),
    input.context.limits.concurrency,
    async (file) => readCodexSessionSummaryCandidate({ ...file, context: input.context }),
  );
  const archiveScan = archiveScanCoverage({
    discovery,
    selectedCount: selected.length,
    results,
    context: input.context,
  });
  const sessionSummaries = results.flatMap((result) => (result.summary ? [result.summary] : []));
  if (sessionSummaries.length === 0 && archiveScan.complete) {
    return null;
  }

  const latestSummary = sessionSummaries.reduce<CodexSessionSummary | null>(
    (latest, current) => (!latest || current.timestampMs > latest.timestampMs ? current : latest),
    null,
  );
  const fallbackTimestampMs = selected[0]?.mtimeMs ?? input.nowMs;
  const cutoff24h = input.nowMs - ONE_DAY_MS;
  const cutoff7d = input.nowMs - LOOKBACK_7D_MS;
  const cutoff30d = input.nowMs - LOOKBACK_30D_MS;

  const recent24h = sessionSummaries.filter((summary) => summary.timestampMs >= cutoff24h);
  const recent7d = sessionSummaries.filter((summary) => summary.timestampMs >= cutoff7d);
  const recent30d = sessionSummaries.filter((summary) => summary.timestampMs >= cutoff30d);

  return {
    provider: "codex",
    updatedAt: toIsoString(latestSummary?.timestampMs ?? fallbackTimestampMs),
    // A partial discovery cannot prove which file has the newest quota event.
    // Keep lower-bound token totals, but omit quota limits rather than surface
    // a potentially stale value as current.
    limits: archiveScan.complete ? (latestSummary?.limits ?? []) : [],
    usageLines:
      sessionSummaries.length > 0
        ? buildUsageLines({
            tokens24h: recent24h.reduce((total, summary) => total + summary.totalTokens, 0),
            tokens7d: recent7d.reduce((total, summary) => total + summary.totalTokens, 0),
            tokens30d: recent30d.reduce((total, summary) => total + summary.totalTokens, 0),
            sessions24h: recent24h.length,
            sessions7d: recent7d.length,
            sessions30d: recent30d.length,
            lowerBound: !archiveScan.complete,
          })
        : [],
    source: "codex-session-archive",
    archiveScan,
    ...(!archiveScan.complete ? { detail: INCOMPLETE_ARCHIVE_DETAIL } : {}),
  };
}

async function loadClaudeUsageSnapshot(input: {
  approvedRoot: ApprovedArchiveRootIdentity | null;
  nowMs: number;
  context: ArchiveScanContext;
}): Promise<UsageSnapshot | null> {
  if (
    !input.approvedRoot ||
    input.approvedRoot.provider !== "claudeAgent" ||
    !(await validateApprovedArchiveRootIdentity({
      approvedRoot: input.approvedRoot,
      context: input.context,
    }))
  ) {
    return input.context.diagnostics.deadlineExceeded
      ? emptyIncompleteArchiveSnapshot({
          provider: "claudeAgent",
          source: "claude-project-transcripts",
          nowMs: input.nowMs,
          context: input.context,
        })
      : null;
  }
  const discovery = await discoverRecentClaudeTranscriptFiles({
    approvedRoot: input.approvedRoot,
    context: input.context,
  });
  if (discovery.filesDiscovered === 0 && !discovery.incomplete) {
    return null;
  }
  const selected = discovery.candidates.slice(0, input.context.limits.maxFiles);
  const allocations = allocateFileByteBudgets({
    fileCount: selected.length,
    limits: input.context.limits,
  });
  const results = await mapWithConcurrency(
    selected.map((candidate, index) => ({
      candidate,
      byteBudget: allocations[index] ?? 0,
    })),
    input.context.limits.concurrency,
    async (file) => readClaudeUsageSamplesFromCandidate({ ...file, context: input.context }),
  );
  const archiveScan = archiveScanCoverage({
    discovery,
    selectedCount: selected.length,
    results,
    context: input.context,
  });
  const usageSamples = results.flatMap((result) => result.samples);
  if (usageSamples.length === 0 && archiveScan.complete) {
    return null;
  }

  const cutoff24h = input.nowMs - ONE_DAY_MS;
  const cutoff7d = input.nowMs - LOOKBACK_7D_MS;
  const cutoff30d = input.nowMs - LOOKBACK_30D_MS;
  const recent24h = usageSamples.filter((sample) => sample.timestampMs >= cutoff24h);
  const recent7d = usageSamples.filter((sample) => sample.timestampMs >= cutoff7d);
  const recent30d = usageSamples.filter((sample) => sample.timestampMs >= cutoff30d);
  const latestSample = usageSamples.reduce<ClaudeUsageSample | null>(
    (latest, current) => (!latest || current.timestampMs > latest.timestampMs ? current : latest),
    null,
  );
  const fallbackTimestampMs = selected[0]?.mtimeMs ?? input.nowMs;

  return {
    provider: "claudeAgent",
    updatedAt: toIsoString(latestSample?.timestampMs ?? fallbackTimestampMs),
    limits: [],
    usageLines:
      usageSamples.length > 0
        ? buildUsageLines({
            tokens24h: recent24h.reduce((total, sample) => total + sample.totalTokens, 0),
            tokens7d: recent7d.reduce((total, sample) => total + sample.totalTokens, 0),
            tokens30d: recent30d.reduce((total, sample) => total + sample.totalTokens, 0),
            sessions24h: new Set(recent24h.map((sample) => sample.sessionId)).size,
            sessions7d: new Set(recent7d.map((sample) => sample.sessionId)).size,
            sessions30d: new Set(recent30d.map((sample) => sample.sessionId)).size,
            lowerBound: !archiveScan.complete,
          })
        : [],
    source: "claude-project-transcripts",
    archiveScan,
    ...(!archiveScan.complete ? { detail: INCOMPLETE_ARCHIVE_DETAIL } : {}),
  };
}

async function scanProviderUsageSnapshot(input: {
  provider: ProviderKind;
  homeDir: string;
  homePath?: string;
  nowMs: number;
  limits: ProviderUsageArchiveScanLimits;
  pinnedApprovedRoot?: { identity: ApprovedArchiveRootIdentity | null };
}): Promise<ProviderUsageArchiveScanTestResult> {
  providerUsageArchiveScanRuns += 1;
  const limits = normalizeArchiveScanLimits(input.limits);
  const startedAtMs = performance.now();
  const context: ArchiveScanContext = {
    limits,
    diagnostics: createArchiveScanDiagnostics(),
    startedAtMs,
    deadlineAtMs: startedAtMs + limits.maxElapsedMs,
    activeFileReads: 0,
  };
  try {
    let approvedRoot: ApprovedArchiveRootIdentity | null;
    if (input.pinnedApprovedRoot) {
      approvedRoot = input.pinnedApprovedRoot.identity;
    } else {
      const configuredRoot = resolveConfiguredArchiveRoot(input);
      approvedRoot = configuredRoot
        ? await resolveApprovedArchiveRootIdentity({
            provider: input.provider,
            path: configuredRoot,
            context,
          })
        : null;
    }
    let snapshot: ServerGetProviderUsageSnapshotResult;
    switch (input.provider) {
      case "codex":
        snapshot = await loadCodexUsageSnapshot({
          approvedRoot,
          nowMs: input.nowMs,
          context,
        });
        break;
      case "claudeAgent":
        snapshot = await loadClaudeUsageSnapshot({
          approvedRoot,
          nowMs: input.nowMs,
          context,
        });
        break;
      case "gemini":
      case "antigravity":
      case "cursor":
      case "grok":
      case "devin":
      case "droid":
      case "kilo":
      case "opencode":
      case "pi":
      default:
        snapshot = null;
    }
    return { snapshot, diagnostics: context.diagnostics };
  } finally {
    context.diagnostics.elapsedMs = performance.now() - context.startedAtMs;
  }
}

async function loadProviderUsageSnapshot(input: {
  provider: ProviderKind;
  homeDir: string;
  homePath?: string;
  nowMs?: number;
  approvedRoot: ApprovedArchiveRootIdentity | null;
}): Promise<ServerGetProviderUsageSnapshotResult> {
  const result = await scanProviderUsageSnapshot({
    provider: input.provider,
    homeDir: input.homeDir,
    ...(input.homePath ? { homePath: input.homePath } : {}),
    nowMs: input.nowMs ?? Date.now(),
    limits: DEFAULT_ARCHIVE_SCAN_LIMITS,
    pinnedApprovedRoot: { identity: input.approvedRoot },
  });
  return result.snapshot;
}

async function resolveArchiveCacheRoot(input: {
  provider: ProviderKind;
  homeDir: string;
  homePath?: string;
}): Promise<{
  cacheKey: string;
  approvedRoot: ApprovedArchiveRootIdentity | null;
}> {
  const configuredRoot = resolveConfiguredArchiveRoot(input);
  if (!configuredRoot) {
    return { cacheKey: `${input.provider}:no-local-archive`, approvedRoot: null };
  }
  const approvedRoot = await resolveApprovedArchiveRootIdentity({
    provider: input.provider,
    path: configuredRoot,
  });
  if (!approvedRoot) {
    return {
      cacheKey: `${input.provider}:unresolved:${configuredRoot}`,
      approvedRoot: null,
    };
  }
  // This immutable identity owns cache reuse, pending single-flight work, and
  // the exact canonical directory traversed by the scan.
  return {
    cacheKey:
      `${input.provider}:canonical:${approvedRoot.canonicalPath}:` +
      `${approvedRoot.dev}:${approvedRoot.ino}`,
    approvedRoot,
  };
}

async function getCachedProviderUsageSnapshot(input: {
  provider: ProviderKind;
  homeDir: string;
  homePath?: string;
  nowMs?: number;
  forceRefresh?: boolean;
  afterArchiveRootResolvedForTests?: () => void | Promise<void>;
}): Promise<ServerGetProviderUsageSnapshotResult> {
  const { cacheKey, approvedRoot } = await resolveArchiveCacheRoot(input);
  const nowMs = input.nowMs ?? Date.now();
  const existing = usageSnapshotCache.get(cacheKey);

  if (existing?.pending) {
    return existing.pending;
  }
  if (!input.forceRefresh && existing && existing.expiresAtMs > nowMs) {
    return existing.value;
  }

  const pending = Promise.resolve()
    .then(async () => {
      await input.afterArchiveRootResolvedForTests?.();
      return loadProviderUsageSnapshot({
        provider: input.provider,
        homeDir: input.homeDir,
        ...(input.homePath ? { homePath: input.homePath } : {}),
        nowMs,
        approvedRoot,
      });
    })
    .catch(() => null)
    .then((value) => {
      usageSnapshotCache.set(cacheKey, {
        expiresAtMs: nowMs + USAGE_CACHE_TTL_MS,
        value,
        pending: null,
      });
      return value;
    });

  usageSnapshotCache.set(cacheKey, {
    expiresAtMs: existing?.expiresAtMs ?? 0,
    value: existing?.value ?? null,
    pending,
  });

  return pending;
}

export const getProviderUsageSnapshot = Effect.fn(function* (
  input: ServerGetProviderUsageSnapshotInput,
) {
  const serverConfig = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const settings = yield* serverSettings.getSettings;
  const serverOwnedCodexHomePath = settings.providers.codex.homePath.trim();
  const serverOwnedClaudeHomePath = settings.providers.claudeAgent.homePath.trim();
  return yield* Effect.tryPromise({
    try: () =>
      getCachedProviderUsageSnapshot({
        provider: input.provider,
        homeDir: serverConfig.homeDir,
        // The renderer's legacy `homePath` field is accepted only for wire
        // compatibility. Archive filesystem authority comes exclusively from
        // server-owned settings for both Codex and Claude.
        ...(input.provider === "codex" && serverOwnedCodexHomePath
          ? { homePath: serverOwnedCodexHomePath }
          : input.provider === "claudeAgent" && serverOwnedClaudeHomePath
            ? { homePath: serverOwnedClaudeHomePath }
            : {}),
      }),
    catch: () => null,
  });
});

// Reused by the live-usage batch so lower-bound detail and archive coverage travel
// with the locally-derived rows instead of being lost during enrichment.
export async function loadLocalProviderUsageSnapshot(input: {
  provider: ProviderKind;
  homeDir: string;
  homePath?: string;
  forceRefresh?: boolean;
}): Promise<ServerGetProviderUsageSnapshotResult> {
  try {
    return await getCachedProviderUsageSnapshot(input);
  } catch {
    return null;
  }
}

/** Test-only: deterministic bounded scan over synthetic archive roots. */
export async function __scanProviderUsageSnapshotForTests(input: {
  provider: ProviderKind;
  homeDir: string;
  homePath?: string;
  nowMs: number;
  limits: ProviderUsageArchiveScanLimits;
}): Promise<ProviderUsageArchiveScanTestResult> {
  return scanProviderUsageSnapshot(input);
}

/** Test-only: exercise production cache/single-flight behavior with a synthetic home. */
export async function __getCachedProviderUsageSnapshotForTests(input: {
  provider: ProviderKind;
  homeDir: string;
  homePath?: string;
  nowMs: number;
  forceRefresh?: boolean;
  afterArchiveRootResolvedForTests?: () => void | Promise<void>;
}): Promise<ServerGetProviderUsageSnapshotResult> {
  return getCachedProviderUsageSnapshot(input);
}

/** Test-only: drop caches and bounded in-memory file summaries. */
export function __resetProviderUsageSnapshotStateForTests(): void {
  usageSnapshotCache.clear();
  fileSummaryIndex.clear();
  providerUsageArchiveScanRuns = 0;
}

/** Test-only: exposes counts, never archive paths or contents. */
export function __getProviderUsageSnapshotTestState(): { scanRuns: number } {
  return { scanRuns: providerUsageArchiveScanRuns };
}
