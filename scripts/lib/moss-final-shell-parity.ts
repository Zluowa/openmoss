import { readFileSync } from "node:fs";
import { join } from "node:path";

export type MossFinalShellCriterionStatus = "aligned" | "partial" | "gap" | "unverified";
export type MossFinalShellAuditGateStatus = "pass" | "fail";

export interface MossFinalShellCriterion {
  readonly id: string;
  readonly label: string;
  readonly requirement: string;
  readonly status: MossFinalShellCriterionStatus;
  readonly codexDesktopTarget: string;
  readonly currentMossEvidence: string;
  readonly findings: ReadonlyArray<string>;
  readonly evidence: ReadonlyArray<string>;
  readonly gap: string;
  readonly nextTaskHint?: string | undefined;
}

export interface MossFinalShellAuditDocument {
  readonly version: 1;
  readonly updatedAt: string;
  readonly scope: string;
  readonly overallStatus: MossFinalShellCriterionStatus;
  readonly fullCodexParityClaim: false;
  readonly summary: {
    readonly nextGapId?: string | undefined;
    readonly note?: string | undefined;
  };
  readonly criteria: ReadonlyArray<MossFinalShellCriterion>;
}

export interface MossFinalShellNextGap {
  readonly id: string;
  readonly status: MossFinalShellCriterionStatus;
  readonly label: string;
  readonly gap: string;
  readonly nextTaskHint?: string | undefined;
  readonly evidence: ReadonlyArray<string>;
}

export interface MossFinalShellAuditReport {
  readonly version: 1;
  readonly path: string;
  readonly updatedAt: string;
  readonly scope: string;
  readonly overallStatus: MossFinalShellCriterionStatus;
  readonly fullCodexParityClaim: false;
  readonly auditGateStatus: MossFinalShellAuditGateStatus;
  readonly statusCounts: Record<MossFinalShellCriterionStatus, number>;
  readonly requiredCriterionIds: ReadonlyArray<string>;
  readonly nextGap: MossFinalShellNextGap | null;
  readonly issueCount: number;
  readonly issues: ReadonlyArray<string>;
  readonly criteria: ReadonlyArray<MossFinalShellCriterion>;
}

