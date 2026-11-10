// FILE: restoreUnsentComposerMessage.ts
// Purpose: Hands a message that never reached the server back to the composer: drops its
//          optimistic transcript row and puts its text, attachments and context chips back
//          into the draft, for the chat it was sent from.
// Layer: Chat send helpers, shared by the send preflight (useChatTurnSubmission) and the
//        turn-start failure path (useChatTurnExecution).

import type { MessageId, ProviderMentionReference, ProviderSkillReference } from "@moss/contracts";
import { ThreadId } from "@moss/contracts";

import { collapseExpandedComposerCursor, detectComposerTrigger } from "../../composer-logic";
import { useComposerDraftStore, type QueuedComposerChatTurn } from "../../composerDraftStore";
import { cloneComposerImageAttachment } from "../../lib/composerSend";
import { revokeUserMessagePreviewUrls } from "../ChatView.logic";
import type { ChatTurnSubmissionInput } from "./chatSendTypes";

export type UnsentComposerMessage = {
  threadId: ThreadId;
  messageId: MessageId;
  prompt: string;
  sourceProposedPlan: QueuedComposerChatTurn["sourceProposedPlan"];
  images: ChatTurnSubmissionInput["composerImages"];
  files: ChatTurnSubmissionInput["composerFiles"];
  assistantSelections: ChatTurnSubmissionInput["composerAssistantSelections"];
  browserAnnotations: ChatTurnSubmissionInput["composerBrowserAnnotations"];
  fileComments: ChatTurnSubmissionInput["composerFileComments"];
  terminalContexts: ChatTurnSubmissionInput["composerTerminalContexts"];
  pastedTexts: ChatTurnSubmissionInput["composerPastedTexts"];
  pullRequestContexts: ChatTurnSubmissionInput["composerPullRequestContexts"];
  skills: ProviderSkillReference[];
  mentions: ProviderMentionReference[];
};

export type UnsentComposerMessageRestorers = Pick<
  ChatTurnSubmissionInput,
  | "activeThreadIdRef"
  | "setOptimisticUserMessages"
  | "promptRef"
  | "setPrompt"
  | "setRestoredQueuedSourceProposedPlan"
  | "setComposerCursor"
  | "addComposerImagesToDraft"
  | "addComposerFilesToDraft"
  | "addComposerAssistantSelectionToDraft"
  | "addComposerDraftBrowserAnnotations"
  | "addComposerFileCommentToDraft"
  | "addComposerTerminalContextsToDraft"
  | "addComposerPastedTextsToDraft"
  | "addComposerPullRequestContextsToDraft"
  | "updateSelectedComposerSkills"
  | "updateSelectedComposerMentions"
  | "setComposerTrigger"
>;

/** True while the chat's draft holds nothing the person typed or attached since. */
export function isComposerDraftEmpty(threadId: ThreadId): boolean {
  const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
  return (
    !draft ||
    (draft.prompt.length === 0 &&
      draft.images.length === 0 &&
      draft.files.length === 0 &&
      draft.assistantSelections.length === 0 &&
      draft.browserAnnotations.length === 0 &&
      draft.fileComments.length === 0 &&
      draft.terminalContexts.length === 0 &&
      draft.pastedTexts.length === 0 &&
      draft.pullRequestContexts.length === 0)
  );
}

/**
 * Drops the message's optimistic row and refills its chat's draft. The caller checks the
 * draft is still empty first, so nothing typed meanwhile is overwritten.
 */
export function restoreUnsentComposerMessage(
  message: UnsentComposerMessage,
  restorers: UnsentComposerMessageRestorers,
): void {
  const { threadId } = message;
  const isFocusedSend = restorers.activeThreadIdRef.current === threadId;
  const drafts = useComposerDraftStore.getState();
  if (isFocusedSend)
    restorers.setOptimisticUserMessages((existing) => {
      const removed = existing.filter((row) => row.id === message.messageId);
      for (const row of removed) {
        revokeUserMessagePreviewUrls(row);
      }
      const next = existing.filter((row) => row.id !== message.messageId);
      return next.length === existing.length ? existing : next;
    });
  if (isFocusedSend) restorers.promptRef.current = message.prompt;
  // Bound to the chat the send started in, so it is right even after a switch.
  restorers.setPrompt(message.prompt);
  if (message.sourceProposedPlan) {
    (isFocusedSend
      ? restorers.setRestoredQueuedSourceProposedPlan
      : drafts.setRestoredSourceProposedPlan)(threadId, {
      threadId,
      restoredPrompt: message.prompt,
      sourceProposedPlan: message.sourceProposedPlan,
    });
  }
  if (isFocusedSend)
    restorers.setComposerCursor(
      collapseExpandedComposerCursor(message.prompt, message.prompt.length),
    );
  const images = message.images.map(cloneComposerImageAttachment);
  if (isFocusedSend) restorers.addComposerImagesToDraft(images);
  else drafts.addImages(threadId, images);
  if (isFocusedSend) restorers.addComposerFilesToDraft(message.files);
  else drafts.addFiles(threadId, message.files);
  for (const selection of message.assistantSelections) {
    if (isFocusedSend) restorers.addComposerAssistantSelectionToDraft(selection);
    else drafts.addAssistantSelection(threadId, selection);
  }
  restorers.addComposerDraftBrowserAnnotations(threadId, message.browserAnnotations);
  for (const comment of message.fileComments) {
    if (isFocusedSend) restorers.addComposerFileCommentToDraft(comment);
    else drafts.addFileComment(threadId, comment);
  }
  if (isFocusedSend) restorers.addComposerTerminalContextsToDraft(message.terminalContexts);
  else drafts.addTerminalContexts(threadId, message.terminalContexts);
  if (isFocusedSend) restorers.addComposerPastedTextsToDraft(message.pastedTexts);
  else drafts.addPastedTexts(threadId, message.pastedTexts);
  if (isFocusedSend) restorers.addComposerPullRequestContextsToDraft(message.pullRequestContexts);
  else
    message.pullRequestContexts.forEach((context) =>
      drafts.addPullRequestContext(threadId, context),
    );
  if (isFocusedSend) {
    restorers.updateSelectedComposerSkills(message.skills);
    restorers.updateSelectedComposerMentions(message.mentions);
  } else {
    drafts.setSkills(threadId, message.skills);
    drafts.setMentions(threadId, message.mentions);
  }
  if (isFocusedSend)
    restorers.setComposerTrigger(detectComposerTrigger(message.prompt, message.prompt.length));
}
