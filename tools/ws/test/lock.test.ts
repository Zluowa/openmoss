import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireLock, lockPath, readOwner, staleReason } from "../lib/lock.ts";
import { cleanup, tempDir } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) cleanup(d);
});

const owner = (lane: string) => ({ owner: "test", lane, sha: "abc" });

function deadPid(): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", ""]);
    child.on("exit", () => resolve(child.pid!));
  });
}

describe("heavy-lane lock", () => {
  it("writes an owner file and removes the directory on release", async () => {
    const dir = tempDir("lock");
    dirs.push(dir);
    const lock = await acquireLock({
      dir,
      name: "heavy",
      staleMs: 3600_000,
      pollMs: 20,
      owner: owner("a"),
    });
    const o = readOwner(lockPath(dir, "heavy"));
    expect(o).toMatchObject({ pid: process.pid, owner: "test", lane: "a", sha: "abc" });
    expect(Date.parse(o!.started)).toBeGreaterThan(0);
    lock.setChildPid(1234);
    expect(readOwner(lockPath(dir, "heavy"))!.childPid).toBe(1234);
    lock.release();
    expect(fs.existsSync(lockPath(dir, "heavy"))).toBe(false);
  });

  it("makes a second taker wait until the first releases, printing its position", async () => {
    const dir = tempDir("lock");
    dirs.push(dir);
    const first = await acquireLock({
      dir,
      name: "heavy",
      staleMs: 3600_000,
      pollMs: 20,
      owner: owner("first"),
    });
    const log: string[] = [];
    let secondGot = 0;
    const second = acquireLock({
      dir,
      name: "heavy",
      staleMs: 3600_000,
      pollMs: 20,
      owner: owner("second"),
      log: (l) => log.push(l),
    }).then((l) => {
      secondGot = Date.now();
      return l;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(secondGot).toBe(0);
    const releasedAt = Date.now();
    first.release();
    const held = await second;
    expect(secondGot).toBeGreaterThanOrEqual(releasedAt);
    expect(log.join("\n")).toMatch(/position 1 in queue; held by test \(first/);
    held.release();
  });

  it("treats a lock whose pid is gone as stale and takes it", async () => {
    const dir = tempDir("lock");
    dirs.push(dir);
    const lockDir = lockPath(dir, "heavy");
    fs.mkdirSync(lockDir);
    const pid = await deadPid();
    fs.writeFileSync(
      path.join(lockDir, "owner.json"),
      JSON.stringify({
        pid,
        owner: "ghost",
        lane: "x",
        sha: "",
        started: new Date().toISOString(),
      }),
    );
    expect(staleReason(lockDir, 3600_000)).toMatch(/is gone/);
    const log: string[] = [];
    const lock = await acquireLock({
      dir,
      name: "heavy",
      staleMs: 3600_000,
      pollMs: 20,
      owner: owner("b"),
      log: (l) => log.push(l),
    });
    expect(log.join("\n")).toMatch(/breaking stale lock/);
    expect(readOwner(lockDir)!.lane).toBe("b");
    lock.release();
  });

  it("treats a live lock older than the limit as stale, and a fresh live one as held", () => {
    const dir = tempDir("lock");
    dirs.push(dir);
    const lockDir = lockPath(dir, "heavy");
    fs.mkdirSync(lockDir);
    const write = (started: string) =>
      fs.writeFileSync(
        path.join(lockDir, "owner.json"),
        JSON.stringify({ pid: process.pid, owner: "me", lane: "x", sha: "", started }),
      );
    write(new Date(Date.now() - 4 * 3600_000).toISOString());
    expect(staleReason(lockDir, 3 * 3600_000)).toMatch(/older than/);
    write(new Date().toISOString());
    expect(staleReason(lockDir, 3 * 3600_000)).toBeUndefined();
  });

  it("keeps a lock alive while the child it started still runs", async () => {
    const dir = tempDir("lock");
    dirs.push(dir);
    const lockDir = lockPath(dir, "heavy");
    fs.mkdirSync(lockDir);
    fs.writeFileSync(
      path.join(lockDir, "owner.json"),
      JSON.stringify({
        pid: await deadPid(),
        childPid: process.pid,
        owner: "me",
        lane: "x",
        sha: "",
        started: new Date().toISOString(),
      }),
    );
    expect(staleReason(lockDir, 3600_000)).toBeUndefined();
  });
});
