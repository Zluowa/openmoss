// Machine-wide locks as atomic directories (mkdir either creates or fails, on every file system).
// The lock directory holds owner.json {pid, childPid, owner, lane, sha, started}. A lock is stale when
// neither its pid nor its child pid is alive, or it is older than the stale limit. Waiters take a
// ticket in <name>.queue and only the oldest live tickets try to take the lock, so waiting is fair.
// A lock with several slots (`bun run check` allows two at once) is the directories <name>-1 to
// <name>-N sharing one queue. Tickets of priority owners (profile lock.priorityOwners, the lead) go
// ahead of the others, so the lead gets the lane when the current run ends; a running command is
// never interrupted. Then "quick" tickets (a capped job the caller declares with `ws lane --quick`)
// go ahead of "long" ones, so a 4 s code-update build does not wait 39 min behind installers
// (2026-11-18); after QUICK_STREAK quick runs in a row, a long ticket that has waited LONG_WAIT_MS
// goes next, so long jobs are never starved.
import fs from "node:fs";
import path from "node:path";
import { isAlive } from "./proc.ts";

/** The heavy-lane lock under <stateDir>/locks. */
export const HEAVY_LOCK = "heavy";
/** Set to the lane's name for the command `ws lane` runs. */
export const LANE_ENV = "MOSS_WS_LANE";

export interface LockOwner {
  pid: number;
  childPid?: number;
  owner: string;
  lane: string;
  sha: string;
  started: string;
  /** The command the holder runs, shown to waiters. */
  command?: string;
}

export interface LockOptions {
  readonly dir: string;
  readonly name: string;
  readonly staleMs: number;
  readonly pollMs: number;
  readonly owner: Omit<LockOwner, "started" | "pid"> & { pid?: number };
  readonly log?: (line: string) => void;
  readonly now?: () => number;
  /** Give up after this long (tests); default wait forever. */
  readonly timeoutMs?: number;
  /** How many may hold the lock at once (default 1). */
  readonly slots?: number;
  /** Prefix of the lines it logs (default "ws lane"). */
  readonly label?: string;
  /** Owners whose tickets go ahead of everyone else's. */
  readonly priorityOwners?: readonly string[];
  /** "quick" jobs go ahead of "long" ones (default "long"). */
  readonly jobClass?: JobClass;
}

export type JobClass = "quick" | "long";
/** Quick runs in a row after which a long ticket that waited LONG_WAIT_MS goes next. */
export const QUICK_STREAK = 3;
export const LONG_WAIT_MS = 10 * 60_000;

export interface HeldLock {
  readonly path: string;
  setChildPid(pid: number): void;
  release(): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function lockPath(dir: string, name: string): string {
  return path.join(dir, name);
}

/** The lock directories of a lock with `slots` slots. */
export function slotPaths(dir: string, name: string, slots = 1): string[] {
  return slots <= 1
    ? [lockPath(dir, name)]
    : Array.from({ length: slots }, (_, index) => lockPath(dir, `${name}-${index + 1}`));
}

/** The owner of a held, live lock, or undefined when it is free or stale. */
export function liveOwner(
  lockDir: string,
  staleMs: number,
  now = Date.now(),
): LockOwner | undefined {
  if (!fs.existsSync(lockDir) || staleReason(lockDir, staleMs, now)) return undefined;
  return readOwner(lockDir);
}

export function readOwner(lockDir: string): LockOwner | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8")) as LockOwner;
  } catch {
    return undefined;
  }
}

/** Why a held lock is stale, or undefined when it is live. */
export function staleReason(
  lockDir: string,
  staleMs: number,
  now = Date.now(),
): string | undefined {
  const owner = readOwner(lockDir);
  if (!owner) {
    // Being created right now, or the creator died between mkdir and writing owner.json.
    try {
      const age = now - fs.statSync(lockDir).mtimeMs;
      return age > 60_000 ? "no owner file for over a minute" : undefined;
    } catch {
      return undefined;
    }
  }
  const age = now - Date.parse(owner.started);
  if (Number.isFinite(age) && age > staleMs)
    return `older than ${Math.round(staleMs / 60_000)} min`;
  if (!isAlive(owner.pid) && !(owner.childPid && isAlive(owner.childPid)))
    return `pid ${owner.pid} is gone`;
  return undefined;
}

