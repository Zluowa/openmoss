import { handleDevsReportSend } from "./handleDevsReportSend";
import { MOSS_DEVS_REPORTS_ENABLED } from "@moss/shared/devsReport";
import type {
  MessageId,
  ProviderKind,
  ProviderMentionReference,
  ProviderSkillReference,
  ThreadId,
} from "@moss/contracts";
import { flushWorkspaceEditors } from "~/lib/workspaceEditorSession";
import { resolveComputerInvocationMode } from "@moss/shared/computerInvocation";
import { projectFoldersSessionIssue } from "@moss/shared/projectFolders";
import {
  prepareComputerPermissionGuide,
  readLocalComputerPermissionBridge,
} from "~/lib/computerProvisioning";
import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { hasActiveComposerSend } from "~/lib/composerSendOwnership";
import { getUnconfirmedTurnSend } from "~/lib/unconfirmedTurnSends";
import {
  filterPromptProviderMentionReferences,
  filterPromptSkillReferences,
} from "~/lib/composerMentions";
import { isServerConfiguredMossDefaultManagedProvider } from "~/lib/providerAvailability";
import { fetchFreshMossQuotaAdmission } from "~/lib/mossQuotaAdmission";
import { localizeProviderSendBlockedReason } from "~/lib/providerUnavailablePresentation";
import { newMessageId, randomUUID } from "~/lib/utils";
import {
  beginComposerSendTiming,
  markComposerSend,
  markComposerSendPaintedAfterNextFrame,
} from "~/lib/composerSendTiming";
import { readNativeApi } from "~/nativeApi";
import { resolveFollowUpDispatchMode } from "../../appSettings";
import { useComposerDraftStore, type QueuedComposerChatTurn } from "../../composerDraftStore";
import { appendAssistantSelectionsToPrompt } from "../../lib/assistantSelections";
import { appendBrowserAnnotationsToPrompt } from "../../lib/browserAnnotations";
import { appendPastedTextsToPrompt } from "../../lib/composerPastedText";
import {
  findPendingBlobComposerAttachments,
  formatOutgoingComposerPrompt,
  hydratePendingBlobComposerAttachments,
  readFileAsDataUrl,
  stageUploadComposerAttachments,
} from "../../lib/composerSend";
import { appendFileCommentsToPrompt } from "../../lib/fileComments";
import { appendPullRequestContextsToPrompt } from "../../lib/pullRequestContext";
import { prepareQueuedComposerResumeAfterSend } from "../../lib/queuedComposerDrain";
import {
  IMAGE_ONLY_BOOTSTRAP_PROMPT,
  appendTerminalContextsToPrompt,
} from "../../lib/terminalContext";
import { setPendingUserInputCustomAnswer } from "../../pendingUserInput";
import { resolvePlanFollowUpSubmission } from "../../proposedPlan";
import { buildSourceProposedPlanReference } from "../../session-logic";
import {
  buildBlockedComposerSendToastCopy,
  buildExpiredTerminalContextToastCopy,
  createWorktreeSetupResolution,
  deriveComposerSendState,
  queuedChatTurnDispatchFields,
  queuedPlanFollowUpDispatchFields,
  resolveBlockedComposerSendReason,
  resolveEnvironmentPanelPreferenceAfterFirstSend,
  resolveQueuedTurnDispatchSettings,
  type BlockedComposerSendReason,
  turnNeedsProviderHandoff,
} from "../ChatView.logic";
import { toastManager } from "../ui/toast";
import { serverMossPayQuotaQueryOptions } from "../auth/mossServerReactQuery";
import { useTranslation } from "../../localization";
import type { ChatTurnSubmissionInput } from "./chatSendTypes";
import { isChatComposerSubmitReady, runChatProviderSendPreflight } from "./ChatProviderSendControl";
import { handleChatAutomationSend } from "./handleChatAutomationSend";
import { prepareChatSendWorkspace } from "./prepareChatSendWorkspace";
import {
  buildQueuedComposerPreviewText,
  composerPromptStillMatchesRestoredQueuedDraft,
} from "./queuedComposerPreview";
import { resolveChatPromptCaptures } from "./resolveChatPromptCaptures";
import { useChatTurnExecution } from "./useChatTurnExecution";
import { useStore } from "../../store";
import { getThreadFromState } from "../../threadDerivation";
import { type ChatMessage } from "../../types";
import {
  isComposerDraftEmpty,
  restoreUnsentComposerMessage,
  type UnsentComposerMessage,
} from "./restoreUnsentComposerMessage";
import { isThreadDetailAwaitingVerification } from "../../threadDetailAuthority";

/**
 * The text, references and transcript row of one outgoing message. Built once when the
 * message is shown (right after Enter) and again just before dispatch, when captures may
 * have added a screenshot.
 */
function buildOutgoingComposerMessage(input: {
  messageId: MessageId;
  createdAt: string;
  dispatchMode: "queue" | "steer";
  prompt: string;
  provider: ProviderKind;
  model: string | null;
  effort: string | null;
  images: ChatTurnSubmissionInput["composerImages"];
  files: ChatTurnSubmissionInput["composerFiles"];
  assistantSelections: ChatTurnSubmissionInput["composerAssistantSelections"];
  browserAnnotations: ChatTurnSubmissionInput["composerBrowserAnnotations"];
  fileComments: ChatTurnSubmissionInput["composerFileComments"];
  terminalContexts: ChatTurnSubmissionInput["composerTerminalContexts"];
  pastedTexts: ChatTurnSubmissionInput["composerPastedTexts"];
  pullRequestContexts: ChatTurnSubmissionInput["composerPullRequestContexts"];
  skills: ReadonlyArray<ProviderSkillReference>;
  mentions: ReadonlyArray<ProviderMentionReference>;
}) {
  // Trailing blocks are appended innermost-to-outermost: assistant selections,
  // terminal contexts, file comments, pasted text, pull request contexts, then
  // browser annotations (outermost). The display extractors unwrap them in the
  // reverse order.
  const messageText = appendBrowserAnnotationsToPrompt(
    appendPullRequestContextsToPrompt(
      appendPastedTextsToPrompt(
        appendFileCommentsToPrompt(
          appendTerminalContextsToPrompt(
            appendAssistantSelectionsToPrompt(input.prompt, input.assistantSelections),
            input.terminalContexts,
          ),
          input.fileComments,
        ),
        input.pastedTexts,
      ),
      input.pullRequestContexts,
    ),
    input.browserAnnotations,
    input.messageId,
  );
  const textSeed = messageText || (input.images.length > 0 ? IMAGE_ONLY_BOOTSTRAP_PROMPT : "");
  const text = formatOutgoingComposerPrompt({
    provider: input.provider,
    model: input.model,
    effort: input.effort,
    text: textSeed,
  });
  const skills = filterPromptSkillReferences(text, input.skills, input.provider);
  const mentions = filterPromptProviderMentionReferences(text, input.mentions);
  const attachments = [
    ...input.assistantSelections,
    ...input.images.map((image) => ({
      type: "image" as const,
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      previewUrl: image.previewUrl,
    })),
    ...input.files.map((file) => ({
      type: "file" as const,
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
    })),
  ];
  const row: ChatMessage = {
    id: input.messageId,
    role: "user",
    text,
    dispatchMode: input.dispatchMode,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(skills.length > 0 ? { skills } : {}),
    ...(mentions.length > 0 ? { mentions } : {}),
    createdAt: input.createdAt,
    streaming: false,
    source: "native",
  };
  return { text, skills, mentions, row };
}

