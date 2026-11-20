import { useStore } from "../store";
// FILE: threadArchive.test.ts
// Purpose: Verifies archive receipts, revision sync, idempotency, and localized error mapping.
// Layer: Web lib test
// Exports: Vitest cases for threadArchive helpers

import {
  SidebarOrderRevision,
  SidebarSectionItemKey,
  ThreadId,
  type OrchestrationShellSnapshot,
} from "@moss/contracts";
import {
  THREAD_ALREADY_ARCHIVED_INVARIANT_MARKER,
  THREAD_NOT_ARCHIVED_INVARIANT_MARKER,
} from "@moss/shared/errorMessages";
import { assert, beforeEach, describe, expect, it, vi } from "vitest";

import { translateZhCnPresentationText } from "../localization/zhCN";
import {
  archiveThreadFromClient,
  formatThreadArchiveErrorMessage,
  isThreadAlreadyArchivedError,
  unarchiveThreadFromClient,
  isThreadAlreadyUnarchivedError,
} from "./threadArchive";

const THREAD_ID = ThreadId.makeUnsafe("thread-archive");
const SECOND_THREAD_ID = ThreadId.makeUnsafe("thread-archive-second");
const NOW = "2026-11-19T12:00:00.000Z";

describe("threadArchive client helpers", () => {
  beforeEach(() => {
    useStore.setState({
      sidebarOrderRevision: undefined,
      sidebarOrderItems: undefined,
      sidebarOrderMigrationState: undefined,
      shellSnapshotSequence: 0,
    });
  });

  it("returns the archive event sequence used by delayed cleanup and advances sidebarOrderRevision", async () => {
    const dispatchCommand = vi.fn(async () => ({
      sequence: 42,
      sidebarOrderRevision: SidebarOrderRevision.makeUnsafe(3),
    }));
    await expect(archiveThreadFromClient({ dispatchCommand }, THREAD_ID)).resolves.toBe(42);
    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.archive", threadId: THREAD_ID }),
    );
    expect(useStore.getState().sidebarOrderRevision).toBe(3);
  });

  it("recognizes the already-archived and already-unarchived invariants returned by the server", () => {
    // Build the messages from the shared markers so this stays coupled to the
    // exact phrases the server embeds (see commandInvariants).
    const unarchiveError = new Error(
      `Orchestration command invariant failed (thread.unarchive): Thread '${THREAD_ID}' ${THREAD_NOT_ARCHIVED_INVARIANT_MARKER} 'thread.unarchive'.`,
    );
    const archiveError = new Error(
      `Orchestration command invariant failed (thread.archive): Thread '${THREAD_ID}' ${THREAD_ALREADY_ARCHIVED_INVARIANT_MARKER} 'thread.archive'.`,
    );

    assert.equal(isThreadAlreadyUnarchivedError(unarchiveError, THREAD_ID), true);
    assert.equal(isThreadAlreadyUnarchivedError(archiveError, THREAD_ID), false);
    assert.equal(isThreadAlreadyArchivedError(archiveError, THREAD_ID), true);
    assert.equal(isThreadAlreadyArchivedError(unarchiveError, THREAD_ID), false);
  });

  it("refreshes a stale revision from a real compacted shell snapshot and does not retry network errors", async () => {
    const shellSnapshot: OrchestrationShellSnapshot = {
      snapshotSequence: 10,
      updatedAt: NOW,
      spaces: [],
      projects: [],
      threads: [],
      sidebarSections: [],
      sidebarOrderRevision: SidebarOrderRevision.makeUnsafe(7),
      sidebarOrderMigrationState: "ready",
      sidebarOrderItems: [
        {
          key: SidebarSectionItemKey.makeUnsafe(`thread:${SECOND_THREAD_ID}`),
          itemType: "thread",
          destination: "default",
          sectionId: null,
          sectionCreatedAt: null,
          sortOrder: 0,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    };
    const getShellSnapshot = vi.fn().mockResolvedValue(shellSnapshot);
    const dispatchCommand = vi
      .fn()
      .mockRejectedValueOnce(new Error("SIDEBAR_ORDER_REVISION_CONFLICT: current revision 7"))
      .mockResolvedValueOnce({
        sequence: 42,
        sidebarOrderRevision: SidebarOrderRevision.makeUnsafe(8),
      });

    await unarchiveThreadFromClient({ dispatchCommand, getShellSnapshot }, THREAD_ID);
    expect(getShellSnapshot).toHaveBeenCalledTimes(1);
    expect(dispatchCommand.mock.calls[1]?.[0].expectedSidebarOrderRevision).toBe(7);
    expect(dispatchCommand.mock.calls[0]?.[0].commandId).not.toBe(
      dispatchCommand.mock.calls[1]?.[0].commandId,
    );
    expect(useStore.getState().sidebarOrderRevision).toBe(8);

    dispatchCommand.mockReset().mockRejectedValue(new Error("network disconnected"));
    await expect(
      unarchiveThreadFromClient({ dispatchCommand, getShellSnapshot }, THREAD_ID),
    ).rejects.toThrow("network disconnected");
    expect(dispatchCommand).toHaveBeenCalledTimes(1);
  });

  it("maps raw orchestration errors to calm Simplified Chinese without exposing internal English", () => {
    const cases = [
      {
        error: new Error(
          "Orchestration command invariant failed (thread.archive): SIDEBAR_ORDER_REVISION_CONFLICT: current revision 1.",
        ),
        action: "archive" as const,
        expectedZh: "侧边栏列表刚刚发生了变化，请重试归档。",
      },
      {
        error: new Error(
          "Orchestration command invariant failed (thread.unarchive): SIDEBAR_ORDER_REVISION_CONFLICT: current revision 1.",
        ),
        action: "restore" as const,
        expectedZh: "侧边栏列表刚刚发生了变化，请重试恢复。",
      },
      {
        error: new Error(
          "Orchestration command invariant failed (thread.archive): Thread 'thread-1' does not exist.",
        ),
        action: "archive" as const,
        expectedZh: "此对话已不存在。",
      },
      {
        error: new Error(
          "Orchestration command invariant failed (thread.unarchive): Sidebar section 's1' cannot accept the archived cohort without exceeding its item limit.",
        ),
        action: "restore" as const,
        expectedZh: "原来的侧边栏分组已满，请移出部分内容后重试。",
      },
      {
        error: new Error("Unable to connect to the app server."),
        action: "archive" as const,
        expectedZh: "无法连接到应用服务器。",
      },
      {
        error: new Error(
          "Orchestration command invariant failed (thread.archive): unexpected internal detail.",
        ),
        action: "archive" as const,
        expectedZh: "无法归档此对话。",
      },
    ];

    for (const testCase of cases) {
      const canonical = formatThreadArchiveErrorMessage(testCase.error, testCase.action);
      const localized = translateZhCnPresentationText(canonical);
      expect(localized).toBe(testCase.expectedZh);
      expect(localized).not.toContain("Orchestration command invariant failed");
      expect(localized).not.toContain("SIDEBAR_ORDER_REVISION_CONFLICT");
    }
  });
});
