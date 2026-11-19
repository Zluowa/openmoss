// FILE: useExternalIssues.ts
// Purpose: One issue source's part of the code review list: its connected teams or sites less the
//          ones the person hid, the list for the open or closed state, and the issues that match
//          the page's search and labels. Filters that only mean something on GitHub (merged,
//          involvement, projects) leave the source out rather than guess.
// Layer: Issue sources data
// Exports: useExternalIssues, ExternalIssuesView

import type {
  ExternalIssue,
  ExternalIssueListResult,
  ExternalIssueListState,
  ExternalIssueSource,
  ExternalIssueSourceStatus,
} from "@moss/contracts";
import { useQuery } from "@tanstack/react-query";

import { useAppSettings } from "~/appSettings";
import type { GitHubInboxFilters } from "~/components/githubInbox/githubInbox.logic";
import {
  issueSourceListQueryOptions,
  issueSourceStatusQueryOptions,
} from "~/lib/issueSourcesQueryOptions";
import { externalIssueMatches, hiddenTeamKey } from "./issueSources.logic";

export interface ExternalIssuesView {
  readonly source: ExternalIssueSource;
  readonly connected: boolean;
  readonly statusState: ExternalIssueSourceStatus["state"] | null;
  readonly teamIds: ReadonlyArray<string>;
  readonly listState: ExternalIssueListState;
  readonly countable: boolean;
  readonly isPending: boolean;
  readonly error: unknown;
  readonly refetch: () => void;
  /** Counted in the kind tabs whatever tab is open. */
  readonly matching: ReadonlyArray<ExternalIssue>;
  /** Listed only while issues are in view. */
  readonly listed: ReadonlyArray<ExternalIssue>;
  readonly showSection: boolean;
  readonly result: ExternalIssueListResult | undefined;
}

export function useExternalIssues(
  source: ExternalIssueSource,
  filters: GitHubInboxFilters,
  normalizedQuery: string,
): ExternalIssuesView {
  const { settings } = useAppSettings();
  const statusQuery = useQuery(issueSourceStatusQueryOptions(source));
  const statusData = statusQuery.data;
  const statusState = statusData?.state ?? null;
  const connected = statusState === "connected";
  const teamIds =
    statusData?.state === "connected"
      ? statusData.teams
          .map((team) => team.id)
          .filter((id) => !settings.issueSourceHiddenTeams.includes(hiddenTeamKey(source, id)))
      : [];
  const listState: ExternalIssueListState = filters.state === "closed" ? "closed" : "open";
  const countable =
    teamIds.length > 0 &&
    filters.state !== "merged" &&
    filters.involvement === "everything" &&
    filters.projectIds.length === 0;
  const applies = countable && filters.kind !== "pullRequest";
  const listQuery = useQuery(
    issueSourceListQueryOptions(source, listState, teamIds, {
      enabled: countable,
    }),
  );
  const matching = countable
    ? (listQuery.data?.items ?? []).filter(
        (issue) =>
          externalIssueMatches(issue, normalizedQuery) &&
          (filters.labels.length === 0 ||
            issue.labels.some((label) =>
              filters.labels.some((name) => name.toLowerCase() === label.name.toLowerCase()),
            )),
      )
    : [];
  return {
    source,
    connected,
    statusState,
    teamIds,
    listState,
    countable,
    isPending: countable && listQuery.isPending,
    error: listQuery.isError ? listQuery.error : null,
    refetch: () => void listQuery.refetch(),
    matching,
    listed: applies ? matching : [],
    showSection: applies && (listQuery.data !== undefined || listQuery.isError),
    result: listQuery.data,
  };
}
