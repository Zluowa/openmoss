// FILE: GuestThread.tsx
// Purpose: The joined guest's page: the owner's transcript pane, read-only, with the guest's
//          own waiting messages and composer floating over it as in the owner's chat.
// Layer: Guest page UI
// Why: The thread comes out of the app store the way the owner's ChatView reads it, and goes
//      through the same derive functions, so a guest sees exactly the owner's timeline. Every
//      affordance that would reach the owner's machine (revert, edit, diffs, pins, forks,
//      approvals) is left out by passing no handler.

import { PROVIDER_DISPLAY_NAMES, type MessageId } from "@synara/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { useAppSettings } from "~/appSettings";
import { resolveWorkingLabel } from "~/components/ChatView.logic";
import { ChatTranscriptPane } from "~/components/chat/ChatTranscriptPane";
import { ExpandedImageOverlay } from "~/components/chat/ExpandedImageOverlay";
import { deriveAgentActivityTimelineState } from "~/components/chat/agentActivity.logic";
import {
  buildTurnDiffSummaryByAssistantMessageId,
  deriveTurnTimingByTurnId,
} from "~/components/chat/MessagesTimeline.logic";
import {
  composerTranscriptBottomInsetPx,
  useComposerOverlayHeight,
} from "~/components/chat/composerOverlay";
import {
  CHAT_BACKGROUND_CLASS_NAME,
  CHAT_COLUMN_GUTTER_CLASS_NAME,
  COMPOSER_COLUMN_FRAME_CLASS_NAME,
} from "~/components/chat/composerPickerStyles";
import { useChatTimelineMessages } from "~/components/chat/useChatTimelineMessages";
import { useChatTranscriptScroll } from "~/components/chat/useChatTranscriptScroll";
import { useChatWorkLog } from "~/components/chat/useChatWorkLog";
import { useExpandedImagePreview } from "~/components/chat/useExpandedImagePreview";
import { useTheme } from "~/hooks/useTheme";
import { useTurnDiffSummaries } from "~/hooks/useTurnDiffSummaries";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import {
  deriveActiveWorkStartedAt,
  derivePhase,
  deriveTimelineEntries,
  hasLiveTurnTailWork,
  isLatestTurnSettled,
} from "~/session-logic";
import { useStore } from "~/store";
import { getThreadFromState } from "~/threadDerivation";
import type { Thread } from "~/types";

import type { GuestConnectionStatus } from "../connection";
import { GUEST_END_REASON_KEY, describeGuestFailure } from "../guestCopy";
import { unplacedGuestMessages, type GuestStreamState } from "../guestStream.logic";
import { useGuestStream, useSeenPendingIds, useVisualViewportHeight } from "../hooks";
import type { GuestShareView } from "../protocol";
import type { GuestTransport } from "../transport";
import { GuestComposer, type GuestComposerNotice } from "./GuestComposer";
import { GuestConnectionBanner } from "./GuestConnectionBanner";
import { GuestHeader } from "./GuestHeader";
import { GuestNotice, WhatIsMossLink } from "./GuestNotice";
import { GuestOwnMessages } from "./GuestOwnMessages";

const NO_REVERTS = new Map<MessageId, number>();
const ignore = () => {};

export function GuestThread({
  shareId,
  transport,
}: {
  readonly shareId: string;
  readonly transport: GuestTransport;
}) {
  const { t } = useTranslation();
  const { state, status, retryNow } = useGuestStream(transport);
  const threadId = state.threadId;
  const thread = useStore(
    useCallback(
      (store) => (threadId === null ? undefined : getThreadFromState(store, threadId)),
      [threadId],
    ),
  );
  const view = state.view;

  if (thread === undefined || view === null) {
    if (status.kind === "ended") {
      return (
        <GuestNotice
          title={t("guest.ended.title")}
          detail={t(GUEST_END_REASON_KEY[status.reason])}
        />
      );
    }
    if (status.kind === "lost") {
      return (
        <GuestNotice
          title={t("guest.link.invalidTitle")}
          detail={describeGuestFailure(status.failure, t)}
        />
      );
    }
    if (status.kind === "offline") {
      return (
        <GuestNotice title={t("guest.ownerOffline")} busy>
          {status.attempt > 1 ? (
            <button
              type="button"
              className="text-ui-sm font-medium underline underline-offset-2"
              onClick={retryNow}
            >
              {t("guest.retryNow")}
            </button>
          ) : null}
        </GuestNotice>
      );
    }
    return <GuestNotice title={t("guest.connecting")} busy />;
  }

  return (
    <GuestTranscript
      shareId={shareId}
      transport={transport}
      thread={thread}
      view={view}
      stream={state}
      status={status}
      onRetry={retryNow}
    />
  );
}

