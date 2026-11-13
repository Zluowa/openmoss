// FILE: UnreadableThreadsNotice.tsx
// Purpose: Tells the person, once, that some conversations could not be read and are
//          hidden, with their details to copy for support.
// Layer: Web app shell
// Exports: UnreadableThreadsNotice, publishUnreadableThreads, formatUnreadableThreadDetails,
//          useUnreadableThread
// Why: the server leaves a conversation whose stored data no longer reads out of every
//      list instead of failing to start; without this line it would vanish silently.

import type { OrchestrationUnreadableThread } from "@moss/contracts";
import { useEffect, useRef } from "react";
import { create } from "zustand";

import { useTranslation } from "~/localization";
import { toastManager } from "./ui/toast";

const NOTICE_TOAST_ID = "unreadable-threads";

interface UnreadableThreadsState {
  readonly threads: ReadonlyArray<OrchestrationUnreadableThread>;
}

const useUnreadableThreadsStore = create<UnreadableThreadsState>(() => ({ threads: [] }));

/** Called with every authoritative shell snapshot. */
export function publishUnreadableThreads(
  threads: ReadonlyArray<OrchestrationUnreadableThread> | undefined,
): void {
  const next = threads ?? [];
  const current = useUnreadableThreadsStore.getState().threads;
  if (current.length === 0 && next.length === 0) return;
  useUnreadableThreadsStore.setState({ threads: next });
}

/** The entry for one conversation the server could not read, or null. */
export function useUnreadableThread(
  threadId: string | null | undefined,
): OrchestrationUnreadableThread | null {
  return useUnreadableThreadsStore((state) =>
    threadId ? (state.threads.find((thread) => thread.id === threadId) ?? null) : null,
  );
}

/** Ids and value-free reasons only: never a title or message text. */
export function formatUnreadableThreadDetails(
  threads: ReadonlyArray<OrchestrationUnreadableThread>,
): string {
  return [
    "Moss could not read these conversations. Their data is still on this computer, unchanged.",
    ...threads.map((thread) => `${thread.id}: ${thread.reason}`),
  ].join("\n");
}

/** Mounted once in the app shell; shows the notice again only when the set changes. */
export function UnreadableThreadsNotice() {
  const threads = useUnreadableThreadsStore((state) => state.threads);
  const { t, format } = useTranslation();
  const shownFor = useRef("");

  useEffect(() => {
    const fingerprint = threads.map((thread) => thread.id).join("\n");
    if (fingerprint === shownFor.current) return;
    shownFor.current = fingerprint;
    if (threads.length === 0) {
      toastManager.close(NOTICE_TOAST_ID);
      return;
    }
    toastManager.add({
      id: NOTICE_TOAST_ID,
      type: "warning",
      title: format("unreadableThreads.notice", { count: threads.length }),
      timeout: 0,
      data: {
        copyItems: [
          {
            label: "details",
            text: formatUnreadableThreadDetails(threads),
            copyLabel: t("unreadableThreads.copyDetails"),
            copiedText: t("unreadableThreads.copied"),
          },
        ],
      },
    });
  }, [format, t, threads]);

  return null;
}
