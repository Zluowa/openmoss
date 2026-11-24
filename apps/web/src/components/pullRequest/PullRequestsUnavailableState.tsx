// FILE: PullRequestsUnavailableState.tsx
// Purpose: Actionable empty state for the pull requests surface when the GitHub CLI is missing,
//          unauthenticated, rate-limited, or a request otherwise failed — each case gets a short
//          explanation and a copyable terminal command or reset time instead of a dead end.
// Layer: Pull request presentation
// Exports: PullRequestsUnavailableState, isPullRequestsUnavailableError, issueSourceErrorReason

import { HitArea } from "~/components/ui/hit-area";
import { useEffect, useRef, useState } from "react";

import { useAppSettings } from "~/appSettings";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "~/components/ui/empty";
import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import { CheckIcon, CopyIcon, TriangleAlertIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";
import { ensureNativeApi } from "~/nativeApi";
import { formatShortTimestamp } from "~/timestampFormat";
import { PR_FINE_TEXT_CLASS_NAME, PR_META_TEXT_CLASS_NAME } from "./pullRequestText";

export function isPullRequestsUnavailableError(error: unknown): error is {
  _tag: "PullRequestsUnavailableError";
  reason: string;
  message: string;
  retryAt?: string;
} {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "PullRequestsUnavailableError"
  );
}

function githubCliInstallCommand(platform: string): string | null {
  if (/mac/i.test(platform)) return "brew install gh";
  if (/win/i.test(platform)) return "winget install --id GitHub.cli";
  return null;
}

/** A single copyable terminal command — the `brew install gh` / `gh auth login` affordances. */
function CommandLine({ command }: { command: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const mountedRef = useRef(true);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    };
  }, []);

  return (
    <HitArea
      type="button"
      onClick={() => {
        void copyTextToClipboard(command).then(
          () => {
            if (!mountedRef.current) return;
            setCopied(true);
            if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
            resetTimerRef.current = window.setTimeout(() => {
              resetTimerRef.current = null;
              setCopied(false);
            }, 1500);
          },
          () => {
            if (!mountedRef.current) return;
            toastManager.add({
              type: "error",
              title: t("codeReview.copy.failed"),
              description: t("codeReview.copy.failedDetail"),
            });
          },
        );
      }}
      className="group flex w-full items-center gap-2 rounded-row border border-border/60 bg-[var(--color-background-elevated-secondary)] px-3 py-2 text-left transition-colors hover:border-border"
    >
      <code
        className={cn(PR_META_TEXT_CLASS_NAME, "min-w-0 flex-1 truncate font-mono text-foreground")}
      >
        {command}
      </code>
      <span
        className={cn(
          PR_FINE_TEXT_CLASS_NAME,
          "flex shrink-0 items-center gap-1 text-muted-foreground transition-colors group-hover:text-foreground",
          copied && "text-success",
        )}
      >
        {copied ? (
          <>
            <CheckIcon className="size-3" /> {t("codeReview.copied")}
          </>
        ) : (
          <>
            <CopyIcon className="size-3" /> {t("codeReview.copy")}
          </>
        )}
      </span>
    </HitArea>
  );
}

export type IssueSourceFailureReason = "not-connected" | "failed" | "unreadable";

/** Extracts `issue-source-<reason>` from a WsRpcError (directly or on `.cause`). */
export function issueSourceErrorReason(error: unknown): IssueSourceFailureReason | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const code = "code" in current && typeof current.code === "string" ? current.code : null;
    if (code === "issue-source-not-connected") return "not-connected";
    if (code === "issue-source-failed") return "failed";
    if (code === "issue-source-unreadable") return "unreadable";
    current = "cause" in current ? current.cause : null;
  }
  return null;
}

