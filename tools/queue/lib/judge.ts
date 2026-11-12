// FILE: tools/queue/lib/judge.ts
// Purpose: Turns failing lane runs into a judgement: rerun every failure alone on the candidate
//          (flaky when it passes), run what still fails on the base (pre-existing when it fails
//          there too, real when not), and name the PR behind each real failure by running the
//          lane on the base plus each suspect PR alone.
// Layer: tool library
// Exports: judge, selectionFor, JudgedFailure, Classification, JudgeDeps

import type { Executor, Failure, LaneRun } from "./executor.ts";
import { failureKey, matchFailures } from "./executor.ts";
import type { Git } from "./git.ts";
import { laneByName, quarantineId, type LaneSpec, type Selection } from "./lanes.ts";
import { identityFor, mergeOnto } from "./plan.ts";
import type { Candidate, CandidateStep } from "./state.ts";

export type Classification = "flaky" | "real" | "preexisting" | "unknown";

export interface JudgedFailure {
  readonly lane: string;
  readonly file: string;
  readonly name: string | undefined;
  readonly target: "local" | "remote";
  readonly classification: Classification;
  /** PRs whose single run on the base reproduces this real failure. */
  readonly culprits: readonly number[];
  readonly quarantineId: string | undefined;
  readonly note: string | undefined;
}

export interface JudgeDeps {
  readonly candidate: Candidate;
  readonly git: Git;
  readonly local: Executor;
  readonly remote: Executor | undefined;
  readonly record: (run: LaneRun) => void;
  readonly log: (line: string) => void;
}

/** How to rerun just these failures of a lane. Empty selection: the whole lane. */
export function selectionFor(lane: LaneSpec, failures: readonly Failure[]): Selection | undefined {
  if (failures.some((f) => !f.file) || lane.rerun === "lane") return undefined;
  if (lane.rerun === "names") {
    if (failures.some((f) => f.name === undefined)) return undefined;
    return { names: [...new Set(failures.map((f) => f.name!))].toSorted() };
  }
  return { files: [...new Set(failures.map((f) => f.file))].toSorted() };
}

const describe = (f: Failure) =>
  f.file ? `${f.file}${f.name ? ` > ${f.name}` : ""}` : "(whole lane)";

