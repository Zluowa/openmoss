import { readFileSync } from "node:fs";
import { join } from "node:path";

export type MossGuiParityStatus = "gated" | "partial" | "missing" | "unverified";
export type MossGuiParityGateStatus = "pass" | "fail";

export interface MossGuiParitySurface {
  readonly id: string;
  readonly label: string;
  readonly prdCoverageRowId: string;
  readonly requirement: string;
  readonly status: MossGuiParityStatus;
  readonly visibleShellSlice: boolean;
  readonly selectors: ReadonlyArray<string>;
  readonly evidence: ReadonlyArray<string>;
  readonly gap: string;
  readonly nextTaskHint?: string | undefined;
}

export interface MossGuiParityFirstVisibleShell {
  readonly status: MossGuiParityStatus;
  readonly selectors: ReadonlyArray<string>;
  readonly evidence: ReadonlyArray<string>;
  readonly gap: string;
}

export interface MossGuiParityDocument {
  readonly version: 1;
  readonly updatedAt: string;
  readonly prdCoverageRowId: string;
  readonly overallStatus: MossGuiParityStatus;
  readonly fullCodexParityClaim: false;
  readonly summary: {
    readonly nextGapId?: string | undefined;
    readonly note?: string | undefined;
  };
  readonly firstVisibleShell: MossGuiParityFirstVisibleShell;
  readonly surfaces: ReadonlyArray<MossGuiParitySurface>;
}

export interface MossGuiParityNextGap {
  readonly id: string;
  readonly status: MossGuiParityStatus;
  readonly label: string;
  readonly gap: string;
  readonly nextTaskHint?: string | undefined;
  readonly evidence: ReadonlyArray<string>;
}

export interface MossGuiParitySnapshot {
  readonly path: string;
  readonly updatedAt: string;
  readonly prdCoverageRowId: string;
  readonly overallStatus: MossGuiParityStatus;
  readonly gateStatus: MossGuiParityGateStatus;
  readonly statusCounts: Record<MossGuiParityStatus, number>;
  readonly requiredSurfaceIds: ReadonlyArray<string>;
  readonly nextGap: MossGuiParityNextGap | null;
  readonly issues: ReadonlyArray<string>;
}

export interface MossGuiParityReport extends MossGuiParitySnapshot {
  readonly version: 1;
  readonly fullCodexParityClaim: false;
  readonly firstVisibleShell: MossGuiParityFirstVisibleShell;
  readonly surfaceCount: number;
  readonly surfaces: ReadonlyArray<MossGuiParitySurface>;
}

const STATUSES = ["gated", "partial", "missing", "unverified"] as const;
const DEFAULT_GUI_PARITY_PATH = ".moss/gui-parity.json";
export const REQUIRED_GUI_PARITY_SURFACE_IDS = [
  "session-list",
  "composer",
  "tool-permission-flow",
  "normalized-event-timeline",
  "launch-plan-inspector",
] as const;

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

function parseBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean`);
  }
  return value;
}

function stringArray(value: unknown, path: string): ReadonlyArray<string> {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((entry) => typeof entry === "string" && entry.trim().length > 0)
  ) {
    throw new Error(`${path} must be a non-empty array of non-empty strings`);
  }
  return value;
}

function parseStatus(value: unknown, path: string): MossGuiParityStatus {
  if (!STATUSES.includes(value as MossGuiParityStatus)) {
    throw new Error(`${path} must be one of ${STATUSES.join(", ")}`);
  }
  return value as MossGuiParityStatus;
}

function parseFirstVisibleShell(value: unknown): MossGuiParityFirstVisibleShell {
  if (!isRecord(value)) {
    throw new Error("firstVisibleShell must be an object");
  }
  return {
    status: parseStatus(value.status, "firstVisibleShell.status"),
    selectors: stringArray(value.selectors, "firstVisibleShell.selectors"),
    evidence: stringArray(value.evidence, "firstVisibleShell.evidence"),
    gap: requiredString(value.gap, "firstVisibleShell.gap"),
  };
}

function parseSurface(value: unknown, index: number): MossGuiParitySurface {
  const path = `surfaces[${index}]`;
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`);
  }
  return {
    id: requiredString(value.id, `${path}.id`),
    label: requiredString(value.label, `${path}.label`),
    prdCoverageRowId: requiredString(value.prdCoverageRowId, `${path}.prdCoverageRowId`),
    requirement: requiredString(value.requirement, `${path}.requirement`),
    status: parseStatus(value.status, `${path}.status`),
    visibleShellSlice: parseBoolean(value.visibleShellSlice, `${path}.visibleShellSlice`),
    selectors: stringArray(value.selectors, `${path}.selectors`),
    evidence: stringArray(value.evidence, `${path}.evidence`),
    gap: requiredString(value.gap, `${path}.gap`),
    ...(value.nextTaskHint !== undefined
      ? { nextTaskHint: optionalString(value.nextTaskHint, `${path}.nextTaskHint`) }
      : {}),
  };
}

function duplicateIds(rows: ReadonlyArray<{ readonly id: string }>): ReadonlyArray<string> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .toSorted();
}

