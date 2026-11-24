// FILE: GitHubItemInfo.tsx
// Purpose: The status facts of a GitHub item's detail page, in two shapes of the same data: a
//          right-hand column of titled sections (wide panes) and compact label/value rows under
//          the header (narrow panes, or whenever the side chat dock takes the room). Pull
//          requests show Merge status, Comments, Reviews, Checks; issues show Assignees, Labels,
//          Comments. Either can lead with Threads, the item's side chats.
// Layer: Pull request presentation
// Exports: PullRequestInfo, IssueInfo, InfoSection, GitHubItemInfoThread, GitHubItemInfoVariant

import { HitArea } from "~/components/ui/hit-area";
import type { GitHubIssueDetail, PullRequestDetail, ThreadId } from "@moss/contracts";
import { useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { CentralIcon } from "~/lib/central-icons";
import {
  BotIcon,
  ChatBubbleIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  GitPullRequestIcon,
  TagIcon,
  UsersIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { useTranslation } from "~/localization";
import { withStableCheckKeys } from "~/components/chat/environment/environmentPullRequest.logic";
import { GitHubLabelChips } from "./GitHubLabelChips";
import { PullRequestActorLabel } from "./PullRequestActorLabel";
import { PullRequestCheckStatusIcon } from "./PullRequestCheckStatusIcon";
import { PullRequestChecksRing } from "./PullRequestChecksRing";
import {
  describePullRequestChecksBrief,
  describePullRequestMergeStatus,
} from "./pullRequestDetail.logic";
import { PullRequestStateGlyph } from "./PullRequestStateGlyph";
import { PullRequestMetaRow } from "./PullRequestMetaRow";
import { PullRequestConflictIcon } from "./pullRequestStatePresentation";
import { PR_META_TEXT_CLASS_NAME, PR_FINE_TEXT_CLASS_NAME } from "./pullRequestText";

export interface GitHubItemInfoThread {
  id: ThreadId;
  title: string;
}

/** Checks listed before "View more". */
const CHECKS_VISIBLE_LIMIT = 6;

export type GitHubItemInfoVariant = "column" | "rows";
type InfoVariant = GitHubItemInfoVariant;

export function InfoSection({
  variant,
  label,
  icon,
  action,
  children,
}: {
  variant: InfoVariant;
  label: string;
  icon?: ReactNode;
  /** Sits at the label's end in the column (the "Request" chip). */
  action?: ReactNode;
  children: ReactNode;
}) {
  if (variant === "rows") {
    return (
      <PullRequestMetaRow icon={icon} label={label} action={action}>
        {children}
      </PullRequestMetaRow>
    );
  }
  return (
    <section className="flex flex-col gap-2" aria-label={label}>
      <div className="flex h-6 items-center justify-between gap-2">
        <h2 className={cn(PR_META_TEXT_CLASS_NAME, "m-0 font-normal text-muted-foreground")}>
          {label}
        </h2>
        {action}
      </div>
      <div className={cn(PR_META_TEXT_CLASS_NAME, "flex min-w-0 flex-col gap-2")}>{children}</div>
    </section>
  );
}

function RequestChip({ url }: { url: string }) {
  const { t } = useTranslation();
  return (
    <Button
      variant="secondary"
      size="xs"
      className="h-6 gap-0.5 rounded-full pr-1.5 pl-2.5 font-normal"
      onClick={() => void ensureNativeApi().shell.openExternal(url)}
    >
      {t("codeReview.info.request")}
      <ChevronRightIcon aria-hidden />
    </Button>
  );
}

function ThreadsSection({
  variant,
  threads,
  onOpenThread,
}: {
  variant: InfoVariant;
  threads: ReadonlyArray<GitHubItemInfoThread>;
  onOpenThread: ((id: ThreadId) => void) | undefined;
}) {
  const { t } = useTranslation();
  if (threads.length === 0) return null;
  return (
    <InfoSection
      variant={variant}
      label={t("codeReview.info.threads")}
      icon={<BotIcon className="size-4" />}
    >
      {threads.map((thread) => (
        <HitArea
          key={thread.id}
          type="button"
          onClick={() => onOpenThread?.(thread.id)}
          className="max-w-full truncate rounded-row text-left hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {thread.title.replace(/^Sidechat:\s*/, "")}
        </HitArea>
      ))}
    </InfoSection>
  );
}

function CommentsSection({ variant, count }: { variant: InfoVariant; count: number }) {
  const { t, format } = useTranslation();
  return (
    <InfoSection
      variant={variant}
      label={t("codeReview.info.comments")}
      icon={<ChatBubbleIcon className="size-4" />}
    >
      <span className={count === 0 ? "text-muted-foreground" : undefined}>
        {count === 0
          ? t("codeReview.info.noComments")
          : format(count === 1 ? "codeReview.info.commentsOne" : "codeReview.info.commentsMany", {
              count,
            })}
      </span>
    </InfoSection>
  );
}

function MergeStatusSection({ detail }: { detail: PullRequestDetail }) {
  const { format, t } = useTranslation();
  const status = describePullRequestMergeStatus(detail, (key, values) => format(key, values ?? {}));
  return (
    <InfoSection variant="column" label={t("codeReview.info.mergeStatus")}>
      <span className="flex items-center gap-2">
        {status.tone === "success" ? (
          <CentralIcon name="circle-check" variant="fill" className="size-4 text-status-success" />
        ) : status.tone === "conflict" ? (
          <PullRequestConflictIcon className="size-4" />
        ) : (
          <PullRequestStateGlyph state={detail.state} isDraft={detail.isDraft} />
        )}
        {status.label}
      </span>
    </InfoSection>
  );
}

function ReviewsSection({ variant, detail }: { variant: InfoVariant; detail: PullRequestDetail }) {
  const { t } = useTranslation();
  const requestable = detail.state === "open";
  const reviewCount = detail.comments.filter((comment) => comment.kind === "review").length;
  const hasReviews = detail.reviewers.length > 0 || reviewCount > 0 || detail.reviewDecision;
  const decision =
    detail.reviewDecision === "APPROVED"
      ? t("codeReview.review.approved")
      : detail.reviewDecision === "CHANGES_REQUESTED"
        ? t("codeReview.review.changesRequested")
        : null;
  // GitHub has no request-review action here; its pull request page is where reviewers are picked.
  const request = requestable ? <RequestChip url={detail.url} /> : null;
  return (
    <InfoSection
      variant={variant}
      label={t("codeReview.info.reviews")}
      icon={<UsersIcon className="size-4" />}
      action={variant === "column" ? request : undefined}
    >
      {hasReviews ? (
        <>
          {decision ? <span>{decision}</span> : null}
          {detail.reviewers.map((actor) => (
            <PullRequestActorLabel key={actor.login} actor={actor} className="max-w-full" />
          ))}
        </>
      ) : (
        <span className="text-muted-foreground">{t("codeReview.review.none")}</span>
      )}
      {variant === "rows" ? request : null}
    </InfoSection>
  );
}

function CheckRows({ checks }: { checks: PullRequestDetail["checks"] }) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  const rows = withStableCheckKeys(checks);
  const visible = showAll ? rows : rows.slice(0, CHECKS_VISIBLE_LIMIT);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {visible.map(({ key, check }) => (
        <HitArea
          key={key}
          type="button"
          disabled={!check.url}
          onClick={() => check.url && void ensureNativeApi().shell.openExternal(check.url)}
          className="-mx-1.5 flex min-w-0 items-center gap-2 rounded-row px-1.5 py-1 text-left hover:bg-muted/50 disabled:hover:bg-transparent"
        >
          <PullRequestCheckStatusIcon status={check.status} />
          <span className="min-w-0 truncate">{check.name}</span>
        </HitArea>
      ))}
      {rows.length > CHECKS_VISIBLE_LIMIT ? (
        <HitArea
          type="button"
          onClick={() => setShowAll((current) => !current)}
          className={cn(
            PR_FINE_TEXT_CLASS_NAME,
            "w-fit rounded-row text-left text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          )}
        >
          {t(showAll ? "codeReview.checks.showFewer" : "codeReview.checks.viewMore")}
        </HitArea>
      ) : null}
    </div>
  );
}

function ChecksSection({ variant, detail }: { variant: InfoVariant; detail: PullRequestDetail }) {
  const { t, format } = useTranslation();
  const [open, setOpen] = useState(false);
  const brief = describePullRequestChecksBrief(detail.checks, (key, values) =>
    format(key, values ?? {}),
  );
  if (variant === "column") {
    return (
      <InfoSection variant="column" label={t("codeReview.info.checks")}>
        {detail.checks.length === 0 ? (
          <span className="text-muted-foreground">{t("codeReview.checks.none")}</span>
        ) : (
          <CheckRows checks={detail.checks} />
        )}
      </InfoSection>
    );
  }
  return (
    <InfoSection
      variant="rows"
      label={t("codeReview.info.checks")}
      icon={<PullRequestChecksRing checks={detail.checks} />}
    >
      {detail.checks.length === 0 ? (
        <span className="text-muted-foreground">{t("codeReview.checks.none")}</span>
      ) : (
        <div className="flex w-full min-w-0 flex-col">
          <HitArea
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
            className="flex w-fit items-center gap-1.5 rounded-row text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {brief.tone === "success" ? (
              <CircleCheckIcon className="size-4 text-status-success" aria-hidden />
            ) : null}
            {brief.label}
            <DisclosureChevron open={open} />
          </HitArea>
          <DisclosureRegion open={open}>
            <div className="pt-1.5">
              <CheckRows checks={detail.checks} />
            </div>
          </DisclosureRegion>
        </div>
      )}
    </InfoSection>
  );
}

