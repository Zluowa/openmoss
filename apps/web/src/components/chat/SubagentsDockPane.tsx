// FILE: SubagentsDockPane.tsx
// Purpose: Right-dock list of every subagent the host thread spawned (opened from the
//          Environment panel summary). "Active" rows show what each run is doing with a
//          ticking time and stop/background on hover; "Done" rows show when they finished,
//          with totals and the result in the tooltip. From a subagent thread it lists the
//          siblings plus a row back to the parent. Selecting a row opens that thread and
//          keeps this list beside it.
// Layer: Chat right-dock UI
// Exports: SubagentsDockPane, SubagentsList (the presentational list it renders)

import type { ThreadId } from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { useTranslation } from "../../localization";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { IconButton } from "~/components/ui/icon-button";
import { stripDiffSearchParams } from "~/diffRouteSearch";
import { useNowMs } from "~/hooks/useNowMs";
import { BackgroundTrayIcon, BackToParentIcon, StopIcon } from "~/lib/icons";
import { subagentStatusTextToneClassName } from "~/lib/subagentPresentation";
import { cn } from "~/lib/utils";
import { useRightDockStore } from "~/rightDockStore";

import { formatClockDuration } from "../../session-logic";
import { ENVIRONMENT_ROW_ICON_CLASS_NAME, EnvironmentRow } from "./environment/EnvironmentRow";
import {
  environmentSubagentElapsedMs,
  formatEnvironmentSubagentMeta,
  type EnvironmentSubagentRoster,
  type EnvironmentSubagentRosterItem,
} from "./environment/EnvironmentSubagentsSection.logic";
import { PanelStateMessage } from "./PanelStateMessage";
import { SubagentAvatar } from "./SubagentAvatar";
import { useSubagentRunControls } from "./useSubagentRunControls";
import { type SubagentParentRow, useThreadSubagentRoster } from "./useSubagentStripSource";

// Done rows shown before "Show more"; active rows always render.
const DONE_VISIBLE_LIMIT = 10;
const SUMMARY_TOOLTIP_MAX_CHARS = 280;
const SECONDARY_TEXT_CLASS_NAME = "text-[var(--color-text-foreground-secondary)]";

function rowTooltip(item: EnvironmentSubagentRosterItem): string {
  const summary =
    item.summary && item.summary.length > SUMMARY_TOOLTIP_MAX_CHARS
      ? `${item.summary.slice(0, SUMMARY_TOOLTIP_MAX_CHARS - 1)}…`
      : item.summary;
  const stats = formatEnvironmentSubagentMeta(item, false);
  return [[item.fullLabel, item.modelLabel].filter(Boolean).join(" · "), stats, summary]
    .filter(Boolean)
    .join("\n\n");
}

function settledSubagentWorkedMs(item: EnvironmentSubagentRosterItem): number | null {
  if (
    typeof item.durationMs === "number" &&
    Number.isFinite(item.durationMs) &&
    item.durationMs > 0
  ) {
    return item.durationMs;
  }
  if (!item.startedAt || !item.settledAt) return null;
  const startedAtMs = Date.parse(item.startedAt);
  const settledAtMs = Date.parse(item.settledAt);
  if (Number.isNaN(startedAtMs) || Number.isNaN(settledAtMs) || settledAtMs < startedAtMs) {
    return null;
  }
  return settledAtMs - startedAtMs;
}

