// FILE: tools/queue/test/judge.test.ts
// Purpose: The judgement and the verify run, from recorded lane outputs (excerpts of the
//          coordinator's real logs of batch 5, where #564 broke the compiler lane and five other
//          lanes failed only once).
// Layer: test

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyOutput,
  ExecutorError,
  type Executor,
  type LaneRun,
  type RunRequest,
} from "../lib/executor.ts";
import type { Git } from "../lib/git.ts";
import { judge } from "../lib/judge.ts";
import { LANES } from "../lib/lanes.ts";
import { RemoteError } from "../lib/remote.ts";
import { CandidateStore, readJson, type Candidate } from "../lib/state.ts";
import { verify, type Verdict } from "../lib/verify.ts";
import { cleanup, fixture, tempDir } from "./helpers.ts";

const sha = (c: string) => c.repeat(40);
const BASE = sha("b");

function candidateOf(prs: number[]): Candidate {
  return {
    version: 1,
    repo: "owner/repo",
    createdAt: "2026-11-13T00:00:00.000Z",
    base: { ref: "origin/main", sha: BASE, tree: sha("e") },
    steps: prs.map((pr, i) => ({
      pr,
      title: `PR ${pr}`,
      head: `${pr}`.padEnd(40, "0"),
      headRef: `b${pr}`,
      baseRef: "main",
      commit: `c${i}`.padEnd(40, "0"),
      tree: `d${i}`.padEnd(40, "0"),
    })),
    sha: `c${prs.length - 1}`.padEnd(40, "0"),
    tree: `d${prs.length - 1}`.padEnd(40, "0"),
  };
}

type Answer = { code: number; output: string } | Error;

/** An executor that answers each run from a table keyed by its label (falls back to `lane-*` green). */
class FakeExecutor implements Executor {
  readonly requests: RunRequest[] = [];
  sessions = 0;
  constructor(
    readonly target: "local" | "remote",
    private readonly answers: Record<string, Answer | ((r: RunRequest) => Answer)>,
  ) {}
  async session<T>(_l: string, _c: string, fn: () => Promise<T>) {
    this.sessions += 1;
    return fn();
  }
  async run(request: RunRequest): Promise<LaneRun> {
    this.requests.push(request);
    const raw = this.answers[request.label];
    const a = typeof raw === "function" ? raw(request) : (raw ?? { code: 0, output: "" });
    if (a instanceof Error) throw a;
    return {
      lane: request.lane.name,
      label: request.label,
      target: this.target,
      commit: request.commit,
      code: a.code,
      seconds: 1,
      ...classifyOutput(request.lane, a.code, a.output),
      log: `${request.label}.log`,
      selection: request.selection,
      shards: undefined,
      finishedAt: "2026-11-13T00:00:00.000Z",
    };
  }
  labels() {
    return this.requests.map((r) => r.label);
  }
}

/** The parts of Git the judgement uses, with files each PR changes. */
function fakeGit(changed: Record<number, string[]>, missingOnBase: string[] = []): Git {
  return {
    exists: async (spec: string) => !missingOnBase.some((m) => spec.endsWith(`:${m}`)),
    changedFiles: async (_base: string, head: string) =>
      changed[Number(head.replace(/0+$/, ""))] ?? [],
    commitTime: async () => 1_700_000_000,
    mergeTree: async (_a: string, b: string) => ({
      tree: `t${b.slice(0, 3)}`.padEnd(40, "0"),
      conflicts: [],
    }),
    commitTree: async (tree: string) => `s${tree.slice(1, 4)}`.padEnd(40, "0"),
  } as unknown as Git;
}

const f = (name: string, code = 1) => ({ code, output: fixture(name) });
const green = (files = 1) => ({
  code: 0,
  output: ` Test Files  ${files} passed (${files})\n      Tests  ${files} passed (${files})\n`,
});

let dir: string | undefined;
afterEach(() => {
  if (dir) cleanup(dir);
  dir = undefined;
});

