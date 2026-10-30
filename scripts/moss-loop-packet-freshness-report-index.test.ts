import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  mossLoopPacketFreshnessGateReportIndexExitCode,
  readMossLoopPacketFreshnessGateReportIndex,
} from "./moss-loop-packet-freshness-report-index.ts";
import { buildMossReleaseGateManifest } from "./lib/moss-release-gate-manifest.ts";

function withTempRepo<T>(callback: (repoRoot: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "moss-loop-packet-freshness-report-index-"));
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

function writeExpectedChainedTaskMetadata(repoRoot: string, taskId: string): void {
  const ledgerDirectory = join(repoRoot, ".moss", "ledger");
  mkdirSync(ledgerDirectory, { recursive: true });
  writeFileSync(
    join(ledgerDirectory, "tasks.jsonl"),
    `${JSON.stringify({
      taskId,
      status: "active",
      owner: "Architect",
      title: "Make chained refresh task provenance explicit",
      metadata: {
        chainedRefreshProvenance: {
          kind: "release-artifact-chain-freshness",
          expected: true,
        },
      },
      evidence: [],
    })}\n`,
  );
  writeFileSync(join(ledgerDirectory, "events.jsonl"), "");
}

function currentGateIds(): ReadonlyArray<string> {
  return buildMossReleaseGateManifest({
    createdAt: "2026-07-02T00:00:00.000Z",
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
      const gate: Record<string, unknown> = {
        id: gateId,
        status: "pass",
        exitCode: 0,
      };
      const latestTaskId = input.latestTaskId ?? "moss-task-0071";

      if (gateId === "release-freshness-refresh-plan-report-index") {
        gate.observedEvidence = {
          releaseFreshnessRefreshPlanReportIndex: {
            readinessStatus: "pass",
            latestArtifactCreatedAt: input.createdAt,
            issueCodes: [],
          },
        };
      }
      if (gateId === "loop-packet-freshness-report-index") {
        gate.observedEvidence = {
          loopPacketFreshnessReportIndex: {
            readinessStatus: "pass",
            latestArtifactCreatedAt: input.createdAt,
            latestTaskId,
            issueCodes: [],
          },
        };
      }
      if (gateId === "loop-packet-refresh-plan-report-index") {
        gate.observedEvidence = {
          loopPacketRefreshPlanReportIndex: {
            readinessStatus: "pass",
            latestArtifactCreatedAt: input.createdAt,
            latestTaskId,
            issueCodes: [],
          },
        };
      }

      return gate;
    }),
  });
}

function report(input: {
  readonly createdAt: string;
  readonly status?: "pass" | "fail" | undefined;
  readonly checkStatus?: "pass" | "pending" | "fail" | undefined;
  readonly releaseGateArtifactPath?: string | undefined;
  readonly releaseGateCount?: number | undefined;
}): Record<string, unknown> {
  const status = input.status ?? "pass";
  const checkStatus = input.checkStatus ?? status;
  const releaseGateArtifactPath =
    input.releaseGateArtifactPath ??
    ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-02.json";
  const releaseGateCount = input.releaseGateCount ?? currentGateIds().length;

  return {
    version: 1,
    createdAt: input.createdAt,
    status,
    rawSource: "raw provider event should not be copied into the index",
    stdout: "child command output should not be copied into the index",
    task: {
      taskId: "moss-task-0058",
      title: "Persist loop packet freshness gate report evidence",
      owner: "Release Operator",
      status: "active",
    },
    chainedRefreshProvenance: {
      kind: "release-artifact-chain-freshness",
      expected: true,
      taskId: "moss-task-0058",
      source: "loop-packet-task-metadata",
    },
    check: {
      id: "loop-ledger-release-freshness",
      status: checkStatus,
      summary: `Loop Ledger Dashboard release freshness passed with ${releaseGateCount}/${releaseGateCount} gate(s).`,
      exitCode: checkStatus === "pass" ? 0 : 1,
    },
    loopPacketReadiness: {
      status: "pending",
      summary: "Loop packet aggregate gate is generated with pending review or evidence.",
    },
    releaseFreshness: {
      status: "pass",
      readinessStatus: "pass",
      summary: `Latest Moss release gate artifact is pass: ${releaseGateArtifactPath}.`,
      manifestGateCount: releaseGateCount,
      latestArtifactGateCount: releaseGateCount,
      artifactPath: releaseGateArtifactPath,
      issueCount: 0,
      issueCodes: [],
      staleArtifactMessages: [],
    },
    source: {
      loopPacketGeneratedAt: input.createdAt,
      dashboardSnapshotGeneratedAt: input.createdAt,
      releaseGateArtifactPath,
    },
    providerCredentialsRequired: false,
    writesGlobalConfig: false,
  };
}

