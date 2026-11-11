// Whether reap may release a worktree. Pure: every input is gathered by the caller.
import type { PullRequest } from "./gh.ts";

export interface TreeFacts {
  readonly name: string;
  readonly path: string;
  readonly registered: boolean;
  /** Protected path, a main checkout, or contains one. */
  readonly protected: boolean;
  readonly insideRoots: boolean;
  /** Listed in the profile's keep list. */
  readonly kept: boolean;
  /** Another worktree lives inside this one. */
  readonly containsWorktree: boolean;
  readonly missing: boolean;
  readonly gitOk: boolean;
  readonly gitError?: string | undefined;
  readonly head: string | undefined;
  readonly dirty: number;
  readonly unpushed: number;
  readonly ahead: number;
  readonly headInBase: boolean;
  readonly pr: PullRequest | undefined;
  /** PR state could not be read (gh missing or failed). */
  readonly prUnknown: boolean;
  readonly livePids: readonly number[];
  /** Hours since the worktree's index, HEAD or reflog last changed. */
  readonly lastActivityHours: number | undefined;
  /** Trees active more recently than this are not reaped on "HEAD in main" alone. */
  readonly recentHours: number;
}

export interface Verdict {
  readonly release: boolean;
  readonly reason: string;
}

const keep = (reason: string): Verdict => ({ release: false, reason });

export function classify(f: TreeFacts): Verdict {
  if (f.protected) return keep("protected checkout");
  if (!f.insideRoots) return keep("outside the configured roots");
  if (f.kept) return keep("listed in the profile's keep list");
  if (f.containsWorktree) return keep("contains another worktree");
  if (f.missing) return { release: true, reason: "directory is gone; prune the record" };
  if (!f.gitOk) return keep(`git status failed${f.gitError ? `: ${f.gitError}` : ""}`);
  if (f.livePids.length)
    return keep(`a running process uses this path (pid ${f.livePids.slice(0, 3).join(",")})`);
  if (f.dirty > 0) return keep(`${f.dirty} uncommitted/untracked files`);
  if (f.pr?.state === "OPEN") return keep(`open PR #${f.pr.number}`);
  if (f.headInBase) {
    // A fresh tree made from origin/main has HEAD in main too: without a finished PR, recent
    // git activity means someone may be about to use it.
    const finished = f.pr?.state === "MERGED" || f.pr?.state === "CLOSED";
    if (!finished && f.lastActivityHours !== undefined && f.lastActivityHours < f.recentHours) {
      return keep(
        `clean, but git activity ${f.lastActivityHours.toFixed(1)} h ago (< ${f.recentHours} h), may be in use`,
      );
    }
    return { release: true, reason: "clean; HEAD already in origin/main" };
  }
  if (f.pr?.state === "MERGED") {
    if (f.pr.headRefOid === f.head)
      return { release: true, reason: `clean; PR #${f.pr.number} merged` };
    return keep(
      `PR #${f.pr.number} merged, but HEAD moved after it (${f.ahead} commits not in main)`,
    );
  }
  if (f.pr?.state === "CLOSED") {
    if (f.unpushed === 0)
      return { release: true, reason: `clean; PR #${f.pr.number} closed, every commit pushed` };
    return keep(`PR #${f.pr.number} closed unmerged, ${f.unpushed} commits not pushed`);
  }
  if (f.prUnknown)
    return keep(`${f.ahead} commits not in origin/main; PR state unknown (gh unavailable)`);
  return keep(`${f.ahead} commits not in origin/main and no PR`);
}
