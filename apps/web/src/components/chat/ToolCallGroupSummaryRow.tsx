// FILE: ToolCallGroupSummaryRow.tsx
// Purpose: One-line disclosure for a run of tool calls. Settled runs read as a
//          verb summary ("Read 2 files, ran 3 commands, 1 failed"); a live run
//          wears its latest status or call instead. Both expand to the rows.
// Layer: Web chat presentation component
// Exports: ToolCallGroupSummaryRow
// Depends on: DisclosureRegion/DisclosureChevron (shared disclosure motion)

import { useEffect, useMemo, useState, type ReactNode } from "react";

import { useTranslation } from "../../localization";

import { DisclosureRegion } from "../ui/DisclosureRegion";
import {
  DISCLOSURE_CLEANUP_BUFFER_MS,
  DISCLOSURE_TRANSITION_MS,
  disclosureChevronClassName,
} from "~/lib/disclosureMotion";
import {
  BotIcon,
  CaretRightFillIcon,
  FileIcon,
  GlobeIcon,
  type LucideIcon,
  McpIcon,
  MessageCircleIcon,
  PencilIcon,
  SearchIcon,
  TerminalIcon,
  WorkingIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { MUTED_LABEL_TEXT_CLASS_NAME } from "~/surfaceStyles";
import { extractWebFetchUrl } from "../../lib/toolCallLabel";
import { fileDiffStatsByPath } from "../../lib/diffRendering";
import { isFileChangeWorkLogEntry } from "../../session-logic";
import { LinkChipIcon } from "../LinkChipIcon";
import { McpServerIcon } from "./McpServerIcon";
import type { WorkLogEntry } from "../../session-logic";
import {
  formatToolCallGroupSummary,
  multiFileEditLabel,
  type ToolCallGroupSummary,
} from "./toolCallGroup.logic";
import {
  renderWorkEntryIcon,
  renderWorkEntrySentence,
  workEntryDisplayParts,
  workEntryLeftIcon,
} from "./TimelineWorkEntryRow";

// One glyph per kind, matching the expanded rows; a mixed group wears the
// working hammer. Tool calls and uncategorized calls keep their first entry's
// own mark (MCP server, Moss, browser).
function summaryIcon(summary: ToolCallGroupSummary): LucideIcon {
  switch (summary.iconCategory) {
    case "read":
      return FileIcon;
    case "search":
      return SearchIcon;
    case "command":
      return TerminalIcon;
    case "edit":
      return PencilIcon;
    case "agent":
      return BotIcon;
    case "message":
      return MessageCircleIcon;
    case "fetch":
      return GlobeIcon;
    case "mixed":
      return WorkingIcon;
    case "tool":
    case "other":
      return workEntryLeftIcon(summary.iconEntry);
  }
}

/** Lines added and removed across the run's own file patches. */
export function toolGroupDiffStat(entries: ReadonlyArray<WorkLogEntry>): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const entry of entries) {
    if (!isFileChangeWorkLogEntry(entry)) continue;
    for (const stat of fileDiffStatsByPath(entry.toolDetails?.diff).values()) {
      additions += stat.additions;
      deletions += stat.deletions;
    }
  }
  return { additions, deletions };
}

// A group the tool summary does not describe (e.g. background tasks) passes
// its own line and glyph instead.
type GroupLine =
  | { summary: ToolCallGroupSummary; label?: never; icon?: never }
  | { summary?: never; label: ReactNode; icon: LucideIcon };

