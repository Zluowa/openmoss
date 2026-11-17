import { ThreadId, type OrchestrationThreadPullRequestLink } from "@moss/contracts";
import { describe, expect, it } from "vitest";

import {
  ACTIVE_PULL_REQUEST_REFRESH_INTERVAL_MS,
  CLOSED_PULL_REQUEST_REFRESH_INTERVAL_MS,
  MAX_PULL_REQUEST_REFRESHES_PER_HOUR,
  MAX_PULL_REQUEST_REFRESHES_PER_TICK,
  makePullRequestRefreshState,
  planPullRequestRefreshes,
  recordPullRequestRefresh,
  type PullRequestRefreshThread,
} from "./pullRequestRefreshSchedule.ts";

const NOW = Date.parse("2026-11-18T12:00:00.000Z");
const link = (
  number: number,
  state: "open" | "closed" | "merged" = "open",
  dismissedAt?: string,
): OrchestrationThreadPullRequestLink => ({
  pullRequest: {
    number,
    title: `PR ${number}`,
    url: `https://github.com/acme/app/pull/${number}`,
    baseBranch: "main",
    headBranch: `feat/${number}`,
    state,
  },
  source: "agent",
  linkedAt: "2026-11-18T09:00:00.000Z",
  ...(dismissedAt ? { dismissedAt } : {}),
});
const thread = (
  id: string,
  pullRequests: OrchestrationThreadPullRequestLink[],
  activeAgoMs = 60_000,
): PullRequestRefreshThread => ({
  id: ThreadId.makeUnsafe(id),
  pullRequests,
  updatedAt: new Date(NOW - activeAgoMs).toISOString(),
});
const cwdOf: Record<string, string> = { a: "/work/a", b: "/work/b", c: "/work/c" };
const plan = (
  threads: PullRequestRefreshThread[],
  state = makePullRequestRefreshState(),
  now = NOW,
) => planPullRequestRefreshes({ threads, resolveCwd: (t) => cwdOf[t.id] ?? "/work/x", now, state });

describe("planPullRequestRefreshes", () => {
  it("reads open and closed links, never merged ones or unlinked ones", () => {
    const planned = plan([
      thread("a", [
        link(1),
        link(2, "closed"),
        link(3, "merged"),
        link(4, "open", "2026-11-18T10:00:00.000Z"),
      ]),
    ]);
    expect(planned.map((entry) => entry.url.split("/").at(-1))).toEqual(["1", "2"]);
  });

  it("caps the reads per tick and per hour", () => {
    const many = Array.from({ length: 30 }, (_, index) => link(index + 1));
    const state = makePullRequestRefreshState();
    expect(plan([thread("a", many)], state)).toHaveLength(MAX_PULL_REQUEST_REFRESHES_PER_TICK);
    for (let index = 0; index < MAX_PULL_REQUEST_REFRESHES_PER_HOUR - 2; index += 1) {
      state.recentAttempts.push(NOW - 1_000);
    }
    expect(plan([thread("a", many)], state)).toHaveLength(2);
    // Attempts older than an hour no longer count.
    expect(plan([thread("a", many)], state, NOW + 60 * 60_000)).toHaveLength(
      MAX_PULL_REQUEST_REFRESHES_PER_TICK,
    );
  });

  it("backs off after failed reads and resets after a success", () => {
    const state = makePullRequestRefreshState();
    const threads = [thread("a", [link(1)])];
    const [first] = plan(threads, state);
    recordPullRequestRefresh(state, first!.key, NOW, false);
    recordPullRequestRefresh(state, first!.key, NOW, false);
    // Two failures: four times the active interval before the next read.
    expect(plan(threads, state, NOW + 3 * ACTIVE_PULL_REQUEST_REFRESH_INTERVAL_MS)).toEqual([]);
    expect(plan(threads, state, NOW + 4 * ACTIVE_PULL_REQUEST_REFRESH_INTERVAL_MS)).toHaveLength(1);
    recordPullRequestRefresh(state, first!.key, NOW, true);
    expect(plan(threads, state, NOW + ACTIVE_PULL_REQUEST_REFRESH_INTERVAL_MS)).toHaveLength(1);
  });

  it("re-reads a closed PR slowly so a reopen on GitHub shows up", () => {
    const state = makePullRequestRefreshState();
    const threads = [thread("a", [link(2, "closed")])];
    const [first] = plan(threads, state);
    recordPullRequestRefresh(state, first!.key, NOW, true);
    expect(plan(threads, state, NOW + ACTIVE_PULL_REQUEST_REFRESH_INTERVAL_MS)).toEqual([]);
    expect(plan(threads, state, NOW + CLOSED_PULL_REQUEST_REFRESH_INTERVAL_MS)).toHaveLength(1);
  });

  it("offers every chat's workspace for a shared PR, most recently active first", () => {
    const planned = plan([
      thread("a", [link(1)], 50 * 60_000),
      thread("b", [link(1)], 60_000),
      thread("c", [link(1)], 10 * 60_000),
    ]);
    expect(planned).toHaveLength(1);
    expect(planned[0]!.cwds).toEqual(["/work/b", "/work/c", "/work/a"]);
    expect([...planned[0]!.snapshotsByThread.keys()]).toHaveLength(3);
  });
});
