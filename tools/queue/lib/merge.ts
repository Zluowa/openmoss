// FILE: tools/queue/lib/merge.ts
// Purpose: Merges a verified candidate one PR at a time through the GitHub API, pinned to each
//          verified head, and proves after every merge that main has exactly the tree computed
//          for that step. Stops at the first mismatch. Never touches the public mirror.
// Layer: tool library
// Exports: mergeCandidate, verdictAllowsMerge, checkHead, mergeLogLine, MergeDeps, MergeRecord

import fs from "node:fs";
import type { Git } from "./git.ts";
import { GitHubError, type GitHub, type PullInfo } from "./github.ts";
import {
  readJson,
  writeJson,
  type Candidate,
  type CandidateStep,
  type CandidateStore,
} from "./state.ts";
import type { Verdict } from "./verify.ts";

export interface MergeRecord {
  readonly merged: readonly {
    readonly pr: number;
    readonly head: string;
    readonly main: string;
    readonly tree: string;
    readonly treeOk: boolean;
    readonly at: string;
  }[];
}

export interface MergeDeps {
  readonly candidate: Candidate;
  readonly verdict: Verdict | undefined;
  readonly store: CandidateStore;
  readonly git: Git;
  readonly github: GitHub;
  readonly remoteName: string;
  readonly baseBranch: string;
  readonly mergeLog: string | undefined;
  readonly log: (line: string) => void;
  readonly dryRun: boolean;
  /** Accept a verdict whose only failures also fail on the base. */
  readonly allowBaseRed?: boolean | undefined;
  /** Appended to every merge-log line. */
  readonly note?: string | undefined;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Why the verdict does not allow merging this candidate, or undefined when it does. */
export function verdictAllowsMerge(
  candidate: Candidate,
  verdict: Verdict | undefined,
  allowBaseRed = false,
): string | undefined {
  if (!verdict) return "no verdict for this candidate: run `bun run queue verify` first";
  if (verdict.candidate.sha !== candidate.sha || verdict.candidate.tree !== candidate.tree)
    return `the verdict is for ${verdict.candidate.sha.slice(0, 9)}, not this candidate`;
  if (verdict.base.sha !== candidate.base.sha) return "the verdict was made on a different base";
  const want = candidate.steps.map((s) => `${s.pr}:${s.head}:${s.tree}`).join(",");
  const got = verdict.heads.map((h) => `${h.pr}:${h.head}:${h.tree}`).join(",");
  if (want !== got) return "the verdict's heads or trees are not this candidate's";
  if (!verdict.complete)
    return "the verdict is partial (--only, or a setup failure): run every lane";
  if (verdict.result === "green") return undefined;
  if (verdict.result === "base-red" && allowBaseRed) return undefined;
  if (verdict.result === "base-red")
    return "the verdict is base-red (failures that also fail on the base): pass --allow-base-red to merge anyway";
  return `the verdict is ${verdict.result}`;
}

/**
 * The head rule: a PR whose head changed after verification is accepted only when merging the
 * new head onto the previous step gives exactly the verified tree.
 */
export async function checkHead(
  git: Git,
  candidate: Candidate,
  index: number,
  current: PullInfo,
): Promise<{ ok: true; head: string; changed: boolean } | { ok: false; reason: string }> {
  const step = candidate.steps[index]!;
  if (current.head === step.head) return { ok: true, head: step.head, changed: false };
  if (!(await git.exists(`${current.head}^{commit}`)))
    return {
      ok: false,
      reason: `#${step.pr} has a new head ${current.head.slice(0, 9)} that is not fetched`,
    };
  const prev = index === 0 ? candidate.base.sha : candidate.steps[index - 1]!.commit;
  const merged = await git.mergeTree(prev, current.head);
  if (merged.conflicts.length || merged.tree !== step.tree)
    return {
      ok: false,
      reason:
        `#${step.pr} moved from ${step.head.slice(0, 9)} to ${current.head.slice(0, 9)} and the merge ` +
        `${merged.conflicts.length ? "conflicts" : `gives tree ${merged.tree.slice(0, 9)}, not ${step.tree.slice(0, 9)}`}: ` +
        "plan and verify the batch again",
    };
  return { ok: true, head: current.head, changed: true };
}

const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

export function mergeLogLine(args: {
  readonly at: Date;
  readonly step: CandidateStep;
  readonly head: string;
  readonly main: string;
  readonly tree: string;
  readonly candidate: Candidate;
  readonly verdict: Verdict;
  readonly note?: string | undefined;
}): string {
  const { step, verdict } = args;
  const ok = args.tree === step.tree;
  const flaky = verdict.failures.filter((f) => f.classification === "flaky");
  const flakyFiles = [...new Set(flaky.map((f) => f.file || f.lane))];
  const title = step.title.replaceAll('"', "'");
  return (
    `- ${stamp(args.at)} #${step.pr} "${title}" head ${args.head.slice(0, 9)} -> main ${args.main.slice(0, 9)} ` +
    `(${ok ? "tree-ok" : `TREE MISMATCH: want ${step.tree.slice(0, 9)} got ${args.tree.slice(0, 9)}`}); ` +
    `queue candidate ${args.candidate.sha.slice(0, 9)} (${args.candidate.steps.map((s) => `#${s.pr}`).join(" ")}), ` +
    `verdict ${verdict.result}: ${verdict.lanes.length} lanes` +
    (flaky.length ? `, ${flaky.length} flaky (${flakyFiles.join(", ")})` : "") +
    (args.note ? `; ${args.note}` : "")
  );
}

function appendLine(file: string, line: string): void {
  let prefix = "";
  try {
    const text = fs.readFileSync(file, "utf8");
    if (text.length && !text.endsWith("\n")) prefix = "\n";
  } catch {
    // a new log
  }
  fs.appendFileSync(file, `${prefix}${line}\n`);
}

export async function mergeCandidate(deps: MergeDeps): Promise<number> {
  const { candidate, git, github, log } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => new Date());
  const refusal = verdictAllowsMerge(candidate, deps.verdict, deps.allowBaseRed);
  if (refusal) {
    log(`refused: ${refusal}`);
    return 1;
  }
  const verdict = deps.verdict!;
  if (!deps.dryRun && !deps.mergeLog) {
    log('refused: no merge log configured ("queue.mergeLog" in the machine profile)');
    return 2;
  }
  const recordFile = deps.store.file(candidate.sha, "merge.json");
  const record: { merged: MergeRecord["merged"][number][] } = {
    merged: [...(readJson<MergeRecord>(recordFile)?.merged ?? [])],
  };
  const tracking = `refs/remotes/${deps.remoteName}/${deps.baseBranch}`;
  const fetchMain = async () => {
    await git.fetch(deps.remoteName, [`+refs/heads/${deps.baseBranch}:${tracking}`]);
    return git.revParse(tracking);
  };

