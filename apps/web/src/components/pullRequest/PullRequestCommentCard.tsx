// FILE: PullRequestCommentCard.tsx
// Purpose: One review/issue comment as a plain collapsible row (hairline-separated, no card
//          chrome): avatar + author leading, timestamp + per-row collapse chevron trailing,
//          finding-style comments elevated into a title + severity subheading, and a "Reply"
//          affordance that always opens the comment's own GitHub URL externally (falling back
//          to the PR URL when the comment has none) — never the in-app browser, since replying
//          has to happen on GitHub itself.
// Layer: Pull request presentation
// Exports: PullRequestCommentCard

import type { PullRequestComment } from "@moss/contracts";
import { useState } from "react";

import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { formatTimeAgo } from "~/lib/timeFormat";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { useTranslation, type TranslationKey } from "~/localization";
import {
  PR_BODY_TEXT_CLASS_NAME,
  PR_FINE_TEXT_CLASS_NAME,
  PR_META_TEXT_CLASS_NAME,
} from "./pullRequestText";
import { ensureNativeApi } from "~/nativeApi";
import { PullRequestActorLabel } from "./PullRequestActorLabel";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
import { parseFindingComment, type PullRequestCommentSeverity } from "./pullRequestComment.logic";

const SEVERITY_LABEL_KEYS: Record<PullRequestCommentSeverity, TranslationKey> = {
  High: "codeReview.comment.severity.high",
  Medium: "codeReview.comment.severity.medium",
  Low: "codeReview.comment.severity.low",
};

function severityToneClassName(severity: PullRequestCommentSeverity): string {
  if (severity === "High") return "text-destructive";
  if (severity === "Medium") return "text-warning";
  return "text-muted-foreground";
}

export function PullRequestCommentCard({
  comment,
  prUrl,
  workspaceRoot,
  defaultOpen: defaultOpenProp,
  replyTitle,
}: {
  comment: PullRequestComment;
  prUrl: string | null;
  workspaceRoot: string;
  /** Where Reply goes, for its tooltip; GitHub by default. */
  replyTitle?: string;
  /** Long threads start older comments collapsed so the tab doesn't eagerly render
   *  dozens of markdown trees. */
  defaultOpen?: boolean;
}) {
  const { locale, t } = useTranslation();
  const defaultOpen = defaultOpenProp ?? true;
  const [open, setOpen] = useState(defaultOpen);
  const finding = parseFindingComment(comment.body);
  const replyUrl = comment.url?.trim() || prUrl?.trim() || null;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="border-t border-border/50 first:border-t-0"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 py-2.5 text-left">
        <PullRequestActorLabel
          actor={comment.author}
          className={cn(PR_META_TEXT_CLASS_NAME, "flex-1 font-medium text-foreground")}
        />
        <span
          className={cn(PR_FINE_TEXT_CLASS_NAME, "shrink-0 tabular-nums text-muted-foreground")}
        >
          {formatTimeAgo(comment.createdAt, { locale })}
        </span>
        <DisclosureChevron open={open} />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="pb-3">
          {comment.path ? (
            <span
              data-translation-skip="true"
              className={cn(
                PR_FINE_TEXT_CLASS_NAME,
                "mb-2 block max-w-full truncate text-muted-foreground",
              )}
            >
              {comment.path}
            </span>
          ) : null}
          {finding ? (
            <div className="mb-2">
              <p
                className={cn(PR_BODY_TEXT_CLASS_NAME, "font-medium text-foreground")}
                data-translation-skip="true"
              >
                {finding.title}
              </p>
              <p
                className={cn(
                  PR_META_TEXT_CLASS_NAME,
                  "font-medium",
                  severityToneClassName(finding.severity),
                )}
              >
                {t(SEVERITY_LABEL_KEYS[finding.severity])}
              </p>
            </div>
          ) : null}
          <PullRequestMarkdown
            text={finding ? finding.body : comment.body}
            fallback={`_${t("codeReview.comment.noReviewBody")}_`}
            cwd={workspaceRoot}
          />
          {replyUrl ? (
            <div className="mt-2 flex justify-end">
              <Button
                variant="ghost"
                size="xs"
                title={replyTitle ?? t("codeReview.comment.replyOnGitHub")}
                onClick={() => void ensureNativeApi().shell.openExternal(replyUrl)}
              >
                {t("codeReview.comment.reply")}
              </Button>
            </div>
          ) : null}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
