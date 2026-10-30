// FILE: TimelineSubagentActivityGroup.tsx
// Purpose: Render routed subagents as compact, Codex-style timeline chips.
// Layer: Web chat presentation component
// Exports: TimelineSubagentActivityGroup, resolveTimelineSubagentStatus,
//          resolveTimelineSubagentGroupStatus

import { ThreadId } from "@synara/contracts";
import { memo, useState, type ReactNode } from "react";

import type { WorkLogSubagent } from "../../workLog";
import type { SubagentActivityKind } from "@synara/shared/subagentTool";
import { cn } from "~/lib/utils";
import {
  resolveSubagentAvatarSeed,
  resolveSubagentPresentation,
} from "../../lib/subagentPresentation";
import { useTranslation, type TranslationKey } from "~/localization";
import { SubagentSeededAvatar } from "./SubagentSeededAvatar";

export type TimelineSubagentStatus =
  | "active"
  | "updated"
  | "interrupted"
  | "completed"
  | "failed"
  | "progress";

const TIMELINE_SUBAGENT_STATUS_TRANSLATION_KEYS = {
  active: "chat.timeline.subagentStatus.startedWorking",
  updated: "chat.timeline.subagentStatus.updated",
  interrupted: "chat.timeline.subagentStatus.interrupted",
  completed: "chat.timeline.subagentStatus.finished",
  failed: "chat.timeline.subagentStatus.failed",
  progress: "chat.timeline.subagentStatus.progress",
} as const satisfies Record<TimelineSubagentStatus, TranslationKey>;

/** Normalize provider lifecycle aliases to the six Codex chip-group statuses. */
export function resolveTimelineSubagentStatus(
  subagent: Pick<WorkLogSubagent, "statusLabel" | "rawStatus" | "isActive" | "latestUpdate">,
): TimelineSubagentStatus {
  const status = [subagent.rawStatus, subagent.statusLabel]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/[_-]/gu, " ");
  if (/\b(failed|failure|error|errored)\b/u.test(status)) return "failed";
  if (/\b(stopped|cancelled|canceled|interrupted|aborted)\b/u.test(status)) return "interrupted";
  if (/\b(completed|complete|done|finished|success|succeeded|closed)\b/u.test(status))
    return "completed";
  // in_progress is an active lifecycle; only an explicit progress report uses this wording.
  if (/\b(made progress|progress)\b/u.test(status) && !/\bin\s*progress\b/u.test(status))
    return "progress";
  if (/\bupdated\b/u.test(status) || (subagent.isActive && subagent.latestUpdate?.trim()))
    return "updated";
  // The reference summary's unknown/other branch is "started working".
  return "active";
}

export function resolveTimelineSubagentGroupStatus(
  subagents: ReadonlyArray<
    Pick<WorkLogSubagent, "statusLabel" | "rawStatus" | "isActive" | "latestUpdate">
  >,
): TimelineSubagentStatus {
  const statuses = subagents.map(resolveTimelineSubagentStatus);
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("interrupted")) return "interrupted";
  if (statuses.includes("updated")) return "updated";
  if (statuses.includes("progress")) return "progress";
  if (statuses.length > 0 && statuses.every((status) => status === "completed")) return "completed";
  return "active";
}

function TimelineSubagentChipContent(props: { sourceId: string; primaryLabel: string }): ReactNode {
  return (
    <>
      <SubagentSeededAvatar
        aria-hidden="true"
        className="size-4 rounded-full"
        data-testid="subagent-avatar"
        seed={props.sourceId}
      />
      <span className="min-w-0 truncate whitespace-nowrap text-ui-lg leading-5">
        {props.primaryLabel}
      </span>
    </>
  );
}

type TimelineSubagentRow = {
  subagent: WorkLogSubagent;
  presentation: ReturnType<typeof resolveSubagentPresentation>;
  resolvedThreadId: string | null;
};

