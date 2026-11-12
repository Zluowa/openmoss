// FILE: tools/queue/lib/git.ts
// Purpose: The git operations the queue needs (fetch PR heads, in-memory merges, trees, patches),
//          all through the injectable Runner.
// Layer: tool library
// Exports: Git, GitError, MergeTreeResult, parseFetchHead

import fs from "node:fs";
import path from "node:path";
import type { Runner, RunOptions, RunResult } from "./runner.ts";

export class GitError extends Error {}

export interface MergeTreeResult {
  readonly tree: string;
  /** Conflicted paths; empty when the merge is clean. */
  readonly conflicts: readonly string[];
}

/** The commit each fetched ref landed on, from FETCH_HEAD lines (`<sha>\t[not-for-merge]\t<what> of <url>`). */
export function parseFetchHead(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.replaceAll("\r\n", "\n").split("\n")) {
    const m = /^([0-9a-f]{40,64})\t[^\t]*\t(.*?) of .*$/.exec(line);
    if (!m) continue;
    const what = m[2]!;
    const pull = /'refs\/pull\/(\d+)\/head'/.exec(what);
    if (pull) out.set(`pull/${pull[1]}`, m[1]!);
    const branch = /^branch '([^']+)'/.exec(what);
    if (branch) out.set(`branch/${branch[1]}`, m[1]!);
  }
  return out;
}

/** The fixed identity and date the queue's own commits are made with, so a plan is reproducible. */
export interface CommitIdentity {
  readonly name: string;
  readonly email: string;
  /** git date, e.g. `@1700000000 +0000`. */
  readonly date: string;
}

export class Git {
  constructor(
    private readonly runner: Runner,
    private readonly git: string,
    readonly dir: string,
    /** Extra `-c` arguments for commands that talk to the remote (a credential helper). */
    private readonly networkArgs: readonly string[] = [],
  ) {}

  raw(args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    return this.runner.run(this.git, ["-C", this.dir, ...args], {
      timeoutMs: 300_000,
      ...options,
    });
  }

  private async ok(args: readonly string[], options: RunOptions = {}): Promise<string> {
    const r = await this.raw(args, options);
    if (r.code !== 0) {
      const why = (r.stderr || r.stdout).trim().split("\n")[0] ?? "";
      throw new GitError(`git ${args[0]} failed (exit ${r.code}): ${why}`);
    }
    return r.stdout;
  }

  async revParse(spec: string): Promise<string> {
    return (await this.ok(["rev-parse", "--verify", "--quiet", `${spec}^{object}`])).trim();
  }

  async treeOf(commit: string): Promise<string> {
    return (await this.ok(["rev-parse", "--verify", `${commit}^{tree}`])).trim();
  }

  /** A blob's text, or "" when it does not exist. */
  async show(spec: string): Promise<string> {
    const r = await this.raw(["show", spec]);
    return r.code === 0 ? r.stdout : "";
  }

  async exists(spec: string): Promise<boolean> {
    return (await this.raw(["cat-file", "-e", spec])).code === 0;
  }

  /** Fetches the base branch (into its remote-tracking ref) and PR heads; returns FETCH_HEAD's map. */
  async fetch(remote: string, refspecs: readonly string[]): Promise<Map<string, string>> {
    const r = await this.runner.run(
      this.git,
      ["-C", this.dir, ...this.networkArgs, "fetch", "--quiet", "--no-tags", remote, ...refspecs],
      { timeoutMs: 600_000 },
    );
    if (r.code !== 0)
      throw new GitError(`git fetch failed (exit ${r.code}): ${r.stderr.trim().split("\n")[0]}`);
    const file = (await this.ok(["rev-parse", "--git-path", "FETCH_HEAD"])).trim();
    const full = path.isAbsolute(file) ? file : path.join(this.dir, file);
    return parseFetchHead(fs.readFileSync(full, "utf8"));
  }

  /** `git merge-tree --write-tree`: a merge computed in the object store, touching no checkout. */
  async mergeTree(ours: string, theirs: string): Promise<MergeTreeResult> {
    const r = await this.raw([
      "merge-tree",
      "--write-tree",
      "--name-only",
      "--no-messages",
      ours,
      theirs,
    ]);
    const lines = r.stdout.replaceAll("\r\n", "\n").split("\n");
    const tree = lines[0]?.trim() ?? "";
    if ((r.code === 0 || r.code === 1) && /^[0-9a-f]{40,64}$/.test(tree)) {
      const conflicts =
        r.code === 1
          ? [
              ...new Set(
                lines
                  .slice(1)
                  .map((l) => l.trim())
                  .filter(Boolean),
              ),
            ]
          : [];
      return { tree, conflicts };
    }
    throw new GitError(`git merge-tree failed (exit ${r.code}): ${r.stderr.trim().split("\n")[0]}`);
  }

  async commitTree(
    tree: string,
    parents: readonly string[],
    message: string,
    who: CommitIdentity,
  ): Promise<string> {
    const args = ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-m", message];
    return (
      await this.ok(args, {
        env: {
          GIT_AUTHOR_NAME: who.name,
          GIT_AUTHOR_EMAIL: who.email,
          GIT_AUTHOR_DATE: who.date,
          GIT_COMMITTER_NAME: who.name,
          GIT_COMMITTER_EMAIL: who.email,
          GIT_COMMITTER_DATE: who.date,
        },
      })
    ).trim();
  }

  /** Unix time of a commit's committer date. */
  async commitTime(commit: string): Promise<number> {
    return Number((await this.ok(["show", "-s", "--format=%ct", commit])).trim());
  }

  /** Files a PR changes: from its merge base with `base` to its head. */
  async changedFiles(base: string, head: string): Promise<string[]> {
    const out = await this.ok(["diff", "--name-only", "--no-renames", `${base}...${head}`]);
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  }

  /** A binary patch from one tree to another, raw bytes. */
  async diffBinary(from: string, to: string): Promise<{ patch: Buffer; files: number }> {
    const r = await this.raw(["diff", "--binary", "--full-index", "--no-renames", from, to], {
      binaryStdout: true,
      timeoutMs: 600_000,
    });
    if (r.code !== 0) throw new GitError(`git diff failed: ${r.stderr.trim().split("\n")[0]}`);
    const names = await this.ok(["diff", "--name-only", "--no-renames", from, to]);
    return {
      patch: r.stdoutBytes ?? Buffer.alloc(0),
      files: names.split("\n").filter((l) => l.trim()).length,
    };
  }

  /** Tracked changes in the checkout (untracked files do not count). */
  async trackedChanges(): Promise<string[]> {
    const out = await this.ok(["status", "--porcelain", "--untracked-files=no"]);
    return out.split("\n").filter((l) => l.trim());
  }

  async checkoutDetached(commit: string): Promise<void> {
    await this.ok(["checkout", "--quiet", "--detach", commit]);
  }
}
