// FILE: MessagesTimeline.approvalPause.browser.tsx
// Purpose: Verify that awaitingUser (approval/user-input wait) time is excluded
//          from both the settled "已工作 …" summary and the live "工作中 …" timer.
import "../../index.css";

import { EventId, MessageId, type OrchestrationThreadActivity, TurnId } from "@moss/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { MossLocaleScope } from "../../localization";
import { installZhCnUiLocalization, uninstallZhCnUiLocalization } from "../../localization/zhCN";
import type { TimelineEntry } from "../../session-logic";
import { LiveElapsedTimer } from "./LiveElapsedTimer";
import { MessagesTimeline } from "./MessagesTimeline";
import { deriveTurnTimingByTurnId } from "./MessagesTimeline.logic";

const TURN_ID = TurnId.makeUnsafe("turn-approval-pause");

function makeApprovalPauseActivities(options: {
  resolved: boolean;
}): OrchestrationThreadActivity[] {
  const base: OrchestrationThreadActivity[] = [
    {
      id: EventId.makeUnsafe("act-start"),
      createdAt: "2026-11-25T10:00:00.000Z",
      tone: "info",
      kind: "turn.started",
      summary: "Turn started",
      turnId: TURN_ID,
      payload: {},
    },
    {
      id: EventId.makeUnsafe("act-approval-open"),
      createdAt: "2026-11-25T10:00:10.000Z",
      tone: "approval",
      kind: "approval.requested",
      summary: "Approval requested",
      turnId: TURN_ID,
      payload: {
        requestId: "req-approval-1",
        lifecycleGeneration: "gen-1",
        requestKind: "command",
      },
    },
  ];
  if (options.resolved) {
    base.push({
      id: EventId.makeUnsafe("act-approval-resolved"),
      createdAt: "2026-11-25T10:05:10.000Z",
      tone: "approval",
      kind: "approval.resolved",
      summary: "Approval resolved",
      turnId: TURN_ID,
      payload: {
        requestId: "req-approval-1",
        lifecycleGeneration: "gen-1",
        requestKind: "command",
        decision: "accept",
      },
    });
  }
  return base;
}

function makeBaseEntries(): TimelineEntry[] {
  return [
    {
      id: "u1",
      kind: "message",
      createdAt: "2026-11-25T10:00:00.000Z",
      message: {
        id: MessageId.makeUnsafe("user-1"),
        role: "user",
        text: "Run a checked command",
        turnId: TURN_ID,
        createdAt: "2026-11-25T10:00:00.000Z",
        streaming: false,
      },
    },
    {
      id: "w1",
      kind: "work",
      createdAt: "2026-11-25T10:00:05.000Z",
      entry: {
        id: "work-1",
        createdAt: "2026-11-25T10:00:05.000Z",
        label: "Ran command",
        tone: "tool",
        turnId: TURN_ID,
      },
    },
  ];
}

const liveTimerText = () => document.querySelector("[data-live-timer-host]")?.textContent ?? "";

afterEach(() => {
  vi.useRealTimers();
  uninstallZhCnUiLocalization();
  document.body.innerHTML = "";
});

