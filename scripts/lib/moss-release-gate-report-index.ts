import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import {
  buildMossReleaseGateManifest,
  type MossReleaseGateReportIndexObservedEvidence,
} from "./moss-release-gate-manifest.ts";
import {
  mossTaskIdIsOlder,
  parseMossChainedRefreshProvenance,
  parseMossTaskNumber,
  readExpectedMossChainedRefreshProvenance,
  type MossChainedRefreshProvenance,
} from "./moss-chained-refresh-provenance.ts";

export interface MossReleaseGateReportArtifactSummary {
  readonly path: string;
  readonly createdAt: string;
  readonly status: "pass" | "fail";
  readonly gateCount: number;
  readonly gateIds: ReadonlyArray<string>;
  readonly failedGateId?: string | undefined;
  readonly freshnessEvidence?: MossReleaseGateReportIndexObservedEvidence | undefined;
  readonly chainedObservedEvidence?:
    | MossReleaseGateReportArtifactChainedObservedEvidence
    | undefined;
}

export interface MossReleaseGateReportArtifactObservedEvidenceSummary {
  readonly gateId: string;
  readonly label: string;
  readonly readinessStatus?: "pass" | "fail" | undefined;
  readonly latestArtifactCreatedAt?: string | undefined;
  readonly latestTaskId?: string | undefined;
  readonly issueCodes: ReadonlyArray<string>;
  readonly chainedRefreshTaskId?: string | undefined;
  readonly chainedRefreshProvenance?: MossChainedRefreshProvenance | undefined;
}

export interface MossReleaseGateReportArtifactChainedObservedEvidence {
  readonly releaseFreshnessRefreshPlanReport?:
    | MossReleaseGateReportArtifactObservedEvidenceSummary
    | undefined;
  readonly loopPacketFreshnessReport?:
    | MossReleaseGateReportArtifactObservedEvidenceSummary
    | undefined;
  readonly loopPacketRefreshPlanReport?:
    | MossReleaseGateReportArtifactObservedEvidenceSummary
    | undefined;
}

type MutableChainedObservedEvidence = {
  releaseFreshnessRefreshPlanReport?: MossReleaseGateReportArtifactObservedEvidenceSummary;
  loopPacketFreshnessReport?: MossReleaseGateReportArtifactObservedEvidenceSummary;
  loopPacketRefreshPlanReport?: MossReleaseGateReportArtifactObservedEvidenceSummary;
};

export interface MossReleaseGateReportArtifactIssue {
  readonly code:
    | "missing-artifacts"
    | "malformed-artifact"
    | "invalid-artifact"
    | "stale-artifact"
    | "failing-artifact";
  readonly severity: "error";
  readonly path?: string | undefined;
  readonly message: string;
}

export interface MossReleaseGateReportArtifactIndex {
  readonly version: 1;
  readonly generatedAt: string;
  readonly sourceDirectory: string;
  readonly manifest: {
    readonly gateCount: number;
    readonly gateIds: ReadonlyArray<string>;
  };
  readonly expectedChainedRefreshProvenance?: MossChainedRefreshProvenance | undefined;
  readonly latest: MossReleaseGateReportArtifactSummary | null;
  readonly artifacts: ReadonlyArray<MossReleaseGateReportArtifactSummary>;
  readonly issues: ReadonlyArray<MossReleaseGateReportArtifactIssue>;
  readonly readiness: {
    readonly status: "pass" | "fail";
    readonly summary: string;
  };
}

export interface MossReleaseGateReportIndexOptions {
  readonly generatedAt?: string;
  readonly expectedGateIds?: ReadonlyArray<string>;
}

const REPORT_ARTIFACT_PATTERN = /^moss-release-gate-report-artifact-.+\.json$/;
const EVIDENCE_DIRECTORY = ".moss/ledger/evidence";

