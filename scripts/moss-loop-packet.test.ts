import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildMossLoopPacketFreshnessGateReport,
  buildMossLoopPacketRefreshPlanGateReport,
  mossLoopPacketExitCode,
  mossLoopPacketFreshnessGateReportExitCode,
  mossLoopPacketRefreshPlanGateReportExitCode,
  readMossLoopPacket,
  writeMossLoopPacketFreshnessGateReportArtifact,
  writeMossLoopPacketRefreshPlanGateReportArtifact,
} from "./moss-loop-packet.ts";
import { isMossExplicitChainedProvenanceBootstrapMessage } from "./lib/moss-chained-refresh-provenance.ts";
import { MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER } from "./lib/moss-release-freshness-refresh-plan-constants.ts";
import { buildMossReleaseGateManifest } from "./lib/moss-release-gate-manifest.ts";

function event(input: {
  readonly eventId: string;
  readonly type: string;
  readonly role: string;
  readonly correlationId: string;
  readonly payload?: Record<string, unknown>;
  readonly evidence?: ReadonlyArray<string>;
}) {
  return {
    eventId: input.eventId,
    type: input.type,
    createdAt: "2026-07-01T00:00:00.000Z",
    actor: {
      role: input.role,
    },
    correlationId: input.correlationId,
    payload: input.payload ?? {},
    evidence: input.evidence ?? [],
  };
}

