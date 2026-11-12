// FILE: tools/queue/test/executor.test.ts
// Purpose: The local executor (checkout, tree check, install, lane command, log) and the remote
//          executor (tree sync by patch, explicit shard script, polling, logs), with a fake runner.
// Layer: test

import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { LocalExecutor, type HeavyLock } from "../lib/executor.ts";
import { Git } from "../lib/git.ts";
import { laneByName } from "../lib/lanes.ts";
import { RemoteError, RemoteExecutor, remoteScript } from "../lib/remote.ts";
import { mergeEnv } from "../lib/runner.ts";
import {
  cleanup,
  FakeRunner,
  fixture,
  makeRepo,
  ok,
  sh,
  testConfig,
  type Repo,
} from "./helpers.ts";

let repo: Repo | undefined;
afterEach(() => {
  if (repo) cleanup(repo.root);
  repo = undefined;
});

const lock = (): HeavyLock & { held: string[] } => {
  const held: string[] = [];
  return {
    held,
    async hold(label, _sha, fn) {
      held.push(label);
      return fn();
    },
  };
};

describe("LocalExecutor", () => {
  const setup = (
    answers: Record<string, { code: number; out: string }> = {},
    queue: Record<string, unknown> = {},
  ) => {
    repo = makeRepo();
    const cfg = testConfig(
      repo.root,
      { checkout: repo.work, ...queue },
      { tools: { git: "git", gh: "gh", bun: "/opt/bun/bun" } },
    );
    const runner = new FakeRunner().on((call) => {
      if (call.cmd === "/opt/bun/bun" && call.args[0] === "install")
        return ok("", answers.install?.code ?? 0);
      if (call.cmd.includes("vitest"))
        return ok(
          answers.vitest?.out ?? fixture("batch5/lane-desktop.txt"),
          answers.vitest?.code ?? 1,
        );
      return undefined;
    });
    const git = new Git(runner, "git", repo.work);
    const logsDir = path.join(repo.root, "logs");
    const exec = new LocalExecutor({ runner, git, cfg, lock: lock(), logsDir, platform: "linux" });
    const commit = sh(repo.work, "rev-parse", "HEAD");
    const tree = sh(repo.work, "rev-parse", "HEAD^{tree}");
    return { repo, runner, exec, commit, tree, logsDir };
  };

  it("checks out the commit, installs once, runs the lane and keeps its log", async () => {
    const { runner, exec, commit, tree, logsDir, repo } = setup();
    const lane = laneByName("desktop")!;
    const run = await exec.session("t", commit, async () => {
      await exec.run({ lane, commit, tree, label: "lane-desktop" });
      return exec.run({
        lane,
        commit,
        tree,
        label: "rerun-desktop",
        selection: { files: ["src/appSnapManager.test.ts"] },
      });
    });
    expect(runner.find("/opt/bun/bun", "install")).toHaveLength(1);
    const calls = runner.calls.filter((c) => c.cmd.includes("vitest"));
    expect(calls[0]!.cmd).toBe(
      path.join(repo.work, "apps/desktop", "node_modules", ".bin", "vitest"),
    );
    expect(calls[0]!.options.cwd).toBe(path.join(repo.work, "apps/desktop"));
    expect(calls[1]!.args.slice(-2)).toEqual([
      "--no-file-parallelism",
      "src/appSnapManager.test.ts",
    ]);
    expect(calls[0]!.options.env).toMatchObject({
      CLAUDE_CODE_CHILD_SESSION: null,
      PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: null,
    });
    expect(String(calls[0]!.options.env!.PATH).startsWith(`/opt/bun${path.delimiter}`)).toBe(true);
    expect(run).toMatchObject({ status: "failed", target: "local", code: 1 });
    expect(run.failures).toHaveLength(3);
    const log = fs.readFileSync(path.join(logsDir, "rerun-desktop.log"), "utf8");
    expect(log).toMatch(
      /^# queue: .*vitest run --passWithNoTests --maxWorkers=4 --no-file-parallelism/,
    );
    expect(log).toContain("Test Files  2 failed");
    expect(sh(repo.work, "rev-parse", "HEAD")).toBe(commit);
  });

  it("refuses a checkout with tracked changes, and a commit whose tree is not the expected one", async () => {
    const { exec, commit, tree, repo } = setup();
    const lane = laneByName("fmt")!;
    await expect(exec.run({ lane, commit, tree: "0".repeat(40), label: "x" })).rejects.toThrow(
      /its tree is/,
    );
    fs.writeFileSync(path.join(repo.work, "a.txt"), "dirty\n");
    await expect(exec.run({ lane, commit, tree, label: "x" })).rejects.toThrow(/tracked change/);
  });

  it("a failed install stops the run", async () => {
    const { exec, commit, tree } = setup({ install: { code: 1, out: "" } });
    await expect(exec.run({ lane: laneByName("fmt")!, commit, tree, label: "x" })).rejects.toThrow(
      /bun install --frozen-lockfile failed/,
    );
  });

  /** Makes the checkout look like a ws worktree: its bun store is a link to another install. */
  const linkInstall = (r: Repo, lockText: string) => {
    const source = path.join(r.root, "source");
    fs.mkdirSync(path.join(source, "node_modules", ".bun"), { recursive: true });
    fs.writeFileSync(path.join(source, "bun.lock"), lockText);
    fs.mkdirSync(path.join(r.work, "node_modules"), { recursive: true });
    fs.symlinkSync(
      path.join(source, "node_modules", ".bun"),
      path.join(r.work, "node_modules", ".bun"),
      process.platform === "win32" ? "junction" : "dir",
    );
    return source;
  };

  it("never installs into a checkout whose dependencies are linked from another", async () => {
    const { exec, commit, tree, runner, repo } = setup();
    linkInstall(repo, "lock\n");
    await expect(exec.run({ lane: laneByName("fmt")!, commit, tree, label: "x" })).rejects.toThrow(
      /links its dependencies from .*"queue.install": "linked"/,
    );
    expect(runner.find("/opt/bun/bun", "install")).toEqual([]);
  });

  it('"linked" runs on the linked install only when the commit has the same bun.lock', async () => {
    const { exec, runner, repo } = setup({}, { install: "linked" });
    runner.on((call) => (call.args[0] === "run" ? ok("") : undefined));
    fs.writeFileSync(path.join(repo.author, "bun.lock"), "lock v1\n");
    sh(repo.author, "add", "-A");
    sh(repo.author, "commit", "--quiet", "-m", "lock");
    sh(repo.author, "push", "--quiet", "origin", "HEAD:main");
    sh(repo.work, "fetch", "--quiet", "origin");
    const commit = sh(repo.work, "rev-parse", "origin/main");
    const tree = sh(repo.work, "rev-parse", "origin/main^{tree}");
    linkInstall(repo, "lock v1\r\n");
    const run = await exec.run({ lane: laneByName("fmt")!, commit, tree, label: "x" });
    expect(run.status).toBe("green");
    expect(runner.find("/opt/bun/bun", "install")).toEqual([]);
    fs.writeFileSync(path.join(repo.root, "source", "bun.lock"), "lock v2\n");
    const other = new LocalExecutor({
      runner,
      git: new Git(runner, "git", repo.work),
      cfg: testConfig(repo.root, { checkout: repo.work, install: "linked" }),
      lock: lock(),
      logsDir: path.join(repo.root, "logs"),
    });
    await expect(other.run({ lane: laneByName("fmt")!, commit, tree, label: "y" })).rejects.toThrow(
      /another bun.lock than the linked install/,
    );
  });
});

