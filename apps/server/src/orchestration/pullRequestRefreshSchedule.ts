// FILE: pullRequestRefreshSchedule.ts
// Purpose: Which linked pull requests the server re-reads from GitHub on a refresh tick, and
//          through which workspaces. Each read is one `gh pr view` on the quota the agents'
//          own `gh` calls use, so reads are capped per tick and per hour and back off on
//          failure (offline, signed out).
// Layer: Orchestration (pure)
// Exports: planPullRequestRefreshes, recordPullRequestRefresh, PullRequestRefreshState, limits

import type { OrchestrationThreadPullRequest, ThreadId } from "@moss/contracts";
import { pullRequestLinkKey, visiblePullRequestLinks } from "@moss/shared/threadPullRequestLinks";

export const ACTIVE_PULL_REQUEST_REFRESH_INTERVAL_MS = 2 * 60_000;
export const QUIET_PULL_REQUEST_REFRESH_INTERVAL_MS = 10 * 60_000;
/** A closed PR can be reopened on GitHub; a merged one is final and never re-read. */
export const CLOSED_PULL_REQUEST_REFRESH_INTERVAL_MS = 60 * 60_000;
export const ACTIVE_THREAD_WINDOW_MS = 30 * 60_000;
export const MAX_PULL_REQUEST_REFRESHES_PER_TICK = 6;
export const MAX_PULL_REQUEST_REFRESHES_PER_HOUR = 60;
/** Failed reads double the wait, up to this. */
export const MAX_PULL_REQUEST_REFRESH_BACKOFF_MS = 6 * 60 * 60_000;

export interface PullRequestRefreshState {
  /** Per PR (link key): when it was last read, and how many reads in a row failed. */
  readonly byKey: Map<string, { lastAttemptAt: number; failures: number }>;
  /** Times of reads in the last hour, oldest first. */
  readonly recentAttempts: number[];
}

export const makePullRequestRefreshState = (): PullRequestRefreshState => ({
  byKey: new Map(),
  recentAttempts: [],
});

export interface PullRequestRefreshThread {
  readonly id: ThreadId;
  readonly pullRequests?: Parameters<typeof visiblePullRequestLinks>[0];
  readonly archivedAt?: string | null | undefined;
  readonly deletedAt?: string | null | undefined;
  readonly latestUserMessageAt?: string | null | undefined;
  readonly updatedAt: string;
}

export interface PlannedPullRequestRefresh {
  readonly key: string;
  readonly url: string;
  /** Workspaces of the chats that link it, most recently active first; try them in order. */
  readonly cwds: ReadonlyArray<string>;
  readonly snapshotsByThread: ReadonlyMap<ThreadId, OrchestrationThreadPullRequest>;
}

/** The PRs due for a read now, at most the per-tick cap and what the hourly budget allows. */
export function planPullRequestRefreshes(input: {
  readonly threads: ReadonlyArray<PullRequestRefreshThread>;
  readonly resolveCwd: (thread: PullRequestRefreshThread) => string | null;
  readonly now: number;
  readonly state: PullRequestRefreshState;
}): PlannedPullRequestRefresh[] {
  const { now, state } = input;
  const entries = new Map<
    string,
    {
      url: string;
      cwds: Array<{ cwd: string; activity: number }>;
      intervalMs: number;
      snapshotsByThread: Map<ThreadId, OrchestrationThreadPullRequest>;
    }
  >();
  for (const thread of input.threads) {
    if (thread.archivedAt != null || thread.deletedAt != null) continue;
    const links = visiblePullRequestLinks(thread.pullRequests).filter(
      (link) => link.pullRequest.state !== "merged",
    );
    if (links.length === 0) continue;
    const cwd = input.resolveCwd(thread);
    if (!cwd) continue;
    const activity = Date.parse(thread.latestUserMessageAt ?? thread.updatedAt);
    const active = Number.isFinite(activity) && now - activity < ACTIVE_THREAD_WINDOW_MS;
    for (const link of links) {
      const intervalMs =
        link.pullRequest.state === "closed"
          ? CLOSED_PULL_REQUEST_REFRESH_INTERVAL_MS
          : active
            ? ACTIVE_PULL_REQUEST_REFRESH_INTERVAL_MS
            : QUIET_PULL_REQUEST_REFRESH_INTERVAL_MS;
      const key = pullRequestLinkKey(link.pullRequest.url);
      const entry = entries.get(key) ?? {
        url: link.pullRequest.url,
        cwds: [],
        intervalMs,
        snapshotsByThread: new Map<ThreadId, OrchestrationThreadPullRequest>(),
      };
      entry.intervalMs = Math.min(entry.intervalMs, intervalMs);
      if (!entry.cwds.some((candidate) => candidate.cwd === cwd)) {
        entry.cwds.push({ cwd, activity: Number.isFinite(activity) ? activity : 0 });
      }
      entry.snapshotsByThread.set(thread.id, link.pullRequest);
      entries.set(key, entry);
    }
  }
  for (const key of state.byKey.keys()) {
    if (!entries.has(key)) state.byKey.delete(key);
  }
  while (state.recentAttempts.length > 0 && now - state.recentAttempts[0]! >= 60 * 60_000) {
    state.recentAttempts.shift();
  }
  const budget = Math.max(
    0,
    Math.min(
      MAX_PULL_REQUEST_REFRESHES_PER_TICK,
      MAX_PULL_REQUEST_REFRESHES_PER_HOUR - state.recentAttempts.length,
    ),
  );
  return [...entries.entries()]
    .flatMap(([key, entry]) => {
      const previous = state.byKey.get(key);
      const wait = Math.min(
        entry.intervalMs * 2 ** Math.min(previous?.failures ?? 0, 16),
        Math.max(entry.intervalMs, MAX_PULL_REQUEST_REFRESH_BACKOFF_MS),
      );
      const lastAttemptAt = previous?.lastAttemptAt ?? 0;
      return now - lastAttemptAt >= wait ? [{ key, entry, lastAttemptAt }] : [];
    })
    .toSorted((left, right) => left.lastAttemptAt - right.lastAttemptAt)
    .slice(0, budget)
    .map(({ key, entry }) => ({
      key,
      url: entry.url,
      cwds: entry.cwds
        .toSorted((left, right) => right.activity - left.activity)
        .map((candidate) => candidate.cwd),
      snapshotsByThread: entry.snapshotsByThread,
    }));
}

/** Records a read attempt: a failure lengthens the wait before the next one. */
export function recordPullRequestRefresh(
  state: PullRequestRefreshState,
  key: string,
  at: number,
  succeeded: boolean,
): void {
  const previous = state.byKey.get(key);
  state.byKey.set(key, {
    lastAttemptAt: at,
    failures: succeeded ? 0 : (previous?.failures ?? 0) + 1,
  });
  state.recentAttempts.push(at);
}
