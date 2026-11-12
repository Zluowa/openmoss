// FILE: tools/queue/lib/executor.ts
// Purpose: Runs one lane on one commit and reads the result. The local executor works in the
//          configured checkout under the machine's heavy-lane lock.
// Layer: tool library
// Exports: Executor, LaneRun, Failure, RunRequest, HeavyLock, LocalExecutor, classifyOutput,
//          matchFailures, failureKey, ExecutorError, wsHeavyLock

import fs from "node:fs";
import path from "node:path";
import { belowFloor, floorMessage } from "../../ws/lib/disk.ts";
import { acquireLock } from "../../ws/lib/lock.ts";
import type { QueueConfig } from "./config.ts";
import type { Git } from "./git.ts";
import { LANE_ENV, laneCommand, type LaneSpec, type Selection } from "./lanes.ts";
import type { Runner } from "./runner.ts";
import { parseVitest, type Counts } from "./vitest.ts";

export type Target = "local" | "remote";
export type LaneStatus = "green" | "failed" | "broken";

/** One failing test; `file` empty means the lane as a whole (a static check, a crashed run). */
export interface Failure {
  readonly file: string;
  readonly name: string | undefined;
}

export interface ShardRun {
  readonly shard: string;
  readonly code: number;
  readonly status: LaneStatus;
  readonly log: string;
}

export interface LaneRun {
  readonly lane: string;
  readonly label: string;
  readonly target: Target;
  readonly commit: string;
  readonly code: number;
  readonly seconds: number;
  readonly status: LaneStatus;
  readonly reason: string | undefined;
  readonly failures: readonly Failure[];
  readonly tests: Counts | undefined;
  readonly log: string;
  readonly selection: Selection | undefined;
  readonly shards: readonly ShardRun[] | undefined;
  readonly finishedAt: string;
}

export interface RunRequest {
  readonly lane: LaneSpec;
  readonly commit: string;
  readonly tree: string;
  /** Names the log file: `lane-server`, `rerun-server`, `control-server`, `pr-576-server`. */
  readonly label: string;
  readonly selection?: Selection | undefined;
  /** A judgement run: one process, never split into shards. */
  readonly alone?: boolean | undefined;
}

export interface Executor {
  readonly target: Target;
  /** Brackets a series of runs: the local executor holds the heavy lock for it. */
  session<T>(label: string, commit: string, fn: () => Promise<T>): Promise<T>;
  run(request: RunRequest): Promise<LaneRun>;
}

export class ExecutorError extends Error {}

export const failureKey = (f: Failure) => `${f.file}\u0000${f.name ?? ""}`;

/** Status, reason and failures of a finished lane process. */
export function classifyOutput(
  lane: LaneSpec,
  code: number,
  output: string,
  timedOut = false,
): Pick<LaneRun, "status" | "reason" | "failures" | "tests"> {
  const whole: Failure[] = [{ file: "", name: undefined }];
  if (!lane.vitest) {
    if (code === 0) return { status: "green", reason: undefined, failures: [], tests: undefined };
    return {
      status: "failed",
      reason: timedOut ? "timed out" : `exit ${code}`,
      failures: whole,
      tests: undefined,
    };
  }
  const report = parseVitest(output);
  if (code === 0 && !timedOut)
    return { status: "green", reason: undefined, failures: [], tests: report.tests };
  if (report.failures.length > 0 && !timedOut)
    return {
      status: "failed",
      reason: `${report.tests?.failed ?? report.failures.length} failed`,
      failures: report.failures.map((f) => ({ file: f.file, name: f.name })),
      tests: report.tests,
    };
  const reason = timedOut
    ? "timed out"
    : report.errors > 0
      ? `exit ${code}: ${report.errors} error(s) outside tests`
      : report.summary
        ? `exit ${code}`
        : `exit ${code}, no Vitest summary`;
  return { status: "broken", reason, failures: whole, tests: report.tests };
}

/**
 * Which of `wanted` failed again in `run`. A broken run tells nothing about single tests:
 * `broken` says whether that counts as every failure repeating ("all") or none ("none").
 * Failures of the run that `wanted` did not list are returned in `extra`.
 */
