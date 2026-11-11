// Machine-wide locks as atomic directories (mkdir either creates or fails, on every file system).
// The lock directory holds owner.json {pid, childPid, owner, lane, sha, started}. A lock is stale when
// neither its pid nor its child pid is alive, or it is older than the stale limit. Waiters take a
// ticket in <name>.queue and only the oldest live ticket tries to take the lock, so waiting is fair.
import fs from "node:fs";
import path from "node:path";
import { isAlive } from "./proc.ts";

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
  fs.mkdirSync(options.dir, { recursive: true });
  const lockDir = lockPath(options.dir, options.name);
  const queueDir = `${lockDir}.queue`;
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
      if (ahead.length === 0) {
        const owner: LockOwner = { ...options.owner, pid, started: new Date(now()).toISOString() };
        if (tryCreate(lockDir, owner)) {
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
        const holder = readOwner(lockDir);
        const stale = staleReason(lockDir, options.staleMs, now());
        if (stale) {
          log(
            `ws lane: breaking stale lock (${stale}; was ${holder?.owner ?? "?"} / ${holder?.lane ?? "?"})`,
          );
          breakStale(lockDir, holder);
          continue;
        }
      }
      const holder = readOwner(lockDir);
      const message =
        `ws lane: waiting, position ${ahead.length + 1} in queue; held by ` +
        (holder
          ? `${holder.owner} (${holder.lane}, pid ${holder.pid}, since ${holder.started})`
          : "a starting run");
      if (message !== lastMessage) {
        log(message);
        lastMessage = message;
      }
      if (options.timeoutMs !== undefined && now() - startedWaiting > options.timeoutMs) {
        throw new Error("ws lane: gave up waiting for the lock");
      }
      await sleep(options.pollMs);
    }
  } catch (error) {
    dropTicket();
    throw error;
  }
}
