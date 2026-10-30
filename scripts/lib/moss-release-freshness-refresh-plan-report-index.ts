import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER } from "./moss-release-freshness-refresh-plan-constants.ts";

export interface MossReleaseFreshnessRefreshPlanReportStepSummary {
  readonly id: string;
  readonly writesArtifacts: boolean;
  readonly artifactOutputs: ReadonlyArray<string>;
  readonly writesGlobalConfig: boolean;
}

export interface MossReleaseFreshnessRefreshPlanReportArtifactSummary {
  readonly path: string;
  readonly createdAt: string;
  readonly status: "pass" | "fail";
  readonly mode: string;
  readonly writesFiles: boolean;
  readonly writesGlobalConfig: boolean;
  readonly providerCredentialsRequired: boolean;
  readonly readinessStatus: string;
  readonly requiresReleaseArtifactRefresh: boolean;
  readonly requiresLoopFreshnessRefresh: boolean;
  readonly requiresLoopRefreshPlanReportRefresh?: boolean | undefined;
  readonly releaseGateReportArtifactOutput: string;
  readonly loopPacketFreshnessReportArtifactOutput: string;
  readonly releaseFreshnessRefreshPlanReportArtifactOutput?: string | undefined;
  readonly loopPacketRefreshPlanReportArtifactOutput?: string | undefined;
  readonly stepOrder: ReadonlyArray<string>;
  readonly steps: ReadonlyArray<MossReleaseFreshnessRefreshPlanReportStepSummary>;
}

export interface MossReleaseFreshnessRefreshPlanReportIssue {
  readonly code:
    | "missing-artifacts"
    | "malformed-artifact"
    | "invalid-artifact"
    | "stale-step-order"
    | "unsafe-write-flags"
    | "failing-artifact";
  readonly severity: "error";
  readonly path?: string | undefined;
  readonly message: string;
}

export interface MossReleaseFreshnessRefreshPlanReportIndex {
  readonly version: 1;
  readonly generatedAt: string;
  readonly sourceDirectory: string;
  readonly expectedStepOrder: ReadonlyArray<string>;
  readonly latest: MossReleaseFreshnessRefreshPlanReportArtifactSummary | null;
  readonly artifacts: ReadonlyArray<MossReleaseFreshnessRefreshPlanReportArtifactSummary>;
  readonly issues: ReadonlyArray<MossReleaseFreshnessRefreshPlanReportIssue>;
  readonly readiness: {
    readonly status: "pass" | "fail";
    readonly summary: string;
  };
}

export interface MossReleaseFreshnessRefreshPlanReportIndexOptions {
  readonly generatedAt?: string;
}