describe("mergeEnv", () => {
  it("replaces PATH case-insensitively on Windows and removes null keys", () => {
    const env = mergeEnv({ Path: "a", KEEP: "1", DROP: "x" }, { PATH: "b", DROP: null }, "win32");
    expect(env).toEqual({ KEEP: "1", PATH: "b" });
  });
});

describe("RemoteExecutor", () => {
  const remoteCfg = {
    ssh: "verify@second-machine",
    sshCommand: "ssh",
    sshOptions: ["-o", "BatchMode=yes"],
    workdir: "moss-verify",
    pathPrepend: ["~/moss-verify/bun", "/opt/homebrew/bin"],
    shards: { components: 3 },
    portBase: 53700,
    pollSeconds: 30,
    timeoutMinutes: 90,
  };

  it("generates explicit shard lines, no seq, and the lane's exact flags", () => {
    const script = remoteScript(
      remoteCfg,
      laneByName("components")!,
      "lane-components",
      "t".repeat(40),
      [
        { id: "s1", selection: { shard: "1/3" }, port: 53700 },
        { id: "s2", selection: { shard: "2/3" }, port: 53702 },
        { id: "s3", selection: { shard: "3/3" }, port: 53704 },
      ],
    );
    expect(script).not.toMatch(/\bseq\b/);
    expect(script).toContain(`R="$HOME"/moss-verify`);
    expect(script).toContain(`export PATH="$HOME"/moss-verify/bun:/opt/homebrew/bin:"$PATH"`);
    expect(script).toContain("unset CLAUDE_CODE_CHILD_SESSION PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH");
    expect(script).toContain(
      `( VITEST_BROWSER_API_PORT=53702 ./node_modules/.bin/vitest run --config vitest.browser.ci.config.ts --project=components --browser.api.port=53702 --browser.api.strictPort --browser.connectTimeout=300000 --shard=2/3 > "$O/s2.log" 2>&1; echo "s2 exit=$?" ) &`,
    );
    expect(script.match(/\) &$/gm)).toHaveLength(3);
    expect(script).toMatch(/wait\necho "QUEUE-DONE ok"/);
  });

  const remoteSetup = (opts: {
    haveTree?: (want: string) => string;
    got?: (want: string) => string;
    shardOut?: Record<string, string>;
    codes?: Record<string, number>;
  }) => {
    repo = makeRepo();
    const baseTree = sh(repo.work, "rev-parse", "HEAD^{tree}");
    fs.writeFileSync(path.join(repo.work, "bin.dat"), Buffer.from([0, 1, 2, 255, 254]));
    fs.writeFileSync(path.join(repo.work, "a.txt"), "changed\n");
    sh(repo.work, "add", "-A");
    sh(repo.work, "commit", "--quiet", "-m", "candidate");
    const want = sh(repo.work, "rev-parse", "HEAD^{tree}");
    const commands: string[] = [];
    let patch: Buffer | undefined;
    let script = "";
    let polls = 0;
    const runner = new FakeRunner().on((call) => {
      if (call.cmd !== "ssh") return undefined;
      expect(call.args.slice(0, 3)).toEqual(["-o", "BatchMode=yes", "verify@second-machine"]);
      const c = call.args[3]!;
      commands.push(c);
      if (c.includes("git reset -q --hard"))
        return ok(`${opts.haveTree ? opts.haveTree(baseTree) : baseTree}\n`);
      if (c.includes("git apply")) {
        patch = gunzipSync(Buffer.from(call.options.input as Uint8Array));
        return ok(`${opts.got ? opts.got(want) : want}\n`);
      }
      if (c.includes("commit -q")) return ok("");
      if (c.includes("cat > ")) {
        script = String(call.options.input);
        return ok("");
      }
      if (c.startsWith("nohup")) return ok("started\n");
      if (c.endsWith(".out")) {
        polls += 1;
        const codes = opts.codes ?? {};
        return polls < 2
          ? ok("install exit=0\n")
          : ok(
              `install exit=0\n${["s1", "s2", "s3"].map((s) => `${s} exit=${codes[s] ?? 0}`).join("\n")}\nQUEUE-DONE ok\n`,
            );
      }
      const m = /\/(s\d)\.log$/.exec(c);
      if (m)
        return ok(
          opts.shardOut?.[m[1]!] ??
            " Test Files  120 passed (120)\n      Tests  700 passed (700)\n",
        );
      throw new Error(`unexpected ssh ${c}`);
    });
    const git = new Git(runner, "git", repo.work);
    const exec = new RemoteExecutor({
      runner,
      git,
      cfg: remoteCfg,
      logsDir: path.join(repo.root, "logs"),
      log: () => {},
      sleep: async () => {},
    });
    return { exec, want, baseTree, commands, getPatch: () => patch, getScript: () => script };
  };

  it("sends only the difference, proves the tree, runs three shards and reads their logs", async () => {
    const { exec, want, commands, getPatch, getScript } = remoteSetup({
      shardOut: { s2: fixture("misc/components-fail.txt") },
      codes: { s2: 1 },
    });
    const run = await exec.run({
      lane: laneByName("components")!,
      commit: "c".repeat(40),
      tree: want,
      label: "lane-components",
    });
    expect(getPatch()!.toString("latin1")).toMatch(/GIT binary patch/);
    expect(commands.some((c) => c.includes("commit -q --no-verify"))).toBe(true);
    expect(getScript()).toContain("--shard=3/3");
    expect(run.status).toBe("failed");
    expect(run.failures).toEqual([
      {
        file: "src/components/settings/ImportSettingsPanel.browser.tsx",
        name: "Settings → Import > lists conversations from the same agents as onboarding and probes only tools",
      },
    ]);
    expect(run.shards!.map((s) => `${s.shard}:${s.status}`)).toEqual([
      "1/3:green",
      "2/3:failed",
      "3/3:green",
    ]);
  });

  it("a rerun of files is one process with the explicit list", async () => {
    const { exec, want, getScript } = remoteSetup({});
    const run = await exec.run({
      lane: laneByName("components")!,
      commit: "c".repeat(40),
      tree: want,
      label: "rerun-components",
      selection: { files: ["src/a.browser.tsx", "src/b c.browser.tsx"] },
    });
    expect(getScript().match(/\) &$/gm)).toHaveLength(1);
    expect(getScript()).toContain(
      "--no-file-parallelism src/a.browser.tsx 'src/b c.browser.tsx' > \"$O/s1.log\"",
    );
    expect(run.status).toBe("green");
    // A whole-lane judgement rerun is one process too, never sharded.
    await exec.run({
      lane: laneByName("components")!,
      commit: "c".repeat(40),
      tree: want,
      label: "rerun-components",
      alone: true,
    });
    expect(getScript().match(/\) &$/gm)).toHaveLength(1);
    expect(getScript()).not.toContain("--shard=");
  });

  it("stops on a tree mismatch, and on a remote tree this repository does not know", async () => {
    const bad = remoteSetup({ got: () => "f".repeat(40) });
    await expect(bad.exec.sync(bad.want)).rejects.toThrow(RemoteError);
    await expect(bad.exec.sync(bad.want)).rejects.toThrow(
      /TREE MISMATCH .* want [0-9a-f]{40}, got f{40}/,
    );
    cleanup(repo!.root);
    const unknown = remoteSetup({ haveTree: () => "a".repeat(40) });
    await expect(unknown.exec.sync(unknown.want)).rejects.toThrow(/does not know/);
  });

  it("sends nothing when the remote already has the tree", async () => {
    const { exec, want, commands } = remoteSetup({ haveTree: () => "" });
    // haveTree "" makes the first probe fail three times: unreachable.
    await expect(exec.sync(want)).rejects.toThrow(/unreachable/);
    cleanup(repo!.root);
    const same = remoteSetup({});
    await same.exec.sync(same.baseTree);
    expect(same.commands.filter((c) => c.includes("git apply"))).toEqual([]);
    expect(commands.length).toBe(3);
  });
});