const STATUSES = ["aligned", "partial", "gap", "unverified"] as const;
const DEFAULT_FINAL_SHELL_AUDIT_PATH = ".moss/final-shell-parity.json";
export const REQUIRED_FINAL_SHELL_CRITERION_IDS = [
  "first-screen-layout",
  "routing",
  "density",
  "state-transitions",
  "interaction-sequencing",
  "native-surface-access",
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

function parseStatus(value: unknown, path: string): MossFinalShellCriterionStatus {
  if (!STATUSES.includes(value as MossFinalShellCriterionStatus)) {
    throw new Error(`${path} must be one of ${STATUSES.join(", ")}`);
  }
  return value as MossFinalShellCriterionStatus;
}

function parseCriterion(value: unknown, index: number): MossFinalShellCriterion {
  const path = `criteria[${index}]`;
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`);
  }
  return {
    id: requiredString(value.id, `${path}.id`),
    label: requiredString(value.label, `${path}.label`),
    requirement: requiredString(value.requirement, `${path}.requirement`),
    status: parseStatus(value.status, `${path}.status`),
    codexDesktopTarget: requiredString(value.codexDesktopTarget, `${path}.codexDesktopTarget`),
    currentMossEvidence: requiredString(value.currentMossEvidence, `${path}.currentMossEvidence`),
    findings: stringArray(value.findings, `${path}.findings`),
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

export function parseMossFinalShellAuditDocument(
  content: string,
  source: string,
): MossFinalShellAuditDocument {
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
  if (!Array.isArray(raw.criteria)) {
    throw new Error(`${source}.criteria must be an array`);
  }

  const criteria = raw.criteria.map(parseCriterion);
  const duplicates = duplicateIds(criteria);
  if (duplicates.length > 0) {
    throw new Error(`${source}.criteria duplicate ids: ${duplicates.join(", ")}`);
  }

  const nextGapId = optionalString(raw.summary.nextGapId, `${source}.summary.nextGapId`);
  if (nextGapId) {
    const criterion = criteria.find((entry) => entry.id === nextGapId);
    if (!criterion) {
      throw new Error(`${source}.summary.nextGapId points to missing criterion ${nextGapId}`);
    }
    if (criterion.status === "aligned") {
      throw new Error(`${source}.summary.nextGapId must not point to an aligned criterion`);
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
    criteria,
  };
}

export function countMossFinalShellStatuses(
  criteria: ReadonlyArray<MossFinalShellCriterion>,
): Record<MossFinalShellCriterionStatus, number> {
  const counts: Record<MossFinalShellCriterionStatus, number> = {
    aligned: 0,
    partial: 0,
    gap: 0,
    unverified: 0,
  };
  for (const criterion of criteria) {
    counts[criterion.status] += 1;
  }
  return counts;
}

export function selectMossFinalShellNextGap(
  document: MossFinalShellAuditDocument,
): MossFinalShellNextGap | null {
  const criterion = document.summary.nextGapId
    ? document.criteria.find((entry) => entry.id === document.summary.nextGapId)
    : document.criteria.find((entry) => entry.status !== "aligned");
  if (!criterion || criterion.status === "aligned") {
    return null;
  }
  return {
    id: criterion.id,
    status: criterion.status,
    label: criterion.label,
    gap: criterion.gap,
    ...(criterion.nextTaskHint ? { nextTaskHint: criterion.nextTaskHint } : {}),
    evidence: criterion.evidence,
  };
}

function buildMossFinalShellAuditIssues(
  document: MossFinalShellAuditDocument,
): ReadonlyArray<string> {
  const issues: string[] = [];
  const criterionIds = new Set(document.criteria.map((criterion) => criterion.id));

  for (const id of REQUIRED_FINAL_SHELL_CRITERION_IDS) {
    if (!criterionIds.has(id)) {
      issues.push(`missing required final shell criterion: ${id}`);
    }
  }

  if (document.overallStatus === "aligned") {
    issues.push("overallStatus must stay partial until full Codex Desktop parity is proved");
  }

  for (const criterion of document.criteria) {
    if (criterion.status === "unverified") {
      issues.push(`final shell criterion ${criterion.id} is unverified`);
    }
    if (criterion.status !== "aligned" && !criterion.nextTaskHint) {
      issues.push(`final shell criterion ${criterion.id} needs nextTaskHint`);
    }
  }

  return issues;
}

export function buildMossFinalShellAuditReport(
  document: MossFinalShellAuditDocument,
  path = DEFAULT_FINAL_SHELL_AUDIT_PATH,
): MossFinalShellAuditReport {
  const issues = buildMossFinalShellAuditIssues(document);
  return {
    version: 1,
    path,
    updatedAt: document.updatedAt,
    scope: document.scope,
    overallStatus: document.overallStatus,
    fullCodexParityClaim: false,
    auditGateStatus: issues.length === 0 ? "pass" : "fail",
    statusCounts: countMossFinalShellStatuses(document.criteria),
    requiredCriterionIds: [...REQUIRED_FINAL_SHELL_CRITERION_IDS],
    nextGap: selectMossFinalShellNextGap(document),
    issueCount: issues.length,
    issues,
    criteria: document.criteria,
  };
}

export function readMossFinalShellAuditReport(
  repoRoot = process.cwd(),
  path = DEFAULT_FINAL_SHELL_AUDIT_PATH,
): MossFinalShellAuditReport {
  const content = readFileSync(join(repoRoot, path), "utf8");
  return buildMossFinalShellAuditReport(parseMossFinalShellAuditDocument(content, path), path);
}
