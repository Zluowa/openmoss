import type { ThreadId } from "@moss/contracts";
import { useStore } from "./store";

type ThreadDetailAuthorityState = Pick<
  ReturnType<typeof useStore.getState>,
  "threadDetailSyncById" | "threadHistoryById"
>;

/** The same rule as a store selector, so a render can wait on it reactively. */
export function selectThreadDetailAwaitingVerification(
  state: ThreadDetailAuthorityState,
  id: ThreadId,
): boolean {
  return (
    state.threadDetailSyncById?.[id] === "cached" ||
    (state.threadHistoryById?.[id] !== undefined && state.threadDetailSyncById?.[id] !== "synced")
  );
}

/** Read authority at the action seam, including callbacks created before restore. */
export function isThreadDetailAwaitingVerification(id: ThreadId): boolean {
  return selectThreadDetailAwaitingVerification(useStore.getState(), id);
}

export function assertThreadDetailVerified(id: ThreadId): void {
  if (isThreadDetailAwaitingVerification(id))
    throw new Error("Wait for the conversation to reconnect before sending.");
}
