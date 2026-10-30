import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildMossReleaseFreshnessRefreshPlan,
  buildMossReleaseFreshnessRefreshPlanReport,
  MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER,
  writeMossReleaseFreshnessRefreshPlanReportArtifact,
  type MossReleaseFreshnessRefreshPlanReport,
} from "./moss-release-freshness-refresh-plan.ts";
import {
  mossReleaseFreshnessRefreshPlanReportIndexExitCode,
  readMossReleaseFreshnessRefreshPlanReportIndex,
} from "./moss-release-freshness-refresh-plan-report-index.ts";

function withTempRepo<T>(callback: (repoRoot: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "moss-release-refresh-plan-index-"));
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

function buildReport(
  repoRoot: string,
  createdAt = "2026-07-03T00:00:00.000Z",
): MossReleaseFreshnessRefreshPlanReport {
  return buildMossReleaseFreshnessRefreshPlanReport(
    buildMossReleaseFreshnessRefreshPlan(repoRoot, { createdAt }),
  );
}

function writeReportArtifact(input: {
  readonly repoRoot: string;
  readonly name: string;
  readonly createdAt?: string | undefined;
  readonly report?: MossReleaseFreshnessRefreshPlanReport | undefined;
}): void {
  writeMossReleaseFreshnessRefreshPlanReportArtifact(
    input.report ?? buildReport(input.repoRoot, input.createdAt),
    `.moss/ledger/evidence/${input.name}`,
    input.repoRoot,
  );
}

