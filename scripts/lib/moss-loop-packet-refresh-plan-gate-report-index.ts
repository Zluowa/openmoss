import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import {
  readMossReleaseFreshnessRefreshPlanReportIndex,
  type MossReleaseFreshnessRefreshPlanReportIndex,
} from "./moss-release-freshness-refresh-plan-report-index.ts";
import {
  parseMossChainedRefreshProvenance,
  type MossChainedRefreshProvenance,
} from "./moss-chained-refresh-provenance.ts";

export interface MossLoopPacketRefreshPlanGateReportArtifactSummary {
  readonly path: string;
  readonly createdAt: string;
  readonly status: "pass" | "fail";
  readonly taskId: string;
  readonly taskTitle: string;
  readonly chainedRefreshProvenance?: MossChainedRefreshProvenance | undefined;
  readonly checkStatus: "pass" | "pending" | "fail";
  readonly checkSummary: string;
  readonly loopPacketReadinessStatus: "ready" | "pending" | "blocked";
  readonly writesFiles: boolean;
  readonly writesGlobalConfig: boolean;
  readonly providerCredentialsRequired: boolean;
  readonly refreshPlan: {
    readonly status: "pass" | "pending" | "blocked";
    readonly readinessStatus: "pass" | "fail";
    readonly summary: string;
    readonly expectedStepCount: number;
    readonly latestStepCount?: number | undefined;
    readonly refreshPlanArtifactPath?: string | undefined;
    readonly latestArtifactStatus?: "pass" | "fail" | undefined;
    readonly mode?: string | undefined;
    readonly writesFiles?: boolean | undefined;
    readonly writesGlobalConfig?: boolean | undefined;
    readonly providerCredentialsRequired?: boolean | undefined;
    readonly requiresReleaseArtifactRefresh?: boolean | undefined;
    readonly requiresLoopFreshnessRefresh?: boolean | undefined;
    readonly issueCount: number;
    readonly issueCodes: ReadonlyArray<string>;
  };
}

export interface MossLoopPacketRefreshPlanGateReportIssue {
  readonly code:
    | "missing-artifacts"
    | "malformed-artifact"
    | "invalid-artifact"
    | "stale-refresh-plan"
    | "unsafe-write-flags"
    | "failing-artifact";
  readonly severity: "error";
  readonly path?: string | undefined;
  readonly message: string;
}

export interface MossLoopPacketRefreshPlanGateReportIndex {
  readonly version: 1;
  readonly generatedAt: string;
  readonly sourceDirectory: string;
  readonly latest: MossLoopPacketRefreshPlanGateReportArtifactSummary | null;
  readonly artifacts: ReadonlyArray<MossLoopPacketRefreshPlanGateReportArtifactSummary>;
  readonly issues: ReadonlyArray<MossLoopPacketRefreshPlanGateReportIssue>;
  readonly readiness: {
    readonly status: "pass" | "fail";
    readonly summary: string;
  };
}

export interface MossLoopPacketRefreshPlanGateReportIndexOptions {
  readonly generatedAt?: string;
}

const EVIDENCE_DIRECTORY = ".moss/ledger/evidence";
const REPORT_ARTIFACT_PATTERN = /^moss-loop-packet-refresh-plan-gate-report-.+\.json$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function relativeArtifactPath(repoRoot: string, absolutePath: string): string {
  return relative(repoRoot, absolutePath).replaceAll("\\", "/");
}

function invalidArtifactIssue(
  path: string,
  message: string,
): MossLoopPacketRefreshPlanGateReportIssue {
  return {
    code: "invalid-artifact",
    severity: "error",
    path,
    message,
  };
}

function asStringArray(value: unknown): ReadonlyArray<string> | null {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    return null;
  }
  return value;
}

