import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import {
  readMossReleaseGateReportArtifactIndex,
  type MossReleaseGateReportArtifactIndex,
} from "./moss-release-gate-report-index.ts";
import {
  isMossExplicitChainedProvenanceBootstrapMessage,
  parseMossChainedRefreshProvenance,
  type MossChainedRefreshProvenance,
} from "./moss-chained-refresh-provenance.ts";

export interface MossLoopPacketFreshnessGateReportArtifactSummary {
  readonly path: string;
  readonly createdAt: string;
  readonly status: "pass" | "fail";
  readonly taskId: string;
  readonly taskTitle: string;
  readonly chainedRefreshProvenance?: MossChainedRefreshProvenance | undefined;
  readonly checkStatus: "pass" | "pending" | "fail";
  readonly checkSummary: string;
  readonly loopPacketReadinessStatus: "ready" | "pending" | "blocked";
  readonly releaseFreshness: {
    readonly status: "pass" | "pending" | "blocked";
    readonly readinessStatus: "pass" | "fail";
    readonly summary: string;
    readonly manifestGateCount: number;
    readonly latestArtifactGateCount?: number | undefined;
    readonly releaseGateArtifactPath?: string | undefined;
    readonly issueCount: number;
    readonly issueCodes: ReadonlyArray<string>;
  };
}

export interface MossLoopPacketFreshnessGateReportIssue {
  readonly code:
    | "missing-artifacts"
    | "malformed-artifact"
    | "invalid-artifact"
    | "stale-release-freshness"
    | "failing-artifact";
  readonly severity: "error";
  readonly path?: string | undefined;
  readonly message: string;
}

export interface MossLoopPacketFreshnessGateReportIndex {
  readonly version: 1;
  readonly generatedAt: string;
  readonly sourceDirectory: string;
  readonly latest: MossLoopPacketFreshnessGateReportArtifactSummary | null;
  readonly artifacts: ReadonlyArray<MossLoopPacketFreshnessGateReportArtifactSummary>;
  readonly issues: ReadonlyArray<MossLoopPacketFreshnessGateReportIssue>;
  readonly readiness: {
    readonly status: "pass" | "fail";
    readonly summary: string;
  };
}

export interface MossLoopPacketFreshnessGateReportIndexOptions {
  readonly generatedAt?: string;
}

const EVIDENCE_DIRECTORY = ".moss/ledger/evidence";
const REPORT_ARTIFACT_PATTERN = /^moss-loop-packet-freshness-gate-report-.+\.json$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function relativeArtifactPath(repoRoot: string, absolutePath: string): string {
  return relative(repoRoot, absolutePath).replaceAll("\\", "/");
}