const CHAINED_OBSERVED_EVIDENCE_PROBES = [
  {
    gateId: "release-freshness-refresh-plan-report-index",
    evidenceKey: "releaseFreshnessRefreshPlanReportIndex",
    summaryKey: "releaseFreshnessRefreshPlanReport",
    label: "release freshness refresh-plan report",
    requiresTaskId: false,
  },
  {
    gateId: "loop-packet-freshness-report-index",
    evidenceKey: "loopPacketFreshnessReportIndex",
    summaryKey: "loopPacketFreshnessReport",
    label: "loop packet freshness report",
    requiresTaskId: true,
  },
  {
    gateId: "loop-packet-refresh-plan-report-index",
    evidenceKey: "loopPacketRefreshPlanReportIndex",
    summaryKey: "loopPacketRefreshPlanReport",
    label: "loop packet refresh-plan report",
    requiresTaskId: true,
  },
] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function relativeArtifactPath(repoRoot: string, absolutePath: string): string {
  return relative(repoRoot, absolutePath).replaceAll("\\", "/");
}

function invalidArtifactIssue(path: string, message: string): MossReleaseGateReportArtifactIssue {
  return {
    code: "invalid-artifact",
    severity: "error",
    path,
    message,
  };
}

function parseGateIds(
  artifactPath: string,
  gates: ReadonlyArray<unknown>,
): {
  readonly gateIds?: ReadonlyArray<string> | undefined;
  readonly issue?: MossReleaseGateReportArtifactIssue | undefined;
} {
  const gateIds: string[] = [];

  for (let index = 0; index < gates.length; index += 1) {
    const gate = gates[index];
    if (!isObject(gate) || typeof gate.id !== "string" || gate.id.length === 0) {
      return {
        issue: invalidArtifactIssue(
          artifactPath,
          `${artifactPath} gates[${index}] must have a non-empty string id.`,
        ),
      };
    }
    gateIds.push(gate.id);
  }

  return { gateIds };
}

function asStringArray(value: unknown): ReadonlyArray<string> | null {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    return null;
  }
  return value;
}

function parseFreshnessEvidence(
  value: unknown,
): MossReleaseGateReportIndexObservedEvidence | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  const manifestGateIds = asStringArray(value.manifestGateIds);
  const latestArtifactGateIds = asStringArray(value.latestArtifactGateIds);
  const issueCodes = asStringArray(value.issueCodes);
  const staleArtifactMessages = asStringArray(value.staleArtifactMessages);
  if (
    (value.readinessStatus !== "pass" && value.readinessStatus !== "fail") ||
    typeof value.manifestGateCount !== "number" ||
    !manifestGateIds ||
    !issueCodes ||
    !staleArtifactMessages
  ) {
    return undefined;
  }

  return {
    readinessStatus: value.readinessStatus,
    manifestGateCount: value.manifestGateCount,
    manifestGateIds,
    ...(typeof value.latestArtifactPath === "string"
      ? { latestArtifactPath: value.latestArtifactPath }
      : {}),
    ...(typeof value.latestArtifactCreatedAt === "string"
      ? { latestArtifactCreatedAt: value.latestArtifactCreatedAt }
      : {}),
    ...(value.latestArtifactStatus === "pass" || value.latestArtifactStatus === "fail"
      ? { latestArtifactStatus: value.latestArtifactStatus }
      : {}),
    ...(typeof value.latestArtifactGateCount === "number"
      ? { latestArtifactGateCount: value.latestArtifactGateCount }
      : {}),
    ...(latestArtifactGateIds ? { latestArtifactGateIds: latestArtifactGateIds } : {}),
    issueCodes,
    staleArtifactMessages,
  };
}

