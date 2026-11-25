// FILE: KanbanCardView.tsx
// Purpose: Presentational kanban card — title, draft preview, provider/branch/env/PR
//          meta row with the relative timestamp and the card's one status.
// Layer: UI component (pure; drag wiring lives in KanbanColumn)
// Exports: KanbanCardView

import type { ReactNode } from "react";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { HitArea } from "~/components/ui/hit-area";
import type { ThreadId } from "@moss/contracts";

import {
  resolveThreadPullRequestFallback,
  type ThreadPullRequest,
} from "~/hooks/useThreadPullRequests";
import { PrStateChip } from "../pullRequest/PrStateChip";
import { resolveThreadStatusPill, type ThreadStatusPill } from "../Sidebar.logic";
import { ProviderIcon } from "../ProviderIcon";
import { TASK_META_TONE_CLASS } from "../tasks/TaskCardPrimitives";
import { TaskStatusGlyph } from "../tasks/TaskGlyphs";
import type { TaskMetaTone, TaskStatusKind } from "../tasks/tasks.logic";
import {
  GitBranchIcon,
  PaperclipIcon,
  PinFilledIcon,
  TerminalIcon,
  WorktreeIcon,
} from "~/lib/icons";
import { resolveThreadEnvironmentPresentation } from "~/lib/threadEnvironment";
import { formatElapsedSpan } from "~/lib/relativeTime";
import { formatTimeAgo } from "~/lib/timeFormat";
import { useTranslation } from "~/localization";
import { cn } from "~/lib/utils";
import { ELEVATED_HOVER_SURFACE_CLASS_NAME } from "../../surfaceStyles";
import {
  KANBAN_ATTENTION_LABELS,
  KANBAN_COLUMN_V2_LABELS,
  type KanbanAttentionFlag,
} from "@moss/shared/kanban";
import {
  kanbanThreadCardId,
  refineAttentionFlagsForLivePr,
  type KanbanCard,
  type KanbanColumnKey,
} from "./kanban.logic";

/** Resolved PR badge per thread from the board root's useThreadPullRequests call. */
export type KanbanCardPrLookup = ReadonlyMap<ThreadId, ThreadPullRequest>;

export interface KanbanCardViewProps {
  card: KanbanCard;
  onOpen?: (card: KanbanCard) => void;
  /** Right-click handler — opens the sidebar-style thread/draft context menu. */
  onContextMenu?: (card: KanbanCard, event: React.MouseEvent) => void;
  /** Keyboard handler — the board uses it for Alt+Arrow draft reorder. */
  onKeyDown?: (card: KanbanCard, event: React.KeyboardEvent) => void;
  prByThreadId: KanbanCardPrLookup;
  /** Rendered inside the DragOverlay — lifted styling, no interactions. */
  isOverlay?: boolean;
  /** The in-column original while its overlay clone is being dragged. */
  isDragSource?: boolean;
  /** Shared wall-clock tick from the board root for live elapsed labels. */
  nowMs?: number;
}

// The Tasks list's status for what a card's flag, thread or column says.
const FLAG_STATUS: Record<KanbanAttentionFlag, TaskStatusKind> = {
  failed: "stopped",
  stuck: "stopped",
  "awaiting-approval": "needs",
  "awaiting-input": "needs",
  "needs-review": "review",
};

// Thread statuses that only restate the column: "Working"/"Connecting" are In Progress,
// "Completed" is Done.
const REDUNDANT_COLUMN_PILL_LABELS = new Set<ThreadStatusPill["label"]>([
  "Working",
  "Connecting",
  "Completed",
]);

const PILL_STATUS: Partial<Record<ThreadStatusPill["label"], TaskStatusKind>> = {
  "Pending Approval": "needs",
  "Awaiting Input": "needs",
  Reminder: "needs",
  "Plan Ready": "review",
  "In Background": "running",
  "Preparing worktree": "starting",
};

const COLUMN_STATUS: Record<KanbanColumnKey, TaskStatusKind> = {
  draft: "todo",
  inProgress: "running",
  awaitingYou: "needs",
  done: "done",
};

// The word's tone, as the Tasks list tints the same status.
const STATUS_TONE: Partial<Record<TaskStatusKind, TaskMetaTone>> = {
  needs: "attention",
  review: "review",
  stopped: "failure",
};

