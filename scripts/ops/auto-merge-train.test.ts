import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  computeMergeTree,
  detectSetBackFiles,
  evaluatePullRequest,
  findEscalationPaths,
  parseLatestVerdictComment,
  type PullRequestCandidate,
} from "./auto-merge-train.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function basePr(overrides: Partial<PullRequestCandidate> = {}): PullRequestCandidate {
  const head = "1111111111111111111111111111111111111111";
  return {
    number: 1051,
    title: "fix(chat): keep composer draft intact",
    headRefOid: head,
    baseRefName: "main",
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    labels: [],
    changedFiles: ["apps/web/src/components/ChatView.tsx"],
    comments: [
      { body: `MOSS-GATES: PASS ${head}\n- CI: success` },
      { body: `MOSS-REVIEW: APPROVE ${head}\nAll rules pass.` },
    ],
    ...overrides,
  };
}

describe("Layer 4 Auto-Merge Train", () => {
  it("approves clean mergeable PRs with green gates & review on exact head SHA", () => {
    const decision = evaluatePullRequest(basePr());
    expect(decision.action).toBe("merge");
    expect(decision.escalations).toEqual([]);
  });

  it("ignores stale verdicts from previous heads and rejects unapproved/conflicting PRs", () => {
    const oldHead = "0000000000000000000000000000000000000000";
    const newHead = "2222222222222222222222222222222222222222";
    const pr = basePr({
      headRefOid: newHead,
      mergeable: "CONFLICTING",
      comments: [
        { body: `MOSS-GATES: PASS ${oldHead}` },
        { body: `MOSS-REVIEW: APPROVE ${oldHead}` },
      ],
    });
    expect(parseLatestVerdictComment(pr.comments, "MOSS-GATES", newHead)).toBe("NONE");
    const decision = evaluatePullRequest(pr);
    expect(decision.action).toBe("skip");
    expect(decision.reasons).toContain("mergeable=CONFLICTING");
    expect(decision.reasons).toContain("MOSS-GATES=NONE");
    expect(decision.reasons).toContain("MOSS-REVIEW=NONE");
  });

  it("escalates PRs touching migrations, mirror guard, publish scripts, or manifests without LEAD-SIGN-OFF", () => {
    const matches = findEscalationPaths([
      "apps/server/src/persistence/Migrations.ts",
      "scripts/public-mirror/config.ts",
      "apps/web/src/App.tsx",
    ]);
    expect(matches.map((m) => m.reason)).toEqual([
      "database migration",
      "public-mirror export tool/guard",
    ]);

    const escalated = evaluatePullRequest(
      basePr({ changedFiles: ["apps/server/src/persistence/Migrations.ts"] }),
    );
    expect(escalated.action).toBe("escalate");

    const head = "1111111111111111111111111111111111111111";
    const cleared = evaluatePullRequest(
      basePr({
        changedFiles: ["apps/server/src/persistence/Migrations.ts"],
        comments: [
          { body: `MOSS-GATES: PASS ${head}` },
          { body: `MOSS-REVIEW: APPROVE ${head}` },
          { body: `LEAD-SIGN-OFF: verified migration on ${head}` },
        ],
      }),
    );
    expect(cleared.action).toBe("merge");
  });

  it("detects set-back blobs and computes merge-tree cleanly in a real git repo", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "moss-merge-train-"));
    tempDirs.push(repo);
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true }).trim();

    git(["init", "-b", "main"]);
    git(["config", "user.email", "test@moss.local"]);
    git(["config", "user.name", "Moss Test"]);
    writeFileSync(path.join(repo, "a.txt"), "v1\n");
    git(["add", "a.txt"]);
    git(["commit", "-m", "v1"]);

    git(["checkout", "-b", "stale-pr"]);
    writeFileSync(path.join(repo, "a.txt"), "v1\n");
    writeFileSync(path.join(repo, "b.txt"), "feature\n");
    git(["add", "b.txt"]);
    git(["commit", "-m", "stale feature"]);
    const staleHead = git(["rev-parse", "HEAD"]);

    git(["checkout", "main"]);
    writeFileSync(path.join(repo, "a.txt"), "v2\n");
    git(["add", "a.txt"]);
    git(["commit", "-m", "v2 on main"]);
    const mainHead = git(["rev-parse", "HEAD"]);

    // Rewrite stale-pr to explicitly carry v1 of a.txt (simulating git reset --soft set-back)
    git(["checkout", "-b", "bad-reset", mainHead]);
    writeFileSync(path.join(repo, "a.txt"), "v1\n");
    git(["add", "a.txt"]);
    git(["commit", "-m", "oops sets a.txt back to v1"]);
    const badHead = git(["rev-parse", "HEAD"]);

    expect(detectSetBackFiles(repo, mainHead, badHead, ["a.txt"])).toEqual(["a.txt"]);
    expect(detectSetBackFiles(repo, mainHead, staleHead, ["b.txt"])).toEqual([]);
    expect(computeMergeTree(repo, mainHead, staleHead)).toMatch(/^[0-9a-f]{40}$/);
  });
});