/** A message already shown and cleared from the composer, but not yet handed to dispatch. */
type ComposerSendEcho = { current: UnsentComposerMessage | null };

/**
 * Resolves once the browser has painted the next frame, so a message just shown reaches the
 * screen before the send's checks take the main thread. A window that is not painting
 * (hidden) moves on after 50 ms.
 */
function afterNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    const fallback = setTimeout(resolve, 50);
    requestAnimationFrame(() =>
      setTimeout(() => {
        clearTimeout(fallback);
        resolve();
      }, 0),
    );
  });
}

// One toast per chat: pressing Send again refreshes it instead of stacking copies.
function notifyBlockedComposerSend(threadId: ThreadId, reason: BlockedComposerSendReason): void {
  const copy = buildBlockedComposerSendToastCopy(reason);
  toastManager.add({
    id: `composer-send-blocked:${threadId}`,
    type: copy.type,
    title: copy.title,
    description: copy.description,
  });
}

export function useChatTurnSubmission({
  threadId,
  hasLiveTurn,
  canSendWithProviderHandoff,
  prepareProviderHandoffForSend,
  lateComposerSendHandlersRef,
  activeThread,
  isConnecting,
  sendPreflightInFlightRef,
  sendInFlightRef,
  showPlanFollowUpPrompt,
  activeProposedPlan,
  hasQueueableLiveTurn,
  clearComposerInput,
  scheduleComposerFocus,
  activeProject,
  threadWorkspaceCwd,
  refreshProviderStatuses,
  isServerThread,
  hasNativeUserMessages,
  chatWorkspaceRoot,
  isHomeChatContainer,
  isGroupContainer,
  resolvedThreadWorktreePath,
  resolvedThreadWorkingDirectory,
  currentActiveGitBranch,
  isContainerLandingProject,
  syncServerShellSnapshot,
  activeRootBranch,
  gitBranchSourceCwd,
  setStoreThreadError,
  queryClient,
  isCenteredEmptyLanding,
  setEnvironmentPanelPreferenceOpen,
  environmentPanelPreferenceOpen,
  setTailAnchor,
  setThreadError,
  setThreadSendFailure,
  setComposerHighlightedItemId,
  setStoreThreadWorkspace,
  createWorktreeMutation,
  isLocalDraftThread,
  threadNotes,
  setSettledThreadBranchWarningDismissedThreadId,
  setQueuedSteerGate,
  planSidebarDismissedForTurnRef,
  setPlanSidebarOpen,
  settings,
  isSendBusy,
  worktreeSetupResolutionRef,
  setWorktreeSetupPendingAction,
  beginLocalDispatch,
  clearLocalDispatchWorktreeSetup,
  armLocalDispatchAckFallback,
  failLocalDispatchWorktreeSetup,
  scheduleFailedWorktreeSetupDispatchReset,
  resetLocalDispatch,
  isVoiceTranscribing,
  waitForPendingComposerImages,
  activePendingProgress,
  activePendingUserInputKey,
  pendingUserInputAnswersByRequestIdRef,
  setPendingUserInputAnswersByRequestId,
  composerEditorRef,
  promptRef,
  composerImages,
  composerFiles,
  composerAssistantSelections,
  composerBrowserAnnotations,
  composerFileComments,
  composerTerminalContexts,
  composerPastedTexts,
  composerPullRequestContexts,
  restoredQueuedSourceProposedPlanRef,
  enqueueQueuedComposerTurn,
  setComposerDraftPrompt,
  setComposerTrigger,
  clearProjectDraftThreadId,
  setDraftThreadContext,
  promptHistoryNavigationRef,
  applyingPromptHistoryNavigationRef,
  expectedPromptHistoryPromptRef,
  clearComposerDraftContent,
  setComposerDraftInteractionMode,
  setComposerCursor,
  setRestoredQueuedSourceProposedPlan,
  composerImagesRef,
  composerFilesRef,
  composerAssistantSelectionsRef,
  composerBrowserAnnotationsRef,
  composerFileCommentsRef,
  composerTerminalContextsRef,
  composerPastedTextsRef,
  composerPullRequestContextsRef,
  setPrompt,
  addComposerImagesToDraft,
  addComposerFilesToDraft,
  addComposerAssistantSelectionToDraft,
  addComposerDraftBrowserAnnotations,
  addComposerFileCommentToDraft,
  addComposerTerminalContextsToDraft,
  addComposerPastedTextsToDraft,
  addComposerPullRequestContextsToDraft,
  selectedComposerSkillsRef,
  selectedComposerMentionsRef,
  updateSelectedComposerSkills,
  updateSelectedComposerMentions,
  selectedProvider,
  selectedModel,
  selectedPromptEffort,
  turnDispatchSettings,
  computerControlChangeSequence,
  setComposerDraftComputerControlMode,
  pendingAutomationConversationRef,
  setPendingAutomationConversation,
  pendingAutomationConversation,
  activeThreadIdRef,
  hasLiveTurnRef,
  automationProjects,
  setAutomationDraftWarningContext,
  setAutomationDraftForm,
  setAutomationDraftWarnings,
  setAcknowledgedAutomationWarnings,
  setAutomationDraftOpen,
  armTranscriptAutoFollow,
  tailAnchorScrollInFlightRef,
  prepareAutomationFormForCreate,
  createAutomationFromForm,
  providerStatuses,
  isPreparingWorktree,
  serverSettings,
  mossQuotaAccountIdentity,
  mossQuotaAccountIdentityRef,
  mossQuotaAccountTransitionPendingRef,
  rememberCustomBinaryPathForDispatch,
  setOptimisticUserMessages,
  runProjectScript,
  persistThreadSettingsForNextTurn,
}: ChatTurnSubmissionInput) {
  const { locale, t } = useTranslation();
  // Dedupe repeat submits of identical content (double clicks, Enter key repeat)
  // so a single user gesture can never dispatch the same turn twice.
  const composerSendGateRef = useRef<{ threadId: typeof threadId; key: string } | null>(null);
  // Messages shown on screen whose preflight is still running. Another send waits for
  // them, so a slow check can never reorder two messages.
  const echoesInFlightRef = useRef(0);
  const anchorSentMessagesToTopRef = useRef(settings.anchorSentMessagesToTop);
  useLayoutEffect(() => {
    anchorSentMessagesToTopRef.current = settings.anchorSentMessagesToTop;
  }, [settings.anchorSentMessagesToTop]);

  const executePreparedTurn = useChatTurnExecution({
    prepareProviderHandoffForSend,
    activeThreadIdRef,
    isServerThread,
    setStoreThreadWorkspace,
    clearLocalDispatchWorktreeSetup,
    createWorktreeMutation,
    beginLocalDispatch,
    isLocalDraftThread,
    threadNotes,
    runProjectScript,
    persistThreadSettingsForNextTurn,
    rememberCustomBinaryPathForDispatch,
    computerControlChangeSequence,
    setComposerDraftComputerControlMode,
    setSettledThreadBranchWarningDismissedThreadId,
    armLocalDispatchAckFallback,
    setQueuedSteerGate,
    threadId,
    planSidebarDismissedForTurnRef,
    setPlanSidebarOpen,
    setRestoredQueuedSourceProposedPlan,
    failLocalDispatchWorktreeSetup,
    setOptimisticUserMessages,
    promptRef,
    setPrompt,
    setComposerCursor,
    addComposerImagesToDraft,
    addComposerFilesToDraft,
    addComposerAssistantSelectionToDraft,
    addComposerDraftBrowserAnnotations,
    addComposerFileCommentToDraft,
    addComposerTerminalContextsToDraft,
    addComposerPastedTextsToDraft,
    addComposerPullRequestContextsToDraft,
    updateSelectedComposerSkills,
    updateSelectedComposerMentions,
    setComposerTrigger,
    setThreadSendFailure,
    sendInFlightRef,
    worktreeSetupResolutionRef,
    scheduleFailedWorktreeSetupDispatchReset,
    resetLocalDispatch,
  });

  const performComposerSend = useCallback(
    async (
      requestedDispatchMode?: "queue" | "steer",
      queuedTurn?: QueuedComposerChatTurn,
      echo?: ComposerSendEcho,
    ): Promise<boolean> => {
      // Fail closed while a worktree is preparing: a native submit must never
      // reach provider refresh, thread creation, or turn dispatch early.
      if (!isChatComposerSubmitReady({ isPreparingWorktree })) {
        return false;
      }
      const dispatchMode =
        requestedDispatchMode ??
        resolveFollowUpDispatchMode({
          behavior: settings.followUpBehavior,
          hasLiveTurn,
        });
      const api = readNativeApi();
      const lateSendHandlers = lateComposerSendHandlersRef.current;
      if (
        !api ||
        !lateSendHandlers ||
        !activeThread ||
        activeThread.claudeCacheReview != null ||
        activeThread.sidechatExpiredAt ||
        isVoiceTranscribing
      ) {
        return false;
      }
      // A message whose delivery is not confirmed yet holds the chat: sending more now could
      // reorder or duplicate it. The notice above the composer offers retry or discard.
      if (getUnconfirmedTurnSend(activeThread.id)) {
        if (!queuedTurn) {
          toastManager.add({
            id: `composer-send-blocked:${activeThread.id}`,
            type: "warning",
            title: t("chat.unconfirmedSend.blockedTitle"),
            description: t("chat.unconfirmedSend.blockedDescription"),
          });
        }
        return false;
      }
      const sendInFlight =
        hasActiveComposerSend(activeThread.id) ||
        isSendBusy ||
        sendPreflightInFlightRef.current ||
        sendInFlightRef.current ||
        echoesInFlightRef.current > 0;
      const awaitingVerification = isThreadDetailAwaitingVerification(activeThread.id);
      if (sendInFlight || isConnecting || awaitingVerification) {
        const blockedReason = resolveBlockedComposerSendReason({
          sendInFlight,
          sessionStarting: isConnecting || awaitingVerification,
          hasComposerContent:
            (composerEditorRef.current?.readSnapshot().value ?? promptRef.current).trim().length >
              0 ||
            composerImages.length > 0 ||
            composerFiles.length > 0,
        });
        // Queue drains retry on their own; only a person pressing Send needs to hear why.
        if (blockedReason !== null && !queuedTurn) {
          notifyBlockedComposerSend(activeThread.id, blockedReason);
        }
        return false;
      }
      const hasPendingCacheReview = () =>
        getThreadFromState(useStore.getState(), activeThread.id)?.claudeCacheReview != null ||
        isThreadDetailAwaitingVerification(activeThread.id);
      if (hasPendingCacheReview()) return false;
      const resumeQueueAfterSend =
        !queuedTurn || dispatchMode === "steer"
          ? prepareQueuedComposerResumeAfterSend(activeThread.id)
          : undefined;
      sendPreflightInFlightRef.current = true;
      const editorSaved = await flushWorkspaceEditors(
        queryClient,
        threadWorkspaceCwd ?? chatWorkspaceRoot,
      ).catch(() => false);
      sendPreflightInFlightRef.current = false;
      markComposerSend("editors-saved");
      if (!editorSaved) {
        setThreadError(
          threadId,
          "Could not save editor changes. Resolve the save error before sending; your prompt and file draft are preserved.",
        );
        return false;
      }
      if (!queuedTurn) {
        sendPreflightInFlightRef.current = true;
        await waitForPendingComposerImages();
        sendPreflightInFlightRef.current = false;
      }
      markComposerSend("images-ready");
      if (
        !activePendingProgress &&
        (!queuedTurn ||
          turnNeedsProviderHandoff({
            thread: activeThread,
            modelSelection: queuedTurn.modelSelection,
          })) &&
        canSendWithProviderHandoff?.(queuedTurn?.modelSelection) === false
      ) {
        return false;
      }
      if (hasPendingCacheReview()) return false;
      if (activePendingProgress) {
        const activeQuestion = activePendingProgress.activeQuestion;
        const liveComposerSnapshot = composerEditorRef.current?.readSnapshot() ?? null;
        const livePendingAnswerText = liveComposerSnapshot?.value ?? promptRef.current;
        const currentDraftAnswer =
          activePendingUserInputKey && activeQuestion
            ? pendingUserInputAnswersByRequestIdRef.current[activePendingUserInputKey]?.[
                activeQuestion.id
              ]
            : undefined;
        const answerOverrides =
          activeQuestion && livePendingAnswerText.trim().length > 0
            ? {
                [activeQuestion.id]: setPendingUserInputCustomAnswer(
                  currentDraftAnswer,
                  livePendingAnswerText,
                ),
              }
            : undefined;
        if (activePendingUserInputKey && answerOverrides) {
          const nextRequestAnswers = {
            ...pendingUserInputAnswersByRequestIdRef.current[activePendingUserInputKey],
            ...answerOverrides,
          };
          pendingUserInputAnswersByRequestIdRef.current = {
            ...pendingUserInputAnswersByRequestIdRef.current,
            [activePendingUserInputKey]: nextRequestAnswers,
          };
          setPendingUserInputAnswersByRequestId((existing) => ({
            ...existing,
            [activePendingUserInputKey]: nextRequestAnswers,
          }));
        }
        return lateSendHandlers.advanceActivePendingUserInput(answerOverrides);
      }
      const queuedChatTurn = queuedTurn ?? null;
      let dispatchSettings = resolveQueuedTurnDispatchSettings(
        turnDispatchSettings,
        queuedChatTurn,
      );
      const computerControlSequenceForSend = computerControlChangeSequence.current;
      const liveComposerSnapshot =
        queuedChatTurn === null ? (composerEditorRef.current?.readSnapshot() ?? null) : null;
      let promptForSend =
        queuedChatTurn?.prompt ?? liveComposerSnapshot?.value ?? promptRef.current;
      if (queuedChatTurn === null) {
        // Read the live editor snapshot, not an earlier React render. A queued
        // command already froze its mode and generation and must not be inferred again.
        const mode = resolveComputerInvocationMode({
          messageText: promptForSend,
          enableComputerControl: settings.computerControlEnabled,
        });
        dispatchSettings = {
          ...dispatchSettings,
          computerControlMode: mode,
          enableComputerControl: mode !== "off",
        };
      }
      let composerImagesForSend =
        queuedChatTurn?.images ??
        useComposerDraftStore.getState().draftsByThreadId[activeThread.id]?.images ??
        composerImages;
      // AppSnap captures persist as IndexedDB blobs and hydrate into `images`
      // asynchronously (see AppSnapCoordinator). Right after a reload the user can
      // hit send before that hydration finishes; without this, the not-yet-hydrated
      // capture would be silently dropped from the message and then have its blob
      // deleted when the composer clears after send. Live sends only: a queued turn
      // already captured a fully-resolved image snapshot when it was queued.
      if (queuedChatTurn === null) {
        const pendingBlobAttachments = findPendingBlobComposerAttachments({
          persistedAttachments:
            useComposerDraftStore.getState().draftsByThreadId[activeThread.id]
              ?.persistedAttachments ?? [],
          images: composerImagesForSend,
        });
        if (pendingBlobAttachments.length > 0) {
          const hydratedPendingImages =
            await hydratePendingBlobComposerAttachments(pendingBlobAttachments);
          if (hydratedPendingImages.length > 0) {
            composerImagesForSend = [...composerImagesForSend, ...hydratedPendingImages];
          }
        }
      }
      const composerFilesForSend = queuedChatTurn?.files ?? composerFiles;
      if (hasPendingCacheReview()) return false;
      const composerAssistantSelectionsForSend =
        queuedChatTurn?.assistantSelections ?? composerAssistantSelections;
      const composerBrowserAnnotationsForSend =
        queuedChatTurn?.browserAnnotations ?? composerBrowserAnnotations;
      const composerFileCommentsForSend = queuedChatTurn?.fileComments ?? composerFileComments;
      const composerTerminalContextsForSend =
        queuedChatTurn?.terminalContexts ?? composerTerminalContexts;
      // Canvas context can finish preparing while the composer send guard awaits
      // a save. Read that live draft just as we do for prepared image attachments.
      const composerPastedTextsForSend =
        queuedChatTurn?.pastedTexts ??
        useComposerDraftStore.getState().draftsByThreadId[activeThread.id]?.pastedTexts ??
        composerPastedTexts;
      const composerPullRequestContextsForSend =
        queuedChatTurn?.pullRequestContexts ?? composerPullRequestContexts;
      const selectedComposerSkillsForSend =
        queuedChatTurn?.skills ?? selectedComposerSkillsRef.current;
      const selectedComposerMentionsForSend =
        queuedChatTurn?.mentions ?? selectedComposerMentionsRef.current;
      const selectedProviderForSend = queuedChatTurn?.selectedProvider ?? selectedProvider;
      const selectedModelForSend = queuedChatTurn?.selectedModel ?? selectedModel;
      const selectedPromptEffortForSend =
        queuedChatTurn?.selectedPromptEffort ?? selectedPromptEffort;
      const selectedModelSelectionForSend = dispatchSettings.modelSelection;
      const providerOptionsForDispatchForSend = dispatchSettings.providerOptions;
      const runtimeModeForSend = dispatchSettings.runtimeMode;
      let interactionModeForSend = dispatchSettings.interactionMode;
      const envModeForSend = dispatchSettings.envMode;
      const {
        trimmedPrompt: trimmed,
        sendableTerminalContexts: sendableComposerTerminalContexts,
        expiredTerminalContextCount,
        sendablePastedTexts: sendableComposerPastedTexts,
        sendablePullRequestContexts: sendableComposerPullRequestContexts,
        hasSendableContent: hasSendableComposerContent,
        hasDraftContent,
      } = deriveComposerSendState({
        prompt: promptForSend,
        imageCount: composerImagesForSend.length,
        fileCount: composerFilesForSend.length,
        assistantSelectionCount: composerAssistantSelectionsForSend.length,
        assistantSelectionReplyCount: composerAssistantSelectionsForSend.filter(
          (selection) => (selection.comment ?? "").trim().length > 0,
        ).length,
        browserAnnotationCount: composerBrowserAnnotationsForSend.length,
        fileCommentCount: composerFileCommentsForSend.length,
        terminalContexts: composerTerminalContextsForSend,
        pastedTexts: composerPastedTextsForSend,
        pullRequestContexts: composerPullRequestContextsForSend,
      });
      // A turn queued earlier already passed the composer's check when it was queued.
      const hasSendableContent =
        queuedChatTurn !== null ? hasDraftContent : hasSendableComposerContent;
      let trimmedPromptForSend = trimmed;
      const restoredQueuedPlanDraftSource =
        queuedChatTurn === null &&
        restoredQueuedSourceProposedPlanRef.current?.threadId === activeThread.id &&
        composerPromptStillMatchesRestoredQueuedDraft(
          restoredQueuedSourceProposedPlanRef.current.restoredPrompt,
          promptForSend,
        )
          ? restoredQueuedSourceProposedPlanRef.current
          : null;
      const isLivePlanFollowUpSubmission =
        queuedChatTurn === null &&
        restoredQueuedPlanDraftSource === null &&
        showPlanFollowUpPrompt &&
        activeProposedPlan !== null;
      const hasStructuredPlanFollowUpContent =
        composerImagesForSend.length > 0 ||
        composerFilesForSend.length > 0 ||
        composerAssistantSelectionsForSend.length > 0 ||
        composerBrowserAnnotationsForSend.length > 0 ||
        composerFileCommentsForSend.length > 0 ||
        sendableComposerTerminalContexts.length > 0 ||
        sendableComposerPastedTexts.length > 0;
      // Queued chat turns already captured their intended mode. Live plan follow-ups
      // with attachments must use the normal send path so references are preserved.
      if (isLivePlanFollowUpSubmission) {
        const followUp = resolvePlanFollowUpSubmission({
          draftText: trimmed,
          planMarkdown: activeProposedPlan.planMarkdown,
        });
        if (hasStructuredPlanFollowUpContent) {
          promptForSend = followUp.text;
          interactionModeForSend = followUp.interactionMode;
          trimmedPromptForSend = followUp.text.trim();
        } else {
          if (hasQueueableLiveTurn && dispatchMode === "queue") {
            clearComposerInput(activeThread.id);
            scheduleComposerFocus();
            enqueueQueuedComposerTurn(activeThread.id, {
              id: randomUUID(),
              kind: "plan-follow-up",
              createdAt: new Date().toISOString(),
              previewText: followUp.text.trim(),
              text: followUp.text,
              interactionMode: followUp.interactionMode,
              selectedProvider,
              selectedModel,
              selectedPromptEffort,
              ...queuedPlanFollowUpDispatchFields(turnDispatchSettings),
            });
            return true;
          }
          clearComposerInput(activeThread.id);
          scheduleComposerFocus();
          return lateSendHandlers.submitPlanFollowUp({
            text: followUp.text,
            interactionMode: followUp.interactionMode,
            dispatchMode,
            ...(resumeQueueAfterSend ? { resumeQueueAfterSend } : {}),
          });
        }
      }
      const hasNoStructuredComposerContext =
        composerImagesForSend.length === 0 &&
        composerFilesForSend.length === 0 &&
        composerAssistantSelectionsForSend.length === 0 &&
        composerBrowserAnnotationsForSend.length === 0 &&
        composerFileCommentsForSend.length === 0 &&
        sendableComposerTerminalContexts.length === 0 &&
        sendableComposerPastedTexts.length === 0 &&
        // Provider mentions are structured turn metadata, and automation definitions persist text only.
        selectedComposerMentionsForSend.length === 0;
      const hasPromptOnlySendableContent = hasNoStructuredComposerContext;
      if (hasPromptOnlySendableContent) {
        const handledSlashCommand =
          await lateSendHandlers.handleStandaloneSlashCommand(trimmedPromptForSend);
        if (handledSlashCommand) {
          // A slash command (e.g. /clear) consumes the composer, so abandon any in-progress
          // automation setup rather than leaving a stale banner/request behind.
          pendingAutomationConversationRef.current = null;
          setPendingAutomationConversation(null);
          return true;
        }
      }
      const sourceProposedPlanForSend =
        queuedChatTurn?.sourceProposedPlan ??
        restoredQueuedPlanDraftSource?.sourceProposedPlan ??
        (isLivePlanFollowUpSubmission && activeProposedPlan && interactionModeForSend === "default"
          ? buildSourceProposedPlanReference({
              threadId: activeThread.id,
              proposedPlan: activeProposedPlan,
            })
          : undefined);
      if (hasPendingCacheReview()) return false;
      if (!hasSendableContent) {
        if (expiredTerminalContextCount > 0) {
          const toastCopy = buildExpiredTerminalContextToastCopy(
            expiredTerminalContextCount,
            "empty",
          );
          toastManager.add({
            type: "warning",
            title: toastCopy.title,
            description: toastCopy.description,
          });
        }
        return false;
      }
      if (!activeProject) {
        if (queuedChatTurn === null) notifyBlockedComposerSend(activeThread.id, "no-project");
        return false;
      }
      if (queuedChatTurn === null && !isLivePlanFollowUpSubmission) {
        const handled = await handleChatAutomationSend({
          threadId,
          pendingAutomationConversation,
          trimmedPromptForSend,
          threadWorkspaceCwd,
          activeProject,
          api,
          activeThreadIdRef,
          pendingAutomationConversationRef,
          hasLiveTurn,
          hasLiveTurnRef,
          hasPromptOnlySendableContent,
          promptRef,
          setComposerDraftPrompt,
          activeThread,
          setComposerTrigger,
          armTranscriptAutoFollow,
          setPendingAutomationConversation,
          automationProjects,
          selectedModelSelectionForSend,
          setAutomationDraftWarningContext,
          setAutomationDraftForm,
          setAutomationDraftWarnings,
          setAcknowledgedAutomationWarnings,
          setAutomationDraftOpen,
          prepareAutomationFormForCreate,
          createAutomationFromForm,
          providerOptionsForDispatchForSend,
        });
        if (handled) return true;
      }
      markComposerSend("commands-checked");
      if (hasPendingCacheReview()) return false;
      if (dispatchSettings.computerControlMode === "request") {
        const appSnap = readLocalComputerPermissionBridge();
        const activeThreadBeforeCheck = activeThreadIdRef.current;
        const draftBeforeCheck = promptRef.current;
        sendPreflightInFlightRef.current = true;
        const ready = await prepareComputerPermissionGuide({
          ...(appSnap
            ? {
                getPermissionState: appSnap.getState,
                startPermissionSetup: appSnap.startPermissionSetup,
              }
            : {}),
          isCurrent: () =>
            activeThreadIdRef.current === activeThreadBeforeCheck &&
            computerControlChangeSequence.current === computerControlSequenceForSend &&
            (queuedChatTurn !== null || promptRef.current === draftBeforeCheck),
        })
          .catch((error) => {
            toastManager.add({
              type: "error",
              title: "Computer permission setup could not start",
              description: String(error),
            });
            return false;
          })
          .finally(() => {
            sendPreflightInFlightRef.current = false;
          });
        if (!ready) return false;
      }

      // From here on it is a chat message. Show it and empty the composer now, the way
      // Claude does; the provider, quota, capture and workspace checks below run after.
      // If one of them stops the send, the caller hands the message back to the composer.
      const messageIdForSend = newMessageId();
      const messageCreatedAt = new Date().toISOString();
      const echoesMessage =
        echo !== undefined &&
        queuedChatTurn === null &&
        !(hasQueueableLiveTurn && dispatchMode === "queue");
      const presentSentMessage = (row: ChatMessage) => {
        // Sending the first message flips the centered empty landing into a normal
        // transcript. Clear session-only landing overrides when default-open is enabled;
        // otherwise keep the transition closed.
        if (isCenteredEmptyLanding) {
          setEnvironmentPanelPreferenceOpen(
            resolveEnvironmentPanelPreferenceAfterFirstSend({
              isCenteredEmptyLanding,
              settingsDefaultOpen: settings.environmentPanelDefaultOpen,
              currentPreferenceOpen: environmentPanelPreferenceOpen,
            }),
          );
        }
        setOptimisticUserMessages((existing) => [...existing, row]);
        markComposerSend("echo");
        markComposerSendPaintedAfterNextFrame();
        // Always follow the sent message. When anchoring is enabled, its hook owns
        // the slide to the top; otherwise normal auto-follow keeps the tail visible.
        armTranscriptAutoFollow(activeThread.id, true);
        const anchorSentMessage = anchorSentMessagesToTopRef.current;
        tailAnchorScrollInFlightRef.current = anchorSentMessage;
        setTailAnchor(anchorSentMessage ? { threadId: activeThread.id, messageId: row.id } : null);
        // Queued turns are dispatched from their captured snapshot, so this send path
        // must not clear a separate live draft the user may already be editing.
        if (queuedChatTurn === null) {
          promptHistoryNavigationRef.current = null;
          applyingPromptHistoryNavigationRef.current = false;
          expectedPromptHistoryPromptRef.current = null;
          promptRef.current = "";
          clearComposerDraftContent(activeThread.id, { preservePreviewUrls: true });
          if (isLivePlanFollowUpSubmission) {
            setComposerDraftInteractionMode(activeThread.id, interactionModeForSend);
          }
          setComposerHighlightedItemId(null);
          setComposerCursor(0);
          setComposerTrigger(null);
          // A clicked submit button steals focus; return it after the controlled
          // draft reset so rapid follow-up typing lands in the composer.
          scheduleComposerFocus();
        }
      };
      const outgoingMessageFor = (images: typeof composerImagesForSend) =>
        buildOutgoingComposerMessage({
          messageId: messageIdForSend,
          createdAt: messageCreatedAt,
          dispatchMode,
          prompt: promptForSend,
          provider: selectedProviderForSend,
          model: selectedModelForSend,
          effort: selectedPromptEffortForSend,
          images,
          files: composerFilesForSend,
          assistantSelections: composerAssistantSelectionsForSend,
          browserAnnotations: composerBrowserAnnotationsForSend,
          fileComments: composerFileCommentsForSend,
          terminalContexts: sendableComposerTerminalContexts,
          pastedTexts: sendableComposerPastedTexts,
          pullRequestContexts: sendableComposerPullRequestContexts,
          skills: selectedComposerSkillsForSend,
          mentions: selectedComposerMentionsForSend,
        });
      if (echoesMessage) {
        presentSentMessage(outgoingMessageFor(composerImagesForSend).row);
        echo.current = {
          threadId: activeThread.id,
          messageId: messageIdForSend,
          prompt: promptForSend,
          sourceProposedPlan: sourceProposedPlanForSend,
          images: [...composerImagesForSend],
          files: [...composerFilesForSend],
          assistantSelections: [...composerAssistantSelectionsForSend],
          browserAnnotations: composerBrowserAnnotationsForSend,
          fileComments: [...composerFileCommentsForSend],
          terminalContexts: [...sendableComposerTerminalContexts],
          pastedTexts: [...sendableComposerPastedTexts],
          pullRequestContexts: [...sendableComposerPullRequestContexts],
          skills: [...selectedComposerSkillsForSend],
          mentions: [...selectedComposerMentionsForSend],
        };
        echoesInFlightRef.current += 1;
        await afterNextPaint();
      }

      const sendProviderAvailability = await runChatProviderSendPreflight({
        provider: selectedModelSelectionForSend.provider,
        instanceId: selectedModelSelectionForSend.instanceId,
        statuses: providerStatuses,
        managedInstanceConfigured: isServerConfiguredMossDefaultManagedProvider(
          serverSettings,
          selectedModelSelectionForSend.instanceId,
        ),
        refreshStatuses: () => refreshProviderStatuses({ silent: true }),
        onPreflightStart: () => {
          sendPreflightInFlightRef.current = true;
        },
        onPreflightEnd: () => {
          sendPreflightInFlightRef.current = false;
        },
        onBlocked: (blockedAvailability) => {
          toastManager.add({
            type: "error",
            title: localizeProviderSendBlockedReason(locale, blockedAvailability),
          });
        },
      });
      markComposerSend("provider-checked");
      if (!sendProviderAvailability.usable) {
        return false;
      }

      // Refresh only the exact managed Moss instances immediately before any
      // browser/device attachment, queue persistence, optimistic message, or
      // worktree path. Query errors are unavailable proof and therefore preserve
      // the normal provider failure path; only a fresh same-account metered zero
      // gets the dedicated quota outcome.
      const managedMossSend = isServerConfiguredMossDefaultManagedProvider(
        serverSettings,
        selectedModelSelectionForSend.instanceId,
      );
      const sendQuotaAccountIdentity = mossQuotaAccountIdentity;
      if (managedMossSend && sendQuotaAccountIdentity !== null) {
        const quotaOptions = serverMossPayQuotaQueryOptions({
          enabled: true,
          accountIdentity: sendQuotaAccountIdentity,
        });
        const freshMossQuotaAdmission = await fetchFreshMossQuotaAdmission({
          instanceId:
            selectedModelSelectionForSend.instanceId ?? selectedModelSelectionForSend.provider,
          driver: selectedModelSelectionForSend.provider,
          accountIdentity: sendQuotaAccountIdentity,
          isTransitionPending: () => mossQuotaAccountTransitionPendingRef.current,
          getCurrentAccountIdentity: () => mossQuotaAccountIdentityRef.current,
          fetchQuota: () => queryClient.fetchQuery({ ...quotaOptions, staleTime: 0 }),
          getFetchedAt: () => queryClient.getQueryState(quotaOptions.queryKey)?.dataUpdatedAt ?? 0,
        });
        if (freshMossQuotaAdmission.kind === "exhausted") {
          return false;
        }
      }
      markComposerSend("quota-checked");
      // The server refuses these chats too; stopping here explains why and avoids
      // creating a worktree the turn would never use.
      const projectFolderIssue =
        (activeProject.additionalFolders?.length ?? 0) > 0
          ? projectFoldersSessionIssue({
              provider: selectedModelSelectionForSend.provider,
              worktree: envModeForSend === "worktree",
            })
          : null;
      if (projectFolderIssue !== null) {
        toastManager.add({ type: "error", title: projectFolderIssue });
        return false;
      }
      if (hasPendingCacheReview()) return false;

      const captures = await resolveChatPromptCaptures({
        api,
        activeThread,
        promptForSend,
        composerImagesForSend,
        composerFilesForSend,
        composerAssistantSelectionsForSend,
      });
      composerImagesForSend = captures.composerImagesForSend;
      markComposerSend("captures-resolved");
      if (hasPendingCacheReview()) return false;

      if (hasQueueableLiveTurn && dispatchMode === "queue" && queuedChatTurn === null) {
        clearComposerInput(activeThread.id);
        scheduleComposerFocus();
        const queuedImagesForPersistence = await Promise.all(
          composerImagesForSend.map(async (image) => {
            try {
              return {
                ...image,
                previewUrl: await readFileAsDataUrl(image.file),
              };
            } catch {
              return image;
            }
          }),
        );
        enqueueQueuedComposerTurn(activeThread.id, {
          id: randomUUID(),
          kind: "chat",
          createdAt: new Date().toISOString(),
          previewText: buildQueuedComposerPreviewText({
            trimmedPrompt: trimmed,
            images: queuedImagesForPersistence,
            files: composerFilesForSend,
            assistantSelections: composerAssistantSelectionsForSend,
            browserAnnotations: composerBrowserAnnotationsForSend,
            terminalContexts: sendableComposerTerminalContexts,
            fileComments: composerFileCommentsForSend,
            pastedTexts: sendableComposerPastedTexts,
            pullRequestContexts: sendableComposerPullRequestContexts,
          }),
          prompt: promptForSend,
          images: queuedImagesForPersistence,
          files: composerFilesForSend,
          assistantSelections: composerAssistantSelectionsForSend,
          browserAnnotations: composerBrowserAnnotationsForSend,
          fileComments: composerFileCommentsForSend,
          terminalContexts: sendableComposerTerminalContexts,
          pastedTexts: sendableComposerPastedTexts,
          pullRequestContexts: sendableComposerPullRequestContexts,
          skills: selectedComposerSkillsForSend,
          mentions: selectedComposerMentionsForSend,
          selectedProvider: selectedProviderForSend,
          selectedModel: selectedModelForSend,
          selectedPromptEffort: selectedPromptEffortForSend,
          ...queuedChatTurnDispatchFields(dispatchSettings, sourceProposedPlanForSend),
          envMode: envModeForSend,
        });
        return true;
      }
      const workspace = await prepareChatSendWorkspace({
        activeThread,
        isServerThread,
        hasNativeUserMessages,
        composerImagesForSend,
        trimmedPromptForSend,
        composerFilesForSend,
        composerAssistantSelectionsForSend,
        composerBrowserAnnotationsForSend,
        sendableComposerTerminalContexts,
        composerFileCommentsForSend,
        sendableComposerPastedTexts,
        selectedModelSelectionForSend,
        selectedModelForSend,
        activeProject,
        chatWorkspaceRoot,
        isHomeChatContainer,
        isGroupContainer,
        resolvedThreadWorktreePath,
        runtimeModeForSend,
        envModeForSend,
        resolvedThreadWorkingDirectory,
        currentActiveGitBranch,
        isContainerLandingProject,
        api,
        syncServerShellSnapshot,
        clearProjectDraftThreadId,
        setDraftThreadContext,
        activeRootBranch,
        gitBranchSourceCwd,
        setStoreThreadError,
        queryClient,
      });
      if (workspace === false) return false;
      markComposerSend("workspace-ready");
      if (hasPendingCacheReview()) return false;
      const {
        threadIdForSend,
        title,
        targetProjectIdForSend,
        targetProjectKindForSend,
        targetProjectCwdForSend,
        targetProjectDefaultModelSelectionForSend,
        nextRuntimeModeForSend,
        nextThreadEnvMode,
        nextThreadBranch,
        nextThreadWorktreePath,
        nextThreadWorkingDirectory,
        nextAssociatedWorktreePath,
        nextAssociatedWorktreeBranch,
        nextAssociatedWorktreeRef,
        shouldResumeSettledLocalThread,
        currentActiveGitBranchForSend,
        baseBranchForWorktree,
        setupScriptForWorktree,
        worktreeSetupScriptName,
        worktreeCopiesLocalChanges,
      } = workspace;
      const worktreeSetupResolution = baseBranchForWorktree
        ? createWorktreeSetupResolution()
        : null;
      worktreeSetupResolutionRef.current = worktreeSetupResolution;
      if (worktreeSetupResolution) {
        setWorktreeSetupPendingAction(null);
      }

      sendInFlightRef.current = true;
      beginLocalDispatch({
        expectedUserMessageId: messageIdForSend,
        ...(baseBranchForWorktree
          ? {
              worktreeSetupStepId: "create-branch" as const,
              setupScriptName: worktreeSetupScriptName,
              copyLocalChanges: worktreeCopiesLocalChanges,
            }
          : {}),
      });

      const composerImagesSnapshot = [...composerImagesForSend];
      const composerFilesSnapshot = [...composerFilesForSend];
      const composerAssistantSelectionsSnapshot = [...composerAssistantSelectionsForSend];
      const composerBrowserAnnotationsSnapshot = composerBrowserAnnotationsForSend.map(
        (annotation) => ({ ...annotation, source: { ...annotation.source } }),
      );
      const composerFileCommentsSnapshot = [...composerFileCommentsForSend];
      const composerTerminalContextsSnapshot = [...sendableComposerTerminalContexts];
      const composerPastedTextsSnapshot = [...sendableComposerPastedTexts];
      const composerPullRequestContextsSnapshot = [...sendableComposerPullRequestContexts];
      const composerSkillsSnapshot = [...selectedComposerSkillsForSend];
      const composerMentionsSnapshot = [...selectedComposerMentionsForSend];
      const {
        text: outgoingMessageText,
        skills: mentionedSkillsForSend,
        mentions: mentionedPluginMentionsForSend,
        row: sentMessageRow,
      } = outgoingMessageFor(composerImagesSnapshot);
      const turnAttachmentsPromise = stageUploadComposerAttachments({
        threadId: threadIdForSend,
        images: composerImagesSnapshot,
        files: composerFilesSnapshot,
        assistantSelections: composerAssistantSelectionsSnapshot,
      });
      if (echo?.current) {
        // Already on screen; captures may have added a screenshot since, so refresh it.
        // From here on a failed dispatch hands the message back itself.
        setOptimisticUserMessages((existing) =>
          existing.some((row) => row.id === messageIdForSend)
            ? existing.map((row) => (row.id === messageIdForSend ? sentMessageRow : row))
            : [...existing, sentMessageRow],
        );
        echo.current = null;
        echoesInFlightRef.current = Math.max(0, echoesInFlightRef.current - 1);
      } else {
        presentSentMessage(sentMessageRow);
      }

      setThreadError(threadIdForSend, null);
      if (expiredTerminalContextCount > 0) {
        const toastCopy = buildExpiredTerminalContextToastCopy(
          expiredTerminalContextCount,
          "omitted",
        );
        toastManager.add({
          type: "warning",
          title: toastCopy.title,
          description: toastCopy.description,
        });
      }

      const sent = await executePreparedTurn({
        nextThreadEnvMode,
        nextThreadBranch,
        nextThreadWorktreePath,
        nextAssociatedWorktreePath,
        nextAssociatedWorktreeBranch,
        nextAssociatedWorktreeRef,
        turnDispatchSettings: dispatchSettings,
        computerControlSequenceForSend,
        api,
        targetProjectCwdForSend,
        threadIdForSend,
        worktreeSetupResolution,
        baseBranchForWorktree,
        worktreeCopiesLocalChanges,
        worktreeSetupScriptName,
        selectedModelSelectionForSend,
        selectedModelForSend,
        targetProjectDefaultModelSelectionForSend,
        targetProjectIdForSend,
        title,
        nextRuntimeModeForSend,
        interactionModeForSend,
        nextThreadWorkingDirectory,
        activeThread,
        targetProjectKindForSend,
        setupScriptForWorktree,
        messageCreatedAt,
        turnAttachmentsPromise,
        messageIdForSend,
        providerOptionsForDispatchForSend,
        outgoingMessageText,
        mentionedSkillsForSend,
        mentionedPluginMentionsForSend,
        dispatchMode,
        sourceProposedPlanForSend,
        shouldResumeSettledLocalThread,
        currentActiveGitBranchForSend,
        queuedChatTurn,
        promptForSend,
        composerImagesSnapshot,
        composerFilesSnapshot,
        composerAssistantSelectionsSnapshot,
        composerBrowserAnnotationsSnapshot,
        composerFileCommentsSnapshot,
        composerTerminalContextsSnapshot,
        composerPastedTextsSnapshot,
        composerPullRequestContextsSnapshot,
        composerSkillsSnapshot,
        composerMentionsSnapshot,
      });
      // A message the user sends by hand (or steers from the queue) resumes a queue
      // paused by Stop; it goes first and the queue follows once its turn ends.
      if (sent) {
        markComposerSend("dispatched");
        resumeQueueAfterSend?.();
      }
      return sent;
    },
    [
      threadId,
      hasLiveTurn,
      lateComposerSendHandlersRef,
      activeThread,
      isConnecting,
      sendPreflightInFlightRef,
      sendInFlightRef,
      turnDispatchSettings,
      computerControlChangeSequence,
      showPlanFollowUpPrompt,
      activeProposedPlan,
      hasQueueableLiveTurn,
      clearComposerInput,
      scheduleComposerFocus,
      activeProject,
      threadWorkspaceCwd,
      refreshProviderStatuses,
      isServerThread,
      hasNativeUserMessages,
      chatWorkspaceRoot,
      isHomeChatContainer,
      isGroupContainer,
      resolvedThreadWorktreePath,
      resolvedThreadWorkingDirectory,
      currentActiveGitBranch,
      isContainerLandingProject,
      syncServerShellSnapshot,
      activeRootBranch,
      gitBranchSourceCwd,
      setStoreThreadError,
      queryClient,
      isCenteredEmptyLanding,
      setEnvironmentPanelPreferenceOpen,
      environmentPanelPreferenceOpen,
      setTailAnchor,
      setThreadError,
      setComposerHighlightedItemId,
      settings,
      isSendBusy,
      worktreeSetupResolutionRef,
      setWorktreeSetupPendingAction,
      beginLocalDispatch,
      isVoiceTranscribing,
      waitForPendingComposerImages,
      activePendingProgress,
      activePendingUserInputKey,
      pendingUserInputAnswersByRequestIdRef,
      setPendingUserInputAnswersByRequestId,
      composerEditorRef,
      promptRef,
      composerImages,
      composerFiles,
      composerAssistantSelections,
      composerBrowserAnnotations,
      composerFileComments,
      composerTerminalContexts,
      composerPastedTexts,
      composerPullRequestContexts,
      restoredQueuedSourceProposedPlanRef,
      enqueueQueuedComposerTurn,
      setComposerDraftPrompt,
      setComposerTrigger,
      clearProjectDraftThreadId,
      setDraftThreadContext,
      promptHistoryNavigationRef,
      applyingPromptHistoryNavigationRef,
      expectedPromptHistoryPromptRef,
      clearComposerDraftContent,
      setComposerDraftInteractionMode,
      setComposerCursor,
      selectedComposerSkillsRef,
      selectedComposerMentionsRef,
      selectedProvider,
      selectedModel,
      selectedPromptEffort,
      pendingAutomationConversationRef,
      setPendingAutomationConversation,
      pendingAutomationConversation,
      activeThreadIdRef,
      hasLiveTurnRef,
      automationProjects,
      setAutomationDraftWarningContext,
      setAutomationDraftForm,
      setAutomationDraftWarnings,
      setAcknowledgedAutomationWarnings,
      setAutomationDraftOpen,
      armTranscriptAutoFollow,
      tailAnchorScrollInFlightRef,
      prepareAutomationFormForCreate,
      createAutomationFromForm,
      providerStatuses,
      isPreparingWorktree,
      serverSettings,
      mossQuotaAccountIdentity,
      mossQuotaAccountIdentityRef,
      mossQuotaAccountTransitionPendingRef,
      locale,
      t,
      setOptimisticUserMessages,
      executePreparedTurn,
      canSendWithProviderHandoff,
    ],
  );
  const unsentMessageRestorers = useMemo(
    () => ({
      activeThreadIdRef,
      setOptimisticUserMessages,
      promptRef,
      setPrompt,
      setRestoredQueuedSourceProposedPlan,
      setComposerCursor,
      addComposerImagesToDraft,
      addComposerFilesToDraft,
      addComposerAssistantSelectionToDraft,
      addComposerDraftBrowserAnnotations,
      addComposerFileCommentToDraft,
      addComposerTerminalContextsToDraft,
      addComposerPastedTextsToDraft,
      addComposerPullRequestContextsToDraft,
      updateSelectedComposerSkills,
      updateSelectedComposerMentions,
      setComposerTrigger,
    }),
    [
      activeThreadIdRef,
      setOptimisticUserMessages,
      promptRef,
      setPrompt,
      setRestoredQueuedSourceProposedPlan,
      setComposerCursor,
      addComposerImagesToDraft,
      addComposerFilesToDraft,
      addComposerAssistantSelectionToDraft,
      addComposerDraftBrowserAnnotations,
      addComposerFileCommentToDraft,
      addComposerTerminalContextsToDraft,
      addComposerPastedTextsToDraft,
      addComposerPullRequestContextsToDraft,
      updateSelectedComposerSkills,
      updateSelectedComposerMentions,
      setComposerTrigger,
    ],
  );
  const devsSendRef = useRef<{
    text: string;
    id: string;
    threadId: ThreadId;
    attachmentKey?: string;
  } | null>(null);
  const onSend = useCallback(
    async (
      e?: { preventDefault: () => void },
      requestedDispatchMode?: "queue" | "steer",
      queuedTurn?: QueuedComposerChatTurn,
    ): Promise<boolean> => {
      e?.preventDefault();
      if (!queuedTurn) beginComposerSendTiming();
      const liveGatePrompt =
        queuedTurn?.prompt ?? composerEditorRef.current?.readSnapshot()?.value ?? promptRef.current;
      if (!queuedTurn && MOSS_DEVS_REPORTS_ENABLED) {
        const handled = await handleDevsReportSend({
          text: liveGatePrompt,
          threadId,
          locale,
          api: readNativeApi(),
          requestRef: devsSendRef,
          images: composerImagesRef.current,
          files: composerFilesRef.current,
          clear: (sentAttachmentIds) => {
            if (
              (composerEditorRef.current?.readSnapshot()?.value ?? promptRef.current) ===
              liveGatePrompt
            ) {
              promptRef.current = "";
              setComposerDraftPrompt(threadId, "");
              setPrompt("");
              setComposerTrigger(null);
            }
            // What went with the report leaves the composer; anything it could not carry stays.
            const draftStore = useComposerDraftStore.getState();
            for (const id of sentAttachmentIds) {
              if (composerImagesRef.current.some((image) => image.id === id))
                draftStore.removeImage(threadId, id);
              else draftStore.removeFile(threadId, id);
            }
          },
        });
        if (handled !== null) return handled;
      }
      const gateContentKey =
        queuedTurn?.id ??
        [
          liveGatePrompt,
          composerImagesRef.current.map((attachment) => attachment.id).join(","),
          composerFilesRef.current.map((attachment) => attachment.id).join(","),
          selectedComposerSkillsRef.current.map((skill) => skill.name).join(","),
          selectedComposerMentionsRef.current.map((mention) => mention.name).join(","),
        ].join("\u0000");
      const gate = composerSendGateRef.current;
      if (gate?.threadId === threadId && gate.key === gateContentKey) {
        return false;
      }
      composerSendGateRef.current = { threadId, key: gateContentKey };
      const echo: ComposerSendEcho = { current: null };
      // A message shown right after Enter whose checks then stopped the send goes back
      // into the composer (unless the person already started a new draft there).
      const handBackEchoedMessage = () => {
        const unsent = echo.current;
        if (unsent === null) return;
        echo.current = null;
        echoesInFlightRef.current = Math.max(0, echoesInFlightRef.current - 1);
        if (isComposerDraftEmpty(unsent.threadId)) {
          restoreUnsentComposerMessage(unsent, unsentMessageRestorers);
          return;
        }
        if (activeThreadIdRef.current === unsent.threadId) {
          setOptimisticUserMessages((existing) =>
            existing.filter((row) => row.id !== unsent.messageId),
          );
        }
      };
      return performComposerSend(requestedDispatchMode, queuedTurn, echo)
        .then(
          (sent) => {
            handBackEchoedMessage();
            return sent;
          },
          (error: unknown) => {
            handBackEchoedMessage();
            throw error;
          },
        )
        .finally(() => {
          if (
            composerSendGateRef.current?.threadId === threadId &&
            composerSendGateRef.current.key === gateContentKey
          ) {
            composerSendGateRef.current = null;
          }
        });
    },
    [
      threadId,
      performComposerSend,
      setComposerDraftPrompt,
      setPrompt,
      setComposerTrigger,
      locale,
      composerEditorRef,
      promptRef,
      composerImagesRef,
      composerFilesRef,
      selectedComposerSkillsRef,
      selectedComposerMentionsRef,
      activeThreadIdRef,
      setOptimisticUserMessages,
      unsentMessageRestorers,
    ],
  );

  return { onSend };
}