function removeLockDir(dir: string): void {
  try {
    for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name));
    fs.rmdirSync(dir);
  } catch {
    // someone else cleaned it
  }
}

/** Moves a stale lock aside atomically, so two waiters cannot both break it. */
export function breakStale(lockDir: string, judged: LockOwner | undefined): boolean {
  const aside = `${lockDir}.stale-${Date.now()}-${process.pid}`;
  try {
    fs.renameSync(lockDir, aside);
  } catch {
    return false;
  }
  const moved = readOwner(aside);
  if (judged && moved && (moved.pid !== judged.pid || moved.started !== judged.started)) {
    // A fresh owner took the lock between our check and the rename: put it back.
    try {
      fs.renameSync(aside, lockDir);
    } catch {
      // the fresh owner keeps running; its release will find no lock, which is harmless
    }
    return false;
  }
  removeLockDir(aside);
  return true;
}

function tryCreate(lockDir: string, owner: LockOwner): boolean {
  try {
    fs.mkdirSync(lockDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify(owner, null, 2));
  return true;
}

export interface Ticket {
  name: string;
  file: string;
  pid: number;
  owner: string;
  priority: boolean;
  jobClass: JobClass;
  /** When the ticket was taken (from its name). */
  sinceMs: number;
}

/** How many quick runs have taken the lock in a row (reset by a long one). */
export function readQuickStreak(queueDir: string): number {
  try {
    return Number(fs.readFileSync(`${queueDir}.streak`, "utf8")) || 0;
  } catch {
    return 0;
  }
}

function writeQuickStreak(queueDir: string, jobClass: JobClass): void {
  const next = jobClass === "quick" ? readQuickStreak(queueDir) + 1 : 0;
  try {
    fs.writeFileSync(`${queueDir}.streak`, String(next));
  } catch {
    // best effort
  }
}

/**
 * Queue order: priority owners first; then quick before long, except that after QUICK_STREAK quick
 * runs in a row a long ticket that has waited LONG_WAIT_MS goes first; then by time. Pure.
 */
export function orderTickets(
  tickets: readonly Ticket[],
  quickStreak: number,
  nowMs: number,
): Ticket[] {
  const starvedLong = quickStreak >= QUICK_STREAK;
  const rank = (t: Ticket) => {
    if (t.jobClass === "quick") return 1;
    return starvedLong && nowMs - t.sinceMs >= LONG_WAIT_MS ? 0 : 2;
  };
  return tickets.toSorted(
    (a, b) =>
      Number(b.priority) - Number(a.priority) || rank(a) - rank(b) || a.name.localeCompare(b.name),
  );
}

/** Live tickets in queue order (orderTickets); dead tickets are removed. */
export function liveTickets(
  queueDir: string,
  priorityOwners: readonly string[] = [],
  nowMs = Date.now(),
): Ticket[] {
  let names: string[] = [];
  try {
    names = fs
      .readdirSync(queueDir)
      .filter((n) => n.endsWith(".json"))
      .toSorted();
  } catch {
    return [];
  }
  const out: Ticket[] = [];
  for (const name of names) {
    const file = path.join(queueDir, name);
    const pid = Number(name.split("-")[1]);
    if (!isAlive(pid)) {
      try {
        fs.unlinkSync(file);
      } catch {
        // already gone
      }
      continue;
    }
    let owner = "";
    let jobClass: JobClass = "long";
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
        owner?: unknown;
        jobClass?: unknown;
      };
      owner = String(raw.owner ?? "");
      if (raw.jobClass === "quick") jobClass = "quick";
    } catch {
      // being written: no priority this round
    }
    out.push({
      name,
      file,
      pid,
      owner,
      priority: priorityOwners.includes(owner),
      jobClass,
      sinceMs: Number(name.split("-")[0]) || 0,
    });
  }
  return orderTickets(out, readQuickStreak(queueDir), nowMs);
}