describe("moss-loop-packet-freshness-report-index", () => {
  it("summarizes the latest passing compact report without copying raw output fields", () => {
    withTempRepo((repoRoot) => {
      writeReleaseGateReportArtifact({
        repoRoot,
        name: "moss-release-gate-report-artifact-2026-07-02.json",
        createdAt: "2026-07-02T00:00:00.000Z",
      });
      writeArtifact(
        repoRoot,
        "moss-loop-packet-freshness-gate-report-2026-07-01.json",
        report({ createdAt: "2026-07-01T00:00:00.000Z" }),
      );
      writeArtifact(
        repoRoot,
        "moss-loop-packet-freshness-gate-report-2026-07-02.json",
        report({ createdAt: "2026-07-02T00:00:00.000Z" }),
      );

      const index = readMossLoopPacketFreshnessGateReportIndex(repoRoot, {
        generatedAt: "2026-07-02T01:00:00.000Z",
      });

      expect(index).toMatchObject({
        version: 1,
        generatedAt: "2026-07-02T01:00:00.000Z",
        latest: {
          path: ".moss/ledger/evidence/moss-loop-packet-freshness-gate-report-2026-07-02.json",
          createdAt: "2026-07-02T00:00:00.000Z",
          status: "pass",
          taskId: "moss-task-0058",
          chainedRefreshProvenance: {
            kind: "release-artifact-chain-freshness",
            taskId: "moss-task-0058",
            source: "loop-packet-task-metadata",
          },
          checkStatus: "pass",
          loopPacketReadinessStatus: "pending",
          releaseFreshness: {
            readinessStatus: "pass",
            manifestGateCount: currentGateIds().length,
            latestArtifactGateCount: currentGateIds().length,
            releaseGateArtifactPath:
              ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-02.json",
            issueCount: 0,
          },
        },
        readiness: {
          status: "pass",
        },
      });
      expect(index.artifacts.map((artifact) => artifact.path)).toEqual([
        ".moss/ledger/evidence/moss-loop-packet-freshness-gate-report-2026-07-02.json",
        ".moss/ledger/evidence/moss-loop-packet-freshness-gate-report-2026-07-01.json",
      ]);
      expect(index.issues).toEqual([]);
      expect(mossLoopPacketFreshnessGateReportIndexExitCode(index)).toBe(0);
      expect(JSON.stringify(index)).not.toContain("rawSource");
      expect(JSON.stringify(index)).not.toContain("stdout");
    });
  });

  it("allows explicit chained provenance bootstrap while indexing the newest freshness report", () => {
    withTempRepo((repoRoot) => {
      writeExpectedChainedTaskMetadata(repoRoot, "moss-task-0072");
      writeReleaseGateReportArtifact({
        repoRoot,
        name: "moss-release-gate-report-artifact-2026-07-02.json",
        createdAt: "2026-07-02T00:02:00.000Z",
        latestTaskId: "moss-task-0071",
      });
      writeArtifact(repoRoot, "moss-loop-packet-freshness-gate-report-2026-07-02-refresh.json", {
        ...report({
          createdAt: "2026-07-02T00:02:10.000Z",
          releaseGateArtifactPath:
            ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-02.json",
        }),
        task: {
          taskId: "moss-task-0072",
          title: "Make chained refresh task provenance explicit",
          owner: "Architect",
          status: "active",
        },
        chainedRefreshProvenance: {
          kind: "release-artifact-chain-freshness",
          expected: true,
          taskId: "moss-task-0072",
          source: "loop-packet-task-metadata",
        },
      });

      const index = readMossLoopPacketFreshnessGateReportIndex(repoRoot, {
        generatedAt: "2026-07-02T00:02:10.000Z",
      });

      expect(index.readiness.status).toBe("pass");
      expect(index.latest).toMatchObject({
        taskId: "moss-task-0072",
        chainedRefreshProvenance: {
          taskId: "moss-task-0072",
        },
      });
      expect(index.issues).toEqual([]);
    });
  });

  it("fails a stale latest report that still points at the pre-refresh release artifact", () => {
    withTempRepo((repoRoot) => {
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
      writeArtifact(
        repoRoot,
        "moss-loop-packet-freshness-gate-report-2026-07-02.json",
        report({
          createdAt: "2026-07-02T00:00:00.000Z",
          releaseGateArtifactPath:
            ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-02.json",
          releaseGateCount: staleGateIds.length,
        }),
      );

      const index = readMossLoopPacketFreshnessGateReportIndex(repoRoot, {
        generatedAt: "2026-07-02T00:00:55.000Z",
      });

      expect(index.latest).toMatchObject({
        path: ".moss/ledger/evidence/moss-loop-packet-freshness-gate-report-2026-07-02.json",
        status: "pass",
        releaseFreshness: {
          releaseGateArtifactPath:
            ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-02.json",
          manifestGateCount: staleGateIds.length,
          latestArtifactGateCount: staleGateIds.length,
        },
      });
      expect(index.issues).toEqual([
        {
          code: "stale-release-freshness",
          severity: "error",
          path: ".moss/ledger/evidence/moss-loop-packet-freshness-gate-report-2026-07-02.json",
          message: `.moss/ledger/evidence/moss-loop-packet-freshness-gate-report-2026-07-02.json is stale against the current Moss release gate artifact: embedded release artifact path .moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-02.json does not match latest .moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-02-refresh.json; embedded manifest gate count ${staleGateIds.length} does not match current manifest ${currentGateIds().length}; embedded latest artifact gate count ${staleGateIds.length} does not match latest ${currentGateIds().length}.`,
        },
      ]);
      expect(index.readiness.status).toBe("fail");
      expect(mossLoopPacketFreshnessGateReportIndexExitCode(index)).toBe(1);
    });
  });

  it("selects the refreshed current-gate report as latest after release artifact refresh", () => {
    withTempRepo((repoRoot) => {
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
      writeArtifact(
        repoRoot,
        "moss-loop-packet-freshness-gate-report-2026-07-02.json",
        report({
          createdAt: "2026-07-02T00:00:00.000Z",
          releaseGateArtifactPath:
            ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-02.json",
          releaseGateCount: staleGateIds.length,
        }),
      );
      writeArtifact(
        repoRoot,
        "moss-loop-packet-freshness-gate-report-2026-07-02-refresh.json",
        report({
          createdAt: "2026-07-02T00:00:50.000Z",
          releaseGateArtifactPath:
            ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-02-refresh.json",
        }),
      );

      const index = readMossLoopPacketFreshnessGateReportIndex(repoRoot, {
        generatedAt: "2026-07-02T00:00:55.000Z",
      });

      expect(index.latest).toMatchObject({
        path: ".moss/ledger/evidence/moss-loop-packet-freshness-gate-report-2026-07-02-refresh.json",
        createdAt: "2026-07-02T00:00:50.000Z",
        status: "pass",
        releaseFreshness: {
          readinessStatus: "pass",
          manifestGateCount: currentGateIds().length,
          latestArtifactGateCount: currentGateIds().length,
          releaseGateArtifactPath:
            ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-02-refresh.json",
          issueCount: 0,
        },
      });
      expect(index.issues).toEqual([]);
      expect(index.readiness.status).toBe("pass");
      expect(mossLoopPacketFreshnessGateReportIndexExitCode(index)).toBe(0);
    });
  });

  it("reports missing artifacts as a deterministic readiness issue", () => {
    withTempRepo((repoRoot) => {
      const index = readMossLoopPacketFreshnessGateReportIndex(repoRoot, {
        generatedAt: "2026-07-02T01:00:00.000Z",
      });

      expect(index.latest).toBeNull();
      expect(index.issues).toEqual([
        {
          code: "missing-artifacts",
          severity: "error",
          path: ".moss/ledger/evidence",
          message: "No Moss loop packet freshness gate report JSON files were found.",
        },
      ]);
      expect(index.readiness.status).toBe("fail");
      expect(mossLoopPacketFreshnessGateReportIndexExitCode(index)).toBe(1);
    });
  });

  it("reports invalid and failing artifacts in machine-readable form", () => {
    withTempRepo((repoRoot) => {
      writeArtifact(repoRoot, "moss-loop-packet-freshness-gate-report-malformed.json", "{bad");
      writeArtifact(repoRoot, "moss-loop-packet-freshness-gate-report-invalid.json", {
        version: 2,
        createdAt: "2026-07-02T00:00:00.000Z",
        status: "pass",
      });
      writeArtifact(
        repoRoot,
        "moss-loop-packet-freshness-gate-report-fail.json",
        report({
          createdAt: "2026-07-02T00:00:00.000Z",
          status: "fail",
          checkStatus: "fail",
        }),
      );

      const index = readMossLoopPacketFreshnessGateReportIndex(repoRoot, {
        generatedAt: "2026-07-02T01:00:00.000Z",
      });

      expect(index.latest).toMatchObject({
        path: ".moss/ledger/evidence/moss-loop-packet-freshness-gate-report-fail.json",
        status: "fail",
      });
      expect(index.issues.map((issue) => issue.code)).toEqual([
        "failing-artifact",
        "invalid-artifact",
        "malformed-artifact",
      ]);
      expect(index.readiness).toEqual({
        status: "fail",
        summary: "Moss loop packet freshness gate report index has 3 issue(s).",
      });
      expect(mossLoopPacketFreshnessGateReportIndexExitCode(index)).toBe(1);
    });
  });
});
