// FILE: load.ts
// Purpose: Keeps `bun run check` inside the machine's load limits: at most two runs at once, and
//          its tests held while another owner's heavy lane (`ws lane`) runs.
// Layer: tools/check; the locks are the workspace tool's (tools/ws/lib/lock.ts).
// Exports: CHECK_LOCK, CHECK_SLOTS, DEFAULT_MAX_WAIT_MINUTES, loadSettings, ownerName, takeSlot,
//          heavyLane, waitForHeavyLane, describeLoad, LoadSettings, LoadReport
// Why: more parallel gates than that crashed the type checker and turned tests into false
//      timeouts; a rule in a document did not stop it.

import path from "node:path";

import {
  acquireLock,
  HEAVY_LOCK,
  LANE_ENV,
  liveOwner,
  lockPath,
  type HeldLock,
  type LockOwner,
} from "../../ws/lib/lock.ts";
import { loadProfile, profilePathFromEnv } from "../../ws/lib/profile.ts";

export const CHECK_LOCK = "check";
export const CHECK_SLOTS = 2;
export const DEFAULT_MAX_WAIT_MINUTES = 45;

export interface LoadSettings {
  /** `<stateDir>/locks` of the machine profile. */
  readonly locksDir: string;
  readonly staleMs: number;
  readonly pollMs: number;
}

/** The lock folder and timings from the machine profile; its folder and defaults without one. */
export function loadSettings(env: NodeJS.ProcessEnv = process.env): LoadSettings {
  try {
    const profile = loadProfile(env);
    return {
      locksDir: path.join(profile.stateDir, "locks"),
      staleMs: profile.lock.staleHours * 3600_000,
      pollMs: profile.lock.pollSeconds * 1000,
    };
  } catch {
    return {
      locksDir: path.join(path.dirname(profilePathFromEnv(env)), "locks"),
      staleMs: 3 * 3600_000,
      pollMs: 10_000,
    };
  }
}

/** Who this run belongs to, as `ws` names owners. */
export function ownerName(env: NodeJS.ProcessEnv, repoRoot: string): string {
  return env.MOSS_WS_OWNER?.trim() || env.CLAUDE_SESSION_NAME?.trim() || path.basename(repoRoot);
}

/** Waits for one of the machine's quick-gate slots. */
export function takeSlot(
  settings: LoadSettings,
  owner: { owner: string; sha: string },
  log: (line: string) => void,
): Promise<HeldLock> {
  return acquireLock({
    dir: settings.locksDir,
    name: CHECK_LOCK,
    slots: CHECK_SLOTS,
    label: "check",
    staleMs: settings.staleMs,
    pollMs: Math.min(settings.pollMs, 2000),
    owner: { ...owner, lane: "check" },
    log,
  });
}

/** The heavy lane running now under another owner, or undefined. */
export function heavyLane(
  settings: LoadSettings,
  self: string,
  env: NodeJS.ProcessEnv = process.env,
): LockOwner | undefined {
  // The command a lane runs carries the lane's name: it must not wait for itself.
  if (env[LANE_ENV]) return undefined;
  const holder = liveOwner(lockPath(settings.locksDir, HEAVY_LOCK), settings.staleMs);
  return holder && holder.owner !== self ? holder : undefined;
}

export const laneName = (holder: LockOwner): string => `${holder.lane} (${holder.owner})`;

export interface HeavyWait {
  readonly waitedMs: number;
  readonly lane?: string;
  /** The ceiling was reached and the tests ran anyway. */
  readonly gaveUp: boolean;
}

/** Waits until no other owner's heavy lane runs, or until `maxWaitMs` has passed. */
export async function waitForHeavyLane(options: {
  readonly settings: LoadSettings;
  readonly self: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly maxWaitMs: number;
  readonly log: (line: string) => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}): Promise<HeavyWait> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let holder = heavyLane(options.settings, options.self, options.env);
  if (!holder) return { waitedMs: 0, gaveUp: false };
  const lane = laneName(holder);
  options.log(
    `check: tests wait for heavy lane ${lane}, since ${holder.started}, to end ` +
      `(at most ${Math.round(options.maxWaitMs / 60_000)} min; --no-wait runs them now)`,
  );
  const started = now();
  for (;;) {
    const left = options.maxWaitMs - (now() - started);
    if (left <= 0) return { waitedMs: now() - started, lane, gaveUp: true };
    await sleep(Math.min(options.settings.pollMs, left));
    holder = heavyLane(options.settings, options.self, options.env);
    if (!holder) return { waitedMs: now() - started, lane, gaveUp: false };
  }
}

export interface LoadReport {
  slotWaitMs: number;
  /** A heavy lane seen while the static steps and types ran. */
  heavyBeforeTests?: string;
  /** A heavy lane seen while tests (or their reruns) ran. */
  heavyDuringTests?: string;
  testWaits: HeavyWait[];
  noWait: boolean;
}

const minutes = (ms: number) => `${(ms / 60_000).toFixed(1)} min`;

/** One phrase for the summary's last line: did the run wait, or overlap a heavy lane. */
export function describeLoad(report: LoadReport): string {
  const parts: string[] = [];
  if (report.slotWaitMs >= 1000) parts.push(`waited ${minutes(report.slotWaitMs)} for a slot`);
  for (const wait of report.testWaits.filter((entry) => entry.lane)) {
    parts.push(
      wait.gaveUp
        ? `tests waited ${minutes(wait.waitedMs)} for heavy lane ${wait.lane}, then ran anyway (ceiling reached)`
        : `tests waited ${minutes(wait.waitedMs)} for heavy lane ${wait.lane}`,
    );
  }
  if (report.heavyDuringTests) {
    parts.push(
      `tests overlapped heavy lane ${report.heavyDuringTests}${report.noWait ? " (--no-wait)" : ""}`,
    );
  } else if (report.heavyBeforeTests && report.testWaits.every((wait) => !wait.lane)) {
    parts.push(`static steps and types overlapped heavy lane ${report.heavyBeforeTests}`);
  }
  if (!report.heavyDuringTests && !report.heavyBeforeTests && parts.length === 0)
    parts.push("no heavy lane ran, no wait");
  else if (!report.heavyDuringTests && !report.testWaits.some((wait) => wait.gaveUp))
    parts.push("tests did not overlap a heavy lane");
  return `load: ${parts.join("; ")}`;
}