function liveTicketsBefore(
  queueDir: string,
  mine: string,
  priorityOwners: readonly string[],
): Ticket[] {
  const queue = liveTickets(queueDir, priorityOwners, Date.now());
  const index = queue.findIndex((ticket) => ticket.name === mine);
  return index === -1 ? queue : queue.slice(0, index);
}

/** "12 min", "1 h 05 min". */
export function formatMinutes(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  return minutes < 60
    ? `${minutes} min`
    : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

export async function acquireLock(options: LockOptions): Promise<HeldLock> {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const label = options.label ?? "ws lane";
  const slots = Math.max(1, options.slots ?? 1);
  fs.mkdirSync(options.dir, { recursive: true });
  const lockDirs = slotPaths(options.dir, options.name, slots);
  const queueDir = `${lockPath(options.dir, options.name)}.queue`;
  fs.mkdirSync(queueDir, { recursive: true });
  const pid = options.owner.pid ?? process.pid;
  const ticketName = `${String(now()).padStart(15, "0")}-${pid}-${Math.random().toString(36).slice(2, 8)}.json`;
  const ticket = path.join(queueDir, ticketName);
  fs.writeFileSync(
    ticket,
    JSON.stringify({
      ...options.owner,
      pid,
      jobClass: options.jobClass ?? "long",
      since: new Date(now()).toISOString(),
    }),
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
      const ahead = liveTicketsBefore(queueDir, ticketName, options.priorityOwners ?? []);
      if (ahead.length < slots) {
        const owner: LockOwner = { ...options.owner, pid, started: new Date(now()).toISOString() };
        const lockDir = lockDirs.find((candidate) => tryCreate(candidate, owner));
        if (lockDir) {
          dropTicket();
          writeQuickStreak(queueDir, options.jobClass ?? "long");
          let held = owner;
          return {
            path: lockDir,
            setChildPid(childPid: number) {
              held = { ...held, childPid };
              fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify(held, null, 2));
            },
            release() {
              const current = readOwner(lockDir);
              if (current && current.pid === held.pid && current.started === held.started)
                removeLockDir(lockDir);
            },
          };
        }
        let broke = false;
        for (const candidate of lockDirs) {
          const holder = readOwner(candidate);
          const stale = staleReason(candidate, options.staleMs, now());
          if (!stale) continue;
          log(
            `${label}: breaking stale lock (${stale}; was ${holder?.owner ?? "?"} / ${holder?.lane ?? "?"})`,
          );
          breakStale(candidate, holder);
          broke = true;
        }
        if (broke) continue;
      }
      const holders = lockDirs
        .filter((candidate) => fs.existsSync(candidate))
        .map((candidate) => {
          const holder = readOwner(candidate);
          if (!holder) return "a starting run";
          const elapsed = formatMinutes(now() - Date.parse(holder.started));
          return (
            `${holder.owner} (${holder.lane}, pid ${holder.pid}, running ${elapsed})` +
            (holder.command ? `: ${holder.command}` : "")
          );
        });
      const priorityAhead = ahead.filter((ticket) => ticket.priority).length;
      // Changes once a minute with the holder's elapsed time, so waiters see progress.
      const message =
        `${label}: waiting, position ${ahead.length + 1} in queue` +
        (priorityAhead ? ` (${priorityAhead} priority ahead)` : "") +
        "; " +
        (holders.length ? `held by ${holders.join(", ")}` : "the runs ahead are starting");
      if (message !== lastMessage) {
        log(message);
        lastMessage = message;
      }
      if (options.timeoutMs !== undefined && now() - startedWaiting > options.timeoutMs) {
        throw new Error(`${label}: gave up waiting for the lock`);
      }
      await sleep(options.pollMs);
    }
  } catch (error) {
    dropTicket();
    throw error;
  }
}