export function PullRequestsUnavailableState({
  error,
  onRetry,
  subject: subjectProp,
  sourceName,
}: {
  error: unknown;
  /** Optional refetch hook so "Retry" re-runs the failed query instead of reloading the app. */
  onRetry?: () => void;
  /** What failed to load, as a plural noun for the title ("Pull requests are unavailable"). */
  subject?: string;
  /** External issue source name ("Linear", "Jira") so failures never blame GitHub. */
  sourceName?: string;
}) {
  const { t, format } = useTranslation();
  const subject = subjectProp ?? t("codeReview.kind.pullRequest");
  const { settings } = useAppSettings();
  const unavailable = isPullRequestsUnavailableError(error) ? error : null;
  const sourceReason = issueSourceErrorReason(error);
  const isExternalSource = sourceName !== undefined || sourceReason !== null;
  const notInstalled = unavailable?.reason === "gh-not-installed";
  const notAuthenticated = unavailable?.reason === "gh-not-authenticated";
  const rateLimited = unavailable?.reason === "rate-limited";
  const resetTime =
    rateLimited && unavailable?.retryAt
      ? formatShortTimestamp(unavailable.retryAt, settings.timestampFormat)
      : null;
  const installCommand =
    notInstalled && typeof navigator !== "undefined"
      ? githubCliInstallCommand(navigator.platform)
      : null;

  return (
    <Empty className="py-16">
      <EmptyHeader>
        <EmptyTitle>
          {notInstalled
            ? t("codeReview.gh.required")
            : notAuthenticated
              ? t("codeReview.gh.signIn")
              : rateLimited
                ? t("codeReview.rateLimit.title")
                : sourceReason === "not-connected"
                  ? sourceName
                    ? format("issueSources.unavailable.notConnectedTitle", { source: sourceName })
                    : t("issueSources.unavailable.notConnectedTitleGeneric")
                  : format("codeReview.unavailable.title", { subject })}
        </EmptyTitle>
        <EmptyDescription>
          {notInstalled
            ? t("codeReview.gh.requiredHint")
            : notAuthenticated
              ? t("codeReview.gh.signInHint")
              : rateLimited
                ? resetTime
                  ? format("codeReview.rateLimit.pausedAt", { time: resetTime })
                  : t("codeReview.rateLimit.paused")
                : sourceReason === "not-connected"
                  ? sourceName
                    ? format("issueSources.unavailable.notConnectedHint", { source: sourceName })
                    : t("issueSources.unavailable.notConnectedHintGeneric")
                  : sourceReason === "unreadable"
                    ? sourceName
                      ? format("issueSources.unavailable.unreadable", { source: sourceName })
                      : t("issueSources.unavailable.unreadableGeneric")
                    : isExternalSource
                      ? sourceName
                        ? format("issueSources.unavailable.failed", { source: sourceName })
                        : t("issueSources.unavailable.failedGeneric")
                      : t("codeReview.unavailable.failed")}
        </EmptyDescription>
      </EmptyHeader>
      {notInstalled || notAuthenticated ? (
        <EmptyContent>
          {notAuthenticated ? <CommandLine command="gh auth login" /> : null}
          {installCommand ? <CommandLine command={installCommand} /> : null}
          <div className="flex w-full items-center gap-2">
            {notInstalled ? (
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={() => void ensureNativeApi().shell.openExternal("https://cli.github.com/")}
              >
                {t("codeReview.gh.install")}
              </Button>
            ) : null}
            {onRetry ? (
              <Button
                variant={notInstalled ? "ghost" : "outline"}
                size="sm"
                className="flex-1"
                onClick={onRetry}
              >
                {t("codeReview.retry")}
              </Button>
            ) : null}
          </div>
        </EmptyContent>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <div
            className={cn(
              PR_META_TEXT_CLASS_NAME,
              "flex items-center gap-1.5 text-muted-foreground",
            )}
          >
            <TriangleAlertIcon className="size-4" />
            <span>
              {rateLimited
                ? t("codeReview.rateLimit.autoRefresh")
                : sourceReason === "not-connected"
                  ? t("issueSources.unavailable.checkSettings")
                  : t("codeReview.checkConnection")}
            </span>
          </div>
          {onRetry ? (
            <Button variant="outline" size="sm" onClick={onRetry}>
              {t("codeReview.retry")}
            </Button>
          ) : null}
        </div>
      )}
    </Empty>
  );
}
