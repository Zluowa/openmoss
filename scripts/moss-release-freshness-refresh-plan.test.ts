import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildMossReleaseGateManifest } from "./lib/moss-release-gate-manifest.ts";
import {
  buildMossReleaseFreshnessRefreshPlan,
  buildMossReleaseFreshnessRefreshPlanReport,
  writeMossReleaseFreshnessRefreshPlanReportArtifact,
} from "./moss-release-freshness-refresh-plan.ts";

const STEP_IDS = [
  "strict-release-report-stale-proof",
  "loop-packet-freshness-artifact-refresh",
  "loop-packet-freshness-report-index",
  "release-freshness-refresh-plan-report-refresh",
  "release-freshness-refresh-plan-report-index",
  "loop-packet-refresh-plan-report-refresh",
  "loop-packet-refresh-plan-report-index",
  "release-report-artifact-refresh",
  "release-report-artifact-index",
  "compact-release-report",
  "final-release-gate",
] as const;

function withTempRepo<T>(callback: (repoRoot: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "moss-release-freshness-refresh-plan-"));
  try {
    return callback(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function writeArtifact(repoRoot: string, name: string, content: unknown): void {
  const evidenceDirectory = join(repoRoot, ".moss", "ledger", "evidence");
  mkdirSync(evidenceDirectory, { recursive: true });
  writeFileSync(join(evidenceDirectory, name), JSON.stringify(content, null, 2));
}

function currentGateIds(): ReadonlyArray<string> {
  return buildMossReleaseGateManifest({
    createdAt: "2026-07-03T00:00:00.000Z",
  }).gates.map((gate) => gate.id);
}

function writeReleaseGateReportArtifact(input: {
  readonly repoRoot: string;
  readonly name: string;
  readonly createdAt: string;
  readonly gateIds?: ReadonlyArray<string> | undefined;
  readonly latestTaskId?: string | undefined;
}): void {
  const gateIds = input.gateIds ?? currentGateIds();
  writeArtifact(input.repoRoot, input.name, {
    version: 1,
    createdAt: input.createdAt,
    status: "pass",
    gates: gateIds.map((gateId) => {
      const baseGate = {
        id: gateId,
        status: "pass",
        exitCode: 0,
      };

      if (gateId === "release-freshness-refresh-plan-report-index") {
        return {
          ...baseGate,
          observedEvidence: {
            releaseFreshnessRefreshPlanReportIndex: {
              readinessStatus: "pass",
              latestArtifactCreatedAt: input.createdAt,
              issueCodes: [],
            },
          },
        };
      }

      if (gateId === "loop-packet-freshness-report-index") {
        return {
          ...baseGate,
          observedEvidence: {
            loopPacketFreshnessReportIndex: {
              readinessStatus: "pass",
              latestArtifactCreatedAt: input.createdAt,
              latestTaskId: input.latestTaskId ?? "moss-task-0070",
              issueCodes: [],
            },
          },
        };
      }

      if (gateId === "loop-packet-refresh-plan-report-index") {
        return {
          ...baseGate,
          observedEvidence: {
            loopPacketRefreshPlanReportIndex: {
              readinessStatus: "pass",
              latestArtifactCreatedAt: input.createdAt,
              latestTaskId: input.latestTaskId ?? "moss-task-0070",
              issueCodes: [],
            },
          },
        };
      }

      return baseGate;
    }),
  });
}

function writeLoopPacketFreshnessArtifact(input: {
  readonly repoRoot: string;
  readonly name: string;
  readonly createdAt: string;
  readonly releaseGateArtifactPath: string;
  readonly releaseGateCount?: number | undefined;
}): void {
  const releaseGateCount = input.releaseGateCount ?? currentGateIds().length;
  writeArtifact(input.repoRoot, input.name, {
    version: 1,
    createdAt: input.createdAt,
    status: "pass",
    task: {
      taskId: "moss-task-0062",
      title: "Automate chained release freshness refresh plan",
      owner: "Release Operator",
      status: "active",
    },
    check: {
      id: "loop-ledger-release-freshness",
      status: "pass",
      summary: `Loop Ledger Dashboard release freshness passed with ${releaseGateCount}/${releaseGateCount} gate(s).`,
      exitCode: 0,
    },
    loopPacketReadiness: {
      status: "pending",
      summary: "Loop packet aggregate gate is generated with pending review or evidence.",
    },
    releaseFreshness: {
      status: "pass",
      readinessStatus: "pass",
      summary: `Latest Moss release gate artifact is pass: ${input.releaseGateArtifactPath}.`,
      manifestGateCount: releaseGateCount,
      latestArtifactGateCount: releaseGateCount,
      artifactPath: input.releaseGateArtifactPath,
      issueCount: 0,
      issueCodes: [],
      staleArtifactMessages: [],
    },
    source: {
      loopPacketGeneratedAt: input.createdAt,
      dashboardSnapshotGeneratedAt: input.createdAt,
      releaseGateArtifactPath: input.releaseGateArtifactPath,
    },
    providerCredentialsRequired: false,
    writesGlobalConfig: false,
  });
}

describe("moss-release-freshness-refresh-plan", () => {
  it("builds a dry-run plan with ordered explicit artifact commands and no writes", () => {
    withTempRepo((repoRoot) => {
      const plan = buildMossReleaseFreshnessRefreshPlan(repoRoot, {
        createdAt: "2026-07-03T00:00:00.000Z",
      });

      expect(plan).toMatchObject({
        version: 1,
        generatedAt: "2026-07-03T00:00:00.000Z",
        mode: "dry-run",
        writesFiles: false,
        writesGlobalConfig: false,
        artifactOutputs: {
          releaseGateReport:
            ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-03-refresh.json",
          loopPacketFreshnessReport:
            ".moss/ledger/evidence/moss-loop-packet-freshness-gate-report-2026-07-03-refresh.json",
          releaseFreshnessRefreshPlanReport:
            ".moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-03-gate.json",
          loopPacketRefreshPlanReport:
            ".moss/ledger/evidence/moss-loop-packet-refresh-plan-gate-report-2026-07-03.json",
        },
        readiness: {
          status: "ready",
        },
      });
      expect(plan.steps.map((entry) => entry.id)).toEqual(STEP_IDS);
      expect(plan.steps.map((entry) => entry.writesGlobalConfig)).toEqual(
        STEP_IDS.map(() => false),
      );
      expect(plan.steps[0]).toMatchObject({
        shellCommand: "bun run moss:release-gate -- --report --created-at 2026-07-03T00:00:00.000Z",
        expectedExitCodes: [0, 1],
        writesArtifacts: false,
      });
      expect(plan.steps[1]).toMatchObject({
        command: "node",
        args: [
          "scripts/moss-loop-packet.ts",
          "--report",
          "--output",
          ".moss/ledger/evidence/moss-loop-packet-freshness-gate-report-2026-07-03-refresh.json",
          "--created-at",
          "2026-07-03T00:00:00.000Z",
        ],
        writesArtifacts: true,
      });
      expect(plan.steps[3]).toMatchObject({
        args: [
          "run",
          "moss:release-freshness-refresh-plan",
          "--",
          "--report",
          "--output",
          ".moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-03-gate.json",
          "--created-at",
          "2026-07-03T00:00:00.000Z",
        ],
        writesArtifacts: true,
        artifactOutputs: [
          ".moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-03-gate.json",
        ],
      });
      expect(plan.steps[5]).toMatchObject({
        args: [
          "run",
          "moss:loop-packet",
          "--",
          "--refresh-plan-report",
          "--output",
          ".moss/ledger/evidence/moss-loop-packet-refresh-plan-gate-report-2026-07-03.json",
          "--created-at",
          "2026-07-03T00:00:00.000Z",
        ],
        writesArtifacts: true,
        artifactOutputs: [
          ".moss/ledger/evidence/moss-loop-packet-refresh-plan-gate-report-2026-07-03.json",
        ],
      });
      expect(plan.steps[7]).toMatchObject({
        command: "node",
        args: [
          "scripts/moss-release-gate.ts",
          "--report",
          "--refresh-artifact",
          "--output",
          ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-03-refresh.json",
          "--created-at",
          "2026-07-03T00:00:00.000Z",
        ],
        writesArtifacts: true,
      });
      expect(plan.state.requiresReleaseArtifactRefresh).toBe(true);
      expect(plan.state.requiresLoopFreshnessRefresh).toBe(true);
      expect(plan.state.requiresLoopRefreshPlanReportRefresh).toBe(true);
    });
  });

  it("writes a compact report artifact only when an explicit output path is used", () => {
    withTempRepo((repoRoot) => {
      const plan = buildMossReleaseFreshnessRefreshPlan(repoRoot, {
        createdAt: "2026-07-03T00:00:00.000Z",
      });
      const report = buildMossReleaseFreshnessRefreshPlanReport(plan);
      const outputPath =
        ".moss/ledger/evidence/moss-release-freshness-refresh-plan-report-test.json";

      const result = writeMossReleaseFreshnessRefreshPlanReportArtifact(
        report,
        outputPath,
        repoRoot,
      );
      const artifactBody = readFileSync(result.path, "utf8");
      const artifact = JSON.parse(artifactBody) as Record<string, unknown>;

      expect(existsSync(result.path)).toBe(true);
      expect(result.bytes).toBeGreaterThan(0);
      expect(artifact).toMatchObject({
        version: 1,
        createdAt: "2026-07-03T00:00:00.000Z",
        status: "pass",
        providerCredentialsRequired: false,
        writesGlobalConfig: false,
        plan: {
          mode: "dry-run",
          writesFiles: false,
          writesGlobalConfig: false,
          artifactOutputs: {
            releaseFreshnessRefreshPlanReport:
              ".moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-03-gate.json",
            loopPacketRefreshPlanReport:
              ".moss/ledger/evidence/moss-loop-packet-refresh-plan-gate-report-2026-07-03.json",
          },
          stepOrder: STEP_IDS,
          readiness: {
            status: "ready",
          },
        },
      });
      expect(artifactBody).not.toContain("rawSource");
      expect(artifactBody).not.toContain("stdout");
    });
  });

  it("detects stale loop freshness after release report artifact refresh", () => {
    withTempRepo((repoRoot) => {
      const currentGateCount = currentGateIds().length;
      const staleGateIds = currentGateIds().filter(
        (gateId) => gateId !== "release-gate-report-index",
      );
      writeReleaseGateReportArtifact({
        repoRoot,
        name: "moss-release-gate-report-artifact-2026-07-02.json",
        createdAt: "2026-07-02T00:00:00.000Z",
        gateIds: staleGateIds,
      });
      writeReleaseGateReportArtifact({
        repoRoot,
        name: "moss-release-gate-report-artifact-2026-07-02-refresh.json",
        createdAt: "2026-07-02T00:00:50.000Z",
      });
      writeLoopPacketFreshnessArtifact({
        repoRoot,
        name: "moss-loop-packet-freshness-gate-report-2026-07-02.json",
        createdAt: "2026-07-02T00:00:00.000Z",
        releaseGateArtifactPath:
          ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-02.json",
        releaseGateCount: staleGateIds.length,
      });

      const plan = buildMossReleaseFreshnessRefreshPlan(repoRoot, {
        createdAt: "2026-07-02T00:00:55.000Z",
      });

      expect(plan.state.releaseGateReportIndex).toMatchObject({
        readinessStatus: "pass",
        latestArtifactPath:
          ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-02-refresh.json",
        manifestGateCount: currentGateCount,
        latestArtifactGateCount: currentGateCount,
        issueCodes: [],
      });
      expect(plan.state.loopPacketFreshnessReportIndex).toMatchObject({
        readinessStatus: "fail",
        latestArtifactPath:
          ".moss/ledger/evidence/moss-loop-packet-freshness-gate-report-2026-07-02.json",
        releaseGateArtifactPath:
          ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-02.json",
        manifestGateCount: staleGateIds.length,
        latestArtifactGateCount: staleGateIds.length,
        issueCodes: ["stale-release-freshness"],
        releaseFreshnessIssueCodes: [],
      });
      expect(plan.state.requiresReleaseArtifactRefresh).toBe(false);
      expect(plan.state.requiresLoopFreshnessRefresh).toBe(true);
    });
  });

  it("reports refreshed release and loop freshness artifacts as the ready end state", () => {
    withTempRepo((repoRoot) => {
      const currentGateCount = currentGateIds().length;
      const staleGateIds = currentGateIds().filter(
        (gateId) => gateId !== "release-gate-report-index",
      );
      writeReleaseGateReportArtifact({
        repoRoot,
        name: "moss-release-gate-report-artifact-2026-07-02.json",
        createdAt: "2026-07-02T00:00:00.000Z",
        gateIds: staleGateIds,
      });
      writeReleaseGateReportArtifact({
        repoRoot,
        name: "moss-release-gate-report-artifact-2026-07-02-refresh.json",
        createdAt: "2026-07-02T00:00:50.000Z",
      });
      writeLoopPacketFreshnessArtifact({
        repoRoot,
        name: "moss-loop-packet-freshness-gate-report-2026-07-02.json",
        createdAt: "2026-07-02T00:00:00.000Z",
        releaseGateArtifactPath:
          ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-02.json",
        releaseGateCount: staleGateIds.length,
      });
      writeLoopPacketFreshnessArtifact({
        repoRoot,
        name: "moss-loop-packet-freshness-gate-report-2026-07-02-refresh.json",
        createdAt: "2026-07-02T00:00:55.000Z",
        releaseGateArtifactPath:
          ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-02-refresh.json",
      });

      const plan = buildMossReleaseFreshnessRefreshPlan(repoRoot, {
        createdAt: "2026-07-02T00:00:55.000Z",
      });

      expect(plan.state.releaseGateReportIndex).toMatchObject({
        readinessStatus: "pass",
        latestArtifactPath:
          ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-02-refresh.json",
        manifestGateCount: currentGateCount,
        latestArtifactGateCount: currentGateCount,
        issueCodes: [],
      });
      expect(plan.state.loopPacketFreshnessReportIndex).toMatchObject({
        readinessStatus: "pass",
        latestArtifactPath:
          ".moss/ledger/evidence/moss-loop-packet-freshness-gate-report-2026-07-02-refresh.json",
        releaseGateArtifactPath:
          ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-02-refresh.json",
        releaseFreshnessReadinessStatus: "pass",
        manifestGateCount: currentGateCount,
        latestArtifactGateCount: currentGateCount,
        issueCodes: [],
        releaseFreshnessIssueCodes: [],
      });
      expect(plan.state.requiresReleaseArtifactRefresh).toBe(false);
      expect(plan.state.requiresLoopFreshnessRefresh).toBe(false);
      expect(plan.state.requiresLoopRefreshPlanReportRefresh).toBe(true);
    });
  });
});