export function parseMossGuiParityDocument(content: string, source: string): MossGuiParityDocument {
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
  if (raw.fullCodexParityClaim !== false) {
    throw new Error(`${source}.fullCodexParityClaim must be false for this partial GUI gate`);
  }
  if (!Array.isArray(raw.surfaces)) {
    throw new Error(`${source}.surfaces must be an array`);
  }

  const surfaces = raw.surfaces.map(parseSurface);
  const duplicates = duplicateIds(surfaces);
  if (duplicates.length > 0) {
    throw new Error(`${source}.surfaces duplicate ids: ${duplicates.join(", ")}`);
  }

  const prdCoverageRowId = requiredString(raw.prdCoverageRowId, `${source}.prdCoverageRowId`);
  for (const surface of surfaces) {
    if (surface.prdCoverageRowId !== prdCoverageRowId) {
      throw new Error(
        `${source}.surfaces ${surface.id} must reference prdCoverageRowId ${prdCoverageRowId}`,
      );
    }
  }

  const nextGapId = optionalString(raw.summary.nextGapId, `${source}.summary.nextGapId`);
  if (nextGapId) {
    const surface = surfaces.find((entry) => entry.id === nextGapId);
    if (!surface) {
      throw new Error(`${source}.summary.nextGapId points to missing surface ${nextGapId}`);
    }
    if (surface.status === "gated") {
      throw new Error(`${source}.summary.nextGapId must not point to a gated surface`);
    }
  }

  return {
    version: 1,
    updatedAt: requiredString(raw.updatedAt, `${source}.updatedAt`),
    prdCoverageRowId,
    overallStatus: parseStatus(raw.overallStatus, `${source}.overallStatus`),
    fullCodexParityClaim: false,
    summary: {
      ...(nextGapId ? { nextGapId } : {}),
      ...(raw.summary.note !== undefined
        ? { note: optionalString(raw.summary.note, `${source}.summary.note`) }
        : {}),
    },
    firstVisibleShell: parseFirstVisibleShell(raw.firstVisibleShell),
    surfaces,
  };
}

export function countMossGuiParityStatuses(
  surfaces: ReadonlyArray<MossGuiParitySurface>,
): Record<MossGuiParityStatus, number> {
  const counts: Record<MossGuiParityStatus, number> = {
    gated: 0,
    partial: 0,
    missing: 0,
    unverified: 0,
  };
  for (const surface of surfaces) {
    counts[surface.status] += 1;
  }
  return counts;
}

export function selectMossGuiParityNextGap(
  document: MossGuiParityDocument,
): MossGuiParityNextGap | null {
  const surface = document.summary.nextGapId
    ? document.surfaces.find((entry) => entry.id === document.summary.nextGapId)
    : document.surfaces.find((entry) => entry.status !== "gated");
  if (!surface || surface.status === "gated") {
    return null;
  }
  return {
    id: surface.id,
    status: surface.status,
    label: surface.label,
    gap: surface.gap,
    ...(surface.nextTaskHint ? { nextTaskHint: surface.nextTaskHint } : {}),
    evidence: surface.evidence,
  };
}

function buildMossGuiParityIssues(document: MossGuiParityDocument): ReadonlyArray<string> {
  const issues: string[] = [];
  const surfaceIds = new Set(document.surfaces.map((surface) => surface.id));

  for (const id of REQUIRED_GUI_PARITY_SURFACE_IDS) {
    if (!surfaceIds.has(id)) {
      issues.push(`missing required GUI parity surface: ${id}`);
    }
  }

  if (document.firstVisibleShell.status === "missing") {
    issues.push("first visible shell slice is missing");
  }
  if (document.firstVisibleShell.status === "unverified") {
    issues.push("first visible shell slice is unverified");
  }

  for (const surface of document.surfaces) {
    if (
      REQUIRED_GUI_PARITY_SURFACE_IDS.includes(
        surface.id as (typeof REQUIRED_GUI_PARITY_SURFACE_IDS)[number],
      ) &&
      (surface.status === "missing" || surface.status === "unverified")
    ) {
      issues.push(`required GUI parity surface ${surface.id} is ${surface.status}`);
    }
  }

  if (document.overallStatus === "gated") {
    issues.push("overallStatus must stay partial until full Codex Desktop parity is proved");
  }

  return issues;
}

export function buildMossGuiParitySnapshot(
  document: MossGuiParityDocument,
  path = DEFAULT_GUI_PARITY_PATH,
): MossGuiParitySnapshot {
  const issues = buildMossGuiParityIssues(document);
  return {
    path,
    updatedAt: document.updatedAt,
    prdCoverageRowId: document.prdCoverageRowId,
    overallStatus: document.overallStatus,
    gateStatus: issues.length === 0 ? "pass" : "fail",
    statusCounts: countMossGuiParityStatuses(document.surfaces),
    requiredSurfaceIds: [...REQUIRED_GUI_PARITY_SURFACE_IDS],
    nextGap: selectMossGuiParityNextGap(document),
    issues,
  };
}

export function buildMossGuiParityReport(
  document: MossGuiParityDocument,
  path = DEFAULT_GUI_PARITY_PATH,
): MossGuiParityReport {
  return {
    version: 1,
    ...buildMossGuiParitySnapshot(document, path),
    fullCodexParityClaim: false,
    firstVisibleShell: document.firstVisibleShell,
    surfaceCount: document.surfaces.length,
    surfaces: document.surfaces,
  };
}

export function readMossGuiParityReport(
  repoRoot = process.cwd(),
  path = DEFAULT_GUI_PARITY_PATH,
): MossGuiParityReport {
  const content = readFileSync(join(repoRoot, path), "utf8");
  return buildMossGuiParityReport(parseMossGuiParityDocument(content, path), path);
}
