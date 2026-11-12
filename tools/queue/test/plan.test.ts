// FILE: tools/queue/test/plan.test.ts
// Purpose: Building a candidate against a real temporary repository with a fake GitHub.
// Layer: test

import { afterEach, describe, expect, it } from "vitest";
import { Git } from "../lib/git.ts";
import { GitHub } from "../lib/github.ts";
import { buildCandidate } from "../lib/plan.ts";
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

function setup(prs: Record<number, Record<string, string>>, base: Record<number, string> = {}) {
  repo = makeRepo();
  const pulls = new Map<number, FakePull>();
  for (const [n, files] of Object.entries(prs)) {
    const num = Number(n);
    const head = repo.pr(num, files, base[num] ? `pr-${base[num]}` : "origin/main");
    pulls.set(num, {
      number: num,
      title: `PR ${num}`,
      head,
      headRef: `pr-${num}`,
      baseRef: base[num] ? `pr-${base[num]}` : "main",
      state: "open",
      merged: false,
    });
  }
  const gh = fakeGitHub(repo, pulls);
  const runner = new FakeRunner().on(gh.handler);
  const git = new Git(runner, "git", repo.work);
  const github = new GitHub(runner, "gh", "owner/repo");
  return { repo, pulls, runner, deps: { git, github, remoteName: "origin", baseBranch: "main" } };
}

describe("queue plan", () => {
  it("chains the PRs onto main in order, as real merges would", async () => {
    const { repo, deps } = setup({
      1: { "b.txt": "b\n" },
      2: { "apps/web/x.ts": "export const x = 2;\n" },
    });
    const out = await buildCandidate(deps, [1, 2]);
    expect(out.kind).toBe("candidate");
    if (out.kind !== "candidate") return;
    const c = out.candidate;
    expect(c.base.sha).toBe(repo.main());
    expect(c.steps.map((s) => s.pr)).toEqual([1, 2]);
    // The same merges done by git in a checkout give the same tree.
    sh(repo.author, "checkout", "--quiet", "-B", "check", "origin/main");
    sh(repo.author, "merge", "--quiet", "--no-ff", "-m", "m1", "pr-1");
    sh(repo.author, "merge", "--quiet", "--no-ff", "-m", "m2", "pr-2");
    expect(c.tree).toBe(sh(repo.author, "rev-parse", "HEAD^{tree}"));
    expect(sh(repo.work, "rev-parse", `${c.sha}^1`)).toBe(c.steps[0]!.commit);
    expect(sh(repo.work, "rev-parse", `${c.sha}^2`)).toBe(c.steps[1]!.head);
    // Unreferenced: no branch or ref points at the candidate.
    expect(sh(repo.work, "for-each-ref", "--contains", c.sha)).toBe("");
  });

  it("gives the same candidate SHA when planned again", async () => {
    const { deps } = setup({ 1: { "b.txt": "b\n" }, 2: { "c.txt": "c\n" } });
    const a = await buildCandidate(deps, [1, 2]);
    const b = await buildCandidate(deps, [1, 2]);
    expect(
      a.kind === "candidate" && b.kind === "candidate" && a.candidate.sha === b.candidate.sha,
    ).toBe(true);
  });

  it("reports the first conflict with its files", async () => {
    const { deps } = setup({
      1: { "b.txt": "b\n" },
      2: { "a.txt": "one\nTWO\nthree\n" },
      3: { "a.txt": "one\n2\nthree\n", "c.txt": "c\n" },
    });
    const out = await buildCandidate(deps, [1, 2, 3]);
    expect(out).toEqual({ kind: "conflict", pr: 3, files: ["a.txt"], before: [1, 2] });
  });

  it("refuses when the fetched head is not the head GitHub reports", async () => {
    const { deps, pulls } = setup({ 1: { "b.txt": "b\n" } });
    pulls.get(1)!.head = "0".repeat(40);
    const out = await buildCandidate(deps, [1]);
    expect(out.kind).toBe("error");
    expect(out.kind === "error" && out.message).toMatch(
      /PR #1: fetched head .* but GitHub reports 000000000/,
    );
  });

  it("refuses merged or closed PRs and duplicates", async () => {
    const { deps, pulls } = setup({ 1: { "b.txt": "b\n" }, 2: { "c.txt": "c\n" } });
    pulls.get(2)!.state = "closed";
    expect(await buildCandidate(deps, [1, 2])).toEqual({
      kind: "error",
      message: "PR #2 is closed",
    });
    expect(await buildCandidate(deps, [1, 1])).toEqual({
      kind: "error",
      message: "a PR is named twice",
    });
  });

  it("records a stacked PR's base and merges its full head", async () => {
    const { deps } = setup({ 1: { "b.txt": "b\n" }, 2: { "c.txt": "c\n" } }, { 2: "1" });
    const out = await buildCandidate(deps, [1, 2]);
    expect(out.kind === "candidate" && out.candidate.steps.map((s) => s.baseRef)).toEqual([
      "main",
      "pr-1",
    ]);
  });
});
