// Pull-request state from the GitHub CLI, cached briefly in the state folder (a full listing takes ~30 s).
import fs from "node:fs";
import path from "node:path";
import type { Profile } from "./profile.ts";
import { runAsync } from "./run.ts";

export interface PullRequest {
  readonly number: number;
  readonly state: "OPEN" | "CLOSED" | "MERGED";
  readonly headRefName: string;
  readonly headRefOid: string;
}

interface Cache {
  readonly repo: string;
  readonly fetchedAt: number;
  readonly prs: PullRequest[];
}

export async function fetchPullRequests(
  profile: Profile,
  options: { refresh?: boolean | undefined; now?: number | undefined } = {},
): Promise<{ prs: PullRequest[]; source: string } | undefined> {
  const repo = profile.githubRepo;
  if (!repo) return undefined;
  const now = options.now ?? Date.now();
  const cacheFile = path.join(profile.stateDir, "pr-cache.json");
  if (!options.refresh) {
    try {
      const cache = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as Cache;
      if (cache.repo === repo && now - cache.fetchedAt < profile.prCacheMinutes * 60_000) {
        return {
          prs: cache.prs,
          source: `cache ${Math.round((now - cache.fetchedAt) / 1000)} s old`,
        };
      }
    } catch {
      // no cache yet
    }
  }
  const gh = profile.tools.gh ?? "gh";
  const r = await runAsync(
    gh,
    [
      "pr",
      "list",
      "-R",
      repo,
      "--state",
      "all",
      "--limit",
      "1000",
      "--json",
      "number,state,headRefName,headRefOid",
    ],
    { timeoutMs: 180_000 },
  );
  if (r.code !== 0) return undefined;
  let prs: PullRequest[];
  try {
    prs = JSON.parse(r.stdout) as PullRequest[];
  } catch {
    return undefined;
  }
  try {
    fs.mkdirSync(profile.stateDir, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ repo, fetchedAt: now, prs } satisfies Cache));
  } catch {
    // caching is best effort
  }
  return { prs, source: "gh" };
}

/**
 * The PR that belongs to a worktree: by branch name, else (detached) by head commit.
 * Among several, an open one wins, then one whose head is the tree's HEAD, then the newest.
 */
export function matchPullRequest(
  prs: readonly PullRequest[],
  branch: string | undefined,
  head: string | undefined,
): PullRequest | undefined {
  let candidates = branch ? prs.filter((p) => p.headRefName === branch) : [];
  if (!candidates.length && head) candidates = prs.filter((p) => p.headRefOid === head);
  if (!candidates.length) return undefined;
  const score = (p: PullRequest) =>
    (p.state === "OPEN" ? 2 : 0) + (head && p.headRefOid === head ? 1 : 0);
  return candidates.toSorted((a, b) => score(b) - score(a) || b.number - a.number)[0];
}
