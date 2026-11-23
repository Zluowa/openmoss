// The heavy lane with several slots (owner, 2026-11-24: 「让队列并行跑」). At 03:00 one job ran and six
// waited while the processors idled at 23 %; memory is what is scarce (31.8 GB RAM, 1.8 GB free on
// 2026-11-18 when several heavy runs went side by side). So the lane admits a job beside running
// ones only when:
//   - a slot is free (profile lock.heavySlots, default 1, read again at every poll);
//   - the job's class may share the machine with every running job's class (MAY_OVERLAP), and it
//     does not run in the same work tree as one of them;
//   - the newest running job has had ADMIT_SETTLE_MS to take its memory;
//   - free memory and commit headroom are above the admission floors (memory.admitFreeGB,
//     memory.admitCommitHeadroomGB), measured at that moment.
// An empty lane admits the head of the queue to slot 1 exactly as before (then the run floor of
// memory.ts applies, as it always did). A job without a class (every caller from before, and every
// job of the old code) runs alone, and nothing queued after it starts before it.
//
// On disk, slot 1 is `locks/heavy` (where the old code looks), slot k is `locks/heavy-k`; one queue,
// `locks/heavy.queue`.
import fs from "node:fs";
import path from "node:path";

import {
  breakStale,
  formatMinutes,
  liveTickets,
  lockPath,
  readOwner,
  removeLockDir,
  staleReason,
  tryCreate,
  writeQuickStreak,
  type HeldLock,
  type JobClass,
  type LockOwner,
  type Ticket,
} from "./lock.ts";
import { memoryShortfall, type MemoryFloor, type MemoryState } from "./memory.ts";
import { samePath } from "./paths.ts";

export const LANE_CLASSES = ["build", "window", "test", "typecheck"] as const;
export type LaneClass = (typeof LANE_CLASSES)[number];

/**
 * Which classes may run at the same time (the table is symmetric). What may not, and why:
 * - build + build: installer and package builds share electron-builder's download and signing-tool
 *   cache in %LOCALAPPDATA%, the build wrappers write fixed output folders, and each takes gigabytes.
 * - window + window: the launchers in use (accept/launch-iso.mjs) take the debugging port and the
 *   profile folder from the caller, so two sessions can pick the same ones; each window is ~1-2 GB.
 * - build + window: a window run is timed (screenshots, 15 s tool limits) and a build saturates the
 *   processors and the disk; not shown to be safe, so not allowed.
 * Tests and typechecks write only inside their own work tree (`ws new` gives each tree real cache
 * folders) and per-run TEMP; Vitest's browser API port moves to the next free port when taken.
 */
export const MAY_OVERLAP: Readonly<Record<LaneClass, readonly LaneClass[]>> = {
  build: ["test", "typecheck"],
  window: ["test", "typecheck"],
  test: ["build", "window", "test", "typecheck"],
  typecheck: ["build", "window", "test", "typecheck"],
};

/** A job admitted beside running ones waits this long after the newest of them started. */
export const ADMIT_SETTLE_MS = 60_000;
/** Marks tickets and holders of this code, so `ws doctor` can tell the old code's apart. */
export const LANE_VERSION = 2;

export function parseLaneClass(value: unknown): LaneClass | undefined {
  return LANE_CLASSES.find((c) => c === value);
}

export interface LaneJob {
  readonly lane: string;
  readonly owner: string;
  readonly laneClass?: LaneClass | undefined;
  /** The work tree the job runs in. */
  readonly tree?: string | undefined;
}

/** Why two jobs may not run at the same time, or undefined when they may. */
export function collision(a: LaneJob, b: LaneJob): string | undefined {
  if (!a.laneClass) return `${a.lane} has no class and runs alone`;
  if (!b.laneClass) return `${b.lane} has no class and runs alone`;
  if (a.tree && b.tree && samePath(a.tree, b.tree)) return `${b.lane} runs in the same work tree`;
  if (!MAY_OVERLAP[a.laneClass].includes(b.laneClass))
    return `${a.laneClass} and ${b.laneClass} never run together (${b.lane} is running)`;
  return undefined;
}