export function ToolCallGroupSummaryRow(
  props: GroupLine & {
    // Selected status or call of a live run, shown instead of the summary.
    liveEntry?: WorkLogEntry | null;
    open: boolean;
    onToggle: (open: boolean) => void;
    fontSizePx: number;
    renderChildren: () => ReactNode;
    /** The run's calls, for the "+16" its file changes add up to. */
    diffEntries?: ReadonlyArray<WorkLogEntry> | undefined;
    /** Opens the turn's changes; shows "· View changes" when the run changed files. */
    onViewChanges?: (() => void) | undefined;
  },
) {
  const { liveEntry, open, onToggle, fontSizePx, renderChildren, diffEntries, onViewChanges } =
    props;
  const { format, locale, t } = useTranslation();
  const diffStat = useMemo(
    () => (diffEntries && !liveEntry ? toolGroupDiffStat(diffEntries) : null),
    [diffEntries, liveEntry],
  );
  const hasDiff = diffStat !== null && diffStat.additions + diffStat.deletions > 0;
  const showViewChanges = hasDiff && onViewChanges !== undefined;
  const [keepChildrenMounted, setKeepChildrenMounted] = useState(open);

  useEffect(() => {
    if (open) {
      setKeepChildrenMounted(true);
      return;
    }
    if (!keepChildrenMounted) return;
    const cleanup = window.setTimeout(
      () => setKeepChildrenMounted(false),
      DISCLOSURE_TRANSITION_MS + DISCLOSURE_CLEANUP_BUFFER_MS,
    );
    return () => window.clearTimeout(cleanup);
  }, [keepChildrenMounted, open]);

  const shouldRenderChildren = open || keepChildrenMounted;

  // A live line wears its call's own icon; a settled group its kind's glyph.
  // A fetched site keeps its favicon.
  const summary = props.summary ?? null;
  const iconEntry = liveEntry ?? summary?.iconEntry ?? null;
  const iconWebFetchUrl = iconEntry ? extractWebFetchUrl(iconEntry) : null;
  const showFavicon =
    iconWebFetchUrl !== null && (liveEntry != null || summary?.iconCategory === "fetch");
  const Icon = liveEntry
    ? workEntryLeftIcon(liveEntry)
    : summary
      ? summaryIcon(summary)
      : props.icon!;
  const liveMultiFileLabel = liveEntry ? multiFileEditLabel(liveEntry) : null;

  const caret = (
    /* Solid caret, always shown, a quarter turn when open (desktop chat). */
    <CaretRightFillIcon
      aria-hidden
      data-tool-group-caret=""
      className={disclosureChevronClassName(open)}
    />
  );
  return (
    <div data-tool-group-disclosure="true" data-tool-group-phase={open ? "expanded" : "collapsed"}>
      <div
        className={cn("inline-flex max-w-full items-center gap-1", MUTED_LABEL_TEXT_CLASS_NAME)}
        style={{ fontSize: `${fontSizePx}px` }}
      >
        <button
          type="button"
          aria-expanded={open}
          className="inline-flex min-h-6 min-w-0 max-w-full items-center gap-1 py-0.5 text-left transition-colors duration-200 hover:text-foreground"
          onClick={() => onToggle(!open)}
        >
          {/* The desktop chat's tool line carries no glyph: the words lead. A live
            line keeps its call's mark so the running action stays recognizable. */}
          {liveEntry ? (
            <span
              className="flex size-4 shrink-0 items-center justify-center"
              aria-hidden
              data-tool-group-icon={undefined}
            >
              {showFavicon && iconWebFetchUrl ? (
                <LinkChipIcon url={iconWebFetchUrl} className="size-4" />
              ) : Icon === McpIcon && iconEntry?.mcpServer ? (
                <McpServerIcon serverName={iconEntry.mcpServer} className="size-4" />
              ) : (
                renderWorkEntryIcon(Icon, "size-4")
              )}
            </span>
          ) : null}
          <span className="min-w-0 truncate" data-tool-group-live={liveEntry ? "true" : undefined}>
            {liveEntry ? (
              (liveMultiFileLabel ??
              renderWorkEntrySentence(workEntryDisplayParts(liveEntry, locale)))
            ) : !summary ? (
              props.label
            ) : (
              <>
                {locale === "zh-CN" ? formatToolCallGroupSummary(summary, format) : summary.label}
                {/* The desktop chat ends a settled line with ", 1 failed" in the line's own
                  muted tone. */}
                {summary.failedLabel
                  ? locale === "zh-CN"
                    ? `，${format("chat.toolGroup.failed", { count: summary.failedCount })}`
                    : `, ${summary.failedLabel}`
                  : null}
              </>
            )}
          </span>
          {hasDiff ? (
            // Only the nonzero side shows, "+16" or "+1 −1", in the diff colors.
            <span className="shrink-0 whitespace-nowrap tabular-nums" data-tool-group-diff="">
              {diffStat.additions > 0 ? (
                <span className="text-[var(--color-decoration-added)]">+{diffStat.additions}</span>
              ) : null}
              {diffStat.additions > 0 && diffStat.deletions > 0 ? " " : null}
              {diffStat.deletions > 0 ? (
                <span className="text-[var(--color-decoration-deleted)]">
                  {"\u2212"}
                  {diffStat.deletions}
                </span>
              ) : null}
            </span>
          ) : null}
          {showViewChanges ? null : caret}
        </button>
        {showViewChanges ? (
          <>
            <span aria-hidden className="shrink-0">
              ·
            </span>
            <button
              type="button"
              data-tool-group-view-changes=""
              className="shrink-0 cursor-interaction underline underline-offset-2 transition-colors duration-200 hover:text-foreground"
              onClick={onViewChanges}
            >
              {t("chat.toolGroup.viewChanges")}
            </button>
            <button
              type="button"
              aria-hidden
              tabIndex={-1}
              className="flex shrink-0 cursor-interaction"
              onClick={() => onToggle(!open)}
            >
              {caret}
            </button>
          </>
        ) : null}
      </div>
      <DisclosureRegion open={open}>
        {shouldRenderChildren ? renderChildren() : null}
      </DisclosureRegion>
    </div>
  );
}