  // Preflight: every PR open (or merged by an earlier run of this command), every head acceptable.
  const heads = new Map<number, string>();
  const pulls = new Map<number, PullInfo>();
  for (const step of candidate.steps) pulls.set(step.pr, await github.getPull(step.pr));
  const moved = candidate.steps.filter((s) => {
    const p = pulls.get(s.pr)!;
    return !p.merged && p.head !== s.head;
  });
  if (moved.length)
    await git.fetch(
      deps.remoteName,
      moved.map((s) => `refs/pull/${s.pr}/head`),
    );
  for (const [i, step] of candidate.steps.entries()) {
    const p = pulls.get(step.pr)!;
    if (p.merged) {
      if (record.merged.some((m) => m.pr === step.pr && m.treeOk)) continue;
      log(`refused: #${step.pr} is already merged, not by this candidate's queue run`);
      return 1;
    }
    if (p.state !== "open") {
      log(`refused: #${step.pr} is ${p.state}`);
      return 1;
    }
    const rule = await checkHead(git, candidate, i, p);
    if (!rule.ok) {
      log(`refused: ${rule.reason}`);
      return 1;
    }
    if (rule.changed)
      log(
        `#${step.pr}: head moved ${step.head.slice(0, 9)} -> ${rule.head.slice(0, 9)}; merging it gives the verified tree, accepted`,
      );
    heads.set(step.pr, rule.head);
  }

  let main = await fetchMain();
  let expected = candidate.base.tree;
  for (const step of candidate.steps) {
    if (record.merged.some((m) => m.pr === step.pr && m.treeOk)) expected = step.tree;
  }
  const mainTree = await git.treeOf(main);
  if (mainTree !== expected) {
    log(
      `refused: ${deps.remoteName}/${deps.baseBranch} ${main.slice(0, 9)} has tree ${mainTree.slice(0, 9)}, ` +
        `the candidate expects ${expected.slice(0, 9)}: something else was merged. Plan and verify again.`,
    );
    return 1;
  }

