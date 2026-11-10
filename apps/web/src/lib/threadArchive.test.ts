import { useStore } from "../store";
// FILE: threadArchive.test.ts
// Purpose: Verifies archive receipts and recognition of the already-unarchived invariant.
// Layer: Web lib test
// Exports: Vitest cases for threadArchive helpers

import { SidebarOrderRevision, ThreadId } from "@moss/contracts";
import { THREAD_NOT_ARCHIVED_INVARIANT_MARKER } from "@moss/shared/errorMessages";
import { assert, describe, expect, it, vi } from "vitest";

import {
  archiveThreadFromClient,
  unarchiveThreadFromClient,
  isThreadAlreadyUnarchivedError,
} from "./threadArchive";

const THREAD_ID = ThreadId.makeUnsafe("thread-archive");

describe("threadArchive client helpers", () => {
  it("returns the archive event sequence used by delayed cleanup", async () => {
    const dispatchCommand = vi.fn(async () => ({ sequence: 42 }));
    await expect(archiveThreadFromClient({ dispatchCommand }, THREAD_ID)).resolves.toBe(42);
    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.archive", threadId: THREAD_ID }),
    );
  });
  it("recognizes the already-unarchived invariant returned by the server", () => {
    // Build the message from the shared marker so this stays coupled to the
    // exact phrase the server embeds (see commandInvariants.requireThreadArchived).
    const error = new Error(
      `Orchestration command invariant failed (thread.unarchive): Thread '${THREAD_ID}' ${THREAD_NOT_ARCHIVED_INVARIANT_MARKER} 'thread.unarchive'.`,
    );

    assert.equal(isThreadAlreadyUnarchivedError(error, THREAD_ID), true);
  });

  it("does not treat unrelated invariant errors as already restored", () => {
    const error = new Error(
      "Orchestration command invariant failed (thread.archive): Thread 'thread-archive' is already archived and cannot handle command 'thread.archive'.",
    );

    assert.equal(isThreadAlreadyUnarchivedError(error, THREAD_ID), false);
  });
  it("refreshes a stale revision once before restoring and does not retry network errors", async () => {
    const sync = vi.spyOn(useStore.getState(), "syncServerShellSnapshot").mockImplementation(() => {
      useStore.setState({ sidebarOrderRevision: SidebarOrderRevision.makeUnsafe(7) });
    });
    const getShellSnapshot = vi.fn().mockResolvedValue({ sidebarOrderRevision: 7 });
    const dispatchCommand = vi
      .fn()
      .mockRejectedValueOnce(new Error("SIDEBAR_ORDER_REVISION_CONFLICT: current revision 7"))
      .mockResolvedValueOnce({ sequence: 42 });
    try {
      await unarchiveThreadFromClient({ dispatchCommand, getShellSnapshot }, THREAD_ID);
      expect(getShellSnapshot).toHaveBeenCalledTimes(1);
      expect(dispatchCommand.mock.calls[1]?.[0].expectedSidebarOrderRevision).toBe(7);
      expect(dispatchCommand.mock.calls[0]?.[0].commandId).not.toBe(
        dispatchCommand.mock.calls[1]?.[0].commandId,
      );
      dispatchCommand.mockReset().mockRejectedValue(new Error("network disconnected"));
      await expect(
        unarchiveThreadFromClient({ dispatchCommand, getShellSnapshot }, THREAD_ID),
      ).rejects.toThrow("network disconnected");
      expect(dispatchCommand).toHaveBeenCalledTimes(1);
    } finally {
      sync.mockRestore();
    }
  });
});
