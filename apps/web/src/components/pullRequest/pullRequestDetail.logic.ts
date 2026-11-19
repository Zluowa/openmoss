// FILE: pullRequestDetail.logic.ts
// Purpose: Pure helpers shared by every host of the pull request detail surface (the inbox
//          route's detail pane and the chat right-dock pane): the canonical
//          pane identity key, the "PR #n" tab chip label, the plain-language state
//          descriptor, and the flattened chronological timeline event list.
// Layer: Web domain helpers (no React)
// Exports: pullRequestDetailInputKey, pullRequestPaneTabLabel, pullRequestDetailInputFromPane,
//          describePullRequestState, stripHtmlComments, PullRequestTimelineEvent,
//          buildPullRequestTimelineEvents

import type { PullRequestDetail, PullRequestDetailInput, PullRequestState } from "@moss/contracts";

import type { RightDockPane } from "~/rightDockStore.logic";

import { formatMossTranslation, type TranslationKey } from "~/localization";
import { pullRequestMarkdownPreview } from "./pullRequestMarkdown.logic";

/** Canonical identity for one detail surface — used as the React key so switching the
 *  selected pull request remounts the panel (resetting its tab and diff state). */
export function pullRequestDetailInputKey(input: PullRequestDetailInput): string {
  return `${input.projectId}:${input.repository}#${input.number}`;
}

/** Tab chip label for the right-dock pane tab. */
export function pullRequestPaneTabLabel(number: number): string {
  return `PR #${number}`;
}

/** The detail input a dock "pullRequest" pane points at, or null while the pane is empty.
 *  Single owner of the identity-fields guard so every pane consumer (content, tab icon)
 *  validates the same way. */
export function pullRequestDetailInputFromPane(pane: RightDockPane): PullRequestDetailInput | null {
  if (
    pane.kind !== "pullRequest" ||
    !pane.pullRequestProjectId ||
    !pane.pullRequestRepository ||
    !pane.pullRequestNumber
  ) {
    return null;
  }
  return {
    projectId: pane.pullRequestProjectId,
    repository: pane.pullRequestRepository,
    number: pane.pullRequestNumber,
  };
}

// Plain-language state descriptor shown next to the author line — the state color itself is
// already conveyed by the PullRequestStateGlyph in the header, so this stays neutral text.
// State only, matching git: conflicts are a merge signal and render as their own row.
export function describePullRequestState(
  state: PullRequestState,
  isDraft: boolean,
  translate: (key: TranslationKey) => string = (key) => formatMossTranslation("en", key, {}),
): string {
  if (isDraft && state === "open") return translate("codeReview.stateWord.draft");
  if (state === "open") return translate("codeReview.prState.readyForReview");
  if (state === "merged") return translate("codeReview.stateWord.merged");
  return translate("codeReview.stateWord.closed");
}

// stripHtmlComments now lives with the rest of the markdown preprocessing.
export { stripHtmlComments } from "./pullRequestMarkdown.logic";

export interface PullRequestTimelineEvent {
  id: string;
  /** ISO timestamp the event sorts by. */
  at: string;
  title: string;
  body: string | null;
}

/** How the app names a GitHub person: the display name, else the login. Null when neither is
 *  known (a deleted account); each surface picks its own word for that case. */
export function githubActorName(
  actor: { login?: string | null; name?: string | null } | null | undefined,
): string | null {
  return actor?.name?.trim() || actor?.login?.trim() || null;
}

/** A pull request's timeline source; issues have no commits and no merge. */
export type GitHubItemTimelineSource = Pick<
  PullRequestDetail,
  "createdAt" | "author" | "comments" | "closedAt"
> &
  Partial<Pick<PullRequestDetail, "commits" | "mergedAt">>;

/** Flattens creation, commits, comments/reviews, and the terminal merge/close event into one
 *  chronologically sorted list. Merged wins over closed: GitHub sets both timestamps on a
 *  merge, and showing "closed" for a merged pull request would misstate what happened. */
