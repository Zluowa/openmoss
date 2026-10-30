import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildMossReleaseGateManifest,
  mossReleaseGateReportExitCode,
  resolveMossReleaseGateReportOutputPath,
  runMossReleaseGateCommands,
  runMossReleaseGateRefreshReport,
  runMossReleaseGateReport,
  type MossReleaseGateCommand,
  type MossReleaseGateSpawn,
  writeMossReleaseGateReportArtifact,
} from "./moss-release-gate.ts";
import { MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER } from "./lib/moss-release-freshness-refresh-plan-constants.ts";
import { readMossReleaseGateReportArtifactIndex } from "./moss-release-gate-report-index.ts";

const spawnReleaseGateError: MossReleaseGateSpawn = () => ({
  status: null,
  error: new Error("spawn failed"),
  stderr: "rawSource should stay out",
});

const CURRENT_RELEASE_GATE_IDS = [
  "ledger-status",
  "provider-fixture-replay",
  "provider-discovery-smoke",
  "control-plane-ui-smoke",
  "electron-product-shell-smoke",
  "codex-desktop-layout-gate",
  "release-freshness-refresh-plan-report-index",
  "loop-packet-freshness-report-index",
  "loop-packet-refresh-plan-report-index",
  "loop-packet",
  "release-gate-report-index",
  "format-check",
  "full-typecheck",
  "lint",
  "diff-hygiene",
] as const;

