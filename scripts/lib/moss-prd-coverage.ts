import { readFileSync } from "node:fs";
import { join } from "node:path";

export type MossPrdCoverageStatus = "proved" | "partial" | "missing" | "unverified";

export interface MossPrdCoverageRow {
  readonly id: string;
  readonly section: string;
  readonly requirement: string;
  readonly status: MossPrdCoverageStatus;
  readonly evidence: ReadonlyArray<string>;
  readonly nextGap: string;
  readonly nextTaskHint?: string | undefined;
}

export interface MossPrdCoverageDocument {
  readonly version: 1;
  readonly updatedAt: string;
  readonly summary: {
    readonly nextGapId?: string | undefined;
    readonly note?: string | undefined;
  };
  readonly rows: ReadonlyArray<MossPrdCoverageRow>;
}

export interface MossPrdCoverageNextGap {
  readonly id: string;
  readonly status: MossPrdCoverageStatus;
  readonly section: string;
  readonly requirement: string;
  readonly nextGap: string;
  readonly nextTaskHint?: string | undefined;
  readonly evidence: ReadonlyArray<string>;
}

export interface MossPrdCoverageSnapshot {
  readonly path: string;
  readonly updatedAt: string;
  readonly statusCounts: Record<MossPrdCoverageStatus, number>;
  readonly nextGap: MossPrdCoverageNextGap | null;
}

export interface MossPrdCoverageReport extends MossPrdCoverageSnapshot {
  readonly version: 1;
  readonly rowCount: number;
  readonly rows: ReadonlyArray<MossPrdCoverageRow>;
}

const STATUSES = ["proved", "partial", "missing", "unverified"] as const;
const DEFAULT_COVERAGE_PATH = ".moss/prd-coverage.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string when present`);
  }
  return value;
}

function stringArray(value: unknown, path: string): ReadonlyArray<string> {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`${path} must be an array of strings`);
  }
  return value;
}

function parseStatus(value: unknown, path: string): MossPrdCoverageStatus {
  if (!STATUSES.includes(value as MossPrdCoverageStatus)) {
    throw new Error(`${path} must be one of ${STATUSES.join(", ")}`);
  }
  return value as MossPrdCoverageStatus;
}

function parseRow(value: unknown, index: number): MossPrdCoverageRow {
  const path = `rows[${index}]`;
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`);
  }
  return {
    id: requiredString(value.id, `${path}.id`),
    section: requiredString(value.section, `${path}.section`),
    requirement: requiredString(value.requirement, `${path}.requirement`),
    status: parseStatus(value.status, `${path}.status`),
    evidence: stringArray(value.evidence, `${path}.evidence`),
    nextGap: requiredString(value.nextGap, `${path}.nextGap`),
    ...(value.nextTaskHint !== undefined
      ? { nextTaskHint: optionalString(value.nextTaskHint, `${path}.nextTaskHint`) }
      : {}),
  };
}

function duplicateIds(rows: ReadonlyArray<MossPrdCoverageRow>): ReadonlyArray<string> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .toSorted();
}

export function parseMossPrdCoverageDocument(
  content: string,
  source: string,
): MossPrdCoverageDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    throw new Error(`${source}: invalid JSON: ${String(error)}`, { cause: error });
  }
  if (!isRecord(raw)) {
    throw new Error(`${source} must be a JSON object`);
  }
  if (raw.version !== 1) {
    throw new Error(`${source}.version must be 1`);
  }
  if (!isRecord(raw.summary)) {
    throw new Error(`${source}.summary must be an object`);
  }
  if (!Array.isArray(raw.rows)) {
    throw new Error(`${source}.rows must be an array`);
  }

  const rows = raw.rows.map(parseRow);
  const duplicates = duplicateIds(rows);
  if (duplicates.length > 0) {
    throw new Error(`${source}.rows duplicate ids: ${duplicates.join(", ")}`);
  }

  const nextGapId = optionalString(raw.summary.nextGapId, `${source}.summary.nextGapId`);
  if (nextGapId) {
    const row = rows.find((entry) => entry.id === nextGapId);
    if (!row) {
      throw new Error(`${source}.summary.nextGapId points to missing row ${nextGapId}`);
    }
    if (row.status === "proved") {
      throw new Error(`${source}.summary.nextGapId must not point to a proved row`);
    }
  }

  return {
    version: 1,
    updatedAt: requiredString(raw.updatedAt, `${source}.updatedAt`),
    summary: {
      ...(nextGapId ? { nextGapId } : {}),
      ...(raw.summary.note !== undefined
        ? { note: optionalString(raw.summary.note, `${source}.summary.note`) }
        : {}),
    },
    rows,
  };
}

export function selectMossPrdCoverageNextGap(
  document: MossPrdCoverageDocument,
): MossPrdCoverageNextGap | null {
  const row = document.summary.nextGapId
    ? document.rows.find((entry) => entry.id === document.summary.nextGapId)
    : document.rows.find((entry) => entry.status !== "proved");
  if (!row || row.status === "proved") {
    return null;
  }
  return {
    id: row.id,
    status: row.status,
    section: row.section,
    requirement: row.requirement,
    nextGap: row.nextGap,
    ...(row.nextTaskHint ? { nextTaskHint: row.nextTaskHint } : {}),
    evidence: row.evidence,
  };
}

export function countMossPrdCoverageStatuses(
  rows: ReadonlyArray<MossPrdCoverageRow>,
): Record<MossPrdCoverageStatus, number> {
  const counts: Record<MossPrdCoverageStatus, number> = {
    proved: 0,
    partial: 0,
    missing: 0,
    unverified: 0,
  };
  for (const row of rows) {
    counts[row.status] += 1;
  }
  return counts;
}

export function buildMossPrdCoverageSnapshot(
  document: MossPrdCoverageDocument,
  path = DEFAULT_COVERAGE_PATH,
): MossPrdCoverageSnapshot {
  return {
    path,
    updatedAt: document.updatedAt,
    statusCounts: countMossPrdCoverageStatuses(document.rows),
    nextGap: selectMossPrdCoverageNextGap(document),
  };
}

export function buildMossPrdCoverageReport(
  document: MossPrdCoverageDocument,
  path = DEFAULT_COVERAGE_PATH,
): MossPrdCoverageReport {
  return {
    version: 1,
    ...buildMossPrdCoverageSnapshot(document, path),
    rowCount: document.rows.length,
    rows: document.rows,
  };
}

export function readMossPrdCoverageReport(
  repoRoot = process.cwd(),
  path = DEFAULT_COVERAGE_PATH,
): MossPrdCoverageReport {
  const content = readFileSync(join(repoRoot, path), "utf8");
  return buildMossPrdCoverageReport(parseMossPrdCoverageDocument(content, path), path);
}
