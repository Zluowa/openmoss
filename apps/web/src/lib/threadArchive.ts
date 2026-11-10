// FILE: threadArchive.ts
// Purpose: Dispatches thread archive/unarchive commands from the client.
// Layer: Web orchestration helper
// Exports: archiveThreadFromClient, unarchiveThreadFromClient, isThreadAlreadyUnarchivedError

import { SidebarOrderRevision, type NativeApi, type ThreadId } from "@moss/contracts";
import {
  collectErrorMessages,
  THREAD_NOT_ARCHIVED_INVARIANT_MARKER,
} from "@moss/shared/errorMessages";

import { newCommandId } from "./utils";
import { useStore } from "../store";

type ThreadCommandDispatcher = Pick<NativeApi["orchestration"], "dispatchCommand"> &
  Partial<Pick<NativeApi["orchestration"], "getShellSnapshot">>;

// Retry only a rejected revision, never an unknown network failure: the latter
// may already have committed. Refresh from the authoritative shell and use a
// new command id for the new precondition, preserving server-side fencing.
export async function dispatchThreadSidebarCommand(
  api: ThreadCommandDispatcher,
  type: "thread.archive" | "thread.unarchive" | "thread.delete",
  threadId: ThreadId,
) {
  const dispatch = () =>
    api.dispatchCommand({
      type,
      commandId: newCommandId(),
      threadId,
      expectedSidebarOrderRevision: SidebarOrderRevision.makeUnsafe(
        useStore.getState().sidebarOrderRevision ?? 0,
      ),
    });
  try {
    return await dispatch();
  } catch (error) {
    if (
      !api.getShellSnapshot ||
      !collectErrorMessages(error).some((message) =>
        message.includes("SIDEBAR_ORDER_REVISION_CONFLICT"),
      )
    )
      throw error;
    useStore.getState().syncServerShellSnapshot(await api.getShellSnapshot());
    return dispatch();
  }
}

// Archives a thread on the server. Archived threads are hidden from the sidebar
// but can be restored later via {@link unarchiveThreadFromClient}.
export async function archiveThreadFromClient(
  api: ThreadCommandDispatcher,
  threadId: ThreadId,
): Promise<number> {
  const receipt = await dispatchThreadSidebarCommand(api, "thread.archive", threadId);
  return receipt.sequence;
}

// Detects the server invariant returned when an Undo races another restore (the
// thread is already unarchived). Matches the marker the server embeds in the
// invariant message — a single shared source of truth so the two sides cannot
// drift — and scopes it to the unarchive command and this thread so unrelated
// invariants (e.g. "thread not found") never read as "already restored".
export function isThreadAlreadyUnarchivedError(error: unknown, threadId: ThreadId): boolean {
  const errorText = collectErrorMessages(error).join("\n");
  return (
    errorText.includes("thread.unarchive") &&
    errorText.includes(THREAD_NOT_ARCHIVED_INVARIANT_MARKER) &&
    errorText.includes(String(threadId))
  );
}

// Restores a previously archived thread back into the sidebar.
export async function unarchiveThreadFromClient(
  api: ThreadCommandDispatcher,
  threadId: ThreadId,
): Promise<void> {
  await dispatchThreadSidebarCommand(api, "thread.unarchive", threadId);
}