function parseChainedObservedEvidence(
  gates: ReadonlyArray<unknown>,
): MossReleaseGateReportArtifactChainedObservedEvidence | undefined {
  const summaries: MutableChainedObservedEvidence = {};

  for (const probe of CHAINED_OBSERVED_EVIDENCE_PROBES) {
    const gate = gates.find((entry) => isObject(entry) && entry.id === probe.gateId);
    if (!isObject(gate) || !isObject(gate.observedEvidence)) {
      continue;
    }
    const observed = gate.observedEvidence[probe.evidenceKey];
    if (!isObject(observed)) {
      continue;
    }
    const issueCodes = asStringArray(observed.issueCodes) ?? [];
    const chainedRefreshProvenance = parseMossChainedRefreshProvenance({
      value: observed,
      fallbackTaskId:
        typeof observed.latestChainedRefreshTaskId === "string"
          ? observed.latestChainedRefreshTaskId
          : typeof observed.latestTaskId === "string"
            ? observed.latestTaskId
            : undefined,
      fallbackSource: "loop-packet-task-metadata",
    });
    summaries[probe.summaryKey] = {
      gateId: probe.gateId,
      label: probe.label,
      ...(observed.readinessStatus === "pass" || observed.readinessStatus === "fail"
        ? { readinessStatus: observed.readinessStatus }
        : {}),
      ...(typeof observed.latestArtifactCreatedAt === "string"
        ? { latestArtifactCreatedAt: observed.latestArtifactCreatedAt }
        : {}),
      ...(typeof observed.latestTaskId === "string" ? { latestTaskId: observed.latestTaskId } : {}),
      ...(chainedRefreshProvenance
        ? {
            chainedRefreshTaskId: chainedRefreshProvenance.taskId,
            chainedRefreshProvenance,
          }
        : {}),
      issueCodes,
    };
  }

  return Object.keys(summaries).length > 0
    ? (summaries as MossReleaseGateReportArtifactChainedObservedEvidence)
    : undefined;
}

function parseReportArtifactFreshnessEvidence(
  gates: ReadonlyArray<unknown>,
): MossReleaseGateReportIndexObservedEvidence | undefined {
  const reportIndexGate = gates.find(
    (gate) => isObject(gate) && gate.id === "release-gate-report-index",
  );
  if (!isObject(reportIndexGate) || !isObject(reportIndexGate.observedEvidence)) {
    return undefined;
  }

  return parseFreshnessEvidence(reportIndexGate.observedEvidence.releaseGateReportIndex);
}

function parseReportArtifact(input: { readonly repoRoot: string; readonly absolutePath: string }): {
  readonly artifact?: MossReleaseGateReportArtifactSummary | undefined;
  readonly issues: ReadonlyArray<MossReleaseGateReportArtifactIssue>;
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
  if (!Array.isArray(parsed.gates)) {
    return {
      issues: [invalidArtifactIssue(artifactPath, `${artifactPath} must have gates array.`)],
    };
  }
  if (
    "failedGateId" in parsed &&
    parsed.failedGateId !== undefined &&
    typeof parsed.failedGateId !== "string"
  ) {
    return {
      issues: [
        invalidArtifactIssue(artifactPath, `${artifactPath} failedGateId must be a string.`),
      ],
    };
  }

  const parsedGateIds = parseGateIds(artifactPath, parsed.gates);
  if (parsedGateIds.issue || !parsedGateIds.gateIds) {
    return {
      issues: [
        parsedGateIds.issue ??
          invalidArtifactIssue(artifactPath, `${artifactPath} gates are invalid.`),
      ],
    };
  }
  const freshnessEvidence = parseReportArtifactFreshnessEvidence(parsed.gates);
  const chainedObservedEvidence = parseChainedObservedEvidence(parsed.gates);

  const artifact = {
    path: artifactPath,
    createdAt: parsed.createdAt,
    status: parsed.status,
    gateCount: parsed.gates.length,
    gateIds: parsedGateIds.gateIds,
    ...(typeof parsed.failedGateId === "string" ? { failedGateId: parsed.failedGateId } : {}),
    ...(freshnessEvidence ? { freshnessEvidence } : {}),
    ...(chainedObservedEvidence ? { chainedObservedEvidence } : {}),
  } satisfies MossReleaseGateReportArtifactSummary;
  const issues =
    artifact.status === "fail"
      ? [
          {
            code: "failing-artifact",
            severity: "error",
            path: artifact.path,
            message: `${artifact.path} reports failed release gate status.`,
          } as const satisfies MossReleaseGateReportArtifactIssue,
        ]
      : [];

  return { artifact, issues };
}

