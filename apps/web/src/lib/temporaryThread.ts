// FILE: temporaryThread.ts
// Purpose: Isolates temporary-thread auto-delete decisions from route lifecycle effects.
// Layer: Web route/domain helpers
// Exports: switch-aware resolver for temporary thread cleanup

import type { ThreadId } from "@moss/contracts";
import { composerDraftHasUnsentContent } from "../composerDraftDomain";
import type { ComposerThreadDraftState, DraftThreadState } from "../composerDraftStore";

export function resolveTemporaryThreadIdToDelete(input: {
  previousThreadId: ThreadId | null;
  nextThreadId: ThreadId | null;
  previousThreadWasTemporary?: boolean;
  previousThreadHasServerThread?: boolean;
  draftThreadsByThreadId: Record<string, DraftThreadState | undefined>;
  draftsByThreadId?: Record<string, ComposerThreadDraftState | undefined>;
}): ThreadId | null {
  const previousThreadId = input.previousThreadId;
  if (!previousThreadId || previousThreadId === input.nextThreadId) {
    return null;
  }
  const previousDraftThread = input.draftThreadsByThreadId[previousThreadId];
  if (input.previousThreadWasTemporary !== true && previousDraftThread?.isTemporary !== true) {
    return null;
  }
  // Never destroy an unsent draft that already holds typed text or attachments when
  // the user temporarily switches to another conversation before sending.
  const previousComposerDraft = input.draftsByThreadId?.[previousThreadId];
  if (
    input.previousThreadHasServerThread !== true &&
    previousDraftThread !== undefined &&
    previousDraftThread.promotedTo === undefined &&
    previousComposerDraft !== undefined &&
    composerDraftHasUnsentContent(previousComposerDraft)
  ) {
    return null;
  }
  return previousThreadId;
}