function parseRefreshPlan(
  artifactPath: string,
  value: unknown,
): {
  readonly refreshPlan?:
    | MossLoopPacketRefreshPlanGateReportArtifactSummary["refreshPlan"]
    | undefined;
  readonly issue?: MossLoopPacketRefreshPlanGateReportIssue | undefined;
} {
  if (!isObject(value)) {
    return {
      issue: invalidArtifactIssue(artifactPath, `${artifactPath} refreshPlan must be an object.`),
    };
  }

  const issueCodes = asStringArray(value.issueCodes);
  if (
    (value.status !== "pass" && value.status !== "pending" && value.status !== "blocked") ||
    (value.readinessStatus !== "pass" && value.readinessStatus !== "fail") ||
    typeof value.summary !== "string" ||
    typeof value.expectedStepCount !== "number" ||
    typeof value.issueCount !== "number" ||
    !issueCodes
  ) {
    return {
      issue: invalidArtifactIssue(
        artifactPath,
        `${artifactPath} refreshPlan has an invalid compact shape.`,
      ),
    };
  }

  return {
    refreshPlan: {
      status: value.status,
      readinessStatus: value.readinessStatus,
      summary: value.summary,
      expectedStepCount: value.expectedStepCount,
      ...(typeof value.latestStepCount === "number"
        ? { latestStepCount: value.latestStepCount }
        : {}),
      ...(typeof value.artifactPath === "string"
        ? { refreshPlanArtifactPath: value.artifactPath }
        : {}),
      ...(value.latestArtifactStatus === "pass" || value.latestArtifactStatus === "fail"
        ? { latestArtifactStatus: value.latestArtifactStatus }
        : {}),
      ...(typeof value.mode === "string" ? { mode: value.mode } : {}),
      ...(typeof value.writesFiles === "boolean" ? { writesFiles: value.writesFiles } : {}),
      ...(typeof value.writesGlobalConfig === "boolean"
        ? { writesGlobalConfig: value.writesGlobalConfig }
        : {}),
      ...(typeof value.providerCredentialsRequired === "boolean"
        ? { providerCredentialsRequired: value.providerCredentialsRequired }
        : {}),
      ...(typeof value.requiresReleaseArtifactRefresh === "boolean"
        ? { requiresReleaseArtifactRefresh: value.requiresReleaseArtifactRefresh }
        : {}),
      ...(typeof value.requiresLoopFreshnessRefresh === "boolean"
        ? { requiresLoopFreshnessRefresh: value.requiresLoopFreshnessRefresh }
        : {}),
      issueCount: value.issueCount,
      issueCodes,
    },
  };
}

