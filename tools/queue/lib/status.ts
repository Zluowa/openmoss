// FILE: tools/queue/lib/status.ts
// Purpose: `queue status`: the current candidate, what is running, the heavy lock, the last verdict.
// Layer: tool library
// Exports: statusLines

import path from "node:path";
import { lockPath, readOwner } from "../../ws/lib/lock.ts";
import { isAlive } from "../../ws/lib/proc.ts";
import type { MergeRecord } from "./merge.ts";
import { readJson, type Candidate, type CandidateStore, type Progress } from "./state.ts";
import { summarize, type Verdict } from "./verify.ts";

export function statusLines(
  store: CandidateStore,
  wsStateDir: string,
  candidate: Candidate | undefined,
): string[] {
  const out: string[] = [];
  const holder = readOwner(lockPath(path.join(wsStateDir, "locks"), "heavy"));
  out.push(
    holder
      ? `heavy lock: held by ${holder.owner} (${holder.lane}, pid ${holder.pid}${isAlive(holder.pid) ? "" : ", gone"}, since ${holder.started})`
      : "heavy lock: free",
  );
  if (!candidate) {
    out.push("no candidate yet");
    return out;
  }
  out.push(
    `candidate ${candidate.sha.slice(0, 9)} (tree ${candidate.tree.slice(0, 9)}), planned ${candidate.createdAt}`,
    `  ${candidate.base.ref} ${candidate.base.sha.slice(0, 9)} + ` +
      candidate.steps.map((s) => `#${s.pr} @${s.head.slice(0, 9)}`).join(" + "),
    `  state ${store.dirOf(candidate.sha)}`,
  );
  const progress = readJson<Progress>(store.file(candidate.sha, "progress.json"));
  if (progress) {
    const alive = isAlive(progress.pid);
    out.push(
      `verify: ${progress.phase}${alive ? ` (pid ${progress.pid} running)` : progress.phase.startsWith("done") ? "" : " (process gone)"}`,
    );
    if (alive)
      for (const r of progress.running)
        out.push(`  running ${r.label} on ${r.target} since ${r.since}`);
  } else out.push("verify: not started");
  const verdict = readJson<Verdict>(store.file(candidate.sha, "verdict.json"));
  if (verdict)
    out.push(
      ...summarize(candidate, verdict)
        .split("\n")
        .map((l) => `  ${l}`),
    );
  const merged = readJson<MergeRecord>(store.file(candidate.sha, "merge.json"))?.merged ?? [];
  if (merged.length)
    out.push(
      `merge: ${merged.map((m) => `#${m.pr} -> ${m.main.slice(0, 9)}${m.treeOk ? "" : " TREE MISMATCH"}`).join(", ")}`,
    );
  return out;
}
