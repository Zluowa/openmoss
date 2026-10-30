import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  mossReleaseGateReportArtifactIndexExitCode,
  readMossReleaseGateReportArtifactIndex,
} from "./moss-release-gate-report-index.ts";
import { buildMossReleaseGateManifest } from "./moss-release-gate.ts";

function withTempRepo<T>(callback: (repoRoot: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "moss-release-gate-report-index-"));
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

function writeTaskLedger(repoRoot: string, tasks: ReadonlyArray<Record<string, unknown>>): void {
  const ledgerDirectory = join(repoRoot, ".moss", "ledger");
  mkdirSync(ledgerDirectory, { recursive: true });
  writeFileSync(
    join(ledgerDirectory, "tasks.jsonl"),
    tasks.map((task) => JSON.stringify(task)).join("\n"),
  );
}

function chainedRefreshProvenance(taskId: string): Record<string, unknown> {
  return {
    kind: "release-artifact-chain-freshness",
    expected: true,
    taskId,
    source: "loop-packet-task-metadata",
  };
}

function report(input: {
  readonly createdAt: string;
  readonly status: "pass" | "fail";
  readonly gateCount?: number | undefined;
  readonly gateIds?: ReadonlyArray<string> | undefined;
  readonly failedGateId?: string | undefined;
  readonly observedEvidence?:
    | "fresh"
    | "mismatched-provenance"
    | "missing"
    | "missing-provenance"
    | "stale-date"
    | "stale-task"
    | undefined;
  readonly expectedTaskId?: string | undefined;
}): Record<string, unknown> {
  const gateIds =
    input.gateIds ?? Array.from({ length: input.gateCount ?? 0 }, (_, index) => `gate-${index}`);
  const observedEvidenceMode = input.observedEvidence ?? "fresh";
  const observedArtifactCreatedAt =
    observedEvidenceMode === "stale-date" ? "2026-07-01T00:00:00.000Z" : input.createdAt;
  const expectedTaskId = input.expectedTaskId ?? "moss-task-0070";
  const loopFreshnessTaskId =
    observedEvidenceMode === "stale-task"
      ? "moss-task-0068"
      : observedEvidenceMode === "mismatched-provenance"
        ? "moss-task-0071"
        : expectedTaskId;
  const includeLoopProvenance = observedEvidenceMode !== "missing-provenance";

  const observedEvidenceForGate = (gateId: string): Record<string, unknown> | undefined => {
    if (observedEvidenceMode === "missing") {
      return undefined;
    }
    if (gateId === "release-freshness-refresh-plan-report-index") {
      return {
        releaseFreshnessRefreshPlanReportIndex: {
          readinessStatus: "pass",
          latestArtifactCreatedAt: observedArtifactCreatedAt,
          issueCodes: [],
        },
      };
    }
    if (gateId === "loop-packet-freshness-report-index") {
      return {
        loopPacketFreshnessReportIndex: {
          readinessStatus: "pass",
          latestArtifactCreatedAt: observedArtifactCreatedAt,
          latestTaskId: loopFreshnessTaskId,
          ...(includeLoopProvenance
            ? {
                latestChainedRefreshTaskId: loopFreshnessTaskId,
                latestChainedRefreshProvenance: chainedRefreshProvenance(loopFreshnessTaskId),
              }
            : {}),
          issueCodes: [],
        },
      };
    }
    if (gateId === "loop-packet-refresh-plan-report-index") {
      return {
        loopPacketRefreshPlanReportIndex: {
          readinessStatus: "pass",
          latestArtifactCreatedAt: observedArtifactCreatedAt,
          latestTaskId: expectedTaskId,
          ...(includeLoopProvenance
            ? {
                latestChainedRefreshTaskId: expectedTaskId,
                latestChainedRefreshProvenance: chainedRefreshProvenance(expectedTaskId),
              }
            : {}),
          issueCodes: [],
        },
      };
    }
    return undefined;
  };

  return {
    version: 1,
    createdAt: input.createdAt,
    status: input.status,
    ...(input.failedGateId ? { failedGateId: input.failedGateId } : {}),
    rawSource: "provider replay detail should not be copied into the index",
    stdout: "child output should not be copied into the index",
    gates: gateIds.map((gateId) => {
      const observedEvidence = observedEvidenceForGate(gateId);
      return {
        id: gateId,
        status: input.status,
        exitCode: input.status === "pass" ? 0 : 1,
        ...(observedEvidence ? { observedEvidence } : {}),
      };
    }),
  };
}

