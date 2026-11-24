// FILE: PullRequestCommentComposer.tsx
// Purpose: Inline "Leave a comment" pill at the bottom of a GitHub item's Comments section. Posts
//          through the comment mutation its host passes in (pull request or issue), as the
//          authenticated GitHub user (hence the GitHub glyph in the leading slot); the mutation
//          owns revalidating the detail and the lists. Enter submits; Shift+Enter breaks a line
//          (comments accept markdown).
// Layer: Pull request presentation
// Exports: PullRequestCommentComposer, GitHubCommentTarget, GitHubCommentMutation

import { IconButton } from "~/components/ui/icon-button";
import { isImeComposingKeyEvent } from "~/lib/imeKeyEvent";
import { GLASS_RAISED_SURFACE_CLASS_NAME } from "~/surfaceStyles";
import type { PullRequestDetailInput } from "@moss/contracts";
import { useRef, useState, type ReactNode } from "react";

import { toastManager } from "~/components/ui/toast";
import { ArrowUpIcon, GitHubIcon } from "~/lib/icons";
import { PR_BODY_TEXT_CLASS_NAME } from "./pullRequestText";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";

/** The item a comment goes to. Pull requests and issues share one number space per repository. */
export type GitHubCommentTarget = Pick<
  PullRequestDetailInput,
  "projectId" | "repository" | "number"
>;

/** The slice of a React Query comment mutation the composer drives. */
export interface GitHubCommentMutation {
  mutateAsync: (input: GitHubCommentTarget & { body: string }) => Promise<unknown>;
  isPending: boolean;
}

/** Who a comment is posted as: the source's mark and a line naming the account. */
export interface CommentAccount {
  icon: ReactNode;
  label: string;
}

export function PullRequestCommentComposer({
  post,
  pending,
  account,
}: {
  /** Posts the comment; the draft clears when it resolves and stays when it fails. */
  post: (body: string) => Promise<unknown>;
  pending: boolean;
  /** Defaults to the person's GitHub account. */
  account?: CommentAccount;
}) {
  const { t } = useTranslation();
  const [body, setBody] = useState("");
  // Synchronous re-entrancy lock: mutation.isPending updates on React's schedule, which is
  // too late to stop a rapid double Enter from posting the comment twice.
  const submittingRef = useRef(false);
  const trimmed = body.trim();
  const canSubmit = trimmed.length > 0 && !pending;

  // Promise chain instead of async/try-catch-finally: React Compiler does not
  // yet support try/finally, and it would skip optimizing this whole component.
  const submit = () => {
    if (!canSubmit || submittingRef.current) return;
    submittingRef.current = true;
    void post(trimmed)
      .then(() => {
        setBody("");
      })
      .catch(() => {
        // The draft stays in the field on failure — nothing to re-type.
        toastManager.add({
          type: "error",
          title: t("codeReview.comment.failed"),
          description: t("codeReview.comment.failedDetail"),
        });
      })
      .finally(() => {
        submittingRef.current = false;
      });
  };

  return (
    <div
      className={`${GLASS_RAISED_SURFACE_CLASS_NAME} flex items-center gap-2 rounded-composer border border-border/60 bg-background py-1 pl-3 pr-1.5 shadow-sm`}
    >
      <span
        className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-background-elevated-secondary)] text-muted-foreground"
        title={account?.label ?? t("codeReview.comment.asAccount")}
      >
        {account?.icon ?? <GitHubIcon className="size-3" />}
      </span>
      <textarea
        rows={Math.min(6, body.split("\n").length)}
        value={body}
        disabled={pending}
        placeholder={t("codeReview.comment.placeholder")}
        aria-label={t("codeReview.comment.placeholder")}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          // Enter during IME composition confirms the composition, not the comment.
          if (event.key === "Enter" && !event.shiftKey && !isImeComposingKeyEvent(event)) {
            event.preventDefault();
            void submit();
          }
        }}
        // font-system-ui overrides the global `textarea { font-family: mono }` reset — this is
        // UI chrome, not code, exactly like the chat composer's editor.
        className={cn(
          PR_BODY_TEXT_CLASS_NAME,
          "font-system-ui min-w-0 flex-1 resize-none bg-transparent py-1.5 outline-none placeholder:text-muted-foreground disabled:opacity-60",
        )}
      />
      <IconButton
        variant="default"
        size="icon-sm"
        shape="capsule"
        disabled={!canSubmit}
        label={t("codeReview.comment.post")}
        tooltip={t("codeReview.comment.post")}
        onClick={() => void submit()}
        className="shrink-0 self-end transition-opacity"
      >
        <ArrowUpIcon className="size-4" />
      </IconButton>
    </div>
  );
}