export function PullRequestInfo({
  detail,
  variant,
  threads,
  onOpenThread,
}: {
  detail: PullRequestDetail;
  variant: InfoVariant;
  threads: ReadonlyArray<GitHubItemInfoThread>;
  onOpenThread?: ((id: ThreadId) => void) | undefined;
}) {
  return (
    <div
      className={cn(variant === "column" ? "flex flex-col gap-7" : "flex flex-col")}
      data-info-variant={variant}
    >
      {variant === "column" ? <MergeStatusSection detail={detail} /> : null}
      <ThreadsSection variant={variant} threads={threads} onOpenThread={onOpenThread} />
      <CommentsSection variant={variant} count={detail.comments.length} />
      <ReviewsSection variant={variant} detail={detail} />
      <ChecksSection variant={variant} detail={detail} />
    </div>
  );
}

export function IssueInfo({
  detail,
  variant,
  threads,
  onOpenThread,
  editors,
  linkedPullRequests,
}: {
  detail: GitHubIssueDetail;
  variant: InfoVariant;
  threads: ReadonlyArray<GitHubItemInfoThread>;
  onOpenThread?: ((id: ThreadId) => void) | undefined;
  /**
   * When the viewer may change the issue: each wraps its whole info row in the picker that edits
   * it, so the row itself is the control, and an empty row offers to add instead of saying none.
   */
  editors?: {
    assignees: (row: ReactNode) => ReactNode;
    labels: (row: ReactNode) => ReactNode;
    hint: ReactNode;
  };
  /** The linked pull requests section: its title and the list of rows. */
  linkedPullRequests?: { label: string; content: ReactNode };
}) {
  const { t } = useTranslation();
  const assigneesRow = (
    <InfoSection
      variant={variant}
      label={t("codeReview.info.assignees")}
      icon={<UsersIcon className="size-4" />}
      action={editors?.hint}
    >
      {detail.assignees.length === 0 ? (
        <span className="text-muted-foreground">
          {t(editors ? "githubIssue.add.assignees" : "codeReview.info.unassigned")}
        </span>
      ) : (
        detail.assignees.map((actor) => (
          <PullRequestActorLabel key={actor.login} actor={actor} className="max-w-full" />
        ))
      )}
    </InfoSection>
  );
  const labelsRow = (
    <InfoSection
      variant={variant}
      label={t("codeReview.info.labels")}
      icon={<TagIcon className="size-4" />}
      action={editors?.hint}
    >
      {detail.labels.length === 0 ? (
        <span className="text-muted-foreground">
          {t(editors ? "githubIssue.add.labels" : "codeReview.info.none")}
        </span>
      ) : (
        <GitHubLabelChips labels={detail.labels} className="flex-wrap" />
      )}
    </InfoSection>
  );
  return (
    <div
      className={cn(variant === "column" ? "flex flex-col gap-7" : "flex flex-col")}
      data-info-variant={variant}
    >
      <ThreadsSection variant={variant} threads={threads} onOpenThread={onOpenThread} />
      {editors ? editors.assignees(assigneesRow) : assigneesRow}
      {editors ? editors.labels(labelsRow) : labelsRow}
      {linkedPullRequests ? (
        <InfoSection
          variant={variant}
          label={linkedPullRequests.label}
          icon={<GitPullRequestIcon className="size-4" />}
        >
          {linkedPullRequests.content}
        </InfoSection>
      ) : null}
      <CommentsSection variant={variant} count={detail.commentCount} />
    </div>
  );
}
