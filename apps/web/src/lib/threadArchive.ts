// FILE: threadArchive.ts
// Purpose: Dispatches thread archive/unarchive commands from the client.
// Layer: Web orchestration helper
// Exports: archiveThreadFromClient, unarchiveThreadFromClient, isThreadAlreadyArchivedError, isThreadAlreadyUnarchivedError, formatThreadArchiveErrorMessage

import { SidebarOrderRevision, type NativeApi, type ThreadId } from "@moss/contracts";
import {
  collectErrorMessages,
  THREAD_ALREADY_ARCHIVED_INVARIANT_MARKER,
  THREAD_NOT_ARCHIVED_INVARIANT_MARKER,
} from "@moss/shared/errorMessages";

import { newCommandId } from "./utils";
import { useStore } from "../store";

type ThreadCommandDispatcher = Pick<NativeApi["orchestration"], "dispatchCommand"> &
  Partial<Pick<NativeApi["orchestration"], "getShellSnapshot">>;

function recordAcceptedSidebarOrderRevision(revision: number | undefined): void {
  if (revision === undefined || !Number.isSafeInteger(revision)) return;
  if (typeof useStore.setState !== "function") return;
  const current = useStore.getState().sidebarOrderRevision;
  if (current === undefined || revision > current) {
    useStore.setState({ sidebarOrderRevision: SidebarOrderRevision.makeUnsafe(revision) });
  }
}

// Retry only a rejected revision, never an unknown network failure: the latter
// may already have committed. Refresh from the authoritative shell and use a
// new command id for the new precondition, preserving server-side fencing.
export async function dispatchThreadSidebarCommand(
  api: ThreadCommandDispatcher,
  type: "thread.archive" | "thread.unarchive" | "thread.delete",
  threadId: ThreadId,
) {
  const dispatch = async () => {
    const receipt = await api.dispatchCommand({
      type,
      commandId: newCommandId(),
      threadId,
      expectedSidebarOrderRevision: SidebarOrderRevision.makeUnsafe(
        useStore.getState().sidebarOrderRevision ?? 0,
      ),
    });
    recordAcceptedSidebarOrderRevision(receipt.sidebarOrderRevision);
    return receipt;
  };
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

// Detects the server invariant returned when an archive races another archive
// (e.g. against an older server before idempotent server-side handling).
export function isThreadAlreadyArchivedError(error: unknown, threadId: ThreadId): boolean {
  const errorText = collectErrorMessages(error).join("\n");
  return (
    errorText.includes("thread.archive") &&
    errorText.includes(THREAD_ALREADY_ARCHIVED_INVARIANT_MARKER) &&
    errorText.includes(String(threadId))
  );
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

// Maps raw orchestration / transport failures into calm, translatable user copy
// so internal English invariant errors never surface directly in error toasts.
export function formatThreadArchiveErrorMessage(
  error: unknown,
  action: "archive" | "restore" = "archive",
): string {
  const errorText = collectErrorMessages(error).join("\n");
  const lower = errorText.toLowerCase();

  if (
    errorText.includes("SIDEBAR_ORDER_REVISION_CONFLICT") ||
    errorText.includes("SIDEBAR_ORDER_REVISION_REQUIRED") ||
    errorText.includes("SIDEBAR_ORDER_MIGRATION_REQUIRED")
  ) {
    return action === "archive"
      ? "The sidebar list changed. Please try archiving again."
      : "The sidebar list changed. Please try restoring again.";
  }

  if (
    lower.includes("does not exist") ||
    lower.includes("was deleted") ||
    lower.includes("no longer exists") ||
    lower.includes("not found")
  ) {
    return "The thread no longer exists.";
  }

  if (lower.includes("exceeding its item limit") || lower.includes("at capacity")) {
    return "The original sidebar section is full. Remove an item from it and try again.";
  }

  if (
    lower.includes("unable to connect to the app server") ||
    lower.includes("transport disposed") ||
    lower.includes("websocket") ||
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("disconnect") ||
    lower.includes("network")
  ) {
    return "Unable to connect to the app server.";
  }

  return action === "archive" ? "Unable to archive the thread." : "Unable to restore the thread.";
}

// Restores a previously archived thread back into the sidebar.
export async function unarchiveThreadFromClient(
  api: ThreadCommandDispatcher,
  threadId: ThreadId,
): Promise<void> {
  await dispatchThreadSidebarCommand(api, "thread.unarchive", threadId);
}
