// FILE: _chat.pull-requests.index.tsx
// Purpose: The Inbox route (`/pull-requests`, kept so links and persisted nav state survive):
//          validates the URL, owns the route shell and header, and hands the page body to
//          GitHubInbox. The shell is a flex row: the Ask side chat docks beside the inset.
// Layer: Route

import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { GitHubConnectionGate } from "~/components/githubInbox/GitHubConnectionGate";
import { GitHubInbox } from "~/components/githubInbox/GitHubInbox";
import { GitHubInboxShell } from "~/components/githubInbox/GitHubInboxShell";
import { GitHubInboxSidechatDock } from "~/components/githubInbox/GitHubInboxSidechatDock";
import {
  githubInboxSelection,
  mergeGitHubInboxSearch,
  parseGitHubInboxSearch,
  type GitHubInboxSearch,
  type GitHubInboxSearchPatch,
} from "~/components/githubInbox/githubInbox.logic";
import { useGitHubInboxSidechat } from "~/components/githubInbox/useGitHubInboxSidechat";
import { issueSourceStatusQueryOptions } from "~/lib/issueSourcesQueryOptions";

export const Route = createFileRoute("/_chat/pull-requests/")({
  validateSearch: (raw: Record<string, unknown>): GitHubInboxSearch => parseGitHubInboxSearch(raw),
  component: GitHubInboxRouteView,
});

function GitHubInboxRouteView() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const updateSearch = (patch: GitHubInboxSearchPatch) =>
    void navigate({
      search: (previous) => mergeGitHubInboxSearch(previous, patch),
      replace: true,
    });
  const selection = githubInboxSelection(search);
  const sidechat = useGitHubInboxSidechat(selection);
  const linearStatus = useQuery(issueSourceStatusQueryOptions("linear"));
  const jiraStatus = useQuery(issueSourceStatusQueryOptions("jira"));
  const hasConnectedIssueSource =
    linearStatus.data?.state === "connected" || jiraStatus.data?.state === "connected";

  return (
    <GitHubConnectionGate allowChildrenWhenDisconnected={hasConnectedIssueSource}>
      {({ githubUnavailable, githubNotice }) => (
        <GitHubInboxShell
          aside={
            selection ? (
              <GitHubInboxSidechatDock
                dockState={sidechat.dockState}
                selection={selection}
                onAskSelected={sidechat.askSelected}
                onNewSidechat={sidechat.newSidechat}
              />
            ) : null
          }
        >
          <GitHubInbox
            search={search}
            onSearchChange={updateSearch}
            sidechat={sidechat}
            dockOpen={selection !== null && sidechat.dockState.open}
            githubUnavailable={githubUnavailable}
            githubConnectionNotice={githubNotice}
          />
        </GitHubInboxShell>
      )}
    </GitHubConnectionGate>
  );
}