export const KANBAN_STATUS_TONE = STATUS_TONE;

/**
 * The card's one status (WALK-12 N12-6: a waiting card showed its thread pill, an attention
 * badge and its column, all saying the same thing). What the card needs from the person
 * comes first (failed, awaiting approval…), then what its thread is doing when the column
 * does not already say it, then the column itself. Terminal-first threads read "Terminal":
 * an idle terminal is not a draft.
 */
export function resolveKanbanCardStatus(
  card: KanbanCard,
  pr?: ReturnType<typeof resolveThreadPullRequestFallback> | null,
): { label: string; kind: TaskStatusKind } {
  // An explicit `null` PR means live resolution settled with no open PR (drop
  // needs-review); `undefined` means the row has not resolved yet (keep the seeded flag).
  const flag = refineAttentionFlagsForLivePr(card.attention, pr === null ? null : pr?.state)[0];
  if (flag) {
    return { label: KANBAN_ATTENTION_LABELS[flag], kind: FLAG_STATUS[flag] };
  }
  const pill = card.thread
    ? resolveThreadStatusPill({
        thread: card.thread,
        hasPendingApprovals: card.thread.hasPendingApprovals,
        hasPendingUserInput: card.thread.hasPendingUserInput,
      })
    : null;
  if (pill && !REDUNDANT_COLUMN_PILL_LABELS.has(pill.label)) {
    return { label: pill.label, kind: PILL_STATUS[pill.label] ?? COLUMN_STATUS[card.column] };
  }
  return {
    label: card.isTerminal ? "Terminal" : KANBAN_COLUMN_V2_LABELS[card.column],
    kind: COLUMN_STATUS[card.column],
  };
}

/** The card's one status: the Tasks list's glyph and word, in the list's tones. */
function KanbanCardStatus({
  card,
  pr,
}: {
  card: KanbanCard;
  pr: ReturnType<typeof resolveThreadPullRequestFallback> | null;
}) {
  const status = resolveKanbanCardStatus(card, pr);
  return (
    <span
      data-kanban-card-status=""
      className={cn(
        "flex shrink-0 items-center gap-1 text-ui-xs",
        TASK_META_TONE_CLASS[STATUS_TONE[status.kind] ?? "muted"],
      )}
    >
      {card.isTerminal ? (
        <TerminalIcon className="size-3 shrink-0" aria-hidden />
      ) : (
        <TaskStatusGlyph kind={status.kind} className="size-3" />
      )}
      {status.label}
    </span>
  );
}