function buildManifestGateIds(input: {
  readonly generatedAt: string;
  readonly expectedGateIds?: ReadonlyArray<string> | undefined;
}): ReadonlyArray<string> {
  if (input.expectedGateIds) {
    return [...input.expectedGateIds];
  }

  return buildMossReleaseGateManifest({ createdAt: input.generatedAt }).gates.map(
    (gate) => gate.id,
  );
}

function diffGateIds(input: {
  readonly expectedGateIds: ReadonlyArray<string>;
  readonly actualGateIds: ReadonlyArray<string>;
}): {
  readonly missingGateIds: ReadonlyArray<string>;
  readonly unexpectedGateIds: ReadonlyArray<string>;
} {
  const actualGateIdSet = new Set(input.actualGateIds);
  const expectedGateIdSet = new Set(input.expectedGateIds);

  return {
    missingGateIds: input.expectedGateIds.filter((gateId) => !actualGateIdSet.has(gateId)),
    unexpectedGateIds: input.actualGateIds.filter((gateId) => !expectedGateIdSet.has(gateId)),
  };
}

function buildFreshnessIssues(input: {
  readonly latest: MossReleaseGateReportArtifactSummary | null;
  readonly expectedGateIds: ReadonlyArray<string>;
  readonly expectedChainedRefreshTaskId?: string | undefined;
}): ReadonlyArray<MossReleaseGateReportArtifactIssue> {
  if (!input.latest) {
    return [];
  }

  const { missingGateIds, unexpectedGateIds } = diffGateIds({
    expectedGateIds: input.expectedGateIds,
    actualGateIds: input.latest.gateIds,
  });
  const stale =
    input.latest.gateCount !== input.expectedGateIds.length ||
    missingGateIds.length > 0 ||
    unexpectedGateIds.length > 0;

  if (!stale) {
    return buildChainedObservedEvidenceFreshnessIssues({
      latest: input.latest,
      expectedChainedRefreshTaskId: input.expectedChainedRefreshTaskId,
    });
  }

  return [
    {
      code: "stale-artifact",
      severity: "error",
      path: input.latest.path,
      message: `${input.latest.path} is stale against current release gate manifest: expected ${
        input.expectedGateIds.length
      } gate(s) [${input.expectedGateIds.join(", ")}], found ${
        input.latest.gateCount
      } gate(s), missing [${missingGateIds.join(", ")}], unexpected [${unexpectedGateIds.join(", ")}].`,
    },
  ];
}

