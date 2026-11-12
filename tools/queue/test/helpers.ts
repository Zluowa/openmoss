// FILE: tools/queue/test/helpers.ts
// Purpose: Test fixtures for the queue: a fake runner, temporary git repositories with a bare
//          "origin" that carries refs/pull/<n>/head, a fake GitHub on top of it, and log excerpts.
// Layer: test support
// Exports: FakeRunner, tempDir, cleanup, sh, makeRepo, fakeGitHub, fixture, testConfig, ok

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseProfile } from "../../ws/lib/profile.ts";
import { parseQueueConfig, type QueueConfig } from "../lib/config.ts";
import { realRunner, type Runner, type RunOptions, type RunResult } from "../lib/runner.ts";

export const ok = (stdout = "", code = 0, stderr = ""): RunResult => ({ code, stdout, stderr });

export interface Call {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly options: RunOptions;
}

type Handler = (call: Call) => RunResult | Promise<RunResult> | undefined;

/** A runner that answers from handlers; git falls through to the real git unless a handler answers. */
export class FakeRunner implements Runner {
  readonly calls: Call[] = [];
  private readonly handlers: Handler[] = [];
  constructor(private readonly passGit = true) {}

  on(handler: Handler): this {
    this.handlers.push(handler);
    return this;
  }

  async run(cmd: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    const call = { cmd, args, options };
    this.calls.push(call);
    for (const h of this.handlers) {
      const r = await h(call);
      if (r) return r;
    }
    if (this.passGit && cmd === "git") return realRunner.run(cmd, args, options);
    throw new Error(`FakeRunner: unexpected ${cmd} ${args.join(" ")}`);
  }

  /** Calls whose program is `cmd` (and whose arguments include every `has`). */
  find(cmd: string, ...has: string[]): Call[] {
    return this.calls.filter((c) => c.cmd === cmd && has.every((h) => c.args.includes(h)));
  }
}

export function tempDir(prefix: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `queue-${prefix}-`)));
}

export function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "queue test",
  GIT_AUTHOR_EMAIL: "queue@example.invalid",
  GIT_COMMITTER_NAME: "queue test",
  GIT_COMMITTER_EMAIL: "queue@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

/** Runs git and returns trimmed stdout; throws on failure. */
export function sh(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

export interface Repo {
  readonly root: string;
  /** Bare repository standing in for GitHub. */
  readonly origin: string;
  /** The checkout the queue works in. */
  readonly work: string;
  /** A scratch clone to author commits in. */
  readonly author: string;
  /** Commits a change on a new branch from `from` and publishes it as refs/pull/<n>/head. */
  pr(n: number, files: Record<string, string>, from?: string): string;
  /** Moves origin's main to a new commit with these files. */
  advanceMain(files: Record<string, string>): string;
  main(): string;
}

export function makeRepo(): Repo {
  const root = tempDir("repo");
  const origin = path.join(root, "origin.git");
  const author = path.join(root, "author");
  const work = path.join(root, "work");
  sh(root, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  sh(root, "init", "--quiet", "--initial-branch=main", author);
  fs.writeFileSync(path.join(author, "a.txt"), "one\ntwo\nthree\n");
  fs.mkdirSync(path.join(author, "apps", "web"), { recursive: true });
  fs.writeFileSync(path.join(author, "apps", "web", "x.ts"), "export const x = 1;\n");
  sh(author, "add", "-A");
  sh(author, "commit", "--quiet", "-m", "base");
  sh(author, "remote", "add", "origin", origin);
  sh(author, "push", "--quiet", "origin", "main");
  sh(root, "clone", "--quiet", origin, work);
  const write = (files: Record<string, string>) => {
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(author, file)), { recursive: true });
      fs.writeFileSync(path.join(author, file), text);
    }
    sh(author, "add", "-A");
  };
  return {
    root,
    origin,
    work,
    author,
    pr(n, files, from = "origin/main") {
      sh(author, "fetch", "--quiet", "origin");
      sh(author, "checkout", "--quiet", "-B", `pr-${n}`, from);
      write(files);
      sh(author, "commit", "--quiet", "-m", `change ${n}`);
      const head = sh(author, "rev-parse", "HEAD");
      sh(author, "push", "--quiet", "--force", "origin", `HEAD:refs/pull/${n}/head`);
      return head;
    },
    advanceMain(files) {
      sh(author, "fetch", "--quiet", "origin");
      sh(author, "checkout", "--quiet", "-B", "main", "origin/main");
      write(files);
      sh(author, "commit", "--quiet", "-m", "main moves");
      sh(author, "push", "--quiet", "origin", "main");
      return sh(author, "rev-parse", "HEAD");
    },
    main: () => sh(origin, "rev-parse", "refs/heads/main"),
  };
}

