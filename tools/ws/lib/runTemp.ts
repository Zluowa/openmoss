// A temp folder per heavy-lane run (and per `bun run check` test phase), removed when the run ends.
//
// Why (2026-11-17/18): tests and builds write their scratch data under %TEMP% on C:. A full
// Windows lane swung C: by ~11 GB within minutes, and tests that never remove their fixtures had
// left 13 GB behind in %TEMP% (sqlite fixtures of 25-56 MB per run, by the hundred). With the
// profile's `tempRoot` set, TEMP/TMP/TMPDIR of the run point at a fresh folder there, which goes
// with the run, leftovers included. Point tempRoot at a fast drive with room (on this PC D:, the same
// NVMe as C:).
import fs from "node:fs";
import path from "node:path";

import { removeTreeSafe } from "./safeRemove.ts";

/** Run folders older than this are leftovers of a run that was killed; the next run removes them. */
export const RUN_TEMP_MAX_AGE_MS = 12 * 3600_000;
const RUN_DIR = /^[A-Za-z0-9._-]+-\d{8}-\d{6}-\d+$/u;

export interface RunTemp {
  readonly dir: string;
  /** TEMP, TMP and TMPDIR for the run's processes. */
  readonly env: Readonly<Record<string, string>>;
  /** Measures what the run left and removes the folder (links as links). */
  finish(): { bytes: number; errors: string[] };
}

const pad = (n: number) => String(n).padStart(2, "0");

function stamp(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** Bytes of regular files under `dir`; links are not followed. */
export function treeBytes(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(full);
      else {
        try {
          total += fs.lstatSync(full).size;
        } catch {
          // Gone already.
        }
      }
    }
  }
  return total;
}

export function createRunTemp(root: string, name: string, now = new Date()): RunTemp {
  const safeName = name.replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 40) || "run";
  const dir = path.join(root, `${safeName}-${stamp(now)}-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    env: { TEMP: dir, TMP: dir, TMPDIR: dir },
    finish() {
      const bytes = treeBytes(dir);
      try {
        const report = removeTreeSafe(dir, { roots: [root], protectedPaths: [] });
        return { bytes, errors: report.errors };
      } catch (error) {
        return { bytes, errors: [(error as Error).message] };
      }
    },
  };
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Removes run folders under `root` older than `maxAgeMs` whose process has ended (killed runs). */
export function sweepRunTemps(
  root: string,
  maxAgeMs = RUN_TEMP_MAX_AGE_MS,
  now = Date.now(),
): { removed: string[]; bytes: number } {
  const removed: string[] = [];
  let bytes = 0;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { removed, bytes };
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !RUN_DIR.test(entry.name)) continue;
    const full = path.join(root, entry.name);
    let modified: number;
    try {
      modified = fs.statSync(full).mtimeMs;
    } catch {
      continue;
    }
    if (now - modified < maxAgeMs) continue;
    // The folder name ends in the pid of the run that made it: never sweep a live run's folder.
    const pid = Number(entry.name.slice(entry.name.lastIndexOf("-") + 1));
    if (processAlive(pid)) continue;
    const size = treeBytes(full);
    try {
      if (removeTreeSafe(full, { roots: [root], protectedPaths: [] }).errors.length === 0) {
        removed.push(entry.name);
        bytes += size;
      }
    } catch {
      // Not removable (a link, protected): leave it.
    }
  }
  return { removed, bytes };
}
