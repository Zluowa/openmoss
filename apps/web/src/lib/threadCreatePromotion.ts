// FILE: threadCreatePromotion.ts
// Purpose: Makes draft-to-server thread promotion idempotent across racing UI callers.
// Layer: Web orchestration helper
// Exports: promoteThreadCreate, isDuplicateThreadCreateError

import {
  SidebarOrderRevision,
  type ClientOrchestrationCommand,
  type NativeApi,
  type ThreadId,
} from "@synara/contracts";
import { markPromotedDraftThreads } from "../composerDraftStore";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { getThreadFromState } from "../threadDerivation";
import {
  clearPendingSidebarPlacement,
  getPendingSidebarPlacement,
} from "../pendingSidebarPlacement";
import { newCommandId } from "./utils";

type ThreadCreateCommand = Extract<ClientOrchestrationCommand, { type: "thread.create" }>;

type PromoteThreadCreateResult = "created" | "exists" | "unavailable";
export const PENDING_SIDEBAR_PLACEMENT_NOTICE_EVENT = "moss:pending-sidebar-placement-notice";
type PendingSidebarPlacementNoticeKind = "stale" | "retryable";
type PendingSidebarPlacementNotice = {
  readonly threadId: ThreadId;
  readonly kind: PendingSidebarPlacementNoticeKind;
  readonly message: string;
};
interface PromoteThreadCreateOptions {
  // Draft-aware callers use this when React knows the route is still local.
  readonly force?: boolean;
}

const inFlightThreadCreateById = new Map<ThreadId, Promise<PromoteThreadCreateResult>>();
const inFlightSidebarPlacementByThreadId = new Map<ThreadId, Promise<void>>();
const acceptedSidebarPlacementByThreadId = new Map<
  ThreadId,
  { readonly sectionId: string; readonly sectionCreatedAt: string; readonly revision: number }
>();
const emittedPendingSidebarPlacementNotices = new Set<string>();

function notifyPendingSidebarPlacement(
  pending: { readonly sectionId: string; readonly sectionCreatedAt: string },
  threadId: ThreadId,
  kind: PendingSidebarPlacementNoticeKind,
  message: string,
): void {
  const key = `${threadId}:${pending.sectionId}:${pending.sectionCreatedAt}:${kind}`;
  if (emittedPendingSidebarPlacementNotices.has(key)) return;
  emittedPendingSidebarPlacementNotices.add(key);
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  const detail: PendingSidebarPlacementNotice = { threadId, kind, message };
  window.dispatchEvent(new CustomEvent(PENDING_SIDEBAR_PLACEMENT_NOTICE_EVENT, { detail }));
}

function isPendingPlacementMatch(
  item:
    | {
        readonly key: string;
        readonly destination: string;
        readonly sectionId: string | null;
        readonly sectionCreatedAt: string | null;
      }
    | undefined,
  threadId: ThreadId,
  pending: { readonly sectionId: string; readonly sectionCreatedAt: string },
): boolean {
  return (
    item?.key === `thread:${threadId}` &&
    item.destination === "custom" &&
    item.sectionId === pending.sectionId &&
    item.sectionCreatedAt === pending.sectionCreatedAt
  );
}

function isDuplicateThreadCreateError(error: unknown, threadId: ThreadId): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : typeof error === "object" && error !== null && "message" in error
          ? String((error as { message?: unknown }).message ?? "")
          : "";
  return (
    message.includes("Orchestration command invariant failed (thread.create)") &&
    message.includes(`Thread '${threadId}' already exists and cannot be created twice.`)
  );
}

async function recoverPromotedThreadFromShellSnapshot(
  api: NativeApi,
  threadId: ThreadId,
): Promise<boolean> {
  const snapshot = await api.orchestration.getShellSnapshot();
  useStore.getState().syncServerShellSnapshot(snapshot);
  markPromotedDraftThreads(new Set(snapshot.threads.map((thread) => thread.id)));
  // getThreadFromState returns undefined for an unknown thread, never null.
  return getThreadFromState(useStore.getState(), threadId) !== undefined;
}

