import {
  EventId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type MossNormalizedSessionEvent,
  type ProviderGetLaunchPlanResult,
  type ProviderSession,
} from "@synara/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MossLaunchPlanInspector } from "./mossLaunchPlanInspector";
import {
  MossLoopLedgerDashboard,
  type MossLoopLedgerDashboardSnapshot,
  MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT,
} from "./mossLoopLedgerDashboard";
import {
  deriveMossControlPlaneEventScope,
  deriveMossControlPlaneSessionListModel,
  deriveMossControlPlaneSessionSummaryModel,
  MossControlPlanePanel,
  MossControlPlanePanelView,
  MossControlPlaneSessionList,
  MossControlPlaneSessionSummary,
  MossLoopLedgerDashboardSurface,
  selectMossControlPlaneSessionRow,
} from "./MossControlPlanePanel";

const threadId = ThreadId.makeUnsafe("thread-moss-control-plane-1");
const turnId = TurnId.makeUnsafe("turn-moss-control-plane-1");
const sessionId = RuntimeSessionId.makeUnsafe("runtime-session-moss-control-plane-1");

function normalizedEvent(payload: Record<string, unknown>): MossNormalizedSessionEvent {
  return {
    eventId: EventId.makeUnsafe("moss-normalized-control-plane-1"),
    type: "text",
    provider: "codex",
    sessionId,
    threadId,
    turnId,
    createdAt: "2026-07-01T00:00:01.000Z",
    rawEventId: EventId.makeUnsafe("raw-control-plane-1"),
    payload,
  };
}

function providerSession(overrides: Partial<ProviderSession> = {}): ProviderSession {
  return {
    provider: "codex",
    status: "running",
    runtimeMode: "full-access",
    cwd: "/repo",
    model: "gpt-5.3-codex",
    threadId,
    activeTurnId: turnId,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:02:00.000Z",
    ...overrides,
  };
}

function dashboardSnapshotWithActiveTask(taskId: string): MossLoopLedgerDashboardSnapshot {
  return {
    ...MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT,
    tasks: {
      ...MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT.tasks,
      active: [
        {
          taskId,
          title: "Provided dashboard snapshot",
          owner: "UI Parity Engineer",
          status: "active",
          acceptanceCount: 4,
          evidenceCount: 2,
        },
      ],
    },
  };
}

function dashboardSnapshotWithGate(
  status: MossLoopLedgerDashboardSnapshot["releaseGate"]["status"],
): MossLoopLedgerDashboardSnapshot {
  return {
    ...MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT,
    releaseGate: {
      ...MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT.releaseGate,
      status,
      issueCount: status === "blocked" ? 1 : 0,
      summary: `${status} release gate`,
    },
  };
}

