import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  deriveMossLoopLedgerDashboardModel,
  MossLoopLedgerDashboard,
  type MossLoopLedgerDashboardSnapshot,
  MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT,
} from "./mossLoopLedgerDashboard";

function snapshotWith(
  patch: Partial<MossLoopLedgerDashboardSnapshot>,
): MossLoopLedgerDashboardSnapshot {
  return {
    ...MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT,
    ...patch,
    mission: {
      ...MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT.mission,
      ...patch.mission,
    },
    tasks: {
      ...MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT.tasks,
      ...patch.tasks,
      counts: {
        ...MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT.tasks.counts,
        ...patch.tasks?.counts,
      },
    },
    reviews: {
      ...MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT.reviews,
      ...patch.reviews,
    },
    evidence: {
      ...MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT.evidence,
      ...patch.evidence,
    },
    releaseGate: {
      ...MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT.releaseGate,
      ...patch.releaseGate,
    },
  };
}

describe("mossLoopLedgerDashboard", () => {
  it("derives a pass model from a typed snapshot", () => {
    const model = deriveMossLoopLedgerDashboardModel(MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT);

    expect(model.status).toBe("pass");
    expect(model.statusLabel).toBe("Pass");
    expect(model.metricRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Tasks", value: "18/19 done" }),
        expect.objectContaining({ label: "Evidence", value: "205" }),
      ]),
    );
    expect(model.activeTasks).toHaveLength(1);
    expect(model.roles.some((role) => role.role === "Runtime Adapter Engineer")).toBe(true);
    expect(model.releaseFreshness).toBeNull();
    expect(model.refreshPlan).toBeNull();
  });

  it("renders typed release freshness evidence when the snapshot provides it", () => {
    const snapshot = snapshotWith({
      releaseGate: {
        ...MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT.releaseGate,
        freshness: {
          status: "pass",
          readinessStatus: "pass",
          summary:
            "Latest Moss release gate artifact is pass: .moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-02.json.",
          manifestGateCount: 9,
          latestArtifactGateCount: 9,
          artifactPath: ".moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-02.json",
          latestArtifactCreatedAt: "2026-07-02T00:00:00.000Z",
          latestArtifactStatus: "pass",
          issueCount: 0,
          issueCodes: [],
          staleArtifactMessages: [],
        },
      },
    });
    const model = deriveMossLoopLedgerDashboardModel(snapshot);
    const markup = renderToStaticMarkup(<MossLoopLedgerDashboard snapshot={snapshot} />);

    expect(model.releaseFreshness).toMatchObject({
      status: "pass",
      statusLabel: "Pass",
      readinessLabel: "pass",
      manifestGateCountLabel: "9",
      latestArtifactGateCountLabel: "9",
      issueCountLabel: "0",
    });
    expect(model.metricRows).toContainEqual({
      label: "Freshness",
      value: "9/9 gates",
      tone: "pass",
    });
    expect(markup).toContain("data-moss-ledger-release-freshness");
    expect(markup).toContain("Artifact freshness");
    expect(markup).toContain("Manifest gates");
    expect(markup).toContain("Latest gates");
    expect(markup).toContain("0");
    expect(markup).not.toContain("rawSource");
    expect(markup).not.toContain("stdout");
  });

  it("renders release freshness fallback states for stale or missing evidence", () => {
    const staleSnapshot = snapshotWith({
      releaseGate: {
        ...MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT.releaseGate,
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
      },
    });
    const staleMarkup = renderToStaticMarkup(<MossLoopLedgerDashboard snapshot={staleSnapshot} />);
    const missingMarkup = renderToStaticMarkup(
      <MossLoopLedgerDashboard snapshot={MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT} />,
    );

    expect(deriveMossLoopLedgerDashboardModel(staleSnapshot).releaseFreshness).toMatchObject({
      status: "blocked",
      latestArtifactGateCountLabel: "8",
      issueCountLabel: "1",
    });
    expect(staleMarkup).toContain('data-status="blocked"');
    expect(staleMarkup).toContain("8");
    expect(staleMarkup).toContain("9");
    expect(staleMarkup).toContain("Moss release gate artifact index has 1 issue(s).");
    expect(missingMarkup).toContain('data-moss-ledger-release-freshness="missing"');
    expect(missingMarkup).toContain("Freshness evidence unavailable");
  });

  it("renders typed refresh plan report index evidence when the snapshot provides it", () => {
    const snapshot = snapshotWith({
      releaseGate: {
        ...MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT.releaseGate,
        refreshPlan: {
          status: "pass",
          readinessStatus: "pass",
          summary:
            "Latest Moss release freshness refresh plan report is pass: .moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-02.json.",
          expectedStepCount: 7,
          latestStepCount: 7,
          artifactPath:
            ".moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-02.json",
          latestArtifactCreatedAt: "2026-07-02T00:01:05.000Z",
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
      },
    });
    const model = deriveMossLoopLedgerDashboardModel(snapshot);
    const markup = renderToStaticMarkup(<MossLoopLedgerDashboard snapshot={snapshot} />);

    expect(model.refreshPlan).toMatchObject({
      status: "pass",
      statusLabel: "Pass",
      readinessLabel: "pass",
      latestStepCountLabel: "7",
      expectedStepCountLabel: "7",
      issueCountLabel: "0",
      artifactPathLabel:
        ".moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-02.json",
      latestArtifactStatusLabel: "pass",
      modeLabel: "dry-run",
      writeFlagsLabel: "files no / global no / creds no",
    });
    expect(model.metricRows).toContainEqual({
      label: "Refresh Plan",
      value: "7/7 steps",
      tone: "pass",
    });
    expect(markup).toContain("data-moss-ledger-refresh-plan");
    expect(markup).toContain("Refresh plan");
    expect(markup).toContain("Artifact status");
    expect(markup).toContain("files no / global no / creds no");
    expect(markup).toContain(
      ".moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-02.json",
    );
    expect(markup).not.toContain("rawSource");
    expect(markup).not.toContain("stdout");
  });

  it("renders refresh plan fallback states for failing or missing evidence", () => {
    const failingSnapshot = snapshotWith({
      releaseGate: {
        ...MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT.releaseGate,
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
    const failingMarkup = renderToStaticMarkup(
      <MossLoopLedgerDashboard snapshot={failingSnapshot} />,
    );
    const missingMarkup = renderToStaticMarkup(
      <MossLoopLedgerDashboard snapshot={MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT} />,
    );

    expect(deriveMossLoopLedgerDashboardModel(failingSnapshot).refreshPlan).toMatchObject({
      status: "blocked",
      latestStepCountLabel: "6",
      expectedStepCountLabel: "7",
      issueCountLabel: "1",
      refreshStateLabel: "release yes / loop yes",
    });
    expect(failingMarkup).toContain('data-moss-ledger-refresh-plan=""');
    expect(failingMarkup).toContain('data-status="blocked"');
    expect(failingMarkup).toContain(
      "Moss release freshness refresh plan report index has 1 issue(s).",
    );
    expect(missingMarkup).toContain('data-moss-ledger-refresh-plan="missing"');
    expect(missingMarkup).toContain("Refresh plan evidence unavailable");
  });

  it("renders the pending dashboard state for an active task without evidence", () => {
    const snapshot = snapshotWith({
      releaseGate: {
        status: "pending",
        issueCount: 0,
        summary: "Reviewer decision is pending for the active dashboard task.",
        checks: [
          {
            id: "review-decision",
            label: "Reviewer decision",
            status: "pending",
            summary: "Active task needs Reviewer decision before completion.",
            issueCount: 0,
          },
        ],
      },
    });
    const markup = renderToStaticMarkup(<MossLoopLedgerDashboard snapshot={snapshot} />);

    expect(markup).toContain("data-moss-loop-ledger-dashboard");
    expect(markup).toContain('data-status="pending"');
    expect(markup).toContain("Loop Ledger");
    expect(markup).toContain("moss-task-0019");
    expect(markup).toContain("Runtime Adapter Engineer");
    expect(markup).toContain("Reviewer decision");
    expect(markup).not.toContain("events.jsonl");
    expect(markup).not.toContain("tasks.jsonl");
  });

  it("renders the blocked dashboard state with gate issues and missing evidence", () => {
    const snapshot = snapshotWith({
      tasks: {
        total: 19,
        counts: {
          active: 1,
          done: 17,
          blocked: 1,
        },
        active: MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT.tasks.active,
        next: MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT.tasks.next,
      },
      evidence: {
        ...MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT.evidence,
        missingCompletedTaskEvidence: 1,
      },
      releaseGate: {
        status: "blocked",
        issueCount: 1,
        summary: "One completed task is missing evidence.",
        checks: [
          {
            id: "completed-task-evidence",
            label: "Completed task evidence",
            status: "blocked",
            summary: "One or more completed tasks have no evidence references.",
            issueCount: 1,
          },
        ],
      },
    });
    const markup = renderToStaticMarkup(<MossLoopLedgerDashboard snapshot={snapshot} />);

    expect(markup).toContain('data-status="blocked"');
    expect(markup).toContain("Blocked");
    expect(markup).toContain("One completed task is missing evidence.");
    expect(markup).toContain("1 issues");
    expect(markup).toContain("Missing");
  });
});
