// FILE: tools/queue/lib/verify.ts
// Purpose: Verifies a candidate: every lane (local ones in order under the heavy lock, remote ones
//          in parallel on the second machine), then the judgement, then verdict.json and a summary.
// Layer: tool library
// Exports: verify, Verdict, VerdictResult, summarize, VerifyDeps, readRuns

import { ExecutorError, type Executor, type LaneRun, type RunRequest } from "./executor.ts";
import type { Git } from "./git.ts";
import { judge, type JudgedFailure } from "./judge.ts";
import { LANES, selectLanes, type LaneSpec } from "./lanes.ts";
import { RemoteError } from "./remote.ts";
import {
  readJson,
  writeJson,
  type Candidate,
  type CandidateStore,
  type Progress,
} from "./state.ts";
import fs from "node:fs";

export type VerdictResult = "green" | "red" | "base-red" | "broken";

export interface Verdict {
  readonly version: 1;
  readonly candidate: { readonly sha: string; readonly tree: string };
  readonly base: { readonly sha: string; readonly tree: string };
  readonly heads: readonly { readonly pr: number; readonly head: string; readonly tree: string }[];
  readonly result: VerdictResult;
  /** Every lane of the table has a run for this candidate (here or, with --resume, before). */
  readonly complete: boolean;
  readonly lanes: readonly {
    readonly name: string;
    readonly target: string;
    readonly status: string;
    readonly seconds: number;
    readonly reason: string | undefined;
    readonly tests: LaneRun["tests"];
    readonly log: string;
    readonly resumed: boolean;
  }[];
  readonly failures: readonly JudgedFailure[];
  readonly culprits: readonly {
    readonly pr: number;
    readonly lanes: readonly string[];
    readonly failures: number;
  }[];
  readonly notes: readonly string[];
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface VerifyOptions {
  readonly only?: readonly string[] | undefined;
  readonly resume?: boolean | undefined;
}

export interface VerifyDeps {
  readonly candidate: Candidate;
  readonly store: CandidateStore;
  readonly git: Git;
  readonly local: Executor;
  /** The second machine, when configured and not turned off with --no-remote. */
  readonly remote: Executor | undefined;
  readonly log: (line: string) => void;
  readonly now?: () => number;
}

export function readRuns(store: CandidateStore, sha: string): LaneRun[] {
  return readJson<{ runs: LaneRun[] }>(store.file(sha, "runs.json"))?.runs ?? [];
}

function laneLine(run: LaneRun, resumed = false): string {
  const tests = run.tests
    ? `, tests ${run.tests.passed} passed${run.tests.failed ? ` ${run.tests.failed} failed` : ""}`
    : "";
  return (
    `${run.lane.padEnd(12)} ${run.status.padEnd(7)} ${`${run.seconds} s`.padStart(8)}  ${run.target}` +
    `${resumed ? " (recorded earlier)" : ""}${run.reason ? `  ${run.reason}` : ""}${tests}`
  );
}

/** Wraps an executor so progress.json says what is running. */
function tracked(exec: Executor, progress: ProgressFile): Executor {
  return {
    target: exec.target,
    session: (label, commit, fn) => exec.session(label, commit, fn),
    async run(request: RunRequest) {
      const entry = { label: request.label, target: exec.target, since: new Date().toISOString() };
      progress.start(entry);
      try {
        return await exec.run(request);
      } finally {
        progress.stop(entry);
      }
    },
  };
}

class ProgressFile {
  private running: Progress["running"][number][] = [];
  phase = "starting";
  constructor(private readonly file: string) {}
  private write() {
    writeJson(this.file, {
      pid: process.pid,
      phase: this.phase,
      running: this.running,
      updatedAt: new Date().toISOString(),
    } satisfies Progress);
  }
  setPhase(phase: string) {
    this.phase = phase;
    this.write();
  }
  start(entry: Progress["running"][number]) {
    this.running.push(entry);
    this.write();
  }
  stop(entry: Progress["running"][number]) {
    this.running = this.running.filter((e) => e !== entry);
    this.write();
  }
}

export async function verify(deps: VerifyDeps, options: VerifyOptions = {}): Promise<Verdict> {
  const { candidate, store, log } = deps;
  const now = deps.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  const progress = new ProgressFile(store.file(candidate.sha, "progress.json"));
  const local = tracked(deps.local, progress);
  const remote = deps.remote ? tracked(deps.remote, progress) : undefined;
  const runsFile = store.file(candidate.sha, "runs.json");
  const allRuns = readRuns(store, candidate.sha);
  const record = (run: LaneRun) => {
    allRuns.push(run);
    writeJson(runsFile, { runs: allRuns });
  };
  const lanes = selectLanes(options.only);
  const previous = new Map<string, LaneRun>();
  if (options.resume)
    for (const run of allRuns)
      if (run.label === `lane-${run.lane}` && run.status === "green") previous.set(run.lane, run);
  const notes: string[] = [];
  const mainRuns: LaneRun[] = [];
  const resumed: LaneRun[] = [];
  for (const lane of lanes) {
    const prev = previous.get(lane.name);
    if (prev) {
      resumed.push(prev);
      log(laneLine(prev, true));
    }
  }
  const todo = lanes.filter((l) => !previous.has(l.name));
  const remoteLanes = remote ? todo.filter((l) => l.where === "remote") : [];
  const localLanes = todo.filter((l) => !remoteLanes.includes(l));
  const request = (lane: LaneSpec): RunRequest => ({
    lane,
    commit: candidate.sha,
    tree: candidate.tree,
    label: `lane-${lane.name}`,
  });
  const finished = (run: LaneRun) => {
    record(run);
    mainRuns.push(run);
    log(laneLine(run));
  };
  progress.setPhase("lanes");

  let setupError: string | undefined;
  const remoteTask = (async () => {
    const fallback: LaneSpec[] = [];
    for (const lane of remoteLanes) {
      try {
        finished(
          await remote!.session(`lane-${lane.name}`, candidate.sha, () =>
            remote!.run(request(lane)),
          ),
        );
      } catch (error) {
        if (!(error instanceof RemoteError)) throw error;
        notes.push(
          `${lane.name}: the remote run failed (${error.message}); ran it locally instead`,
        );
        log(`${lane.name.padEnd(12)} remote failed: ${error.message}; will run locally`);
        fallback.push(lane);
      }
    }
    return fallback;
  })().then(
    (fallback) => ({ fallback, error: undefined as unknown }),
    (error: unknown) => ({ fallback: [] as LaneSpec[], error }),
  );
  const runLocal = async (label: string, list: readonly LaneSpec[]) => {
    if (list.length === 0 || setupError) return;
    try {
      await local.session(label, candidate.sha, async () => {
        for (const lane of list) finished(await local.run(request(lane)));
      });
    } catch (error) {
      if (!(error instanceof ExecutorError)) throw error;
      setupError = error.message;
      log(`setup failed: ${error.message}`);
    }
  };
  await runLocal("lanes", localLanes);
  const remoteOutcome = await remoteTask;
  if (remoteOutcome.error) throw remoteOutcome.error;
  await runLocal("lanes (fallback)", remoteOutcome.fallback);

  let failures: JudgedFailure[] = [];
  if (!setupError && mainRuns.some((r) => r.status !== "green")) {
    progress.setPhase("judge");
    log("judging failures:");
    try {
      const judged = await judge(
        { candidate, git: deps.git, local, remote, record, log },
        mainRuns,
      );
      failures = judged.failures;
      notes.push(...judged.notes);
    } catch (error) {
      if (!(error instanceof ExecutorError)) throw error;
      setupError = error.message;
    }
  }
  if (setupError) notes.unshift(`setup failed: ${setupError}`);

  const byPr = new Map<number, { lanes: Set<string>; failures: number }>();
  for (const f of failures)
    for (const pr of f.culprits) {
      const entry = byPr.get(pr) ?? { lanes: new Set<string>(), failures: 0 };
      entry.lanes.add(f.lane);
      entry.failures += 1;
      byPr.set(pr, entry);
    }
  const result: VerdictResult = setupError
    ? "broken"
    : failures.some((f) => f.classification === "real" || f.classification === "unknown")
      ? "red"
      : failures.some((f) => f.classification === "preexisting")
        ? "base-red"
        : "green";
  const ranLanes = new Set([...mainRuns, ...resumed].map((r) => r.lane));
  const verdict: Verdict = {
    version: 1,
    candidate: { sha: candidate.sha, tree: candidate.tree },
    base: { sha: candidate.base.sha, tree: candidate.base.tree },
    heads: candidate.steps.map((s) => ({ pr: s.pr, head: s.head, tree: s.tree })),
    result,
    complete: !setupError && LANES.every((l) => ranLanes.has(l.name)),
    lanes: [
      ...resumed.map((r) => ({ r, resumed: true })),
      ...mainRuns.map((r) => ({ r, resumed: false })),
    ]
      .toSorted(
        (a, b) =>
          LANES.findIndex((l) => l.name === a.r.lane) - LANES.findIndex((l) => l.name === b.r.lane),
      )
      .map(({ r, resumed: wasResumed }) => ({
        name: r.lane,
        target: r.target,
        status: r.status,
        seconds: r.seconds,
        reason: r.reason,
        tests: r.tests,
        log: r.log,
        resumed: wasResumed,
      })),
    failures,
    culprits: [...byPr.entries()].map(([pr, e]) => ({
      pr,
      lanes: [...e.lanes].toSorted(),
      failures: e.failures,
    })),
    notes,
    startedAt,
    finishedAt: new Date(now()).toISOString(),
  };
  writeJson(store.file(candidate.sha, "verdict.json"), verdict);
  fs.writeFileSync(store.file(candidate.sha, "summary.txt"), `${summarize(candidate, verdict)}\n`);
  progress.setPhase(`done: ${result}`);
  return verdict;
}

const show = (f: JudgedFailure) =>
  f.file ? `${f.file}${f.name ? ` > ${f.name}` : ""}` : "(the whole lane)";

/** The short human summary printed at the end and kept as summary.txt. */
export function summarize(candidate: Candidate, verdict: Verdict): string {
  const by = (c: string) => verdict.failures.filter((f) => f.classification === c);
  const real = by("real");
  const unknown = by("unknown");
  const flaky = by("flaky");
  const pre = by("preexisting");
  const prs = candidate.steps.map((s) => `#${s.pr}`).join(" ");
  const out = [
    `candidate ${candidate.sha.slice(0, 9)} (tree ${candidate.tree.slice(0, 9)}) = ${candidate.base.ref} ${candidate.base.sha.slice(0, 9)} + ${prs}`,
    `verdict ${verdict.result.toUpperCase()}${verdict.complete ? "" : " (partial: not every lane ran)"}: ` +
      `${real.length} real, ${flaky.length} flaky, ${pre.length} pre-existing` +
      (unknown.length ? `, ${unknown.length} not judged` : ""),
  ];
  const total = verdict.lanes.reduce((s, l) => s + (l.resumed ? 0 : l.seconds), 0);
  out.push(
    `lanes (${Math.round(total)} s): ${verdict.lanes.map((l) => `${l.name} ${l.status}`).join(", ")}`,
  );
  if (verdict.culprits.length)
    out.push(
      `culprits: ${verdict.culprits.map((c) => `#${c.pr} (${c.lanes.join(", ")}: ${c.failures})`).join("; ")}`,
    );
  if (real.length) {
    out.push("real failures:");
    for (const f of real)
      out.push(
        `  ${f.lane}: ${show(f)}${f.culprits.length ? ` <- #${f.culprits.join(", #")}` : ""}${f.note ? ` (${f.note})` : ""}`,
      );
  }
  if (unknown.length) {
    out.push("not judged:");
    for (const f of unknown) out.push(`  ${f.lane}: ${show(f)} (${f.note})`);
  }
  if (pre.length) {
    out.push(`pre-existing (fail on ${candidate.base.ref} too):`);
    for (const f of pre) out.push(`  ${f.lane}: ${show(f)}`);
  }
  if (flaky.length) {
    out.push("flaky (failed, then passed alone; quarantine ids where the list covers the lane):");
    for (const f of flaky) out.push(`  ${f.quarantineId ?? `${f.lane}: ${show(f)}`}`);
  }
  for (const n of verdict.notes) out.push(`note: ${n}`);
  return out.join("\n");
}
