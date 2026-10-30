// Codex 26.1007 timeline row for native subagents under the parent turn.
// Source: sites-end-resource-ad39113306e8.js `tk` / `nk`
// i18n: subagents.activity.summary → chat.timeline.subagentStatus.*
// Marks are `Hu` → app-initial `KOc` (seeded sparkle img, `size-4`).
// This is the in-timeline row, not the sidebar child thread.

import { useTranslation } from "../../localization";
import { CodexSubagentSparkle } from "./CodexSubagentSparkle";
import { cn } from "~/lib/utils";
import {
  formatInlineSubagentNameList,
  selectInlineSubagentNames,
  type InlineSubagentStatus,
} from "./inlineSubagentActivity.logic";

export interface InlineSubagentActivityItem {
  readonly id: string;
  readonly label: string;
  readonly accentColor: string;
}

const STATUS_KEY = {
  active: "chat.timeline.subagentStatus.startedWorking",
  updated: "chat.timeline.subagentStatus.updated",
  completed: "chat.timeline.subagentStatus.finished",
  failed: "chat.timeline.subagentStatus.failed",
  progress: "chat.timeline.subagentStatus.progress",
} as const;

export function InlineSubagentActivity(props: {
  items: readonly InlineSubagentActivityItem[];
  status: InlineSubagentStatus;
  className?: string;
}) {
  const { t, locale } = useTranslation();
  const labels = props.items.map((item) => item.label);
  const nameList = formatInlineSubagentNameList(labels, locale);
  if (!nameList) return null;
  const { visibleNames } = selectInlineSubagentNames(labels);
  const chipCount = props.items.length > 3 ? Math.min(props.items.length, 4) : visibleNames.length;
  const chips = props.items.slice(0, chipCount);
  const statusPhrase =
    props.status === "interrupted"
      ? t(
          props.items.length === 1
            ? "chat.timeline.subagentStatus.interrupted.one"
            : "chat.timeline.subagentStatus.interrupted.many",
        )
      : t(STATUS_KEY[props.status]);

  return (
    <span
      data-testid="subagent-activity-inline-group"
      className={cn(
        // Codex `tk`: `flex min-w-0 items-start gap-1.5 text-base leading-5`.
        // `text-secondary` here is the 3% surface token, not Codex secondary copy.
        "flex min-w-0 items-start gap-1.5 text-size-chat leading-5 text-muted-foreground select-none",
        props.className,
      )}
    >
      <span className="inline-flex h-5 shrink-0 items-center gap-1.5" aria-hidden="true">
        {chips.map((item) => (
          <CodexSubagentSparkle
            key={item.id}
            seed={item.id}
            accentColor={item.accentColor}
            className="size-4"
            data-subagent-chip={item.id}
          />
        ))}
      </span>
      <span className="min-w-0 break-words">
        {nameList} {statusPhrase}
      </span>
    </span>
  );
}
