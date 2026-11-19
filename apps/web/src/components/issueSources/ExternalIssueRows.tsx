// FILE: ExternalIssueRows.tsx
// Purpose: Linear and Jira issues in the code review list: the state glyph (the same three
//          outline glyphs and Moss meaning colors as GitHub issues), a row shaped like the GitHub
//          rows above it, and each source's section with its own note when a team or site could
//          not answer.
// Layer: Issue sources presentation
// Exports: ExternalIssueStateGlyph, ExternalIssueRow, ExternalIssueListSection

import type { ExternalIssue, ExternalIssueSource, ExternalIssueState } from "@moss/contracts";
import { useState } from "react";

import { PullRequestActorLabel } from "~/components/pullRequest/PullRequestActorLabel";
import { issueSourceErrorReason } from "~/components/pullRequest/PullRequestsUnavailableState";
import { PullRequestWarningNote } from "~/components/pullRequest/PullRequestWarningNote";
import {
  PR_BODY_TEXT_CLASS_NAME,
  PR_FINE_TEXT_CLASS_NAME,
  PR_QUIET_INK_CLASS_NAME,
} from "~/components/pullRequest/pullRequestText";
import { SidebarCollapsibleSection } from "~/components/SidebarListSection";
import { Button } from "~/components/ui/button";
import { IssueClosedIcon, IssueNotPlannedIcon, IssueOpenedIcon } from "~/lib/icons";
import { formatTimeAgo } from "~/lib/timeFormat";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import { ISSUE_SOURCE_PRESENTATION } from "./issueSources.logic";

/** The glyph and Moss tone of a state, by its category (Linear's own; Jira's mapped to it). */
export function ExternalIssueStateGlyph({
  state,
  className,
}: {
  state: ExternalIssueState | null;
  className?: string;
}) {
  const type = state?.type ?? "unknown";
  const Icon =
    type === "completed"
      ? IssueClosedIcon
      : type === "canceled"
        ? IssueNotPlannedIcon
        : IssueOpenedIcon;
  const tone =
    type === "completed"
      ? "text-status-success"
      : type === "canceled" || type === "backlog" || type === "triage"
        ? "text-muted-foreground"
        : "text-foreground";
  return (
    <span
      role="img"
      aria-label={state?.name ?? ""}
      title={state?.name}
      className={cn("flex size-4 shrink-0 items-center justify-center", className)}
    >
      <Icon aria-hidden className={cn("size-full", tone)} />
    </span>
  );
}

export function ExternalIssueRow({
  issue,
  selected,
  onSelect,
}: {
  issue: ExternalIssue;
  selected: boolean;
  onSelect: (issue: ExternalIssue) => void;
}) {
  const { locale } = useTranslation();
  const timestamp = issue.updatedAt ?? issue.createdAt;
  return (
    <Button
      variant="ghost"
      data-external-issue-row={issue.source}
      data-external-issue-id={issue.id}
      aria-current={selected ? "true" : undefined}
      title={`${issue.title} ${issue.identifier}`}
      onClick={() => onSelect(issue)}
      className={cn(
        "h-auto w-full min-w-0 flex-col items-stretch justify-start gap-1 rounded-row py-2 pr-2 pl-3 text-left font-normal whitespace-normal",
        selected && "bg-[color-mix(in_srgb,var(--color-text-foreground)_7%,transparent)]",
      )}
    >
      <span
        className={cn(
          PR_BODY_TEXT_CLASS_NAME,
          "line-clamp-2 min-w-0 break-words font-medium leading-snug text-foreground",
        )}
        data-translation-skip="true"
      >
        {issue.title}
      </span>
      <span
        className={cn(
          PR_FINE_TEXT_CLASS_NAME,
          PR_QUIET_INK_CLASS_NAME,
          "flex min-w-0 items-center gap-1.5",
        )}
      >
        <ExternalIssueStateGlyph state={issue.state} />
        {issue.team?.name ? (
          <span className="min-w-0 max-w-[6rem] shrink-0 truncate">{issue.team.name}</span>
        ) : null}
        {issue.assignee ? <PullRequestActorLabel actor={issue.assignee} /> : null}
        {timestamp ? (
          <>
            <span aria-hidden className="shrink-0">
              ·
            </span>
            <time dateTime={timestamp} className="shrink-0 tabular-nums">
              {formatTimeAgo(timestamp, { locale })}
            </time>
          </>
        ) : null}
        <span className="ml-auto shrink-0 pl-1 tabular-nums opacity-80">{issue.identifier}</span>
      </span>
    </Button>
  );
}

