// FILE: GitHubIssueDetailPanel.tsx
// Purpose: The inbox detail pane for an issue, in the same page shell as a pull request: a top
//          bar (Summary and Timeline tabs; pin, copy link, open on GitHub, Send to agent), the
//          shared GitHubItemHeader, the description and comments (with the comment composer) on
//          the left, and Assignees, Labels, and Comments in the info column (rows under the
//          header in a narrow pane). The question composer floats over the bottom and feeds the
//          issue's side chat. When GitHub lets the viewer update the issue, the top bar closes or
//          reopens it and the Assignees and Labels rows open their pickers; the info also lists
//          the pull requests linked to the issue.
// Layer: GitHub inbox presentation
// Exports: GitHubIssueDetailPanel

import type { GitHubIssueDetail, GitHubIssueDetailInput, GitHubIssueUpdate } from "@moss/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { createGitHubItemContextDraft } from "~/components/chat/environment/environmentPullRequest.logic";
import {
  GitHubItemAgentActions,
  type GitHubItemSendTarget,
} from "~/components/pullRequest/GitHubItemAgentActions";
import { GitHubItemHeader } from "~/components/pullRequest/GitHubItemHeader";
import { IssueInfo } from "~/components/pullRequest/GitHubItemInfo";
import {
  DETACHED_GITHUB_ITEM_PAGE_HOST,
  GitHubItemAskComposer,
  GitHubItemDetailPage,
  GitHubItemPageBody,
  GitHubItemPageIconActions,
  GitHubItemTabBody,
  GitHubItemTabs,
  type GitHubItemPageHost,
} from "~/components/pullRequest/GitHubItemPageLayout";
import {
  githubItemCardSourceFromIssue,
  type GitHubItemAgentTarget,
} from "~/components/pullRequest/githubItemAgentContext";
import { IssueStateGlyph } from "~/components/pullRequest/PullRequestStateGlyph";
import {
  GitHubItemComments,
  GitHubItemPageSummary,
} from "~/components/pullRequest/PullRequestSummaryTab";
import { PullRequestTimelineTab } from "~/components/pullRequest/PullRequestTimelineTab";
import { PullRequestWarningNote } from "~/components/pullRequest/PullRequestWarningNote";
import { useStartGitHubItemThread } from "~/hooks/useStartGitHubItemThread";
import { toastManager } from "~/components/ui/toast";
import {
  githubIssueCommentMutationOptions,
  githubIssueDetailQueryOptions,
  githubIssueUpdateMutationOptions,
  type GitHubIssueUpdateVariables,
} from "~/lib/githubInboxQueryOptions";
import { pullRequestQueryErrorState } from "~/lib/pullRequestReactQuery";
import { useTranslation, type TranslationKey } from "~/localization";
import {
  GitHubIssueAssigneePicker,
  GitHubIssueLabelPicker,
  GitHubIssueLinkedPullRequests,
  GitHubIssueEditHint,
  GitHubIssueStateAction,
  type GitHubIssueStateChange,
} from "./GitHubIssueEditors";

type IssueTab = "summary" | "timeline";

const ISSUE_TABS: ReadonlyArray<{ value: IssueTab; label: TranslationKey }> = [
  { value: "summary", label: "codeReview.tab.summary" },
  { value: "timeline", label: "codeReview.tab.timeline" },
];

const UPDATE_ERROR_KEYS: Record<GitHubIssueUpdate["op"], TranslationKey> = {
  close: "githubIssue.error.state",
  reopen: "githubIssue.error.state",
  setLabels: "githubIssue.error.labels",
  setAssignees: "githubIssue.error.assignees",
};

/** How the detail reads once a state change lands, shown before GitHub answers. */
function stateChangePreview(change: GitHubIssueStateChange): GitHubIssueUpdateVariables["preview"] {
  return change.op === "reopen"
    ? { state: "open", stateReason: null }
    : { state: "closed", stateReason: change.reason };
}

