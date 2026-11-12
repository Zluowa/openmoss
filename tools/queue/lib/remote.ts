// FILE: tools/queue/lib/remote.ts
// Purpose: Runs a lane on the second machine over ssh: sends only the difference from the tree it
//          already has, proves it arrived at exactly the wanted tree, runs the lane (sharded) in
//          the background and polls for the result, because the link drops now and then.
// Layer: tool library
// Exports: RemoteExecutor, RemoteError, remoteScript, remoteRoot
// Why: every remote command is generated here with explicit lists (no `seq`, no remote parsing),
//      so the remote side needs only bash, git, gunzip and the repo's own toolchain.

import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { RemoteConfig } from "./config.ts";
import {
  classifyOutput,
  type Executor,
  type Failure,
  type LaneRun,
  type LaneStatus,
  type RunRequest,
  type ShardRun,
} from "./executor.ts";
import type { Git } from "./git.ts";
import { LANE_ENV, laneCommand, type LaneSpec, type Selection } from "./lanes.ts";
import { shellQuote, type Runner } from "./runner.ts";

export class RemoteError extends Error {}

/** The remote work folder as a shell word: absolute, or under the remote user's home. */
export function remoteRoot(workdir: string): string {
  return workdir.startsWith("/") ? shellQuote(workdir) : `"$HOME"/${shellQuote(workdir)}`;
}

function remotePathEntry(entry: string): string {
  return entry.startsWith("~/") ? `"$HOME"/${shellQuote(entry.slice(2))}` : shellQuote(entry);
}

export interface RemoteJob {
  readonly id: string;
  readonly selection: Selection;
  readonly port: number;
}