function buildChainedObservedEvidenceFreshnessIssues(input: {
  readonly latest: MossReleaseGateReportArtifactSummary;
  readonly expectedChainedRefreshTaskId?: string | undefined;
}): ReadonlyArray<MossReleaseGateReportArtifactIssue> {
  const issues: MossReleaseGateReportArtifactIssue[] = [];
  const expectedTaskId = input.expectedChainedRefreshTaskId;
  const expectedTaskNumber = parseMossTaskNumber(expectedTaskId);
  const taskEvidence: MossReleaseGateReportArtifactObservedEvidenceSummary[] = [];
  const consistencyEvidence: MossReleaseGateReportArtifactObservedEvidenceSummary[] = [];
  const chainedEvidence = input.latest.chainedObservedEvidence;

  for (const probe of CHAINED_OBSERVED_EVIDENCE_PROBES) {
    if (!input.latest.gateIds.includes(probe.gateId)) {
      continue;
    }

    const evidence = chainedEvidence?.[probe.summaryKey];
    if (!evidence) {
      issues.push({
        code: "stale-artifact",
        severity: "error",
        path: input.latest.path,
        message: `${input.latest.path} cannot prove chained freshness: ${probe.gateId} is missing observedEvidence.${probe.evidenceKey}.`,
      });
      continue;
    }

    if (evidence.readinessStatus !== "pass") {
      issues.push({
        code: "stale-artifact",
        severity: "error",
        path: input.latest.path,
        message: `${input.latest.path} has stale chained observed evidence for ${probe.label}: readinessStatus=${evidence.readinessStatus ?? "missing"}.`,
      });
    }

    if (!evidence.latestArtifactCreatedAt) {
      issues.push({
        code: "stale-artifact",
        severity: "error",
        path: input.latest.path,
        message: `${input.latest.path} cannot prove chained freshness: ${probe.label} is missing latestArtifactCreatedAt.`,
      });
    } else if (evidence.latestArtifactCreatedAt < input.latest.createdAt) {
      issues.push({
        code: "stale-artifact",
        severity: "error",
        path: input.latest.path,
        message: `${input.latest.path} has stale chained observed evidence for ${probe.label}: latestArtifactCreatedAt ${evidence.latestArtifactCreatedAt} predates release artifact createdAt ${input.latest.createdAt}.`,
      });
    }

    if (probe.requiresTaskId) {
      taskEvidence.push(evidence);
    }
  }

  const observedTaskNumbers = taskEvidence
    .map((evidence) => parseMossTaskNumber(evidence.latestTaskId))
    .filter((taskNumber): taskNumber is number => taskNumber !== null);
  const maxObservedTaskNumber =
    observedTaskNumbers.length > 0 ? Math.max(...observedTaskNumbers) : null;

  for (const evidence of taskEvidence) {
    if (!evidence.latestTaskId) {
      issues.push({
        code: "stale-artifact",
        severity: "error",
        path: input.latest.path,
        message: `${input.latest.path} cannot prove chained freshness: ${evidence.label} is missing latestTaskId.`,
      });
      continue;
    }
    const taskNumber = parseMossTaskNumber(evidence.latestTaskId);
    if (taskNumber === null) {
      issues.push({
        code: "stale-artifact",
        severity: "error",
        path: input.latest.path,
        message: `${input.latest.path} cannot prove chained freshness: ${evidence.label} latestTaskId ${evidence.latestTaskId} is not a Moss task id.`,
      });
      continue;
    }
    if (expectedTaskId && !evidence.chainedRefreshTaskId) {
      issues.push({
        code: "stale-artifact",
        severity: "error",
        path: input.latest.path,
        message: `${input.latest.path} cannot prove explicit chained freshness provenance for ${evidence.label}: chainedRefreshProvenance is missing.`,
      });
      continue;
    }
    if (
      expectedTaskId &&
      expectedTaskNumber !== null &&
      evidence.chainedRefreshTaskId &&
      mossTaskIdIsOlder(evidence.chainedRefreshTaskId, expectedTaskId)
    ) {
      issues.push({
        code: "stale-artifact",
        severity: "error",
        path: input.latest.path,
        message: `${input.latest.path} has stale chained provenance for ${evidence.label}: chainedRefreshTaskId ${evidence.chainedRefreshTaskId} is older than expected ${expectedTaskId}.`,
      });
      continue;
    }
    if (
      expectedTaskId &&
      expectedTaskNumber !== null &&
      mossTaskIdIsOlder(evidence.latestTaskId, expectedTaskId)
    ) {
      issues.push({
        code: "stale-artifact",
        severity: "error",
        path: input.latest.path,
        message: `${input.latest.path} has stale chained observed evidence for ${evidence.label}: latestTaskId ${evidence.latestTaskId} is older than expected ${expectedTaskId}.`,
      });
      continue;
    }
    if (!expectedTaskId && maxObservedTaskNumber !== null && taskNumber < maxObservedTaskNumber) {
      issues.push({
        code: "stale-artifact",
        severity: "error",
        path: input.latest.path,
        message: `${input.latest.path} has inconsistent chained observed evidence for ${evidence.label}: latestTaskId ${evidence.latestTaskId} is older than another chained report task.`,
      });
      continue;
    }

    consistencyEvidence.push(evidence);
  }

  issues.push(
    ...buildChainedObservedEvidenceConsistencyIssues({
      latest: input.latest,
      taskEvidence: consistencyEvidence,
    }),
  );

  return issues;
}

