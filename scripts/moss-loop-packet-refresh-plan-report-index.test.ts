import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  mossLoopPacketRefreshPlanGateReportIndexExitCode,
  readMossLoopPacketRefreshPlanGateReportIndex,
} from "./moss-loop-packet-refresh-plan-report-index.ts";
import { MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER } from "./lib/moss-release-freshness-refresh-plan-constants.ts";

function withTempRepo<T>(callback: (repoRoot: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "moss-loop-packet-refresh-plan-report-index-"));
  try {
    return callback(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function writeArtifact(repoRoot: string, name: string, content: unknown): void {
  const evidenceDirectory = join(repoRoot, ".moss", "ledger", "evidence");
  mkdirSync(evidenceDirectory, { recursive: true });
  writeFileSync(
    join(evidenceDirectory, name),
    typeof content === "string" ? content : JSON.stringify(content, null, 2),
  );
}

function writeRefreshPlanReportArtifact(input: {
  readonly repoRoot: string;
  readonly name: string;
  readonly createdAt: string;
  readonly stepOrder?: ReadonlyArray<string> | undefined;
}): void {
  const stepOrder = input.stepOrder ?? MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER;
  const artifactWriterStepIds = new Set([
    "release-report-artifact-refresh",
    "loop-packet-freshness-artifact-refresh",
    "release-freshness-refresh-plan-report-refresh",
    "loop-packet-refresh-plan-report-refresh",
  ]);

  writeArtifact(input.repoRoot, input.name, {
    version: 1,
    createdAt: input.createdAt,
    status: "pass",
    providerCredentialsRequired: false,
    writesGlobalConfig: false,
    plan: {
      mode: "dry-run",
      writesFiles: false,
      writesGlobalConfig: false,
      readiness: {
        status: "ready",
      },
      artifactOutputs: {
        releaseGateReport: ".moss/ledger/evidence/moss-release-gate-report-artifact-refresh.json",
        loopPacketFreshnessReport:
          ".moss/ledger/evidence/moss-loop-packet-freshness-gate-report-refresh.json",
        releaseFreshnessRefreshPlanReport:
          ".moss/ledger/evidence/moss-release-freshness-refresh-plan-report-refresh.json",
        loopPacketRefreshPlanReport:
          ".moss/ledger/evidence/moss-loop-packet-refresh-plan-gate-report-refresh.json",
      },
      state: {
        requiresReleaseArtifactRefresh: false,
        requiresLoopFreshnessRefresh: false,
      },
      stepOrder,
      steps: stepOrder.map((id) => ({
        id,
        writesArtifacts: artifactWriterStepIds.has(id),
        artifactOutputs: artifactWriterStepIds.has(id)
          ? [`.moss/ledger/evidence/${id}-output.json`]
          : [],
        writesGlobalConfig: false,
      })),
    },
  });
}

function report(input: {
  readonly createdAt: string;
  readonly status?: "pass" | "fail" | undefined;
  readonly checkStatus?: "pass" | "pending" | "fail" | undefined;
  readonly refreshPlanArtifactPath?: string | undefined;
  readonly stepCount?: number | undefined;
  readonly topLevelWritesFiles?: boolean | undefined;
  readonly refreshPlanWritesFiles?: boolean | undefined;
}): Record<string, unknown> {
  const status = input.status ?? "pass";
  const checkStatus = input.checkStatus ?? status;
  const refreshPlanArtifactPath =
    input.refreshPlanArtifactPath ??
    ".moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-02.json";
  const stepCount = input.stepCount ?? MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER.length;

  return {
    version: 1,
    createdAt: input.createdAt,
    status,
    rawSource: "raw provider event should not be copied into the index",
    stdout: "child command output should not be copied into the index",
    task: {
      taskId: "moss-task-0067",
      title: "Persist loop packet refresh plan dashboard gate report evidence",
      owner: "Release Operator",
      status: "active",
    },
    chainedRefreshProvenance: {
      kind: "release-artifact-chain-freshness",
      expected: true,
      taskId: "moss-task-0067",
      source: "loop-packet-task-metadata",
    },
    check: {
      id: "loop-ledger-refresh-plan",
      status: checkStatus,
      summary: `Loop Ledger Dashboard refresh plan passed with ${stepCount}/${stepCount} step(s).`,
      exitCode: checkStatus === "pass" ? 0 : 1,
    },
    loopPacketReadiness: {
      status: "pending",
      summary: "Loop packet aggregate gate is generated with pending review or evidence.",
    },
    refreshPlan: {
      status: "pass",
      readinessStatus: "pass",
      summary: `Latest Moss release freshness refresh plan report is pass: ${refreshPlanArtifactPath}.`,
      expectedStepCount: stepCount,
      latestStepCount: stepCount,
      artifactPath: refreshPlanArtifactPath,
      latestArtifactStatus: "pass",
      mode: "dry-run",
      writesFiles: input.refreshPlanWritesFiles ?? false,
      writesGlobalConfig: false,
      providerCredentialsRequired: false,
      requiresReleaseArtifactRefresh: false,
      requiresLoopFreshnessRefresh: false,
      issueCount: 0,
      issueCodes: [],
    },
    source: {
      loopPacketGeneratedAt: input.createdAt,
      dashboardSnapshotGeneratedAt: input.createdAt,
      refreshPlanArtifactPath,
    },
    providerCredentialsRequired: false,
    writesFiles: input.topLevelWritesFiles ?? false,
    writesGlobalConfig: false,
  };
}

describe("moss-loop-packet-refresh-plan-report-index", () => {
  it("summarizes the latest passing compact report without copying raw output fields", () => {
    withTempRepo((repoRoot) => {
      writeRefreshPlanReportArtifact({
        repoRoot,
        name: "moss-release-freshness-refresh-plan-report-2026-07-02.json",
        createdAt: "2026-07-02T00:00:00.000Z",
      });
      writeArtifact(
        repoRoot,
        "moss-loop-packet-refresh-plan-gate-report-2026-07-01.json",
        report({ createdAt: "2026-07-01T00:00:00.000Z" }),
      );
      writeArtifact(
        repoRoot,
        "moss-loop-packet-refresh-plan-gate-report-2026-07-02.json",
        report({ createdAt: "2026-07-02T00:00:00.000Z" }),
      );

      const index = readMossLoopPacketRefreshPlanGateReportIndex(repoRoot, {
        generatedAt: "2026-07-02T01:00:00.000Z",
      });

      expect(index).toMatchObject({
        version: 1,
        generatedAt: "2026-07-02T01:00:00.000Z",
        latest: {
          path: ".moss/ledger/evidence/moss-loop-packet-refresh-plan-gate-report-2026-07-02.json",
          createdAt: "2026-07-02T00:00:00.000Z",
          status: "pass",
          taskId: "moss-task-0067",
          chainedRefreshProvenance: {
            kind: "release-artifact-chain-freshness",
            taskId: "moss-task-0067",
            source: "loop-packet-task-metadata",
          },
          checkStatus: "pass",
          loopPacketReadinessStatus: "pending",
          writesFiles: false,
          writesGlobalConfig: false,
          providerCredentialsRequired: false,
          refreshPlan: {
            readinessStatus: "pass",
            expectedStepCount: MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER.length,
            latestStepCount: MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER.length,
            refreshPlanArtifactPath:
              ".moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-02.json",
            mode: "dry-run",
            writesFiles: false,
            writesGlobalConfig: false,
            providerCredentialsRequired: false,
            issueCount: 0,
          },
        },
        readiness: {
          status: "pass",
        },
      });
      expect(index.artifacts.map((artifact) => artifact.path)).toEqual([
        ".moss/ledger/evidence/moss-loop-packet-refresh-plan-gate-report-2026-07-02.json",
        ".moss/ledger/evidence/moss-loop-packet-refresh-plan-gate-report-2026-07-01.json",
      ]);
      expect(index.issues).toEqual([]);
      expect(mossLoopPacketRefreshPlanGateReportIndexExitCode(index)).toBe(0);
      expect(JSON.stringify(index)).not.toContain("rawSource");
      expect(JSON.stringify(index)).not.toContain("stdout");
    });
  });

  it("fails a stale latest report that still points at a pre-refresh plan artifact", () => {
    withTempRepo((repoRoot) => {
      const staleStepOrder = MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER.filter(
        (stepId) => stepId !== "final-release-gate",
      );
      writeRefreshPlanReportArtifact({
        repoRoot,
        name: "moss-release-freshness-refresh-plan-report-2026-07-02.json",
        createdAt: "2026-07-02T00:00:00.000Z",
        stepOrder: staleStepOrder,
      });
      writeRefreshPlanReportArtifact({
        repoRoot,
        name: "moss-release-freshness-refresh-plan-report-2026-07-02-refresh.json",
        createdAt: "2026-07-02T00:00:50.000Z",
      });
      writeArtifact(
        repoRoot,
        "moss-loop-packet-refresh-plan-gate-report-2026-07-02.json",
        report({
          createdAt: "2026-07-02T00:00:00.000Z",
          refreshPlanArtifactPath:
            ".moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-02.json",
          stepCount: staleStepOrder.length,
        }),
      );

      const index = readMossLoopPacketRefreshPlanGateReportIndex(repoRoot, {
        generatedAt: "2026-07-02T00:00:55.000Z",
      });

      expect(index.latest).toMatchObject({
        path: ".moss/ledger/evidence/moss-loop-packet-refresh-plan-gate-report-2026-07-02.json",
        status: "pass",
        refreshPlan: {
          refreshPlanArtifactPath:
            ".moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-02.json",
          expectedStepCount: staleStepOrder.length,
          latestStepCount: staleStepOrder.length,
        },
      });
      expect(index.issues).toEqual([
        expect.objectContaining({
          code: "stale-refresh-plan",
          severity: "error",
          path: ".moss/ledger/evidence/moss-loop-packet-refresh-plan-gate-report-2026-07-02.json",
        }),
      ]);
      expect(index.readiness.status).toBe("fail");
      expect(mossLoopPacketRefreshPlanGateReportIndexExitCode(index)).toBe(1);
    });
  });

  it("reports missing artifacts as a deterministic readiness issue", () => {
    withTempRepo((repoRoot) => {
      const index = readMossLoopPacketRefreshPlanGateReportIndex(repoRoot, {
        generatedAt: "2026-07-02T01:00:00.000Z",
      });

      expect(index.latest).toBeNull();
      expect(index.issues).toEqual([
        {
          code: "missing-artifacts",
          severity: "error",
          path: ".moss/ledger/evidence",
          message: "No Moss loop packet refresh plan gate report JSON files were found.",
        },
      ]);
      expect(index.readiness.status).toBe("fail");
      expect(mossLoopPacketRefreshPlanGateReportIndexExitCode(index)).toBe(1);
    });
  });

  it("reports invalid and failing artifacts in machine-readable form", () => {
    withTempRepo((repoRoot) => {
      writeArtifact(repoRoot, "moss-loop-packet-refresh-plan-gate-report-malformed.json", "{bad");
      writeArtifact(repoRoot, "moss-loop-packet-refresh-plan-gate-report-invalid.json", {
        version: 2,
        createdAt: "2026-07-02T00:00:00.000Z",
        status: "pass",
      });
      writeArtifact(
        repoRoot,
        "moss-loop-packet-refresh-plan-gate-report-fail.json",
        report({
          createdAt: "2026-07-02T00:00:00.000Z",
          status: "fail",
          checkStatus: "fail",
        }),
      );

      const index = readMossLoopPacketRefreshPlanGateReportIndex(repoRoot, {
        generatedAt: "2026-07-02T01:00:00.000Z",
      });

      expect(index.latest).toMatchObject({
        path: ".moss/ledger/evidence/moss-loop-packet-refresh-plan-gate-report-fail.json",
        status: "fail",
      });
      expect(index.issues.map((issue) => issue.code)).toEqual([
        "failing-artifact",
        "invalid-artifact",
        "malformed-artifact",
      ]);
      expect(index.readiness).toEqual({
        status: "fail",
        summary: "Moss loop packet refresh plan gate report index has 3 issue(s).",
      });
      expect(mossLoopPacketRefreshPlanGateReportIndexExitCode(index)).toBe(1);
    });
  });

  it("blocks unsafe write flags in the latest compact report", () => {
    withTempRepo((repoRoot) => {
      writeRefreshPlanReportArtifact({
        repoRoot,
        name: "moss-release-freshness-refresh-plan-report-2026-07-02.json",
        createdAt: "2026-07-02T00:00:00.000Z",
      });
      writeArtifact(
        repoRoot,
        "moss-loop-packet-refresh-plan-gate-report-2026-07-02.json",
        report({
          createdAt: "2026-07-02T00:00:00.000Z",
          topLevelWritesFiles: true,
          refreshPlanWritesFiles: true,
        }),
      );

      const index = readMossLoopPacketRefreshPlanGateReportIndex(repoRoot, {
        generatedAt: "2026-07-02T01:00:00.000Z",
      });

      expect(index.issues).toEqual([
        expect.objectContaining({
          code: "unsafe-write-flags",
          path: ".moss/ledger/evidence/moss-loop-packet-refresh-plan-gate-report-2026-07-02.json",
        }),
      ]);
      expect(index.readiness.status).toBe("fail");
      expect(mossLoopPacketRefreshPlanGateReportIndexExitCode(index)).toBe(1);
    });
  });
});
