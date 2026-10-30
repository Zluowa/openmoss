import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type MossCodexDesktopComparatorStatus = "aligned" | "partial" | "gap" | "unverified";
export type MossCodexDesktopComparatorGateStatus = "pass" | "fail";

export interface MossCodexDesktopWindowBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface MossCodexDesktopBaseline {
  readonly capturedAt: string;
  readonly source: string;
  readonly processName: string;
  readonly windowName: string;
  readonly windowBounds: MossCodexDesktopWindowBounds;
  readonly screenshotPath: string;
  readonly observedShellTraits: ReadonlyArray<string>;
  readonly evidenceLimitations: ReadonlyArray<string>;
}

export interface MossCodexDesktopMossEvidence {
  readonly label: string;
  readonly path: string;
  readonly kind: "screenshot" | "report" | "source";
}

export interface MossCodexDesktopComparison {
  readonly id: string;
  readonly label: string;
  readonly requirement: string;
  readonly status: MossCodexDesktopComparatorStatus;
  readonly directCodexDesktopBaseline: boolean;
  readonly codexDesktopEvidence: ReadonlyArray<string>;
  readonly mossEvidence: ReadonlyArray<string>;
  readonly findings: ReadonlyArray<string>;
  readonly gap: string;
  readonly nextTaskHint?: string | undefined;
}

export interface MossCodexDesktopFirstScreenLayoutMeasurement {
  readonly source: string;
  readonly capturedAt: string;
  readonly viewportWidthPx: number;
  readonly viewportHeightPx: number;
  readonly composerTopPx: number;
  readonly composerBottomGapPx: number;
  readonly composerHeightPx: number;
  readonly sideAccessWidthPx: number;
  readonly sideAccessVisible: boolean;
  readonly controlPlaneAffordanceCount: number;
  readonly requiredControlPlaneAffordanceCount: number;
  readonly normalizedEventRowCount: number;
  readonly timelineHeightPx: number;
  readonly timelineDensityRowsPer1000Px: number;
  readonly evidence: ReadonlyArray<string>;
}

export interface MossCodexDesktopFirstScreenLayoutThresholds {
  readonly maxComposerTopRatioDelta: number;
  readonly maxComposerBottomGapPxDelta: number;
  readonly maxComposerHeightPxDelta: number;
  readonly maxSideAccessWidthRatioDelta: number;
  readonly maxMissingControlPlaneAffordances: number;
  readonly maxNormalizedEventRowCountDelta: number;
  readonly minMossTimelineDensityRowsPer1000Px: number;
  readonly maxTimelineDensityRowsPer1000PxDelta: number;
}

export interface MossCodexDesktopFirstScreenLayoutMetrics {
  readonly codexDesktop: MossCodexDesktopFirstScreenLayoutMeasurement;
  readonly mossElectron: MossCodexDesktopFirstScreenLayoutMeasurement;
  readonly thresholds: MossCodexDesktopFirstScreenLayoutThresholds;
}

export type MossCodexDesktopLayoutDeltaStatus = "pass" | "fail";

export interface MossCodexDesktopLayoutDelta {
  readonly id:
    | "composer-position"
    | "side-session-access"
    | "control-plane-affordance-visibility"
    | "normalized-event-timeline-density";
  readonly label: string;
  readonly status: MossCodexDesktopLayoutDeltaStatus;
  readonly delta: Readonly<Record<string, number | boolean>>;
  readonly threshold: Readonly<Record<string, number>>;
  readonly message: string;
}

export interface MossCodexDesktopComparatorDocument {
  readonly version: 1;
  readonly updatedAt: string;
  readonly scope: string;
  readonly overallStatus: MossCodexDesktopComparatorStatus;
  readonly fullCodexParityClaim: false;
  readonly summary: {
    readonly nextGapId?: string | undefined;
    readonly note?: string | undefined;
  };
  readonly codexDesktopBaseline: MossCodexDesktopBaseline;
  readonly mossEvidence: ReadonlyArray<MossCodexDesktopMossEvidence>;
  readonly layoutMetrics: MossCodexDesktopFirstScreenLayoutMetrics;
  readonly comparisons: ReadonlyArray<MossCodexDesktopComparison>;
}

export interface MossCodexDesktopImageMetadata {
  readonly path: string;
  readonly exists: boolean;
  readonly bytes: number;
  readonly format: "png" | "unknown" | "missing";
  readonly width?: number | undefined;
  readonly height?: number | undefined;
}

export interface MossCodexDesktopComparatorNextGap {
  readonly id: string;
  readonly status: MossCodexDesktopComparatorStatus;
  readonly label: string;
  readonly gap: string;
  readonly nextTaskHint?: string | undefined;
  readonly codexDesktopEvidence: ReadonlyArray<string>;
  readonly mossEvidence: ReadonlyArray<string>;
}