describe("MossControlPlanePanel", () => {
  it("renders the normalized events surface without exposing provider raw payloads", () => {
    const markup = renderToStaticMarkup(
      <MossControlPlanePanelView
        activeSurface="events"
        events={[
          normalizedEvent({
            text: "assistant text",
            streamKind: "assistant_text",
            rawSource: "codex.eventmsg",
          }),
        ]}
        launchPlanInspector={<MossLaunchPlanInspector status="idle" />}
        loopLedgerDashboard={
          <MossLoopLedgerDashboard snapshot={MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT} />
        }
        threadLabel={String(threadId)}
      />,
    );

    expect(markup).toContain("data-moss-control-plane");
    expect(markup).toContain("data-moss-control-plane-events");
    expect(markup).toContain("Moss Control");
    expect(markup).toContain("thread-moss-control-plane-1");
    expect(markup).toContain("Assistant text");
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).not.toContain("codex.eventmsg");
  });

  it("marks the product-shell control plane and event viewport when product mode is enabled", () => {
    const markup = renderToStaticMarkup(
      <MossControlPlanePanelView
        activeSurface="events"
        events={[
          normalizedEvent({
            text: "assistant text",
            streamKind: "assistant_text",
            rawSource: "codex.eventmsg",
          }),
        ]}
        launchPlanInspector={<MossLaunchPlanInspector status="idle" />}
        loopLedgerDashboard={
          <MossLoopLedgerDashboard snapshot={MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT} />
        }
        productShellMode
        threadLabel={String(threadId)}
      />,
    );

    expect(markup).toContain('data-moss-product-shell-control-plane="true"');
    expect(markup).toContain('data-moss-product-shell-events-viewport="true"');
  });

  it("renders selected-session scope metadata on the normalized events surface", () => {
    const markup = renderToStaticMarkup(
      <MossControlPlanePanelView
        activeSurface="events"
        eventScope={{
          threadId: String(threadId),
          sessionId: String(sessionId),
          label: "Codex / thread-moss-control-plane-1",
          activeThread: true,
          onClear: () => undefined,
        }}
        events={[
          normalizedEvent({
            text: "assistant text",
            streamKind: "assistant_text",
            rawSource: "codex.eventmsg",
          }),
        ]}
        launchPlanInspector={<MossLaunchPlanInspector status="idle" />}
        loopLedgerDashboard={
          <MossLoopLedgerDashboard snapshot={MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT} />
        }
        threadLabel={String(threadId)}
      />,
    );

    expect(markup).toContain("data-moss-normalized-session-scope");
    expect(markup).toContain(`data-scope-thread-id="${String(threadId)}"`);
    expect(markup).toContain(`data-scope-session-id="${String(sessionId)}"`);
    expect(markup).toContain("data-moss-normalized-session-scope-clear");
    expect(markup).toContain("assistant text");
    expect(markup).not.toContain("codex.eventmsg");
  });

  it("renders the launch-plan loading state", () => {
    const markup = renderToStaticMarkup(
      <MossControlPlanePanelView
        activeSurface="launch-plan"
        events={[]}
        launchPlanInspector={<MossLaunchPlanInspector status="loading" />}
        loopLedgerDashboard={
          <MossLoopLedgerDashboard snapshot={MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT} />
        }
      />,
    );

    expect(markup).toContain("data-moss-control-plane-launch-plan");
    expect(markup).toContain("data-moss-launch-plan-loading");
    expect(markup).toContain("Loading launch plan");
    expect(markup).not.toContain("No normalized events");
  });

  it("renders the launch-plan missing state", () => {
    const result: ProviderGetLaunchPlanResult = {
      threadId,
      planHash: null,
      launchPlan: null,
    };
    const markup = renderToStaticMarkup(
      <MossControlPlanePanelView
        activeSurface="launch-plan"
        events={[]}
        launchPlanInspector={<MossLaunchPlanInspector result={result} />}
        loopLedgerDashboard={
          <MossLoopLedgerDashboard snapshot={MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT} />
        }
      />,
    );

    expect(markup).toContain("data-moss-launch-plan-missing");
    expect(markup).toContain("No launch plan for this session");
    expect(markup).toContain("thread-moss-control-plane-1");
  });

  it("renders the loop-ledger dashboard surface from a typed snapshot", () => {
    const markup = renderToStaticMarkup(
      <MossControlPlanePanelView
        activeSurface="ledger"
        events={[]}
        launchPlanInspector={<MossLaunchPlanInspector status="idle" />}
        loopLedgerDashboard={
          <MossLoopLedgerDashboard snapshot={MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT} />
        }
      />,
    );

    expect(markup).toContain("data-moss-control-plane-ledger");
    expect(markup).toContain("data-moss-loop-ledger-dashboard");
    expect(markup).toContain("Loop Ledger");
    expect(markup).toContain("moss-task-0018");
    expect(markup).toContain("UI Parity Engineer");
    expect(markup).toContain("data-moss-ledger-release-gate");
    expect(markup).not.toContain("No normalized events");
  });

  it("uses the static dashboard fallback before a runtime bridge snapshot is available", () => {
    const markup = renderToStaticMarkup(
      <MossControlPlanePanel defaultSurface="ledger" threadId={threadId} />,
    );

    expect(markup).toContain("data-moss-control-plane-summary");
    expect(markup).toContain("data-moss-control-plane-ledger");
    expect(markup).toContain("data-moss-loop-ledger-snapshot-state");
    expect(markup).toContain('data-source="fallback"');
    expect(markup).toContain('data-status="idle"');
    expect(markup).toContain("Fallback");
    expect(markup).toContain("Idle");
    expect(markup).toContain("Refresh ledger snapshot");
    expect(markup).toContain("data-moss-loop-ledger-dashboard");
    expect(markup).toContain("moss-task-0019");
    expect(markup).not.toContain("events.jsonl");
  });

  it("accepts an injected dashboard snapshot from the app/runtime boundary", () => {
    const markup = renderToStaticMarkup(
      <MossControlPlanePanel
        defaultSurface="ledger"
        loopLedgerDashboardSnapshot={dashboardSnapshotWithActiveTask("moss-task-provided-bridge")}
        threadId={threadId}
      />,
    );

    expect(markup).toContain("moss-task-provided-bridge");
    expect(markup).toContain("Provided dashboard snapshot");
    expect(markup).toContain("data-moss-control-plane-summary");
    expect(markup).toContain('data-source="provided"');
    expect(markup).toContain('data-status="ready"');
    expect(markup).toContain("Provided");
    expect(markup).toContain("Ready");
    expect(markup).not.toContain("moss-task-0019");
  });

  it("renders runtime snapshot source and refresh affordance for the ledger surface", () => {
    const markup = renderToStaticMarkup(
      <MossLoopLedgerDashboardSurface
        snapshot={dashboardSnapshotWithActiveTask("moss-task-runtime-state")}
        source="runtime"
        status="ready"
      />,
    );

    expect(markup).toContain("data-moss-loop-ledger-surface");
    expect(markup).toContain('data-source="runtime"');
    expect(markup).toContain('data-status="ready"');
    expect(markup).toContain("Runtime");
    expect(markup).toContain("Ready");
    expect(markup).toContain("Refresh ledger snapshot");
    expect(markup).toContain("moss-task-runtime-state");
    expect(markup).not.toContain("events.jsonl");
  });

  it("renders missing and error runtime bridge states without exposing ledger files", () => {
    const missing = renderToStaticMarkup(
      <MossLoopLedgerDashboardSurface
        snapshot={MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT}
        source="fallback"
        status="missing"
      />,
    );
    const error = renderToStaticMarkup(
      <MossLoopLedgerDashboardSurface
        error="Runtime bridge failed"
        snapshot={MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT}
        source="fallback"
        status="error"
      />,
    );

    expect(missing).toContain('data-status="missing"');
    expect(missing).toContain("Bridge missing");
    expect(error).toContain('data-status="error"');
    expect(error).toContain("Runtime bridge failed");
    expect(missing).not.toContain("tasks.jsonl");
    expect(error).not.toContain("events.jsonl");
  });

  it("derives an empty provider session list from typed view data", () => {
    const model = deriveMossControlPlaneSessionListModel({
      activeThreadId: null,
      events: [],
      sessions: [],
      source: "runtime",
      status: "ready",
    });
    const markup = renderToStaticMarkup(<MossControlPlaneSessionList model={model} />);

    expect(model.rows).toHaveLength(0);
    expect(markup).toContain("data-moss-control-plane-session-list");
    expect(markup).toContain('data-source="runtime"');
    expect(markup).toContain('data-status="ready"');
    expect(markup).toContain("No provider sessions");
    expect(markup).not.toContain("events.jsonl");
  });

  it("derives an active-thread fallback row from normalized events", () => {
    const model = deriveMossControlPlaneSessionListModel({
      activeThreadId: threadId,
      events: [
        normalizedEvent({
          text: "assistant text",
          launchPlanHash: "sha256:session-list-launch-plan",
          rawSource: "codex.eventmsg",
        }),
      ],
      sessions: [],
      source: "fallback",
      status: "missing",
    });
    const markup = renderToStaticMarkup(<MossControlPlaneSessionList compact model={model} />);

    expect(model.rows).toHaveLength(1);
    expect(model.rows[0]?.active).toBe(true);
    expect(model.rows[0]?.sessionId).toBe(String(sessionId));
    expect(model.rows[0]?.eventCount).toBe(1);
    expect(model.rows[0]?.launchPlanHash).toBe("sha256:session-list-launch-plan");
    expect(markup).toContain('data-active-thread="true"');
    expect(markup).toContain('data-event-count="1"');
    expect(markup).toContain(`data-session-id="${String(sessionId)}"`);
    expect(markup).toContain("Event replay");
    expect(markup).toContain("sha256:session-list-launch-plan");
    expect(markup).not.toContain("codex.eventmsg");
  });

  it("derives multi-session runtime rows with active-thread selection metadata", () => {
    const otherThreadId = ThreadId.makeUnsafe("thread-moss-control-plane-other");
    const model = deriveMossControlPlaneSessionListModel({
      activeThreadId: threadId,
      events: [
        normalizedEvent({
          text: "assistant text",
          launchPlanHash: "sha256:active-session-launch-plan",
        }),
      ],
      sessions: [
        providerSession(),
        providerSession({
          provider: "claudeAgent",
          status: "ready",
          runtimeMode: "approval-required",
          cwd: "/other-repo",
          model: "claude-sonnet-4-6",
          threadId: otherThreadId,
          createdAt: "2026-07-01T00:00:02.000Z",
          updatedAt: "2026-07-01T00:03:00.000Z",
        }),
      ],
      source: "runtime",
      status: "ready",
    });
    const markup = renderToStaticMarkup(<MossControlPlaneSessionList model={model} />);

    expect(model.rows).toHaveLength(2);
    expect(model.rows[0]?.threadId).toBe(String(threadId));
    expect(model.rows[0]?.sessionId).toBeNull();
    expect(model.rows[0]?.active).toBe(true);
    expect(model.rows[0]?.eventCount).toBe(1);
    expect(model.rows[1]?.providerLabel).toBe("Claude");
    expect(selectMossControlPlaneSessionRow(model, null)?.threadId).toBe(String(threadId));
    expect(markup).toContain('data-session-source="runtime"');
    expect(markup).toContain('data-selected-session="true"');
    expect(markup).toContain("Selected session");
    expect(markup).toContain("Codex");
    expect(markup).toContain("Claude");
    expect(markup).toContain("gpt-5.3-codex");
    expect(markup).toContain("/repo");
    expect(markup).toContain("sha256:active-session-launch-plan");
  });

  it("renders selected session drilldown without changing the active-thread marker", () => {
    const otherThreadId = ThreadId.makeUnsafe("thread-moss-control-plane-other");
    const model = deriveMossControlPlaneSessionListModel({
      activeThreadId: threadId,
      events: [
        normalizedEvent({
          text: "assistant text",
          launchPlanHash: "sha256:active-session-launch-plan",
          rawSource: "codex.eventmsg",
        }),
      ],
      sessions: [
        providerSession(),
        providerSession({
          provider: "claudeAgent",
          status: "ready",
          runtimeMode: "approval-required",
          cwd: "/other-repo",
          model: "claude-sonnet-4-6",
          threadId: otherThreadId,
          createdAt: "2026-07-01T00:00:02.000Z",
          updatedAt: "2026-07-01T00:03:00.000Z",
        }),
      ],
      source: "runtime",
      status: "ready",
    });
    const selectedRow = model.rows.find((row) => row.threadId === String(otherThreadId));

    expect(selectedRow).toBeTruthy();
    expect(selectMossControlPlaneSessionRow(model, selectedRow!.key)?.threadId).toBe(
      String(otherThreadId),
    );
    expect(
      deriveMossControlPlaneEventScope({ activeThreadId: threadId, row: selectedRow! }),
    ).toMatchObject({
      threadId: String(otherThreadId),
      sessionId: null,
      activeThread: false,
      label: `Claude / ${String(otherThreadId)}`,
    });

    const markup = renderToStaticMarkup(
      <MossControlPlaneSessionList model={model} selectedSessionKey={selectedRow!.key} />,
    );

    expect(markup).toContain('data-active-thread="true"');
    expect(markup).toContain(`data-selected-session-key="${selectedRow!.key}"`);
    expect(markup).toContain(`data-selected-thread-id="${String(otherThreadId)}"`);
    expect(markup).toContain('data-selected-session-id=""');
    expect(markup).toContain("Claude");
    expect(markup).toContain("Approval Required");
    expect(markup).toContain("claude-sonnet-4-6");
    expect(markup).toContain("/other-repo");
    expect(markup).toContain("not loaded");
    expect(markup).not.toContain("codex.eventmsg");
  });

  it("renders provider-missing state without reading provider raw logs", () => {
    const model = deriveMossControlPlaneSessionListModel({
      activeThreadId: threadId,
      events: [],
      sessions: [],
      source: "fallback",
      status: "missing",
    });
    const markup = renderToStaticMarkup(<MossControlPlaneSessionList model={model} />);

    expect(model.rows).toHaveLength(1);
    expect(model.rows[0]?.providerLabel).toBe("Unknown");
    expect(markup).toContain('data-source="fallback"');
    expect(markup).toContain('data-status="missing"');
    expect(markup).toContain('data-active-thread="true"');
    expect(markup).toContain('data-selected-session="true"');
    expect(markup).toContain("Selected session");
    expect(markup).toContain("Bridge missing");
    expect(markup).not.toContain("rawSource");
  });

  it("renders a compact session summary from typed event and ledger state", () => {
    const markup = renderToStaticMarkup(
      <MossControlPlaneSessionSummary
        activeSurface="events"
        ledgerSnapshot={MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT}
        ledgerSource="runtime"
        ledgerStatus="ready"
        normalizedEventCount={1}
      />,
    );

    expect(markup).toContain("data-moss-control-plane-summary");
    expect(markup).toContain('data-surface="events"');
    expect(markup).toContain('data-ledger-source="runtime"');
    expect(markup).toContain('data-ledger-status="ready"');
    expect(markup).toContain('data-release-gate-status="pass"');
    expect(markup).toContain("Surface");
    expect(markup).toContain("Events");
    expect(markup).toContain("Runtime / Ready");
    expect(markup).toContain("Gate");
    expect(markup).toContain("Pass");
    expect(markup).not.toContain("codex.eventmsg");
    expect(markup).not.toContain("events.jsonl");
  });

  it("renders fallback, loading, missing, and error summary states", () => {
    const cases = [
      { source: "fallback", status: "idle", label: "Fallback / Idle" },
      { source: "fallback", status: "loading", label: "Fallback / Loading" },
      { source: "fallback", status: "missing", label: "Fallback / Bridge missing" },
      { source: "fallback", status: "error", label: "Fallback / Error" },
    ] as const;

    for (const entry of cases) {
      const markup = renderToStaticMarkup(
        <MossControlPlaneSessionSummary
          activeSurface="ledger"
          ledgerSnapshot={MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT}
          ledgerSource={entry.source}
          ledgerStatus={entry.status}
          normalizedEventCount={0}
        />,
      );

      expect(markup).toContain(`data-ledger-source="${entry.source}"`);
      expect(markup).toContain(`data-ledger-status="${entry.status}"`);
      expect(markup).toContain(entry.label);
      expect(markup).not.toContain("tasks.jsonl");
    }
  });

  it("derives pending and blocked release gate labels for the session summary", () => {
    const pending = deriveMossControlPlaneSessionSummaryModel({
      activeSurface: "ledger",
      ledgerSnapshot: dashboardSnapshotWithGate("pending"),
      ledgerSource: "runtime",
      ledgerStatus: "ready",
      normalizedEventCount: 2,
    });
    const blocked = deriveMossControlPlaneSessionSummaryModel({
      activeSurface: "ledger",
      ledgerSnapshot: dashboardSnapshotWithGate("blocked"),
      ledgerSource: "runtime",
      ledgerStatus: "ready",
      normalizedEventCount: 2,
    });

    expect(pending.releaseGateLabel).toBe("Pending");
    expect(pending.releaseGateStatus).toBe("pending");
    expect(blocked.releaseGateLabel).toBe("Blocked");
    expect(blocked.releaseGateStatus).toBe("blocked");
  });
});
