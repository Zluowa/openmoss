import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { deriveMossLoopLedgerDashboardModel } from "@synara/contracts";
import { readMossLoopLedgerDashboardSnapshot } from "./moss-loop-ledger-snapshot.ts";
import { buildMossReleaseGateManifest } from "./moss-release-gate.ts";
import { MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER } from "./lib/moss-release-freshness-refresh-plan-constants.ts";

interface TestMossRepoInput {
  readonly events: ReadonlyArray<Record<string, unknown>>;
  readonly tasks: ReadonlyArray<Record<string, unknown>>;
  readonly evidenceIndex?: string;
  readonly roles?: Record<string, string>;
}

async function writeMossRepo(root: string, input: TestMossRepoInput): Promise<void> {
  await rm(root, { force: true, recursive: true });
  await mkdir(join(root, ".moss", "ledger", "evidence"), { recursive: true });
  await mkdir(join(root, ".moss", "roles"), { recursive: true });
  await mkdir(join(root, ".moss", "context"), { recursive: true });
  await writeFile(
    join(root, ".moss", "mission.md"),
    "# Moss Shell Mission\n\nBuild the control plane.\n",
  );
  await writeFile(
    join(root, ".moss", "context", "current.md"),
    [
      "# Moss Context Snapshot",
      "",
      "## Status",
      "",
      "Current implementation snapshot.",
      "",
      "## Next Tasks",
      "",
      "- Continue generated ledger snapshot wiring.",
      "- Re-run the loop gate.",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, ".moss", "ledger", "evidence", "README.md"),
    input.evidenceIndex ??
      "# Evidence Index\n\n- `snapshot-evidence.md`\n- `bun run moss:status`\n",
  );
  await writeFile(
    join(root, ".moss", "ledger", "events.jsonl"),
    `${input.events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
  await writeFile(
    join(root, ".moss", "ledger", "tasks.jsonl"),
    `${input.tasks.map((task) => JSON.stringify(task)).join("\n")}\n`,
  );

  const roles = input.roles ?? {
    "runtime-adapter-engineer.md":
      "# Runtime Adapter Engineer\n\n## Mission\n\nOwn provider launch and event ingestion.\n",
    "qa-gatekeeper.md": "# QA Gatekeeper\n\n## Mission\n\nOwn verification gates.\n",
    "reviewer.md": "# Reviewer\n\n## Mission\n\nReview risks and missing tests.\n",
  };
  await Promise.all(
    Object.entries(roles).map(([file, content]) =>
      writeFile(join(root, ".moss", "roles", file), content),
    ),
  );
}

function currentGateIds(): ReadonlyArray<string> {
  return buildMossReleaseGateManifest({
    createdAt: "2026-07-02T00:00:00.000Z",
  }).gates.map((gate) => gate.id);
}

async function writeReleaseGateReportArtifact(
  root: string,
  input: {
    readonly name?: string | undefined;
    readonly createdAt?: string | undefined;
    readonly gateIds?: ReadonlyArray<string> | undefined;
    readonly status?: "pass" | "fail" | undefined;
    readonly includeFreshnessEvidence?: boolean | undefined;
  } = {},
): Promise<void> {
  const createdAt = input.createdAt ?? "2026-07-02T00:00:00.000Z";
  const gateIds = input.gateIds ?? currentGateIds();
  const status = input.status ?? "pass";
  await writeFile(
    join(
      root,
      ".moss",
      "ledger",
      "evidence",
      input.name ?? "moss-release-gate-report-artifact-2026-07-02.json",
    ),
    `${JSON.stringify(
      {
        version: 1,
        createdAt,
        status,
        gates: gateIds.map((gateId) => {
          const gate: Record<string, unknown> = {
            id: gateId,
            status,
            exitCode: status === "pass" ? 0 : 1,
          };

          if (input.includeFreshnessEvidence && gateId === "release-gate-report-index") {
            gate.observedEvidence = {
              releaseGateReportIndex: {
                readinessStatus: "pass",
                manifestGateCount: currentGateIds().length,
                manifestGateIds: currentGateIds(),
                latestArtifactPath:
                  ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-02.json",
                latestArtifactCreatedAt: createdAt,
                latestArtifactStatus: status,
                latestArtifactGateCount: gateIds.length,
                latestArtifactGateIds: gateIds,
                issueCodes: [],
                staleArtifactMessages: [],
              },
            };
          }
          if (
            input.includeFreshnessEvidence &&
            gateId === "release-freshness-refresh-plan-report-index"
          ) {
            gate.observedEvidence = {
              releaseFreshnessRefreshPlanReportIndex: {
                readinessStatus: "pass",
                latestArtifactPath:
                  ".moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-02.json",
                latestArtifactCreatedAt: createdAt,
                latestArtifactStatus: status,
                mode: "dry-run",
                writesFiles: false,
                writesGlobalConfig: false,
                providerCredentialsRequired: false,
                requiresReleaseArtifactRefresh: false,
                requiresLoopFreshnessRefresh: false,
                requiresLoopRefreshPlanReportRefresh: false,
                issueCodes: [],
              },
            };
          }
          if (input.includeFreshnessEvidence && gateId === "loop-packet-freshness-report-index") {
            gate.observedEvidence = {
              loopPacketFreshnessReportIndex: {
                readinessStatus: "pass",
                latestArtifactPath:
                  ".moss/ledger/evidence/moss-loop-packet-freshness-gate-report-2026-07-02.json",
                latestArtifactCreatedAt: createdAt,
                latestArtifactStatus: status,
                latestTaskId: "moss-task-2",
                latestChainedRefreshTaskId: "moss-task-2",
                latestChainedRefreshProvenance: {
                  kind: "release-artifact-chain-freshness",
                  expected: true,
                  taskId: "moss-task-2",
                  source: "loop-packet-task-metadata",
                },
                latestCheckStatus: "pass",
                latestLoopPacketReadinessStatus: "ready",
                releaseFreshnessStatus: "pass",
                releaseFreshnessReadinessStatus: "pass",
                releaseFreshnessIssueCodes: [],
                issueCodes: [],
              },
            };
          }
          if (
            input.includeFreshnessEvidence &&
            gateId === "loop-packet-refresh-plan-report-index"
          ) {
            gate.observedEvidence = {
              loopPacketRefreshPlanReportIndex: {
                readinessStatus: "pass",
                latestArtifactPath:
                  ".moss/ledger/evidence/moss-loop-packet-refresh-plan-gate-report-2026-07-02.json",
                latestArtifactCreatedAt: createdAt,
                latestArtifactStatus: status,
                latestTaskId: "moss-task-2",
                latestChainedRefreshTaskId: "moss-task-2",
                latestChainedRefreshProvenance: {
                  kind: "release-artifact-chain-freshness",
                  expected: true,
                  taskId: "moss-task-2",
                  source: "loop-packet-task-metadata",
                },
                latestCheckStatus: "pass",
                latestLoopPacketReadinessStatus: "ready",
                writesFiles: false,
                writesGlobalConfig: false,
                providerCredentialsRequired: false,
                refreshPlanStatus: "pass",
                refreshPlanReadinessStatus: "pass",
                refreshPlanArtifactPath:
                  ".moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-02-gate.json",
                refreshPlanExpectedStepCount: MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER.length,
                refreshPlanLatestStepCount: MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER.length,
                refreshPlanLatestArtifactStatus: status,
                refreshPlanMode: "dry-run",
                refreshPlanWritesFiles: false,
                refreshPlanWritesGlobalConfig: false,
                refreshPlanProviderCredentialsRequired: false,
                refreshPlanRequiresReleaseArtifactRefresh: false,
                refreshPlanRequiresLoopFreshnessRefresh: false,
                refreshPlanIssueCodes: [],
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
  input: {
    readonly name?: string | undefined;
    readonly createdAt?: string | undefined;
    readonly status?: "pass" | "fail" | undefined;
    readonly stepOrder?: ReadonlyArray<string> | undefined;
  } = {},
): Promise<void> {
  const createdAt = input.createdAt ?? "2026-07-02T00:00:00.000Z";
  const status = input.status ?? "pass";
  const stepOrder = input.stepOrder ?? MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER;
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
      input.name ?? "moss-release-freshness-refresh-plan-report-2026-07-02.json",
    ),
    `${JSON.stringify(
      {
        version: 1,
        createdAt,
        status,
        providerCredentialsRequired: false,
        writesGlobalConfig: false,
        plan: {
          mode: "dry-run",
          writesFiles: false,
          writesGlobalConfig: false,
          readiness: {
            status,
          },
          artifactOutputs: {
            releaseGateReport:
              ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-02-refresh.json",
            loopPacketFreshnessReport:
              ".moss/ledger/evidence/moss-loop-packet-freshness-gate-report-2026-07-02-refresh.json",
            releaseFreshnessRefreshPlanReport:
              ".moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-02-gate.json",
            loopPacketRefreshPlanReport:
              ".moss/ledger/evidence/moss-loop-packet-refresh-plan-gate-report-2026-07-02.json",
          },
          state: {
            requiresReleaseArtifactRefresh: false,
            requiresLoopFreshnessRefresh: false,
            requiresLoopRefreshPlanReportRefresh: false,
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
      },
      null,
      2,
    )}\n`,
  );
}

describe("moss-loop-ledger-snapshot", () => {
  it("generates a typed dashboard snapshot from mission, ledger, evidence, and roles", async () => {
    const root = join(process.cwd(), ".tmp", "moss-loop-ledger-snapshot-test");
    await writeMossRepo(root, {
      events: [
        {
          eventId: "moss-event-1",
          type: "moss.goal.defined",
          createdAt: "2026-07-01T00:00:00.000Z",
          payload: {
            goal: "Build a Codex-like shell",
            branch: "moss/control-plane-v1",
          },
        },
        {
          eventId: "moss-event-2",
          type: "moss.task.started",
          createdAt: "2026-07-01T00:01:00.000Z",
          correlationId: "iteration-1",
          payload: {
            taskId: "moss-task-2",
            title: "Generate Loop Ledger Dashboard snapshot from .moss ledger",
          },
          evidence: [".moss/ledger/tasks.jsonl"],
        },
        {
          eventId: "moss-event-3",
          type: "moss.evidence.recorded",
          createdAt: "2026-07-01T00:02:00.000Z",
          correlationId: "iteration-1",
          evidence: ["snapshot-evidence.md", "bun --filter @synara/scripts test -- snapshot"],
        },
        {
          eventId: "moss-event-4",
          type: "moss.review.completed",
          createdAt: "2026-07-01T00:03:00.000Z",
          actor: { role: "Reviewer" },
          correlationId: "iteration-1",
          payload: {
            decision: "accepted",
            notes: "Snapshot is ledger-backed and UI typed.",
          },
          evidence: ["snapshot-evidence.md"],
        },
      ],
      tasks: [
        {
          taskId: "moss-task-1",
          status: "done",
          owner: "QA Gatekeeper",
          title: "Run tests",
          acceptance: ["Tests pass"],
          evidence: ["bun run moss:status"],
        },
        {
          taskId: "moss-task-2",
          status: "active",
          owner: "Runtime Adapter Engineer",
          title: "Generate Loop Ledger Dashboard snapshot from .moss ledger",
          acceptance: ["Snapshot uses typed shape"],
          evidence: [],
        },
      ],
    });
    await writeReleaseGateReportArtifact(root, { includeFreshnessEvidence: true });
    await writeRefreshPlanReportArtifact(root);

    const snapshot = await readMossLoopLedgerDashboardSnapshot(root, {
      createdAt: "2026-07-02T00:00:00.000Z",
    });
    const model = deriveMossLoopLedgerDashboardModel(snapshot);

    expect(snapshot).toMatchObject({
      version: 1,
      generatedAt: "2026-07-02T00:00:00.000Z",
      mission: {
        title: "Moss Shell Mission",
        currentGoal: "Build a Codex-like shell",
        branch: "moss/control-plane-v1",
        status: "active",
      },
      tasks: {
        total: 2,
        counts: {
          active: 1,
          done: 1,
          blocked: 0,
        },
      },
      releaseGate: {
        status: "pass",
        issueCount: 0,
        freshness: {
          status: "pass",
          readinessStatus: "pass",
          manifestGateCount: currentGateIds().length,
          latestArtifactGateCount: currentGateIds().length,
          issueCount: 0,
          issueCodes: [],
        },
        refreshPlan: {
          status: "pass",
          readinessStatus: "pass",
          expectedStepCount: MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER.length,
          latestStepCount: MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER.length,
          latestArtifactStatus: "pass",
          mode: "dry-run",
          writesFiles: false,
          writesGlobalConfig: false,
          providerCredentialsRequired: false,
          issueCount: 0,
          issueCodes: [],
        },
      },
    });
    expect(snapshot.tasks.active).toEqual([
      {
        taskId: "moss-task-2",
        title: "Generate Loop Ledger Dashboard snapshot from .moss ledger",
        owner: "Runtime Adapter Engineer",
        status: "active",
        acceptanceCount: 1,
        evidenceCount: 0,
      },
    ]);
    expect(snapshot.tasks.next).toEqual([
      "Continue generated ledger snapshot wiring.",
      "Re-run the loop gate.",
    ]);
    expect(snapshot.reviews.recent[0]).toMatchObject({
      eventId: "moss-event-4",
      taskId: "moss-task-2",
      decision: "accepted",
    });
    expect(snapshot.evidence.indexedArtifacts).toBe(2);
    expect(snapshot.evidence.commandReferences).toBe(2);
    expect(snapshot.evidence.recent[0]).toEqual({
      label: "snapshot-evidence.md",
      kind: "file",
      status: "pass",
    });
    expect(snapshot.roles).toEqual(
      expect.arrayContaining([
        {
          role: "Runtime Adapter Engineer",
          activeTaskCount: 1,
          responsibility: "Own provider launch and event ingestion.",
          status: "assigned",
        },
      ]),
    );
    expect(model.status).toBe("pass");
    expect(model.metricRows).toContainEqual({
      label: "Active",
      value: "1",
      tone: "pending",
    });
    expect(model.metricRows).toContainEqual({
      label: "Freshness",
      value: `${currentGateIds().length}/${currentGateIds().length} gates`,
      tone: "pass",
    });
    expect(model.releaseFreshness).toMatchObject({
      readinessLabel: "pass",
      manifestGateCountLabel: String(currentGateIds().length),
      latestArtifactGateCountLabel: String(currentGateIds().length),
      issueCountLabel: "0",
    });
    expect(model.metricRows).toContainEqual({
      label: "Refresh Plan",
      value: `${MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER.length}/${MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER.length} steps`,
      tone: "pass",
    });
    expect(model.refreshPlan).toMatchObject({
      readinessLabel: "pass",
      latestStepCountLabel: String(MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER.length),
      expectedStepCountLabel: String(MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER.length),
      issueCountLabel: "0",
      latestArtifactStatusLabel: "pass",
      modeLabel: "dry-run",
      writeFlagsLabel: "files no / global no / creds no",
    });

    await rm(root, { force: true, recursive: true });
  });

  it("surfaces missing refresh plan report index evidence as a typed fallback", async () => {
    const root = join(process.cwd(), ".tmp", "moss-loop-ledger-snapshot-missing-refresh-plan-test");
    await writeMossRepo(root, {
      events: [
        {
          eventId: "moss-event-1",
          type: "moss.goal.defined",
          createdAt: "2026-07-01T00:00:00.000Z",
          payload: {
            goal: "Build a Codex-like shell",
            branch: "moss/control-plane-v1",
          },
        },
      ],
      tasks: [
        {
          taskId: "moss-task-1",
          status: "active",
          owner: "UI Parity Engineer",
          title: "Expose refresh plan evidence",
          acceptance: ["Dashboard shows refresh plan evidence"],
          evidence: [],
        },
      ],
    });
    await writeReleaseGateReportArtifact(root, { includeFreshnessEvidence: true });

    const snapshot = await readMossLoopLedgerDashboardSnapshot(root, {
      createdAt: "2026-07-02T00:00:00.000Z",
    });

    expect(snapshot.releaseGate.refreshPlan).toMatchObject({
      status: "blocked",
      readinessStatus: "fail",
      expectedStepCount: MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER.length,
      issueCount: 1,
      issueCodes: ["missing-artifacts"],
    });
    expect(deriveMossLoopLedgerDashboardModel(snapshot).refreshPlan).toMatchObject({
      statusLabel: "Blocked",
      latestStepCountLabel: "none",
      artifactPathLabel: "No refresh plan report artifact",
      issueCountLabel: "1",
    });
    expect(JSON.stringify(snapshot.releaseGate.refreshPlan)).not.toContain("stdout");

    await rm(root, { force: true, recursive: true });
  });

  it("surfaces failing refresh plan report index evidence as a typed fallback", async () => {
    const root = join(process.cwd(), ".tmp", "moss-loop-ledger-snapshot-failing-refresh-plan-test");
    await writeMossRepo(root, {
      events: [
        {
          eventId: "moss-event-1",
          type: "moss.goal.defined",
          createdAt: "2026-07-01T00:00:00.000Z",
          payload: {
            goal: "Build a Codex-like shell",
            branch: "moss/control-plane-v1",
          },
        },
      ],
      tasks: [
        {
          taskId: "moss-task-1",
          status: "active",
          owner: "UI Parity Engineer",
          title: "Expose refresh plan evidence",
          acceptance: ["Dashboard shows failing refresh plan evidence"],
          evidence: [],
        },
      ],
    });
    await writeReleaseGateReportArtifact(root, { includeFreshnessEvidence: true });
    await writeRefreshPlanReportArtifact(root, { status: "fail" });

    const snapshot = await readMossLoopLedgerDashboardSnapshot(root, {
      createdAt: "2026-07-02T00:00:00.000Z",
    });
    const model = deriveMossLoopLedgerDashboardModel(snapshot);

    expect(snapshot.releaseGate.refreshPlan).toMatchObject({
      status: "blocked",
      readinessStatus: "fail",
      expectedStepCount: MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER.length,
      latestStepCount: MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER.length,
      latestArtifactStatus: "fail",
      mode: "dry-run",
      writesFiles: false,
      writesGlobalConfig: false,
      providerCredentialsRequired: false,
      issueCount: 1,
      issueCodes: ["failing-artifact"],
    });
    expect(model.metricRows).toContainEqual({
      label: "Refresh Plan",
      value: `${MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER.length}/${MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER.length} steps`,
      tone: "blocked",
    });
    expect(model.refreshPlan).toMatchObject({
      statusLabel: "Blocked",
      issueCountLabel: "1",
      latestArtifactStatusLabel: "fail",
      writeFlagsLabel: "files no / global no / creds no",
    });

    await rm(root, { force: true, recursive: true });
  });

  it("surfaces missing release freshness as a typed fallback without raw stdout", async () => {
    const root = join(process.cwd(), ".tmp", "moss-loop-ledger-snapshot-missing-report-test");
    await writeMossRepo(root, {
      events: [
        {
          eventId: "moss-event-1",
          type: "moss.goal.defined",
          createdAt: "2026-07-01T00:00:00.000Z",
          payload: {
            goal: "Build a Codex-like shell",
            branch: "moss/control-plane-v1",
          },
        },
      ],
      tasks: [
        {
          taskId: "moss-task-1",
          status: "active",
          owner: "QA Gatekeeper",
          title: "Run tests",
          acceptance: ["Tests pass"],
          evidence: [],
        },
      ],
    });

    const snapshot = await readMossLoopLedgerDashboardSnapshot(root, {
      createdAt: "2026-07-02T00:00:00.000Z",
    });

    expect(snapshot.releaseGate.freshness).toMatchObject({
      status: "blocked",
      readinessStatus: "fail",
      manifestGateCount: currentGateIds().length,
      issueCount: 1,
      issueCodes: ["missing-artifacts"],
    });
    expect(deriveMossLoopLedgerDashboardModel(snapshot).releaseFreshness).toMatchObject({
      statusLabel: "Blocked",
      latestArtifactGateCountLabel: "none",
      issueCountLabel: "1",
    });
    expect(JSON.stringify(snapshot.releaseGate.freshness)).not.toContain("stdout");

    await rm(root, { force: true, recursive: true });
  });

  it("surfaces stale release freshness fallback from artifact index issues", async () => {
    const root = join(process.cwd(), ".tmp", "moss-loop-ledger-snapshot-stale-report-test");
    await writeMossRepo(root, {
      events: [
        {
          eventId: "moss-event-1",
          type: "moss.goal.defined",
          createdAt: "2026-07-01T00:00:00.000Z",
          payload: {
            goal: "Build a Codex-like shell",
            branch: "moss/control-plane-v1",
          },
        },
      ],
      tasks: [
        {
          taskId: "moss-task-1",
          status: "active",
          owner: "QA Gatekeeper",
          title: "Run tests",
          acceptance: ["Tests pass"],
          evidence: [],
        },
      ],
    });
    const staleGateIds = currentGateIds().filter(
      (gateId) => gateId !== "release-gate-report-index",
    );
    await writeReleaseGateReportArtifact(root, { gateIds: staleGateIds });

    const snapshot = await readMossLoopLedgerDashboardSnapshot(root, {
      createdAt: "2026-07-02T00:00:00.000Z",
    });

    expect(snapshot.releaseGate.freshness).toMatchObject({
      status: "blocked",
      readinessStatus: "fail",
      manifestGateCount: currentGateIds().length,
      latestArtifactGateCount: staleGateIds.length,
      issueCount: 1,
      issueCodes: ["stale-artifact"],
    });
    expect(snapshot.releaseGate.freshness?.staleArtifactMessages[0]).toContain(
      "stale against current release gate manifest",
    );
    expect(deriveMossLoopLedgerDashboardModel(snapshot).metricRows).toContainEqual({
      label: "Freshness",
      value: `${staleGateIds.length}/${currentGateIds().length} gates`,
      tone: "blocked",
    });

    await rm(root, { force: true, recursive: true });
  });

  it("prefers current artifact-index staleness over old embedded freshness evidence", async () => {
    const root = join(
      process.cwd(),
      ".tmp",
      "moss-loop-ledger-snapshot-old-embedded-freshness-test",
    );
    await writeMossRepo(root, {
      events: [
        {
          eventId: "moss-event-1",
          type: "moss.goal.defined",
          createdAt: "2026-07-01T00:00:00.000Z",
          payload: {
            goal: "Build a Codex-like shell",
            branch: "moss/control-plane-v1",
          },
        },
      ],
      tasks: [
        {
          taskId: "moss-task-1",
          status: "active",
          owner: "QA Gatekeeper",
          title: "Run tests",
          acceptance: ["Tests pass"],
          evidence: [],
        },
      ],
    });
    const staleGateIds = currentGateIds().filter(
      (gateId) => gateId !== "loop-packet-freshness-report-index",
    );
    await writeReleaseGateReportArtifact(root, {
      gateIds: staleGateIds,
      includeFreshnessEvidence: true,
    });

    const snapshot = await readMossLoopLedgerDashboardSnapshot(root, {
      createdAt: "2026-07-02T00:00:00.000Z",
    });

    expect(snapshot.releaseGate.freshness).toMatchObject({
      status: "blocked",
      readinessStatus: "fail",
      manifestGateCount: currentGateIds().length,
      latestArtifactGateCount: staleGateIds.length,
      issueCount: 1,
      issueCodes: ["stale-artifact"],
    });
    expect(snapshot.releaseGate.freshness?.staleArtifactMessages[0]).toContain(
      "missing [loop-packet-freshness-report-index]",
    );

    await rm(root, { force: true, recursive: true });
  });

  it("reports a blocked gate when a completed task has no evidence", async () => {
    const root = join(process.cwd(), ".tmp", "moss-loop-ledger-snapshot-blocked-test");
    await writeMossRepo(root, {
      events: [
        {
          eventId: "moss-event-1",
          type: "moss.goal.defined",
          createdAt: "2026-07-01T00:00:00.000Z",
          payload: {
            goal: "Build a Codex-like shell",
            branch: "moss/control-plane-v1",
          },
        },
      ],
      tasks: [
        {
          taskId: "moss-task-1",
          status: "done",
          owner: "QA Gatekeeper",
          title: "Run tests",
          acceptance: ["Tests pass"],
          evidence: [],
        },
      ],
    });

    const snapshot = await readMossLoopLedgerDashboardSnapshot(root, {
      createdAt: "2026-07-01T00:00:00.000Z",
    });

    expect(snapshot.mission.status).toBe("blocked");
    expect(snapshot.releaseGate).toMatchObject({
      status: "blocked",
      issueCount: 1,
    });
    expect(snapshot.releaseGate.checks).toContainEqual({
      id: "completed-task-evidence",
      label: "Completed Task Evidence",
      status: "blocked",
      issueCount: 1,
      summary: "One or more completed tasks have no evidence references.",
    });
    expect(snapshot.evidence.missingCompletedTaskEvidence).toBe(1);
    expect(deriveMossLoopLedgerDashboardModel(snapshot).status).toBe("blocked");

    await rm(root, { force: true, recursive: true });
  });
});
