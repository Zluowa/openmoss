// FILE: quickChatAttachment.ts
// Purpose: Attach a durable Quick Chat conversation to another task's composer
//   as a replaceable structured reference, never as a copied transcript.
// Layer: Web composer utility

import type { ThreadId } from "@synara/contracts";
import type { Thread } from "~/types";

import { useComposerDraftStore } from "../composerDraftStore";
import { requestComposerFocus } from "../composerFocusRequestStore";
import { createPastedTextDraft } from "./composerPastedText";
import { buildQuickChatReferenceContext, type QuickChatReferenceInput } from "./quickChatReference";

const QUICK_CHAT_REFERENCE_DRAFT_PREFIX = "quick-chat-reference:";

export type QuickChatAttachmentSource = Pick<Thread, "codexThreadId" | "id" | "session" | "title">;

function referenceForSource(source: QuickChatAttachmentSource): QuickChatReferenceInput | null {
  const threadId = source.id.trim();
  const providerConversationId = source.codexThreadId?.trim() ?? "";
  // A provider conversation id is direct persistence evidence. Once a provider
  // session exists, Moss's orchestration thread id is itself the stable fallback.
  if (threadId.length === 0 || (providerConversationId.length === 0 && source.session === null)) {
    return null;
  }
  return {
    conversationId: providerConversationId || threadId,
    threadId,
    title: source.title,
  };
}

export function canAttachQuickChatThread(input: {
  readonly source: QuickChatAttachmentSource;
  readonly targetId: ThreadId | null | undefined;
}): boolean {
  const targetId = input.targetId?.trim() ?? "";
  return (
    targetId.length > 0 && targetId !== input.source.id && referenceForSource(input.source) !== null
  );
}

export function attachQuickChatToTask(input: {
  readonly source: QuickChatAttachmentSource;
  readonly targetId: ThreadId | null | undefined;
  readonly now?: Date | string;
}): boolean {
  if (!canAttachQuickChatThread(input) || !input.targetId) {
    return false;
  }

  const reference = referenceForSource(input.source);
  if (!reference) {
    return false;
  }
  const text = buildQuickChatReferenceContext(reference);
  if (text.length === 0) {
    return false;
  }

  const pastedTextId = `${QUICK_CHAT_REFERENCE_DRAFT_PREFIX}${reference.threadId}`;
  const createdAt =
    typeof input.now === "string" ? input.now : (input.now ?? new Date()).toISOString();
  const store = useComposerDraftStore.getState();
  // The persisted composer context lane already supports replace/dedupe, prompt
  // history, queued turns, reload hydration, and send-time serialization. The
  // tagged payload lets presentation distinguish this from ordinary pasted text.
  store.removePastedText(input.targetId, pastedTextId);
  store.addPastedTexts(input.targetId, [
    createPastedTextDraft({ id: pastedTextId, createdAt, text }),
  ]);
  requestComposerFocus(input.targetId);
  return true;
}