function parseReportArtifact(input: { readonly repoRoot: string; readonly absolutePath: string }): {
  readonly artifact?: MossLoopPacketRefreshPlanGateReportArtifactSummary | undefined;
  readonly issues: ReadonlyArray<MossLoopPacketRefreshPlanGateReportIssue>;
} {
  const artifactPath = relativeArtifactPath(input.repoRoot, input.absolutePath);
  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(input.absolutePath, "utf8"));
  } catch (error) {
    return {
      issues: [
        {
          code: "malformed-artifact",
          severity: "error",
          path: artifactPath,
          message: `${artifactPath} is not valid JSON: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      ],
    };
  }

  if (!isObject(parsed)) {
    return {
      issues: [invalidArtifactIssue(artifactPath, `${artifactPath} must contain a JSON object.`)],
    };
  }
  if (parsed.version !== 1) {
    return {
      issues: [invalidArtifactIssue(artifactPath, `${artifactPath} must have version=1.`)],
    };
  }
  if (typeof parsed.createdAt !== "string" || parsed.createdAt.length === 0) {
    return {
      issues: [invalidArtifactIssue(artifactPath, `${artifactPath} must have createdAt.`)],
    };
  }
  if (parsed.status !== "pass" && parsed.status !== "fail") {
    return {
      issues: [invalidArtifactIssue(artifactPath, `${artifactPath} must have pass/fail status.`)],
    };
  }
  if (!isObject(parsed.task) || typeof parsed.task.taskId !== "string") {
    return {
      issues: [invalidArtifactIssue(artifactPath, `${artifactPath} must have task.taskId.`)],
    };
  }
  if (
    !isObject(parsed.check) ||
    parsed.check.id !== "loop-ledger-refresh-plan" ||
    (parsed.check.status !== "pass" &&
      parsed.check.status !== "pending" &&
      parsed.check.status !== "fail") ||
    typeof parsed.check.summary !== "string"
  ) {
    return {
      issues: [invalidArtifactIssue(artifactPath, `${artifactPath} must have refresh plan check.`)],
    };
  }
  if (
    !isObject(parsed.loopPacketReadiness) ||
    (parsed.loopPacketReadiness.status !== "ready" &&
      parsed.loopPacketReadiness.status !== "pending" &&
      parsed.loopPacketReadiness.status !== "blocked")
  ) {
    return {
      issues: [
        invalidArtifactIssue(artifactPath, `${artifactPath} must have loopPacketReadiness.status.`),
      ],
    };
  }
  if (
    typeof parsed.writesFiles !== "boolean" ||
    typeof parsed.writesGlobalConfig !== "boolean" ||
    typeof parsed.providerCredentialsRequired !== "boolean"
  ) {
    return {
      issues: [
        invalidArtifactIssue(artifactPath, `${artifactPath} must have top-level write flags.`),
      ],
    };
  }

  const parsedRefreshPlan = parseRefreshPlan(artifactPath, parsed.refreshPlan);
  if (parsedRefreshPlan.issue || !parsedRefreshPlan.refreshPlan) {
    return {
      issues: [
        parsedRefreshPlan.issue ??
          invalidArtifactIssue(artifactPath, `${artifactPath} refreshPlan is invalid.`),
      ],
    };
  }

  const chainedRefreshProvenance = parseMossChainedRefreshProvenance({
    value: parsed,
    fallbackTaskId: parsed.task.taskId,
    fallbackSource: "loop-packet-task-metadata",
  });
  const artifact = {
    path: artifactPath,
    createdAt: parsed.createdAt,
    status: parsed.status,
    taskId: parsed.task.taskId,
    taskTitle: typeof parsed.task.title === "string" ? parsed.task.title : "",
    ...(chainedRefreshProvenance ? { chainedRefreshProvenance } : {}),
    checkStatus: parsed.check.status,
    checkSummary: parsed.check.summary,
    loopPacketReadinessStatus: parsed.loopPacketReadiness.status,
    writesFiles: parsed.writesFiles,
    writesGlobalConfig: parsed.writesGlobalConfig,
    providerCredentialsRequired: parsed.providerCredentialsRequired,
    refreshPlan: parsedRefreshPlan.refreshPlan,
  } satisfies MossLoopPacketRefreshPlanGateReportArtifactSummary;
  const issues =
    artifact.status === "fail"
      ? [
          {
            code: "failing-artifact",
            severity: "error",
            path: artifact.path,
            message: `${artifact.path} reports failed loop packet refresh plan gate status.`,
          } as const satisfies MossLoopPacketRefreshPlanGateReportIssue,
        ]
      : [];

  return { artifact, issues };
}

function sortArtifacts(
  artifacts: ReadonlyArray<MossLoopPacketRefreshPlanGateReportArtifactSummary>,
): ReadonlyArray<MossLoopPacketRefreshPlanGateReportArtifactSummary> {
  return artifacts.toSorted(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) || right.path.localeCompare(left.path),
  );
}

function buildRefreshPlanFreshnessIssues(input: {
  readonly latest: MossLoopPacketRefreshPlanGateReportArtifactSummary | null;
  readonly refreshPlanReportIndex: MossReleaseFreshnessRefreshPlanReportIndex | null;
}): ReadonlyArray<MossLoopPacketRefreshPlanGateReportIssue> {
  const { latest, refreshPlanReportIndex } = input;
  if (!latest || latest.status !== "pass") {
    return [];
  }

  const latestRefreshPlanArtifact = refreshPlanReportIndex?.latest ?? null;
  if (!refreshPlanReportIndex || !latestRefreshPlanArtifact) {
    return [
      {
        code: "stale-refresh-plan",
        severity: "error",
        path: latest.path,
        message: `${latest.path} cannot prove refresh plan freshness because no current refresh plan report artifact is indexed.`,
      },
    ];
  }

  const refreshPlan = latest.refreshPlan;
  const issueCodes = refreshPlanReportIndex.issues.map((issue) => issue.code);
  const mismatches: string[] = [];
  if (refreshPlanReportIndex.readiness.status !== "pass") {
    mismatches.push(
      `refresh plan artifact index readiness is ${refreshPlanReportIndex.readiness.status} with issue(s) [${issueCodes.join(
        ", ",
      )}]`,
    );
  }
  if (refreshPlan.readinessStatus !== "pass" || refreshPlan.issueCount !== 0) {
    mismatches.push(
      `embedded refresh plan readiness is ${refreshPlan.readinessStatus} with ${refreshPlan.issueCount} issue(s)`,
    );
  }
  if (refreshPlan.refreshPlanArtifactPath !== latestRefreshPlanArtifact.path) {
    mismatches.push(
      `embedded refresh plan artifact path ${
        refreshPlan.refreshPlanArtifactPath ?? "none"
      } does not match latest ${latestRefreshPlanArtifact.path}`,
    );
  }
  if (refreshPlan.expectedStepCount !== refreshPlanReportIndex.expectedStepOrder.length) {
    mismatches.push(
      `embedded expected step count ${refreshPlan.expectedStepCount} does not match current expected ${refreshPlanReportIndex.expectedStepOrder.length}`,
    );
  }
  if (refreshPlan.latestStepCount !== latestRefreshPlanArtifact.stepOrder.length) {
    mismatches.push(
      `embedded latest step count ${refreshPlan.latestStepCount ?? "none"} does not match latest ${latestRefreshPlanArtifact.stepOrder.length}`,
    );
  }
  if (refreshPlan.latestArtifactStatus !== latestRefreshPlanArtifact.status) {
    mismatches.push(
      `embedded latest artifact status ${
        refreshPlan.latestArtifactStatus ?? "none"
      } does not match latest ${latestRefreshPlanArtifact.status}`,
    );
  }

  if (mismatches.length === 0) {
    return [];
  }

  return [
    {
      code: "stale-refresh-plan",
      severity: "error",
      path: latest.path,
      message: `${latest.path} is stale against the current Moss release freshness refresh plan artifact: ${mismatches.join(
        "; ",
      )}.`,
    },
  ];
}

function buildUnsafeWriteFlagIssues(
  latest: MossLoopPacketRefreshPlanGateReportArtifactSummary | null,
): ReadonlyArray<MossLoopPacketRefreshPlanGateReportIssue> {
  if (!latest || latest.status !== "pass") {
    return [];
  }

  const unsafeMessages: string[] = [];
  if (latest.writesFiles !== false) {
    unsafeMessages.push("report writesFiles is not false");
  }
  if (latest.writesGlobalConfig !== false) {
    unsafeMessages.push("report writesGlobalConfig is not false");
  }
  if (latest.providerCredentialsRequired !== false) {
    unsafeMessages.push("report providerCredentialsRequired is not false");
  }
  if (latest.refreshPlan.mode !== "dry-run") {
    unsafeMessages.push(`refresh plan mode is ${latest.refreshPlan.mode ?? "none"}`);
  }
  if (latest.refreshPlan.writesFiles !== false) {
    unsafeMessages.push("refresh plan writesFiles is not false");
  }
  if (latest.refreshPlan.writesGlobalConfig !== false) {
    unsafeMessages.push("refresh plan writesGlobalConfig is not false");
  }
  if (latest.refreshPlan.providerCredentialsRequired !== false) {
    unsafeMessages.push("refresh plan providerCredentialsRequired is not false");
  }

  if (unsafeMessages.length === 0) {
    return [];
  }

  return [
    {
      code: "unsafe-write-flags",
      severity: "error",
      path: latest.path,
      message: `${latest.path} has unsafe loop packet refresh plan gate write flags: ${unsafeMessages.join(
        "; ",
      )}.`,
    },
  ];
}

export function readMossLoopPacketRefreshPlanGateReportIndex(
  repoRoot = process.cwd(),
  options: MossLoopPacketRefreshPlanGateReportIndexOptions = {},
): MossLoopPacketRefreshPlanGateReportIndex {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const evidenceDirectory = join(repoRoot, EVIDENCE_DIRECTORY);
  const issues: MossLoopPacketRefreshPlanGateReportIssue[] = [];
  const artifacts: MossLoopPacketRefreshPlanGateReportArtifactSummary[] = [];
  const names = existsSync(evidenceDirectory)
    ? readdirSync(evidenceDirectory).filter((name) => REPORT_ARTIFACT_PATTERN.test(name))
    : [];

  if (names.length === 0) {
    issues.push({
      code: "missing-artifacts",
      severity: "error",
      path: EVIDENCE_DIRECTORY,
      message: "No Moss loop packet refresh plan gate report JSON files were found.",
    });
  }

  for (const name of names.toSorted()) {
    const parsed = parseReportArtifact({
      repoRoot,
      absolutePath: join(evidenceDirectory, name),
    });
    if (parsed.artifact) {
      artifacts.push(parsed.artifact);
    }
    issues.push(...parsed.issues);
  }

  const sortedArtifacts = sortArtifacts(artifacts);
  const latest = sortedArtifacts[0] ?? null;
  const refreshPlanReportIndex =
    latest?.status === "pass"
      ? readMossReleaseFreshnessRefreshPlanReportIndex(repoRoot, { generatedAt })
      : null;
  issues.push(...buildRefreshPlanFreshnessIssues({ latest, refreshPlanReportIndex }));
  issues.push(...buildUnsafeWriteFlagIssues(latest));
  const status = issues.length === 0 && latest?.status === "pass" ? "pass" : "fail";

  return {
    version: 1,
    generatedAt,
    sourceDirectory: EVIDENCE_DIRECTORY,
    latest,
    artifacts: sortedArtifacts,
    issues,
    readiness: {
      status,
      summary:
        status === "pass"
          ? `Latest Moss loop packet refresh plan gate report is pass: ${
              latest?.path ?? "none"
            } (${latest?.checkSummary ?? "no summary"}).`
          : `Moss loop packet refresh plan gate report index has ${issues.length} issue(s).`,
    },
  };
}

export function mossLoopPacketRefreshPlanGateReportIndexExitCode(
  index: MossLoopPacketRefreshPlanGateReportIndex,
): number {
  return index.readiness.status === "pass" ? 0 : 1;
}
