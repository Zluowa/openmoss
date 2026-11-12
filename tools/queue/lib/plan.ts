// FILE: tools/queue/lib/plan.ts
// Purpose: Builds a batch candidate: fetch the PR heads, check each is the head GitHub reports,
//          and chain in-memory merges onto the base branch in the given order.
// Layer: tool library
// Exports: buildCandidate, mergeOnto, QUEUE_IDENTITY, PlanOutcome

import type { CommitIdentity, Git } from "./git.ts";
import type { GitHub, PullInfo } from "./github.ts";
import type { Candidate, CandidateStep } from "./state.ts";

export const QUEUE_IDENTITY = { name: "Moss queue", email: "queue@localhost" } as const;

export type PlanOutcome =
  | { readonly kind: "candidate"; readonly candidate: Candidate }
  | {
      readonly kind: "conflict";
      readonly pr: number;
      readonly files: readonly string[];
      /** PRs that merged cleanly before the conflict. */
      readonly before: readonly number[];
    }
  | { readonly kind: "error"; readonly message: string };

export interface PlanDeps {
  readonly git: Git;
  readonly github: GitHub;
  readonly remoteName: string;
  readonly baseBranch: string;
  readonly now?: () => Date;
}

/** The commit identity for queue commits on top of `parent`: fixed name, the parent's date. */
export async function identityFor(git: Git, base: string): Promise<CommitIdentity> {
  return { ...QUEUE_IDENTITY, date: `@${await git.commitTime(base)} +0000` };
}

/** Merges `head` onto `onto` in memory; a merge commit with parents [onto, head], or the conflicts. */
export async function mergeOnto(
  git: Git,
  onto: string,
  head: string,
  message: string,
  who: CommitIdentity,
): Promise<{ commit: string; tree: string } | { conflicts: readonly string[] }> {
  const merged = await git.mergeTree(onto, head);
  if (merged.conflicts.length > 0) return { conflicts: merged.conflicts };
  const commit = await git.commitTree(merged.tree, [onto, head], message, who);
  return { commit, tree: merged.tree };
}

export async function buildCandidate(deps: PlanDeps, prs: readonly number[]): Promise<PlanOutcome> {
  const { git, github } = deps;
  if (prs.length === 0) return { kind: "error", message: "name at least one PR" };
  if (new Set(prs).size !== prs.length) return { kind: "error", message: "a PR is named twice" };
  const pulls: PullInfo[] = [];
  for (const n of prs) {
    const p = await github.getPull(n);
    if (p.merged) return { kind: "error", message: `PR #${n} is already merged` };
    if (p.state !== "open") return { kind: "error", message: `PR #${n} is ${p.state}` };
    pulls.push(p);
  }
  const trackingRef = `refs/remotes/${deps.remoteName}/${deps.baseBranch}`;
  const fetched = await git.fetch(deps.remoteName, [
    `+refs/heads/${deps.baseBranch}:${trackingRef}`,
    ...prs.map((n) => `refs/pull/${n}/head`),
  ]);
  for (const p of pulls) {
    const got = fetched.get(`pull/${p.number}`);
    if (got !== p.head) {
      return {
        kind: "error",
        message:
          `PR #${p.number}: fetched head ${got?.slice(0, 9) ?? "(none)"} but GitHub reports ` +
          `${p.head.slice(0, 9)}; it was probably pushed meanwhile. Plan again.`,
      };
    }
  }
  const baseSha = await git.revParse(trackingRef);
  const baseTree = await git.treeOf(baseSha);
  const who = await identityFor(git, baseSha);
  const steps: CandidateStep[] = [];
  let onto = baseSha;
  for (const p of pulls) {
    const merged = await mergeOnto(
      git,
      onto,
      p.head,
      `queue: merge #${p.number} (head ${p.head.slice(0, 9)})\n\n${p.title}`,
      who,
    );
    if ("conflicts" in merged)
      return {
        kind: "conflict",
        pr: p.number,
        files: merged.conflicts,
        before: steps.map((s) => s.pr),
      };
    steps.push({
      pr: p.number,
      title: p.title,
      head: p.head,
      headRef: p.headRef,
      baseRef: p.baseRef,
      commit: merged.commit,
      tree: merged.tree,
    });
    onto = merged.commit;
  }
  const last = steps.at(-1)!;
  return {
    kind: "candidate",
    candidate: {
      version: 1,
      repo: github.repo,
      createdAt: (deps.now?.() ?? new Date()).toISOString(),
      base: { ref: `${deps.remoteName}/${deps.baseBranch}`, sha: baseSha, tree: baseTree },
      steps,
      sha: last.commit,
      tree: last.tree,
    },
  };
}
