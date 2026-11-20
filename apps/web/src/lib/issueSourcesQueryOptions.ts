// FILE: issueSourcesQueryOptions.ts
// Purpose: Query definitions for the issue sources beside GitHub on the code review page (Linear,
//          Jira): whether a source is connected and its teams or sites, the issue list per state,
//          an issue's detail, the states, labels and people an issue offers, and the update and
//          comment mutations. Every key starts with the source, so the two never share a cache.
// Layer: Web data
// Exports: issueSourcesQueryKeys, issueSourceStatusQueryOptions, issueSourceListQueryOptions,
//          issueSourceDetailQueryOptions, issueSourceCandidatesQueryOptions,
//          issueSourceUpdateMutationOptions, issueSourceCommentMutationOptions,
//          issueSourcesForceRefreshMutationOptions, ExternalIssueUpdateVariables,
//          ExternalIssueForceRefreshTarget

import type {
  ExternalIssueCandidatesInput,
  ExternalIssueCommentInput,
  ExternalIssueDetail,
  ExternalIssueListState,
  ExternalIssueSource,
  ExternalIssueUpdateInput,
} from "@moss/contracts";
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";

import { ensureNativeApi } from "~/nativeApi";

export const issueSourcesQueryKeys = {
  all: ["issue-sources"] as const,
  source: (source: ExternalIssueSource) => ["issue-sources", source] as const,
  status: (source: ExternalIssueSource) => ["issue-sources", source, "status"] as const,
  lists: (source: ExternalIssueSource) => ["issue-sources", source, "list"] as const,
  list: (
    source: ExternalIssueSource,
    state: ExternalIssueListState,
    teamIds: ReadonlyArray<string>,
  ) => ["issue-sources", source, "list", state, [...teamIds].toSorted().join(",")] as const,
  detail: (source: ExternalIssueSource, id: string | null) =>
    ["issue-sources", source, "detail", id] as const,
  candidates: (source: ExternalIssueSource, teamId: string, issueId: string | null) =>
    ["issue-sources", source, "candidates", teamId, issueId] as const,
};

/** Each read costs one MCP session; poll gently, like GitHub detail. */
const LIST_POLL_INTERVAL_MS = 5 * 60_000;
const DETAIL_POLL_INTERVAL_MS = 2 * 60_000;

export function issueSourceStatusQueryOptions(source: ExternalIssueSource) {
  return queryOptions({
    queryKey: issueSourcesQueryKeys.status(source),
    queryFn: () => ensureNativeApi().issueSources.status({ source }),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

export function issueSourceListQueryOptions(
  source: ExternalIssueSource,
  state: ExternalIssueListState,
  teamIds: ReadonlyArray<string>,
  behavior: { enabled: boolean },
) {
  return queryOptions({
    queryKey: issueSourcesQueryKeys.list(source, state, teamIds),
    queryFn: () => ensureNativeApi().issueSources.list({ source, teamIds: [...teamIds], state }),
    enabled: behavior.enabled && teamIds.length > 0,
    staleTime: 60_000,
    gcTime: 30 * 60_000,
    refetchInterval: LIST_POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}

export function issueSourceDetailQueryOptions(source: ExternalIssueSource, id: string | null) {
  return queryOptions({
    queryKey: issueSourcesQueryKeys.detail(source, id),
    queryFn: () => {
      if (!id) throw new Error("No issue is selected.");
      return ensureNativeApi().issueSources.detail({ source, id });
    },
    enabled: id !== null,
    staleTime: 60_000,
    refetchInterval: DETAIL_POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });
}

export function issueSourceCandidatesQueryOptions(
  input: ExternalIssueCandidatesInput,
  behavior: { enabled: boolean },
) {
  return queryOptions({
    // Linear's choices belong to the team; Jira's states depend on the issue's own transitions.
    queryKey: issueSourcesQueryKeys.candidates(
      input.source,
      input.teamId,
      input.source === "jira" ? (input.issueId ?? null) : null,
    ),
    queryFn: () => ensureNativeApi().issueSources.candidates(input),
    enabled: behavior.enabled,
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
  });
}

/** One change, with how the detail should read once it lands (shown at once, undone on failure). */
export interface ExternalIssueUpdateVariables {
  readonly input: ExternalIssueUpdateInput;
  readonly preview: Partial<Pick<ExternalIssueDetail, "state" | "labels" | "assignee">>;
}

const refreshAfterWrite = (queryClient: QueryClient, source: ExternalIssueSource, id: string) =>
  Promise.all([
    queryClient.invalidateQueries({
      queryKey: issueSourcesQueryKeys.detail(source, id),
      exact: true,
    }),
    queryClient.invalidateQueries({ queryKey: issueSourcesQueryKeys.lists(source) }),
    // A Jira state change alters which transitions the issue offers next.
    queryClient.invalidateQueries({
      queryKey: [...issueSourcesQueryKeys.source(source), "candidates"],
    }),
  ]);

export function issueSourceUpdateMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationKey: ["issue-sources", "update"] as const,
    networkMode: "always",
    mutationFn: ({ input }: ExternalIssueUpdateVariables) =>
      ensureNativeApi().issueSources.update(input),
    onMutate: async ({ input, preview }: ExternalIssueUpdateVariables) => {
      const queryKey = issueSourcesQueryKeys.detail(input.source, input.id);
      await queryClient.cancelQueries({ queryKey, exact: true });
      const previous = queryClient.getQueryData<ExternalIssueDetail>(queryKey);
      if (previous)
        queryClient.setQueryData<ExternalIssueDetail>(queryKey, { ...previous, ...preview });
      return { previous };
    },
    onError: (_error, { input }, context) => {
      if (context?.previous) {
        queryClient.setQueryData(
          issueSourcesQueryKeys.detail(input.source, input.id),
          context.previous,
        );
      }
    },
    onSettled: (_result, _error, { input }) =>
      refreshAfterWrite(queryClient, input.source, input.id),
  });
}

export function issueSourceCommentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationKey: ["issue-sources", "comment"] as const,
    networkMode: "always",
    mutationFn: (input: ExternalIssueCommentInput) => ensureNativeApi().issueSources.comment(input),
    onSettled: (_result, _error, input) => refreshAfterWrite(queryClient, input.source, input.id),
  });
}

export interface ExternalIssueForceRefreshTarget {
  readonly source: ExternalIssueSource;
  readonly state: ExternalIssueListState;
  readonly teamIds: ReadonlyArray<string>;
}

/**
 * Forces a fresh read for every active external source, bypassing the 60s server list cache and
 * replacing the matching TanStack Query cache entry in place.
 */
export function issueSourcesForceRefreshMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationKey: ["issue-sources", "force-refresh"] as const,
    networkMode: "always",
    mutationFn: async (targets: ReadonlyArray<ExternalIssueForceRefreshTarget>) => {
      const outcomes = await Promise.allSettled(
        targets.map(async (target) => {
          const queryKey = issueSourcesQueryKeys.list(target.source, target.state, target.teamIds);
          await queryClient.cancelQueries({ queryKey, exact: true });
          const result = await ensureNativeApi().issueSources.list({
            source: target.source,
            teamIds: [...target.teamIds],
            state: target.state,
            forceRefresh: true,
          });
          queryClient.setQueryData(queryKey, result);
          return result;
        }),
      );
      const rejected = outcomes.find(
        (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
      );
      if (rejected) throw rejected.reason;
      return outcomes.length;
    },
  });
}