async function dispatchPendingSidebarPlacement(api: NativeApi, threadId: ThreadId): Promise<void> {
  const pending = getPendingSidebarPlacement(threadId);
  if (!pending) return;
  const snapshot = await api.orchestration.getShellSnapshot();
  useStore.getState().syncServerShellSnapshot(snapshot);
  if (!snapshot.threads.some((thread) => thread.id === threadId)) {
    notifyPendingSidebarPlacement(
      pending,
      threadId,
      "retryable",
      "The new chat was created, but its sidebar placement could not be confirmed yet.",
    );
    return;
  }
  const section = (snapshot.sidebarSections ?? []).find(
    (candidate) => candidate.id === pending.sectionId,
  );
  if (!section || section.createdAt !== pending.sectionCreatedAt) {
    clearPendingSidebarPlacement(threadId);
    acceptedSidebarPlacementByThreadId.delete(threadId);
    notifyPendingSidebarPlacement(
      pending,
      threadId,
      "stale",
      "The selected sidebar section changed, so this new chat stayed in Chats.",
    );
    return;
  }
  const existing = (snapshot.sidebarOrderItems ?? []).find(
    (item) => item.key === `thread:${threadId}`,
  );
  if (isPendingPlacementMatch(existing, threadId, pending)) {
    clearPendingSidebarPlacement(threadId);
    acceptedSidebarPlacementByThreadId.delete(threadId);
    return;
  }
  const accepted = acceptedSidebarPlacementByThreadId.get(threadId);
  if (accepted) {
    if ((snapshot.sidebarOrderRevision ?? 0) <= accepted.revision) return;
    clearPendingSidebarPlacement(threadId);
    acceptedSidebarPlacementByThreadId.delete(threadId);
    notifyPendingSidebarPlacement(
      pending,
      threadId,
      "stale",
      "The sidebar changed before the new chat could be placed, so it stayed in Chats.",
    );
    return;
  }
  const result = await api.orchestration.dispatchCommand({
    type: "sidebar-section.thread.place",
    commandId: newCommandId(),
    threadId,
    destination: "custom",
    sectionId: pending.sectionId,
    sectionCreatedAt: pending.sectionCreatedAt,
    beforeThreadId: null,
    expectedSidebarOrderRevision: SidebarOrderRevision.makeUnsafe(
      snapshot.sidebarOrderRevision ?? 0,
    ),
  });
  const resultingRevision = result.sidebarOrderRevision;
  if (resultingRevision === undefined || !Number.isSafeInteger(resultingRevision)) {
    throw new Error("Sidebar placement has an unknown outcome.");
  }
  acceptedSidebarPlacementByThreadId.set(threadId, {
    sectionId: pending.sectionId,
    sectionCreatedAt: pending.sectionCreatedAt,
    revision: resultingRevision,
  });
  const observed = await api.orchestration.getShellSnapshot();
  useStore.getState().syncServerShellSnapshot(observed);
  if (
    (observed.sidebarOrderRevision ?? 0) >= resultingRevision &&
    isPendingPlacementMatch(
      (observed.sidebarOrderItems ?? []).find((item) => item.key === `thread:${threadId}`),
      threadId,
      pending,
    )
  ) {
    clearPendingSidebarPlacement(threadId);
    acceptedSidebarPlacementByThreadId.delete(threadId);
  } else if ((observed.sidebarOrderRevision ?? 0) > resultingRevision) {
    clearPendingSidebarPlacement(threadId);
    acceptedSidebarPlacementByThreadId.delete(threadId);
    notifyPendingSidebarPlacement(
      pending,
      threadId,
      "stale",
      "The sidebar changed before the new chat could be placed, so it stayed in Chats.",
    );
  }
}

async function promotePendingSidebarPlacement(api: NativeApi, threadId: ThreadId): Promise<void> {
  if (!getPendingSidebarPlacement(threadId)) return;
  const existing = inFlightSidebarPlacementByThreadId.get(threadId);
  if (existing) {
    await existing;
    return;
  }
  const operation = dispatchPendingSidebarPlacement(api, threadId)
    .catch(async (error) => {
      const message =
        error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
      if (
        message.includes("revision") ||
        message.includes("incarnation") ||
        message.includes("deleted")
      ) {
        const pending = getPendingSidebarPlacement(threadId);
        clearPendingSidebarPlacement(threadId);
        acceptedSidebarPlacementByThreadId.delete(threadId);
        if (pending) {
          notifyPendingSidebarPlacement(
            pending,
            threadId,
            "stale",
            "The selected sidebar section changed, so this new chat stayed in Chats.",
          );
        }
        try {
          useStore.getState().syncServerShellSnapshot(await api.orchestration.getShellSnapshot());
        } catch {
          // Keep the failure bounded without claiming placement success.
        }
      } else {
        const pending = getPendingSidebarPlacement(threadId);
        if (pending) {
          notifyPendingSidebarPlacement(
            pending,
            threadId,
            "retryable",
            "The new chat was created, but its sidebar placement could not be confirmed yet.",
          );
        }
      }
    })
    .finally(() => {
      inFlightSidebarPlacementByThreadId.delete(threadId);
    });
  inFlightSidebarPlacementByThreadId.set(threadId, operation);
  await operation;
}

async function dispatchPromoteThreadCreate(
  api: NativeApi,
  command: ThreadCreateCommand,
  options: PromoteThreadCreateOptions = {},
): Promise<PromoteThreadCreateResult> {
  if (!options.force && getThreadFromState(useStore.getState(), command.threadId)) {
    markPromotedDraftThreads(new Set([command.threadId]));
    await promotePendingSidebarPlacement(api, command.threadId);
    return "exists";
  }

  try {
    await api.orchestration.dispatchCommand(command);
    markPromotedDraftThreads(new Set([command.threadId]));
    await promotePendingSidebarPlacement(api, command.threadId);
    return "created";
  } catch (error) {
    if (!isDuplicateThreadCreateError(error, command.threadId)) {
      throw error;
    }
    try {
      if (await recoverPromotedThreadFromShellSnapshot(api, command.threadId)) {
        await promotePendingSidebarPlacement(api, command.threadId);
        return "exists";
      }
    } catch {
      // Keep the original duplicate-create failure visible if recovery cannot confirm success.
    }
    throw error;
  }
}

export async function promoteThreadCreate(
  command: ThreadCreateCommand,
  api: NativeApi | undefined = readNativeApi(),
  options: PromoteThreadCreateOptions = {},
): Promise<PromoteThreadCreateResult> {
  if (!api) {
    return "unavailable";
  }
  const existing = inFlightThreadCreateById.get(command.threadId);
  if (existing) {
    await existing;
    return "exists";
  }

  const promise = dispatchPromoteThreadCreate(api, command, options).finally(() => {
    inFlightThreadCreateById.delete(command.threadId);
  });
  inFlightThreadCreateById.set(command.threadId, promise);
  return promise;
}
