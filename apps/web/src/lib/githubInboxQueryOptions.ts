// Query definitions for the GitHub inbox: one list query per state and sort (a superset every filter is
// applied to on the client), the sidebar review badge that shares it, issue detail, the labels and
// people an issue can be given, and the issue comment and update mutations.
import type {
  GitHubInboxListResult,
  GitHubInboxState,
  GitHubInboxSort,
  GitHubIssueCandidatesInput,
  GitHubIssueCommentInput,
  GitHubIssueDetail,
  GitHubIssueDetailInput,
  GitHubIssueUpdateInput,
} from "@moss/contracts";
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";

import { ensureNativeApi } from "~/nativeApi";

export const GITHUB_INBOX_STATES: readonly GitHubInboxState[] = ["open", "closed"];

export const githubInboxQueryKeys = {
  all: ["github-inbox"] as const,
  lists: (state: GitHubInboxState) => ["github-inbox", "list", state] as const,
  list: (state: GitHubInboxState, sort: GitHubInboxSort = "created") =>
    ["github-inbox", "list", state, sort] as const,
  issueDetail: (
    input: Pick<GitHubIssueDetailInput, "projectId" | "repository" | "number"> | null,
  ) =>
    [
      "github-inbox",
      "issue-detail",
      input?.projectId ?? null,
      input?.repository ?? null,
      input?.number ?? null,
    ] as const,
  issueCandidates: (input: GitHubIssueCandidatesInput) =>
    ["github-inbox", "issue-candidates", input.projectId, input.repository] as const,
};

/** Poll while the page is visible; the server snapshot (4 minutes) makes most polls free. */
export const GITHUB_INBOX_POLL_INTERVAL_MS = 5 * 60_000;
/** The sidebar badge keeps the open list warm this often when the inbox is closed. */
export const GITHUB_INBOX_BADGE_POLL_INTERVAL_MS = 15 * 60_000;
/** Pull request and issue detail polling while their pane is visible. */
export const GITHUB_ITEM_DETAIL_POLL_INTERVAL_MS = 2 * 60_000;
export const GITHUB_ITEM_DETAIL_STALE_TIME_MS = 60_000;

function fetchGitHubInboxList(state: GitHubInboxState, sort: GitHubInboxSort) {
  return ensureNativeApi().githubInbox.list({ state, sort });
}

export function githubInboxListQueryOptions(
  state: GitHubInboxState,
  sort: GitHubInboxSort = "created",
) {
  return queryOptions({
    queryKey: githubInboxQueryKeys.list(state, sort),
    queryFn: () => fetchGitHubInboxList(state, sort),
    staleTime: 60_000,
    gcTime: 30 * 60_000,
    refetchInterval: GITHUB_INBOX_POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: "always",
  });
}

export type GitHubReviewRequestBadgeCount = {
  readonly count: number;
  readonly incomplete: boolean;
};

export function selectGitHubReviewRequestBadgeCount(
  result: GitHubInboxListResult,
): GitHubReviewRequestBadgeCount {
  return { count: result.reviewRequestedCount, incomplete: result.reviewRequestedCountIncomplete };
}

/**
 * The sidebar review badge observes the open inbox list rather than a count endpoint. With the
 * inbox open the badge costs nothing extra; with it closed, the list refreshes every 15 minutes.
 */
export function githubInboxReviewBadgeQueryOptions(sort: GitHubInboxSort = "created") {
  return queryOptions({
    queryKey: githubInboxQueryKeys.list("open", sort),
    queryFn: () => fetchGitHubInboxList("open", sort),
    staleTime: GITHUB_INBOX_BADGE_POLL_INTERVAL_MS,
    gcTime: 30 * 60_000,
    refetchInterval: GITHUB_INBOX_BADGE_POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: "always",
    select: selectGitHubReviewRequestBadgeCount,
  });
}

export function githubIssueDetailQueryOptions(
  input: GitHubIssueDetailInput | null,
  behavior: { pollingEnabled?: boolean } = {},
) {
  const pollingEnabled = behavior.pollingEnabled ?? true;
  return queryOptions({
    queryKey: githubInboxQueryKeys.issueDetail(input),
    queryFn: () => {
      if (!input) throw new Error("Issue detail is unavailable.");
      return ensureNativeApi().githubInbox.issueDetail(input);
    },
    enabled: input !== null,
    staleTime: GITHUB_ITEM_DETAIL_STALE_TIME_MS,
    refetchInterval: pollingEnabled ? GITHUB_ITEM_DETAIL_POLL_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: pollingEnabled,
    refetchOnReconnect: pollingEnabled,
  });
}

/** A repository's labels and assignable people change rarely; read them when a picker opens. */
export function githubIssueCandidatesQueryOptions(
  input: GitHubIssueCandidatesInput,
  behavior: { enabled: boolean },
) {
  return queryOptions({
    queryKey: githubInboxQueryKeys.issueCandidates(input),
    queryFn: () => ensureNativeApi().githubInbox.issueCandidates(input),
    enabled: behavior.enabled,
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
  });
}

export const githubInboxMutationKeys = {
  issueComment: ["github-inbox", "issue-comment"] as const,
  issueUpdate: ["github-inbox", "issue-update"] as const,
};

/**
 * One issue change, with how the detail should read once it lands. The preview is shown at once
 * and dropped again if GitHub refuses; the detail is then read fresh either way.
 */
export interface GitHubIssueUpdateVariables {
  readonly input: GitHubIssueUpdateInput;
  readonly preview: Partial<
    Pick<GitHubIssueDetail, "state" | "stateReason" | "labels" | "assignees">
  >;
}

export function githubIssueUpdateMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationKey: githubInboxMutationKeys.issueUpdate,
    networkMode: "always",
    mutationFn: ({ input }: GitHubIssueUpdateVariables) =>
      ensureNativeApi().githubInbox.issueUpdate(input),
    onMutate: async ({ input, preview }: GitHubIssueUpdateVariables) => {
      const queryKey = githubInboxQueryKeys.issueDetail(input);
      await queryClient.cancelQueries({ queryKey, exact: true });
      const previous = queryClient.getQueryData<GitHubIssueDetail>(queryKey);
      if (previous)
        queryClient.setQueryData<GitHubIssueDetail>(queryKey, { ...previous, ...preview });
      return { previous };
    },
    onError: (_error, { input }, context) => {
      if (context?.previous) {
        queryClient.setQueryData(githubInboxQueryKeys.issueDetail(input), context.previous);
      }
    },
    // State, labels, and assignees all show in the list rows, and closing moves the issue
    // between the open and closed lists.
    onSettled: (_result, _error, { input }) =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: githubInboxQueryKeys.issueDetail(input),
          exact: true,
        }),
        ...GITHUB_INBOX_STATES.map((state) =>
          queryClient.invalidateQueries({ queryKey: githubInboxQueryKeys.lists(state) }),
        ),
      ]),
  });
}

export function githubIssueCommentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationKey: githubInboxMutationKeys.issueComment,
    networkMode: "always",
    mutationFn: (input: GitHubIssueCommentInput) =>
      ensureNativeApi().githubInbox.issueComment(input),
    // A comment changes the issue's comment count and `updatedAt`, so both lists may reorder.
    onSettled: (_result, _error, input) =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: githubInboxQueryKeys.issueDetail(input),
          exact: true,
        }),
        ...GITHUB_INBOX_STATES.map((state) =>
          queryClient.invalidateQueries({
            queryKey: githubInboxQueryKeys.lists(state),
          }),
        ),
      ]),
  });
}