export interface FakePull {
  number: number;
  title: string;
  head: string;
  headRef: string;
  baseRef: string;
  state: "open" | "closed";
  merged: boolean;
  mergeCommit?: string | undefined;
}

/**
 * `gh api` against the bare origin: GET a pull, PATCH its base, PUT a merge (a real merge commit
 * on origin's main, refused when the pinned sha is not the head). `tamper` makes a merge produce a
 * different tree, as if something else landed in between.
 */
export function fakeGitHub(
  repo: Repo,
  pulls: Map<number, FakePull>,
  options: { tamper?: number[] } = {},
) {
  const writes: string[] = [];
  const handler: Handler = (call) => {
    if (call.cmd !== "gh" || call.args[0] !== "api") return undefined;
    const args = call.args.slice(1);
    const method = args[0] === "-X" ? args[1]! : "GET";
    const route = args.find((a) => a.startsWith("repos/"))!;
    const n = Number(/pulls\/(\d+)/.exec(route)![1]);
    const p = pulls.get(n);
    if (!p) return ok(JSON.stringify({ message: "Not Found" }), 1, "gh: Not Found (HTTP 404)");
    const field = (k: string) => args.find((a) => a.startsWith(`${k}=`))?.slice(k.length + 1);
    const view = () =>
      ok(
        JSON.stringify({
          number: p.number,
          title: p.title,
          state: p.state,
          merged: p.merged,
          merge_commit_sha: p.mergeCommit ?? null,
          head: { sha: p.head, ref: p.headRef },
          base: { ref: p.baseRef },
        }),
      );
    if (method === "GET") return view();
    if (method === "PATCH") {
      writes.push(`PATCH ${n} base=${field("base")}`);
      p.baseRef = field("base")!;
      return view();
    }
    writes.push(`PUT ${n} sha=${field("sha")} method=${field("merge_method")}`);
    if (p.merged)
      return ok(JSON.stringify({ message: "Pull Request is not mergeable" }), 1, "gh: (HTTP 405)");
    if (field("sha") !== p.head)
      return ok(JSON.stringify({ message: "Head branch was modified" }), 1, "gh: (HTTP 409)");
    if (p.baseRef !== "main")
      return ok(JSON.stringify({ message: "Base is not main" }), 1, "gh: (HTTP 405)");
    const main = repo.main();
    const out = spawnSync("git", ["merge-tree", "--write-tree", main, p.head], {
      cwd: repo.origin,
      encoding: "utf8",
    });
    let tree = out.stdout.split("\n")[0]!.trim();
    if (options.tamper?.includes(n)) tree = sh(repo.origin, "rev-parse", `${main}^{tree}`);
    const commit = sh(
      repo.origin,
      "commit-tree",
      tree,
      "-p",
      main,
      "-p",
      p.head,
      "-m",
      `Merge pull request #${n}`,
    );
    sh(repo.origin, "update-ref", "refs/heads/main", commit);
    p.merged = true;
    p.state = "closed";
    p.mergeCommit = commit;
    return ok(
      JSON.stringify({ sha: commit, merged: true, message: "Pull Request successfully merged" }),
    );
  };
  return { handler, writes };
}

const FIXTURES = path.join(import.meta.dirname, "fixtures");

export function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

/** A queue configuration for a test machine rooted at `dir`. */
export function testConfig(
  dir: string,
  queue: Record<string, unknown> = {},
  profileExtra: Record<string, unknown> = {},
): QueueConfig {
  const raw = {
    primaryCheckout: path.join(dir, "primary"),
    worktreeRoot: path.join(dir, "wt"),
    githubRepo: "owner/repo",
    tools: { git: "git", gh: "gh", bun: "bun" },
    ...profileExtra,
    queue: { checkout: path.join(dir, "work"), mergeLog: path.join(dir, "merge-log.md"), ...queue },
  };
  const profilePath = path.join(dir, "profile.json");
  return parseQueueConfig(parseProfile(raw, profilePath), raw);
}