function KanbanCardViewComponent({
  card,
  onOpen,
  onContextMenu,
  onKeyDown,
  prByThreadId,
  isOverlay: isOverlayProp,
  isDragSource: isDragSourceProp,
  nowMs,
}: KanbanCardViewProps) {
  const isOverlay = isOverlayProp ?? false;
  const isDragSource = isDragSourceProp ?? false;
  // Thread-backed draft cards keep their own title, so the unsent prompt is shown
  // separately; local drafts and unsent-prompt cards already title themselves from it.
  const showDraftPreview =
    card.column === "draft" &&
    card.draftPrompt.length > 0 &&
    card.cardId === kanbanThreadCardId(card.threadId);

  const isForked = Boolean(card.thread?.forkSourceThreadId);
  const worktreeBadgeLabel = resolveThreadEnvironmentPresentation({
    envMode: card.envMode,
    worktreePath: card.worktreePath,
  }).worktreeBadgeLabel;
  // An explicit null from the resolver means the persisted PR was ruled out (e.g. the
  // checkout moved on); rows the board root has not resolved yet get the same validation
  // without live status instead of the raw — possibly stale — persisted badge.
  const pr = card.thread
    ? prByThreadId.has(card.threadId)
      ? (prByThreadId.get(card.threadId) ?? null)
      : resolveThreadPullRequestFallback({
          branch: card.thread.branch,
          hasDedicatedWorktree: card.thread.worktreePath !== null,
          lastKnownPr: card.thread.lastKnownPr ?? null,
          pullRequests: card.thread.pullRequests,
        })
    : null;
  // One relative-time format for the whole Tasks page, in the app's language: the board used
  // to print English "4h" (only an exact "5h" happened to be translated) and a clock-style
  // elapsed time next to the list's "4 小时".
  const { locale } = useTranslation();
  const activeWorkElapsed =
    card.activeWorkStartedAt && nowMs
      ? formatElapsedSpan(card.activeWorkStartedAt, locale, nowMs)
      : null;

  return (
    <HitArea
      tabIndex={isOverlay ? -1 : 0}
      onClick={onOpen ? () => onOpen(card) : undefined}
      onContextMenu={onContextMenu ? (event) => onContextMenu(card, event) : undefined}
      onKeyDown={onKeyDown ? (event) => onKeyDown(card, event) : undefined}
      className={cn(
        // Moss destination cards are panels: hairline border on the card fill, no grey wash
        // or glass. Hover tints with ink; a dragged card lifts with the overlay shadow.
        "flex w-full cursor-interaction flex-col gap-ui-gap-xs rounded-card border border-border bg-card p-ui-pad-md text-left",
        ELEVATED_HOVER_SURFACE_CLASS_NAME,
        "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
        isOverlay && "shadow-xl",
        isDragSource && "opacity-40",
      )}
    >
      <span className="flex min-w-0 items-start gap-ui-gap-xs">
        <span className="line-clamp-2 min-w-0 flex-1 text-ui font-medium text-foreground">
          {card.title}
        </span>
        {card.thread?.isPinned ? (
          <span className="flex shrink-0 items-center pt-0.5">
            <CardMark label="Pinned">
              <PinFilledIcon className="size-3 text-muted-foreground/60" aria-hidden />
            </CardMark>
          </span>
        ) : null}
      </span>
      {showDraftPreview ? (
        <span className="line-clamp-2 text-ui-sm text-muted-foreground">{card.draftPrompt}</span>
      ) : null}
      <span className="flex min-w-0 items-center gap-ui-gap-xs">
        {card.isTerminal ? null : (
          <ProviderIcon
            provider={card.provider}
            className="size-4 shrink-0 opacity-80"
            fallback={
              <span className="size-3.5 shrink-0 rounded-full border border-dashed border-muted-foreground/40" />
            }
          />
        )}
        {card.branch ? (
          <span className="flex min-w-0 items-center gap-1 text-ui-xs text-muted-foreground">
            <GitBranchIcon className="size-3 shrink-0" aria-hidden />
            <span className="max-w-32 truncate">{card.branch}</span>
          </span>
        ) : null}
        {worktreeBadgeLabel ? (
          <CardMark label={worktreeBadgeLabel}>
            <WorktreeIcon className="size-3 text-muted-foreground/70" aria-hidden />
          </CardMark>
        ) : null}
        {isForked ? (
          <CardMark label="Forked thread">
            <GitBranchIcon className="size-3 text-success" aria-hidden />
          </CardMark>
        ) : null}
        {pr ? <PrStateChip pr={pr} /> : null}
        {card.draftHasAttachments ? (
          <PaperclipIcon className="size-3 shrink-0 text-muted-foreground/70" aria-hidden />
        ) : null}
        <span className="ml-auto flex min-w-0 shrink-0 items-center gap-ui-gap-xs">
          {activeWorkElapsed ? (
            <span className="shrink-0 text-ui-xs text-muted-foreground">
              Worked for {activeWorkElapsed}
            </span>
          ) : card.timestamp && !card.isOptimisticDispatch ? (
            <span className="shrink-0 text-ui-xs text-muted-foreground">
              {formatTimeAgo(card.timestamp, { locale, now: nowMs })}
            </span>
          ) : null}
          {card.isOptimisticDispatch ? (
            // Optimistically In Progress: the thread's real status (Draft/Completed) would
            // contradict the column until the first runtime signal arrives.
            <span className="flex shrink-0 items-center gap-1 text-ui-xs text-info-foreground">
              <Spinner className="size-3 shrink-0" aria-hidden />
              Starting…
            </span>
          ) : (
            <KanbanCardStatus card={card} pr={pr} />
          )}
        </span>
      </span>
    </HitArea>
  );
}

export const KanbanCardView = KanbanCardViewComponent;

/** An icon that only marks something on the card: named by the Moss tooltip, not a native one. */
function CardMark({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span role="img" aria-label={label} className="flex shrink-0 items-center" />}
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