describe("MessagesTimeline awaitingUser pause duration", () => {
  it("freezes LiveElapsedTimer while paused for approval and excludes closed pause intervals on resume", async () => {
    vi.useFakeTimers();
    const startMs = Date.parse("2026-11-25T10:00:00.000Z");
    const startedAt = new Date(startMs).toISOString();
    const pausedAt = new Date(startMs + 10_000).toISOString();
    vi.setSystemTime(startMs + 10_000);

    const screen = await render(
      <MossLocaleScope locale="zh-CN">
        <div data-live-timer-host="">
          <LiveElapsedTimer startedAt={startedAt} paused pausedAt={pausedAt} />
        </div>
      </MossLocaleScope>,
    );
    try {
      expect(liveTimerText()).toBe("10 秒");

      // Time passes while waiting for user approval: the displayed clock must not advance.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(liveTimerText()).toBe("10 秒");

      // Approval granted at 10:05:10 (5 minutes waited); clock resumes at 10s + 3s = 13s.
      const resolvedMs = startMs + 310_000;
      vi.setSystemTime(resolvedMs + 3_000);
      await screen.rerender(
        <MossLocaleScope locale="zh-CN">
          <div data-live-timer-host="">
            <LiveElapsedTimer
              startedAt={startedAt}
              paused={false}
              pausedIntervals={[{ startMs: startMs + 10_000, endMs: resolvedMs }]}
            />
          </div>
        </MossLocaleScope>,
      );
      expect(liveTimerText()).toBe("13 秒");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(liveTimerText()).toBe("15 秒");
    } finally {
      await screen.unmount();
    }
  });
  it("excludes approval wait time from settled 已工作 label and pauses the live timer while awaiting approval", async () => {
    installZhCnUiLocalization();

    // 1) While awaiting user approval 3 minutes after opening, live header stays paused at 10s.
    const liveAwaitingTiming = deriveTurnTimingByTurnId({
      turnDiffSummaries: [],
      latestTurn: {
        turnId: TURN_ID,
        state: "running",
        requestedAt: "2026-11-25T10:00:00.000Z",
        startedAt: "2026-11-25T10:00:00.000Z",
        completedAt: null,
      },
      activities: makeApprovalPauseActivities({ resolved: false }),
    });

    const liveScreen = await render(
      <MossLocaleScope locale="zh-CN">
        <div style={{ width: 800, height: 600 }}>
          <MessagesTimeline
            hasMessages
            isWorking
            awaitingUser
            activeTurnId={TURN_ID}
            activeTurnInProgress
            activeTurnStartedAt="2026-11-25T10:00:00.000Z"
            timelineEntries={makeBaseEntries()}
            turnDiffSummaryByAssistantMessageId={new Map()}
            turnTimingByTurnId={liveAwaitingTiming}
            nowIso="2026-11-25T10:03:10.000Z"
            onOpenTurnDiff={() => {}}
            revertTurnCountByUserMessageId={new Map()}
            onRevertUserMessage={() => {}}
            isRevertingCheckpoint={false}
            onImageExpand={() => {}}
            markdownCwd="/repo"
            resolvedTheme="light"
            timestampFormat="locale"
            workspaceRoot={undefined}
          />
        </div>
      </MossLocaleScope>,
    );
    try {
      await expect
        .poll(() => document.querySelector('[data-turn-header="live"]')?.textContent ?? "")
        .toContain("已工作 10 秒");
    } finally {
      await liveScreen.unmount();
    }

    // 2) After a 5-minute approval wait and 30s more work (5m 40s wall clock), settled says 已工作 40 秒.
    const settledTiming = deriveTurnTimingByTurnId({
      turnDiffSummaries: [],
      latestTurn: {
        turnId: TURN_ID,
        state: "completed",
        requestedAt: "2026-11-25T10:00:00.000Z",
        startedAt: "2026-11-25T10:00:00.000Z",
        completedAt: "2026-11-25T10:05:40.000Z",
      },
      activities: makeApprovalPauseActivities({ resolved: true }),
    });

    const settledScreen = await render(
      <MossLocaleScope locale="zh-CN">
        <div style={{ width: 800, height: 600 }}>
          <MessagesTimeline
            hasMessages
            isWorking={false}
            activeTurnInProgress={false}
            activeTurnStartedAt={null}
            timelineEntries={[
              ...makeBaseEntries(),
              {
                id: "a1",
                kind: "message",
                createdAt: "2026-11-25T10:05:39.000Z",
                message: {
                  id: MessageId.makeUnsafe("assistant-1"),
                  role: "assistant",
                  text: "已完成。",
                  turnId: TURN_ID,
                  createdAt: "2026-11-25T10:05:39.000Z",
                  completedAt: "2026-11-25T10:05:40.000Z",
                  streaming: false,
                },
              },
            ]}
            turnDiffSummaryByAssistantMessageId={new Map()}
            turnTimingByTurnId={settledTiming}
            nowIso="2026-11-25T10:05:40.000Z"
            onOpenTurnDiff={() => {}}
            revertTurnCountByUserMessageId={new Map()}
            onRevertUserMessage={() => {}}
            isRevertingCheckpoint={false}
            onImageExpand={() => {}}
            markdownCwd="/repo"
            resolvedTheme="light"
            timestampFormat="locale"
            workspaceRoot={undefined}
          />
        </div>
      </MossLocaleScope>,
    );
    try {
      await expect
        .poll(() => document.querySelector('[data-turn-header="completed"]')?.textContent ?? "")
        .toContain("已工作 40 秒");
      expect(document.body.textContent).not.toContain("5 分钟 40 秒");
    } finally {
      await settledScreen.unmount();
    }
  });

  it("#1003: freezes inner running tool row timer and suppresses 没有动静 while awaiting approval", async () => {
    installZhCnUiLocalization();

    const liveAwaitingTiming = deriveTurnTimingByTurnId({
      turnDiffSummaries: [],
      latestTurn: {
        turnId: TURN_ID,
        state: "running",
        requestedAt: "2026-11-25T10:00:00.000Z",
        startedAt: "2026-11-25T10:00:00.000Z",
        completedAt: null,
      },
      activities: makeApprovalPauseActivities({ resolved: false }),
    });

    const entriesWithLiveTool: TimelineEntry[] = [
      makeBaseEntries()[0]!,
      {
        id: "w-live-tool",
        kind: "work",
        createdAt: "2026-11-25T10:00:02.000Z",
        entry: {
          id: "work-live-tool",
          createdAt: "2026-11-25T10:00:02.000Z",
          label: "PowerShell",
          tone: "tool",
          turnId: TURN_ID,
          liveActivity: {
            state: "running_tool",
            label: "PowerShell",
            startedAt: "2026-11-25T10:00:02.000Z",
            lastActivityAt: "2026-11-25T10:00:03.000Z",
          },
        },
      },
    ];

    const screen = await render(
      <MossLocaleScope locale="zh-CN">
        <div style={{ width: 800, height: 600 }}>
          <MessagesTimeline
            hasMessages
            isWorking
            awaitingUser
            activeTurnId={TURN_ID}
            activeTurnInProgress
            activeTurnStartedAt="2026-11-25T10:00:00.000Z"
            timelineEntries={entriesWithLiveTool}
            turnDiffSummaryByAssistantMessageId={new Map()}
            turnTimingByTurnId={liveAwaitingTiming}
            nowIso="2026-11-25T10:03:10.000Z"
            onOpenTurnDiff={() => {}}
            revertTurnCountByUserMessageId={new Map()}
            onRevertUserMessage={() => {}}
            isRevertingCheckpoint={false}
            onImageExpand={() => {}}
            markdownCwd="/repo"
            resolvedTheme="light"
            timestampFormat="locale"
            workspaceRoot={undefined}
          />
        </div>
      </MossLocaleScope>,
    );
    try {
      await expect
        .poll(() => document.querySelector('[data-live-activity-meta="true"]')?.textContent ?? "")
        .toContain("等待批准 · 已用时 8 秒");
      const metaText =
        document.querySelector('[data-live-activity-meta="true"]')?.textContent ?? "";
      expect(metaText).not.toContain("没有动静");
    } finally {
      await screen.unmount();
    }
  });
});
