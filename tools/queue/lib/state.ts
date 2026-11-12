// FILE: tools/queue/lib/state.ts
// Purpose: The queue's records on disk: one folder per candidate under the state folder, with
//          candidate.json, runs.json, progress.json, verdict.json, merge.json and the lane logs.
// Layer: tool library
// Exports: Candidate, CandidateStep, CandidateStore, Progress, writeJson, readJson

import fs from "node:fs";
import path from "node:path";

export interface CandidateStep {
  readonly pr: number;
  readonly title: string;
  readonly head: string;
  readonly headRef: string;
  readonly baseRef: string;
  /** The candidate chain's commit after merging this PR. */
  readonly commit: string;
  readonly tree: string;
}

export interface Candidate {
  readonly version: 1;
  readonly repo: string;
  readonly createdAt: string;
  readonly base: { readonly ref: string; readonly sha: string; readonly tree: string };
  readonly steps: readonly CandidateStep[];
  readonly sha: string;
  readonly tree: string;
}

export interface Progress {
  readonly pid: number;
  readonly phase: string;
  readonly running: readonly {
    readonly label: string;
    readonly target: string;
    readonly since: string;
  }[];
  readonly updatedAt: string;
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export class CandidateStore {
  constructor(readonly root: string) {}

  dirOf(sha: string): string {
    return path.join(this.root, sha.slice(0, 12));
  }

  file(sha: string, name: string): string {
    return path.join(this.dirOf(sha), name);
  }

  logsDir(sha: string): string {
    return path.join(this.dirOf(sha), "logs");
  }

  save(candidate: Candidate): void {
    writeJson(this.file(candidate.sha, "candidate.json"), candidate);
    writeJson(path.join(this.root, "current.json"), {
      candidate: candidate.sha,
      updatedAt: new Date().toISOString(),
    });
  }

  current(): string | undefined {
    return readJson<{ candidate: string }>(path.join(this.root, "current.json"))?.candidate;
  }

  /** A candidate by full or abbreviated SHA (at least 7 characters), or the current one. */
  resolve(ref: string | undefined): Candidate | { error: string } {
    const want = ref ?? this.current();
    if (!want) return { error: "no candidate yet: run `bun run queue plan <pr…>` first" };
    if (!/^[0-9a-f]{7,64}$/.test(want)) return { error: `not a candidate SHA: ${want}` };
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.root);
    } catch {
      // no state yet
    }
    const matches = names.filter(
      (n) => /^[0-9a-f]{12}$/.test(n) && (n.startsWith(want) || want.startsWith(n)),
    );
    const found = matches
      .map((n) => readJson<Candidate>(path.join(this.root, n, "candidate.json")))
      .filter((c): c is Candidate => c !== undefined && c.sha.startsWith(want));
    if (found.length === 0) return { error: `no candidate ${want} under ${this.root}` };
    if (found.length > 1) return { error: `candidate ${want} is ambiguous` };
    return found[0]!;
  }
}
