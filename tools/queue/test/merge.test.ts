// FILE: tools/queue/test/merge.test.ts
// Purpose: The merge step against a fake GitHub that really merges into a temporary bare repo:
//          the verdict gate, the tree assertion after every merge, stop on mismatch, the head rule.
// Layer: test

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Git } from "../lib/git.ts";
import { GitHub } from "../lib/github.ts";
import { checkHead, mergeCandidate, verdictAllowsMerge } from "../lib/merge.ts";
import { buildCandidate } from "../lib/plan.ts";
import { CandidateStore, type Candidate } from "../lib/state.ts";
import type { Verdict } from "../lib/verify.ts";
import {
  cleanup,
  FakeRunner,
  fakeGitHub,
  makeRepo,
  sh,
  type FakePull,
  type Repo,
} from "./helpers.ts";

let repo: Repo | undefined;
afterEach(() => {
  if (repo) cleanup(repo.root);
  repo = undefined;
});

export function greenVerdict(c: Candidate, over: Partial<Verdict> = {}): Verdict {
  return {
    version: 1,
    candidate: { sha: c.sha, tree: c.tree },
    base: { sha: c.base.sha, tree: c.base.tree },
    heads: c.steps.map((s) => ({ pr: s.pr, head: s.head, tree: s.tree })),
    result: "green",
    complete: true,
    lanes: [
      {
        name: "fmt",
        target: "local",
        status: "green",
        seconds: 1,
        reason: undefined,
        tests: undefined,
        log: "x",
        resumed: false,
      },
    ],
    failures: [],
    culprits: [],
    notes: [],
    startedAt: "2026-11-13T00:00:00.000Z",
    finishedAt: "2026-11-13T01:00:00.000Z",
    ...over,
  };
}

async function setup(options: { tamper?: number[]; stacked?: boolean } = {}) {
  repo = makeRepo();
  const pulls = new Map<number, FakePull>();
  const h1 = repo.pr(1, { "b.txt": "b\n" });
  const h2 = repo.pr(2, { "c.txt": "c\n" }, options.stacked ? "pr-1" : "origin/main");
  pulls.set(1, {
    number: 1,
    title: 'one "quoted"',
    head: h1,
    headRef: "pr-1",
    baseRef: "main",
    state: "open",
    merged: false,
  });
  pulls.set(2, {
    number: 2,
    title: "two",
    head: h2,
    headRef: "pr-2",
    baseRef: options.stacked ? "pr-1" : "main",
    state: "open",
    merged: false,
  });
  const gh = fakeGitHub(repo, pulls, options);
  const runner = new FakeRunner().on(gh.handler);
  const git = new Git(runner, "git", repo.work);
  const github = new GitHub(runner, "gh", "owner/repo");
  const out = await buildCandidate(
    { git, github, remoteName: "origin", baseBranch: "main" },
    [1, 2],
  );
  if (out.kind !== "candidate") throw new Error(JSON.stringify(out));
  const store = new CandidateStore(path.join(repo.root, "state"));
  store.save(out.candidate);
  const mergeLog = path.join(repo.root, "merge-log.md");
  fs.writeFileSync(mergeLog, "# log\n- earlier line");
  const lines: string[] = [];
  const deps = {
    candidate: out.candidate,
    verdict: greenVerdict(out.candidate),
    store,
    git,
    github,
    remoteName: "origin",
    baseBranch: "main",
    mergeLog,
    log: (l: string) => lines.push(l),
    dryRun: false,
    now: () => new Date(2026, 10, 13, 1, 34),
    sleep: async () => {},
  };
  return { repo, pulls, gh, runner, deps, lines, mergeLog, candidate: out.candidate };
}

