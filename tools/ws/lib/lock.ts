// Machine-wide locks as atomic directories (mkdir either creates or fails, on every file system).
// The lock directory holds owner.json {pid, childPid, owner, lane, sha, started}. A lock is stale when
// neither its pid nor its child pid is alive, or it is older than the stale limit. Waiters take a
// ticket in <name>.queue and only the oldest live tickets try to take the lock, so waiting is fair.
// A lock with several slots (`bun run check` allows two at once) is the directories <name>-1 to
// <name>-N sharing one queue.
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
}

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

interface Ticket {
  file: string;
  pid: number;
}

function liveTicketsBefore(queueDir: string, mine: string): Ticket[] {
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
    if (name >= mine) break;
    const file = path.join(queueDir, name);
    const pid = Number(name.split("-")[1]);
    if (isAlive(pid)) out.push({ file, pid });
    else {
      try {
        fs.unlinkSync(file);
      } catch {
        // already gone
      }
    }
  }
  return out;
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
    JSON.stringify({ ...options.owner, pid, since: new Date(now()).toISOString() }),
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
      const ahead = liveTicketsBefore(queueDir, ticketName);
      if (ahead.length < slots) {
        const owner: LockOwner = { ...options.owner, pid, started: new Date(now()).toISOString() };
        const lockDir = lockDirs.find((candidate) => tryCreate(candidate, owner));
        if (lockDir) {
          dropTicket();
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
          return holder
            ? `${holder.owner} (${holder.lane}, pid ${holder.pid}, since ${holder.started})`
            : "a starting run";
        });
      const message =
        `${label}: waiting, position ${ahead.length + 1} in queue; ` +
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