export function matchFailures(
  wanted: readonly Failure[],
  run: Pick<LaneRun, "status" | "failures">,
  broken: "all" | "none",
): { repeated: Failure[]; extra: Failure[] } {
  if (run.status === "green") return { repeated: [], extra: [] };
  if (run.status === "broken") return { repeated: broken === "all" ? [...wanted] : [], extra: [] };
  const keys = new Set(run.failures.map(failureKey));
  const suiteFiles = new Set(run.failures.filter((f) => f.name === undefined).map((f) => f.file));
  const files = new Set(run.failures.map((f) => f.file));
  const repeated: Failure[] = [];
  for (const f of wanted) {
    if (!f.file) repeated.push(f);
    else if (keys.has(failureKey(f)) || suiteFiles.has(f.file)) repeated.push(f);
    else if (f.name === undefined && files.has(f.file)) repeated.push(f);
  }
  const wantedKeys = new Set(wanted.map(failureKey));
  const wantedFiles = new Set(wanted.filter((f) => f.name === undefined).map((f) => f.file));
  const extra = run.failures.filter(
    (f) =>
      !wantedKeys.has(failureKey(f)) && !wantedFiles.has(f.file) && !wanted.some((w) => !w.file),
  );
  return { repeated, extra };
}

export interface HeavyLock {
  hold<T>(label: string, sha: string, fn: () => Promise<T>): Promise<T>;
}

/** The machine-wide heavy-lane lock of `ws lane`, from tools/ws/lib/lock.ts. */
export function wsHeavyLock(
  cfg: QueueConfig,
  owner: string,
  log: (line: string) => void,
): HeavyLock {
  const floor = (when: string) => {
    const low = belowFloor(cfg.profile.disk.drives, cfg.profile.disk.floorGB);
    if (low.length)
      throw new ExecutorError(`refused ${when}: ${floorMessage(low, cfg.profile.disk.floorGB)}`);
  };
  return {
    async hold(label, sha, fn) {
      floor("before queueing for the heavy lock");
      const lock = await acquireLock({
        dir: path.join(cfg.profile.stateDir, "locks"),
        name: "heavy",
        staleMs: cfg.profile.lock.staleHours * 3600_000,
        pollMs: cfg.profile.lock.pollSeconds * 1000,
        owner: { owner, lane: `queue ${label}`, sha },
        log,
      });
      const release = () => lock.release();
      process.once("exit", release);
      try {
        floor("after getting the heavy lock");
        return await fn();
      } finally {
        release();
        process.off("exit", release);
      }
    },
  };
}

export interface LocalDeps {
  readonly runner: Runner;
  readonly git: Git;
  readonly cfg: QueueConfig;
  readonly lock: HeavyLock;
  readonly logsDir: string;
  readonly now?: () => number;
  readonly platform?: NodeJS.Platform;
}

/** Environment every local lane gets: the operator's unsets, and the configured bun first on PATH. */
export function localLaneEnv(cfg: QueueConfig): Record<string, string | null> {
  const env: Record<string, string | null> = { ...LANE_ENV };
  if (path.isAbsolute(cfg.tools.bun))
    env.PATH = `${path.dirname(cfg.tools.bun)}${path.delimiter}${process.env.PATH ?? ""}`;
  return env;
}

/**
 * The checkout whose install `checkout` links to, when its bun store is a link (how `ws new`
 * gives a worktree dependencies without an install), else undefined.
 */
export function linkedInstallSource(checkout: string): string | undefined {
  const store = path.join(checkout, "node_modules", ".bun");
  try {
    if (!fs.lstatSync(store).isSymbolicLink()) return undefined;
    return path.dirname(path.dirname(fs.realpathSync.native(store)));
  } catch {
    return undefined;
  }
}

export function writeLogHeader(
  log: string,
  cwd: string,
  cmd: string,
  args: readonly string[],
): void {
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, `# queue: ${[cmd, ...args].join(" ")}\n# cwd: ${cwd}\n`);
}

export class LocalExecutor implements Executor {
  readonly target = "local" as const;
  private prepared: string | undefined;

  constructor(private readonly deps: LocalDeps) {}

  session<T>(label: string, commit: string, fn: () => Promise<T>): Promise<T> {
    return this.deps.lock.hold(label, commit, async () => {
      this.prepared = undefined;
      try {
        return await fn();
      } finally {
        this.prepared = undefined;
      }
    });
  }