export interface Holder extends LaneJob {
  readonly slot: number;
  readonly dir: string;
  readonly startedMs: number;
  readonly owner: string;
  readonly pid?: number | undefined;
  readonly command?: string | undefined;
  /** Written by this code (false: the old single-slot code, or a run just starting). */
  readonly current: boolean;
}

export interface Queued extends LaneJob {
  readonly name: string;
}

export type Admission =
  /** `beside`: other jobs are running, so the admission floors of memory must hold first. */
  { readonly go: true; readonly beside: boolean } | { readonly go: false; readonly reason: string };

/** Whether the ticket `mine` may take a slot now (memory aside). Pure. `queue` is in queue order. */
export function decideAdmission(input: {
  readonly mine: string;
  readonly queue: readonly Queued[];
  readonly holders: readonly Holder[];
  readonly slots: number;
  readonly nowMs: number;
  readonly settleMs?: number;
}): Admission {
  const { holders, slots } = input;
  if (holders.length >= slots)
    return { go: false, reason: `all ${slots} slot${slots === 1 ? "" : "s"} busy` };
  const index = input.queue.findIndex((q) => q.name === input.mine);
  const ahead = index === -1 ? input.queue : input.queue.slice(0, index);
  for (const q of ahead) {
    if (!q.laneClass) return { go: false, reason: `queued after ${q.lane}, which runs alone` };
    if (!holders.some((h) => collision(q, h)))
      return { go: false, reason: `${q.lane} is ahead in the queue` };
  }
  if (holders.length === 0) return { go: true, beside: false };
  const me = index === -1 ? undefined : input.queue[index];
  if (!me) return { go: false, reason: "ticket not in the queue" };
  for (const h of holders) {
    const why = collision(me, h);
    if (why) return { go: false, reason: why };
  }
  const newest = Math.max(...holders.map((h) => h.startedMs));
  const settle = input.settleMs ?? ADMIT_SETTLE_MS;
  if (input.nowMs - newest < settle)
    return {
      go: false,
      reason: `letting the newest run take its memory (${Math.ceil((settle - (input.nowMs - newest)) / 1000)} s)`,
    };
  return { go: true, beside: true };
}

/** Slot k's lock directory: slot 1 is `<name>` itself (the old single-slot lock), then `<name>-k`. */
export function laneSlotDir(dir: string, name: string, slot: number): string {
  return slot <= 1 ? lockPath(dir, name) : lockPath(dir, `${name}-${slot}`);
}

