// FILE: visualFollowUp.ts
// Purpose: The one reflow every agent visual shares: a follow-up the reader asks an
//          OpenUI block or an HTML page to send lands in the thread's composer draft.
// Layer: Web chat presentation logic
// Exports: injectVisualFollowUpIntoComposer, visualFollowUpForThread, VisualFollowUpContext

import type { ThreadId } from "@moss/contracts";
import { createContext } from "react";

import { requestComposerFocus } from "../composerFocusRequestStore";
import { useComposerDraftStore } from "../composerDraftStore";

/**
 * Mirrors the plugin "Try in chat" pattern: the message lands in the thread's
 * composer draft and the composer takes focus, so the reader reviews or edits it
 * before sending instead of a visual silently spending a turn. An existing draft
 * is kept, with the follow-up appended.
 */
export function injectVisualFollowUpIntoComposer(threadId: ThreadId, message: string): void {
  const store = useComposerDraftStore.getState();
  const existing = store.draftsByThreadId[threadId]?.prompt?.trim() ?? "";
  store.setPrompt(threadId, existing ? `${existing}\n\n${message}` : message);
  requestComposerFocus(threadId);
}

/** The follow-up handler for one thread's visuals; null outside a thread. */
export function visualFollowUpForThread(
  threadId: string | null,
): ((message: string) => void) | null {
  return threadId === null
    ? null
    : (message: string) => injectVisualFollowUpIntoComposer(threadId as ThreadId, message);
}

/**
 * The follow-up handler for visuals that do not know their thread, such as
 * sandboxed HTML pages. The thread view provides it, and so does the side panel,
 * which renders outside the thread view. Null outside a thread, where pages get
 * an error.
 */
export const VisualFollowUpContext = createContext<((message: string) => void) | null>(null);