describe("judge: batch 5 as it happened", () => {
  const batch = () => {
    const candidate = candidateOf([564, 568, 569, 570]);
    const local = new FakeExecutor("local", {
      "lane-compiler": f("batch5/lane-compiler.txt"),
      "lane-chat": f("batch5/lane-chat.txt"),
      "lane-desktop": f("batch5/lane-desktop.txt"),
      "lane-shared": f("batch5/lane-shared.txt"),
      "lane-server": f("batch5/lane-server.txt"),
      "lane-contracts": f("batch5/lane-contracts.txt", 0),
      "lane-web": f("batch5/lane-web.txt", 0),
      "lane-scripts": f("batch5/lane-scripts.txt", 0),
      "rerun-compiler": f("batch5/rerun-compiler.txt"),
      "rerun-chat": f("batch5/rerun-chat.txt", 0),
      "rerun-desktop": f("batch5/rerun-desktop.txt", 0),
      "rerun-shared": f("batch5/rerun-shared.txt", 0),
      "rerun-server": f("batch5/rerun-server.txt", 0),
      "control-compiler": f("batch5/pr-568-compiler.txt", 0),
      "pr-564-compiler": f("batch5/pr-564-compiler.txt"),
      "pr-568-compiler": f("batch5/pr-568-compiler.txt", 0),
      "pr-569-compiler": f("batch5/pr-569-compiler.txt", 0),
    });
    const remote = new FakeExecutor("remote", { "lane-components": green(368) });
    const git = fakeGit({
      564: ["apps/web/src/components/chat/MessagesTimeline.tsx"],
      568: ["apps/web/src/lib/x.ts", "apps/server/src/y.ts"],
      569: ["apps/web/src/z.ts"],
      570: ["apps/server/src/account/a.ts"],
    });
    return { candidate, local, remote, git };
  };

  it("names #564 for the compiler lane and lists the rest as flaky", async () => {
    dir = tempDir("verify");
    const { candidate, local, remote, git } = batch();
    const store = new CandidateStore(dir);
    store.save(candidate);
    const lines: string[] = [];
    const verdict = await verify({
      candidate,
      store,
      git,
      local,
      remote,
      log: (l) => lines.push(l),
    });

    expect(verdict.result).toBe("red");
    expect(verdict.complete).toBe(true);
    const real = verdict.failures.filter((x) => x.classification === "real");
    expect(real).toHaveLength(3);
    expect(real.every((x) => x.lane === "compiler" && x.culprits.join() === "564")).toBe(true);
    expect(verdict.culprits).toEqual([{ pr: 564, lanes: ["compiler"], failures: 3 }]);
    const flaky = verdict.failures.filter((x) => x.classification === "flaky");
    expect(new Set(flaky.map((x) => x.lane))).toEqual(
      new Set(["chat", "desktop", "shared", "server"]),
    );
    expect(flaky.map((x) => x.quarantineId)).toContain(
      "shared:packages/shared/src/mossProjectionMaterializer.test.ts > materializeMossProjection > is idempotent: second run reports zero created/updated/conflict and leaves bytes unchanged",
    );
    // #570 touches only the server: it is not a suspect for a web lane.
    expect(local.labels().filter((l) => l.startsWith("pr-"))).toEqual([
      "pr-564-compiler",
      "pr-568-compiler",
      "pr-569-compiler",
    ]);
    // Reruns are alone: by name for the one-file chat lane, by file elsewhere.
    const rerun = (lane: string) =>
      local.requests.find((r) => r.label === `rerun-${lane}`)!.selection;
    expect(rerun("chat")).toEqual({
      names: [
        "ChatView transcript geometry (full app) > covers B2.2a reduced-motion coachmark and transition behavior",
      ],
    });
    expect(rerun("desktop")).toEqual({
      files: ["src/appSnapManager.test.ts", "src/cuaDriverHost.test.ts"],
    });
    // The components lane ran on the second machine, the rest here; static lanes ran.
    expect(remote.labels()).toEqual(["lane-components"]);
    expect(local.labels().slice(0, 5)).toEqual([
      "lane-fmt",
      "lane-lint",
      "lane-winruntime",
      "lane-migrations",
      "lane-typecheck",
    ]);

    const saved = readJson<Verdict>(store.file(candidate.sha, "verdict.json"))!;
    expect(saved.result).toBe("red");
    const summary = fs.readFileSync(store.file(candidate.sha, "summary.txt"), "utf8");
    expect(summary).toMatch(/^verdict RED: 3 real, \d+ flaky, 0 pre-existing$/m);
    expect(summary).toMatch(/culprits: #564 \(compiler: 3\)/);
    expect(lines.some((l) => /^compiler\s+failed/.test(l))).toBe(true);
    expect(
      readJson<{ runs: LaneRun[] }>(store.file(candidate.sha, "runs.json"))!.runs.length,
    ).toBeGreaterThan(LANES.length);
  });

  it("is green when every failure passes alone", async () => {
    dir = tempDir("verify");
    const { candidate, remote, git } = batch();
    const local = new FakeExecutor("local", {
      "lane-desktop": f("batch5/lane-desktop.txt"),
      "rerun-desktop": f("batch5/rerun-desktop.txt", 0),
    });
    const store = new CandidateStore(dir);
    const verdict = await verify({ candidate, store, git, local, remote, log: () => {} });
    expect(verdict.result).toBe("green");
    expect(verdict.failures.map((x) => x.classification)).toEqual(["flaky", "flaky", "flaky"]);
  });
});

const deps = (candidate: Candidate, local: Executor, git = fakeGit({})) => ({
  candidate,
  git,
  local,
  remote: undefined,
  record: () => {},
  log: () => {},
});

describe("judge: other outcomes", () => {
  it("a failure that fails on the base too is pre-existing", async () => {
    const local = new FakeExecutor("local", {
      "lane-desktop": f("batch5/lane-desktop.txt"),
      "rerun-desktop": f("batch5/lane-desktop.txt"),
      "control-desktop": f("batch5/lane-desktop.txt"),
    });
    const main = await local.run({
      lane: LANES.find((l) => l.name === "desktop")!,
      commit: "c",
      tree: "t",
      label: "lane-desktop",
    });
    const out = await judge(deps(candidateOf([1, 2]), local), [main]);
    expect(out.failures.map((x) => x.classification)).toEqual([
      "preexisting",
      "preexisting",
      "preexisting",
    ]);
    expect(local.labels().some((l) => l.startsWith("pr-"))).toBe(false);
  });

  it("a failing test file the base does not have is real without a control run", async () => {
    const output = " FAIL  src/new.test.ts > adds > a test\n Test Files  1 failed (1)\n";
    const local = new FakeExecutor("local", {
      "lane-server": { code: 1, output },
      "rerun-server": { code: 1, output },
      "pr-7-server": { code: 1, output },
    });
    const main = await local.run({
      lane: LANES.find((l) => l.name === "server")!,
      commit: "c",
      tree: "t",
      label: "lane-server",
    });
    const out = await judge(
      deps(
        candidateOf([7, 8]),
        local,
        fakeGit({ 7: ["apps/server/src/new.test.ts"], 8: ["apps/web/a.ts"] }, [
          "apps/server/src/new.test.ts",
        ]),
      ),
      [main],
    );
    expect(out.failures).toMatchObject([{ classification: "real", culprits: [7] }]);
    expect(local.labels()).toEqual(["lane-server", "rerun-server", "pr-7-server"]);
  });

  it("a static lane failing for real is pinned to the PR that fails it alone", async () => {
    const local = new FakeExecutor("local", {
      "lane-fmt": { code: 1, output: "a.ts" },
      "rerun-fmt": { code: 1, output: "a.ts" },
      "control-fmt": { code: 0, output: "" },
      "pr-1-fmt": { code: 0, output: "" },
      "pr-2-fmt": { code: 1, output: "a.ts" },
    });
    const main = await local.run({ lane: LANES[0]!, commit: "c", tree: "t", label: "lane-fmt" });
    const out = await judge(deps(candidateOf([1, 2]), local), [main]);
    expect(out.failures).toMatchObject([
      { lane: "fmt", file: "", classification: "real", culprits: [2] },
    ]);
    expect(local.requests.find((r) => r.label === "rerun-fmt")!.selection).toBeUndefined();
  });

  it("a failure no single PR reproduces is real, with no culprit", async () => {
    const local = new FakeExecutor("local", {
      "lane-web": f("batch5/lane-desktop.txt"),
      "rerun-web": f("batch5/lane-desktop.txt"),
      "control-web": green(),
    });
    const main = await local.run({
      lane: LANES.find((l) => l.name === "web")!,
      commit: "c",
      tree: "t",
      label: "lane-web",
    });
    const out = await judge(
      deps(candidateOf([1, 2]), local, fakeGit({ 1: ["apps/web/a"], 2: ["apps/web/b"] })),
      [main],
    );
    expect(out.failures.every((x) => x.classification === "real" && x.culprits.length === 0)).toBe(
      true,
    );
    expect(out.failures[0]!.note).toMatch(/only in combination/);
  });

  it("names the only PR of a one-PR batch without running anything more", async () => {
    const local = new FakeExecutor("local", {
      "lane-web": f("batch5/lane-desktop.txt"),
      "rerun-web": f("batch5/lane-desktop.txt"),
      "control-web": green(),
    });
    const main = await local.run({
      lane: LANES.find((l) => l.name === "web")!,
      commit: "c",
      tree: "t",
      label: "lane-web",
    });
    const out = await judge(deps(candidateOf([5]), local), [main]);
    expect(out.failures.every((x) => x.culprits.join() === "5")).toBe(true);
    expect(local.labels()).toEqual(["lane-web", "rerun-web", "control-web"]);
  });

  it("a broken lane is rerun whole and judged by the tests that fail then", async () => {
    const local = new FakeExecutor("local", {
      "lane-desktop": { code: 1, output: "Error: worker exited unexpectedly\n" },
      "rerun-desktop": f("batch5/lane-desktop.txt"),
      "control-desktop": f("batch5/rerun-desktop.txt", 0),
    });
    const main = await local.run({
      lane: LANES.find((l) => l.name === "desktop")!,
      commit: "c",
      tree: "t",
      label: "lane-desktop",
    });
    expect(main.status).toBe("broken");
    const out = await judge(deps(candidateOf([1]), local), [main]);
    expect(local.requests.find((r) => r.label === "rerun-desktop")!.selection).toBeUndefined();
    expect(local.requests.find((r) => r.label === "control-desktop")!.selection).toEqual({
      files: ["src/appSnapManager.test.ts", "src/cuaDriverHost.test.ts"],
    });
    expect(out.failures.map((x) => x.classification)).toEqual(["real", "real", "real"]);
  });

  it("a rerun that cannot start leaves the failure not judged", async () => {
    const local = new FakeExecutor("local", {
      "lane-desktop": f("batch5/lane-desktop.txt"),
      "rerun-desktop": new ExecutorError("checkout has tracked changes"),
    });
    const main = await local.run({
      lane: LANES.find((l) => l.name === "desktop")!,
      commit: "c",
      tree: "t",
      label: "lane-desktop",
    });
    const out = await judge(deps(candidateOf([1]), local), [main]);
    expect(out.failures.every((x) => x.classification === "unknown")).toBe(true);
    expect(out.notes[0]).toMatch(/could not rerun alone/);
  });
});

describe("verify", () => {
  const candidate = candidateOf([1, 2]);

  it("runs a remote lane locally when the second machine fails", async () => {
    dir = tempDir("verify");
    const local = new FakeExecutor("local", {});
    const remote = new FakeExecutor("remote", {
      "lane-components": new RemoteError("TREE MISMATCH on the remote machine"),
    });
    const verdict = await verify({
      candidate,
      store: new CandidateStore(dir),
      git: fakeGit({}),
      local,
      remote,
      log: () => {},
    });
    expect(verdict.result).toBe("green");
    expect(local.labels().at(-1)).toBe("lane-components");
    expect(verdict.notes[0]).toMatch(/remote run failed .*TREE MISMATCH.*ran it locally/);
  });

  it("without a second machine runs every lane locally", async () => {
    dir = tempDir("verify");
    const local = new FakeExecutor("local", {});
    await verify({
      candidate,
      store: new CandidateStore(dir),
      git: fakeGit({}),
      local,
      remote: undefined,
      log: () => {},
    });
    expect(local.labels()).toEqual(LANES.map((l) => `lane-${l.name}`));
  });

  it("--only gives a partial verdict; --resume skips lanes recorded green", async () => {
    dir = tempDir("verify");
    const store = new CandidateStore(dir);
    const first = new FakeExecutor("local", {
      "lane-lint": { code: 1, output: "x" },
      "rerun-lint": { code: 0, output: "" },
    });
    const partial = await verify(
      { candidate, store, git: fakeGit({}), local: first, remote: undefined, log: () => {} },
      { only: ["fmt", "lint"] },
    );
    expect(partial.complete).toBe(false);
    expect(partial.result).toBe("green");
    const second = new FakeExecutor("local", {});
    const all = await verify(
      { candidate, store, git: fakeGit({}), local: second, remote: undefined, log: () => {} },
      { resume: true },
    );
    expect(second.labels()).not.toContain("lane-fmt");
    expect(second.labels()).toContain("lane-lint");
    expect(all.complete).toBe(true);
    expect(all.lanes.find((l) => l.name === "fmt")!.resumed).toBe(true);
  });

  it("a setup failure (install, dirty checkout) makes the verdict broken", async () => {
    dir = tempDir("verify");
    const local = new FakeExecutor("local", {
      "lane-fmt": new ExecutorError("bun install --frozen-lockfile failed"),
    });
    const verdict = await verify({
      candidate,
      store: new CandidateStore(dir),
      git: fakeGit({}),
      local,
      remote: undefined,
      log: () => {},
    });
    expect(verdict).toMatchObject({ result: "broken", complete: false });
    expect(verdict.notes[0]).toMatch(/setup failed: bun install/);
    expect(
      fs.existsSync(path.join(new CandidateStore(dir).dirOf(candidate.sha), "summary.txt")),
    ).toBe(true);
  });
});