function invalidArtifactIssue(
  path: string,
  message: string,
): MossLoopPacketFreshnessGateReportIssue {
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

function parseReleaseFreshness(
  artifactPath: string,
  value: unknown,
): {
  readonly releaseFreshness?:
    | MossLoopPacketFreshnessGateReportArtifactSummary["releaseFreshness"]
    | undefined;
  readonly issue?: MossLoopPacketFreshnessGateReportIssue | undefined;
} {
  if (!isObject(value)) {
    return {
      issue: invalidArtifactIssue(
        artifactPath,
        `${artifactPath} releaseFreshness must be an object.`,
      ),
    };
  }

  const issueCodes = asStringArray(value.issueCodes);
  if (
    (value.status !== "pass" && value.status !== "pending" && value.status !== "blocked") ||
    (value.readinessStatus !== "pass" && value.readinessStatus !== "fail") ||
    typeof value.summary !== "string" ||
    typeof value.manifestGateCount !== "number" ||
    typeof value.issueCount !== "number" ||
    !issueCodes
  ) {
    return {
      issue: invalidArtifactIssue(
        artifactPath,
        `${artifactPath} releaseFreshness has an invalid compact shape.`,
      ),
    };
  }

  return {
    releaseFreshness: {
      status: value.status,
      readinessStatus: value.readinessStatus,
      summary: value.summary,
      manifestGateCount: value.manifestGateCount,
      ...(typeof value.latestArtifactGateCount === "number"
        ? { latestArtifactGateCount: value.latestArtifactGateCount }
        : {}),
      ...(typeof value.artifactPath === "string"
        ? { releaseGateArtifactPath: value.artifactPath }
        : {}),
      issueCount: value.issueCount,
      issueCodes,
    },
  };
}

function parseReportArtifact(input: { readonly repoRoot: string; readonly absolutePath: string }): {
  readonly artifact?: MossLoopPacketFreshnessGateReportArtifactSummary | undefined;
  readonly issues: ReadonlyArray<MossLoopPacketFreshnessGateReportIssue>;
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
    parsed.check.id !== "loop-ledger-release-freshness" ||
    (parsed.check.status !== "pass" &&
      parsed.check.status !== "pending" &&
      parsed.check.status !== "fail") ||
    typeof parsed.check.summary !== "string"
  ) {
    return {
      issues: [invalidArtifactIssue(artifactPath, `${artifactPath} must have freshness check.`)],
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

  const parsedFreshness = parseReleaseFreshness(artifactPath, parsed.releaseFreshness);
  if (parsedFreshness.issue || !parsedFreshness.releaseFreshness) {
    return {
      issues: [
        parsedFreshness.issue ??
          invalidArtifactIssue(artifactPath, `${artifactPath} releaseFreshness is invalid.`),
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
    releaseFreshness: parsedFreshness.releaseFreshness,
  } satisfies MossLoopPacketFreshnessGateReportArtifactSummary;
  const issues =
    artifact.status === "fail"
      ? [
          {
            code: "failing-artifact",
            severity: "error",
            path: artifact.path,
            message: `${artifact.path} reports failed loop packet freshness gate status.`,
          } as const satisfies MossLoopPacketFreshnessGateReportIssue,
        ]
      : [];

  return { artifact, issues };
}

function sortArtifacts(
  artifacts: ReadonlyArray<MossLoopPacketFreshnessGateReportArtifactSummary>,
): ReadonlyArray<MossLoopPacketFreshnessGateReportArtifactSummary> {
  return artifacts.toSorted(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) || right.path.localeCompare(left.path),
  );
}

function buildReleaseFreshnessIssues(input: {
  readonly latest: MossLoopPacketFreshnessGateReportArtifactSummary | null;
  readonly releaseGateArtifactIndex: MossReleaseGateReportArtifactIndex | null;
}): ReadonlyArray<MossLoopPacketFreshnessGateReportIssue> {
  const { latest, releaseGateArtifactIndex } = input;
  if (!latest || latest.status !== "pass") {
    return [];
  }

  const latestReleaseGateArtifact = releaseGateArtifactIndex?.latest ?? null;
  if (!releaseGateArtifactIndex || !latestReleaseGateArtifact) {
    return [
      {
        code: "stale-release-freshness",
        severity: "error",
        path: latest.path,
        message: `${latest.path} cannot prove release freshness because no current Moss release gate artifact is indexed.`,
      },
    ];
  }

  const freshness = latest.releaseFreshness;
  const issueCodes = releaseGateArtifactIndex.issues.map((issue) => issue.code);
  const canBootstrapExplicitChainedProvenance =
    Boolean(latest.chainedRefreshProvenance) &&
    releaseGateArtifactIndex.issues.length > 0 &&
    releaseGateArtifactIndex.issues.every(
      (issue) =>
        issue.code === "stale-artifact" &&
        isMossExplicitChainedProvenanceBootstrapMessage(issue.message),
    );
  const mismatches: string[] = [];
  if (
    releaseGateArtifactIndex.readiness.status !== "pass" &&
    !canBootstrapExplicitChainedProvenance
  ) {
    mismatches.push(
      `release artifact index readiness is ${releaseGateArtifactIndex.readiness.status} with issue(s) [${issueCodes.join(
        ", ",
      )}]`,
    );
  }
  if (freshness.readinessStatus !== "pass" || freshness.issueCount !== 0) {
    mismatches.push(
      `embedded release freshness readiness is ${freshness.readinessStatus} with ${freshness.issueCount} issue(s)`,
    );
  }
  if (freshness.releaseGateArtifactPath !== latestReleaseGateArtifact.path) {
    mismatches.push(
      `embedded release artifact path ${freshness.releaseGateArtifactPath ?? "none"} does not match latest ${latestReleaseGateArtifact.path}`,
    );
  }
  if (freshness.manifestGateCount !== releaseGateArtifactIndex.manifest.gateCount) {
    mismatches.push(
      `embedded manifest gate count ${freshness.manifestGateCount} does not match current manifest ${releaseGateArtifactIndex.manifest.gateCount}`,
    );
  }
  if (freshness.latestArtifactGateCount !== latestReleaseGateArtifact.gateCount) {
    mismatches.push(
      `embedded latest artifact gate count ${freshness.latestArtifactGateCount ?? "none"} does not match latest ${latestReleaseGateArtifact.gateCount}`,
    );
  }

  if (mismatches.length === 0) {
    return [];
  }

  return [
    {
      code: "stale-release-freshness",
      severity: "error",
      path: latest.path,
      message: `${latest.path} is stale against the current Moss release gate artifact: ${mismatches.join(
        "; ",
      )}.`,
    },
  ];
}

export function readMossLoopPacketFreshnessGateReportIndex(
  repoRoot = process.cwd(),
  options: MossLoopPacketFreshnessGateReportIndexOptions = {},
): MossLoopPacketFreshnessGateReportIndex {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const evidenceDirectory = join(repoRoot, EVIDENCE_DIRECTORY);
  const issues: MossLoopPacketFreshnessGateReportIssue[] = [];
  const artifacts: MossLoopPacketFreshnessGateReportArtifactSummary[] = [];
  const names = existsSync(evidenceDirectory)
    ? readdirSync(evidenceDirectory).filter((name) => REPORT_ARTIFACT_PATTERN.test(name))
    : [];

  if (names.length === 0) {
    issues.push({
      code: "missing-artifacts",
      severity: "error",
      path: EVIDENCE_DIRECTORY,
      message: "No Moss loop packet freshness gate report JSON files were found.",
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
  const releaseGateArtifactIndex =
    latest?.status === "pass"
      ? readMossReleaseGateReportArtifactIndex(repoRoot, { generatedAt })
      : null;
  issues.push(...buildReleaseFreshnessIssues({ latest, releaseGateArtifactIndex }));
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
          ? `Latest Moss loop packet freshness gate report is pass: ${
              latest?.path ?? "none"
            } (${latest?.checkSummary ?? "no summary"}).`
          : `Moss loop packet freshness gate report index has ${issues.length} issue(s).`,
    },
  };
}

export function mossLoopPacketFreshnessGateReportIndexExitCode(
  index: MossLoopPacketFreshnessGateReportIndex,
): number {
  return index.readiness.status === "pass" ? 0 : 1;
}