export interface MossCodexDesktopComparatorReport {
  readonly version: 1;
  readonly path: string;
  readonly updatedAt: string;
  readonly scope: string;
  readonly overallStatus: MossCodexDesktopComparatorStatus;
  readonly fullCodexParityClaim: false;
  readonly gateStatus: MossCodexDesktopComparatorGateStatus;
  readonly statusCounts: Record<MossCodexDesktopComparatorStatus, number>;
  readonly requiredComparisonIds: ReadonlyArray<string>;
  readonly requiredBaselineTraits: ReadonlyArray<string>;
  readonly layoutGateStatus: MossCodexDesktopComparatorGateStatus;
  readonly layoutDeltas: ReadonlyArray<MossCodexDesktopLayoutDelta>;
  readonly layoutMetrics: MossCodexDesktopFirstScreenLayoutMetrics;
  readonly nextGap: MossCodexDesktopComparatorNextGap | null;
  readonly issueCount: number;
  readonly issues: ReadonlyArray<string>;
  readonly codexDesktopBaseline: MossCodexDesktopBaseline;
  readonly codexDesktopImage: MossCodexDesktopImageMetadata;
  readonly mossImages: ReadonlyArray<MossCodexDesktopImageMetadata>;
  readonly mossEvidence: ReadonlyArray<MossCodexDesktopMossEvidence>;
  readonly comparisons: ReadonlyArray<MossCodexDesktopComparison>;
}

const STATUSES = ["aligned", "partial", "gap", "unverified"] as const;
const DEFAULT_COMPARATOR_PATH = ".moss/codex-desktop-comparator.json";
const MAX_BASELINE_AGE_MS = 24 * 60 * 60 * 1000;

export const REQUIRED_CODEX_DESKTOP_COMPARISON_IDS = [
  "first-screen-layout",
  "routing",
  "density",
  "state-transitions",
  "interaction-sequencing",
  "native-surface-access",
  "launch-plan-affordance",
] as const;

export const REQUIRED_CODEX_DESKTOP_BASELINE_TRAITS = [
  "desktop-window-chrome",
  "project-or-thread-sidebar",
  "active-thread-transcript",
  "composer",
  "run-state-control",
  "model-or-permission-control",
  "plan-or-output-side-panel",
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

function requiredNumber(value: unknown, path: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return value as number;
}

function requiredBoolean(value: unknown, path: string): boolean {
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

function parseStatus(value: unknown, path: string): MossCodexDesktopComparatorStatus {
  if (!STATUSES.includes(value as MossCodexDesktopComparatorStatus)) {
    throw new Error(`${path} must be one of ${STATUSES.join(", ")}`);
  }
  return value as MossCodexDesktopComparatorStatus;
}

function parseWindowBounds(value: unknown): MossCodexDesktopWindowBounds {
  if (!isRecord(value)) {
    throw new Error("codexDesktopBaseline.windowBounds must be an object");
  }
  return {
    x: requiredNumber(value.x, "codexDesktopBaseline.windowBounds.x"),
    y: requiredNumber(value.y, "codexDesktopBaseline.windowBounds.y"),
    width: requiredNumber(value.width, "codexDesktopBaseline.windowBounds.width"),
    height: requiredNumber(value.height, "codexDesktopBaseline.windowBounds.height"),
  };
}

function parseBaseline(value: unknown): MossCodexDesktopBaseline {
  if (!isRecord(value)) {
    throw new Error("codexDesktopBaseline must be an object");
  }
  return {
    capturedAt: requiredString(value.capturedAt, "codexDesktopBaseline.capturedAt"),
    source: requiredString(value.source, "codexDesktopBaseline.source"),
    processName: requiredString(value.processName, "codexDesktopBaseline.processName"),
    windowName: requiredString(value.windowName, "codexDesktopBaseline.windowName"),
    windowBounds: parseWindowBounds(value.windowBounds),
    screenshotPath: requiredString(value.screenshotPath, "codexDesktopBaseline.screenshotPath"),
    observedShellTraits: stringArray(
      value.observedShellTraits,
      "codexDesktopBaseline.observedShellTraits",
    ),
    evidenceLimitations: stringArray(
      value.evidenceLimitations,
      "codexDesktopBaseline.evidenceLimitations",
    ),
  };
}

function parseEvidenceKind(value: unknown, path: string): "screenshot" | "report" | "source" {
  if (value === "screenshot" || value === "report" || value === "source") {
    return value;
  }
  throw new Error(`${path} must be screenshot, report, or source`);
}

function parseMossEvidence(value: unknown, index: number): MossCodexDesktopMossEvidence {
  const path = `mossEvidence[${index}]`;
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`);
  }
  return {
    label: requiredString(value.label, `${path}.label`),
    path: requiredString(value.path, `${path}.path`),
    kind: parseEvidenceKind(value.kind, `${path}.kind`),
  };
}

function parseComparison(value: unknown, index: number): MossCodexDesktopComparison {
  const path = `comparisons[${index}]`;
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`);
  }
  return {
    id: requiredString(value.id, `${path}.id`),
    label: requiredString(value.label, `${path}.label`),
    requirement: requiredString(value.requirement, `${path}.requirement`),
    status: parseStatus(value.status, `${path}.status`),
    directCodexDesktopBaseline: requiredBoolean(
      value.directCodexDesktopBaseline,
      `${path}.directCodexDesktopBaseline`,
    ),
    codexDesktopEvidence: stringArray(value.codexDesktopEvidence, `${path}.codexDesktopEvidence`),
    mossEvidence: stringArray(value.mossEvidence, `${path}.mossEvidence`),
    findings: stringArray(value.findings, `${path}.findings`),
    gap: requiredString(value.gap, `${path}.gap`),
    ...(value.nextTaskHint !== undefined
      ? { nextTaskHint: optionalString(value.nextTaskHint, `${path}.nextTaskHint`) }
      : {}),
  };
}