function buildChainedObservedEvidenceConsistencyIssues(input: {
  readonly latest: MossReleaseGateReportArtifactSummary;
  readonly taskEvidence: ReadonlyArray<MossReleaseGateReportArtifactObservedEvidenceSummary>;
}): ReadonlyArray<MossReleaseGateReportArtifactIssue> {
  const [baseline, ...rest] = input.taskEvidence;
  if (!baseline) {
    return [];
  }

  return rest.flatMap((evidence) => {
    const mismatches: string[] = [];

    if (
      baseline.latestTaskId &&
      evidence.latestTaskId &&
      baseline.latestTaskId !== evidence.latestTaskId
    ) {
      mismatches.push(
        `latestTaskId ${baseline.latestTaskId} does not match ${evidence.latestTaskId}`,
      );
    }

    if (
      baseline.chainedRefreshTaskId &&
      evidence.chainedRefreshTaskId &&
      baseline.chainedRefreshTaskId !== evidence.chainedRefreshTaskId
    ) {
      mismatches.push(
        `chainedRefreshTaskId ${baseline.chainedRefreshTaskId} does not match ${evidence.chainedRefreshTaskId}`,
      );
    }

    if (mismatches.length === 0) {
      return [];
    }

    return [
      {
        code: "stale-artifact",
        severity: "error",
        path: input.latest.path,
        message: `${input.latest.path} has inconsistent chained provenance between ${baseline.label} and ${evidence.label}: ${mismatches.join("; ")}.`,
      } as const satisfies MossReleaseGateReportArtifactIssue,
    ];
  });
}

function sortArtifacts(
  artifacts: ReadonlyArray<MossReleaseGateReportArtifactSummary>,
): ReadonlyArray<MossReleaseGateReportArtifactSummary> {
  return artifacts.toSorted(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) || right.path.localeCompare(left.path),
  );
}

export function readMossReleaseGateReportArtifactIndex(
  repoRoot = process.cwd(),
  options: MossReleaseGateReportIndexOptions = {},
): MossReleaseGateReportArtifactIndex {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const evidenceDirectory = join(repoRoot, EVIDENCE_DIRECTORY);
  const expectedGateIds = buildManifestGateIds({
    generatedAt,
    expectedGateIds: options.expectedGateIds,
  });
  const expectedChainedRefreshProvenance = readExpectedMossChainedRefreshProvenance(repoRoot);
  const issues: MossReleaseGateReportArtifactIssue[] = [];
  const artifacts: MossReleaseGateReportArtifactSummary[] = [];

  const names = existsSync(evidenceDirectory)
    ? readdirSync(evidenceDirectory).filter((name) => REPORT_ARTIFACT_PATTERN.test(name))
    : [];

  if (names.length === 0) {
    issues.push({
      code: "missing-artifacts",
      severity: "error",
      path: EVIDENCE_DIRECTORY,
      message: "No Moss release gate report artifact JSON files were found.",
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
  issues.push(
    ...buildFreshnessIssues({
      latest,
      expectedGateIds,
      expectedChainedRefreshTaskId: expectedChainedRefreshProvenance?.taskId,
    }),
  );
  const status = issues.length === 0 && latest?.status === "pass" ? "pass" : "fail";

  return {
    version: 1,
    generatedAt,
    sourceDirectory: EVIDENCE_DIRECTORY,
    manifest: {
      gateCount: expectedGateIds.length,
      gateIds: expectedGateIds,
    },
    ...(expectedChainedRefreshProvenance ? { expectedChainedRefreshProvenance } : {}),
    latest,
    artifacts: sortedArtifacts,
    issues,
    readiness: {
      status,
      summary:
        status === "pass"
          ? `Latest Moss release gate artifact is pass: ${latest?.path ?? "none"}.`
          : `Moss release gate artifact index has ${issues.length} issue(s).`,
    },
  };
}

export function mossReleaseGateReportArtifactIndexExitCode(
  index: MossReleaseGateReportArtifactIndex,
): number {
  return index.readiness.status === "pass" ? 0 : 1;
}