function rawIdentityVariants(value: string | null | undefined): ReadonlyArray<string> {
  const normalized = value?.trim();
  if (!normalized) {
    return [];
  }

  const slashIndex = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  const basename = slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
  const variants = new Set([normalized, basename]);
  if (normalized.startsWith("subagent:")) {
    const segments = normalized.split(":").filter(Boolean);
    const leaf = segments.at(-1);
    if (leaf) {
      variants.add(leaf);
    }
  }
  return [...variants];
}

function isRawSubagentIdentity(
  value: string | null | undefined,
  subagent: Pick<WorkLogSubagent, "threadId" | "providerThreadId" | "resolvedThreadId">,
): boolean {
  const normalized = value?.trim();
  if (!normalized) {
    return false;
  }

  const rawIdentities = [
    subagent.threadId,
    subagent.providerThreadId,
    subagent.resolvedThreadId,
  ].flatMap(rawIdentityVariants);
  return rawIdentities.includes(normalized);
}

function resolveTimelineSubagentRow(subagent: WorkLogSubagent): TimelineSubagentRow | null {
  // A provider/local id is useful for stable rendering but is not a user-facing identity. Do
  // not let it win over a meaningful role/title, and do not turn the generic presentation
  // fallback into an inline chip while metadata is still hydrating.
  const presentation = resolveSubagentPresentation({
    nickname: isRawSubagentIdentity(subagent.nickname, subagent) ? undefined : subagent.nickname,
    role: isRawSubagentIdentity(subagent.role, subagent) ? undefined : subagent.role,
    title: isRawSubagentIdentity(subagent.title, subagent) ? undefined : subagent.title,
  });
  if (
    !presentation.primaryLabel.trim() ||
    presentation.primaryLabel === "Subagent" ||
    isRawSubagentIdentity(presentation.primaryLabel, subagent)
  ) {
    return null;
  }

  return {
    subagent,
    presentation,
    resolvedThreadId: subagent.resolvedThreadId?.trim() || null,
  };
}