function requiredNonNegativeNumber(value: unknown, path: string): number {
  const numberValue = requiredNumber(value, path);
  if (numberValue < 0) {
    throw new Error(`${path} must be a non-negative number`);
  }
  return numberValue;
}

function parseFirstScreenLayoutMeasurement(
  value: unknown,
  path: string,
): MossCodexDesktopFirstScreenLayoutMeasurement {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`);
  }
  return {
    source: requiredString(value.source, `${path}.source`),
    capturedAt: requiredString(value.capturedAt, `${path}.capturedAt`),
    viewportWidthPx: requiredNonNegativeNumber(value.viewportWidthPx, `${path}.viewportWidthPx`),
    viewportHeightPx: requiredNonNegativeNumber(value.viewportHeightPx, `${path}.viewportHeightPx`),
    composerTopPx: requiredNonNegativeNumber(value.composerTopPx, `${path}.composerTopPx`),
    composerBottomGapPx: requiredNonNegativeNumber(
      value.composerBottomGapPx,
      `${path}.composerBottomGapPx`,
    ),
    composerHeightPx: requiredNonNegativeNumber(value.composerHeightPx, `${path}.composerHeightPx`),
    sideAccessWidthPx: requiredNonNegativeNumber(
      value.sideAccessWidthPx,
      `${path}.sideAccessWidthPx`,
    ),
    sideAccessVisible: requiredBoolean(value.sideAccessVisible, `${path}.sideAccessVisible`),
    controlPlaneAffordanceCount: requiredNonNegativeNumber(
      value.controlPlaneAffordanceCount,
      `${path}.controlPlaneAffordanceCount`,
    ),
    requiredControlPlaneAffordanceCount: requiredNonNegativeNumber(
      value.requiredControlPlaneAffordanceCount,
      `${path}.requiredControlPlaneAffordanceCount`,
    ),
    normalizedEventRowCount: requiredNonNegativeNumber(
      value.normalizedEventRowCount,
      `${path}.normalizedEventRowCount`,
    ),
    timelineHeightPx: requiredNonNegativeNumber(value.timelineHeightPx, `${path}.timelineHeightPx`),
    timelineDensityRowsPer1000Px: requiredNonNegativeNumber(
      value.timelineDensityRowsPer1000Px,
      `${path}.timelineDensityRowsPer1000Px`,
    ),
    evidence: stringArray(value.evidence, `${path}.evidence`),
  };
}

function parseFirstScreenLayoutThresholds(
  value: unknown,
): MossCodexDesktopFirstScreenLayoutThresholds {
  if (!isRecord(value)) {
    throw new Error("layoutMetrics.thresholds must be an object");
  }
  return {
    maxComposerTopRatioDelta: requiredNonNegativeNumber(
      value.maxComposerTopRatioDelta,
      "layoutMetrics.thresholds.maxComposerTopRatioDelta",
    ),
    maxComposerBottomGapPxDelta: requiredNonNegativeNumber(
      value.maxComposerBottomGapPxDelta,
      "layoutMetrics.thresholds.maxComposerBottomGapPxDelta",
    ),
    maxComposerHeightPxDelta: requiredNonNegativeNumber(
      value.maxComposerHeightPxDelta,
      "layoutMetrics.thresholds.maxComposerHeightPxDelta",
    ),
    maxSideAccessWidthRatioDelta: requiredNonNegativeNumber(
      value.maxSideAccessWidthRatioDelta,
      "layoutMetrics.thresholds.maxSideAccessWidthRatioDelta",
    ),
    maxMissingControlPlaneAffordances: requiredNonNegativeNumber(
      value.maxMissingControlPlaneAffordances,
      "layoutMetrics.thresholds.maxMissingControlPlaneAffordances",
    ),
    maxNormalizedEventRowCountDelta: requiredNonNegativeNumber(
      value.maxNormalizedEventRowCountDelta,
      "layoutMetrics.thresholds.maxNormalizedEventRowCountDelta",
    ),
    minMossTimelineDensityRowsPer1000Px: requiredNonNegativeNumber(
      value.minMossTimelineDensityRowsPer1000Px,
      "layoutMetrics.thresholds.minMossTimelineDensityRowsPer1000Px",
    ),
    maxTimelineDensityRowsPer1000PxDelta: requiredNonNegativeNumber(
      value.maxTimelineDensityRowsPer1000PxDelta,
      "layoutMetrics.thresholds.maxTimelineDensityRowsPer1000PxDelta",
    ),
  };
}

function parseFirstScreenLayoutMetrics(value: unknown): MossCodexDesktopFirstScreenLayoutMetrics {
  if (!isRecord(value)) {
    throw new Error("layoutMetrics must be an object");
  }
  return {
    codexDesktop: parseFirstScreenLayoutMeasurement(
      value.codexDesktop,
      "layoutMetrics.codexDesktop",
    ),
    mossElectron: parseFirstScreenLayoutMeasurement(
      value.mossElectron,
      "layoutMetrics.mossElectron",
    ),
    thresholds: parseFirstScreenLayoutThresholds(value.thresholds),
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

export function parseMossCodexDesktopComparatorDocument(
  content: string,
  source: string,
): MossCodexDesktopComparatorDocument {
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
    throw new Error(`${source}.fullCodexParityClaim must be false until full parity is proved`);
  }
  if (!Array.isArray(raw.mossEvidence) || raw.mossEvidence.length === 0) {
    throw new Error(`${source}.mossEvidence must be a non-empty array`);
  }
  if (!Array.isArray(raw.comparisons)) {
    throw new Error(`${source}.comparisons must be an array`);
  }

  const comparisons = raw.comparisons.map(parseComparison);
  const duplicates = duplicateIds(comparisons);
  if (duplicates.length > 0) {
    throw new Error(`${source}.comparisons duplicate ids: ${duplicates.join(", ")}`);
  }

  const nextGapId = optionalString(raw.summary.nextGapId, `${source}.summary.nextGapId`);
  if (nextGapId) {
    const comparison = comparisons.find((entry) => entry.id === nextGapId);
    if (!comparison) {
      throw new Error(`${source}.summary.nextGapId points to missing comparison ${nextGapId}`);
    }
    if (comparison.status === "aligned") {
      throw new Error(`${source}.summary.nextGapId must not point to an aligned comparison`);
    }
  }

  return {
    version: 1,
    updatedAt: requiredString(raw.updatedAt, `${source}.updatedAt`),
    scope: requiredString(raw.scope, `${source}.scope`),
    overallStatus: parseStatus(raw.overallStatus, `${source}.overallStatus`),
    fullCodexParityClaim: false,
    summary: {
      ...(nextGapId ? { nextGapId } : {}),
      ...(raw.summary.note !== undefined
        ? { note: optionalString(raw.summary.note, `${source}.summary.note`) }
        : {}),
    },
    codexDesktopBaseline: parseBaseline(raw.codexDesktopBaseline),
    mossEvidence: raw.mossEvidence.map(parseMossEvidence),
    layoutMetrics: parseFirstScreenLayoutMetrics(raw.layoutMetrics),
    comparisons,
  };
}

export function countMossCodexDesktopComparatorStatuses(
  comparisons: ReadonlyArray<MossCodexDesktopComparison>,
): Record<MossCodexDesktopComparatorStatus, number> {
  const counts: Record<MossCodexDesktopComparatorStatus, number> = {
    aligned: 0,
    partial: 0,
    gap: 0,
    unverified: 0,
  };
  for (const comparison of comparisons) {
    counts[comparison.status] += 1;
  }
  return counts;
}

export function selectMossCodexDesktopComparatorNextGap(
  document: MossCodexDesktopComparatorDocument,
): MossCodexDesktopComparatorNextGap | null {
  const comparison = document.summary.nextGapId
    ? document.comparisons.find((entry) => entry.id === document.summary.nextGapId)
    : document.comparisons.find((entry) => entry.status !== "aligned");
  if (!comparison || comparison.status === "aligned") {
    return null;
  }
  return {
    id: comparison.id,
    status: comparison.status,
    label: comparison.label,
    gap: comparison.gap,
    ...(comparison.nextTaskHint ? { nextTaskHint: comparison.nextTaskHint } : {}),
    codexDesktopEvidence: comparison.codexDesktopEvidence,
    mossEvidence: comparison.mossEvidence,
  };
}

function readPngMetadata(repoRoot: string, path: string): MossCodexDesktopImageMetadata {
  const absolutePath = join(repoRoot, path);
  if (!existsSync(absolutePath)) {
    return {
      path,
      exists: false,
      bytes: 0,
      format: "missing",
    };
  }

  const stats = statSync(absolutePath);
  const buffer = readFileSync(absolutePath);
  const isPng =
    buffer.length >= 24 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a;

  if (!isPng) {
    return {
      path,
      exists: true,
      bytes: stats.size,
      format: "unknown",
    };
  }

  return {
    path,
    exists: true,
    bytes: stats.size,
    format: "png",
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function pathExists(repoRoot: string, path: string): boolean {
  return existsSync(join(repoRoot, path));
}

function collectFreshMossLayoutEvidencePaths(
  document: MossCodexDesktopComparatorDocument,
): ReadonlyArray<string> {
  const paths = new Set<string>();
  for (const evidencePath of document.layoutMetrics.mossElectron.evidence) {
    if (evidencePath.endsWith(".json")) {
      paths.add(evidencePath);
    }
  }
  return [...paths];
}

function readFreshMossLayoutMeasurement(
  repoRoot: string,
  path: string,
): MossCodexDesktopFirstScreenLayoutMeasurement | undefined {
  const absolutePath = join(repoRoot, path);
  if (!existsSync(absolutePath)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(readFileSync(absolutePath, "utf8")) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.firstScreenLayoutEvidence)) {
      return undefined;
    }
    return parseFirstScreenLayoutMeasurement(
      parsed.firstScreenLayoutEvidence,
      `${path}.firstScreenLayoutEvidence`,
    );
  } catch {
    return undefined;
  }
}

function selectLatestFreshMossLayoutMeasurement(
  document: MossCodexDesktopComparatorDocument,
  repoRoot: string,
): MossCodexDesktopFirstScreenLayoutMeasurement | undefined {
  let latest: MossCodexDesktopFirstScreenLayoutMeasurement | undefined;
  let latestCapturedAt = Number.NEGATIVE_INFINITY;

  for (const evidencePath of collectFreshMossLayoutEvidencePaths(document)) {
    const measurement = readFreshMossLayoutMeasurement(repoRoot, evidencePath);
    if (!measurement) {
      continue;
    }
    const capturedAt = Date.parse(measurement.capturedAt);
    if (!Number.isFinite(capturedAt) || capturedAt <= latestCapturedAt) {
      continue;
    }
    latest = measurement;
    latestCapturedAt = capturedAt;
  }

  return latest;
}

function applyFreshMossLayoutEvidence(
  document: MossCodexDesktopComparatorDocument,
  repoRoot: string,
): MossCodexDesktopComparatorDocument {
  const latest = selectLatestFreshMossLayoutMeasurement(document, repoRoot);
  if (!latest) {
    return document;
  }

  const currentCapturedAt = Date.parse(document.layoutMetrics.mossElectron.capturedAt);
  const latestCapturedAt = Date.parse(latest.capturedAt);
  if (
    Number.isFinite(currentCapturedAt) &&
    Number.isFinite(latestCapturedAt) &&
    latestCapturedAt <= currentCapturedAt
  ) {
    return document;
  }

  const documentUpdatedAt = Date.parse(document.updatedAt);
  const updatedAt =
    !Number.isFinite(documentUpdatedAt) ||
    (Number.isFinite(latestCapturedAt) && latestCapturedAt > documentUpdatedAt)
      ? latest.capturedAt
      : document.updatedAt;

  return {
    ...document,
    updatedAt,
    layoutMetrics: {
      ...document.layoutMetrics,
      mossElectron: latest,
    },
  };
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }
  return numerator / denominator;
}

function absoluteDelta(left: number, right: number): number {
  return Math.abs(left - right);
}

function formatDelta(value: number | boolean): string {
  if (typeof value === "boolean") {
    return String(value);
  }
  if (Number.isInteger(value)) {
    return String(value);
  }
  return value.toFixed(6);
}

function buildDeltaMessage(
  deltas: Readonly<Record<string, number | boolean>>,
  thresholds: Readonly<Record<string, number>>,
): string {
  return Object.entries(deltas)
    .map(([key, value]) => {
      const threshold = thresholds[key];
      return threshold === undefined
        ? `${key}=${formatDelta(value)}`
        : `${key}=${formatDelta(value)} (max ${formatDelta(threshold)})`;
    })
    .join(", ");
}

function buildMossCodexDesktopLayoutDeltas(
  layoutMetrics: MossCodexDesktopFirstScreenLayoutMetrics,
): ReadonlyArray<MossCodexDesktopLayoutDelta> {
  const codex = layoutMetrics.codexDesktop;
  const moss = layoutMetrics.mossElectron;
  const thresholds = layoutMetrics.thresholds;
  const composerDeltas = {
    topRatioDelta: absoluteDelta(
      ratio(codex.composerTopPx, codex.viewportHeightPx),
      ratio(moss.composerTopPx, moss.viewportHeightPx),
    ),
    bottomGapDeltaPx: absoluteDelta(codex.composerBottomGapPx, moss.composerBottomGapPx),
    heightDeltaPx: absoluteDelta(codex.composerHeightPx, moss.composerHeightPx),
  };
  const composerThresholds = {
    topRatioDelta: thresholds.maxComposerTopRatioDelta,
    bottomGapDeltaPx: thresholds.maxComposerBottomGapPxDelta,
    heightDeltaPx: thresholds.maxComposerHeightPxDelta,
  };
  const sideAccessDeltas = {
    widthRatioDelta: absoluteDelta(
      ratio(codex.sideAccessWidthPx, codex.viewportWidthPx),
      ratio(moss.sideAccessWidthPx, moss.viewportWidthPx),
    ),
    mossSideAccessVisible: moss.sideAccessVisible,
  };
  const sideAccessThresholds = {
    widthRatioDelta: thresholds.maxSideAccessWidthRatioDelta,
  };
  const missingControlPlaneAffordances = Math.max(
    0,
    moss.requiredControlPlaneAffordanceCount - moss.controlPlaneAffordanceCount,
  );
  const controlPlaneDeltas = {
    missingMossAffordances: missingControlPlaneAffordances,
    requiredMossAffordances: moss.requiredControlPlaneAffordanceCount,
    visibleMossAffordances: moss.controlPlaneAffordanceCount,
  };
  const controlPlaneThresholds = {
    missingMossAffordances: thresholds.maxMissingControlPlaneAffordances,
  };
  const timelineDeltas = {
    rowCountDelta: absoluteDelta(codex.normalizedEventRowCount, moss.normalizedEventRowCount),
    mossDensityRowsPer1000Px: moss.timelineDensityRowsPer1000Px,
    densityRowsPer1000PxDelta: absoluteDelta(
      codex.timelineDensityRowsPer1000Px,
      moss.timelineDensityRowsPer1000Px,
    ),
  };
  const timelineThresholds = {
    rowCountDelta: thresholds.maxNormalizedEventRowCountDelta,
    minMossDensityRowsPer1000Px: thresholds.minMossTimelineDensityRowsPer1000Px,
    densityRowsPer1000PxDelta: thresholds.maxTimelineDensityRowsPer1000PxDelta,
  };
  const timelineMessage = [
    `rowCountDelta=${formatDelta(timelineDeltas.rowCountDelta)} (max ${formatDelta(
      thresholds.maxNormalizedEventRowCountDelta,
    )})`,
    `mossDensityRowsPer1000Px=${formatDelta(
      timelineDeltas.mossDensityRowsPer1000Px,
    )} (min ${formatDelta(thresholds.minMossTimelineDensityRowsPer1000Px)})`,
    `densityRowsPer1000PxDelta=${formatDelta(
      timelineDeltas.densityRowsPer1000PxDelta,
    )} (max ${formatDelta(thresholds.maxTimelineDensityRowsPer1000PxDelta)})`,
  ].join(", ");

  return [
    {
      id: "composer-position",
      label: "Composer position",
      status:
        composerDeltas.topRatioDelta <= thresholds.maxComposerTopRatioDelta &&
        composerDeltas.bottomGapDeltaPx <= thresholds.maxComposerBottomGapPxDelta &&
        composerDeltas.heightDeltaPx <= thresholds.maxComposerHeightPxDelta
          ? "pass"
          : "fail",
      delta: composerDeltas,
      threshold: composerThresholds,
      message: buildDeltaMessage(composerDeltas, composerThresholds),
    },
    {
      id: "side-session-access",
      label: "Side/session access",
      status:
        moss.sideAccessVisible &&
        sideAccessDeltas.widthRatioDelta <= thresholds.maxSideAccessWidthRatioDelta
          ? "pass"
          : "fail",
      delta: sideAccessDeltas,
      threshold: sideAccessThresholds,
      message: buildDeltaMessage(sideAccessDeltas, sideAccessThresholds),
    },
    {
      id: "control-plane-affordance-visibility",
      label: "Control-plane affordance visibility",
      status:
        missingControlPlaneAffordances <= thresholds.maxMissingControlPlaneAffordances
          ? "pass"
          : "fail",
      delta: controlPlaneDeltas,
      threshold: controlPlaneThresholds,
      message: buildDeltaMessage(controlPlaneDeltas, controlPlaneThresholds),
    },
    {
      id: "normalized-event-timeline-density",
      label: "Normalized event timeline density",
      status:
        timelineDeltas.rowCountDelta <= thresholds.maxNormalizedEventRowCountDelta &&
        timelineDeltas.mossDensityRowsPer1000Px >= thresholds.minMossTimelineDensityRowsPer1000Px &&
        timelineDeltas.densityRowsPer1000PxDelta <= thresholds.maxTimelineDensityRowsPer1000PxDelta
          ? "pass"
          : "fail",
      delta: timelineDeltas,
      threshold: timelineThresholds,
      message: timelineMessage,
    },
  ];
}

function appendLayoutMeasurementIssues(
  issues: string[],
  repoRoot: string,
  label: string,
  measurement: MossCodexDesktopFirstScreenLayoutMeasurement,
): void {
  if (!Number.isFinite(Date.parse(measurement.capturedAt))) {
    issues.push(`${label}.capturedAt must be a valid ISO timestamp`);
  }
  if (measurement.viewportWidthPx <= 0) {
    issues.push(`${label}.viewportWidthPx must be greater than 0`);
  }
  if (measurement.viewportHeightPx <= 0) {
    issues.push(`${label}.viewportHeightPx must be greater than 0`);
  }
  if (measurement.timelineHeightPx <= 0) {
    issues.push(`${label}.timelineHeightPx must be greater than 0`);
  }
  if (measurement.requiredControlPlaneAffordanceCount <= 0) {
    issues.push(`${label}.requiredControlPlaneAffordanceCount must be greater than 0`);
  }
  if (
    measurement.composerTopPx + measurement.composerHeightPx + measurement.composerBottomGapPx >
    measurement.viewportHeightPx
  ) {
    issues.push(`${label}.composer geometry exceeds viewport height`);
  }
  for (const evidencePath of measurement.evidence) {
    if (!pathExists(repoRoot, evidencePath)) {
      issues.push(`missing ${label} layout evidence path: ${evidencePath}`);
    }
  }
}

function buildMossCodexDesktopComparatorIssues(
  document: MossCodexDesktopComparatorDocument,
  repoRoot: string,
  codexDesktopImage: MossCodexDesktopImageMetadata,
  mossImages: ReadonlyArray<MossCodexDesktopImageMetadata>,
  layoutDeltas: ReadonlyArray<MossCodexDesktopLayoutDelta>,
): ReadonlyArray<string> {
  const issues: string[] = [];
  const comparisonIds = new Set(document.comparisons.map((comparison) => comparison.id));
  const baselineTraits = new Set(document.codexDesktopBaseline.observedShellTraits);

  for (const id of REQUIRED_CODEX_DESKTOP_COMPARISON_IDS) {
    if (!comparisonIds.has(id)) {
      issues.push(`missing required Codex Desktop comparison: ${id}`);
    }
  }

  for (const trait of REQUIRED_CODEX_DESKTOP_BASELINE_TRAITS) {
    if (!baselineTraits.has(trait)) {
      issues.push(`missing required Codex Desktop baseline trait: ${trait}`);
    }
  }

  if (document.overallStatus === "aligned") {
    issues.push("overallStatus must stay partial until full Codex Desktop parity is proved");
  }

  const baselineCapturedAt = Date.parse(document.codexDesktopBaseline.capturedAt);
  const documentUpdatedAt = Date.parse(document.updatedAt);
  if (!Number.isFinite(baselineCapturedAt)) {
    issues.push("codexDesktopBaseline.capturedAt must be a valid ISO timestamp");
  }
  if (!Number.isFinite(documentUpdatedAt)) {
    issues.push("updatedAt must be a valid ISO timestamp");
  }
  if (
    Number.isFinite(baselineCapturedAt) &&
    Number.isFinite(documentUpdatedAt) &&
    Math.abs(documentUpdatedAt - baselineCapturedAt) > MAX_BASELINE_AGE_MS
  ) {
    issues.push("codexDesktopBaseline screenshot is older than 24 hours from document updatedAt");
  }

  if (codexDesktopImage.format !== "png" || !codexDesktopImage.exists) {
    issues.push("codexDesktopBaseline.screenshotPath must point to an existing PNG image");
  }
  if (
    codexDesktopImage.format === "png" &&
    ((codexDesktopImage.width ?? 0) < 1200 || (codexDesktopImage.height ?? 0) < 700)
  ) {
    issues.push("codexDesktopBaseline screenshot must be at least 1200x700 for shell comparison");
  }

  if (!document.codexDesktopBaseline.source.includes("screencapture")) {
    issues.push("codexDesktopBaseline.source must identify the direct capture mechanism");
  }
  if (document.codexDesktopBaseline.processName !== "Codex") {
    issues.push("codexDesktopBaseline.processName must be Codex");
  }
  if (document.codexDesktopBaseline.evidenceLimitations.length === 0) {
    issues.push("codexDesktopBaseline.evidenceLimitations must record comparator limits");
  }
  if (!mossImages.some((image) => image.format === "png" && image.exists)) {
    issues.push("at least one Moss screenshot evidence PNG is required");
  }

  for (const evidence of document.mossEvidence) {
    if (!pathExists(repoRoot, evidence.path)) {
      issues.push(`missing Moss evidence path: ${evidence.path}`);
    }
  }

  appendLayoutMeasurementIssues(
    issues,
    repoRoot,
    "layoutMetrics.codexDesktop",
    document.layoutMetrics.codexDesktop,
  );
  appendLayoutMeasurementIssues(
    issues,
    repoRoot,
    "layoutMetrics.mossElectron",
    document.layoutMetrics.mossElectron,
  );

  for (const layoutDelta of layoutDeltas) {
    if (layoutDelta.status === "fail") {
      issues.push(`layout delta ${layoutDelta.id} failed: ${layoutDelta.message}`);
    }
  }

  for (const comparison of document.comparisons) {
    if (!comparison.directCodexDesktopBaseline) {
      issues.push(`comparison ${comparison.id} must use direct Codex Desktop baseline evidence`);
    }
    if (!comparison.codexDesktopEvidence.includes(document.codexDesktopBaseline.screenshotPath)) {
      issues.push(`comparison ${comparison.id} must reference the Codex Desktop screenshot`);
    }
    if (comparison.status === "unverified") {
      issues.push(`comparison ${comparison.id} is unverified`);
    }
    if (comparison.status !== "aligned" && !comparison.nextTaskHint) {
      issues.push(`comparison ${comparison.id} needs nextTaskHint`);
    }
  }

  return issues;
}

export function buildMossCodexDesktopComparatorReport(
  document: MossCodexDesktopComparatorDocument,
  repoRoot = process.cwd(),
  path = DEFAULT_COMPARATOR_PATH,
): MossCodexDesktopComparatorReport {
  const effectiveDocument = applyFreshMossLayoutEvidence(document, repoRoot);
  const codexDesktopImage = readPngMetadata(
    repoRoot,
    effectiveDocument.codexDesktopBaseline.screenshotPath,
  );
  const mossImages = effectiveDocument.mossEvidence
    .filter((evidence) => evidence.kind === "screenshot")
    .map((evidence) => readPngMetadata(repoRoot, evidence.path));
  const layoutDeltas = buildMossCodexDesktopLayoutDeltas(effectiveDocument.layoutMetrics);
  const issues = buildMossCodexDesktopComparatorIssues(
    effectiveDocument,
    repoRoot,
    codexDesktopImage,
    mossImages,
    layoutDeltas,
  );
  const layoutGateStatus = layoutDeltas.every((layoutDelta) => layoutDelta.status === "pass")
    ? "pass"
    : "fail";

  return {
    version: 1,
    path,
    updatedAt: effectiveDocument.updatedAt,
    scope: effectiveDocument.scope,
    overallStatus: effectiveDocument.overallStatus,
    fullCodexParityClaim: false,
    gateStatus: issues.length === 0 ? "pass" : "fail",
    statusCounts: countMossCodexDesktopComparatorStatuses(effectiveDocument.comparisons),
    requiredComparisonIds: [...REQUIRED_CODEX_DESKTOP_COMPARISON_IDS],
    requiredBaselineTraits: [...REQUIRED_CODEX_DESKTOP_BASELINE_TRAITS],
    layoutGateStatus,
    layoutDeltas,
    layoutMetrics: effectiveDocument.layoutMetrics,
    nextGap: selectMossCodexDesktopComparatorNextGap(effectiveDocument),
    issueCount: issues.length,
    issues,
    codexDesktopBaseline: effectiveDocument.codexDesktopBaseline,
    codexDesktopImage,
    mossImages,
    mossEvidence: effectiveDocument.mossEvidence,
    comparisons: effectiveDocument.comparisons,
  };
}

export function readMossCodexDesktopComparatorReport(
  repoRoot = process.cwd(),
  path = DEFAULT_COMPARATOR_PATH,
): MossCodexDesktopComparatorReport {
  const content = readFileSync(join(repoRoot, path), "utf8");
  return buildMossCodexDesktopComparatorReport(
    parseMossCodexDesktopComparatorDocument(content, path),
    repoRoot,
    path,
  );
}
