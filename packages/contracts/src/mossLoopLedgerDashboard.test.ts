import { describe, expect, it } from "vitest";

import {
  deriveMossLoopLedgerDashboardModel,
  type MossLoopLedgerDashboardSnapshot,
} from "./mossLoopLedgerDashboard";

const baseSnapshot: MossLoopLedgerDashboardSnapshot = {
  version: 1,
  generatedAt: "2026-07-01T00:00:00.000Z",
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
    active: [
      {
        taskId: "moss-task-2",
        title: "Generate dashboard snapshot",
        owner: "Runtime Adapter Engineer",
        status: "active",
        acceptanceCount: 2,
        evidenceCount: 0,
      },
    ],
    next: ["Continue."],
  },
  reviews: {
    recent: [
      {
        eventId: "moss-event-4",
        taskId: "moss-task-1",
        role: "Reviewer",
        decision: "accepted",
        createdAt: "2026-07-01T00:03:00.000Z",
        notes: "Accepted.",
      },
    ],
  },
  evidence: {
    indexedArtifacts: 2,
    taskEvidenceReferences: 1,
    commandReferences: 1,
    missingCompletedTaskEvidence: 0,
    recent: [
      {
        label: "bun run moss:status",
        kind: "command",
        status: "pass",
      },
    ],
  },
  roles: [
    {
      role: "Runtime Adapter Engineer",
      activeTaskCount: 1,
      responsibility: "Own provider launch.",
      status: "assigned",
    },
  ],
  releaseGate: {
    status: "pass",
    issueCount: 0,
    summary: "Gate passed.",
    freshness: {
      status: "pass",
      readinessStatus: "pass",
      summary: "Latest Moss release gate artifact is pass.",
      manifestGateCount: 9,
      latestArtifactGateCount: 9,
      artifactPath: ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-02.json",
      latestArtifactCreatedAt: "2026-07-02T00:00:00.000Z",
      latestArtifactStatus: "pass",
      issueCount: 0,
      issueCodes: [],
      staleArtifactMessages: [],
    },
    refreshPlan: {
      status: "pass",
      readinessStatus: "pass",
      summary: "Latest Moss release freshness refresh plan report is pass.",
      expectedStepCount: 7,
      latestStepCount: 7,
      artifactPath:
        ".moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-02.json",
      latestArtifactCreatedAt: "2026-07-02T00:00:00.000Z",
      latestArtifactStatus: "pass",
      mode: "dry-run",
      writesFiles: false,
      writesGlobalConfig: false,
      providerCredentialsRequired: false,
      requiresReleaseArtifactRefresh: false,
      requiresLoopFreshnessRefresh: false,
      issueCount: 0,
      issueCodes: [],
    },
    checks: [
      {
        id: "completed-task-evidence",
        label: "Completed task evidence",
        status: "pass",
        summary: "Every completed task has evidence.",
        issueCount: 0,
      },
    ],
  },
};

describe("mossLoopLedgerDashboard contracts", () => {
  it("derives pass and pending tones from a typed snapshot", () => {
    const model = deriveMossLoopLedgerDashboardModel(baseSnapshot);

    expect(model.status).toBe("pass");
    expect(model.statusLabel).toBe("Pass");
    expect(model.metricRows).toEqual(
      expect.arrayContaining([
        { label: "Tasks", value: "1/2 done", tone: "muted" },
        { label: "Active", value: "1", tone: "pending" },
        { label: "Freshness", value: "9/9 gates", tone: "pass" },
        { label: "Refresh Plan", value: "7/7 steps", tone: "pass" },
      ]),
    );
    expect(model.activeTasks).toHaveLength(1);
    expect(model.releaseFreshness).toMatchObject({
      status: "pass",
      statusLabel: "Pass",
      readinessLabel: "pass",
      manifestGateCountLabel: "9",
      latestArtifactGateCountLabel: "9",
      issueCountLabel: "0",
    });
    expect(model.refreshPlan).toMatchObject({
      status: "pass",
      statusLabel: "Pass",
      readinessLabel: "pass",
      expectedStepCountLabel: "7",
      latestStepCountLabel: "7",
      issueCountLabel: "0",
      latestArtifactStatusLabel: "pass",
      modeLabel: "dry-run",
      writeFlagsLabel: "files no / global no / creds no",
      refreshStateLabel: "release no / loop no",
    });
  });

  it("derives blocked tones for failed gate evidence", () => {
    const model = deriveMossLoopLedgerDashboardModel({
      ...baseSnapshot,
      evidence: {
        ...baseSnapshot.evidence,
        missingCompletedTaskEvidence: 1,
      },
      releaseGate: {
        ...baseSnapshot.releaseGate,
        status: "blocked",
        issueCount: 1,
        summary: "Gate blocked.",
        freshness: {
          status: "blocked",
          readinessStatus: "fail",
          summary: "Moss release gate artifact index has 1 issue(s).",
          manifestGateCount: 9,
          latestArtifactGateCount: 8,
          issueCount: 1,
          issueCodes: ["stale-artifact"],
          staleArtifactMessages: ["Latest artifact is stale."],
        },
        refreshPlan: {
          status: "blocked",
          readinessStatus: "fail",
          summary: "Moss release freshness refresh plan report index has 1 issue(s).",
          expectedStepCount: 7,
          latestStepCount: 6,
          latestArtifactStatus: "fail",
          mode: "dry-run",
          writesFiles: false,
          writesGlobalConfig: false,
          providerCredentialsRequired: false,
          requiresReleaseArtifactRefresh: true,
          requiresLoopFreshnessRefresh: true,
          issueCount: 1,
          issueCodes: ["failing-artifact"],
        },
      },
    });

    expect(model.status).toBe("blocked");
    expect(model.statusLabel).toBe("Blocked");
    expect(model.metricRows).toContainEqual({
      label: "Evidence",
      value: "1",
      tone: "blocked",
    });
    expect(model.metricRows).toContainEqual({
      label: "Freshness",
      value: "8/9 gates",
      tone: "blocked",
    });
    expect(model.metricRows).toContainEqual({
      label: "Refresh Plan",
      value: "6/7 steps",
      tone: "blocked",
    });
    expect(model.releaseFreshness?.issueCountLabel).toBe("1");
    expect(model.refreshPlan?.issueCountLabel).toBe("1");
    expect(model.refreshPlan?.writeFlagsLabel).toBe("files no / global no / creds no");
  });
});