function finishedAgoLabel(
  item: EnvironmentSubagentRosterItem,
  nowMs: number,
  locale: "en" | "zh-CN",
): string | null {
  const at = item.settledAt;
  if (!at) return null;
  const minutes = Math.floor(Math.max(0, nowMs - new Date(at).getTime()) / 60_000);
  if (locale === "zh-CN") {
    if (minutes < 1) return "刚刚";
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days} 天前`;
    if (days < 30) return `${Math.floor(days / 7)} 周前`;
    if (days < 365) return `${Math.floor(days / 30)} 个月前`;
    return `${Math.floor(days / 365)} 年前`;
  }
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function ListHeading({ label, count }: { label: string; count: number }) {
  return (
    <p className={cn("px-2 pt-3 pb-1 text-ui-sm first:pt-0", SECONDARY_TEXT_CLASS_NAME)}>
      {label} · {count}
    </p>
  );
}

function ActiveSubagentRow({
  item,
  nowMs,
  onOpen,
  onBackground,
  onStop,
}: {
  item: EnvironmentSubagentRosterItem;
  nowMs: number;
  onOpen: (threadId: ThreadId) => void;
  onBackground: (item: EnvironmentSubagentRosterItem) => void;
  onStop: (item: EnvironmentSubagentRosterItem) => void;
}) {
  const { t } = useTranslation();
  const elapsedMs = environmentSubagentElapsedMs(item, nowMs);
  const statusText =
    item.statusKind === "queued"
      ? t("chatgptConversations.subagents.status.waiting")
      : item.statusKind === "failed"
        ? t("chatgptConversations.subagents.status.failed")
        : t("chatgptConversations.subagents.status.working");
  const meta = formatEnvironmentSubagentMeta(item);
  const showBackground = item.isActive && !item.isBackground;
  const showStop = item.isActive;
  const actionCount = Number(showBackground) + Number(showStop);

  // The actions overlay the first line instead of nesting inside the row (a button cannot
  // contain a button); on hover the time gives way to a spacer that reserves their slot.
  return (
    <div className="group/subagent relative">
      <EnvironmentRow
        compact
        icon={<SubagentAvatar seed={item.key} accentColor={item.accentColor} className="size-5" />}
        label={
          <span className="flex min-w-0 flex-col">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate">{item.primaryLabel}</span>
              {elapsedMs !== null ? (
                <span
                  className={cn(
                    "shrink-0 text-ui-sm tabular-nums",
                    SECONDARY_TEXT_CLASS_NAME,
                    actionCount > 0 &&
                      "group-focus-within/subagent:hidden group-hover/subagent:hidden",
                  )}
                >
                  {formatClockDuration(elapsedMs)}
                </span>
              ) : null}
              {actionCount > 0 ? (
                <span
                  aria-hidden
                  className={cn(
                    "hidden shrink-0 group-focus-within/subagent:block group-hover/subagent:block",
                    actionCount === 2 ? "w-12" : "w-6",
                  )}
                />
              ) : null}
            </span>
            <span className={cn("truncate text-ui-sm", SECONDARY_TEXT_CLASS_NAME)}>
              {item.modelLabel ? <span>{item.modelLabel}</span> : null}
              {item.modelLabel ? " · " : null}
              <span className={subagentStatusTextToneClassName(item.statusKind)}>{statusText}</span>
              {meta ? ` · ${meta}` : null}
            </span>
          </span>
        }
        className={cn(
          "items-start",
          item.isViewed && "bg-[var(--color-background-elevated-secondary)]",
        )}
        title={rowTooltip(item)}
        aria-label={`Open subagent ${item.fullLabel}${item.statusLabel ? ` (${item.statusLabel})` : ""}`}
        aria-current={item.isViewed ? "page" : undefined}
        data-testid="subagents-pane-active-row"
        onClick={() => onOpen(item.threadId)}
      />
      {actionCount > 0 ? (
        <div className="pointer-events-none invisible absolute top-0.5 right-2 flex items-center opacity-0 transition-opacity group-focus-within/subagent:pointer-events-auto group-focus-within/subagent:visible group-focus-within/subagent:opacity-100 group-hover/subagent:pointer-events-auto group-hover/subagent:visible group-hover/subagent:opacity-100">
          {showBackground ? (
            <IconButton
              label={`Run ${item.primaryLabel} in background`}
              tooltip="Run in background (ctrl+b)"
              onClick={() => onBackground(item)}
            >
              <BackgroundTrayIcon className="size-4" />
            </IconButton>
          ) : null}
          {showStop ? (
            <IconButton
              label={`Stop subagent ${item.primaryLabel}`}
              tooltip="Stop subagent"
              onClick={() => onStop(item)}
            >
              <StopIcon className="size-4" />
            </IconButton>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function DoneSubagentRow({
  item,
  nowMs,
  onOpen,
}: {
  item: EnvironmentSubagentRosterItem;
  nowMs: number;
  onOpen: (threadId: ThreadId) => void;
}) {
  const { format, locale, t } = useTranslation();
  const outcome =
    item.statusKind === "failed"
      ? t("chatgptConversations.subagents.status.failed")
      : item.statusKind === "stopped"
        ? t("chatgptConversations.subagents.panel.preview.stopped")
        : null;
  // Settled rows freeze on the provider duration, then spawn→settle. A live
  // wall clock would keep "Worked for" growing after the run finished.
  const workedMs = settledSubagentWorkedMs(item);
  const workedFor =
    workedMs !== null && workedMs > 0
      ? format("localConversation.workedFor", { time: formatClockDuration(workedMs) })
      : null;
  const finishedAgo = workedFor ?? finishedAgoLabel(item, nowMs, locale);
  return (
    <EnvironmentRow
      compact
      icon={<SubagentAvatar seed={item.key} accentColor={item.accentColor} className="size-5" />}
      label={
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 truncate">{item.primaryLabel}</span>
          {outcome ? (
            <span
              className={cn(
                "shrink-0 text-ui-sm",
                subagentStatusTextToneClassName(item.statusKind),
              )}
            >
              {outcome}
            </span>
          ) : null}
        </span>
      }
      trailing={
        finishedAgo ? (
          <span className={cn("text-ui-sm", SECONDARY_TEXT_CLASS_NAME)}>{finishedAgo}</span>
        ) : null
      }
      className={cn(item.isViewed && "bg-[var(--color-background-elevated-secondary)]")}
      title={rowTooltip(item)}
      aria-label={`Open subagent ${item.fullLabel}${item.statusLabel ? ` (${item.statusLabel})` : ""}`}
      aria-current={item.isViewed ? "page" : undefined}
      data-testid="subagents-pane-done-row"
      onClick={() => onOpen(item.threadId)}
    />
  );
}

export function SubagentsList({
  roster,
  parent,
  nowMs,
  onOpen,
  onBackground,
  onStop,
}: {
  roster: EnvironmentSubagentRoster;
  parent: SubagentParentRow | null;
  nowMs: number;
  onOpen: (threadId: ThreadId) => void;
  onBackground: (item: EnvironmentSubagentRosterItem) => void;
  onStop: (item: EnvironmentSubagentRosterItem) => void;
}) {
  const [showAllDone, setShowAllDone] = useState(false);
  const { format, t, locale } = useTranslation();
  const { active, previous } = roster;
  const working = active.filter((item) => item.statusKind !== "queued");
  const waiting = active.filter((item) => item.statusKind === "queued");
  const failed = previous.filter((item) => item.statusKind === "failed");
  const done = previous.filter((item) => item.statusKind !== "failed");
  const workingHeading = t("chatgptConversations.subagents.status.working");
  const waitingHeading = t("chatgptConversations.subagents.status.waiting");
  const doneHeading = t("chatgptConversations.subagents.status.done");
  const failedHeading = t("chatgptConversations.subagents.status.failed");

  const hiddenDoneCount = showAllDone ? 0 : Math.max(0, done.length - DONE_VISIBLE_LIMIT);
  const visibleDone = done.slice(0, DONE_VISIBLE_LIMIT);

  return (
    <div
      className="flex h-full min-h-0 w-full min-w-0 flex-col gap-0.5 overflow-y-auto px-3 py-4"
      data-testid="subagents-dock-pane"
    >
      {parent ? (
        <EnvironmentRow
          icon={<BackToParentIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
          label={<span className="truncate">{parent.label ?? "Main thread"}</span>}
          aria-label={`Back to ${parent.label ?? "main thread"}`}
          className="mb-2"
          onClick={() => onOpen(parent.threadId)}
        />
      ) : null}
      {active.length === 0 && previous.length === 0 ? (
        <PanelStateMessage>{t("localConversation.subagentsPanel.noActive")}</PanelStateMessage>
      ) : null}
      {working.length > 0 ? (
        <>
          <ListHeading label={workingHeading} count={working.length} />
          {working.map((item) => (
            <ActiveSubagentRow
              key={item.key}
              item={item}
              nowMs={nowMs}
              onOpen={onOpen}
              onBackground={onBackground}
              onStop={onStop}
            />
          ))}
        </>
      ) : null}
      {waiting.length > 0 ? (
        <>
          <ListHeading label={waitingHeading} count={waiting.length} />
          {waiting.map((item) => (
            <ActiveSubagentRow
              key={item.key}
              item={item}
              nowMs={nowMs}
              onOpen={onOpen}
              onBackground={onBackground}
              onStop={onStop}
            />
          ))}
        </>
      ) : null}
      {failed.length > 0 ? (
        <>
          <ListHeading label={failedHeading} count={failed.length} />
          {failed.map((item) => (
            <DoneSubagentRow key={item.key} item={item} nowMs={nowMs} onOpen={onOpen} />
          ))}
        </>
      ) : null}
      {done.length > 0 ? (
        <>
          <ListHeading label={doneHeading} count={done.length} />
          {visibleDone.map((item) => (
            <DoneSubagentRow key={item.key} item={item} nowMs={nowMs} onOpen={onOpen} />
          ))}
          <DisclosureRegion open={showAllDone}>
            {done.slice(DONE_VISIBLE_LIMIT).map((item) => (
              <DoneSubagentRow key={item.key} item={item} nowMs={nowMs} onOpen={onOpen} />
            ))}
          </DisclosureRegion>
          {done.length > DONE_VISIBLE_LIMIT ? (
            <EnvironmentRow
              compact
              icon={<DisclosureChevron open={showAllDone} className="size-5 shrink-0" />}
              label={
                <span className={SECONDARY_TEXT_CLASS_NAME}>
                  {hiddenDoneCount > 0
                    ? locale === "zh-CN"
                      ? format("rightDock.subagents.showMore", { count: hiddenDoneCount })
                      : `Show ${hiddenDoneCount} more`
                    : locale === "zh-CN"
                      ? format("rightDock.subagents.showLess", {})
                      : "Show less"}
                </span>
              }
              aria-expanded={hiddenDoneCount === 0}
              onClick={() => setShowAllDone((value) => !value)}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export function SubagentsDockPane({
  hostThreadId,
  onOpenThread,
}: {
  hostThreadId: ThreadId;
  onOpenThread?: (threadId: ThreadId) => void;
}) {
  const { roster, source } = useThreadSubagentRoster(hostThreadId);
  const { backgroundSubagent, stopSubagent } = useSubagentRunControls(source.stripSourceThreadId);
  const navigate = useNavigate();
  const openRightDockPane = useRightDockStore((store) => store.openPane);
  const nowMs = useNowMs(
    roster.active.length > 0 || roster.previous.some((item) => item.settledAt !== null),
    roster.active.length > 0 ? 1_000 : 60_000,
  );

  // Docks are per thread: open this list in the destination's dock too, so hopping
  // between siblings (or back to the parent) keeps it beside the transcript.
  const openThread = (threadId: ThreadId) => {
    openRightDockPane(threadId, { kind: "subagents" });
    if (onOpenThread) {
      onOpenThread(threadId);
      return;
    }
    void navigate({
      to: "/$threadId",
      params: { threadId },
      search: (previousSearch) => stripDiffSearchParams(previousSearch),
    });
  };

  return (
    <SubagentsList
      roster={roster}
      parent={source.subagentParentRow}
      nowMs={nowMs}
      onOpen={openThread}
      onBackground={(item) => void backgroundSubagent(item)}
      onStop={(item) => void stopSubagent(item)}
    />
  );
}