/** The bash script that installs and runs `jobs` of one lane in parallel on the remote machine. */
export function remoteScript(
  cfg: RemoteConfig,
  lane: LaneSpec,
  label: string,
  tree: string,
  jobs: readonly RemoteJob[],
): string {
  const lines = [
    "#!/bin/bash",
    `# tools/queue: ${label}, tree ${tree}`,
    `R=${remoteRoot(cfg.workdir)}`,
    `O="$R/queue-logs/${label}"`,
  ];
  if (cfg.pathPrepend.length)
    lines.push(`export PATH=${[...cfg.pathPrepend.map(remotePathEntry), '"$PATH"'].join(":")}`);
  const unset = Object.entries(LANE_ENV)
    .filter(([, v]) => v === null)
    .map(([k]) => k);
  if (unset.length) lines.push(`unset ${unset.join(" ")}`);
  lines.push(
    'rm -rf "$O" && mkdir -p "$O" || { echo "QUEUE-DONE no-log-folder"; exit 0; }',
    'cd "$R/src" || { echo "QUEUE-DONE no-src"; exit 0; }',
    'bun install --frozen-lockfile > "$O/install.log" 2>&1',
    'c=$?; echo "install exit=$c"',
    '[ "$c" -eq 0 ] || { echo "QUEUE-DONE install-failed"; exit 0; }',
    `cd ${shellQuote(lane.cwd)} || { echo "QUEUE-DONE no-lane-folder"; exit 0; }`,
  );
  for (const job of jobs) {
    const { cmd, args, env } = laneCommand(
      lane,
      {
        bun: "bun",
        node: "node",
        portBase: job.port,
        bin: (_cwd, name) => `./node_modules/.bin/${name}`,
      },
      job.selection,
    );
    const assigns = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`);
    const command = [...assigns, shellQuote(cmd), ...args.map(shellQuote)].join(" ");
    lines.push(`( ${command} > "$O/${job.id}.log" 2>&1; echo "${job.id} exit=$?" ) &`);
  }
  lines.push("wait", 'echo "QUEUE-DONE ok"', "");
  return lines.join("\n");
}

export interface RemoteDeps {
  readonly runner: Runner;
  /** The local repository: it knows both trees and makes the patch. */
  readonly git: Git;
  readonly cfg: RemoteConfig;
  readonly logsDir: string;
  readonly log: (line: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

const lastLine = (text: string) =>
  text.replaceAll("\r", "").trim().split("\n").at(-1)?.trim() ?? "";

export class RemoteExecutor implements Executor {
  readonly target = "remote" as const;

  constructor(private readonly deps: RemoteDeps) {}

  session<T>(_label: string, _commit: string, fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  private sleep(ms: number): Promise<void> {
    return (this.deps.sleep ?? ((t) => new Promise((r) => setTimeout(r, t))))(ms);
  }

  private ssh(command: string, input?: Buffer | string) {
    const { cfg, runner } = this.deps;
    return runner.run(cfg.sshCommand, [...cfg.sshOptions, cfg.ssh, command], {
      input,
      timeoutMs: 10 * 60_000,
    });
  }

  /** Brings the remote checkout to exactly `tree`; throws RemoteError otherwise. */
  async sync(tree: string): Promise<void> {
    const R = remoteRoot(this.deps.cfg.workdir);
    let have = "";
    for (let attempt = 1; attempt <= 3 && !have; attempt += 1) {
      const r = await this.ssh(
        `cd ${R}/src && git reset -q --hard && git clean -qfd -e node_modules && git rev-parse 'HEAD^{tree}'`,
      );
      const line = lastLine(r.stdout);
      if (r.code === 0 && /^[0-9a-f]{40,64}$/.test(line)) have = line;
      else if (attempt < 3) await this.sleep(10_000);
    }
    if (!have)
      throw new RemoteError(`remote ${this.deps.cfg.ssh} is unreachable or has no checkout`);
    if (have === tree) return;
    if (!(await this.deps.git.exists(`${have}^{tree}`)))
      throw new RemoteError(
        `the remote checkout is at tree ${have}, which this repository does not know`,
      );
    const { patch, files } = await this.deps.git.diffBinary(have, tree);
    const gz = gzipSync(patch, { level: 9 });
    this.deps.log(`remote: patch ${Math.ceil(gz.length / 1024)} KB, ${files} files`);
    const applied = await this.ssh(
      `cd ${R}/src && gunzip -c | git apply --index --whitespace=nowarn && git write-tree`,
      gz,
    );
    const got = lastLine(applied.stdout);
    if (applied.code !== 0 || got !== tree)
      throw new RemoteError(
        `TREE MISMATCH on the remote machine: want ${tree}, got ${got || "nothing"}` +
          (applied.code !== 0 ? ` (exit ${applied.code}: ${lastLine(applied.stderr)})` : ""),
      );
    const committed = await this.ssh(
      `cd ${R}/src && git -c user.name=queue -c user.email=queue@localhost commit -q --no-verify -m ${shellQuote(`queue snapshot of tree ${tree}`)}`,
    );
    if (committed.code !== 0)
      throw new RemoteError(
        `could not record the snapshot on the remote: ${lastLine(committed.stderr)}`,
      );
  }

  async run(request: RunRequest): Promise<LaneRun> {
    const { cfg, logsDir } = this.deps;
    const now = this.deps.now ?? Date.now;
    const started = now();
    const lane = request.lane;
    const label = request.label.replace(/[^\w.-]/g, "_");
    await this.sync(request.tree);
    const n = request.selection || request.alone ? 1 : Math.max(1, cfg.shards[lane.name] ?? 1);
    const jobs: RemoteJob[] = Array.from({ length: n }, (_, i) => ({
      id: `s${i + 1}`,
      selection: n > 1 ? { shard: `${i + 1}/${n}` } : (request.selection ?? {}),
      port: cfg.portBase + 2 * i,
    }));
    const R = remoteRoot(cfg.workdir);
    const script = remoteScript(cfg, lane, label, request.tree, jobs);
    const base = `${R}/queue-logs/${label}`;
    const wrote = await this.ssh(`mkdir -p ${R}/queue-logs && cat > ${base}.sh`, script);
    if (wrote.code !== 0)
      throw new RemoteError(`could not send the run script: ${lastLine(wrote.stderr)}`);
    const launched = await this.ssh(
      `nohup bash ${base}.sh > ${base}.out 2>&1 < /dev/null & echo started`,
    );
    if (!/started/.test(launched.stdout))
      throw new RemoteError(`could not start the run: ${lastLine(launched.stderr)}`);
    this.deps.log(`remote: ${label} started (${jobs.length} job${jobs.length > 1 ? "s" : ""})`);

    let out = "";
    let misses = 0;
    let timedOut = false;
    const deadline = started + cfg.timeoutMinutes * 60_000;
    for (;;) {
      await this.sleep(cfg.pollSeconds * 1000);
      const r = await this.ssh(`cat ${base}.out`);
      if (r.code === 0) {
        misses = 0;
        out = r.stdout.replaceAll("\r", "");
        if (/^QUEUE-DONE/m.test(out)) break;
      } else if (++misses >= 20) {
        throw new RemoteError("lost the remote machine while waiting for the run");
      }
      if (now() > deadline) {
        timedOut = true;
        break;
      }
    }
    const summaryLog = path.join(logsDir, `${label}.log`);
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(summaryLog, `# queue: remote ${cfg.ssh}, ${jobs.length} job(s)\n${out}`);
    const done = /^QUEUE-DONE (\S+)/m.exec(out)?.[1];
    if (done && done !== "ok") throw new RemoteError(`remote run of ${label} stopped: ${done}`);

    const shards: ShardRun[] = [];
    const failures: Failure[] = [];
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    let total = 0;
    let broken = timedOut;
    for (const job of jobs) {
      const code = timedOut
        ? 124
        : Number(new RegExp(`^${job.id} exit=(\\d+)`, "m").exec(out)?.[1] ?? 1);
      const fetched = await this.ssh(`cat ${base}/${job.id}.log`);
      const text = fetched.code === 0 ? fetched.stdout : "";
      const log =
        jobs.length > 1
          ? path.join(logsDir, `${label}-${job.id}.log`)
          : path.join(logsDir, `${label}-run.log`);
      fs.writeFileSync(log, text);
      const c = classifyOutput(lane, code, text, timedOut);
      shards.push({ shard: job.selection.shard ?? "1/1", code, status: c.status, log });
      if (c.status === "broken") broken = true;
      else failures.push(...c.failures);
      passed += c.tests?.passed ?? 0;
      failed += c.tests?.failed ?? 0;
      skipped += c.tests?.skipped ?? 0;
      total += c.tests?.total ?? 0;
    }
    const status: LaneStatus = broken ? "broken" : failures.length ? "failed" : "green";
    const brokenShards = shards.filter((s) => s.status === "broken").map((s) => s.shard);
    return {
      lane: lane.name,
      label: request.label,
      target: "remote",
      commit: request.commit,
      code: Math.max(...shards.map((s) => s.code)),
      seconds: Math.round((now() - started) / 100) / 10,
      status,
      reason:
        status === "green"
          ? undefined
          : timedOut
            ? "timed out"
            : broken
              ? `shard ${brokenShards.join(", ")} produced no failures to rerun`
              : `${failed || failures.length} failed`,
      failures: broken ? [{ file: "", name: undefined }] : failures,
      tests: total ? { passed, failed, skipped, total } : undefined,
      log: summaryLog,
      selection: request.selection,
      shards,
      finishedAt: new Date(now()).toISOString(),
    };
  }
}