function currentGateIds(): ReadonlyArray<string> {
  return buildMossReleaseGateManifest({
    createdAt: "2026-07-01T01:00:00.000Z",
  }).gates.map((gate) => gate.id);
}

describe("moss-release-gate-report-index", () => {
  it("summarizes the latest passing current-manifest artifact without copying raw output fields", () => {
    withTempRepo((repoRoot) => {
      writeArtifact(
        repoRoot,
        "moss-release-gate-report-artifact-2026-06-30.json",
        report({
          createdAt: "2026-06-30T00:00:00.000Z",
          gateCount: 4,
          status: "pass",
        }),
      );
      writeArtifact(
        repoRoot,
        "moss-release-gate-report-artifact-2026-07-01.json",
        report({
          createdAt: "2026-07-01T00:00:00.000Z",
          gateIds: currentGateIds(),
          status: "pass",
        }),
      );

      const index = readMossReleaseGateReportArtifactIndex(repoRoot, {
        generatedAt: "2026-07-01T01:00:00.000Z",
      });

      expect(index).toMatchObject({
        version: 1,
        generatedAt: "2026-07-01T01:00:00.000Z",
        latest: {
          path: ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-01.json",
          createdAt: "2026-07-01T00:00:00.000Z",
          status: "pass",
          gateCount: currentGateIds().length,
          gateIds: currentGateIds(),
        },
        manifest: {
          gateCount: currentGateIds().length,
          gateIds: currentGateIds(),
        },
        readiness: {
          status: "pass",
        },
      });
      expect(index.artifacts.map((artifact) => artifact.path)).toEqual([
        ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-01.json",
        ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-06-30.json",
      ]);
      expect(index.latest?.chainedObservedEvidence?.loopPacketFreshnessReport).toMatchObject({
        latestTaskId: "moss-task-0070",
        chainedRefreshTaskId: "moss-task-0070",
      });
      expect(index.latest?.chainedObservedEvidence?.loopPacketRefreshPlanReport).toMatchObject({
        latestTaskId: "moss-task-0070",
        chainedRefreshTaskId: "moss-task-0070",
      });
      expect(index.issues).toEqual([]);
      expect(mossReleaseGateReportArtifactIndexExitCode(index)).toBe(0);
      expect(JSON.stringify(index)).not.toContain("rawSource");
      expect(JSON.stringify(index)).not.toContain("stdout");
    });
  });

  it("fails a stale latest artifact that does not match the current manifest gate ids", () => {
    withTempRepo((repoRoot) => {
      const staleGateIds = currentGateIds().filter(
        (gateId) => gateId !== "release-gate-report-index",
      );
      writeArtifact(
        repoRoot,
        "moss-release-gate-report-artifact-2026-07-01.json",
        report({
          createdAt: "2026-07-01T00:00:00.000Z",
          gateIds: staleGateIds,
          status: "pass",
        }),
      );

      const index = readMossReleaseGateReportArtifactIndex(repoRoot, {
        generatedAt: "2026-07-01T01:00:00.000Z",
      });

      expect(index.latest).toMatchObject({
        path: ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-01.json",
        status: "pass",
        gateCount: staleGateIds.length,
        gateIds: staleGateIds,
      });
      expect(index.issues).toEqual([
        {
          code: "stale-artifact",
          severity: "error",
          path: ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-01.json",
          message: `.moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-01.json is stale against current release gate manifest: expected ${currentGateIds().length} gate(s) [${currentGateIds().join(", ")}], found ${staleGateIds.length} gate(s), missing [release-gate-report-index], unexpected [].`,
        },
      ]);
      expect(index.readiness).toEqual({
        status: "fail",
        summary: "Moss release gate artifact index has 1 issue(s).",
      });
      expect(mossReleaseGateReportArtifactIndexExitCode(index)).toBe(1);
    });
  });

  it("fails stale chained observed evidence inside an otherwise passing current-manifest artifact", () => {
    withTempRepo((repoRoot) => {
      writeTaskLedger(repoRoot, [
        {
          taskId: "moss-task-0070",
          status: "done",
          owner: "Release Operator",
          title: "Any explicit chain task title",
          metadata: {
            chainedRefreshProvenance: {
              kind: "release-artifact-chain-freshness",
              expected: true,
            },
          },
          acceptance: [],
          evidence: ["release artifact refreshed"],
        },
      ]);
      writeArtifact(
        repoRoot,
        "moss-release-gate-report-artifact-2026-07-02-refresh.json",
        report({
          createdAt: "2026-07-02T00:01:50.000Z",
          gateIds: currentGateIds(),
          observedEvidence: "stale-date",
          status: "pass",
        }),
      );

      const index = readMossReleaseGateReportArtifactIndex(repoRoot, {
        generatedAt: "2026-07-02T00:02:00.000Z",
      });

      expect(index.latest).toMatchObject({
        path: ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-02-refresh.json",
        status: "pass",
        gateCount: currentGateIds().length,
      });
      expect(index.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "stale-artifact",
            path: ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-02-refresh.json",
            message: expect.stringContaining(
              "latestArtifactCreatedAt 2026-07-01T00:00:00.000Z predates release artifact createdAt 2026-07-02T00:01:50.000Z",
            ),
          }),
        ]),
      );
      expect(index.readiness.status).toBe("fail");
      expect(mossReleaseGateReportArtifactIndexExitCode(index)).toBe(1);
    });
  });

  it("fails loop report task ids older than the chained release artifact refresh task", () => {
    withTempRepo((repoRoot) => {
      writeTaskLedger(repoRoot, [
        {
          taskId: "moss-task-0070",
          status: "done",
          owner: "Release Operator",
          title: "Any explicit chain task title",
          metadata: {
            chainedRefreshProvenance: {
              kind: "release-artifact-chain-freshness",
              expected: true,
            },
          },
          acceptance: [],
          evidence: ["release artifact refreshed"],
        },
      ]);
      writeArtifact(
        repoRoot,
        "moss-release-gate-report-artifact-2026-07-02-refresh.json",
        report({
          createdAt: "2026-07-02T00:01:50.000Z",
          expectedTaskId: "moss-task-0070",
          gateIds: currentGateIds(),
          observedEvidence: "stale-task",
          status: "pass",
        }),
      );

      const index = readMossReleaseGateReportArtifactIndex(repoRoot, {
        generatedAt: "2026-07-02T00:02:00.000Z",
      });

      expect(index.issues).toEqual([
        expect.objectContaining({
          code: "stale-artifact",
          path: ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-02-refresh.json",
          message: expect.stringContaining(
            "chainedRefreshTaskId moss-task-0068 is older than expected moss-task-0070",
          ),
        }),
      ]);
      expect(index.readiness).toEqual({
        status: "fail",
        summary: "Moss release gate artifact index has 1 issue(s).",
      });
      expect(mossReleaseGateReportArtifactIndexExitCode(index)).toBe(1);
    });
  });

  it("fails missing explicit chained provenance separately from stale task evidence", () => {
    withTempRepo((repoRoot) => {
      writeTaskLedger(repoRoot, [
        {
          taskId: "moss-task-0070",
          status: "done",
          owner: "Release Operator",
          title: "Any explicit chain task title",
          metadata: {
            chainedRefreshProvenance: {
              kind: "release-artifact-chain-freshness",
              expected: true,
            },
          },
          acceptance: [],
          evidence: ["release artifact refreshed"],
        },
      ]);
      writeArtifact(
        repoRoot,
        "moss-release-gate-report-artifact-2026-07-02-refresh.json",
        report({
          createdAt: "2026-07-02T00:01:50.000Z",
          expectedTaskId: "moss-task-0070",
          gateIds: currentGateIds(),
          observedEvidence: "missing-provenance",
          status: "pass",
        }),
      );

      const index = readMossReleaseGateReportArtifactIndex(repoRoot, {
        generatedAt: "2026-07-02T00:02:00.000Z",
      });

      expect(index.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "stale-artifact",
            message: expect.stringContaining(
              "cannot prove explicit chained freshness provenance for loop packet freshness report: chainedRefreshProvenance is missing",
            ),
          }),
          expect.objectContaining({
            code: "stale-artifact",
            message: expect.stringContaining(
              "cannot prove explicit chained freshness provenance for loop packet refresh-plan report: chainedRefreshProvenance is missing",
            ),
          }),
        ]),
      );
      expect(index.readiness.status).toBe("fail");
      expect(mossReleaseGateReportArtifactIndexExitCode(index)).toBe(1);
    });
  });

  it("fails mismatched loop freshness and refresh-plan chained provenance in one artifact", () => {
    withTempRepo((repoRoot) => {
      writeTaskLedger(repoRoot, [
        {
          taskId: "moss-task-0070",
          status: "done",
          owner: "Release Operator",
          title: "Any explicit chain task title",
          metadata: {
            chainedRefreshProvenance: {
              kind: "release-artifact-chain-freshness",
              expected: true,
            },
          },
          acceptance: [],
          evidence: ["release artifact refreshed"],
        },
      ]);
      writeArtifact(
        repoRoot,
        "moss-release-gate-report-artifact-2026-07-02-refresh.json",
        report({
          createdAt: "2026-07-02T00:01:50.000Z",
          expectedTaskId: "moss-task-0070",
          gateIds: currentGateIds(),
          observedEvidence: "mismatched-provenance",
          status: "pass",
        }),
      );

      const index = readMossReleaseGateReportArtifactIndex(repoRoot, {
        generatedAt: "2026-07-02T00:02:00.000Z",
      });

      expect(index.latest?.chainedObservedEvidence?.loopPacketFreshnessReport).toMatchObject({
        latestTaskId: "moss-task-0071",
        chainedRefreshTaskId: "moss-task-0071",
      });
      expect(index.latest?.chainedObservedEvidence?.loopPacketRefreshPlanReport).toMatchObject({
        latestTaskId: "moss-task-0070",
        chainedRefreshTaskId: "moss-task-0070",
      });
      expect(index.issues).toEqual([
        expect.objectContaining({
          code: "stale-artifact",
          path: ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-02-refresh.json",
          message: expect.stringContaining(
            "has inconsistent chained provenance between loop packet freshness report and loop packet refresh-plan report",
          ),
        }),
      ]);
      expect(index.issues[0]?.message).toContain(
        "latestTaskId moss-task-0071 does not match moss-task-0070",
      );
      expect(index.issues[0]?.message).toContain(
        "chainedRefreshTaskId moss-task-0071 does not match moss-task-0070",
      );
      expect(index.readiness.status).toBe("fail");
      expect(mossReleaseGateReportArtifactIndexExitCode(index)).toBe(1);
    });
  });

  it("ignores old title substring matching when explicit chained provenance is absent", () => {
    withTempRepo((repoRoot) => {
      writeTaskLedger(repoRoot, [
        {
          taskId: "moss-task-0070",
          status: "done",
          owner: "Release Operator",
          title: "Refresh release gate artifact after loop refresh plan chain",
          acceptance: [],
          evidence: ["release artifact refreshed"],
        },
      ]);
      writeArtifact(
        repoRoot,
        "moss-release-gate-report-artifact-2026-07-02-refresh.json",
        report({
          createdAt: "2026-07-02T00:01:50.000Z",
          expectedTaskId: "moss-task-0068",
          gateIds: currentGateIds(),
          status: "pass",
        }),
      );

      const index = readMossReleaseGateReportArtifactIndex(repoRoot, {
        generatedAt: "2026-07-02T00:02:00.000Z",
      });

      expect(index.expectedChainedRefreshProvenance).toBeUndefined();
      expect(index.issues).toEqual([]);
      expect(index.readiness.status).toBe("pass");
      expect(mossReleaseGateReportArtifactIndexExitCode(index)).toBe(0);
    });
  });

  it("uses moss-task-0071 style task metadata as the expected chained refresh task", () => {
    withTempRepo((repoRoot) => {
      writeTaskLedger(repoRoot, [
        {
          taskId: "moss-task-0071",
          status: "active",
          owner: "QA Gatekeeper",
          title: "Gate release artifact freshness after chained refresh reports",
          metadata: {
            chainedRefreshProvenance: {
              kind: "release-artifact-chain-freshness",
              expected: true,
            },
          },
          acceptance: [],
          evidence: [],
        },
      ]);
      writeArtifact(
        repoRoot,
        "moss-release-gate-report-artifact-2026-07-02-refresh.json",
        report({
          createdAt: "2026-07-02T00:01:50.000Z",
          expectedTaskId: "moss-task-0071",
          gateIds: currentGateIds(),
          observedEvidence: "stale-task",
          status: "pass",
        }),
      );

      const index = readMossReleaseGateReportArtifactIndex(repoRoot, {
        generatedAt: "2026-07-02T00:02:00.000Z",
      });

      expect(index.expectedChainedRefreshProvenance).toMatchObject({
        taskId: "moss-task-0071",
        source: "task-ledger-metadata",
      });
      expect(index.issues).toEqual([
        expect.objectContaining({
          code: "stale-artifact",
          path: ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-02-refresh.json",
          message: expect.stringContaining(
            "chainedRefreshTaskId moss-task-0068 is older than expected moss-task-0071",
          ),
        }),
      ]);
      expect(index.readiness.status).toBe("fail");
      expect(mossReleaseGateReportArtifactIndexExitCode(index)).toBe(1);
    });
  });

  it("reports missing artifacts as a deterministic readiness issue", () => {
    withTempRepo((repoRoot) => {
      const index = readMossReleaseGateReportArtifactIndex(repoRoot, {
        generatedAt: "2026-07-01T01:00:00.000Z",
      });

      expect(index.latest).toBeNull();
      expect(index.issues).toEqual([
        {
          code: "missing-artifacts",
          severity: "error",
          path: ".moss/ledger/evidence",
          message: "No Moss release gate report artifact JSON files were found.",
        },
      ]);
      expect(index.readiness.status).toBe("fail");
      expect(mossReleaseGateReportArtifactIndexExitCode(index)).toBe(1);
    });
  });

  it("reports malformed, invalid, and failing artifacts as deterministic readiness issues", () => {
    withTempRepo((repoRoot) => {
      writeArtifact(repoRoot, "moss-release-gate-report-artifact-malformed.json", "{not json");
      writeArtifact(repoRoot, "moss-release-gate-report-artifact-invalid.json", {
        version: 2,
        createdAt: "2026-07-01T00:00:00.000Z",
        status: "pass",
        gates: [],
      });
      writeArtifact(
        repoRoot,
        "moss-release-gate-report-artifact-fail.json",
        report({
          createdAt: "2026-07-01T00:00:00.000Z",
          failedGateId: "lint",
          gateIds: currentGateIds(),
          status: "fail",
        }),
      );

      const index = readMossReleaseGateReportArtifactIndex(repoRoot, {
        generatedAt: "2026-07-01T01:00:00.000Z",
      });

      expect(index.latest).toMatchObject({
        path: ".moss/ledger/evidence/moss-release-gate-report-artifact-fail.json",
        status: "fail",
        failedGateId: "lint",
      });
      expect(index.issues.map((issue) => issue.code)).toEqual([
        "failing-artifact",
        "invalid-artifact",
        "malformed-artifact",
      ]);
      expect(index.readiness).toEqual({
        status: "fail",
        summary: "Moss release gate artifact index has 3 issue(s).",
      });
      expect(mossReleaseGateReportArtifactIndexExitCode(index)).toBe(1);
    });
  });
});
