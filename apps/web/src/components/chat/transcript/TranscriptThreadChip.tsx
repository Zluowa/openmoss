// FILE: TranscriptThreadChip.tsx
// Purpose: A Moss thread named inside the transcript, drawn like the desktop chat's
//          session chip: an accent-tinted pill with a status glyph and the thread's
//          live title (a renamed thread renames every chip), a hover card with the
//          title and state, and a muted, inert pill when the thread is unknown.
// Layer: Chat transcript primitive
// Exports: TranscriptThreadChip, useTranscriptThreadLabel

import type { ThreadId } from "@moss/contracts";
import type { MouseEvent, ReactNode } from "react";

import { ChatBubbleIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import { useStore } from "~/store";
import type { SidebarThreadSummary } from "~/types";

import { isThreadActivelyWorking } from "../../Sidebar.logic";
import { ThreadRunningSpinner } from "../../ThreadRunningSpinner";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "../../ui/preview-card";
import { formatChatRelativeTimeAgo } from "../chatFileKind";
import {
  FILE_CHIP_HOVER_CARD_POPUP_CLASS_NAME,
  FILE_CHIP_HOVER_CARD_SIDE_OFFSET_PX,
} from "../FileChipHoverCard";

const CHIP_BASE_CLASS_NAME =
  "inline-flex max-w-full items-center gap-0.75 rounded-inline px-1.5 align-baseline leading-tight no-underline";
const CHIP_LIVE_CLASS_NAME = cn(
  CHIP_BASE_CLASS_NAME,
  "cursor-interaction bg-[color-mix(in_srgb,var(--color-text-accent)_10%,transparent)] text-[var(--color-text-accent)]",
  "hover:bg-[color-mix(in_srgb,var(--color-text-accent)_18%,transparent)]",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
);
const CHIP_MUTED_CLASS_NAME = cn(CHIP_BASE_CLASS_NAME, "bg-muted/60 text-muted-foreground");

function useThreadSummary(threadId: ThreadId | null): SidebarThreadSummary | undefined {
  return useStore((state) => (threadId ? state.sidebarThreadSummaryById[threadId] : undefined));
}

/** The live title of a thread, or null while the thread is unknown here. */
export function useTranscriptThreadLabel(threadId: ThreadId | null): string | null {
  const summary = useThreadSummary(threadId);
  const title = summary?.title.trim();
  return title ? title : null;
}

function ThreadChipHoverCard(props: { summary: SidebarThreadSummary; working: boolean }) {
  const { t, locale } = useTranslation();
  const { summary, working } = props;
  const stamp = summary.updatedAt ?? summary.createdAt;
  return (
    <div className="flex w-54 min-w-0 flex-col gap-1" data-thread-chip-hover-card="">
      <div className="flex min-w-0 items-center gap-1.5 text-ui-sm text-muted-foreground">
        <span className="flex size-4 shrink-0 items-center justify-center">
          {working ? <ThreadRunningSpinner className="size-3.5" /> : <ChatBubbleIcon />}
        </span>
        <span className="min-w-0 flex-1 truncate">
          {working ? t("transcript.threadChip.working") : t("transcript.threadChip.thread")}
        </span>
        <span className="shrink-0 tabular-nums">{formatChatRelativeTimeAgo(stamp, locale)}</span>
      </div>
      <span className="line-clamp-2 break-words text-ui text-foreground">{summary.title}</span>
    </div>
  );
}

/**
 * The sender named in a disclosure line ("Received message from <title>"): the live
 * title as an underlined text link in the primary tone, as the desktop chat draws it.
 */
export function TranscriptThreadLink(props: {
  threadId: ThreadId;
  fallbackLabel: string;
  onOpenThread?: ((threadId: ThreadId) => void) | undefined;
}) {
  const title = useTranscriptThreadLabel(props.threadId);
  if (title === null || !props.onOpenThread) {
    return (
      <span data-thread-link={title === null ? "unknown" : "static"}>
        {title ?? props.fallbackLabel}
      </span>
    );
  }
  const open = props.onOpenThread;
  return (
    <button
      type="button"
      data-thread-link="live"
      data-thread-id={props.threadId}
      onClick={(event) => {
        event.stopPropagation();
        open(props.threadId);
      }}
      className="max-w-full cursor-interaction truncate p-0 text-foreground underline decoration-foreground/40 underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <bdi>{title}</bdi>
    </button>
  );
}

export function TranscriptThreadChip(props: {
  threadId: ThreadId | null;
  /** Shown while the thread is unknown here (link text, or a generic noun). */
  fallbackLabel: ReactNode;
  onOpenThread?: ((threadId: ThreadId) => void) | undefined;
}) {
  const { t } = useTranslation();
  const summary = useThreadSummary(props.threadId);
  const title = summary?.title.trim();
  if (!summary || !title || !props.threadId) {
    return (
      <span className={CHIP_MUTED_CLASS_NAME} data-thread-chip="unknown">
        <span className="min-w-0 truncate">{props.fallbackLabel}</span>
      </span>
    );
  }
  const working = isThreadActivelyWorking(summary);
  const threadId = props.threadId;
  const open = props.onOpenThread;
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    open?.(threadId);
  };
  const statusText = working ? t("transcript.threadChip.working") : null;
  return (
    <PreviewCard>
      <PreviewCardTrigger
        render={
          <button
            type="button"
            className={CHIP_LIVE_CLASS_NAME}
            data-thread-chip="live"
            data-thread-id={threadId}
            onClick={handleClick}
            disabled={!open}
          />
        }
      >
        {/* An idle chip is words only (desktop chat); a working thread shows its spinner. */}
        {working ? <ThreadRunningSpinner className="size-3 text-current" /> : null}
        <span className="min-w-0 truncate">{title}</span>
        {statusText ? <span className="sr-only">{` — ${statusText}`}</span> : null}
      </PreviewCardTrigger>
      <PreviewCardPopup
        side="bottom"
        align="start"
        sideOffset={FILE_CHIP_HOVER_CARD_SIDE_OFFSET_PX}
        className={FILE_CHIP_HOVER_CARD_POPUP_CLASS_NAME}
      >
        <ThreadChipHoverCard summary={summary} working={working} />
      </PreviewCardPopup>
    </PreviewCard>
  );
}