function withTempRepo<T>(callback: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "moss-release-gate-"));
  try {
    return callback(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function releaseGateReportIndexStdout(input: {
  readonly readinessStatus: "pass" | "fail";
  readonly latestGateIds: ReadonlyArray<string>;
  readonly issueCodes?: ReadonlyArray<string> | undefined;
}): string {
  const currentGateIds: ReadonlyArray<string> = CURRENT_RELEASE_GATE_IDS;
  const missingGateIds = CURRENT_RELEASE_GATE_IDS.filter(
    (gateId) => !input.latestGateIds.includes(gateId),
  );
  const unexpectedGateIds = input.latestGateIds.filter(
    (gateId) => !currentGateIds.includes(gateId),
  );
  const issues = (input.issueCodes ?? []).map((code) => ({
    code,
    severity: "error",
    path: ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-01.json",
    message:
      code === "stale-artifact"
        ? `.moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-01.json is stale against current release gate manifest: expected ${CURRENT_RELEASE_GATE_IDS.length} gate(s), found ${input.latestGateIds.length} gate(s), missing [${missingGateIds.join(", ")}], unexpected [${unexpectedGateIds.join(", ")}].`
        : `${code} issue`,
  }));

  return `$ node scripts/moss-release-gate-report-index.ts --created-at 2026-07-01T00:00:00.000Z
${JSON.stringify(
  {
    version: 1,
    generatedAt: "2026-07-01T00:00:00.000Z",
    sourceDirectory: ".moss/ledger/evidence",
    manifest: {
      gateCount: CURRENT_RELEASE_GATE_IDS.length,
      gateIds: CURRENT_RELEASE_GATE_IDS,
    },
    latest: {
      path: ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-01.json",
      createdAt: "2026-07-01T00:00:00.000Z",
      status: "pass",
      gateCount: input.latestGateIds.length,
      gateIds: input.latestGateIds,
    },
    artifacts: [],
    issues,
    readiness: {
      status: input.readinessStatus,
      summary: input.readinessStatus === "pass" ? "pass" : "fail",
    },
  },
  null,
  2,
)}
`;
}

function electronProductShellSmokeGateStdout(input: {
  readonly readinessStatus: "pass" | "fail";
  readonly issueCodes?: ReadonlyArray<string> | undefined;
}): string {
  const issueCodes = input.issueCodes ?? [];
  return `$ node scripts/moss-electron-product-shell-smoke-gate.ts --created-at 2026-07-01T00:00:00.000Z
${JSON.stringify(
  {
    version: 1,
    generatedAt: "2026-07-01T00:00:00.000Z",
    reportPath: ".moss/ledger/evidence/moss-electron-product-shell-smoke-2026-07-01.json",
    screenshotPath: ".moss/ledger/evidence/moss-electron-product-shell-smoke-2026-07-01.png",
    report: {
      createdAt: "2026-07-01T00:00:00.000Z",
      route: "moss://app/index.html#/thread-moss-served-smoke?mossShell=1",
      desktopRuntime: "electron",
      backendMode: "real-node",
      assertionCount: 21,
      runtimeDataset: "electron",
      hasDesktopBridge: true,
      hasNativeApi: true,
      backendHealthStatus: 200,
      backendProcessPresent: true,
    },
    screenshot: {
      path: ".moss/ledger/evidence/moss-electron-product-shell-smoke-2026-07-01.png",
      bytes: 12345,
    },
    issues: issueCodes.map((code) => ({
      code,
      severity: "error",
      path: ".moss/ledger/evidence/moss-electron-product-shell-smoke-2026-07-01.json",
      message: `${code} issue`,
    })),
    readiness: {
      status: input.readinessStatus,
      summary: input.readinessStatus === "pass" ? "pass" : "fail",
    },
  },
  null,
  2,
)}
`;
}

function providerDiscoverySmokeGateStdout(input: {
  readonly readinessStatus: "pass" | "fail";
  readonly issueCodes?: ReadonlyArray<string> | undefined;
}): string {
  const issueCodes = input.issueCodes ?? [];
  return `$ node scripts/moss-provider-discovery-smoke-gate.ts --created-at 2026-07-01T00:00:00.000Z
${JSON.stringify(
  {
    version: 1,
    generatedAt: "2026-07-01T00:00:00.000Z",
    reportPath: ".moss/ledger/evidence/moss-provider-discovery-smoke-2026-07-01.json",
    report: {
      createdAt: "2026-07-01T00:00:00.000Z",
      provider: "codex",
      runtimeBoundary: "ProviderDiscoveryServiceLive",
      providerCredentialsRequired: false,
      writesGlobalConfig: false,
      operationCount: 4,
      adapterInvocationCount: 8,
      readinessStatus: input.readinessStatus,
    },
    operations: [
      {
        id: "getComposerCapabilities",
        status: "pass",
        source: "ProviderDiscoveryServiceLive",
        count: 1,
        items: ["codex"],
        supportsSkillDiscovery: true,
        supportsPluginDiscovery: true,
        supportsRuntimeModelList: true,
      },
      {
        id: "listSkills",
        status: "pass",
        source: "codex-smoke-adapter+moss.catalog",
        count: 2,
        items: ["moss-native-smoke-skill", "moss-portable-smoke-skill"],
      },
      {
        id: "listPlugins",
        status: "pass",
        source: "codex-smoke-adapter",
        count: 1,
        items: ["moss-provider-smoke-plugin"],
      },
      {
        id: "listModels",
        status: "pass",
        source: "codex-smoke-adapter",
        count: 1,
        items: ["moss-smoke-model"],
      },
    ],
    issues: issueCodes.map((code) => ({
      code,
      severity: "error",
      path: ".moss/ledger/evidence/moss-provider-discovery-smoke-2026-07-01.json",
      message: `${code} issue`,
    })),
    readiness: {
      status: input.readinessStatus,
      summary: input.readinessStatus === "pass" ? "pass" : "fail",
    },
  },
  null,
  2,
)}
`;
}

function codexDesktopLayoutGateStdout(input: {
  readonly readinessStatus: "pass" | "fail";
  readonly issueCodes?: ReadonlyArray<string> | undefined;
  readonly layoutGateStatus?: "pass" | "fail" | undefined;
  readonly includeStrictLayoutDetails?: boolean | undefined;
}): string {
  const issueCodes = input.issueCodes ?? [];
  const strictLayoutDetails = input.includeStrictLayoutDetails
    ? {
        deltas: [
          {
            id: "composer-position",
            status: "pass",
            message:
              "topRatioDelta=0.038300 (max 0.040000), bottomGapDeltaPx=2 (max 4), heightDeltaPx=39 (max 40)",
          },
          {
            id: "normalized-event-timeline-density",
            status: "pass",
            message:
              "rowCountDelta=2 (max 2), mossDensityRowsPer1000Px=10.700552 (min 10), densityRowsPer1000PxDelta=8.530217 (max 9)",
          },
        ],
        strictThresholds: {
          maxComposerTopRatioDelta: 0.04,
          maxComposerBottomGapPxDelta: 4,
          maxComposerHeightPxDelta: 40,
          maxSideAccessWidthRatioDelta: 0.01,
          maxMissingControlPlaneAffordances: 0,
          maxNormalizedEventRowCountDelta: 2,
          minMossTimelineDensityRowsPer1000Px: 10,
          maxTimelineDensityRowsPer1000PxDelta: 9,
        },
      }
    : {};
  return `$ node scripts/moss-codex-desktop-layout-gate.ts --created-at 2026-07-01T00:00:00.000Z
${JSON.stringify(
  {
    version: 1,
    generatedAt: "2026-07-01T00:00:00.000Z",
    comparatorPath: ".moss/codex-desktop-comparator.json",
    comparator: {
      updatedAt: "2026-07-01T00:00:00.000Z",
      overallStatus: "partial",
      gateStatus: input.readinessStatus,
      layoutGateStatus: input.layoutGateStatus ?? input.readinessStatus,
      fullCodexParityClaim: false,
      issueCount: issueCodes.length,
      nextGapId: "first-screen-layout",
    },
    layout: {
      codexCapturedAt: "2026-07-01T00:00:00.000Z",
      mossCapturedAt: "2026-07-01T00:00:00.000Z",
      codexEvidence: [".moss/ledger/evidence/codex-desktop-current-shell-2026-07-01.png"],
      mossEvidence: [
        ".moss/ledger/evidence/moss-electron-product-shell-layout-smoke-2026-07-01.png",
        ".moss/ledger/evidence/moss-electron-product-shell-layout-smoke-2026-07-01.json",
      ],
      deltaCount: 4,
      ...strictLayoutDetails,
      failedDeltaIds:
        (input.layoutGateStatus ?? input.readinessStatus) === "pass" ? [] : ["composer-position"],
    },
    issues: issueCodes.map((code) => ({
      code,
      severity: "error",
      path: ".moss/codex-desktop-comparator.json",
      message: `${code} issue`,
    })),
    readiness: {
      status: input.readinessStatus,
      summary: input.readinessStatus === "pass" ? "pass" : "fail",
    },
  },
  null,
  2,
)}
`;
}

function loopPacketFreshnessReportIndexStdout(input: {
  readonly readinessStatus: "pass" | "fail";
  readonly issueCodes?: ReadonlyArray<string> | undefined;
  readonly latestStatus?: "pass" | "fail" | undefined;
  readonly latestTaskId?: string | undefined;
}): string {
  const issueCodes = input.issueCodes ?? [];
  const latestTaskId = input.latestTaskId ?? "moss-task-0058";

  return `$ node scripts/moss-loop-packet-freshness-report-index.ts --created-at 2026-07-01T00:00:00.000Z
${JSON.stringify(
  {
    version: 1,
    generatedAt: "2026-07-01T00:00:00.000Z",
    sourceDirectory: ".moss/ledger/evidence",
    latest: issueCodes.includes("missing-artifacts")
      ? null
      : {
          path: ".moss/ledger/evidence/moss-loop-packet-freshness-gate-report-2026-07-01.json",
          createdAt: "2026-07-01T00:00:00.000Z",
          status: input.latestStatus ?? "pass",
          taskId: latestTaskId,
          taskTitle: "Persist loop packet freshness gate report evidence",
          chainedRefreshProvenance: {
            kind: "release-artifact-chain-freshness",
            expected: true,
            taskId: latestTaskId,
            source: "loop-packet-task-metadata",
          },
          checkStatus: input.readinessStatus === "pass" ? "pass" : "fail",
          checkSummary: `Loop Ledger Dashboard release freshness passed with ${CURRENT_RELEASE_GATE_IDS.length}/${CURRENT_RELEASE_GATE_IDS.length} gate(s).`,
          loopPacketReadinessStatus: input.readinessStatus === "pass" ? "pending" : "blocked",
          releaseFreshness: {
            status: input.readinessStatus === "pass" ? "pass" : "blocked",
            readinessStatus: input.readinessStatus,
            summary:
              input.readinessStatus === "pass"
                ? "Latest Moss release gate artifact is pass."
                : "Moss release gate artifact index has issue(s).",
            manifestGateCount: CURRENT_RELEASE_GATE_IDS.length,
            latestArtifactGateCount: CURRENT_RELEASE_GATE_IDS.length,
            releaseGateArtifactPath:
              ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-01.json",
            issueCount: issueCodes.length,
            issueCodes,
          },
        },
    artifacts: [],
    issues: issueCodes.map((code) => ({
      code,
      severity: "error",
      path: ".moss/ledger/evidence/moss-loop-packet-freshness-gate-report-2026-07-01.json",
      message: `${code} issue`,
    })),
    readiness: {
      status: input.readinessStatus,
      summary: input.readinessStatus === "pass" ? "pass" : "fail",
    },
  },
  null,
  2,
)}
`;
}

function loopPacketRefreshPlanReportIndexStdout(input: {
  readonly readinessStatus: "pass" | "fail";
  readonly issueCodes?: ReadonlyArray<string> | undefined;
  readonly latestStatus?: "pass" | "fail" | undefined;
  readonly latestTaskId?: string | undefined;
}): string {
  const issueCodes = input.issueCodes ?? [];
  const stepCount = MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER.length;
  const latestTaskId = input.latestTaskId ?? "moss-task-0067";

  return `$ node scripts/moss-loop-packet-refresh-plan-report-index.ts --created-at 2026-07-01T00:00:00.000Z
${JSON.stringify(
  {
    version: 1,
    generatedAt: "2026-07-01T00:00:00.000Z",
    sourceDirectory: ".moss/ledger/evidence",
    latest: issueCodes.includes("missing-artifacts")
      ? null
      : {
          path: ".moss/ledger/evidence/moss-loop-packet-refresh-plan-gate-report-2026-07-01.json",
          createdAt: "2026-07-01T00:00:00.000Z",
          status: input.latestStatus ?? "pass",
          taskId: latestTaskId,
          taskTitle: "Persist loop packet refresh plan dashboard gate report evidence",
          chainedRefreshProvenance: {
            kind: "release-artifact-chain-freshness",
            expected: true,
            taskId: latestTaskId,
            source: "loop-packet-task-metadata",
          },
          checkStatus: input.readinessStatus === "pass" ? "pass" : "fail",
          checkSummary: `Loop Ledger Dashboard refresh plan passed with ${stepCount}/${stepCount} step(s).`,
          loopPacketReadinessStatus: "pending",
          writesFiles: false,
          writesGlobalConfig: false,
          providerCredentialsRequired: false,
          refreshPlan: {
            status: input.readinessStatus === "pass" ? "pass" : "blocked",
            readinessStatus: input.readinessStatus,
            summary:
              input.readinessStatus === "pass"
                ? "Latest Moss release freshness refresh plan artifact is pass."
                : "Moss release freshness refresh plan artifact index has issue(s).",
            expectedStepCount: stepCount,
            latestStepCount: stepCount,
            refreshPlanArtifactPath:
              ".moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-02-gate.json",
            latestArtifactStatus: input.readinessStatus === "pass" ? "pass" : "fail",
            mode: "dry-run",
            writesFiles: false,
            writesGlobalConfig: false,
            providerCredentialsRequired: false,
            requiresReleaseArtifactRefresh: false,
            requiresLoopFreshnessRefresh: false,
            issueCount: issueCodes.length,
            issueCodes,
          },
        },
    artifacts: [],
    issues: issueCodes.map((code) => ({
      code,
      severity: "error",
      path: ".moss/ledger/evidence/moss-loop-packet-refresh-plan-gate-report-2026-07-01.json",
      message: `${code} issue`,
    })),
    readiness: {
      status: input.readinessStatus,
      summary: input.readinessStatus === "pass" ? "pass" : "fail",
    },
  },
  null,
  2,
)}
`;
}

function releaseFreshnessRefreshPlanReportIndexStdout(input: {
  readonly readinessStatus: "pass" | "fail";
  readonly issueCodes?: ReadonlyArray<string> | undefined;
  readonly latestStatus?: "pass" | "fail" | undefined;
}): string {
  const issueCodes = input.issueCodes ?? [];

  return `$ node scripts/moss-release-freshness-refresh-plan-report-index.ts --created-at 2026-07-01T00:00:00.000Z
${JSON.stringify(
  {
    version: 1,
    generatedAt: "2026-07-01T00:00:00.000Z",
    sourceDirectory: ".moss/ledger/evidence",
    expectedStepOrder: [...MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER],
    latest: issueCodes.includes("missing-artifacts")
      ? null
      : {
          path: ".moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-02.json",
          createdAt: "2026-07-02T00:01:05.000Z",
          status: input.latestStatus ?? "pass",
          mode: "dry-run",
          writesFiles: false,
          writesGlobalConfig: false,
          providerCredentialsRequired: false,
          readinessStatus: "ready",
          requiresReleaseArtifactRefresh: false,
          requiresLoopFreshnessRefresh: false,
          requiresLoopRefreshPlanReportRefresh: false,
          releaseGateReportArtifactOutput:
            ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-02-refresh.json",
          loopPacketFreshnessReportArtifactOutput:
            ".moss/ledger/evidence/moss-loop-packet-freshness-gate-report-2026-07-02-refresh.json",
          releaseFreshnessRefreshPlanReportArtifactOutput:
            ".moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-02-gate.json",
          loopPacketRefreshPlanReportArtifactOutput:
            ".moss/ledger/evidence/moss-loop-packet-refresh-plan-gate-report-2026-07-02.json",
          stepOrder: [...MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER],
          steps: [],
        },
    artifacts: [],
    issues: issueCodes.map((code) => ({
      code,
      severity: "error",
      path: ".moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-02.json",
      message: `${code} issue`,
    })),
    readiness: {
      status: input.readinessStatus,
      summary: input.readinessStatus === "pass" ? "pass" : "fail",
    },
  },
  null,
  2,
)}
`;
}

function passingChainedReportIndexStdout(call: string): string | undefined {
  if (call.includes("moss:release-freshness-refresh-plan-report-index")) {
    return releaseFreshnessRefreshPlanReportIndexStdout({
      readinessStatus: "pass",
    });
  }
  if (call.includes("moss:loop-packet-freshness-report-index")) {
    return loopPacketFreshnessReportIndexStdout({
      readinessStatus: "pass",
      latestTaskId: "moss-task-0071",
    });
  }
  if (call.includes("moss:loop-packet-refresh-plan-report-index")) {
    return loopPacketRefreshPlanReportIndexStdout({
      readinessStatus: "pass",
      latestTaskId: "moss-task-0071",
    });
  }
  return undefined;
}

function loopPacketStaleReleaseFreshnessStdout(): string {
  return `$ node scripts/moss-loop-packet.ts --created-at 2026-07-01T00:00:00.000Z
${JSON.stringify(
  {
    version: 1,
    generatedAt: "2026-07-01T00:00:00.000Z",
    checks: [
      {
        id: "iteration-packet",
        status: "pass",
        summary: "iteration-packet passed.",
        exitCode: 0,
      },
      {
        id: "loop-ledger-release-freshness",
        status: "fail",
        summary: `Loop Ledger Dashboard release freshness is not pass: readiness=fail, manifestGates=${CURRENT_RELEASE_GATE_IDS.length}, latestGates=${CURRENT_RELEASE_GATE_IDS.length - 1}, issues=1, issueCodes=stale-artifact.`,
        exitCode: 1,
      },
    ],
    issues: [
      {
        code: "loop-ledger-release-freshness-blocked",
        severity: "error",
        message: `Loop Ledger Dashboard release freshness is not pass: readiness=fail, manifestGates=${CURRENT_RELEASE_GATE_IDS.length}, latestGates=${CURRENT_RELEASE_GATE_IDS.length - 1}, issues=1, issueCodes=stale-artifact.`,
      },
    ],
    readiness: {
      status: "blocked",
      summary: "Loop packet aggregate gate has blocking packet errors.",
    },
    packets: {
      loopLedgerDashboard: {
        generatedAt: "2026-07-01T00:00:00.000Z",
        releaseGate: {
          status: "blocked",
          freshness: {
            status: "blocked",
            readinessStatus: "fail",
            summary: "Moss release gate artifact index has 1 issue(s).",
            manifestGateCount: CURRENT_RELEASE_GATE_IDS.length,
            latestArtifactGateCount: CURRENT_RELEASE_GATE_IDS.length - 1,
            artifactPath: ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-01.json",
            latestArtifactStatus: "pass",
            issueCount: 1,
            issueCodes: ["stale-artifact"],
            staleArtifactMessages: [
              `expected ${CURRENT_RELEASE_GATE_IDS.length} gate(s), found ${CURRENT_RELEASE_GATE_IDS.length - 1} gate(s), missing [loop-packet-freshness-report-index]`,
            ],
          },
        },
      },
    },
  },
  null,
  2,
)}
`;
}

function loopPacketPartialRefreshArtifactStdout(): string {
  return `$ node scripts/moss-loop-packet.ts --created-at 2026-07-01T00:00:00.000Z
${JSON.stringify(
  {
    version: 1,
    generatedAt: "2026-07-01T00:00:00.000Z",
    checks: [
      {
        id: "loop-ledger-release-freshness",
        status: "fail",
        summary: `Loop Ledger Dashboard release freshness is not pass: readiness=fail, manifestGates=${CURRENT_RELEASE_GATE_IDS.length}, latestGates=${CURRENT_RELEASE_GATE_IDS.length - 5}, issues=2, issueCodes=failing-artifact, stale-artifact.`,
        exitCode: 1,
      },
    ],
    readiness: {
      status: "blocked",
      summary: "Loop packet aggregate gate has blocking packet errors.",
    },
    packets: {
      loopLedgerDashboard: {
        generatedAt: "2026-07-01T00:00:00.000Z",
        releaseGate: {
          status: "blocked",
          freshness: {
            status: "blocked",
            readinessStatus: "fail",
            summary: "Moss release gate artifact index has 2 issue(s).",
            manifestGateCount: CURRENT_RELEASE_GATE_IDS.length,
            latestArtifactGateCount: CURRENT_RELEASE_GATE_IDS.length - 5,
            artifactPath:
              ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-01-refresh.json",
            latestArtifactStatus: "fail",
            issueCount: 2,
            issueCodes: ["failing-artifact", "stale-artifact"],
            staleArtifactMessages: [
              `expected ${CURRENT_RELEASE_GATE_IDS.length} gate(s), found ${CURRENT_RELEASE_GATE_IDS.length - 5} gate(s)`,
            ],
          },
        },
      },
    },
  },
  null,
  2,
)}
`;
}

const spawnLoopPacketNonStaleFailure: MossReleaseGateSpawn = (command, args) => {
  const call = [command, ...args].join(" ");
  if (call.includes("moss:loop-packet --")) {
    return {
      status: 1,
      stdout: JSON.stringify({
        readiness: { status: "blocked" },
        checks: [
          {
            id: "memory-packet",
            status: "fail",
            summary: "memory-packet has blocking errors.",
            exitCode: 1,
          },
        ],
        packets: {
          loopLedgerDashboard: {
            releaseGate: {
              freshness: {
                readinessStatus: "fail",
                issueCodes: ["missing-artifacts"],
              },
            },
          },
        },
      }),
    };
  }
  return { status: 0 };
};

describe("moss-release-gate", () => {
  it("builds a provider-credential-free release gate command manifest", () => {
    const manifest = buildMossReleaseGateManifest({
      createdAt: "2026-07-01T00:00:00.000Z",
    });

    expect(manifest.version).toBe(1);
    expect(manifest.createdAt).toBe("2026-07-01T00:00:00.000Z");
    expect(manifest.gates.map((gate) => gate.id)).toEqual(CURRENT_RELEASE_GATE_IDS);
    expect(manifest.gates.every((gate) => gate.providerCredentialsRequired === false)).toBe(true);
    expect(manifest.gates.every((gate) => gate.writesGlobalConfig === false)).toBe(true);
    expect(manifest.gates.every((gate) => gate.expectedEvidence.length > 0)).toBe(true);
    // The provider-fixture-replay gate names every currently checked-in runtime
    // fixture; retired providers must not return through release-gate copy.
    const replayGate = manifest.gates.find((gate) => gate.id === "provider-fixture-replay");
    expect(replayGate?.description).toContain("all seven checked-in provider runtime fixtures");
    for (const providerLabel of ["Cursor", "Gemini", "Grok", "Pi"]) {
      expect(replayGate?.description).toContain(providerLabel);
    }
    expect(replayGate?.description).not.toMatch(/Droid|Kilo/u);
    expect(replayGate?.description).not.toContain("Codex, Claude Agent, and OpenCode");
    expect(manifest.gates[2]?.args).toEqual([
      "run",
      "moss:provider-discovery-smoke-gate",
      "--",
      "--created-at",
      "2026-07-01T00:00:00.000Z",
    ]);
    expect(manifest.gates[4]?.args).toEqual([
      "run",
      "moss:electron-product-shell-smoke-gate",
      "--",
      "--created-at",
      "2026-07-01T00:00:00.000Z",
    ]);
    expect(manifest.gates[5]?.args).toEqual([
      "run",
      "moss:codex-desktop-layout-gate",
      "--",
      "--created-at",
      "2026-07-01T00:00:00.000Z",
    ]);
    expect(manifest.gates[6]?.args).toEqual([
      "run",
      "moss:release-freshness-refresh-plan-report-index",
      "--",
      "--created-at",
      "2026-07-01T00:00:00.000Z",
    ]);
    expect(manifest.gates[7]?.args).toEqual([
      "run",
      "moss:loop-packet-freshness-report-index",
      "--",
      "--created-at",
      "2026-07-01T00:00:00.000Z",
    ]);
    expect(manifest.gates[8]?.args).toEqual([
      "run",
      "moss:loop-packet-refresh-plan-report-index",
      "--",
      "--created-at",
      "2026-07-01T00:00:00.000Z",
    ]);
    expect(manifest.gates[9]?.args).toEqual([
      "run",
      "moss:loop-packet",
      "--",
      "--created-at",
      "2026-07-01T00:00:00.000Z",
    ]);
    expect(manifest.gates[10]?.args).toEqual([
      "run",
      "moss:release-gate-report-index",
      "--",
      "--created-at",
      "2026-07-01T00:00:00.000Z",
    ]);
  });

  it("stops on the first failing release gate command", () => {
    const commands: MossReleaseGateCommand[] = [
      {
        id: "ledger-status",
        description: "first command",
        command: "bun",
        args: ["first"],
        expectedEvidence: ["first evidence"],
        providerCredentialsRequired: false,
        writesGlobalConfig: false,
      },
      {
        id: "lint",
        description: "second command",
        command: "bun",
        args: ["second"],
        expectedEvidence: ["second evidence"],
        providerCredentialsRequired: false,
        writesGlobalConfig: false,
      },
    ];
    const calls: string[] = [];
    const spawn: MossReleaseGateSpawn = (_command, args) => {
      calls.push(args.join(" "));
      return { status: calls.length === 1 ? 9 : 0 };
    };

    expect(
      runMossReleaseGateCommands(
        {
          version: 1,
          createdAt: "2026-07-01T00:00:00.000Z",
          gates: commands,
        },
        spawn,
      ),
    ).toBe(9);
    expect(calls).toEqual(["first"]);
  });

  it("returns pass when every release gate command succeeds", () => {
    const calls: string[] = [];
    const spawn: MossReleaseGateSpawn = (command, args) => {
      calls.push([command, ...args].join(" "));
      return { status: 0 };
    };

    expect(
      runMossReleaseGateCommands(
        buildMossReleaseGateManifest({
          createdAt: "2026-07-01T00:00:00.000Z",
        }),
        spawn,
      ),
    ).toBe(0);
    expect(calls).toHaveLength(CURRENT_RELEASE_GATE_IDS.length);
    expect(calls[0]).toBe("bun run moss:status");
    expect(calls.at(-1)).toBe("git diff --check");
  });

  it("builds a compact report without carrying child stdout or provider raw replay noise", () => {
    const calls: string[] = [];
    const stdioModes: string[] = [];
    const timestamps = [
      100, 103, 110, 115, 120, 121, 130, 131, 140, 141, 150, 151, 160, 161, 170, 171, 180, 181, 190,
      191,
    ];
    const spawn: MossReleaseGateSpawn = (command, args, options) => {
      calls.push([command, ...args].join(" "));
      stdioModes.push(options.stdio);
      return {
        status: 0,
        stdout: "rawSource provider replay detail that must stay out of compact report",
      };
    };

    const report = runMossReleaseGateReport(
      buildMossReleaseGateManifest({
        createdAt: "2026-07-01T00:00:00.000Z",
      }),
      spawn,
      () => timestamps.shift() ?? 200,
    );

    expect(report.status).toBe("pass");
    expect(report.failedGateId).toBeUndefined();
    expect(report.gates).toHaveLength(CURRENT_RELEASE_GATE_IDS.length);
    expect(report.gates[0]).toMatchObject({
      id: "ledger-status",
      status: "pass",
      exitCode: 0,
      command: "bun",
      args: ["run", "moss:status"],
      durationMs: 3,
      providerCredentialsRequired: false,
      writesGlobalConfig: false,
    });
    expect(report.gates.every((gate) => gate.expectedEvidence.length > 0)).toBe(true);
    expect(stdioModes).toEqual(
      Array.from({ length: CURRENT_RELEASE_GATE_IDS.length }, () => "pipe"),
    );
    expect(calls.at(-1)).toBe("git diff --check");
    expect(JSON.stringify(report)).not.toContain("rawSource");
    expect(JSON.stringify(report)).not.toContain("provider replay detail");
    expect(mossReleaseGateReportExitCode(report)).toBe(0);
  });

  it("records compact report-index manifest freshness evidence without raw stdout", () => {
    const spawn: MossReleaseGateSpawn = (command, args) => {
      const call = [command, ...args].join(" ");
      return {
        status: 0,
        stdout: call.includes("moss:release-gate-report-index")
          ? releaseGateReportIndexStdout({
              readinessStatus: "pass",
              latestGateIds: CURRENT_RELEASE_GATE_IDS,
            })
          : "rawSource provider replay detail that must stay out of compact report",
      };
    };

    const report = runMossReleaseGateReport(
      buildMossReleaseGateManifest({
        createdAt: "2026-07-01T00:00:00.000Z",
      }),
      spawn,
      () => 100,
    );
    const indexGate = report.gates.find((gate) => gate.id === "release-gate-report-index");

    expect(report.status).toBe("pass");
    expect(indexGate?.observedEvidence?.releaseGateReportIndex).toEqual({
      readinessStatus: "pass",
      manifestGateCount: CURRENT_RELEASE_GATE_IDS.length,
      manifestGateIds: CURRENT_RELEASE_GATE_IDS,
      latestArtifactPath: ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-01.json",
      latestArtifactCreatedAt: "2026-07-01T00:00:00.000Z",
      latestArtifactStatus: "pass",
      latestArtifactGateCount: CURRENT_RELEASE_GATE_IDS.length,
      latestArtifactGateIds: CURRENT_RELEASE_GATE_IDS,
      issueCodes: [],
      staleArtifactMessages: [],
    });
    expect(JSON.stringify(report)).not.toContain("$ node");
    expect(JSON.stringify(report)).not.toContain("rawSource");
    expect(JSON.stringify(report)).not.toContain("provider replay detail");
  });

  it("records compact provider discovery smoke evidence without raw stdout", () => {
    const spawn: MossReleaseGateSpawn = (command, args) => {
      const call = [command, ...args].join(" ");
      return {
        status: 0,
        stdout: call.includes("moss:provider-discovery-smoke-gate")
          ? providerDiscoverySmokeGateStdout({ readinessStatus: "pass" })
          : "rawSource provider replay detail that must stay out of compact report",
      };
    };

    const report = runMossReleaseGateReport(
      buildMossReleaseGateManifest({
        createdAt: "2026-07-01T00:00:00.000Z",
      }),
      spawn,
      () => 100,
    );
    const smokeGate = report.gates.find((gate) => gate.id === "provider-discovery-smoke");

    expect(report.status).toBe("pass");
    expect(smokeGate?.observedEvidence?.providerDiscoverySmoke).toEqual({
      readinessStatus: "pass",
      reportPath: ".moss/ledger/evidence/moss-provider-discovery-smoke-2026-07-01.json",
      reportCreatedAt: "2026-07-01T00:00:00.000Z",
      provider: "codex",
      runtimeBoundary: "ProviderDiscoveryServiceLive",
      providerCredentialsRequired: false,
      writesGlobalConfig: false,
      operationCount: 4,
      adapterInvocationCount: 8,
      operationIds: ["getComposerCapabilities", "listSkills", "listPlugins", "listModels"],
      skillItems: ["moss-native-smoke-skill", "moss-portable-smoke-skill"],
      pluginItems: ["moss-provider-smoke-plugin"],
      modelItems: ["moss-smoke-model"],
      issueCodes: [],
    });
    expect(JSON.stringify(report)).not.toContain("$ node");
    expect(JSON.stringify(report)).not.toContain("rawSource");
    expect(JSON.stringify(report)).not.toContain("provider replay detail");
  });

  it("records compact Electron product-shell smoke evidence without raw stdout", () => {
    const spawn: MossReleaseGateSpawn = (command, args) => {
      const call = [command, ...args].join(" ");
      return {
        status: 0,
        stdout: call.includes("moss:electron-product-shell-smoke-gate")
          ? electronProductShellSmokeGateStdout({ readinessStatus: "pass" })
          : "rawSource provider replay detail that must stay out of compact report",
      };
    };

    const report = runMossReleaseGateReport(
      buildMossReleaseGateManifest({
        createdAt: "2026-07-01T00:00:00.000Z",
      }),
      spawn,
      () => 100,
    );
    const smokeGate = report.gates.find((gate) => gate.id === "electron-product-shell-smoke");

    expect(report.status).toBe("pass");
    expect(smokeGate?.observedEvidence?.electronProductShellSmoke).toEqual({
      readinessStatus: "pass",
      reportPath: ".moss/ledger/evidence/moss-electron-product-shell-smoke-2026-07-01.json",
      screenshotPath: ".moss/ledger/evidence/moss-electron-product-shell-smoke-2026-07-01.png",
      reportCreatedAt: "2026-07-01T00:00:00.000Z",
      route: "moss://app/index.html#/thread-moss-served-smoke?mossShell=1",
      desktopRuntime: "electron",
      backendMode: "real-node",
      assertionCount: 21,
      runtimeDataset: "electron",
      hasDesktopBridge: true,
      hasNativeApi: true,
      backendHealthStatus: 200,
      backendProcessPresent: true,
      screenshotBytes: 12345,
      issueCodes: [],
    });
    expect(JSON.stringify(report)).not.toContain("$ node");
    expect(JSON.stringify(report)).not.toContain("rawSource");
    expect(JSON.stringify(report)).not.toContain("provider replay detail");
  });

  it("records compact Codex Desktop layout gate evidence without raw stdout", () => {
    const spawn: MossReleaseGateSpawn = (command, args) => {
      const call = [command, ...args].join(" ");
      return {
        status: 0,
        stdout: call.includes("moss:codex-desktop-layout-gate")
          ? codexDesktopLayoutGateStdout({
              readinessStatus: "pass",
              includeStrictLayoutDetails: true,
            })
          : "rawSource provider replay detail that must stay out of compact report",
      };
    };

    const report = runMossReleaseGateReport(
      buildMossReleaseGateManifest({
        createdAt: "2026-07-01T00:00:00.000Z",
      }),
      spawn,
      () => 100,
    );
    const layoutGate = report.gates.find((gate) => gate.id === "codex-desktop-layout-gate");

    expect(report.status).toBe("pass");
    expect(layoutGate?.observedEvidence?.codexDesktopLayoutGate).toEqual({
      readinessStatus: "pass",
      comparatorPath: ".moss/codex-desktop-comparator.json",
      comparatorUpdatedAt: "2026-07-01T00:00:00.000Z",
      comparatorGateStatus: "pass",
      layoutGateStatus: "pass",
      issueCount: 0,
      nextGapId: "first-screen-layout",
      codexCapturedAt: "2026-07-01T00:00:00.000Z",
      mossCapturedAt: "2026-07-01T00:00:00.000Z",
      deltaCount: 4,
      failedDeltaIds: [],
      deltaMessages: [
        "composer-position: topRatioDelta=0.038300 (max 0.040000), bottomGapDeltaPx=2 (max 4), heightDeltaPx=39 (max 40)",
        "normalized-event-timeline-density: rowCountDelta=2 (max 2), mossDensityRowsPer1000Px=10.700552 (min 10), densityRowsPer1000PxDelta=8.530217 (max 9)",
      ],
      strictThresholds: {
        maxComposerTopRatioDelta: 0.04,
        maxComposerBottomGapPxDelta: 4,
        maxComposerHeightPxDelta: 40,
        maxSideAccessWidthRatioDelta: 0.01,
        maxMissingControlPlaneAffordances: 0,
        maxNormalizedEventRowCountDelta: 2,
        minMossTimelineDensityRowsPer1000Px: 10,
        maxTimelineDensityRowsPer1000PxDelta: 9,
      },
      issueCodes: [],
    });
    expect(JSON.stringify(report)).not.toContain("$ node");
    expect(JSON.stringify(report)).not.toContain("rawSource");
    expect(JSON.stringify(report)).not.toContain("provider replay detail");
  });

  it("records compact loop-packet freshness report index evidence without raw stdout", () => {
    const spawn: MossReleaseGateSpawn = (command, args) => {
      const call = [command, ...args].join(" ");
      return {
        status: 0,
        stdout: call.includes("moss:loop-packet-freshness-report-index")
          ? loopPacketFreshnessReportIndexStdout({
              readinessStatus: "pass",
            })
          : "rawSource provider replay detail that must stay out of compact report",
      };
    };

    const report = runMossReleaseGateReport(
      buildMossReleaseGateManifest({
        createdAt: "2026-07-01T00:00:00.000Z",
      }),
      spawn,
      () => 100,
    );
    const indexGate = report.gates.find((gate) => gate.id === "loop-packet-freshness-report-index");

    expect(report.status).toBe("pass");
    expect(indexGate?.observedEvidence?.loopPacketFreshnessReportIndex).toEqual({
      readinessStatus: "pass",
      latestArtifactPath:
        ".moss/ledger/evidence/moss-loop-packet-freshness-gate-report-2026-07-01.json",
      latestArtifactCreatedAt: "2026-07-01T00:00:00.000Z",
      latestArtifactStatus: "pass",
      latestTaskId: "moss-task-0058",
      latestChainedRefreshTaskId: "moss-task-0058",
      latestChainedRefreshProvenance: {
        kind: "release-artifact-chain-freshness",
        expected: true,
        taskId: "moss-task-0058",
        source: "loop-packet-task-metadata",
      },
      latestCheckStatus: "pass",
      latestLoopPacketReadinessStatus: "pending",
      releaseFreshnessStatus: "pass",
      releaseFreshnessReadinessStatus: "pass",
      releaseFreshnessIssueCodes: [],
      issueCodes: [],
    });
    expect(JSON.stringify(report)).not.toContain("$ node");
    expect(JSON.stringify(report)).not.toContain("rawSource");
    expect(JSON.stringify(report)).not.toContain("provider replay detail");
  });

  it("records compact loop-packet refresh plan report index evidence without raw stdout", () => {
    const spawn: MossReleaseGateSpawn = (command, args) => {
      const call = [command, ...args].join(" ");
      return {
        status: 0,
        stdout: call.includes("moss:loop-packet-refresh-plan-report-index")
          ? loopPacketRefreshPlanReportIndexStdout({
              readinessStatus: "pass",
            })
          : "rawSource provider replay detail that must stay out of compact report",
      };
    };

    const report = runMossReleaseGateReport(
      buildMossReleaseGateManifest({
        createdAt: "2026-07-01T00:00:00.000Z",
      }),
      spawn,
      () => 100,
    );
    const indexGate = report.gates.find(
      (gate) => gate.id === "loop-packet-refresh-plan-report-index",
    );

    expect(report.status).toBe("pass");
    expect(indexGate?.observedEvidence?.loopPacketRefreshPlanReportIndex).toEqual({
      readinessStatus: "pass",
      latestArtifactPath:
        ".moss/ledger/evidence/moss-loop-packet-refresh-plan-gate-report-2026-07-01.json",
      latestArtifactCreatedAt: "2026-07-01T00:00:00.000Z",
      latestArtifactStatus: "pass",
      latestTaskId: "moss-task-0067",
      latestChainedRefreshTaskId: "moss-task-0067",
      latestChainedRefreshProvenance: {
        kind: "release-artifact-chain-freshness",
        expected: true,
        taskId: "moss-task-0067",
        source: "loop-packet-task-metadata",
      },
      latestCheckStatus: "pass",
      latestLoopPacketReadinessStatus: "pending",
      writesFiles: false,
      writesGlobalConfig: false,
      providerCredentialsRequired: false,
      refreshPlanStatus: "pass",
      refreshPlanReadinessStatus: "pass",
      refreshPlanArtifactPath:
        ".moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-02-gate.json",
      refreshPlanExpectedStepCount: MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER.length,
      refreshPlanLatestStepCount: MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER.length,
      refreshPlanLatestArtifactStatus: "pass",
      refreshPlanMode: "dry-run",
      refreshPlanWritesFiles: false,
      refreshPlanWritesGlobalConfig: false,
      refreshPlanProviderCredentialsRequired: false,
      refreshPlanRequiresReleaseArtifactRefresh: false,
      refreshPlanRequiresLoopFreshnessRefresh: false,
      refreshPlanIssueCodes: [],
      issueCodes: [],
    });
    expect(JSON.stringify(report)).not.toContain("$ node");
    expect(JSON.stringify(report)).not.toContain("rawSource");
    expect(JSON.stringify(report)).not.toContain("provider replay detail");
  });

  it("records compact refresh plan report index evidence without raw stdout", () => {
    const spawn: MossReleaseGateSpawn = (command, args) => {
      const call = [command, ...args].join(" ");
      return {
        status: 0,
        stdout: call.includes("moss:release-freshness-refresh-plan-report-index")
          ? releaseFreshnessRefreshPlanReportIndexStdout({
              readinessStatus: "pass",
            })
          : "rawSource provider replay detail that must stay out of compact report",
      };
    };

    const report = runMossReleaseGateReport(
      buildMossReleaseGateManifest({
        createdAt: "2026-07-01T00:00:00.000Z",
      }),
      spawn,
      () => 100,
    );
    const indexGate = report.gates.find(
      (gate) => gate.id === "release-freshness-refresh-plan-report-index",
    );

    expect(report.status).toBe("pass");
    expect(indexGate?.observedEvidence?.releaseFreshnessRefreshPlanReportIndex).toEqual({
      readinessStatus: "pass",
      latestArtifactPath:
        ".moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-02.json",
      latestArtifactCreatedAt: "2026-07-02T00:01:05.000Z",
      latestArtifactStatus: "pass",
      mode: "dry-run",
      writesFiles: false,
      writesGlobalConfig: false,
      providerCredentialsRequired: false,
      requiresReleaseArtifactRefresh: false,
      requiresLoopFreshnessRefresh: false,
      requiresLoopRefreshPlanReportRefresh: false,
      releaseFreshnessRefreshPlanReportArtifactOutput:
        ".moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-02-gate.json",
      loopPacketRefreshPlanReportArtifactOutput:
        ".moss/ledger/evidence/moss-loop-packet-refresh-plan-gate-report-2026-07-02.json",
      stepOrder: [...MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER],
      issueCodes: [],
    });
    expect(JSON.stringify(report)).not.toContain("$ node");
    expect(JSON.stringify(report)).not.toContain("rawSource");
    expect(JSON.stringify(report)).not.toContain("provider replay detail");
  });

  it("stops compact report execution on the first failing gate", () => {
    const calls: string[] = [];
    const spawn: MossReleaseGateSpawn = (_command, args) => {
      calls.push(args.join(" "));
      return { status: calls.length === 2 ? 12 : 0 };
    };

    const report = runMossReleaseGateReport(
      buildMossReleaseGateManifest({
        createdAt: "2026-07-01T00:00:00.000Z",
      }),
      spawn,
      () => 100,
    );

    expect(report.status).toBe("fail");
    expect(report.failedGateId).toBe("provider-fixture-replay");
    expect(report.gates).toHaveLength(2);
    expect(report.gates[1]).toMatchObject({
      id: "provider-fixture-replay",
      status: "fail",
      exitCode: 12,
    });
    expect(calls).toEqual(["run moss:status", "run moss:provider-replay"]);
    expect(mossReleaseGateReportExitCode(report)).toBe(12);
  });

  it("records stale-artifact evidence when compact report stops at report index freshness", () => {
    const staleGateIds = CURRENT_RELEASE_GATE_IDS.filter(
      (gateId) => gateId !== "release-gate-report-index",
    );
    const calls: string[] = [];
    const spawn: MossReleaseGateSpawn = (command, args) => {
      const call = [command, ...args].join(" ");
      calls.push(call);
      return call.includes("moss:release-gate-report-index")
        ? {
            status: 1,
            stdout: releaseGateReportIndexStdout({
              readinessStatus: "fail",
              latestGateIds: staleGateIds,
              issueCodes: ["stale-artifact"],
            }),
          }
        : { status: 0 };
    };

    const report = runMossReleaseGateReport(
      buildMossReleaseGateManifest({
        createdAt: "2026-07-01T00:00:00.000Z",
      }),
      spawn,
      () => 100,
    );
    const indexGate = report.gates.at(-1);

    expect(report.status).toBe("fail");
    expect(report.failedGateId).toBe("release-gate-report-index");
    expect(report.gates.map((gate) => gate.id)).toEqual([
      "ledger-status",
      "provider-fixture-replay",
      "provider-discovery-smoke",
      "control-plane-ui-smoke",
      "electron-product-shell-smoke",
      "codex-desktop-layout-gate",
      "release-freshness-refresh-plan-report-index",
      "loop-packet-freshness-report-index",
      "loop-packet-refresh-plan-report-index",
      "loop-packet",
      "release-gate-report-index",
    ]);
    expect(report.gates.map((gate) => gate.id)).not.toContain("format-check");
    expect(indexGate?.observedEvidence?.releaseGateReportIndex).toMatchObject({
      readinessStatus: "fail",
      manifestGateCount: CURRENT_RELEASE_GATE_IDS.length,
      latestArtifactGateCount: staleGateIds.length,
      latestArtifactGateIds: staleGateIds,
      issueCodes: ["stale-artifact"],
    });
    expect(indexGate?.observedEvidence?.releaseGateReportIndex?.staleArtifactMessages[0]).toContain(
      "missing [release-gate-report-index]",
    );
    expect(calls.at(-1)).toContain("moss:release-gate-report-index");
    expect(mossReleaseGateReportExitCode(report)).toBe(1);
  });

  it("fails release readiness deterministically when the report artifact index gate fails", () => {
    const manifest = buildMossReleaseGateManifest({
      createdAt: "2026-07-01T00:00:00.000Z",
    });
    const calls: string[] = [];
    const spawn: MossReleaseGateSpawn = (command, args) => {
      const call = [command, ...args].join(" ");
      calls.push(call);
      return call.includes("moss:release-gate-report-index") ? { status: 7 } : { status: 0 };
    };

    const report = runMossReleaseGateReport(manifest, spawn, () => 100);

    expect(report.status).toBe("fail");
    expect(report.failedGateId).toBe("release-gate-report-index");
    expect(report.gates.map((gate) => gate.id)).toEqual([
      "ledger-status",
      "provider-fixture-replay",
      "provider-discovery-smoke",
      "control-plane-ui-smoke",
      "electron-product-shell-smoke",
      "codex-desktop-layout-gate",
      "release-freshness-refresh-plan-report-index",
      "loop-packet-freshness-report-index",
      "loop-packet-refresh-plan-report-index",
      "loop-packet",
      "release-gate-report-index",
    ]);
    expect(report.gates.at(-1)).toMatchObject({
      id: "release-gate-report-index",
      status: "fail",
      exitCode: 7,
    });
    expect(calls.at(-1)).toBe(
      "bun run moss:release-gate-report-index -- --created-at 2026-07-01T00:00:00.000Z",
    );
    expect(mossReleaseGateReportExitCode(report)).toBe(7);
  });

  it.each(["missing-report", "missing-screenshot", "stale-report-date"])(
    "fails release readiness deterministically when Electron product-shell smoke has %s",
    (issueCode) => {
      const manifest = buildMossReleaseGateManifest({
        createdAt: "2026-07-01T00:00:00.000Z",
      });
      const calls: string[] = [];
      const spawn: MossReleaseGateSpawn = (command, args) => {
        const call = [command, ...args].join(" ");
        calls.push(call);
        return call.includes("moss:electron-product-shell-smoke-gate")
          ? {
              status: 1,
              stdout: electronProductShellSmokeGateStdout({
                readinessStatus: "fail",
                issueCodes: [issueCode],
              }),
            }
          : { status: 0 };
      };

      const report = runMossReleaseGateReport(manifest, spawn, () => 100);

      expect(report.status).toBe("fail");
      expect(report.failedGateId).toBe("electron-product-shell-smoke");
      expect(report.gates.map((gate) => gate.id)).toEqual([
        "ledger-status",
        "provider-fixture-replay",
        "provider-discovery-smoke",
        "control-plane-ui-smoke",
        "electron-product-shell-smoke",
      ]);
      expect(report.gates.at(-1)).toMatchObject({
        id: "electron-product-shell-smoke",
        status: "fail",
        exitCode: 1,
        observedEvidence: {
          electronProductShellSmoke: {
            readinessStatus: "fail",
            issueCodes: [issueCode],
          },
        },
      });
      expect(calls.at(-1)).toBe(
        "bun run moss:electron-product-shell-smoke-gate -- --created-at 2026-07-01T00:00:00.000Z",
      );
      expect(mossReleaseGateReportExitCode(report)).toBe(1);
    },
  );

  it.each(["missing-comparator", "stale-layout-evidence", "layout-gate-failed"])(
    "fails release readiness deterministically when Codex Desktop layout gate has %s",
    (issueCode) => {
      const manifest = buildMossReleaseGateManifest({
        createdAt: "2026-07-01T00:00:00.000Z",
      });
      const calls: string[] = [];
      const spawn: MossReleaseGateSpawn = (command, args) => {
        const call = [command, ...args].join(" ");
        calls.push(call);
        return call.includes("moss:codex-desktop-layout-gate")
          ? {
              status: 1,
              stdout: codexDesktopLayoutGateStdout({
                readinessStatus: "fail",
                layoutGateStatus: issueCode === "layout-gate-failed" ? "fail" : "pass",
                issueCodes: [issueCode],
              }),
            }
          : { status: 0 };
      };

      const report = runMossReleaseGateReport(manifest, spawn, () => 100);

      expect(report.status).toBe("fail");
      expect(report.failedGateId).toBe("codex-desktop-layout-gate");
      expect(report.gates.map((gate) => gate.id)).toEqual([
        "ledger-status",
        "provider-fixture-replay",
        "provider-discovery-smoke",
        "control-plane-ui-smoke",
        "electron-product-shell-smoke",
        "codex-desktop-layout-gate",
      ]);
      expect(report.gates.at(-1)).toMatchObject({
        id: "codex-desktop-layout-gate",
        status: "fail",
        exitCode: 1,
        observedEvidence: {
          codexDesktopLayoutGate: {
            readinessStatus: "fail",
            issueCodes: [issueCode],
          },
        },
      });
      expect(calls.at(-1)).toBe(
        "bun run moss:codex-desktop-layout-gate -- --created-at 2026-07-01T00:00:00.000Z",
      );
      expect(mossReleaseGateReportExitCode(report)).toBe(1);
    },
  );

  it("fails release readiness deterministically when the loop-packet freshness report index gate fails", () => {
    const manifest = buildMossReleaseGateManifest({
      createdAt: "2026-07-01T00:00:00.000Z",
    });
    const calls: string[] = [];
    const spawn: MossReleaseGateSpawn = (command, args) => {
      const call = [command, ...args].join(" ");
      calls.push(call);
      return call.includes("moss:loop-packet-freshness-report-index")
        ? {
            status: 1,
            stdout: loopPacketFreshnessReportIndexStdout({
              readinessStatus: "fail",
              issueCodes: ["missing-artifacts"],
            }),
          }
        : { status: 0 };
    };

    const report = runMossReleaseGateReport(manifest, spawn, () => 100);

    expect(report.status).toBe("fail");
    expect(report.failedGateId).toBe("loop-packet-freshness-report-index");
    expect(report.gates.map((gate) => gate.id)).toEqual([
      "ledger-status",
      "provider-fixture-replay",
      "provider-discovery-smoke",
      "control-plane-ui-smoke",
      "electron-product-shell-smoke",
      "codex-desktop-layout-gate",
      "release-freshness-refresh-plan-report-index",
      "loop-packet-freshness-report-index",
    ]);
    expect(report.gates.at(-1)).toMatchObject({
      id: "loop-packet-freshness-report-index",
      status: "fail",
      exitCode: 1,
      observedEvidence: {
        loopPacketFreshnessReportIndex: {
          readinessStatus: "fail",
          issueCodes: ["missing-artifacts"],
        },
      },
    });
    expect(calls.at(-1)).toBe(
      "bun run moss:loop-packet-freshness-report-index -- --created-at 2026-07-01T00:00:00.000Z",
    );
    expect(mossReleaseGateReportExitCode(report)).toBe(1);
  });

  it.each([
    "missing-artifacts",
    "malformed-artifact",
    "invalid-artifact",
    "failing-artifact",
    "stale-refresh-plan",
    "unsafe-write-flags",
  ])(
    "fails release readiness deterministically when the loop-packet refresh plan report index has %s",
    (issueCode) => {
      const manifest = buildMossReleaseGateManifest({
        createdAt: "2026-07-01T00:00:00.000Z",
      });
      const calls: string[] = [];
      const spawn: MossReleaseGateSpawn = (command, args) => {
        const call = [command, ...args].join(" ");
        calls.push(call);
        return call.includes("moss:loop-packet-refresh-plan-report-index")
          ? {
              status: 1,
              stdout: loopPacketRefreshPlanReportIndexStdout({
                readinessStatus: "fail",
                issueCodes: [issueCode],
                latestStatus: issueCode === "failing-artifact" ? "fail" : "pass",
              }),
            }
          : { status: 0 };
      };

      const report = runMossReleaseGateReport(manifest, spawn, () => 100);

      expect(report.status).toBe("fail");
      expect(report.failedGateId).toBe("loop-packet-refresh-plan-report-index");
      expect(report.gates.map((gate) => gate.id)).toEqual([
        "ledger-status",
        "provider-fixture-replay",
        "provider-discovery-smoke",
        "control-plane-ui-smoke",
        "electron-product-shell-smoke",
        "codex-desktop-layout-gate",
        "release-freshness-refresh-plan-report-index",
        "loop-packet-freshness-report-index",
        "loop-packet-refresh-plan-report-index",
      ]);
      expect(report.gates.at(-1)).toMatchObject({
        id: "loop-packet-refresh-plan-report-index",
        status: "fail",
        exitCode: 1,
        observedEvidence: {
          loopPacketRefreshPlanReportIndex: {
            readinessStatus: "fail",
            issueCodes: [issueCode],
          },
        },
      });
      expect(calls.at(-1)).toBe(
        "bun run moss:loop-packet-refresh-plan-report-index -- --created-at 2026-07-01T00:00:00.000Z",
      );
      expect(mossReleaseGateReportExitCode(report)).toBe(1);
    },
  );

  it.each([
    "missing-artifacts",
    "malformed-artifact",
    "invalid-artifact",
    "failing-artifact",
    "stale-step-order",
    "unsafe-write-flags",
  ])(
    "fails release readiness deterministically when the refresh plan report index has %s",
    (issueCode) => {
      const manifest = buildMossReleaseGateManifest({
        createdAt: "2026-07-01T00:00:00.000Z",
      });
      const calls: string[] = [];
      const spawn: MossReleaseGateSpawn = (command, args) => {
        const call = [command, ...args].join(" ");
        calls.push(call);
        return call.includes("moss:release-freshness-refresh-plan-report-index")
          ? {
              status: 1,
              stdout: releaseFreshnessRefreshPlanReportIndexStdout({
                readinessStatus: "fail",
                issueCodes: [issueCode],
                latestStatus: issueCode === "failing-artifact" ? "fail" : "pass",
              }),
            }
          : { status: 0 };
      };

      const report = runMossReleaseGateReport(manifest, spawn, () => 100);

      expect(report.status).toBe("fail");
      expect(report.failedGateId).toBe("release-freshness-refresh-plan-report-index");
      expect(report.gates.map((gate) => gate.id)).toEqual([
        "ledger-status",
        "provider-fixture-replay",
        "provider-discovery-smoke",
        "control-plane-ui-smoke",
        "electron-product-shell-smoke",
        "codex-desktop-layout-gate",
        "release-freshness-refresh-plan-report-index",
      ]);
      expect(report.gates.at(-1)).toMatchObject({
        id: "release-freshness-refresh-plan-report-index",
        status: "fail",
        exitCode: 1,
        observedEvidence: {
          releaseFreshnessRefreshPlanReportIndex: {
            readinessStatus: "fail",
            issueCodes: [issueCode],
          },
        },
      });
      expect(calls.at(-1)).toBe(
        "bun run moss:release-freshness-refresh-plan-report-index -- --created-at 2026-07-01T00:00:00.000Z",
      );
      expect(mossReleaseGateReportExitCode(report)).toBe(1);
    },
  );

  it("refreshes a release report artifact only for stale self-referential freshness gates", () => {
    withTempRepo((root) => {
      const staleGateIds = CURRENT_RELEASE_GATE_IDS.filter(
        (gateId) => gateId !== "loop-packet-freshness-report-index",
      );
      const calls: string[] = [];
      const spawn: MossReleaseGateSpawn = (command, args) => {
        const call = [command, ...args].join(" ");
        calls.push(call);
        if (
          call.includes("moss:release-freshness-refresh-plan-report-index") ||
          call.includes("moss:loop-packet-refresh-plan-report-index")
        ) {
          return {
            status: 0,
            stdout: passingChainedReportIndexStdout(call),
          };
        }
        if (call.includes("moss:loop-packet-freshness-report-index")) {
          return {
            status: 1,
            stdout: loopPacketFreshnessReportIndexStdout({
              readinessStatus: "fail",
              issueCodes: ["stale-release-freshness"],
              latestTaskId: "moss-task-0071",
            }),
          };
        }
        if (call.includes("moss:loop-packet --")) {
          return {
            status: 1,
            stdout: loopPacketStaleReleaseFreshnessStdout(),
          };
        }
        if (call.includes("moss:release-gate-report-index")) {
          return {
            status: 1,
            stdout: releaseGateReportIndexStdout({
              readinessStatus: "fail",
              latestGateIds: staleGateIds,
              issueCodes: ["stale-artifact"],
            }),
          };
        }
        return { status: 0 };
      };

      const report = runMossReleaseGateRefreshReport(
        buildMossReleaseGateManifest({
          createdAt: "2026-07-01T00:00:00.000Z",
        }),
        spawn,
        () => 100,
      );
      const loopPacketGate = report.gates.find((gate) => gate.id === "loop-packet");
      const loopPacketFreshnessIndexGate = report.gates.find(
        (gate) => gate.id === "loop-packet-freshness-report-index",
      );
      const reportIndexGate = report.gates.find((gate) => gate.id === "release-gate-report-index");

      expect(report.status).toBe("pass");
      expect(report.refresh).toEqual({
        mode: "release-report-artifact-refresh",
        reason: "manifest-change",
        refreshedGateIds: [
          "loop-packet-freshness-report-index",
          "loop-packet",
          "release-gate-report-index",
        ],
      });
      expect(report.gates).toHaveLength(CURRENT_RELEASE_GATE_IDS.length);
      expect(loopPacketFreshnessIndexGate).toMatchObject({
        status: "pass",
        exitCode: 0,
        refreshEvidence: {
          mode: "release-report-artifact-refresh",
          reason: "stale-release-report-artifact",
          originalExitCode: 1,
          issueCodes: ["stale-release-freshness"],
        },
      });
      expect(loopPacketGate).toMatchObject({
        status: "pass",
        exitCode: 0,
        refreshEvidence: {
          mode: "release-report-artifact-refresh",
          reason: "stale-release-report-artifact",
          originalExitCode: 1,
          issueCodes: ["stale-artifact"],
        },
      });
      expect(reportIndexGate).toMatchObject({
        status: "pass",
        exitCode: 0,
        refreshEvidence: {
          mode: "release-report-artifact-refresh",
          reason: "stale-release-report-artifact",
          originalExitCode: 1,
          issueCodes: ["stale-artifact"],
        },
      });
      expect(reportIndexGate?.observedEvidence).toBeUndefined();
      expect(calls.at(-1)).toBe("git diff --check");

      const artifact = writeMossReleaseGateReportArtifact(
        report,
        ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-01-refresh.json",
        root,
      );
      const index = readMossReleaseGateReportArtifactIndex(root, {
        generatedAt: "2026-07-01T00:00:00.000Z",
      });

      expect(readFileSync(artifact.path, "utf8")).toContain('"refreshEvidence"');
      expect(index.readiness.status).toBe("fail");
      expect(index.latest?.gateCount).toBe(CURRENT_RELEASE_GATE_IDS.length);
      expect(index.latest?.freshnessEvidence).toBeUndefined();
      expect(index.latest?.chainedObservedEvidence?.loopPacketFreshnessReport).toMatchObject({
        readinessStatus: "fail",
        latestTaskId: "moss-task-0071",
      });
      expect(index.issues).toEqual([
        expect.objectContaining({
          code: "stale-artifact",
          path: ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-01-refresh.json",
          message: expect.stringContaining("readinessStatus=fail"),
        }),
      ]);
    });
  });

  it("continues refresh artifact reports for explicit chained loop freshness bootstrap", () => {
    const calls: string[] = [];
    const spawn: MossReleaseGateSpawn = (command, args) => {
      const call = [command, ...args].join(" ");
      calls.push(call);
      if (
        call.includes("moss:release-freshness-refresh-plan-report-index") ||
        call.includes("moss:loop-packet-refresh-plan-report-index")
      ) {
        return {
          status: 0,
          stdout: passingChainedReportIndexStdout(call),
        };
      }
      if (call.includes("moss:loop-packet-freshness-report-index")) {
        return {
          status: 1,
          stdout: loopPacketFreshnessReportIndexStdout({
            readinessStatus: "fail",
            issueCodes: ["failing-artifact"],
            latestStatus: "fail",
            latestTaskId: "moss-task-0090",
          }),
        };
      }
      if (call.includes("moss:release-gate-report-index")) {
        return {
          status: 1,
          stdout: releaseGateReportIndexStdout({
            readinessStatus: "fail",
            latestGateIds: CURRENT_RELEASE_GATE_IDS.slice(0, -1),
            issueCodes: ["stale-artifact"],
          }),
        };
      }
      return { status: 0 };
    };

    const report = runMossReleaseGateRefreshReport(
      buildMossReleaseGateManifest({
        createdAt: "2026-07-01T00:00:00.000Z",
      }),
      spawn,
      () => 100,
    );
    const loopPacketFreshnessIndexGate = report.gates.find(
      (gate) => gate.id === "loop-packet-freshness-report-index",
    );
    const reportIndexGate = report.gates.find((gate) => gate.id === "release-gate-report-index");

    expect(report.status).toBe("pass");
    expect(report.gates).toHaveLength(CURRENT_RELEASE_GATE_IDS.length);
    expect(report.refresh?.refreshedGateIds).toContain("loop-packet-freshness-report-index");
    expect(report.refresh?.refreshedGateIds).toContain("release-gate-report-index");
    expect(loopPacketFreshnessIndexGate).toMatchObject({
      status: "pass",
      exitCode: 0,
      observedEvidence: {
        loopPacketFreshnessReportIndex: {
          readinessStatus: "fail",
          latestArtifactStatus: "fail",
          latestTaskId: "moss-task-0090",
          latestChainedRefreshTaskId: "moss-task-0090",
          latestCheckStatus: "fail",
          latestLoopPacketReadinessStatus: "blocked",
          releaseFreshnessStatus: "blocked",
          releaseFreshnessReadinessStatus: "fail",
          releaseFreshnessIssueCodes: ["failing-artifact"],
          issueCodes: ["failing-artifact"],
        },
      },
      refreshEvidence: {
        mode: "release-report-artifact-refresh",
        reason: "stale-release-report-artifact",
        originalExitCode: 1,
        issueCodes: ["failing-artifact"],
      },
    });
    expect(reportIndexGate).toMatchObject({
      status: "pass",
      exitCode: 0,
      refreshEvidence: {
        mode: "release-report-artifact-refresh",
        reason: "stale-release-report-artifact",
        originalExitCode: 1,
        issueCodes: ["stale-artifact"],
      },
    });
    expect(calls.at(-1)).toBe("git diff --check");
  });

  it("recovers from a stale partial refresh artifact left by an interrupted refresh", () => {
    const spawn: MossReleaseGateSpawn = (command, args) => {
      const call = [command, ...args].join(" ");
      if (call.includes("moss:loop-packet --")) {
        return {
          status: 1,
          stdout: loopPacketPartialRefreshArtifactStdout(),
        };
      }
      if (call.includes("moss:release-gate-report-index")) {
        return {
          status: 1,
          stdout: releaseGateReportIndexStdout({
            readinessStatus: "fail",
            latestGateIds: CURRENT_RELEASE_GATE_IDS.slice(0, -5),
            issueCodes: ["failing-artifact", "stale-artifact"],
          }),
        };
      }
      return { status: 0 };
    };

    const report = runMossReleaseGateRefreshReport(
      buildMossReleaseGateManifest({
        createdAt: "2026-07-01T00:00:00.000Z",
      }),
      spawn,
      () => 100,
    );
    const loopPacketGate = report.gates.find((gate) => gate.id === "loop-packet");
    const reportIndexGate = report.gates.find((gate) => gate.id === "release-gate-report-index");

    expect(report.status).toBe("pass");
    expect(report.refresh?.refreshedGateIds).toContain("loop-packet");
    expect(report.refresh?.refreshedGateIds).toContain("release-gate-report-index");
    expect(loopPacketGate).toMatchObject({
      status: "pass",
      exitCode: 0,
      refreshEvidence: {
        mode: "release-report-artifact-refresh",
        reason: "stale-release-report-artifact",
        originalExitCode: 1,
        issueCodes: ["failing-artifact", "stale-artifact"],
      },
    });
    expect(reportIndexGate).toMatchObject({
      status: "pass",
      exitCode: 0,
      refreshEvidence: {
        mode: "release-report-artifact-refresh",
        reason: "stale-release-report-artifact",
        originalExitCode: 1,
        issueCodes: ["failing-artifact", "stale-artifact"],
      },
    });
  });

  it("keeps refresh artifact reports strict for non-stale loop packet failures", () => {
    const report = runMossReleaseGateRefreshReport(
      buildMossReleaseGateManifest({
        createdAt: "2026-07-01T00:00:00.000Z",
      }),
      spawnLoopPacketNonStaleFailure,
      () => 100,
    );

    expect(report.status).toBe("fail");
    expect(report.failedGateId).toBe("loop-packet");
    expect(report.refresh).toBeUndefined();
    expect(report.gates.at(-1)).toMatchObject({
      id: "loop-packet",
      status: "fail",
      exitCode: 1,
    });
  });

  it("reports spawn errors without streaming child output", () => {
    const report = runMossReleaseGateReport(
      buildMossReleaseGateManifest({
        createdAt: "2026-07-01T00:00:00.000Z",
      }),
      spawnReleaseGateError,
      () => 100,
    );

    expect(report.status).toBe("fail");
    expect(report.failedGateId).toBe("ledger-status");
    expect(report.gates).toEqual([
      expect.objectContaining({
        id: "ledger-status",
        status: "fail",
        exitCode: 1,
        errorMessage: "spawn failed",
      }),
    ]);
    expect(JSON.stringify(report)).not.toContain("rawSource");
    expect(mossReleaseGateReportExitCode(report)).toBe(1);
  });

  it("writes compact report JSON to an explicit repo-local artifact path", () => {
    withTempRepo((root) => {
      const report = runMossReleaseGateReport(
        buildMossReleaseGateManifest({
          createdAt: "2026-07-01T00:00:00.000Z",
        }),
        (_command, _args, _options) => ({
          status: 0,
          stdout: "rawSource provider replay detail that must stay out of artifact",
        }),
        () => 100,
      );

      const artifact = writeMossReleaseGateReportArtifact(
        report,
        ".moss/ledger/evidence/release-gate-report.json",
        root,
      );
      const storedText = readFileSync(artifact.path, "utf8");
      const storedReport = JSON.parse(storedText) as typeof report;

      expect(artifact.path).toBe(join(root, ".moss/ledger/evidence/release-gate-report.json"));
      expect(artifact.bytes).toBe(Buffer.byteLength(storedText, "utf8"));
      expect(storedText).toContain('"args": ["run", "moss:status"]');
      expect(storedReport.version).toBe(1);
      expect(storedReport.status).toBe("pass");
      expect(storedReport.gates).toHaveLength(CURRENT_RELEASE_GATE_IDS.length);
      expect(storedReport.gates.map((gate) => gate.id)).toContain(
        "release-freshness-refresh-plan-report-index",
      );
      expect(storedReport.gates.map((gate) => gate.id)).toContain(
        "loop-packet-freshness-report-index",
      );
      expect(storedReport.gates.map((gate) => gate.id)).toContain(
        "loop-packet-refresh-plan-report-index",
      );
      expect(storedReport.gates.map((gate) => gate.id)).toContain("release-gate-report-index");
      expect(JSON.stringify(storedReport)).not.toContain("rawSource");
      expect(JSON.stringify(storedReport)).not.toContain("provider replay detail");
      expect(mossReleaseGateReportExitCode(storedReport)).toBe(0);
    });
  });

  it("writes report-index freshness evidence to a report artifact and index summary", () => {
    withTempRepo((root) => {
      const report = runMossReleaseGateReport(
        buildMossReleaseGateManifest({
          createdAt: "2026-07-01T00:00:00.000Z",
        }),
        (command, args) => {
          const call = [command, ...args].join(" ");
          const chainedReportStdout = passingChainedReportIndexStdout(call);
          return {
            status: 0,
            stdout:
              chainedReportStdout ??
              (call.includes("moss:release-gate-report-index")
                ? releaseGateReportIndexStdout({
                    readinessStatus: "pass",
                    latestGateIds: CURRENT_RELEASE_GATE_IDS,
                  })
                : "rawSource provider replay detail that must stay out of artifact"),
          };
        },
        () => 100,
      );

      const artifact = writeMossReleaseGateReportArtifact(
        report,
        ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-01.json",
        root,
      );
      const storedText = readFileSync(artifact.path, "utf8");
      const storedReport = JSON.parse(storedText) as typeof report;
      const storedIndexGate = storedReport.gates.find(
        (gate) => gate.id === "release-gate-report-index",
      );
      const index = readMossReleaseGateReportArtifactIndex(root, {
        generatedAt: "2026-07-01T00:00:00.000Z",
      });

      expect(storedIndexGate?.observedEvidence?.releaseGateReportIndex).toMatchObject({
        readinessStatus: "pass",
        manifestGateCount: CURRENT_RELEASE_GATE_IDS.length,
        latestArtifactGateCount: CURRENT_RELEASE_GATE_IDS.length,
        issueCodes: [],
      });
      expect(index.latest?.freshnessEvidence).toMatchObject({
        readinessStatus: "pass",
        manifestGateCount: CURRENT_RELEASE_GATE_IDS.length,
        latestArtifactGateCount: CURRENT_RELEASE_GATE_IDS.length,
        issueCodes: [],
      });
      expect(index.readiness.status).toBe("pass");
      expect(storedText).not.toContain("$ node");
      expect(storedText).not.toContain("rawSource");
      expect(storedText).not.toContain("provider replay detail");
    });
  });

  it("writes stale report-index freshness evidence to a failed report artifact", () => {
    withTempRepo((root) => {
      const staleGateIds = CURRENT_RELEASE_GATE_IDS.filter(
        (gateId) => gateId !== "release-gate-report-index",
      );
      const report = runMossReleaseGateReport(
        buildMossReleaseGateManifest({
          createdAt: "2026-07-01T00:00:00.000Z",
        }),
        (command, args) => {
          const call = [command, ...args].join(" ");
          return call.includes("moss:release-gate-report-index")
            ? {
                status: 1,
                stdout: releaseGateReportIndexStdout({
                  readinessStatus: "fail",
                  latestGateIds: staleGateIds,
                  issueCodes: ["stale-artifact"],
                }),
              }
            : { status: 0 };
        },
        () => 100,
      );

      const artifact = writeMossReleaseGateReportArtifact(
        report,
        ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-01.json",
        root,
      );
      const storedReport = JSON.parse(readFileSync(artifact.path, "utf8")) as typeof report;
      const storedIndexGate = storedReport.gates.at(-1);
      const index = readMossReleaseGateReportArtifactIndex(root, {
        generatedAt: "2026-07-01T00:00:00.000Z",
      });

      expect(storedReport.status).toBe("fail");
      expect(storedReport.failedGateId).toBe("release-gate-report-index");
      expect(storedReport.gates.map((gate) => gate.id)).not.toContain("format-check");
      expect(storedIndexGate?.observedEvidence?.releaseGateReportIndex).toMatchObject({
        readinessStatus: "fail",
        latestArtifactGateCount: staleGateIds.length,
        latestArtifactGateIds: staleGateIds,
        issueCodes: ["stale-artifact"],
      });
      expect(index.latest?.freshnessEvidence).toMatchObject({
        readinessStatus: "fail",
        latestArtifactGateCount: staleGateIds.length,
        issueCodes: ["stale-artifact"],
      });
      expect(index.issues.map((issue) => issue.code)).toEqual([
        "failing-artifact",
        "stale-artifact",
      ]);
    });
  });

  it("rejects report artifact paths outside the repository", () => {
    withTempRepo((root) => {
      expect(() => resolveMossReleaseGateReportOutputPath("../outside.json", root)).toThrow(
        /inside the current repository/,
      );
    });
  });

  it("rejects directory report artifact targets", () => {
    withTempRepo((root) => {
      const report = runMossReleaseGateReport(
        buildMossReleaseGateManifest({
          createdAt: "2026-07-01T00:00:00.000Z",
        }),
        () => ({ status: 0 }),
        () => 100,
      );
      mkdirSync(join(root, ".moss/ledger/evidence"), { recursive: true });

      expect(() =>
        writeMossReleaseGateReportArtifact(report, ".moss/ledger/evidence", root),
      ).toThrow(/directory/);
    });
  });

  it("surfaces report artifact write failures", () => {
    withTempRepo((root) => {
      const report = runMossReleaseGateReport(
        buildMossReleaseGateManifest({
          createdAt: "2026-07-01T00:00:00.000Z",
        }),
        () => ({ status: 0 }),
        () => 100,
      );
      writeFileSync(join(root, "blocked-parent"), "not a directory");

      expect(() =>
        writeMossReleaseGateReportArtifact(report, "blocked-parent/report.json", root),
      ).toThrow();
    });
  });
});