  for (const [i, step] of candidate.steps.entries()) {
    if (record.merged.some((m) => m.pr === step.pr && m.treeOk)) {
      log(
        `#${step.pr}: already merged by this candidate (${record.merged.find((m) => m.pr === step.pr)!.main.slice(0, 9)})`,
      );
      continue;
    }
    const pinned = heads.get(step.pr)!;
    if (deps.dryRun) {
      const p = pulls.get(step.pr)!;
      if (p.baseRef !== deps.baseBranch)
        log(`would retarget #${step.pr} from ${p.baseRef} to ${deps.baseBranch}`);
      log(
        `would merge #${step.pr} "${step.title}" at ${pinned.slice(0, 9)} (merge commit), ` +
          `then expect ${deps.remoteName}/${deps.baseBranch} tree ${step.tree.slice(0, 9)}`,
      );
      continue;
    }
    if (i > 0) {
      main = await fetchMain();
      const before = await git.treeOf(main);
      const want = i === 0 ? candidate.base.tree : candidate.steps[i - 1]!.tree;
      if (before !== want) {
        log(
          `stopped before #${step.pr}: main moved to ${main.slice(0, 9)} (tree ${before.slice(0, 9)}, want ${want.slice(0, 9)})`,
        );
        return 1;
      }
    }
    // Re-read right before merging: a push since the preflight must pass the head rule too.
    const current = await github.getPull(step.pr);
    if (current.head !== pinned) {
      await git.fetch(deps.remoteName, [`refs/pull/${step.pr}/head`]);
      const rule = await checkHead(git, candidate, i, current);
      if (!rule.ok) {
        log(`stopped before #${step.pr}: ${rule.reason}`);
        return 1;
      }
    }
    const head = current.head;
    if (current.baseRef !== deps.baseBranch) {
      log(`#${step.pr}: retargeting from ${current.baseRef} to ${deps.baseBranch}`);
      await github.retarget(step.pr, deps.baseBranch);
    }
    let mergeSha: string | undefined;
    for (let attempt = 1; attempt <= 3 && !mergeSha; attempt += 1) {
      try {
        const r = await github.merge(step.pr, head);
        if (r.merged) mergeSha = r.sha;
      } catch (error) {
        const after = await github.getPull(step.pr);
        if (after.merged && after.mergeCommit) {
          mergeSha = after.mergeCommit;
          break;
        }
        const status = error instanceof GitHubError ? error.status : undefined;
        if (attempt === 3 || (status !== 405 && status !== 409)) {
          log(`stopped: merging #${step.pr} failed: ${(error as Error).message}`);
          return 1;
        }
        log(`#${step.pr}: merge refused (${(error as Error).message}); retrying`);
        await sleep(5_000);
      }
    }
    if (!mergeSha) {
      log(`stopped: GitHub did not merge #${step.pr}`);
      return 1;
    }
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      main = await fetchMain();
      if (main === mergeSha) break;
      await sleep(5_000);
    }
    if (main !== mergeSha) {
      log(
        `stopped: ${deps.remoteName}/${deps.baseBranch} is ${main.slice(0, 9)}, not the merge commit ${mergeSha.slice(0, 9)}`,
      );
      return 1;
    }
    const tree = await git.treeOf(mergeSha);
    const treeOk = tree === step.tree;
    record.merged.push({
      pr: step.pr,
      head,
      main: mergeSha,
      tree,
      treeOk,
      at: now().toISOString(),
    });
    writeJson(recordFile, record);
    appendLine(
      deps.mergeLog!,
      mergeLogLine({
        at: now(),
        step,
        head,
        main: mergeSha,
        tree,
        candidate,
        verdict,
        note: deps.note,
      }),
    );
    if (!treeOk) {
      log(
        `STOPPED: #${step.pr} merged as ${mergeSha.slice(0, 9)} with tree ${tree.slice(0, 9)}, want ${step.tree.slice(0, 9)}`,
      );
      return 1;
    }
    log(`merged #${step.pr} at ${head.slice(0, 9)} -> ${mergeSha.slice(0, 9)} (tree ok)`);
  }
  log(
    deps.dryRun
      ? "dry run: nothing merged"
      : `merged ${candidate.steps.length} PR(s); main tree ${candidate.tree.slice(0, 9)}`,
  );
  return 0;
}