describe("moss-release-freshness-refresh-plan-report-index", () => {
  it("summarizes the latest passing compact report without copying command detail", () => {
    withTempRepo((repoRoot) => {
      writeReportArtifact({
        repoRoot,
        name: "moss-release-freshness-refresh-plan-report-2026-07-02.json",
        createdAt: "2026-07-02T00:01:00.000Z",
      });
      writeReportArtifact({
        repoRoot,
        name: "moss-release-freshness-refresh-plan-report-2026-07-03.json",
        createdAt: "2026-07-03T00:00:00.000Z",
      });

      const index = readMossReleaseFreshnessRefreshPlanReportIndex(repoRoot, {
        generatedAt: "2026-07-03T01:00:00.000Z",
      });

      expect(index).toMatchObject({
        version: 1,
        generatedAt: "2026-07-03T01:00:00.000Z",
        expectedStepOrder: [...MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER],
        latest: {
          path: ".moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-03.json",
          createdAt: "2026-07-03T00:00:00.000Z",
          status: "pass",
          mode: "dry-run",
          writesFiles: false,
          writesGlobalConfig: false,
          providerCredentialsRequired: false,
          readinessStatus: "ready",
          releaseGateReportArtifactOutput:
            ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-03-refresh.json",
          loopPacketFreshnessReportArtifactOutput:
            ".moss/ledger/evidence/moss-loop-packet-freshness-gate-report-2026-07-03-refresh.json",
          releaseFreshnessRefreshPlanReportArtifactOutput:
            ".moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-03-gate.json",
          loopPacketRefreshPlanReportArtifactOutput:
            ".moss/ledger/evidence/moss-loop-packet-refresh-plan-gate-report-2026-07-03.json",
          stepOrder: [...MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER],
        },
        readiness: {
          status: "pass",
        },
      });
      expect(index.artifacts.map((artifact) => artifact.path)).toEqual([
        ".moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-03.json",
        ".moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-02.json",
      ]);
      expect(index.issues).toEqual([]);
      expect(mossReleaseFreshnessRefreshPlanReportIndexExitCode(index)).toBe(0);
      expect(JSON.stringify(index)).not.toContain("shellCommand");
      expect(JSON.stringify(index)).not.toContain("stdout");
    });
  });

  it("reports missing artifacts as a deterministic readiness issue", () => {
    withTempRepo((repoRoot) => {
      const index = readMossReleaseFreshnessRefreshPlanReportIndex(repoRoot, {
        generatedAt: "2026-07-03T01:00:00.000Z",
      });

      expect(index.latest).toBeNull();
      expect(index.issues).toEqual([
        {
          code: "missing-artifacts",
          severity: "error",
          path: ".moss/ledger/evidence",
          message: "No Moss release freshness refresh plan report JSON files were found.",
        },
      ]);
      expect(index.readiness.status).toBe("fail");
      expect(mossReleaseFreshnessRefreshPlanReportIndexExitCode(index)).toBe(1);
    });
  });

  it("fails stale step order in the latest compact report", () => {
    withTempRepo((repoRoot) => {
      const report = buildReport(repoRoot);
      writeArtifact(repoRoot, "moss-release-freshness-refresh-plan-report-2026-07-03.json", {
        ...report,
        plan: {
          ...report.plan,
          stepOrder: report.plan.stepOrder.filter((stepId) => stepId !== "final-release-gate"),
        },
      });

      const index = readMossReleaseFreshnessRefreshPlanReportIndex(repoRoot, {
        generatedAt: "2026-07-03T01:00:00.000Z",
      });

      expect(index.latest).toMatchObject({
        path: ".moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-03.json",
        status: "pass",
      });
      expect(index.issues).toEqual([
        expect.objectContaining({
          code: "stale-step-order",
          severity: "error",
          path: ".moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-03.json",
        }),
      ]);
      expect(index.issues[0]?.message).toContain("loop-packet-refresh-plan-report-index");
      expect(index.readiness.status).toBe("fail");
      expect(mossReleaseFreshnessRefreshPlanReportIndexExitCode(index)).toBe(1);
    });
  });

  it("fails unsafe write flags in the latest compact report", () => {
    withTempRepo((repoRoot) => {
      const report = buildReport(repoRoot);
      writeArtifact(repoRoot, "moss-release-freshness-refresh-plan-report-2026-07-03.json", {
        ...report,
        providerCredentialsRequired: true,
        plan: {
          ...report.plan,
          writesFiles: true,
          steps: report.plan.steps.map((step) => {
            if (step.id !== "compact-release-report") {
              return step;
            }
            return Object.assign({}, step, { writesArtifacts: true });
          }),
        },
      });

      const index = readMossReleaseFreshnessRefreshPlanReportIndex(repoRoot, {
        generatedAt: "2026-07-03T01:00:00.000Z",
      });

      expect(index.issues).toEqual([
        {
          code: "unsafe-write-flags",
          severity: "error",
          path: ".moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-03.json",
          message:
            ".moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-03.json has unsafe release freshness refresh plan write flags: plan writesFiles is not false; providerCredentialsRequired is not false; compact-release-report writesArtifacts is true.",
        },
      ]);
      expect(index.readiness.status).toBe("fail");
      expect(mossReleaseFreshnessRefreshPlanReportIndexExitCode(index)).toBe(1);
    });
  });

  it("reports malformed, invalid, and failing artifacts in machine-readable form", () => {
    withTempRepo((repoRoot) => {
      writeArtifact(repoRoot, "moss-release-freshness-refresh-plan-report-malformed.json", "{bad");
      writeArtifact(repoRoot, "moss-release-freshness-refresh-plan-report-invalid.json", {
        version: 2,
        createdAt: "2026-07-03T00:00:00.000Z",
        status: "pass",
      });
      writeArtifact(repoRoot, "moss-release-freshness-refresh-plan-report-fail.json", {
        ...buildReport(repoRoot),
        status: "fail",
      });

      const index = readMossReleaseFreshnessRefreshPlanReportIndex(repoRoot, {
        generatedAt: "2026-07-03T01:00:00.000Z",
      });

      expect(index.latest).toMatchObject({
        path: ".moss/ledger/evidence/moss-release-freshness-refresh-plan-report-fail.json",
        status: "fail",
      });
      expect(index.issues.map((issue) => issue.code)).toEqual([
        "failing-artifact",
        "invalid-artifact",
        "malformed-artifact",
      ]);
      expect(index.readiness).toEqual({
        status: "fail",
        summary: "Moss release freshness refresh plan report index has 3 issue(s).",
      });
      expect(mossReleaseFreshnessRefreshPlanReportIndexExitCode(index)).toBe(1);
    });
  });
});