  private bin = (cwd: string, name: string) => {
    const dir = path.join(this.deps.cfg.checkout, cwd, "node_modules", ".bin");
    return path.join(
      dir,
      (this.deps.platform ?? process.platform) === "win32" ? `${name}.exe` : name,
    );
  };

  /** Checks out `commit` (asserting its tree) and installs; throws ExecutorError when either fails. */
  private async prepare(commit: string, tree: string): Promise<void> {
    if (this.prepared === commit) return;
    const { git, cfg, runner } = this.deps;
    const changes = await git.trackedChanges();
    if (changes.length > 0)
      throw new ExecutorError(
        `the lane checkout ${cfg.checkout} has ${changes.length} tracked change(s); ` +
          "the queue only checks out over a clean tree",
      );
    const source = linkedInstallSource(cfg.checkout);
    if (source && cfg.install === "frozen")
      throw new ExecutorError(
        `${cfg.checkout} links its dependencies from ${source} (a ws worktree): an install ` +
          "there would rewrite that checkout's install. Use a checkout with its own install, " +
          'or set "queue.install": "linked" to run on the linked install as it is',
      );
    if (source) {
      const want = await git.show(`${commit}:bun.lock`);
      let have = "";
      try {
        have = fs.readFileSync(path.join(source, "bun.lock"), "utf8");
      } catch {
        // no lockfile there: cannot match
      }
      const lf = (text: string) => text.replaceAll("\r\n", "\n");
      if (lf(want) !== lf(have))
        throw new ExecutorError(
          `${commit.slice(0, 9)} has another bun.lock than the linked install in ${source}; ` +
            "it needs a checkout with its own install",
        );
    }
    await git.checkoutDetached(commit);
    const got = await git.treeOf("HEAD");
    if (got !== tree)
      throw new ExecutorError(
        `checked out ${commit.slice(0, 9)} but its tree is ${got}, want ${tree}`,
      );
    if (cfg.install === "linked") {
      this.prepared = commit;
      return;
    }
    const log = path.join(this.deps.logsDir, `install-${commit.slice(0, 9)}.log`);
    const args = ["install", "--frozen-lockfile"];
    writeLogHeader(log, cfg.checkout, cfg.tools.bun, args);
    const r = await runner.run(cfg.tools.bun, args, {
      cwd: cfg.checkout,
      env: localLaneEnv(cfg),
      logFile: log,
      timeoutMs: 20 * 60_000,
    });
    if (r.code !== 0)
      throw new ExecutorError(
        `bun install --frozen-lockfile failed on ${commit.slice(0, 9)} (exit ${r.code}); log ${log}`,
      );
    this.prepared = commit;
  }

  async run(request: RunRequest): Promise<LaneRun> {
    const { cfg, runner } = this.deps;
    const now = this.deps.now ?? Date.now;
    await this.prepare(request.commit, request.tree);
    const { cmd, args, env } = laneCommand(
      request.lane,
      { bun: cfg.tools.bun, node: cfg.tools.node, portBase: cfg.browserPortBase, bin: this.bin },
      request.selection,
    );
    const cwd = path.join(cfg.checkout, request.lane.cwd);
    const log = path.join(this.deps.logsDir, `${request.label}.log`);
    writeLogHeader(log, cwd, cmd, args);
    const headerSize = fs.statSync(log).size;
    const started = now();
    const r = await runner.run(cmd, args, {
      cwd,
      env: { ...localLaneEnv(cfg), ...env },
      logFile: log,
      timeoutMs: cfg.laneTimeoutMinutes * 60_000,
    });
    const output = `${r.stdout}\n${r.stderr}`;
    // A runner that does not stream (the tests' fake) leaves only the header: keep the output.
    if (fs.statSync(log).size === headerSize && output.trim()) fs.appendFileSync(log, output);
    return {
      lane: request.lane.name,
      label: request.label,
      target: "local",
      commit: request.commit,
      code: r.code,
      seconds: Math.round((now() - started) / 100) / 10,
      ...classifyOutput(request.lane, r.code, output, r.timedOut ?? false),
      log,
      selection: request.selection,
      shards: undefined,
      finishedAt: new Date(now()).toISOString(),
    };
  }
}