export function buildPullRequestTimelineEvents(
  detail: GitHubItemTimelineSource,
  noun?: "pull request" | "issue",
  /** Words in the reader's language; English when absent (tests and logs). */
  format: (key: TranslationKey, values?: Record<string, string | number>) => string = (
    key,
    values,
  ) => formatMossTranslation("en", key, values ?? {}),
): PullRequestTimelineEvent[] {
  const issue = noun === "issue";
  const mergedAt = detail.mergedAt ?? null;
  const someone = format("codeReview.timeline.someone");
  const events: PullRequestTimelineEvent[] = [
    {
      id: "created",
      at: detail.createdAt,
      title: format(
        issue ? "codeReview.timeline.opened.issue" : "codeReview.timeline.opened.pullRequest",
        { name: githubActorName(detail.author) ?? someone },
      ),
      body: null,
    },
    ...(detail.commits ?? []).map((commit) => {
      const authorLabel = commit.authors.map(githubActorName).find((name) => name !== null);
      const sha = commit.oid.slice(0, 7);
      return {
        id: commit.oid,
        at: commit.committedDate,
        title: authorLabel
          ? format("codeReview.timeline.commitBy", { sha, name: authorLabel })
          : format("codeReview.timeline.commit", { sha }),
        body: commit.messageHeadline || format("codeReview.timeline.noCommitMessage"),
      };
    }),
    ...detail.comments.map((comment) => ({
      id: comment.id,
      at: comment.createdAt,
      title: format(
        comment.kind === "review"
          ? "codeReview.timeline.reviewed"
          : "codeReview.timeline.commented",
        { name: githubActorName(comment.author) ?? someone },
      ),
      // Timeline previews are plain text, so raw markdown/HTML would print literally.
      body: pullRequestMarkdownPreview(comment.body) || null,
    })),
    ...(mergedAt
      ? [
          {
            id: "merged",
            at: mergedAt,
            title: format(
              issue ? "codeReview.timeline.merged.issue" : "codeReview.timeline.merged.pullRequest",
            ),
            body: null,
          },
        ]
      : []),
    ...(detail.closedAt && !mergedAt
      ? [
          {
            id: "closed",
            at: detail.closedAt,
            title: format(
              issue ? "codeReview.timeline.closed.issue" : "codeReview.timeline.closed.pullRequest",
            ),
            body: null,
          },
        ]
      : []),
  ];
  return events.toSorted((left, right) => left.at.localeCompare(right.at));
}

export type PullRequestMergeStatusTone = "success" | "conflict" | "muted";

/** Words in the reader's language; English when absent (tests and logs). */
type DetailTextFormat = (key: TranslationKey, values?: Record<string, string | number>) => string;

const englishDetailText: DetailTextFormat = (key, values) =>
  formatMossTranslation("en", key, values ?? {});

/** The Merge status line of the detail's info column, from what GitHub reports. */
export function describePullRequestMergeStatus(
  detail: Pick<PullRequestDetail, "state" | "isDraft" | "mergeability" | "baseBranch">,
  format: DetailTextFormat = englishDetailText,
): { tone: PullRequestMergeStatusTone; label: string } {
  if (detail.state === "merged")
    return { tone: "muted", label: format("codeReview.stateWord.merged") };
  if (detail.state === "closed")
    return { tone: "muted", label: format("codeReview.stateWord.closed") };
  if (detail.isDraft) return { tone: "muted", label: format("codeReview.stateWord.draft") };
  if (detail.mergeability === "conflicting") {
    return {
      tone: "conflict",
      label: format("codeReview.merge.conflictsWith", { branch: detail.baseBranch }),
    };
  }
  if (detail.mergeability === "mergeable") {
    return { tone: "success", label: format("codeReview.merge.clean") };
  }
  return { tone: "muted", label: format("codeReview.merge.unknown") };
}

/** "24 successful", "2 failing, 22 successful": the checks row's one-line summary. */
export function describePullRequestChecksBrief(
  checks: ReadonlyArray<{
    status: PullRequestDetail["checks"][number]["status"];
  }>,
  format: DetailTextFormat = englishDetailText,
): { tone: "success" | "failure" | "pending" | "none"; label: string } {
  if (checks.length === 0) return { tone: "none", label: format("codeReview.checks.none") };
  const count = (...statuses: string[]) =>
    checks.filter((check) => statuses.includes(check.status)).length;
  const failing = count("failure", "cancelled");
  const pending = count("pending");
  const successful = count("success");
  const parts = [
    failing > 0 ? format("codeReview.checks.failing", { count: failing }) : null,
    pending > 0 ? format("codeReview.checks.pending", { count: pending }) : null,
    successful > 0 ? format("codeReview.checks.successful", { count: successful }) : null,
  ].filter((part) => part !== null);
  const label =
    parts.length > 0
      ? parts.join(format("codeReview.checks.separator"))
      : format("codeReview.checks.skipped", { count: checks.length });
  return {
    tone: failing > 0 ? "failure" : pending > 0 ? "pending" : successful > 0 ? "success" : "none",
    label,
  };
}