/** Every slot directory present (also above the current slot count, after it was lowered). */
export function presentSlots(dir: string, name: string): { slot: number; dir: string }[] {
  const pattern = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:-(\\d+))?$`);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((n) => ({ n, m: pattern.exec(n) }))
    .filter((x): x is { n: string; m: RegExpExecArray } => x.m !== null)
    .map(({ n, m }) => ({ slot: m[1] ? Number(m[1]) : 1, dir: path.join(dir, n) }))
    .filter((s) => s.slot >= 1)
    .toSorted((a, b) => a.slot - b.slot);
}

/** Live holders of the lane's slots; stale ones are left out (and listed). */
export function laneHolders(
  dir: string,
  name: string,
  staleMs: number,
  nowMs: number,
): { holders: Holder[]; stale: { dir: string; reason: string; owner: LockOwner | undefined }[] } {
  const holders: Holder[] = [];
  const stale: { dir: string; reason: string; owner: LockOwner | undefined }[] = [];
  for (const s of presentSlots(dir, name)) {
    const owner = readOwner(s.dir);
    const reason = staleReason(s.dir, staleMs, nowMs);
    if (reason) {
      stale.push({ dir: s.dir, reason, owner });
      continue;
    }
    if (!owner) {
      // Being created right now: count it, starting now, without a class (so nothing joins it yet).
      holders.push({
        slot: s.slot,
        dir: s.dir,
        lane: "a starting run",
        owner: "?",
        startedMs: nowMs,
        current: false,
      });
      continue;
    }
    const extra = owner as LockOwner & {
      laneClass?: unknown;
      tree?: unknown;
      laneVersion?: unknown;
    };
    holders.push({
      slot: s.slot,
      dir: s.dir,
      lane: owner.lane,
      owner: owner.owner,
      pid: owner.pid,
      command: owner.command,
      laneClass: parseLaneClass(extra.laneClass),
      tree: typeof extra.tree === "string" ? extra.tree : undefined,
      startedMs: Date.parse(owner.started) || nowMs,
      current: extra.laneVersion === LANE_VERSION,
    });
  }
  return { holders, stale };
}

export function queuedFromTickets(tickets: readonly Ticket[]): Queued[] {
  return tickets.map((t) => ({
    name: t.name,
    lane: t.lane ?? "?",
    owner: t.owner,
    laneClass: parseLaneClass(t.laneClass),
    tree: t.tree,
  }));
}

export interface LaneSlotOptions {
  readonly dir: string;
  readonly name: string;
  readonly staleMs: number;
  readonly pollMs: number;
  readonly owner: Omit<LockOwner, "started" | "pid"> & { pid?: number };
  readonly laneClass: LaneClass | undefined;
  readonly tree: string | undefined;
  readonly jobClass: JobClass;
  readonly priorityOwners: readonly string[];
  /** Read at every poll, so a change to the profile counts for the next admission. */
  readonly slots: () => number;
  /** Read at every poll too; default ADMIT_SETTLE_MS. */
  readonly settleMs?: () => number;
  /** Why memory is under the admission floors right now (empty: admit). Asked only for a slot beside running jobs. */
  readonly admissionShortfall: () => string[];
  readonly log?: (line: string) => void;
  readonly label?: string;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

export interface HeldSlot extends HeldLock {
  readonly slot: number;
  /** The jobs running when this one was admitted. */
  readonly beside: readonly Holder[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits for a slot of the heavy lane under the rules at the top of this file. */
export async function acquireLaneSlot(options: LaneSlotOptions): Promise<HeldSlot> {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const label = options.label ?? "ws lane";
  fs.mkdirSync(options.dir, { recursive: true });
  const queueDir = `${lockPath(options.dir, options.name)}.queue`;
  fs.mkdirSync(queueDir, { recursive: true });
  const pid = options.owner.pid ?? process.pid;
  const job = {
    ...options.owner,
    pid,
    ...(options.laneClass ? { laneClass: options.laneClass } : {}),
    ...(options.tree ? { tree: options.tree } : {}),
    laneVersion: LANE_VERSION,
  };
  const ticketName = `${String(now()).padStart(15, "0")}-${pid}-${Math.random().toString(36).slice(2, 8)}.json`;
  const ticket = path.join(queueDir, ticketName);
  fs.writeFileSync(
    ticket,
    JSON.stringify({ ...job, jobClass: options.jobClass, since: new Date(now()).toISOString() }),
  );
  const dropTicket = () => {
    try {
      fs.unlinkSync(ticket);
    } catch {
      // gone
    }
  };
  const startedWaiting = now();
  let lastMessage = "";
  try {
    for (;;) {
      const slots = Math.max(1, Math.floor(options.slots()));
      const tickets = liveTickets(queueDir, options.priorityOwners, now());
      let { holders, stale } = laneHolders(options.dir, options.name, options.staleMs, now());
      // The head of the queue clears stale locks (atomically; see breakStale).
      if (stale.length && tickets[0]?.name === ticketName) {
        for (const s of stale) {
          log(
            `${label}: breaking stale lock (${s.reason}; was ${s.owner?.owner ?? "?"} / ${s.owner?.lane ?? "?"})`,
          );
          breakStale(s.dir, s.owner);
        }
        ({ holders } = laneHolders(options.dir, options.name, options.staleMs, now()));
      }
      const queue = queuedFromTickets(tickets);
      const decision = decideAdmission({
        mine: ticketName,
        queue,
        holders,
        slots,
        nowMs: now(),
        ...(options.settleMs ? { settleMs: options.settleMs() } : {}),
      });
      let reason = decision.go ? "" : decision.reason;
      if (decision.go) {
        const short = decision.beside ? options.admissionShortfall() : [];
        if (short.length) reason = `a slot is free but memory is short: ${short.join("; ")}`;
        else {
          const owner = { ...job, started: new Date(now()).toISOString() };
          for (let slot = 1; slot <= slots; slot += 1) {
            const slotDir = laneSlotDir(options.dir, options.name, slot);
            if (!tryCreate(slotDir, owner)) continue;
            dropTicket();
            writeQuickStreak(queueDir, options.jobClass);
            let held: LockOwner = owner;
            return {
              path: slotDir,
              slot,
              beside: holders,
              setChildPid(childPid: number) {
                held = { ...held, childPid };
                fs.writeFileSync(path.join(slotDir, "owner.json"), JSON.stringify(held, null, 2));
              },
              release() {
                const current = readOwner(slotDir);
                if (current && current.pid === held.pid && current.started === held.started)
                  removeLockDir(slotDir);
              },
            };
          }
          reason = "another run took the free slot first";
        }
      }
      const index = tickets.findIndex((t) => t.name === ticketName);
      const position = index === -1 ? tickets.length + 1 : index + 1;
      const priorityAhead = tickets.slice(0, Math.max(0, index)).filter((t) => t.priority).length;
      const shown = holders.map((h) =>
        h.owner === "?"
          ? "a starting run"
          : `${h.owner} (${h.lane}${h.laneClass ? `, ${h.laneClass}` : ""}, pid ${h.pid ?? "?"}, running ${formatMinutes(now() - h.startedMs)})` +
            (h.command ? `: ${h.command}` : ""),
      );
      // Changes once a minute with the holders' elapsed time, so waiters see progress.
      const message =
        `${label}: waiting, position ${position} in queue` +
        (priorityAhead ? ` (${priorityAhead} priority ahead)` : "") +
        "; " +
        (shown.length ? `held by ${shown.join(", ")}` : "the runs ahead are starting") +
        (slots > 1 ? ` [${holders.length} of ${slots} slots busy; ${reason}]` : "");
      if (message !== lastMessage) {
        log(message);
        lastMessage = message;
      }
      if (options.timeoutMs !== undefined && now() - startedWaiting > options.timeoutMs)
        throw new Error(`${label}: gave up waiting for the lock`);
      await sleep(options.pollMs);
    }
  } catch (error) {
    dropTicket();
    throw error;
  }
}

export interface LaneReportInput {
  readonly dir: string;
  readonly name: string;
  readonly staleMs: number;
  readonly slots: number;
  readonly settleMs?: number;
  readonly priorityOwners: readonly string[];
  readonly memory: MemoryState;
  /** Installed RAM, shown beside the free amount. */
  readonly totalGB?: number;
  readonly runFloor: MemoryFloor;
  readonly admitFloor: MemoryFloor;
  readonly nowMs: number;
}

/** `ws doctor`'s lane screen: every slot's holder, the queue with why each job waits, memory against both floors. */
export function laneReport(input: LaneReportInput): { lines: string[]; problems: string[] } {
  const lines: string[] = [];
  const problems: string[] = [];
  const { holders, stale } = laneHolders(input.dir, input.name, input.staleMs, input.nowMs);
  const present = presentSlots(input.dir, input.name);
  const highest = Math.max(input.slots, ...present.map((p) => p.slot));
  lines.push(
    `lane   ${input.name}: ${holders.length} of ${input.slots} slot${input.slots === 1 ? "" : "s"} busy (lock.heavySlots ${input.slots})`,
  );
  for (let slot = 1; slot <= highest; slot += 1) {
    const h = holders.find((x) => x.slot === slot);
    const s = stale.find((x) => x.dir === laneSlotDir(input.dir, input.name, slot));
    const over = slot > input.slots ? "  (above lock.heavySlots; ends with its run)" : "";
    if (h) {
      lines.push(
        `  slot ${slot}  ${h.owner === "?" ? "a starting run" : `${h.owner} (${h.lane}, ${h.laneClass ?? "no class: runs alone"}, pid ${h.pid ?? "?"}, running ${formatMinutes(input.nowMs - h.startedMs)}${h.current ? "" : ", old code"})`}` +
          (h.command ? `: ${h.command.slice(0, 120)}` : "") +
          over,
      );
    } else if (s) {
      lines.push(
        `  slot ${slot}  STALE: ${s.reason} (was ${s.owner?.owner ?? "?"} / ${s.owner?.lane ?? "?"})`,
      );
      problems.push(`heavy lane slot ${slot} is stale`);
    } else if (slot <= input.slots) lines.push(`  slot ${slot}  free`);
  }
  const short = memoryShortfall(input.memory, input.runFloor);
  const admitShort = memoryShortfall(input.memory, input.admitFloor);
  const f = (n: number | undefined) => (n === undefined ? "?" : n.toFixed(1));
  lines.push(
    `memory free ${f(input.memory.freeGB)} GB${input.totalGB ? ` of ${f(input.totalGB)} GB` : ""} (run floor ${input.runFloor.freeGB}, admission floor ${input.admitFloor.freeGB})` +
      (input.memory.commitHeadroomGB === undefined
        ? ""
        : `; commit headroom ${f(input.memory.commitHeadroomGB)} GB of ${f(input.memory.commitLimitGB)} GB (run floor ${input.runFloor.commitHeadroomGB}, admission floor ${input.admitFloor.commitHeadroomGB})`),
  );
  lines.push(
    short.length
      ? `       BELOW THE RUN FLOOR (lane runs wait): ${short.join("; ")}`
      : admitShort.length
        ? `       a job beside running ones waits: ${admitShort.join("; ")}`
        : "       a job beside running ones is admitted",
  );
  if (short.length) problems.push("memory below the floor");
  const tickets = liveTickets(
    `${lockPath(input.dir, input.name)}.queue`,
    input.priorityOwners,
    input.nowMs,
  );
  const queue = queuedFromTickets(tickets);
  const old = tickets.filter((t) => t.laneVersion !== LANE_VERSION).length;
  lines.push(
    `queue  ${tickets.length} waiting` +
      (old ? `; ${old} queued by the old code (they take slot 1 only and check no class)` : ""),
  );
  tickets.forEach((t, index) => {
    const d = decideAdmission({
      mine: t.name,
      queue,
      holders,
      slots: input.slots,
      nowMs: input.nowMs,
      ...(input.settleMs === undefined ? {} : { settleMs: input.settleMs }),
    });
    const state = !d.go
      ? `waits: ${d.reason}`
      : d.beside && admitShort.length
        ? `waits: memory short (${admitShort.join("; ")})`
        : "starts at its next poll";
    lines.push(
      `  ${index + 1}. ${t.owner || "?"} (${t.lane ?? "?"}, ${parseLaneClass(t.laneClass) ?? "no class"}` +
        `${t.jobClass === "quick" ? ", quick" : ""}${t.priority ? ", priority" : ""}, waited ${formatMinutes(input.nowMs - t.sinceMs)}` +
        `${t.laneVersion === LANE_VERSION ? "" : ", old code"}): ${state}`,
    );
  });
  return { lines, problems };
}
