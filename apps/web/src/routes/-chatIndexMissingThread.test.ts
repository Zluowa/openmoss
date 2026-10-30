import { ProjectId, ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { filterRestorableChatThreadIds } from "./_chat.index";
import { resolveTerminalMissingSplitThreadIds } from "./_chat.$threadId";
import { resolveChatIndexRestoreRoute } from "./-chatIndexRoute.logic";
import type { SplitView } from "../splitViewStore";

describe("chat index terminal detail failures", () => {
  it("does not restore a remembered shell after its detail retry ended in not-found", () => {
    const missingThreadId = ThreadId.makeUnsafe("thread-missing");
    const liveThreadId = ThreadId.makeUnsafe("thread-live");
    const projectId = ProjectId.makeUnsafe("project-1");
    const threadIds = [missingThreadId, liveThreadId];

    const restorableThreadIds = filterRestorableChatThreadIds(threadIds, {
      [missingThreadId]: "THREAD_SNAPSHOT_NOT_FOUND",
    });

    expect(restorableThreadIds).toEqual([liveThreadId]);
    expect(
      resolveChatIndexRestoreRoute({
        safeMainNavigationTarget: null,
        lastThreadRoute: { threadId: missingThreadId },
        availableSplitViewIds: new Set(),
        threadIds: restorableThreadIds,
        projectById: new Map([[projectId, { id: projectId } as never]]),
        sidebarThreadSummaryById: {
          [missingThreadId]: { projectId },
          [liveThreadId]: { projectId },
        },
        groupProjectIds: new Set(),
        draftProjectIdByThreadId: new Map(),
        rememberedSplitViewThreadIds: undefined,
        landingSpace: null,
      }),
    ).toBeNull();
  });

  it("reuses the thread id registry when no terminal not-found is present", () => {
    const threadIds = [ThreadId.makeUnsafe("thread-live")];

    expect(filterRestorableChatThreadIds(threadIds, {})).toBe(threadIds);
  });

  it("prefers a persisted kanban target over the last active thread route", () => {
    const liveThreadId = ThreadId.makeUnsafe("thread-live");
    const projectId = ProjectId.makeUnsafe("project-1");

    expect(
      resolveChatIndexRestoreRoute({
        safeMainNavigationTarget: { kind: "kanban", projectId },
        lastThreadRoute: { threadId: liveThreadId },
        availableSplitViewIds: new Set(),
        threadIds: [liveThreadId],
        projectById: new Map([[projectId, { id: projectId } as never]]),
        sidebarThreadSummaryById: {
          [liveThreadId]: { projectId },
        },
        groupProjectIds: new Set(),
        draftProjectIdByThreadId: new Map(),
        rememberedSplitViewThreadIds: undefined,
        landingSpace: null,
      }),
    ).toEqual({ kind: "kanban", projectId });
  });
});

describe("split route terminal detail failures", () => {
  it("audits every pane instead of only the focused route thread", () => {
    const focusedThreadId = ThreadId.makeUnsafe("thread-focused");
    const missingBackgroundThreadId = ThreadId.makeUnsafe("thread-missing-background");
    const panel = {
      panel: null,
      diffTurnId: null,
      diffFilePath: null,
      hasOpenedPanel: false,
      lastOpenPanel: "browser" as const,
    };
    const splitView: SplitView = {
      id: "split-1",
      sourceThreadId: focusedThreadId,
      ownerProjectId: ProjectId.makeUnsafe("project-1"),
      root: {
        kind: "split",
        id: "split-root",
        direction: "horizontal",
        ratio: 0.5,
        first: {
          kind: "leaf",
          id: "pane-focused",
          threadId: focusedThreadId,
          panel,
        },
        second: {
          kind: "leaf",
          id: "pane-background",
          threadId: missingBackgroundThreadId,
          panel,
        },
      },
      focusedPaneId: "pane-focused",
      createdAt: "2026-07-31T00:00:00.000Z",
      updatedAt: "2026-07-31T00:00:00.000Z",
    };

    expect(
      resolveTerminalMissingSplitThreadIds(splitView, {
        [missingBackgroundThreadId]: "THREAD_SNAPSHOT_NOT_FOUND",
      }),
    ).toEqual([missingBackgroundThreadId]);
  });
});