async function writeMossRepo(
  root: string,
  input: {
    readonly events: ReadonlyArray<unknown>;
    readonly tasks: ReadonlyArray<unknown>;
    readonly context?: string;
    readonly evidenceIndex?: string;
    readonly releaseArtifact?:
      | "valid"
      | "missing"
      | "stale"
      | "missing-provenance"
      | "stale-provenance"
      | undefined;
    readonly refreshPlanArtifact?: "valid" | "missing" | "failing" | "stale" | "unsafe" | undefined;
  },
): Promise<void> {
  await rm(root, { force: true, recursive: true });
  await mkdir(join(root, ".moss", "ledger", "evidence"), { recursive: true });
  await mkdir(join(root, ".moss", "roles"), { recursive: true });
  await mkdir(join(root, ".moss", "context"), { recursive: true });
  await writeFile(
    join(root, ".moss", "mission.md"),
    "# Moss Shell Mission\n\nBuild the control plane.\n",
  );
  await writeFile(
    join(root, ".moss", "ledger", "events.jsonl"),
    `${[
      {
        eventId: "moss-event-goal",
        type: "moss.goal.defined",
        createdAt: "2026-07-01T00:00:00.000Z",
        payload: {
          goal: "Build a Codex-like shell.",
          branch: "moss/control-plane-v1",
        },
      },
      ...input.events,
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
  );
  await writeFile(
    join(root, ".moss", "ledger", "tasks.jsonl"),
    `${input.tasks.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  await writeFile(join(root, ".moss", "roles", "memory-curator.md"), "# Memory Curator\n");
  await writeFile(join(root, ".moss", "roles", "qa-gatekeeper.md"), "# QA Gatekeeper\n");
  await writeFile(join(root, ".moss", "roles", "release-operator.md"), "# Release Operator\n");
  await writeFile(join(root, ".moss", "roles", "reviewer.md"), "# Reviewer\n");
  await writeFile(
    join(root, ".moss", "context", "current.md"),
    input.context ??
      "# Moss Context Snapshot\n\n## Status\n\nMemory packet generation is complete.\n\n## Next Tasks\n\n- Add Moss loop packet aggregate gate.\n",
  );
  await writeFile(
    join(root, ".moss", "ledger", "evidence", "README.md"),
    input.evidenceIndex ?? "# Evidence Index\n\n- `memory-packet.md`\n",
  );
  if (input.releaseArtifact !== "missing") {
    await writeReleaseGateReportArtifact(root, input.releaseArtifact ?? "valid");
  }
  if (input.refreshPlanArtifact !== "missing") {
    await writeRefreshPlanReportArtifact(root, input.refreshPlanArtifact ?? "valid");
  }
}

function currentGateIds(): ReadonlyArray<string> {
  return buildMossReleaseGateManifest({
    createdAt: "2026-07-01T00:00:00.000Z",
  }).gates.map((gate) => gate.id);
}

async function writeReleaseGateReportArtifact(
  root: string,
  artifactKind: "valid" | "stale" | "missing-provenance" | "stale-provenance",
): Promise<void> {
  const createdAt = "2026-07-01T00:00:00.000Z";
  const includeChainedProvenance = artifactKind === "valid" || artifactKind === "stale-provenance";
  const artifactTaskId = "moss-task-1";
  const chainedRefreshProvenance = {
    kind: "release-artifact-chain-freshness",
    expected: true,
    taskId: artifactTaskId,
    source: "loop-packet-task-metadata",
  };
  const gateIds =
    artifactKind === "stale"
      ? currentGateIds().filter((gateId) => gateId !== "release-gate-report-index")
      : currentGateIds();
  await writeFile(
    join(root, ".moss", "ledger", "evidence", "moss-release-gate-report-artifact-2026-07-01.json"),
    `${JSON.stringify(
      {
        version: 1,
        createdAt,
        status: "pass",
        gates: gateIds.map((gateId) => {
          const gate: Record<string, unknown> = {
            id: gateId,
            status: "pass",
            exitCode: 0,
          };

          if (
            (artifactKind === "valid" ||
              artifactKind === "missing-provenance" ||
              artifactKind === "stale-provenance") &&
            gateId === "release-gate-report-index"
          ) {
            gate.observedEvidence = {
              releaseGateReportIndex: {
                readinessStatus: "pass",
                manifestGateCount: currentGateIds().length,
                manifestGateIds: currentGateIds(),
                latestArtifactPath:
                  ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-01.json",
                latestArtifactCreatedAt: createdAt,
                latestArtifactStatus: "pass",
                latestArtifactGateCount: gateIds.length,
                latestArtifactGateIds: gateIds,
                issueCodes: [],
                staleArtifactMessages: [],
              },
            };
          }
          if (
            (artifactKind === "valid" ||
              artifactKind === "missing-provenance" ||
              artifactKind === "stale-provenance") &&
            gateId === "release-freshness-refresh-plan-report-index"
          ) {
            gate.observedEvidence = {
              releaseFreshnessRefreshPlanReportIndex: {
                readinessStatus: "pass",
                latestArtifactCreatedAt: createdAt,
                issueCodes: [],
              },
            };
          }
          if (
            (artifactKind === "valid" ||
              artifactKind === "missing-provenance" ||
              artifactKind === "stale-provenance") &&
            gateId === "loop-packet-freshness-report-index"
          ) {
            gate.observedEvidence = {
              loopPacketFreshnessReportIndex: {
                readinessStatus: "pass",
                latestArtifactCreatedAt: createdAt,
                latestTaskId: artifactTaskId,
                ...(includeChainedProvenance
                  ? {
                      latestChainedRefreshTaskId: artifactTaskId,
                      latestChainedRefreshProvenance: chainedRefreshProvenance,
                    }
                  : {}),
                issueCodes: [],
              },
            };
          }
          if (
            (artifactKind === "valid" ||
              artifactKind === "missing-provenance" ||
              artifactKind === "stale-provenance") &&
            gateId === "loop-packet-refresh-plan-report-index"
          ) {
            gate.observedEvidence = {
              loopPacketRefreshPlanReportIndex: {
                readinessStatus: "pass",
                latestArtifactCreatedAt: createdAt,
                latestTaskId: artifactTaskId,
                ...(includeChainedProvenance
                  ? {
                      latestChainedRefreshTaskId: artifactTaskId,
                      latestChainedRefreshProvenance: chainedRefreshProvenance,
                    }
                  : {}),
                issueCodes: [],
              },
            };
          }

          return gate;
        }),
      },
      null,
      2,
    )}\n`,
  );
}

async function writeRefreshPlanReportArtifact(
  root: string,
  artifactKind: "valid" | "failing" | "stale" | "unsafe",
): Promise<void> {
  const createdAt = "2026-07-01T00:00:00.000Z";
  const status = artifactKind === "failing" ? "fail" : "pass";
  const stepOrder =
    artifactKind === "stale"
      ? MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER.filter(
          (stepId) => stepId !== "final-release-gate",
        )
      : MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER;
  const artifactWriterStepIds = new Set([
    "release-report-artifact-refresh",
    "loop-packet-freshness-artifact-refresh",
    "release-freshness-refresh-plan-report-refresh",
    "loop-packet-refresh-plan-report-refresh",
  ]);

  await writeFile(
    join(
      root,
      ".moss",
      "ledger",
      "evidence",
      "moss-release-freshness-refresh-plan-report-2026-07-01.json",
    ),
    `${JSON.stringify(
      {
        version: 1,
        createdAt,
        status,
        providerCredentialsRequired: artifactKind === "unsafe",
        writesGlobalConfig: false,
        plan: {
          mode: "dry-run",
          writesFiles: artifactKind === "unsafe",
          writesGlobalConfig: false,
          readiness: {
            status: status === "pass" ? "ready" : "blocked",
          },
          artifactOutputs: {
            releaseGateReport:
              ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-01-refresh.json",
            loopPacketFreshnessReport:
              ".moss/ledger/evidence/moss-loop-packet-freshness-gate-report-2026-07-01-refresh.json",
            releaseFreshnessRefreshPlanReport:
              ".moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-01-gate.json",
            loopPacketRefreshPlanReport:
              ".moss/ledger/evidence/moss-loop-packet-refresh-plan-gate-report-2026-07-01.json",
          },
          state: {
            requiresReleaseArtifactRefresh: false,
            requiresLoopFreshnessRefresh: false,
            requiresLoopRefreshPlanReportRefresh: false,
          },
          stepOrder,
          steps: stepOrder.map((id) => {
            const writesArtifacts =
              artifactKind === "unsafe" && id === "compact-release-report"
                ? true
                : artifactWriterStepIds.has(id);
            return {
              id,
              writesArtifacts,
              artifactOutputs: writesArtifacts ? [`.moss/ledger/evidence/${id}-output.json`] : [],
              writesGlobalConfig: false,
            };
          }),
        },
      },
      null,
      2,
    )}\n`,
  );
}

describe("moss-loop-packet", () => {
  it("generates one bundle for iteration, review, and memory packets", async () => {
    const root = await mkdtemp(join(tmpdir(), "moss-loop-packet-pending-test-"));
    await writeMossRepo(root, {
      events: [
        event({
          eventId: "moss-event-start",
          type: "moss.task.started",
          role: "Release Operator",
          correlationId: "iteration-1",
          payload: {
            taskId: "moss-task-1",
          },
        }),
      ],
      tasks: [
        {
          taskId: "moss-task-1",
          status: "active",
          owner: "Release Operator",
          title: "Add Moss loop packet aggregate gate",
          acceptance: ["Aggregate packet reports readiness"],
          evidence: [],
        },
      ],
    });

    const packet = await readMossLoopPacket(root, {
      createdAt: "2026-07-01T00:00:00.000Z",
      changedFiles: ["scripts/moss-loop-packet.ts"],
    });

    expect(packet).toMatchObject({
      version: 1,
      generatedAt: "2026-07-01T00:00:00.000Z",
      task: {
        taskId: "moss-task-1",
        owner: "Release Operator",
      },
      readiness: {
        status: "pending",
      },
    });
    expect(packet.checks).toEqual([
      expect.objectContaining({ id: "iteration-packet", status: "pass", exitCode: 0 }),
      expect.objectContaining({ id: "review-packet", status: "pending", exitCode: 0 }),
      expect.objectContaining({ id: "memory-packet", status: "pass", exitCode: 0 }),
      expect.objectContaining({
        id: "loop-ledger-release-freshness",
        status: "pass",
        exitCode: 0,
      }),
      expect.objectContaining({
        id: "loop-ledger-refresh-plan",
        status: "pass",
        exitCode: 0,
      }),
    ]);
    expect(packet.packets.iteration.objective).toBe(
      "Complete moss-task-1: Add Moss loop packet aggregate gate",
    );
    expect(packet.packets.review.readiness.status).toBe("pending");
    expect(packet.packets.memory.readiness.status).toBe("ready");
    expect(packet.packets.loopLedgerDashboard.releaseGate.freshness).toMatchObject({
      status: "pass",
      manifestGateCount: currentGateIds().length,
      latestArtifactGateCount: currentGateIds().length,
      issueCount: 0,
    });
    expect(packet.packets.loopLedgerDashboard.releaseGate.refreshPlan).toMatchObject({
      status: "pass",
      expectedStepCount: MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER.length,
      latestStepCount: MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER.length,
      issueCount: 0,
    });
    expect(packet.sourceFiles).toEqual(
      expect.arrayContaining([
        "scripts/moss-loop-packet.ts",
        "scripts/moss-memory-packet.ts",
        "package.json",
      ]),
    );
    expect(packet.issues).toEqual([]);
    expect(mossLoopPacketExitCode(packet)).toBe(0);

    await rm(root, { force: true, recursive: true });
  });

  it("reports ready when all underlying packets are ready", async () => {
    const root = await mkdtemp(join(tmpdir(), "moss-loop-packet-ready-test-"));
    await writeMossRepo(root, {
      evidenceIndex: "# Evidence Index\n\n- `loop-packet.md`\n",
      events: [
        event({
          eventId: "moss-event-start",
          type: "moss.task.started",
          role: "Release Operator",
          correlationId: "iteration-1",
          payload: {
            taskId: "moss-task-1",
          },
        }),
        event({
          eventId: "moss-event-evidence",
          type: "moss.evidence.recorded",
          role: "QA Gatekeeper",
          correlationId: "iteration-1",
          evidence: [".moss/ledger/evidence/loop-packet.md"],
        }),
        event({
          eventId: "moss-event-review",
          type: "moss.review.completed",
          role: "Reviewer",
          correlationId: "iteration-1",
          payload: {
            decision: "accepted",
            notes: "aggregate packet is ready",
          },
          evidence: [".moss/ledger/evidence/loop-packet.md"],
        }),
      ],
      tasks: [
        {
          taskId: "moss-task-1",
          status: "active",
          owner: "Release Operator",
          title: "Add Moss loop packet aggregate gate",
          acceptance: ["Aggregate packet reports readiness"],
          evidence: [".moss/ledger/evidence/loop-packet.md"],
        },
      ],
    });

    const packet = await readMossLoopPacket(root, {
      createdAt: "2026-07-01T00:00:00.000Z",
      changedFiles: ["scripts/moss-loop-packet.ts", "package.json"],
    });

    expect(packet.readiness.status).toBe("ready");
    expect(packet.checks.map((check) => check.status)).toEqual([
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
    ]);
    expect(packet.issues).toEqual([]);
    expect(mossLoopPacketExitCode(packet)).toBe(0);

    await rm(root, { force: true, recursive: true });
  });

  it("writes a compact freshness gate report artifact without raw packet payloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "moss-loop-packet-freshness-report-test-"));
    await writeMossRepo(root, {
      evidenceIndex: "# Evidence Index\n\n- `loop-packet.md`\n",
      events: [
        event({
          eventId: "moss-event-start",
          type: "moss.task.started",
          role: "Release Operator",
          correlationId: "iteration-1",
          payload: {
            taskId: "moss-task-1",
          },
        }),
        event({
          eventId: "moss-event-evidence",
          type: "moss.evidence.recorded",
          role: "QA Gatekeeper",
          correlationId: "iteration-1",
          evidence: [".moss/ledger/evidence/loop-packet.md"],
        }),
      ],
      tasks: [
        {
          taskId: "moss-task-1",
          status: "active",
          owner: "Release Operator",
          title: "Persist loop packet freshness gate report evidence",
          metadata: {
            chainedRefreshProvenance: {
              kind: "release-artifact-chain-freshness",
              expected: true,
            },
          },
          acceptance: ["Loop packet writes compact freshness gate report artifact"],
          evidence: [".moss/ledger/evidence/loop-packet.md"],
        },
      ],
    });

    const packet = await readMossLoopPacket(root, {
      createdAt: "2026-07-01T00:00:00.000Z",
      changedFiles: ["scripts/moss-loop-packet.ts"],
    });
    const report = buildMossLoopPacketFreshnessGateReport(packet);
    const artifact = writeMossLoopPacketFreshnessGateReportArtifact(
      report,
      ".moss/ledger/evidence/moss-loop-packet-freshness-gate-report-2026-07-01.json",
      root,
    );
    const artifactBody = await readFile(artifact.path, "utf8");

    expect(report).toMatchObject({
      version: 1,
      createdAt: "2026-07-01T00:00:00.000Z",
      status: "pass",
      task: {
        taskId: "moss-task-1",
      },
      chainedRefreshProvenance: {
        kind: "release-artifact-chain-freshness",
        expected: true,
        taskId: "moss-task-1",
        source: "loop-packet-task-metadata",
      },
      check: {
        id: "loop-ledger-release-freshness",
        status: "pass",
      },
      releaseFreshness: {
        status: "pass",
        readinessStatus: "pass",
        manifestGateCount: currentGateIds().length,
        latestArtifactGateCount: currentGateIds().length,
        artifactPath: ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-01.json",
        issueCount: 0,
      },
      providerCredentialsRequired: false,
      writesGlobalConfig: false,
    });
    expect(artifact.path).toBe(
      join(root, ".moss/ledger/evidence/moss-loop-packet-freshness-gate-report-2026-07-01.json"),
    );
    expect(artifact.bytes).toBeGreaterThan(0);
    expect(JSON.parse(artifactBody)).toMatchObject({
      version: 1,
      status: "pass",
      chainedRefreshProvenance: {
        taskId: "moss-task-1",
      },
    });
    expect(JSON.stringify(report)).not.toContain('"packets"');
    expect(JSON.stringify(report)).not.toContain("rawSource");
    expect(JSON.stringify(report)).not.toContain("stdout");
    expect(mossLoopPacketFreshnessGateReportExitCode(report)).toBe(0);

    await rm(root, { force: true, recursive: true });
  });

  it("bootstraps explicit chained provenance when release freshness only lacks loop provenance", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "moss-loop-packet-chained-provenance-bootstrap-test-"),
    );
    await writeMossRepo(root, {
      releaseArtifact: "missing-provenance",
      evidenceIndex: "# Evidence Index\n\n- `loop-packet.md`\n",
      events: [
        event({
          eventId: "moss-event-start",
          type: "moss.task.started",
          role: "Architect",
          correlationId: "iteration-1",
          payload: {
            taskId: "moss-task-1",
          },
        }),
      ],
      tasks: [
        {
          taskId: "moss-task-1",
          status: "active",
          owner: "Architect",
          title: "Make chained refresh task provenance explicit",
          metadata: {
            chainedRefreshProvenance: {
              kind: "release-artifact-chain-freshness",
              expected: true,
            },
          },
          acceptance: ["Loop packet supplies explicit chained provenance"],
          evidence: [".moss/ledger/evidence/loop-packet.md"],
        },
      ],
    });

    const packet = await readMossLoopPacket(root, {
      createdAt: "2026-07-01T00:00:00.000Z",
      changedFiles: ["scripts/moss-loop-packet.ts"],
    });
    const releaseFreshnessCheck = packet.checks.find(
      (check) => check.id === "loop-ledger-release-freshness",
    );
    const report = buildMossLoopPacketFreshnessGateReport(packet);

    expect(releaseFreshnessCheck?.status).toBe("pass");
    expect(report).toMatchObject({
      status: "pass",
      chainedRefreshProvenance: {
        taskId: "moss-task-1",
        source: "loop-packet-task-metadata",
      },
      releaseFreshness: {
        status: "pass",
        readinessStatus: "pass",
        issueCount: 0,
        issueCodes: [],
        staleArtifactMessages: [],
      },
    });
    expect(mossLoopPacketFreshnessGateReportExitCode(report)).toBe(0);

    await rm(root, { force: true, recursive: true });
  });

  it("bootstraps explicit chained provenance when the previous release artifact has older provenance", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "moss-loop-packet-stale-chained-provenance-bootstrap-test-"),
    );
    await writeMossRepo(root, {
      releaseArtifact: "stale-provenance",
      evidenceIndex: "# Evidence Index\n\n- `loop-packet.md`\n",
      events: [
        event({
          eventId: "moss-event-start",
          type: "moss.task.started",
          role: "QA Gatekeeper",
          correlationId: "iteration-2",
          payload: {
            taskId: "moss-task-2",
          },
        }),
      ],
      tasks: [
        {
          taskId: "moss-task-2",
          status: "active",
          owner: "QA Gatekeeper",
          title: "Gate chained provenance consistency across release artifacts",
          metadata: {
            chainedRefreshProvenance: {
              kind: "release-artifact-chain-freshness",
              expected: true,
            },
          },
          acceptance: ["Loop packet supplies newer explicit chained provenance"],
          evidence: [".moss/ledger/evidence/loop-packet.md"],
        },
      ],
    });

    const packet = await readMossLoopPacket(root, {
      createdAt: "2026-07-01T00:00:00.000Z",
      changedFiles: ["scripts/moss-loop-packet.ts"],
    });
    const releaseFreshnessCheck = packet.checks.find(
      (check) => check.id === "loop-ledger-release-freshness",
    );
    const report = buildMossLoopPacketFreshnessGateReport(packet);

    expect(releaseFreshnessCheck?.status).toBe("pass");
    expect(report).toMatchObject({
      status: "pass",
      chainedRefreshProvenance: {
        taskId: "moss-task-2",
        source: "loop-packet-task-metadata",
      },
      releaseFreshness: {
        status: "pass",
        readinessStatus: "pass",
        issueCount: 0,
        issueCodes: [],
        staleArtifactMessages: [],
      },
    });
    expect(mossLoopPacketFreshnessGateReportExitCode(report)).toBe(0);

    await rm(root, { force: true, recursive: true });
  });

  it("recognizes stale chained observed evidence messages during provenance bootstrap", () => {
    const bootstrapMessages = [
      ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-02-refresh.json has stale chained observed evidence for release freshness refresh-plan report: latestArtifactCreatedAt 2026-07-02T17:21:05.000Z predates release artifact createdAt 2026-07-02T17:22:03.000Z.",
      ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-02-refresh.json has stale chained observed evidence for loop packet freshness report: latestArtifactCreatedAt 2026-07-02T17:21:05.000Z predates release artifact createdAt 2026-07-02T17:22:03.000Z.",
      ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-02-refresh.json has stale chained observed evidence for loop packet refresh-plan report: latestArtifactCreatedAt 2026-07-02T17:21:05.000Z predates release artifact createdAt 2026-07-02T17:22:03.000Z.",
    ];

    expect(bootstrapMessages.every(isMossExplicitChainedProvenanceBootstrapMessage)).toBe(true);
    expect(
      isMossExplicitChainedProvenanceBootstrapMessage(
        ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-02-refresh.json has stale gate list unrelated to chained provenance.",
      ),
    ).toBe(false);
  });

  it("writes a compact refresh plan gate report artifact without raw packet payloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "moss-loop-packet-refresh-plan-report-test-"));
    await writeMossRepo(root, {
      evidenceIndex: "# Evidence Index\n\n- `loop-packet.md`\n",
      events: [
        event({
          eventId: "moss-event-start",
          type: "moss.task.started",
          role: "Release Operator",
          correlationId: "iteration-1",
          payload: {
            taskId: "moss-task-1",
          },
        }),
        event({
          eventId: "moss-event-evidence",
          type: "moss.evidence.recorded",
          role: "QA Gatekeeper",
          correlationId: "iteration-1",
          evidence: [".moss/ledger/evidence/loop-packet.md"],
        }),
      ],
      tasks: [
        {
          taskId: "moss-task-1",
          status: "active",
          owner: "Release Operator",
          title: "Persist loop packet refresh plan dashboard gate report evidence",
          metadata: {
            chainedRefreshProvenance: {
              kind: "release-artifact-chain-freshness",
              expected: true,
            },
          },
          acceptance: ["Loop packet writes compact refresh plan gate report artifact"],
          evidence: [".moss/ledger/evidence/loop-packet.md"],
        },
      ],
    });

    const packet = await readMossLoopPacket(root, {
      createdAt: "2026-07-01T00:00:00.000Z",
      changedFiles: ["scripts/moss-loop-packet.ts"],
    });
    const report = buildMossLoopPacketRefreshPlanGateReport(packet);
    const artifact = writeMossLoopPacketRefreshPlanGateReportArtifact(
      report,
      ".moss/ledger/evidence/moss-loop-packet-refresh-plan-gate-report-2026-07-01.json",
      root,
    );
    const artifactBody = await readFile(artifact.path, "utf8");

    expect(report).toMatchObject({
      version: 1,
      createdAt: "2026-07-01T00:00:00.000Z",
      status: "pass",
      task: {
        taskId: "moss-task-1",
      },
      chainedRefreshProvenance: {
        kind: "release-artifact-chain-freshness",
        expected: true,
        taskId: "moss-task-1",
        source: "loop-packet-task-metadata",
      },
      check: {
        id: "loop-ledger-refresh-plan",
        status: "pass",
      },
      refreshPlan: {
        status: "pass",
        readinessStatus: "pass",
        expectedStepCount: MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER.length,
        latestStepCount: MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER.length,
        artifactPath:
          ".moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-01.json",
        latestArtifactStatus: "pass",
        mode: "dry-run",
        writesFiles: false,
        writesGlobalConfig: false,
        providerCredentialsRequired: false,
        issueCount: 0,
      },
      providerCredentialsRequired: false,
      writesFiles: false,
      writesGlobalConfig: false,
    });
    expect(artifact.path).toBe(
      join(root, ".moss/ledger/evidence/moss-loop-packet-refresh-plan-gate-report-2026-07-01.json"),
    );
    expect(artifact.bytes).toBeGreaterThan(0);
    expect(JSON.parse(artifactBody)).toMatchObject({
      version: 1,
      status: "pass",
      chainedRefreshProvenance: {
        taskId: "moss-task-1",
      },
    });
    expect(JSON.stringify(report)).not.toContain('"packets"');
    expect(JSON.stringify(report)).not.toContain("rawSource");
    expect(JSON.stringify(report)).not.toContain("stdout");
    expect(mossLoopPacketRefreshPlanGateReportExitCode(report)).toBe(0);

    await rm(root, { force: true, recursive: true });
  });

  it("blocks when any underlying packet has blocking errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "moss-loop-packet-blocked-test-"));
    await writeMossRepo(root, {
      events: [
        event({
          eventId: "moss-event-start",
          type: "moss.task.started",
          role: "Release Operator",
          correlationId: "iteration-1",
          payload: {
            taskId: "moss-task-1",
          },
        }),
      ],
      tasks: [
        {
          taskId: "moss-task-1",
          status: "active",
          owner: "Release Operator",
          title: "Add Moss loop packet aggregate gate",
          acceptance: ["Aggregate packet reports readiness"],
          evidence: [],
        },
        {
          taskId: "moss-task-2",
          status: "done",
          owner: "QA Gatekeeper",
          title: "Done without evidence",
          evidence: [],
        },
      ],
    });

    const packet = await readMossLoopPacket(root, {
      createdAt: "2026-07-01T00:00:00.000Z",
      changedFiles: ["scripts/moss-loop-packet.ts"],
    });

    expect(packet.readiness.status).toBe("blocked");
    expect(packet.checks.map((check) => check.status)).toEqual([
      "fail",
      "fail",
      "fail",
      "pass",
      "pass",
    ]);
    expect(packet.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "iteration-packet-blocked" }),
        expect.objectContaining({ code: "review-packet-blocked" }),
        expect.objectContaining({ code: "memory-packet-blocked" }),
      ]),
    );
    expect(mossLoopPacketExitCode(packet)).toBe(1);

    await rm(root, { force: true, recursive: true });
  });

  it("blocks when Loop Ledger Dashboard release freshness evidence is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "moss-loop-packet-missing-freshness-test-"));
    await writeMossRepo(root, {
      releaseArtifact: "missing",
      evidenceIndex: "# Evidence Index\n\n- `loop-packet.md`\n",
      events: [
        event({
          eventId: "moss-event-start",
          type: "moss.task.started",
          role: "Release Operator",
          correlationId: "iteration-1",
          payload: {
            taskId: "moss-task-1",
          },
        }),
        event({
          eventId: "moss-event-evidence",
          type: "moss.evidence.recorded",
          role: "QA Gatekeeper",
          correlationId: "iteration-1",
          evidence: [".moss/ledger/evidence/loop-packet.md"],
        }),
        event({
          eventId: "moss-event-review",
          type: "moss.review.completed",
          role: "Reviewer",
          correlationId: "iteration-1",
          payload: {
            decision: "accepted",
            notes: "aggregate packet is ready",
          },
          evidence: [".moss/ledger/evidence/loop-packet.md"],
        }),
      ],
      tasks: [
        {
          taskId: "moss-task-1",
          status: "active",
          owner: "Release Operator",
          title: "Add Moss loop packet aggregate gate",
          acceptance: ["Aggregate packet reports readiness"],
          evidence: [".moss/ledger/evidence/loop-packet.md"],
        },
      ],
    });

    const packet = await readMossLoopPacket(root, {
      createdAt: "2026-07-01T00:00:00.000Z",
      changedFiles: ["scripts/moss-loop-packet.ts"],
    });

    expect(packet.readiness.status).toBe("blocked");
    expect(packet.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "loop-ledger-release-freshness",
          status: "fail",
          summary: expect.stringContaining("issueCodes=missing-artifacts"),
        }),
      ]),
    );
    expect(packet.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "loop-ledger-release-freshness-blocked" }),
      ]),
    );
    expect(mossLoopPacketExitCode(packet)).toBe(1);

    await rm(root, { force: true, recursive: true });
  });

  it("blocks when Loop Ledger Dashboard release freshness evidence is stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "moss-loop-packet-stale-freshness-test-"));
    await writeMossRepo(root, {
      releaseArtifact: "stale",
      evidenceIndex: "# Evidence Index\n\n- `loop-packet.md`\n",
      events: [
        event({
          eventId: "moss-event-start",
          type: "moss.task.started",
          role: "Release Operator",
          correlationId: "iteration-1",
          payload: {
            taskId: "moss-task-1",
          },
        }),
        event({
          eventId: "moss-event-evidence",
          type: "moss.evidence.recorded",
          role: "QA Gatekeeper",
          correlationId: "iteration-1",
          evidence: [".moss/ledger/evidence/loop-packet.md"],
        }),
        event({
          eventId: "moss-event-review",
          type: "moss.review.completed",
          role: "Reviewer",
          correlationId: "iteration-1",
          payload: {
            decision: "accepted",
            notes: "aggregate packet is ready",
          },
          evidence: [".moss/ledger/evidence/loop-packet.md"],
        }),
      ],
      tasks: [
        {
          taskId: "moss-task-1",
          status: "active",
          owner: "Release Operator",
          title: "Add Moss loop packet aggregate gate",
          acceptance: ["Aggregate packet reports readiness"],
          evidence: [".moss/ledger/evidence/loop-packet.md"],
        },
      ],
    });

    const packet = await readMossLoopPacket(root, {
      createdAt: "2026-07-01T00:00:00.000Z",
      changedFiles: ["scripts/moss-loop-packet.ts"],
    });

    expect(packet.readiness.status).toBe("blocked");
    expect(packet.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "loop-ledger-release-freshness",
          status: "fail",
          summary: expect.stringContaining("issueCodes=stale-artifact"),
        }),
      ]),
    );
    expect(packet.packets.loopLedgerDashboard.releaseGate.freshness).toMatchObject({
      status: "blocked",
      readinessStatus: "fail",
      manifestGateCount: currentGateIds().length,
      latestArtifactGateCount: currentGateIds().length - 1,
      issueCodes: ["stale-artifact"],
    });
    expect(packet.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "loop-ledger-release-freshness-blocked" }),
      ]),
    );
    expect(mossLoopPacketExitCode(packet)).toBe(1);

    await rm(root, { force: true, recursive: true });
  });

  it.each([
    {
      artifactKind: "missing" as const,
      issueCode: "missing-artifacts",
      testName: "missing",
    },
    {
      artifactKind: "failing" as const,
      issueCode: "failing-artifact",
      testName: "failing",
    },
    {
      artifactKind: "stale" as const,
      issueCode: "stale-step-order",
      testName: "stale step-order",
    },
    {
      artifactKind: "unsafe" as const,
      issueCode: "unsafe-write-flags",
      testName: "unsafe write flags",
    },
  ])("blocks when Loop Ledger Dashboard refresh plan evidence is $testName", async (input) => {
    const root = await mkdtemp(
      join(tmpdir(), `moss-loop-packet-refresh-plan-${input.artifactKind}-test-`),
    );
    await writeMossRepo(root, {
      refreshPlanArtifact: input.artifactKind,
      evidenceIndex: "# Evidence Index\n\n- `loop-packet.md`\n",
      events: [
        event({
          eventId: "moss-event-start",
          type: "moss.task.started",
          role: "Release Operator",
          correlationId: "iteration-1",
          payload: {
            taskId: "moss-task-1",
          },
        }),
        event({
          eventId: "moss-event-evidence",
          type: "moss.evidence.recorded",
          role: "QA Gatekeeper",
          correlationId: "iteration-1",
          evidence: [".moss/ledger/evidence/loop-packet.md"],
        }),
        event({
          eventId: "moss-event-review",
          type: "moss.review.completed",
          role: "Reviewer",
          correlationId: "iteration-1",
          payload: {
            decision: "accepted",
            notes: "aggregate packet is ready",
          },
          evidence: [".moss/ledger/evidence/loop-packet.md"],
        }),
      ],
      tasks: [
        {
          taskId: "moss-task-1",
          status: "active",
          owner: "Release Operator",
          title: "Gate loop packet on refresh plan dashboard evidence",
          acceptance: ["Loop packet blocks bad refresh plan dashboard evidence"],
          evidence: [".moss/ledger/evidence/loop-packet.md"],
        },
      ],
    });

    const packet = await readMossLoopPacket(root, {
      createdAt: "2026-07-01T00:00:00.000Z",
      changedFiles: ["scripts/moss-loop-packet.ts"],
    });

    expect(packet.readiness.status).toBe("blocked");
    expect(packet.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "loop-ledger-refresh-plan",
          status: "fail",
          summary: expect.stringContaining(`issueCodes=${input.issueCode}`),
        }),
      ]),
    );
    expect(packet.packets.loopLedgerDashboard.releaseGate.refreshPlan).toMatchObject({
      status: "blocked",
      readinessStatus: "fail",
      expectedStepCount: MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER.length,
      issueCodes: [input.issueCode],
    });
    expect(packet.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "loop-ledger-refresh-plan-blocked" }),
      ]),
    );
    expect(mossLoopPacketExitCode(packet)).toBe(1);

    await rm(root, { force: true, recursive: true });
  });
});
