import { ProjectId, ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import type { SidebarThreadSummary } from "../types";
import {
  buildQuickChatItems,
  clampQuickChatWindowSize,
  formatQuickChatRelativeDate,
  QUICK_CHAT_DEFAULT_SIZE,
  QUICK_CHAT_SESSION_RETENTION_MS,
  resolveQuickChatWindowPosition,
  resolveQuickChatHoverSurface,
  resolveVisibleQuickChatThreadIds,
  shouldRetainQuickChatSession,
} from "./QuickChat.logic";

const PROJECT_ID = ProjectId.makeUnsafe("home-chat-project");

function localIso(day: number): string {
  return new Date(2026, 6, day, 9).toISOString();
}

function makeThread(
  id: string,
  overrides: Partial<SidebarThreadSummary> = {},
): SidebarThreadSummary {
  return {
    id: ThreadId.makeUnsafe(id),
    projectId: PROJECT_ID,
    title: id,
    modelSelection: { provider: "codex", model: "gpt-5.3-codex" } as never,
    interactionMode: "default" as never,
    branch: null,
    worktreePath: null,
    session: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    latestTurn: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: false,
    pendingBackgroundWorkCount: 0,
    ...overrides,
  };
}

function makeLatestTurn(overrides: Record<string, unknown> = {}) {
  return {
    turnId: "turn-1",
    state: "completed",
    requestedAt: "2026-07-09T09:00:00.000Z",
    startedAt: "2026-07-09T09:00:01.000Z",
    completedAt: "2026-07-09T09:00:02.000Z",
    assistantMessageId: "message-1",
    ...overrides,
  } as never;
}

function makeSession(status: "connecting" | "running" | "closed" = "running") {
  return {
    provider: "codex",
    status,
    activeTurnId: "turn-1",
    createdAt: "2026-07-09T09:00:00.000Z",
    updatedAt: "2026-07-09T09:00:01.000Z",
    orchestrationStatus: status === "running" ? "running" : "stopped",
  } as never;
}

describe("buildQuickChatItems", () => {
  it("deduplicates, follows explicit pin order, sorts the rest by recency, and caps at five", () => {
    const threads = [
      makeThread("a", { updatedAt: "2026-07-01T10:00:00.000Z" }),
      makeThread("b", { updatedAt: "2026-07-02T10:00:00.000Z" }),
      makeThread("c", { updatedAt: "2026-07-06T10:00:00.000Z" }),
      makeThread("d", { updatedAt: "2026-07-05T10:00:00.000Z" }),
      makeThread("e", { updatedAt: "2026-07-04T10:00:00.000Z" }),
      makeThread("f", { updatedAt: "2026-07-03T10:00:00.000Z" }),
      makeThread("a", {
        title: "newest duplicate",
        updatedAt: "2026-07-07T10:00:00.000Z",
      }),
    ];

    const items = buildQuickChatItems({
      threads,
      pinnedThreadIds: ["b", "a", "b", "missing"],
    });

    expect(items.map((item) => item.id)).toEqual(["b", "a", "c", "d", "e"]);
    expect(items[1]).toMatchObject({ title: "newest duplicate", isPinned: true });
    expect(new Set(items.map((item) => item.id)).size).toBe(5);
  });

  it("derives unread and streaming state from the latest turn and session", () => {
    const items = buildQuickChatItems({
      threads: [
        makeThread("unread", {
          latestTurn: makeLatestTurn(),
          lastVisitedAt: "2026-07-09T09:00:01.000Z",
        }),
        makeThread("read", {
          latestTurn: makeLatestTurn(),
          lastVisitedAt: "2026-07-09T09:00:03.000Z",
        }),
        makeThread("live", {
          latestTurn: makeLatestTurn({ state: "running", completedAt: null }),
          session: makeSession("running"),
          lastVisitedAt: "2026-07-09T08:00:00.000Z",
        }),
        makeThread("connecting", { session: makeSession("connecting") }),
        makeThread("tail", { hasLiveTailWork: true }),
      ],
      pinnedThreadIds: [],
    });

    expect(items.find((item) => item.id === "unread")).toMatchObject({
      unread: true,
      streaming: false,
    });
    expect(items.find((item) => item.id === "read")?.unread).toBe(false);
    expect(items.find((item) => item.id === "live")).toMatchObject({
      unread: false,
      streaming: true,
    });
    expect(items.find((item) => item.id === "connecting")?.streaming).toBe(true);
    expect(items.find((item) => item.id === "tail")?.streaming).toBe(true);
  });
});

describe("Quick Chat session retention", () => {
  it("keeps open sessions and closed sessions for exactly seven minutes", () => {
    const now = Date.parse("2026-07-10T12:00:00.000Z");
    expect(shouldRetainQuickChatSession(null, now)).toBe(true);
    expect(shouldRetainQuickChatSession(now - QUICK_CHAT_SESSION_RETENTION_MS, now)).toBe(true);
    expect(shouldRetainQuickChatSession(now - QUICK_CHAT_SESSION_RETENTION_MS - 1, now)).toBe(
      false,
    );
    expect(shouldRetainQuickChatSession("not-a-date", now)).toBe(false);
  });
});

describe("Quick Chat sidebar hover surface", () => {
  it("shows the coachmark until first open, then always uses recent chats", () => {
    expect(resolveQuickChatHoverSurface(false)).toBe("coachmark");
    expect(resolveQuickChatHoverSurface(true)).toBe("recent");
  });
});

describe("Quick Chat geometry", () => {
  it("uses 560x640 by default and clamps to Codex viewport bounds", () => {
    expect(clampQuickChatWindowSize(undefined, { width: 1_400, height: 900 })).toEqual(
      QUICK_CHAT_DEFAULT_SIZE,
    );
    expect(
      clampQuickChatWindowSize({ width: 2_000, height: 2_000 }, { width: 1_400, height: 900 }),
    ).toEqual({ width: 700, height: 822 });
    expect(
      clampQuickChatWindowSize({ width: 100, height: 100 }, { width: 1_400, height: 900 }),
    ).toEqual({ width: 400, height: 400 });
    expect(
      clampQuickChatWindowSize({ width: 560, height: 640 }, { width: 600, height: 350 }),
    ).toEqual({ width: 300, height: 272 });
  });

  it("anchors to center, bottom-left, or bottom-right with a 16px edge inset", () => {
    const viewport = { width: 1_400, height: 900 };
    expect(resolveQuickChatWindowPosition("center", QUICK_CHAT_DEFAULT_SIZE, viewport)).toEqual({
      x: 420,
      y: 130,
    });
    expect(
      resolveQuickChatWindowPosition("bottom-left", QUICK_CHAT_DEFAULT_SIZE, viewport),
    ).toEqual({ x: 16, y: 244 });
    expect(
      resolveQuickChatWindowPosition("bottom-right", QUICK_CHAT_DEFAULT_SIZE, viewport),
    ).toEqual({ x: 824, y: 244 });
  });
});

describe("formatQuickChatRelativeDate", () => {
  it("formats English calendar recency as Today, Yesterday, 2-6d, then month and day", () => {
    const now = new Date(2026, 6, 10, 12).getTime();

    expect(formatQuickChatRelativeDate(localIso(10), now, "en-US")).toBe("Today");
    expect(formatQuickChatRelativeDate(localIso(9), now, "en-US")).toBe("Yesterday");
    expect(formatQuickChatRelativeDate(localIso(5), now, "en-US")).toBe("5d");
    expect(formatQuickChatRelativeDate(localIso(3), now, "en-US")).toBe("Jul 3");
  });

  it("formats Simplified Chinese calendar recency without English leftovers", () => {
    const now = new Date(2026, 6, 10, 12).getTime();

    expect(formatQuickChatRelativeDate(localIso(10), now, "zh-CN")).toBe("今天");
    expect(formatQuickChatRelativeDate(localIso(9), now, "zh-CN")).toBe("昨天");
    expect(formatQuickChatRelativeDate(localIso(5), now, "zh-CN")).toBe("5天前");
    expect(formatQuickChatRelativeDate(localIso(3), now, "zh-CN")).toBe("7月3日");
  });
});

describe("resolveVisibleQuickChatThreadIds", () => {
  const host = ThreadId.makeUnsafe("host-thread");
  const quick = ThreadId.makeUnsafe("quick-chat-thread");

  it("returns the open Quick Chat thread when it is not already a host thread", () => {
    expect(
      resolveVisibleQuickChatThreadIds({
        windowOpen: true,
        activeThreadId: quick,
        hostThreadIds: [host],
      }),
    ).toEqual([quick]);
  });

  it("returns nothing when Quick Chat is closed or already hosted by the route", () => {
    expect(
      resolveVisibleQuickChatThreadIds({
        windowOpen: false,
        activeThreadId: quick,
        hostThreadIds: [host],
      }),
    ).toEqual([]);
    expect(
      resolveVisibleQuickChatThreadIds({
        windowOpen: true,
        activeThreadId: host,
        hostThreadIds: [host],
      }),
    ).toEqual([]);
    expect(
      resolveVisibleQuickChatThreadIds({
        windowOpen: true,
        activeThreadId: null,
        hostThreadIds: [host],
      }),
    ).toEqual([]);
  });
});