/** One source's part of the list, under its own heading below the GitHub rows. */
export function ExternalIssueListSection({
  source,
  issues,
  selectedId,
  failedTeamCount,
  truncated,
  forceOpen,
  error,
  onRetry,
  onSelect,
}: {
  source: ExternalIssueSource;
  issues: ReadonlyArray<ExternalIssue>;
  selectedId: string | null;
  failedTeamCount: number;
  truncated: boolean;
  /** While searching, the section opens so a match is never hidden behind a fold. */
  forceOpen: boolean;
  /** List query failure for this source, shown with source-aware copy (never blaming GitHub). */
  error?: unknown;
  onRetry?: () => void;
  onSelect: (issue: ExternalIssue) => void;
}) {
  const { t, format } = useTranslation();
  const [open, setOpen] = useState(true);
  const name = ISSUE_SOURCE_PRESENTATION[source].name;
  const errorReason = error ? issueSourceErrorReason(error) : null;
  const errorMessage = error
    ? format(
        errorReason === "not-connected"
          ? "issueSources.unavailable.notConnectedHint"
          : errorReason === "unreadable"
            ? "issueSources.unavailable.unreadable"
            : "issueSources.unavailable.failed",
        { source: name },
      )
    : null;
  return (
    // Bleeds like the GitHub list above it, so titles and the heading sit on the same vertical.
    <section aria-label={name} data-inbox-section={source} className="-mx-3">
      <SidebarCollapsibleSection
        label={`${name} · ${issues.length}`}
        open={open || forceOpen}
        onToggle={() => setOpen((value) => !value)}
        headerClassName="px-3"
        headingLevel={2}
      >
        <div className="flex flex-col gap-0.5">
          {issues.map((issue) => (
            <ExternalIssueRow
              key={issue.id}
              issue={issue}
              selected={issue.id === selectedId}
              onSelect={onSelect}
            />
          ))}
          {errorMessage ? (
            <div className="px-3 py-1">
              <PullRequestWarningNote shape="callout">
                <span className="flex flex-wrap items-center justify-between gap-2">
                  <span>{errorMessage}</span>
                  {onRetry ? (
                    <Button variant="outline" size="xs" onClick={onRetry}>
                      {t("codeReview.retry")}
                    </Button>
                  ) : null}
                </span>
              </PullRequestWarningNote>
            </div>
          ) : issues.length === 0 ? (
            <p className={cn(PR_FINE_TEXT_CLASS_NAME, "m-0 px-3 py-2 text-muted-foreground")}>
              {format("issueSources.empty", { source: name })}
            </p>
          ) : null}
          {truncated ? (
            <p className={cn(PR_FINE_TEXT_CLASS_NAME, "m-0 px-3 py-1 text-muted-foreground")}>
              {t(
                source === "jira" ? "issueSources.truncated.jira" : "issueSources.truncated.linear",
              )}
            </p>
          ) : null}
        </div>
      </SidebarCollapsibleSection>
      {failedTeamCount > 0 ? (
        <div className="px-3 pt-2">
          <PullRequestWarningNote shape="callout">
            {format(
              source === "jira"
                ? "issueSources.failedTeams.jira"
                : "issueSources.failedTeams.linear",
              { count: failedTeamCount },
            )}
          </PullRequestWarningNote>
        </div>
      ) : null}
    </section>
  );
}
