// FILE: GitHubItemHeader.tsx
// Purpose: The header a GitHub item's detail opens with, the same for pull requests and issues:
//          a state pill (its chevron opens the host's state menu) beside "repo #n"; the large
//          title; author, time, and (pull requests) head to base; then the labels. The actions
//          (and, on a narrow window, the back control) live in the page's top bar. Hosts that
//          show the detail as a page use it (the inbox); the chat dock keeps its compact header.
// Layer: Pull request presentation
// Exports: GitHubItemHeader, GitHubItemHeaderItem, GitHubItemBackButton

import type {
  GitHubIssueDetail,
  GitPullRequestMergeability,
  PullRequestDetail,
} from "@moss/contracts";
import type { ReactNode } from "react";

import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { IconButton } from "~/components/ui/icon-button";
import { Menu, MenuTrigger } from "~/components/ui/menu";
import { ArrowLeftIcon, ArrowRightIcon, ChevronDownIcon } from "~/lib/icons";
import { formatTimeAgo } from "~/lib/timeFormat";
import { useTranslation } from "~/localization";
import { cn } from "~/lib/utils";
import { GitHubLabelChips } from "./GitHubLabelChips";
import { PullRequestActorLabel } from "./PullRequestActorLabel";
import { PullRequestMetaLine } from "./PullRequestMetaLine";
import {
  IssueStateGlyph,
  PullRequestStateGlyph,
  pullRequestStateLabel,
  STATE_WORD_KEYS,
} from "./PullRequestStateGlyph";
import { PR_FINE_TEXT_CLASS_NAME, PR_META_TEXT_CLASS_NAME } from "./pullRequestText";

type HeaderFields =
  | "number"
  | "repository"
  | "url"
  | "title"
  | "author"
  | "createdAt"
  | "updatedAt"
  | "labels";

/** What the header shows, from either detail. Pull request detail carries no assignees. */
export type GitHubItemHeaderItem =
  | ({
      kind: "pullRequest";
      mergeability?: GitPullRequestMergeability | undefined;
    } & Pick<PullRequestDetail, HeaderFields | "state" | "isDraft" | "headBranch" | "baseBranch">)
  | ({ kind: "issue" } & Pick<
      GitHubIssueDetail,
      HeaderFields | "state" | "stateReason" | "assignees"
    >);

/** Returns a narrow layout from the detail to the list; leads the detail page's top bar. */
export function GitHubItemBackButton({
  onBack,
  className,
}: {
  onBack: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <IconButton
      variant="chrome"
      label={t("codeReview.back.aria")}
      tooltip={t("codeReview.back")}
      className={cn("shrink-0", className)}
      onClick={onBack}
    >
      <ArrowLeftIcon />
    </IconButton>
  );
}

export function GitHubItemHeader({
  item,
  stateMenu,
  className,
}: {
  item: GitHubItemHeaderItem;
  /** The entries of the state pill's menu (Draft / Ready for review). Absent: a plain pill. */
  stateMenu?: ReactNode;
  className?: string;
}) {
  const { locale, t, format } = useTranslation();
  const state =
    item.kind === "pullRequest"
      ? {
          word: t(
            STATE_WORD_KEYS[pullRequestStateLabel(item.state, item.isDraft, item.mergeability)] ??
              "codeReview.stateWord.open",
          ),
          glyph: (
            <PullRequestStateGlyph
              state={item.state}
              isDraft={item.isDraft}
              mergeability={item.mergeability}
              className="size-4"
            />
          ),
        }
      : {
          word: t(
            item.state === "open"
              ? "codeReview.stateWord.open"
              : item.stateReason === "not-planned" || item.stateReason === "duplicate"
                ? "codeReview.stateWord.notPlanned"
                : "codeReview.stateWord.completed",
          ),
          glyph: (
            <IssueStateGlyph state={item.state} stateReason={item.stateReason} className="size-4" />
          ),
        };
  const repositoryName = item.repository.split("/").pop() ?? item.repository;
  // A quiet ink chip, as Moss draws every status: only the glyph carries color, and only when the
  // state means something finished (green) or blocked (amber).
  const pillClassName = cn(
    PR_META_TEXT_CLASS_NAME,
    "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-secondary px-2.5 text-muted-foreground",
  );
  const pillContent = (
    <>
      {state.glyph}
      <span>{state.word}</span>
    </>
  );
  return (
    <header className={cn("shrink-0 pb-4", className)}>
      <div className="flex min-w-0 items-center gap-2">
        {stateMenu ? (
          <Menu>
            <MenuTrigger
              aria-label={format("codeReview.state.change", { state: state.word })}
              className={cn(
                pillClassName,
                "cursor-interaction pr-1.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              )}
            >
              {pillContent}
              <ChevronDownIcon aria-hidden className="size-3" />
            </MenuTrigger>
            <ComposerPickerMenuPopup align="start" side="bottom" className="w-48 min-w-48">
              {stateMenu}
            </ComposerPickerMenuPopup>
          </Menu>
        ) : (
          <span className={pillClassName}>{pillContent}</span>
        )}
        <span
          className={cn(PR_META_TEXT_CLASS_NAME, "min-w-0 truncate text-muted-foreground")}
          title={item.repository}
        >
          {repositoryName} #{item.number}
        </span>
      </div>
      {/* The page title role (22 on 28), as on every Moss page. */}
      <h1 className="mt-3 text-title font-semibold break-words" data-translation-skip="true">
        {item.title}
      </h1>
      <PullRequestMetaLine
        className={cn(PR_META_TEXT_CLASS_NAME, "mt-3 flex-wrap text-muted-foreground")}
      >
        <PullRequestActorLabel actor={item.author} className="font-medium text-foreground" />
        <span title={new Date(item.createdAt).toLocaleString()}>
          {formatTimeAgo(item.createdAt, { locale })}
        </span>
        {item.kind === "pullRequest" ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className={cn(PR_FINE_TEXT_CLASS_NAME, "min-w-0 truncate")}
              title={item.headBranch}
            >
              {item.headBranch}
            </span>
            <ArrowRightIcon aria-hidden className="size-4 shrink-0" />
            <span className={cn(PR_FINE_TEXT_CLASS_NAME, "shrink-0")}>{item.baseBranch}</span>
          </span>
        ) : null}
      </PullRequestMetaLine>
      {item.kind === "pullRequest" && item.labels.length > 0 ? (
        <GitHubLabelChips labels={item.labels} className="mt-3 flex-wrap" />
      ) : null}
    </header>
  );
}
