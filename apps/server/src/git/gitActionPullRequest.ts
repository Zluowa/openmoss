// FILE: gitActionPullRequest.ts
// Purpose: Convert successful GitHub actions to durable thread-link observations.
// Layer: Server git helpers
// Exports: pullRequestFromGitActionResult, refreshReopenedThreadPullRequest

import {
  CommandId,
  type GitRunStackedActionResult,
  type OrchestrationCommand,
  type OrchestrationThreadPullRequest,
  type OrchestrationThreadShell,
} from "@moss/contracts";
import { findPullRequestLink, isPullRequestLinkVisible } from "@moss/shared/threadPullRequestLinks";
import { Effect } from "effect";

export function pullRequestFromGitActionResult(
  result: GitRunStackedActionResult,
): OrchestrationThreadPullRequest | null {
  const pr = result.pr;
  if (pr.status !== "created" && pr.status !== "opened_existing") return null;
  if (!pr.number || !pr.url || !pr.title || !pr.baseBranch || !pr.headBranch) return null;
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    baseBranch: pr.baseBranch,
    headBranch: pr.headBranch,
    state: "open",
  };
}

/**
 * What a successful git action records on its thread. A PR the action created (or opened)
 * becomes a `created` link, which an unlink still wins over. A push to a branch that already
 * has an open PR is only a branch observation (Moss; upstream links it as `user`): it becomes
 * the branch-managed link, so it never revives a PR the person unlinked and is dropped when
 * the thread's branch moves on, like any discovered PR.
 */
export function gitActionPullRequestCommands(input: {
  readonly threadId: OrchestrationThreadShell["id"];
  readonly result: GitRunStackedActionResult;
  /** The open PR of the pushed branch, from a status refresh after the action. */
  readonly branchPullRequest: OrchestrationThreadPullRequest | null;
  readonly commandId: () => CommandId;
}): OrchestrationCommand[] {
  const created = pullRequestFromGitActionResult(input.result);
  if (created) {
    return [
      {
        type: "thread.pull-request.link",
        commandId: input.commandId(),
        threadId: input.threadId,
        pullRequest: created,
        source: "created",
      },
    ];
  }
  if (input.result.push.status === "pushed" && input.branchPullRequest?.state === "open") {
    return [
      {
        type: "thread.pull-request.sync",
        commandId: input.commandId(),
        threadId: input.threadId,
        discovered: input.branchPullRequest,
      },
    ];
  }
  return [];
}

/** A successful reopen refreshes an existing link. The serialized sync also honors later unlinks. */
export function refreshReopenedThreadPullRequest<A, E, R>(input: {
  thread: Pick<OrchestrationThreadShell, "id" | "pullRequests">;
  repository: string;
  number: number;
  dispatch: (command: OrchestrationCommand) => Effect.Effect<A, E, R>;
}): Effect.Effect<void, E, R> {
  const url = `https://github.com/${input.repository}/pull/${input.number}`;
  const link = findPullRequestLink(input.thread.pullRequests, url);
  if (link === null || !isPullRequestLinkVisible(link) || link.pullRequest.state !== "closed") {
    return Effect.void;
  }
  return input
    .dispatch({
      type: "thread.pull-request.sync",
      commandId: CommandId.makeUnsafe(`server:pr-reopen:${crypto.randomUUID()}`),
      threadId: input.thread.id,
      snapshots: [{ ...link.pullRequest, state: "open" }],
    })
    .pipe(Effect.asVoid);
}