const EVIDENCE_DIRECTORY = ".moss/ledger/evidence";
const REPORT_ARTIFACT_PATTERN = /^moss-release-freshness-refresh-plan-report-.+\.json$/;
const EXPECTED_ARTIFACT_WRITER_STEP_IDS = new Set<string>([
  "release-report-artifact-refresh",
  "loop-packet-freshness-artifact-refresh",
  "release-freshness-refresh-plan-report-refresh",
  "loop-packet-refresh-plan-report-refresh",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function relativeArtifactPath(repoRoot: string, absolutePath: string): string {
  return relative(repoRoot, absolutePath).replaceAll("\\", "/");
}

function invalidArtifactIssue(
  path: string,
  message: string,
): MossReleaseFreshnessRefreshPlanReportIssue {
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

function parseArtifactOutputs(
  artifactPath: string,
  value: unknown,
): {
  readonly releaseGateReportArtifactOutput?: string | undefined;
  readonly loopPacketFreshnessReportArtifactOutput?: string | undefined;
  readonly releaseFreshnessRefreshPlanReportArtifactOutput?: string | undefined;
  readonly loopPacketRefreshPlanReportArtifactOutput?: string | undefined;
  readonly issue?: MossReleaseFreshnessRefreshPlanReportIssue | undefined;
} {
  if (
    !isObject(value) ||
    typeof value.releaseGateReport !== "string" ||
    value.releaseGateReport.length === 0 ||
    typeof value.loopPacketFreshnessReport !== "string" ||
    value.loopPacketFreshnessReport.length === 0
  ) {
    return {
      issue: invalidArtifactIssue(artifactPath, `${artifactPath} must have plan artifactOutputs.`),
    };
  }

  return {
    releaseGateReportArtifactOutput: value.releaseGateReport,
    loopPacketFreshnessReportArtifactOutput: value.loopPacketFreshnessReport,
    ...(typeof value.releaseFreshnessRefreshPlanReport === "string" &&
    value.releaseFreshnessRefreshPlanReport.length > 0
      ? { releaseFreshnessRefreshPlanReportArtifactOutput: value.releaseFreshnessRefreshPlanReport }
      : {}),
    ...(typeof value.loopPacketRefreshPlanReport === "string" &&
    value.loopPacketRefreshPlanReport.length > 0
      ? { loopPacketRefreshPlanReportArtifactOutput: value.loopPacketRefreshPlanReport }
      : {}),
  };
}

function parseState(
  artifactPath: string,
  value: unknown,
): {
  readonly requiresReleaseArtifactRefresh?: boolean | undefined;
  readonly requiresLoopFreshnessRefresh?: boolean | undefined;
  readonly requiresLoopRefreshPlanReportRefresh?: boolean | undefined;
  readonly issue?: MossReleaseFreshnessRefreshPlanReportIssue | undefined;
} {
  if (
    !isObject(value) ||
    typeof value.requiresReleaseArtifactRefresh !== "boolean" ||
    typeof value.requiresLoopFreshnessRefresh !== "boolean"
  ) {
    return {
      issue: invalidArtifactIssue(artifactPath, `${artifactPath} must have plan state flags.`),
    };
  }

  return {
    requiresReleaseArtifactRefresh: value.requiresReleaseArtifactRefresh,
    requiresLoopFreshnessRefresh: value.requiresLoopFreshnessRefresh,
    ...(typeof value.requiresLoopRefreshPlanReportRefresh === "boolean"
      ? { requiresLoopRefreshPlanReportRefresh: value.requiresLoopRefreshPlanReportRefresh }
      : {}),
  };
}

function parseSteps(
  artifactPath: string,
  value: unknown,
): {
  readonly steps?: ReadonlyArray<MossReleaseFreshnessRefreshPlanReportStepSummary> | undefined;
  readonly issue?: MossReleaseFreshnessRefreshPlanReportIssue | undefined;
} {
  if (!Array.isArray(value)) {
    return {
      issue: invalidArtifactIssue(artifactPath, `${artifactPath} must have plan steps array.`),
    };
  }

  const steps: MossReleaseFreshnessRefreshPlanReportStepSummary[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const step = value[index];
    const artifactOutputs = isObject(step) ? asStringArray(step.artifactOutputs) : null;
    if (
      !isObject(step) ||
      typeof step.id !== "string" ||
      typeof step.writesArtifacts !== "boolean" ||
      typeof step.writesGlobalConfig !== "boolean" ||
      !artifactOutputs
    ) {
      return {
        issue: invalidArtifactIssue(
          artifactPath,
          `${artifactPath} plan.steps[${index}] has an invalid compact shape.`,
        ),
      };
    }
    steps.push({
      id: step.id,
      writesArtifacts: step.writesArtifacts,
      artifactOutputs,
      writesGlobalConfig: step.writesGlobalConfig,
    });
  }

  return { steps };
}

function parseReportArtifact(input: { readonly repoRoot: string; readonly absolutePath: string }): {
  readonly artifact?: MossReleaseFreshnessRefreshPlanReportArtifactSummary | undefined;
  readonly issues: ReadonlyArray<MossReleaseFreshnessRefreshPlanReportIssue>;
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
  if (typeof parsed.providerCredentialsRequired !== "boolean") {
    return {
      issues: [
        invalidArtifactIssue(
          artifactPath,
          `${artifactPath} must have providerCredentialsRequired flag.`,
        ),
      ],
    };
  }
  if (typeof parsed.writesGlobalConfig !== "boolean") {
    return {
      issues: [
        invalidArtifactIssue(artifactPath, `${artifactPath} must have writesGlobalConfig flag.`),
      ],
    };
  }
  if (!isObject(parsed.plan)) {
    return {
      issues: [invalidArtifactIssue(artifactPath, `${artifactPath} must have plan object.`)],
    };
  }

  const plan = parsed.plan;
  const stepOrder = asStringArray(plan.stepOrder);
  if (!stepOrder) {
    return {
      issues: [invalidArtifactIssue(artifactPath, `${artifactPath} must have plan.stepOrder.`)],
    };
  }
  if (
    typeof plan.mode !== "string" ||
    typeof plan.writesFiles !== "boolean" ||
    typeof plan.writesGlobalConfig !== "boolean"
  ) {
    return {
      issues: [invalidArtifactIssue(artifactPath, `${artifactPath} has invalid plan write flags.`)],
    };
  }
  if (!isObject(plan.readiness) || typeof plan.readiness.status !== "string") {
    return {
      issues: [invalidArtifactIssue(artifactPath, `${artifactPath} must have plan readiness.`)],
    };
  }

  const artifactOutputs = parseArtifactOutputs(artifactPath, plan.artifactOutputs);
  if (artifactOutputs.issue) {
    return { issues: [artifactOutputs.issue] };
  }
  const state = parseState(artifactPath, plan.state);
  if (state.issue) {
    return { issues: [state.issue] };
  }
  const steps = parseSteps(artifactPath, plan.steps);
  if (steps.issue || !steps.steps) {
    return {
      issues: [
        steps.issue ??
          invalidArtifactIssue(artifactPath, `${artifactPath} plan.steps are invalid.`),
      ],
    };
  }

  const artifact = {
    path: artifactPath,
    createdAt: parsed.createdAt,
    status: parsed.status,
    mode: plan.mode,
    writesFiles: plan.writesFiles,
    writesGlobalConfig: plan.writesGlobalConfig,
    providerCredentialsRequired: parsed.providerCredentialsRequired,
    readinessStatus: plan.readiness.status,
    requiresReleaseArtifactRefresh: state.requiresReleaseArtifactRefresh ?? false,
    requiresLoopFreshnessRefresh: state.requiresLoopFreshnessRefresh ?? false,
    ...(typeof state.requiresLoopRefreshPlanReportRefresh === "boolean"
      ? { requiresLoopRefreshPlanReportRefresh: state.requiresLoopRefreshPlanReportRefresh }
      : {}),
    releaseGateReportArtifactOutput: artifactOutputs.releaseGateReportArtifactOutput ?? "",
    loopPacketFreshnessReportArtifactOutput:
      artifactOutputs.loopPacketFreshnessReportArtifactOutput ?? "",
    ...(artifactOutputs.releaseFreshnessRefreshPlanReportArtifactOutput
      ? {
          releaseFreshnessRefreshPlanReportArtifactOutput:
            artifactOutputs.releaseFreshnessRefreshPlanReportArtifactOutput,
        }
      : {}),
    ...(artifactOutputs.loopPacketRefreshPlanReportArtifactOutput
      ? {
          loopPacketRefreshPlanReportArtifactOutput:
            artifactOutputs.loopPacketRefreshPlanReportArtifactOutput,
        }
      : {}),
    stepOrder,
    steps: steps.steps,
  } satisfies MossReleaseFreshnessRefreshPlanReportArtifactSummary;
  const issues =
    artifact.status === "fail"
      ? [
          {
            code: "failing-artifact",
            severity: "error",
            path: artifact.path,
            message: `${artifact.path} reports failed release freshness refresh plan status.`,
          } as const satisfies MossReleaseFreshnessRefreshPlanReportIssue,
        ]
      : [];

  return { artifact, issues };
}

function sortArtifacts(
  artifacts: ReadonlyArray<MossReleaseFreshnessRefreshPlanReportArtifactSummary>,
): ReadonlyArray<MossReleaseFreshnessRefreshPlanReportArtifactSummary> {
  return artifacts.toSorted(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) || right.path.localeCompare(left.path),
  );
}

function arraysEqual(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function buildLatestArtifactIssues(
  latest: MossReleaseFreshnessRefreshPlanReportArtifactSummary | null,
): ReadonlyArray<MossReleaseFreshnessRefreshPlanReportIssue> {
  if (!latest || latest.status !== "pass") {
    return [];
  }

  const issues: MossReleaseFreshnessRefreshPlanReportIssue[] = [];
  const expectedStepOrder = [...MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER];
  const stepOrderMatches = arraysEqual(latest.stepOrder, expectedStepOrder);
  if (!stepOrderMatches) {
    issues.push({
      code: "stale-step-order",
      severity: "error",
      path: latest.path,
      message: `${latest.path} has stale release freshness refresh step order: expected [${expectedStepOrder.join(
        ", ",
      )}], found [${latest.stepOrder.join(", ")}].`,
    });
  }

  const unsafeMessages: string[] = [];
  if (latest.mode !== "dry-run") {
    unsafeMessages.push(`mode is ${latest.mode}`);
  }
  if (latest.writesFiles !== false) {
    unsafeMessages.push("plan writesFiles is not false");
  }
  if (latest.writesGlobalConfig !== false) {
    unsafeMessages.push("plan writesGlobalConfig is not false");
  }
  if (latest.providerCredentialsRequired !== false) {
    unsafeMessages.push("providerCredentialsRequired is not false");
  }
  if (stepOrderMatches && !latest.releaseFreshnessRefreshPlanReportArtifactOutput) {
    unsafeMessages.push("releaseFreshnessRefreshPlanReport artifact output is missing");
  }
  if (stepOrderMatches && !latest.loopPacketRefreshPlanReportArtifactOutput) {
    unsafeMessages.push("loopPacketRefreshPlanReport artifact output is missing");
  }
  for (const step of latest.steps) {
    if (step.writesGlobalConfig !== false) {
      unsafeMessages.push(`${step.id} writesGlobalConfig is not false`);
    }
    const shouldWriteArtifact = EXPECTED_ARTIFACT_WRITER_STEP_IDS.has(step.id);
    if (step.writesArtifacts !== shouldWriteArtifact) {
      unsafeMessages.push(`${step.id} writesArtifacts is ${step.writesArtifacts}`);
    }
    if (shouldWriteArtifact && step.artifactOutputs.length === 0) {
      unsafeMessages.push(`${step.id} has no artifactOutputs`);
    }
  }

  if (unsafeMessages.length > 0) {
    issues.push({
      code: "unsafe-write-flags",
      severity: "error",
      path: latest.path,
      message: `${latest.path} has unsafe release freshness refresh plan write flags: ${unsafeMessages.join(
        "; ",
      )}.`,
    });
  }

  return issues;
}

export function readMossReleaseFreshnessRefreshPlanReportIndex(
  repoRoot = process.cwd(),
  options: MossReleaseFreshnessRefreshPlanReportIndexOptions = {},
): MossReleaseFreshnessRefreshPlanReportIndex {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const evidenceDirectory = join(repoRoot, EVIDENCE_DIRECTORY);
  const issues: MossReleaseFreshnessRefreshPlanReportIssue[] = [];
  const artifacts: MossReleaseFreshnessRefreshPlanReportArtifactSummary[] = [];
  const names = existsSync(evidenceDirectory)
    ? readdirSync(evidenceDirectory).filter((name) => REPORT_ARTIFACT_PATTERN.test(name))
    : [];

  if (names.length === 0) {
    issues.push({
      code: "missing-artifacts",
      severity: "error",
      path: EVIDENCE_DIRECTORY,
      message: "No Moss release freshness refresh plan report JSON files were found.",
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
  issues.push(...buildLatestArtifactIssues(latest));
  const status = issues.length === 0 && latest?.status === "pass" ? "pass" : "fail";

  return {
    version: 1,
    generatedAt,
    sourceDirectory: EVIDENCE_DIRECTORY,
    expectedStepOrder: [...MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER],
    latest,
    artifacts: sortedArtifacts,
    issues,
    readiness: {
      status,
      summary:
        status === "pass"
          ? `Latest Moss release freshness refresh plan report is pass: ${latest?.path ?? "none"}.`
          : `Moss release freshness refresh plan report index has ${issues.length} issue(s).`,
    },
  };
}

export function mossReleaseFreshnessRefreshPlanReportIndexExitCode(
  index: MossReleaseFreshnessRefreshPlanReportIndex,
): number {
  return index.readiness.status === "pass" ? 0 : 1;
}