export function GitHubIssueDetailPanel({
  input,
  onBack,
  onSelectPullRequest,
  pollingEnabled: pollingEnabledProp,
  sendTargets: sendTargetsProp,
  pageHost,
}: {
  input: GitHubIssueDetailInput;
  /** Narrow windows show the detail in place of the list; this returns to it. */
  onBack?: () => void;
  /** Opens a pull request of the same repository on the code review page. */
  onSelectPullRequest?: (number: number) => void;
  pollingEnabled?: boolean;
  /** Projects Send to agent may open the thread in. Defaults to the issue's project. */
  sendTargets?: ReadonlyArray<GitHubItemSendTarget>;
  /** Pin, side chat threads, and the floating composer, from the code review page. */
  pageHost?: GitHubItemPageHost;
}) {
  const pollingEnabled = pollingEnabledProp ?? true;
  // The page remounts the panel per issue, so the tab starts on Summary for each one.
  const [tab, setTab] = useState<IssueTab>("summary");
  const queryClient = useQueryClient();
  const detailQuery = useQuery(githubIssueDetailQueryOptions(input, { pollingEnabled }));
  const commentMutation = useMutation(githubIssueCommentMutationOptions(queryClient));
  const updateMutation = useMutation(githubIssueUpdateMutationOptions(queryClient));
  const { t, format } = useTranslation();
  const detail = detailQuery.data;
  const canUpdate = detail?.viewerCanUpdate === true;
  const updatePending = updateMutation.isPending;
  const runUpdate = (
    current: GitHubIssueDetail,
    update: GitHubIssueUpdate,
    preview: GitHubIssueUpdateVariables["preview"],
  ) => {
    updateMutation.mutate(
      {
        input: {
          projectId: current.projectId,
          repository: current.repository,
          number: current.number,
          update,
        },
        preview,
      },
      {
        onSuccess: () => {
          if (update.op === "close" || update.op === "reopen") {
            toastManager.add({
              type: "success",
              title: t(
                update.op === "close" ? "githubIssue.state.closed" : "githubIssue.state.reopened",
              ),
            });
          }
        },
        onError: () => {
          toastManager.add({ type: "error", title: t(UPDATE_ERROR_KEYS[update.op]) });
        },
      },
    );
  };
  const { initialError, backgroundError } = pullRequestQueryErrorState(detailQuery);
  const { start: startItemThread, pendingAction } = useStartGitHubItemThread({
    workspaceRoot: detail?.workspaceRoot ?? null,
  });
  const sendTargets: ReadonlyArray<GitHubItemSendTarget> =
    sendTargetsProp && sendTargetsProp.length > 0
      ? sendTargetsProp
      : detail
        ? [{ projectId: detail.projectId, projectTitle: detail.projectTitle }]
        : [];
  const sendToAgent = (projectId: GitHubItemSendTarget["projectId"]) => {
    if (!detail) return;
    const source = githubItemCardSourceFromIssue(detail);
    startItemThread({
      action: "send",
      projectId,
      card: (environment) => createGitHubItemContextDraft(source, environment),
      errorTitle: t("githubIssue.sendFailed"),
    });
  };

  const host = pageHost ?? DETACHED_GITHUB_ITEM_PAGE_HOST;
  const target = (projectId: GitHubItemSendTarget["projectId"]): GitHubItemAgentTarget => ({
    projectId,
    source: githubItemCardSourceFromIssue(detail!),
  });
  const composer = detail ? (
    <GitHubItemAskComposer
      noun="issue"
      defaultProjectId={detail.projectId}
      sendTargets={sendTargets}
      buildTarget={target}
      host={host}
      onSendToAgent={sendToAgent}
    />
  ) : null;

  return (
    <GitHubItemDetailPage
      onBack={onBack}
      tabs={
        <GitHubItemTabs
          label={t("githubIssue.tabs")}
          tabs={ISSUE_TABS.map((option) => ({ value: option.value, label: t(option.label) }))}
          value={tab}
          onChange={setTab}
        />
      }
      actions={
        detail ? (
          <>
            <GitHubItemPageIconActions
              url={detail.url}
              itemLabel={format("codeReview.item.issue", { number: detail.number })}
              pin={host.pin}
            />
            {canUpdate ? (
              <GitHubIssueStateAction
                state={detail.state}
                pending={updatePending}
                onChange={(change) => runUpdate(detail, change, stateChangePreview(change))}
              />
            ) : null}
            <GitHubItemAgentActions
              sendTargets={sendTargets}
              sending={pendingAction === "send"}
              onSendToAgent={sendToAgent}
            />
          </>
        ) : null
      }
      query={{
        isPending: detailQuery.isPending,
        initialError,
        subject: t("codeReview.kind.issue"),
        onRetry: () => void detailQuery.refetch(),
        loaded: detail !== undefined,
      }}
      notFound={{
        title: t("githubIssue.notFound"),
        description: t("githubIssue.notFoundHint"),
      }}
      banners={
        backgroundError ? (
          <PullRequestWarningNote shape="banner" role="status">
            {t("githubIssue.refreshFailed")}
          </PullRequestWarningNote>
        ) : null
      }
    >
      {!detail ? null : tab === "summary" ? (
        <GitHubItemPageBody
          header={<GitHubItemHeader item={{ kind: "issue", ...detail }} />}
          info={(variant) => (
            <IssueInfo
              detail={detail}
              variant={variant}
              threads={host.threads}
              onOpenThread={host.onOpenThread}
              {...(canUpdate
                ? {
                    editors: {
                      hint: <GitHubIssueEditHint />,
                      assignees: (row) => (
                        <GitHubIssueAssigneePicker
                          candidatesInput={{
                            projectId: detail.projectId,
                            repository: detail.repository,
                          }}
                          assignees={detail.assignees}
                          disabled={updatePending}
                          onSave={(assignees) =>
                            runUpdate(
                              detail,
                              {
                                op: "setAssignees",
                                assignees: assignees.map((actor) => actor.login),
                              },
                              { assignees },
                            )
                          }
                        >
                          {row}
                        </GitHubIssueAssigneePicker>
                      ),
                      labels: (row) => (
                        <GitHubIssueLabelPicker
                          candidatesInput={{
                            projectId: detail.projectId,
                            repository: detail.repository,
                          }}
                          labels={detail.labels}
                          disabled={updatePending}
                          onSave={(labels) =>
                            runUpdate(
                              detail,
                              { op: "setLabels", labels: labels.map((label) => label.name) },
                              { labels },
                            )
                          }
                        >
                          {row}
                        </GitHubIssueLabelPicker>
                      ),
                    },
                  }
                : {})}
              linkedPullRequests={{
                label: t("githubIssue.linked.title"),
                content: (
                  <GitHubIssueLinkedPullRequests
                    repository={detail.repository}
                    pullRequests={detail.linkedPullRequests}
                    onSelectPullRequest={onSelectPullRequest}
                  />
                ),
              }}
            />
          )}
          composer={composer}
        >
          <GitHubItemPageSummary
            body={detail.body}
            workspaceRoot={detail.workspaceRoot}
            commentCount={detail.commentCount}
          >
            <GitHubItemComments
              comments={detail.comments}
              itemUrl={detail.url}
              workspaceRoot={detail.workspaceRoot}
              warning={detail.commentsTruncated ? t("githubIssue.commentsTruncated") : null}
              target={detail}
              mutation={commentMutation}
            />
          </GitHubItemPageSummary>
        </GitHubItemPageBody>
      ) : (
        <GitHubItemTabBody
          glyph={<IssueStateGlyph state={detail.state} stateReason={detail.stateReason} />}
          title={detail.title}
          composer={composer}
        >
          <PullRequestTimelineTab detail={detail} noun="issue" />
        </GitHubItemTabBody>
      )}
    </GitHubItemDetailPage>
  );
}