export const TimelineSubagentActivityGroup = memo(function TimelineSubagentActivityGroup(props: {
  groupId: string;
  subagents: ReadonlyArray<WorkLogSubagent>;
  activityKind?: SubagentActivityKind;
  onOpenThread?: ((threadId: ThreadId) => void) | undefined;
}) {
  const { format, t, locale } = useTranslation();
  const eligibleRows = props.subagents.flatMap((subagent) => {
    const row = resolveTimelineSubagentRow(subagent);
    return row ? [row] : [];
  });
  const visibleRows = eligibleRows.slice(0, 3);
  const hiddenSubagentCount = Math.max(0, eligibleRows.length - visibleRows.length);
  const groupStatus =
    props.activityKind === "started"
      ? "active"
      : props.activityKind === "interacted"
        ? "updated"
        : (props.activityKind ??
          resolveTimelineSubagentGroupStatus(eligibleRows.map((row) => row.subagent)));
  const groupStatusLabel =
    groupStatus === "interrupted"
      ? t(
          eligibleRows.length === 1
            ? "chat.timeline.subagentStatus.interrupted.one"
            : "chat.timeline.subagentStatus.interrupted.many",
        )
      : t(TIMELINE_SUBAGENT_STATUS_TRANSLATION_KEYS[groupStatus]);
  const [seenSourceIds, setSeenSourceIds] = useState(
    () => new Set(eligibleRows.map((row) => row.subagent.threadId)),
  );

  const markSourceSeen = (sourceId: string) => {
    setSeenSourceIds((current) => {
      if (current.has(sourceId)) {
        return current;
      }
      const next = new Set(current);
      next.add(sourceId);
      return next;
    });
  };

  if (eligibleRows.length === 0) {
    return null;
  }

  if (props.activityKind) {
    const namedCount = eligibleRows.length > 3 ? 2 : eligibleRows.length;
    const named = eligibleRows.slice(0, namedCount);
    return (
      <section
        className="flex min-w-0 items-start gap-1.5 text-size-chat leading-5 select-none text-codex-secondary"
        data-testid="subagent-activity-inline-group"
      >
        <span className="inline-flex h-5 shrink-0 items-center gap-1.5">
          {eligibleRows.slice(0, 4).map((row) => (
            <span
              key={row.subagent.threadId}
              className="timeline-subagent-chip-enter"
              data-animate-entrance={!seenSourceIds.has(row.subagent.threadId) ? "" : undefined}
              onAnimationEnd={() => markSourceSeen(row.subagent.threadId)}
            >
              <SubagentSeededAvatar
                aria-hidden="true"
                className="size-4"
                data-testid="subagent-avatar"
                seed={resolveSubagentAvatarSeed(row.subagent)}
              />
            </span>
          ))}
        </span>
        <span className="min-w-0 break-words">
          {named.map((row, index) => (
            <span key={row.subagent.threadId}>
              {index > 0
                ? index === named.length - 1 && eligibleRows.length <= 3
                  ? locale === "zh-CN"
                    ? "和"
                    : " and "
                  : locale === "zh-CN"
                    ? "、"
                    : ", "
                : null}
              {props.onOpenThread && row.resolvedThreadId ? (
                <button
                  type="button"
                  className="inline cursor-interaction rounded-sm bg-transparent p-0 text-start hover:text-default focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring"
                  data-subagent-thread-id={row.resolvedThreadId}
                  onClick={() => props.onOpenThread?.(ThreadId.makeUnsafe(row.resolvedThreadId!))}
                >
                  {row.presentation.primaryLabel}
                </button>
              ) : (
                row.presentation.primaryLabel
              )}
            </span>
          ))}
          {eligibleRows.length > namedCount
            ? locale === "zh-CN"
              ? `和另外 ${eligibleRows.length - namedCount} 个`
              : ` and ${eligibleRows.length - namedCount} more`
            : null}{" "}
          <span data-testid="subagent-group-status">{groupStatusLabel}</span>
        </span>
      </section>
    );
  }

  return (
    <section
      className="timeline-subagent-activity-group block min-w-0 max-w-full text-ui-sm leading-5 text-foreground/60"
      data-testid="subagent-activity-inline-group"
    >
      {visibleRows.map((row) => {
        const { presentation, resolvedThreadId, subagent } = row;
        const sourceId = subagent.threadId;
        const animateEntrance = !seenSourceIds.has(sourceId);
        const content = (
          <TimelineSubagentChipContent
            sourceId={resolveSubagentAvatarSeed(subagent)}
            primaryLabel={presentation.primaryLabel}
          />
        );
        const chipClassName =
          "timeline-subagent-chip timeline-subagent-chip-enter me-1.5 first:-ms-1.5 inline-flex h-7 max-w-48 min-w-0 items-center gap-1.5 rounded-full border pe-2 ps-1.5 align-middle text-left text-ui-lg leading-5 outline-none";
        const interactiveClassName = cn(
          chipClassName,
          "timeline-subagent-chip-interactive cursor-pointer",
        );
        const staticClassName = chipClassName;
        const motionProps = animateEntrance
          ? {
              "data-animate-entrance": "",
              onAnimationEnd: () => markSourceSeen(sourceId),
            }
          : {};

        return props.onOpenThread && resolvedThreadId ? (
          <button
            key={sourceId}
            type="button"
            className={interactiveClassName}
            data-subagent-thread-id={resolvedThreadId}
            aria-label={format("chat.timeline.openSubagent", {
              name: presentation.primaryLabel,
            })}
            onClick={() => props.onOpenThread?.(ThreadId.makeUnsafe(resolvedThreadId))}
            {...motionProps}
          >
            {content}
          </button>
        ) : (
          <span key={sourceId} className={staticClassName} {...motionProps}>
            {content}
          </span>
        );
      })}
      {hiddenSubagentCount > 0 ? (
        <span className="me-1.5 inline align-middle text-ui-lg leading-5 text-inherit">
          {format(
            hiddenSubagentCount === 1
              ? "chat.timeline.otherSubagent.one"
              : "chat.timeline.otherSubagent.many",
            { count: hiddenSubagentCount },
          )}
        </span>
      ) : null}
      {groupStatusLabel ? (
        <span
          className="me-1.5 inline align-middle text-ui-lg leading-5 text-inherit"
          data-testid="subagent-group-status"
        >
          {groupStatusLabel}
        </span>
      ) : null}
    </section>
  );
});