describe("queue merge", () => {
  it("merges one PR at a time pinned to its head, checks each tree, and logs each merge", async () => {
    const { repo, gh, deps, mergeLog, candidate, lines } = await setup();
    expect(await mergeCandidate(deps)).toBe(0);
    expect(gh.writes).toEqual([
      `PUT 1 sha=${candidate.steps[0]!.head} method=merge`,
      `PUT 2 sha=${candidate.steps[1]!.head} method=merge`,
    ]);
    expect(sh(repo.origin, "rev-parse", "main^{tree}")).toBe(candidate.tree);
    const log = fs.readFileSync(mergeLog, "utf8").split("\n");
    expect(log[1]).toBe("- earlier line");
    expect(log[2]).toMatch(
      new RegExp(
        `^- 2026-11-13 01:34 #1 "one 'quoted'" head ${candidate.steps[0]!.head.slice(0, 9)} -> main [0-9a-f]{9} \\(tree-ok\\); queue candidate ${candidate.sha.slice(0, 9)} \\(#1 #2\\), verdict green: 1 lanes$`,
      ),
    );
    expect(log[3]).toMatch(/#2 "two" .*\(tree-ok\)/);
    expect(lines.at(-1)).toMatch(/merged 2 PR\(s\)/);
  });

  it("stops at the first tree mismatch and merges nothing after it", async () => {
    const { gh, deps, mergeLog, lines } = await setup({ tamper: [1] });
    expect(await mergeCandidate(deps)).toBe(1);
    expect(gh.writes).toHaveLength(1);
    expect(fs.readFileSync(mergeLog, "utf8")).toMatch(
      /#1 .*TREE MISMATCH: want [0-9a-f]{9} got [0-9a-f]{9}/,
    );
    expect(lines.at(-1)).toMatch(/^STOPPED: #1 merged as/);
  });

  it("dry run calls no write API and appends nothing", async () => {
    const { gh, deps, mergeLog, lines } = await setup({ stacked: true });
    const before = fs.readFileSync(mergeLog, "utf8");
    expect(await mergeCandidate({ ...deps, dryRun: true })).toBe(0);
    expect(gh.writes).toEqual([]);
    expect(fs.readFileSync(mergeLog, "utf8")).toBe(before);
    expect(lines).toContain("would retarget #2 from pr-1 to main");
    expect(lines.filter((l) => l.startsWith("would merge"))).toHaveLength(2);
  });

  it("retargets a stacked PR to main before merging it", async () => {
    const { gh, deps } = await setup({ stacked: true });
    expect(await mergeCandidate(deps)).toBe(0);
    expect(gh.writes.map((w) => w.split(" sha=")[0])).toEqual([
      "PUT 1",
      "PATCH 2 base=main",
      "PUT 2",
    ]);
  });

  it("refuses without a green, complete verdict for exactly these heads and trees", async () => {
    const { deps, candidate, gh } = await setup();
    expect(verdictAllowsMerge(candidate, undefined)).toMatch(/no verdict/);
    expect(verdictAllowsMerge(candidate, greenVerdict(candidate, { result: "red" }))).toBe(
      "the verdict is red",
    );
    expect(verdictAllowsMerge(candidate, greenVerdict(candidate, { complete: false }))).toMatch(
      /partial/,
    );
    expect(verdictAllowsMerge(candidate, greenVerdict(candidate, { result: "base-red" }))).toMatch(
      /--allow-base-red/,
    );
    expect(
      verdictAllowsMerge(candidate, greenVerdict(candidate, { result: "base-red" }), true),
    ).toBeUndefined();
    const other = greenVerdict(candidate, {
      heads: candidate.steps.map((s, i) => ({
        pr: s.pr,
        head: i ? "f".repeat(40) : s.head,
        tree: s.tree,
      })),
    });
    expect(verdictAllowsMerge(candidate, other)).toMatch(/heads or trees/);
    expect(
      await mergeCandidate({ ...deps, verdict: greenVerdict(candidate, { result: "red" }) }),
    ).toBe(1);
    expect(gh.writes).toEqual([]);
  });

  it("refuses when main moved since the plan", async () => {
    const { repo, deps, gh, lines } = await setup();
    repo.advanceMain({ "z.txt": "z\n" });
    expect(await mergeCandidate(deps)).toBe(1);
    expect(gh.writes).toEqual([]);
    expect(lines.at(-1)).toMatch(/something else was merged/);
  });

  it("accepts a head that moved when merging it gives the verified tree", async () => {
    const { repo, deps, pulls, gh, candidate, lines } = await setup();
    // Same content, new commit (an amended message): the merge tree is unchanged.
    sh(repo.author, "checkout", "--quiet", "pr-2");
    sh(repo.author, "commit", "--quiet", "--amend", "-m", "reworded");
    const moved = sh(repo.author, "rev-parse", "HEAD");
    sh(repo.author, "push", "--quiet", "--force", "origin", "HEAD:refs/pull/2/head");
    pulls.get(2)!.head = moved;
    expect(await mergeCandidate(deps)).toBe(0);
    expect(gh.writes[1]).toBe(`PUT 2 sha=${moved} method=merge`);
    expect(lines.some((l) => /#2: head moved .* accepted/.test(l))).toBe(true);
    expect(sh(repo.origin, "rev-parse", "main^{tree}")).toBe(candidate.tree);
  });

  it("refuses a moved head whose merge gives another tree, before merging anything", async () => {
    const { repo, deps, pulls, gh, candidate, lines } = await setup();
    pulls.get(2)!.head = repo.pr(2, { "c.txt": "changed\n" });
    expect(await mergeCandidate(deps)).toBe(1);
    expect(gh.writes).toEqual([]);
    expect(lines.at(-1)).toMatch(/#2 moved from .* gives tree .*: plan and verify the batch again/);
    const rule = await checkHead(deps.git, candidate, 1, {
      ...pulls.get(2)!,
      mergeCommit: undefined,
      draft: false,
    });
    expect(rule.ok).toBe(false);
  });

  it("refuses to merge for real without a merge log", async () => {
    const { deps } = await setup();
    expect(await mergeCandidate({ ...deps, mergeLog: undefined })).toBe(2);
  });
});