export async function judge(
  deps: JudgeDeps,
  mainRuns: readonly LaneRun[],
): Promise<{ failures: JudgedFailure[]; notes: string[] }> {
  const { candidate, git } = deps;
  const notes: string[] = [];
  const judged: JudgedFailure[] = [];
  const executorFor = (target: "local" | "remote") =>
    target === "remote" && deps.remote ? deps.remote : deps.local;
  const once = async (
    target: "local" | "remote",
    lane: LaneSpec,
    commit: string,
    tree: string,
    label: string,
    failures: readonly Failure[],
  ) => {
    const exec = executorFor(target);
    const run = await exec.session(label, commit, () =>
      exec.run({ lane, commit, tree, label, selection: selectionFor(lane, failures), alone: true }),
    );
    deps.record(run);
    deps.log(`  ${label}: ${run.status}${run.reason ? ` (${run.reason})` : ""}, ${run.seconds} s`);
    return run;
  };
  const push = (
    lane: LaneSpec,
    target: "local" | "remote",
    f: Failure,
    classification: Classification,
    extra: Partial<Pick<JudgedFailure, "culprits" | "note">> = {},
  ) =>
    judged.push({
      lane: lane.name,
      file: f.file,
      name: f.name,
      target,
      classification,
      culprits: extra.culprits ?? [],
      quarantineId: classification === "flaky" ? quarantineId(lane, f.file, f.name) : undefined,
      note: extra.note,
    });

  // 1. Rerun alone on the candidate, serially.
  const still: { lane: LaneSpec; target: "local" | "remote"; failures: Failure[] }[] = [];
  for (const run of mainRuns) {
    if (run.status === "green") continue;
    const lane = laneByName(run.lane)!;
    try {
      const rerun = await once(
        run.target,
        lane,
        candidate.sha,
        candidate.tree,
        `rerun-${lane.name}`,
        run.failures,
      );
      const lanewide = run.failures.some((f) => !f.file);
      let next: Failure[];
      if (rerun.status === "green") next = [];
      // A whole-lane failure that repeats as named tests is judged as those tests.
      else if (lanewide && rerun.status === "failed") next = [...rerun.failures];
      else {
        const { repeated, extra } = matchFailures(run.failures, rerun, "all");
        next = [...repeated, ...extra];
      }
      const nextKeys = new Set(next.map(failureKey));
      if (!(lanewide && next.length > 0))
        for (const f of run.failures)
          if (!nextKeys.has(failureKey(f))) push(lane, run.target, f, "flaky");
      if (next.length) still.push({ lane, target: run.target, failures: dedupe(next) });
    } catch (error) {
      notes.push(`${lane.name}: could not rerun alone: ${(error as Error).message}`);
      for (const f of run.failures)
        push(lane, run.target, f, "unknown", { note: `not judged: ${(error as Error).message}` });
    }
  }

  // 2. What still fails runs on the base: failing there too means it was already failing.
  const real: { lane: LaneSpec; target: "local" | "remote"; failures: Failure[] }[] = [];
  for (const item of still) {
    const { lane, target } = item;
    const missing: Failure[] = [];
    const present: Failure[] = [];
    for (const f of item.failures) {
      const repoPath = lane.cwd === "." ? f.file : `${lane.cwd}/${f.file}`;
      if (f.file && !(await git.exists(`${candidate.base.sha}:${repoPath}`))) missing.push(f);
      else present.push(f);
    }
    const realHere = [...missing];
    if (present.length) {
      try {
        const control = await once(
          target,
          lane,
          candidate.base.sha,
          candidate.base.tree,
          `control-${lane.name}`,
          present,
        );
        const { repeated } = matchFailures(present, control, "all");
        const onBase = new Set(repeated.map(failureKey));
        for (const f of present) {
          if (onBase.has(failureKey(f)))
            push(lane, target, f, "preexisting", {
              note:
                control.status === "broken"
                  ? `control run broken: ${control.reason}`
                  : "fails on the base too",
            });
          else realHere.push(f);
        }
      } catch (error) {
        notes.push(`${lane.name}: control run failed to start: ${(error as Error).message}`);
        for (const f of present)
          push(lane, target, f, "unknown", { note: `no control run: ${(error as Error).message}` });
      }
    }
    if (realHere.length) real.push({ lane, target, failures: realHere });
  }

  // 3. Name the PR: the lane on the base plus each suspect PR alone.
  const changed = new Map<number, string[]>();
  const singles = new Map<number, { commit: string; tree: string } | undefined>();
  const single = async (step: CandidateStep) => {
    if (!singles.has(step.pr)) {
      const who = await identityFor(git, candidate.base.sha);
      const m = await mergeOnto(
        git,
        candidate.base.sha,
        step.head,
        `queue: #${step.pr} alone on the base`,
        who,
      );
      singles.set(step.pr, "conflicts" in m ? undefined : m);
    }
    return singles.get(step.pr);
  };
  for (const item of real) {
    const { lane, target, failures } = item;
    const culprits = new Map<string, number[]>(failures.map((f) => [failureKey(f), []]));
    let note: string | undefined;
    if (candidate.steps.length === 1) {
      for (const f of failures) culprits.get(failureKey(f))!.push(candidate.steps[0]!.pr);
      note = "the only PR in the batch";
    } else {
      let suspects: CandidateStep[] = [...candidate.steps];
      if (lane.suspects.length) {
        const touching: CandidateStep[] = [];
        for (const step of candidate.steps) {
          if (!changed.has(step.pr))
            changed.set(step.pr, await git.changedFiles(candidate.base.sha, step.head));
          if (
            changed.get(step.pr)!.some((file) => lane.suspects.some((dir) => file.startsWith(dir)))
          )
            touching.push(step);
        }
        if (touching.length) suspects = touching;
        else note = `no PR touches ${lane.suspects.join(", ")}; tried every PR`;
      }
      for (const step of suspects) {
        const alone = await single(step);
        if (!alone) {
          notes.push(
            `#${step.pr} does not merge alone onto the base; skipped as a suspect for ${lane.name}`,
          );
          continue;
        }
        try {
          const run = await once(
            target,
            lane,
            alone.commit,
            alone.tree,
            `pr-${step.pr}-${lane.name}`,
            failures,
          );
          const lanewide = failures.every((f) => !f.file);
          const { repeated } = matchFailures(failures, run, lanewide ? "all" : "none");
          if (run.status === "broken" && !lanewide)
            notes.push(`${lane.name} on #${step.pr} alone was broken (${run.reason}); not counted`);
          for (const f of repeated) culprits.get(failureKey(f))!.push(step.pr);
        } catch (error) {
          notes.push(`${lane.name} on #${step.pr} alone did not run: ${(error as Error).message}`);
        }
      }
    }
    for (const f of failures) {
      const prs = culprits.get(failureKey(f))!;
      push(lane, target, f, "real", {
        culprits: prs,
        note: prs.length ? note : "no single PR reproduces it: fails only in combination",
      });
    }
  }
  for (const j of judged)
    deps.log(
      `  ${j.classification.padEnd(11)} ${j.lane}: ${describe(j)}${j.culprits.length ? ` <- #${j.culprits.join(", #")}` : ""}`,
    );
  return { failures: judged, notes };
}

function dedupe(failures: readonly Failure[]): Failure[] {
  const seen = new Map<string, Failure>();
  for (const f of failures) seen.set(failureKey(f), f);
  return [...seen.values()];
}
