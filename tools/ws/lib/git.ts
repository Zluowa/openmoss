// Read-only git queries plus the two writes ws makes: `worktree add` and `worktree prune`.
import { normalize } from "./paths.ts";
import { runAsync, runSync } from "./run.ts";

export interface GitWorktree {
  readonly path: string;
  readonly head: string | undefined;
  /** Short branch name, or undefined when detached. */
  readonly branch: string | undefined;
  readonly bare: boolean;
  readonly prunable: boolean;
  /** The first entry of `git worktree list` is the main worktree that owns the objects. */
  readonly isMain: boolean;
}

export function parseWorktreeList(porcelain: string): GitWorktree[] {
  const out: GitWorktree[] = [];
  for (const block of porcelain.replaceAll("\r\n", "\n").split("\n\n")) {
    const lines = block.split("\n").filter(Boolean);
    const wt = lines.find((l) => l.startsWith("worktree "));
    if (!wt) continue;
    const head = lines.find((l) => l.startsWith("HEAD "))?.slice(5);
    const branchRef = lines.find((l) => l.startsWith("branch "))?.slice(7);
    out.push({
      path: normalize(wt.slice(9)),
      head,
      branch: branchRef?.replace(/^refs\/heads\//, ""),
      bare: lines.includes("bare"),
      prunable: lines.some((l) => l.startsWith("prunable")),
      isMain: out.length === 0,
    });
  }
  return out;
}

export function listWorktrees(git: string, repo: string): GitWorktree[] {
  const r = runSync(git, ["-C", repo, "worktree", "list", "--porcelain"]);
  if (r.code !== 0) throw new Error(`git worktree list failed: ${r.stderr.trim()}`);
  return parseWorktreeList(r.stdout);
}

export interface TreeState {
  readonly ok: boolean;
  readonly head: string | undefined;
  readonly dirty: number;
  /** Commits on HEAD that no remote-tracking ref contains. */
  readonly unpushed: number;
  /** Commits on HEAD that the base (origin/main) does not contain. */
  readonly ahead: number;
  readonly headInBase: boolean;
  readonly error?: string | undefined;
}

export async function readTreeState(git: string, dir: string, base: string): Promise<TreeState> {
  const [head, status] = await Promise.all([
    runAsync(git, ["-C", dir, "rev-parse", "HEAD"]),
    runAsync(
      git,
      ["--no-optional-locks", "-C", dir, "status", "--porcelain", "--untracked-files=normal"],
      { timeoutMs: 180_000 },
    ),
  ]);
  if (head.code !== 0 || status.code !== 0) {
    return {
      ok: false,
      head: undefined,
      dirty: 0,
      unpushed: 0,
      ahead: 0,
      headInBase: false,
      error: (head.stderr || status.stderr).trim().split("\n")[0],
    };
  }
  const sha = head.stdout.trim();
  const [unpushed, ahead, inBase] = await Promise.all([
    runAsync(git, ["-C", dir, "rev-list", "--count", sha, "--not", "--remotes"]),
    runAsync(git, ["-C", dir, "rev-list", "--count", `${base}..${sha}`]),
    runAsync(git, ["-C", dir, "merge-base", "--is-ancestor", sha, base]),
  ]);
  return {
    ok: true,
    head: sha,
    dirty: status.stdout.split("\n").filter((l) => l.trim()).length,
    unpushed: Number(unpushed.stdout.trim()) || 0,
    ahead: Number(ahead.stdout.trim()) || 0,
    headInBase: inBase.code === 0,
  };
}

export function branchExists(git: string, repo: string, branch: string): boolean {
  return (
    runSync(git, ["-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).code === 0
  );
}

export function branchTip(git: string, repo: string, branch: string): string | undefined {
  const r = runSync(git, ["-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  return r.code === 0 ? r.stdout.trim() : undefined;
}