/** Everything the owner's ChatView derives for the transcript, for one read-only thread. */
function GuestTranscript({
  shareId,
  transport,
  thread,
  view,
  stream,
  status,
  onRetry,
}: {
  readonly shareId: string;
  readonly transport: GuestTransport;
  readonly thread: Thread;
  readonly view: GuestShareView;
  readonly stream: GuestStreamState;
  readonly status: GuestConnectionStatus;
  readonly onRetry: () => void;
}) {
  const { t } = useTranslation();
  const { settings } = useAppSettings();
  const { resolvedTheme } = useTheme();
  const legendListRef = useRef<LegendListRef | null>(null);
  const frameHeightPx = useVisualViewportHeight();

  useEffect(() => {
    document.title = `${thread.title !== "" ? thread.title : t("guest.page.untitled")} · Moss`;
  }, [thread.title, t]);

  // The same turn bookkeeping ChatView keeps, minus the owner's local sends.
  const phase = derivePhase(thread.session);
  const latestTurn = thread.latestTurn;
  const hasLiveTurnTail = hasLiveTurnTailWork({
    latestTurn,
    messages: thread.messages,
    activities: thread.activities,
    session: thread.session,
  });
  const latestTurnSettled = isLatestTurnSettled(latestTurn, thread.session) && !hasLiveTurnTail;
  const hasLiveTurn = phase === "running";
  const isConnecting = phase === "connecting";
  const isWorking = hasLiveTurn || isConnecting;
  const activeTurnId = latestTurnSettled
    ? null
    : (thread.session?.activeTurnId ?? latestTurn?.turnId ?? null);
  const activeWorkStartedAt = hasLiveTurnTail
    ? (latestTurn?.startedAt ?? null)
    : hasLiveTurn
      ? deriveActiveWorkStartedAt(latestTurn, thread.session, null)
      : null;
  const providerName = thread.session?.provider ?? view.model.provider;

  const { workLogEntries } = useChatWorkLog({
    activeThread: thread,
    latestTurnSettled,
    latestTurnLive: hasLiveTurn,
  });
  const timelineWorkEntries = useMemo(
    () => deriveAgentActivityTimelineState(workLogEntries).timelineWorkEntries,
    [workLogEntries],
  );
  const { timelineMessages } = useChatTimelineMessages({
    threadId: thread.id,
    activeThread: thread,
    pendingAutomationConversation: null,
  });
  const timelineEntries = useMemo(
    () => deriveTimelineEntries(timelineMessages, thread.proposedPlans, timelineWorkEntries),
    [thread.proposedPlans, timelineMessages, timelineWorkEntries],
  );
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } = useTurnDiffSummaries(thread);
  const turnTimingByTurnId = useMemo(
    () =>
      deriveTurnTimingByTurnId({ turnDiffSummaries, latestTurn, activities: thread.activities }),
    [latestTurn, thread.activities, turnDiffSummaries],
  );
  const turnDiffSummaryByAssistantMessageId = useMemo(
    () =>
      buildTurnDiffSummaryByAssistantMessageId({
        turnDiffSummaries: turnDiffSummaries.map((summary) => ({
          ...summary,
          checkpointTurnCount:
            summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId],
        })),
        messages: timelineMessages.map((message) => ({
          id: message.id,
          role: message.role,
          turnId: message.turnId ?? null,
        })),
      }),
    [inferredCheckpointTurnCountByTurnId, timelineMessages, turnDiffSummaries],
  );
  const hasStreamingAssistantText = thread.messages.some(
    (message) => message.role === "assistant" && message.streaming,
  );

  const { overlayRef, overlayHeightPx, overlayBottomClearancePx } = useComposerOverlayHeight();
  const composerTranscriptInsetPx = composerTranscriptBottomInsetPx(overlayHeightPx);
  const scroll = useChatTranscriptScroll({
    activeThreadId: thread.id,
    legendListRef,
    timelineEntries,
    hasStreamingAssistantText,
    composerTranscriptInsetPx,
    isInactiveSplitPane: false,
  });
  const { expandedImage, setExpandedImage, closeExpandedImage, navigateExpandedImage } =
    useExpandedImagePreview();

  // The guest's own messages above the composer, with receipts for the ones this tab saw wait.
  const seenPendingIds = useSeenPendingIds(shareId, view);
  const ownMessages = useMemo(
    () => unplacedGuestMessages(view.messages, thread.messages, view.guestName, seenPendingIds),
    [seenPendingIds, thread.messages, view.guestName, view.messages],
  );
  const pendingCount = view.messages.filter((message) => message.status === "pending").length;

  const [notice, setNotice] = useState<GuestComposerNotice | null>(null);
  const over = status.kind === "ended" || status.kind === "lost" || stream.ended !== null;
  const onScrollToBottom = scroll.onScrollToBottom;
  const onSubmitted = useCallback(() => onScrollToBottom(), [onScrollToBottom]);

  const frameStyle: CSSProperties | undefined =
    frameHeightPx === null ? undefined : { height: frameHeightPx };

  return (
    <div
      className={cn(
        "flex h-dvh min-h-0 min-w-0 flex-col overflow-hidden text-foreground",
        CHAT_BACKGROUND_CLASS_NAME,
      )}
      style={frameStyle}
      data-guest-thread={shareId}
    >
      <GuestHeader title={thread.title} model={view.model} expiresAt={view.expiresAt} />
      <GuestConnectionBanner status={status} onRetry={onRetry} />
      {stream.truncated ? (
        <p className="shrink-0 pt-2 text-center text-ui-xs text-muted-foreground">
          {t("guest.timeline.truncated")}
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          <ChatTranscriptPane
            activeThreadId={thread.id}
            activeTurnId={activeTurnId}
            hasMessages={timelineEntries.length > 0}
            isWorking={isWorking}
            workingLabel={resolveWorkingLabel({
              isSendBusy: false,
              turnTakenOver: false,
              isConnecting,
              ...(providerName ? { providerName: PROVIDER_DISPLAY_NAMES[providerName] } : {}),
            })}
            worktreeSetup={null}
            activeTurnInProgress={isWorking || !latestTurnSettled}
            collapseFinishedTurns={settings.collapseFinishedTurns}
            activeTurnStartedAt={activeWorkStartedAt}
            listRef={legendListRef}
            timelineEntries={timelineEntries}
            messageChangeSignal={timelineMessages}
            turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
            turnTimingByTurnId={turnTimingByTurnId}
            threadError={thread.error}
            onOpenTurnDiff={ignore}
            onOpenThread={ignore}
            revertTurnCountByUserMessageId={NO_REVERTS}
            onRevertUserMessage={ignore}
            isRevertingCheckpoint={false}
            onExpandTimelineImage={setExpandedImage}
            followLiveOutput={!scroll.isUserScrollDetached}
            animateTailAnchorSlide={!hasStreamingAssistantText}
            onIsAtEndChange={scroll.onIsAtEndChange}
            onNavigate={scroll.onTranscriptNavigate}
            markdownCwd={undefined}
            resolvedTheme={resolvedTheme}
            chatFontSizePx={settings.chatFontSizePx}
            timestampFormat={settings.timestampFormat}
            workspaceRoot={undefined}
            emptyStateProjectName={undefined}
            terminalWorkspaceTerminalTabActive={false}
            onMessagesScroll={scroll.onMessagesScrollBase}
            onMessagesClickCapture={scroll.onMessagesClickCaptureBase}
            onMessagesMouseUp={ignore}
            onMessagesWheel={scroll.onMessagesWheelBase}
            onEmbeddedScrollIntent={scroll.onEmbeddedScrollIntent}
            onMessagesPointerDown={scroll.onMessagesPointerDownBase}
            onMessagesPointerUp={scroll.onMessagesPointerUpBase}
            onMessagesPointerCancel={scroll.onMessagesPointerCancelBase}
            onMessagesTouchStart={scroll.onMessagesTouchStartBase}
            onMessagesTouchMove={scroll.onMessagesTouchMoveBase}
            onMessagesTouchEnd={scroll.onMessagesTouchEndBase}
            scrollButtonVisible={scroll.showScrollToBottom}
            onScrollToBottom={scroll.onScrollToBottom}
            contentInsetBottomPx={composerTranscriptInsetPx}
            contentInsetBottomClearancePx={overlayBottomClearancePx}
          />
        </div>
        {/* Trailing block below the transcript: the composer floats `bottom-full` over it, as
            in ChatView, so rows scroll behind the frosted surface. */}
        <div className="relative z-10 w-full shrink-0">
          <div
            ref={overlayRef}
            className={cn(
              "pointer-events-none absolute inset-x-0 bottom-full w-full overflow-visible",
              CHAT_COLUMN_GUTTER_CLASS_NAME,
            )}
          >
            <div className="pointer-events-auto">
              {over ? (
                <div className={COMPOSER_COLUMN_FRAME_CLASS_NAME}>
                  <GuestOwnMessages messages={ownMessages} onImageExpand={setExpandedImage} />
                </div>
              ) : (
                <GuestComposer
                  transport={transport}
                  model={view.model}
                  pendingCount={pendingCount}
                  panels={
                    <GuestOwnMessages messages={ownMessages} onImageExpand={setExpandedImage} />
                  }
                  onExpandImage={setExpandedImage}
                  onSubmitted={onSubmitted}
                  onNotice={setNotice}
                />
              )}
            </div>
          </div>
          <div
            className={cn(CHAT_COLUMN_GUTTER_CLASS_NAME, "pb-[env(safe-area-inset-bottom,0px)]")}
          >
            <div
              className={cn(
                COMPOSER_COLUMN_FRAME_CLASS_NAME,
                "flex min-h-8 items-center justify-center gap-x-2 px-1 pt-1.5 pb-1 text-center text-ui-xs",
              )}
            >
              {over ? (
                <span className="text-muted-foreground">{t("guest.ended.readOnly")}</span>
              ) : notice?.tone === "error" ? (
                <span role="alert" className="text-destructive">
                  {notice.text}
                </span>
              ) : (
                <>
                  <span className="min-w-0 truncate text-muted-foreground">{notice?.text}</span>
                  <span aria-hidden className="text-muted-foreground/60">
                    ·
                  </span>
                  <WhatIsMossLink className="shrink-0" />
                </>
              )}
            </div>
          </div>
        </div>
      </div>
      <ExpandedImageOverlay
        expandedImage={expandedImage}
        onClose={closeExpandedImage}
        onNavigate={navigateExpandedImage}
      />
    </div>
  );
}
