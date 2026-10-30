// FILE: KanbanProjectBoardView.logic.ts
// Purpose: Coalesces Draft dispatches per thread and presents localized board-drop side effects.
// Layer: Kanban UI logic
// Exports: createKanbanDraftDispatchSingleFlight, presentKanbanDraftDispatchResult,
//          routeKanbanDraftColumnDrop

import type { ThreadId } from "@synara/contracts";
import type { KanbanDraftDispatchResult } from "~/lib/kanbanDispatch";
import type { TranslationKey } from "~/localization";
import type { KanbanCard, KanbanColumnKey } from "./kanban.logic";

interface KanbanDraftDispatchToast {
  readonly type: "error" | "info" | "success";
  readonly title: string;
  readonly description: string;
}

export interface KanbanDraftDispatchSingleFlight {
  readonly run: (threadId: ThreadId, operation: () => Promise<void>) => Promise<void>;
}

/**
 * Coalesces the entire board-level dispatch flow for one thread, beginning before
 * provider preflight and ending after the final presentation side effect. Locks
 * are instance-local so separate boards do not share lifecycle state, while
 * different threads on the same board remain fully concurrent.
 */
export function createKanbanDraftDispatchSingleFlight(): KanbanDraftDispatchSingleFlight {
  const inFlightByThreadId = new Map<ThreadId, Promise<void>>();
  return {
    run(threadId, operation) {
      const existing = inFlightByThreadId.get(threadId);
      if (existing) {
        return existing;
      }
      const pending = Promise.resolve()
        .then(operation)
        .finally(() => {
          if (inFlightByThreadId.get(threadId) === pending) {
            inFlightByThreadId.delete(threadId);
          }
        });
      inFlightByThreadId.set(threadId, pending);
      return pending;
    },
  };
}

export function presentKanbanDoneDrop(input: {
  readonly t: (key: TranslationKey) => string;
  readonly addToast: (toast: KanbanDraftDispatchToast) => void;
}): void {
  input.addToast({
    type: "info",
    title: input.t("kanban.doneDrop.toast.derivedTitle"),
    description: input.t("kanban.doneDrop.toast.derivedDescription"),
  });
}

/**
 * Routes the two non-reorder Draft drops. The expensive provider preflight and
 * dispatch pipeline is injected as one callback so the derived Done outcome can
 * never enter it.
 */
export function routeKanbanDraftColumnDrop(input: {
  readonly targetColumn: Extract<KanbanColumnKey, "inProgress" | "done">;
  readonly dispatchWithPreflight: () => void;
  readonly t: (key: TranslationKey) => string;
  readonly addToast: (toast: KanbanDraftDispatchToast) => void;
}): void {
  if (input.targetColumn === "inProgress") {
    input.dispatchWithPreflight();
    return;
  }
  presentKanbanDoneDrop(input);
}

export function presentKanbanDraftDispatchResult(input: {
  readonly result: KanbanDraftDispatchResult;
  readonly card: KanbanCard;
  readonly t: (key: TranslationKey) => string;
  readonly addToast: (toast: KanbanDraftDispatchToast) => void;
  readonly onOpenCard: (card: KanbanCard) => void;
}): void {
  const { result, card, t, addToast, onOpenCard } = input;
  if (result.kind === "dispatched") {
    addToast({
      type: "success",
      title: t("kanban.draft.toast.sent"),
      description: card.title,
    });
    return;
  }
  if (result.kind === "open-thread") {
    const descriptionKey =
      result.reason === "empty"
        ? "kanban.draft.toast.empty"
        : result.reason === "worktree-pending"
          ? "kanban.draft.toast.worktreePending"
          : "kanban.draft.toast.continueInChat";
    addToast({
      type: "info",
      title: t("kanban.draft.toast.finishInChat"),
      description: t(descriptionKey),
    });
    onOpenCard(card);
    return;
  }
  if (result.kind === "unavailable") {
    addToast({
      type: "error",
      title: t("kanban.draft.toast.notConnected"),
      description: t("kanban.draft.toast.reconnect"),
    });
    return;
  }
  addToast({
    type: "error",
    title: t("kanban.draft.toast.sendFailed"),
    description: t("kanban.draft.toast.sendFailedDescription"),
  });
}
