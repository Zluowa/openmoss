import {
  CommandId,
  ThreadId,
  type GitRunStackedActionResult,
  type OrchestrationThreadPullRequest,
  type OrchestrationThreadPullRequestLink,
} from "@moss/contracts";
import {
  linkPullRequest,
  syncDiscoveredPullRequest,
  visiblePullRequestLinks,
} from "@moss/shared/threadPullRequestLinks";
import { describe, expect, it } from "vitest";

import { gitActionPullRequestCommands } from "./gitActionPullRequest.ts";

const threadId = ThreadId.makeUnsafe("thread-git-action");
const pr = (number: number): OrchestrationThreadPullRequest => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/acme/app/pull/${number}`,
  baseBranch: "main",
  headBranch: `feat/${number}`,
  state: "open",
});
const result = (input: {
  readonly pushed: boolean;
  readonly created?: OrchestrationThreadPullRequest;
}): GitRunStackedActionResult =>
  ({
    push: { status: input.pushed ? "pushed" : "skipped_not_requested" },
    pr: input.created
      ? { status: "created", ...input.created }
      : { status: "skipped_not_requested" },
  }) as unknown as GitRunStackedActionResult;
const commandId = () => CommandId.makeUnsafe("cmd-git-action");

describe("gitActionPullRequestCommands", () => {
  it("links a PR the action created", () => {
    expect(
      gitActionPullRequestCommands({
        threadId,
        result: result({ pushed: true, created: pr(7) }),
        branchPullRequest: pr(7),
        commandId,
      }),
    ).toMatchObject([{ type: "thread.pull-request.link", pullRequest: pr(7), source: "created" }]);
  });

  it("records a push to a branch's open PR as a branch observation, not a person's link", () => {
    const commands = gitActionPullRequestCommands({
      threadId,
      result: result({ pushed: true }),
      branchPullRequest: pr(5),
      commandId,
    });
    expect(commands).toEqual([
      { type: "thread.pull-request.sync", commandId: commandId(), threadId, discovered: pr(5) },
    ]);

    // The person unlinked #5; the push observes it again and it stays unlinked.
    const unlinked: OrchestrationThreadPullRequestLink[] = [
      {
        pullRequest: pr(5),
        source: "user",
        linkedAt: "2026-11-18T09:00:00.000Z",
        dismissedAt: "2026-11-18T09:30:00.000Z",
      },
    ];
    const afterPush = syncDiscoveredPullRequest(unlinked, pr(5), "2026-11-18T10:00:00.000Z");
    expect(visiblePullRequestLinks(afterPush)).toEqual([]);

    // Pushed into a thread without that link, it follows the branch: another branch's PR
    // replaces it instead of piling up permanent links.
    const pushed = syncDiscoveredPullRequest([], pr(5), "2026-11-18T10:00:00.000Z");
    const moved = syncDiscoveredPullRequest(pushed, pr(6), "2026-11-18T11:00:00.000Z");
    expect(visiblePullRequestLinks(moved).map((link) => link.pullRequest.number)).toEqual([6]);
    // A person's link, by contrast, stays through branch moves.
    const linked = linkPullRequest([], {
      pullRequest: pr(5),
      source: "user",
      linkedAt: "2026-11-18T10:00:00.000Z",
    });
    expect(
      visiblePullRequestLinks(syncDiscoveredPullRequest(linked, pr(6), "2026-11-18T11:00:00.000Z"))
        .map((link) => link.pullRequest.number)
        .toSorted(),
    ).toEqual([5, 6]);
  });

  it("records nothing for a push without an open PR or an action that did not push", () => {
    expect(
      gitActionPullRequestCommands({
        threadId,
        result: result({ pushed: true }),
        branchPullRequest: { ...pr(5), state: "merged" },
        commandId,
      }),
    ).toEqual([]);
    expect(
      gitActionPullRequestCommands({
        threadId,
        result: result({ pushed: false }),
        branchPullRequest: pr(5),
        commandId,
      }),
    ).toEqual([]);
  });
});
