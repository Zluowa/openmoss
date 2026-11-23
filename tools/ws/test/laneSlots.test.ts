import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  acquireLaneSlot,
  collision,
  decideAdmission,
  LANE_CLASSES,
  LANE_VERSION,
  laneReport,
  MAY_OVERLAP,
  type Holder,
  type LaneClass,
  type Queued,
} from "../lib/laneSlots.ts";
import { parseProfile } from "../lib/profile.ts";
import { cleanup, tempDir } from "./helpers.ts";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.ts");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) cleanup(d);
});
const base = (prefix: string) => {
  const d = tempDir(prefix);
  dirs.push(d);
  return d;
};

const NOW = 1_800_000_000_000;
const holder = (
  lane: string,
  laneClass: LaneClass | undefined,
  tree = lane,
  ageMs = 600_000,
): Holder => ({
  slot: 1,
  dir: lane,
  lane,
  owner: "s",
  laneClass,
  tree,
  startedMs: NOW - ageMs,
  current: true,
});
const queued = (name: string, laneClass: LaneClass | undefined, tree = name): Queued => ({
  name,
  lane: name,
  owner: "s",
  laneClass,
  tree,
});

describe("job classes", () => {
  it("lets only the pairs of the table share the machine, the same both ways", () => {
    const allowed: string[] = [];
    for (const a of LANE_CLASSES)
      for (const b of LANE_CLASSES) {
        const ab = collision(
          { lane: "a", owner: "", laneClass: a, tree: "/a" },
          { lane: "b", owner: "", laneClass: b, tree: "/b" },
        );
        const ba = collision(
          { lane: "b", owner: "", laneClass: b, tree: "/b" },
          { lane: "a", owner: "", laneClass: a, tree: "/a" },
        );
        expect(ab === undefined).toBe(ba === undefined);
        expect(ab === undefined).toBe(MAY_OVERLAP[a].includes(b));
        if (!ab) allowed.push(`${a}+${b}`);
      }
    expect(collision(holder("x", "build"), holder("y", "build"))).toMatch(
      /build and build never run together/,
    );
    expect(collision(holder("x", "window"), holder("y", "window"))).toMatch(/never run together/);
    expect(collision(holder("x", "build"), holder("y", "window"))).toMatch(/never run together/);
    expect(allowed).toContain("test+test");
    expect(allowed).toContain("build+test");
    expect(allowed).toContain("window+typecheck");
  });

  it("never runs two jobs in the same work tree, nor a job without a class beside anything", () => {
    expect(collision(holder("x", "typecheck", "/t"), holder("y", "test", "/t"))).toMatch(
      /same work tree/,
    );
    expect(collision(holder("x", undefined), holder("y", "typecheck"))).toMatch(
      /no class and runs alone/,
    );
    expect(collision(holder("x", "typecheck"), holder("y", undefined))).toMatch(
      /no class and runs alone/,
    );
  });
});

describe("admission", () => {
  it("at one slot behaves as the single lock did: only the head of the queue, only on an empty lane", () => {
    const queue = [queued("a", "test"), queued("b", "typecheck")];
    expect(decideAdmission({ mine: "a", queue, holders: [], slots: 1, nowMs: NOW })).toEqual({
      go: true,
      beside: false,
    });
    expect(decideAdmission({ mine: "b", queue, holders: [], slots: 1, nowMs: NOW })).toMatchObject({
      go: false,
    });
    expect(
      decideAdmission({ mine: "a", queue, holders: [holder("h", "test")], slots: 1, nowMs: NOW }),
    ).toEqual({ go: false, reason: "all 1 slot busy" });
  });

  it("admits a job beside a running one when a slot is free and the classes may share", () => {
    const queue = [queued("a", "test")];
    expect(
      decideAdmission({ mine: "a", queue, holders: [holder("h", "build")], slots: 2, nowMs: NOW }),
    ).toEqual({
      go: true,
      beside: true,
    });
    expect(
      decideAdmission({
        mine: "a",
        queue: [queued("a", "build")],
        holders: [holder("h", "build")],
        slots: 2,
        nowMs: NOW,
      }),
    ).toMatchObject({ go: false, reason: expect.stringMatching(/never run together/) });
  });

  it("lets a job pass one that collides, but nothing passes a job that runs alone", () => {
    const holders = [holder("h", "build")];
    const passing = [queued("blocked-build", "build"), queued("t", "test")];
    expect(decideAdmission({ mine: "t", queue: passing, holders, slots: 3, nowMs: NOW })).toEqual({
      go: true,
      beside: true,
    });
    const barrier = [queued("alone", undefined), queued("t", "test")];
    expect(decideAdmission({ mine: "t", queue: barrier, holders, slots: 3, nowMs: NOW })).toEqual({
      go: false,
      reason: "queued after alone, which runs alone",
    });
    expect(
      decideAdmission({ mine: "alone", queue: barrier, holders, slots: 3, nowMs: NOW }),
    ).toMatchObject({ go: false });
    expect(
      decideAdmission({ mine: "alone", queue: barrier, holders: [], slots: 3, nowMs: NOW }),
    ).toEqual({
      go: true,
      beside: false,
    });
  });

  it("waits until the newest running job has had time to take its memory", () => {
    const queue = [queued("t", "test")];
    const young = [holder("h", "test", "h", 20_000)];
    expect(
      decideAdmission({ mine: "t", queue, holders: young, slots: 2, nowMs: NOW, settleMs: 60_000 }),
    ).toMatchObject({
      go: false,
      reason: expect.stringMatching(/letting the newest run take its memory \(40 s\)/),
    });
    expect(
      decideAdmission({ mine: "t", queue, holders: young, slots: 2, nowMs: NOW, settleMs: 10_000 }),
    ).toEqual({
      go: true,
      beside: true,
    });
  });
});

const owner = { owner: "t", lane: "x", sha: "" };
const laneOptions = (dir: string, over: Partial<Parameters<typeof acquireLaneSlot>[0]> = {}) => ({
  dir,
  name: "heavy",
  staleMs: 3600_000,
  pollMs: 20,
  owner,
  laneClass: "test" as const,
  tree: path.join(dir, "tree-x"),
  jobClass: "long" as const,
  priorityOwners: [],
  slots: () => 2,
  settleMs: () => 0,
  admissionShortfall: () => [] as string[],
  ...over,
});

describe("acquireLaneSlot", () => {
  it("keeps slot 1 in the old lock folder, puts slot 2 beside it, and refuses a slot under the memory floor", async () => {
    const dir = base("slots");
    const first = await acquireLaneSlot(
      laneOptions(dir, { owner: { ...owner, lane: "one" }, tree: "/one" }),
    );
    expect(first.path).toBe(path.join(dir, "heavy"));
    expect(first.slot).toBe(1);

    const lines: string[] = [];
    await expect(
      acquireLaneSlot(
        laneOptions(dir, {
          owner: { ...owner, lane: "two" },
          tree: "/two",
          admissionShortfall: () => ["free memory 1.0 GB (admission floor 8 GB)"],
          timeoutMs: 150,
          log: (l) => lines.push(l),
        }),
      ),
    ).rejects.toThrow(/gave up/);
    expect(lines.join("\n")).toMatch(
      /a slot is free but memory is short: free memory 1.0 GB \(admission floor 8 GB\)/,
    );
    expect(fs.existsSync(path.join(dir, "heavy-2"))).toBe(false);

    const second = await acquireLaneSlot(
      laneOptions(dir, { owner: { ...owner, lane: "two" }, tree: "/two" }),
    );
    expect(second.path).toBe(path.join(dir, "heavy-2"));
    expect(second.beside.map((h) => h.lane)).toEqual(["one"]);
    first.release();
    second.release();
    expect(fs.readdirSync(dir).filter((n) => n.startsWith("heavy") && !n.includes("."))).toEqual(
      [],
    );
  });

  it("does not measure memory for an empty lane: slot 1 keeps the old flow (run floor checked after the lock)", async () => {
    const dir = base("slots");
    let asked = 0;
    const held = await acquireLaneSlot(
      laneOptions(dir, { admissionShortfall: () => (asked++, ["short"]) }),
    );
    expect(held.slot).toBe(1);
    expect(asked).toBe(0);
    held.release();
  });

  it("waits beside a job of the old code (no class) and reads the slot count at every poll", async () => {
    const dir = base("slots");
    fs.mkdirSync(path.join(dir, "heavy"));
    fs.writeFileSync(
      path.join(dir, "heavy", "owner.json"),
      JSON.stringify({
        pid: process.pid,
        owner: "old",
        lane: "old-run",
        sha: "",
        started: new Date().toISOString(),
      }),
    );
    const lines: string[] = [];
    await expect(
      acquireLaneSlot(
        laneOptions(dir, { slots: () => 3, timeoutMs: 150, log: (l) => lines.push(l) }),
      ),
    ).rejects.toThrow(/gave up/);
    expect(lines.join("\n")).toMatch(/old-run has no class and runs alone/);

    // The old run ends; the lead lowers the slot count to 1 meanwhile: still admitted (empty lane).
    fs.rmSync(path.join(dir, "heavy"), { recursive: true });
    let slots = 0;
    const held = await acquireLaneSlot(laneOptions(dir, { slots: () => ((slots += 1), 1) }));
    expect(held.slot).toBe(1);
    expect(slots).toBeGreaterThan(0);
    held.release();
  });

  it("breaks a stale slot when it is at the head of the queue", async () => {
    const dir = base("slots");
    fs.mkdirSync(path.join(dir, "heavy-2"));
    fs.writeFileSync(
      path.join(dir, "heavy-2", "owner.json"),
      JSON.stringify({
        pid: 999_999_99,
        owner: "gone",
        lane: "dead",
        sha: "",
        started: new Date().toISOString(),
        laneClass: "build",
      }),
    );
    const lines: string[] = [];
    const held = await acquireLaneSlot(laneOptions(dir, { log: (l) => lines.push(l) }));
    expect(lines.join("\n")).toMatch(
      /breaking stale lock \(pid 99999999 is gone; was gone \/ dead\)/,
    );
    expect(fs.existsSync(path.join(dir, "heavy-2"))).toBe(false);
    expect(held.slot).toBe(1);
    held.release();
  });
});

describe("ws doctor lane screen", () => {
  it("shows each slot's holder, the queue with why each waits, and memory against both floors", async () => {
    const dir = base("slots");
    const held = await acquireLaneSlot(
      laneOptions(dir, {
        owner: { ...owner, lane: "builder", command: "bun run build" },
        laneClass: "build",
        tree: "/b",
      }),
    );
    const waiting = acquireLaneSlot(
      laneOptions(dir, {
        owner: { ...owner, lane: "second-build" },
        laneClass: "build",
        tree: "/c",
        timeoutMs: 400,
      }),
    ).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 100));
    const report = laneReport({
      dir,
      name: "heavy",
      staleMs: 3600_000,
      slots: 2,
      priorityOwners: [],
      memory: { freeGB: 9.5, commitHeadroomGB: 7.8, commitLimitGB: 51.7 },
      totalGB: 31.8,
      runFloor: { freeGB: 4, commitHeadroomGB: 8 },
      admitFloor: { freeGB: 8, commitHeadroomGB: 12 },
      nowMs: Date.now(),
    });
    const text = report.lines.join("\n");
    expect(text).toMatch(/lane {3}heavy: 1 of 2 slots busy \(lock.heavySlots 2\)/);
    expect(text).toMatch(/slot 1 {2}t \(builder, build, pid \d+, running 0 min\): bun run build/);
    expect(text).toMatch(/slot 2 {2}free/);
    expect(text).toMatch(
      /memory free 9.5 GB of 31.8 GB \(run floor 4, admission floor 8\); commit headroom 7.8 GB of 51.7 GB \(run floor 8, admission floor 12\)/,
    );
    expect(text).toMatch(/BELOW THE RUN FLOOR/);
    expect(text).toMatch(/queue {2}1 waiting\n/);
    expect(text).toMatch(
      /1\. t \(second-build, build, waited 0 min\): waits: build and build never run together/,
    );
    expect(report.problems).toEqual(["memory below the floor"]);
    await waiting;
    held.release();
  });

  it("marks tickets and holders of the old code", () => {
    const dir = base("slots");
    fs.mkdirSync(path.join(dir, "heavy.queue"), { recursive: true });
    fs.writeFileSync(
      path.join(
        dir,
        "heavy.queue",
        `${String(Date.now()).padStart(15, "0")}-${process.pid}-abc.json`,
      ),
      JSON.stringify({ owner: "o", lane: "old-wait", pid: process.pid, jobClass: "long" }),
    );
    const text = laneReport({
      dir,
      name: "heavy",
      staleMs: 3600_000,
      slots: 1,
      priorityOwners: [],
      memory: { freeGB: 20, commitHeadroomGB: 20, commitLimitGB: 50 },
      runFloor: { freeGB: 4, commitHeadroomGB: 8 },
      admitFloor: { freeGB: 8, commitHeadroomGB: 12 },
      nowMs: Date.now(),
    }).lines.join("\n");
    expect(text).toMatch(/queue {2}1 waiting; 1 queued by the old code/);
    expect(text).toMatch(/old-wait, no class, waited 0 min, old code\): starts at its next poll/);
    expect(LANE_VERSION).toBe(2);
  });
});

// ---- the real command, two processes ----

function profileAt(at: string, lock: Record<string, unknown>): string {
  const file = path.join(at, "profile.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      primaryCheckout: path.join(at, "primary"),
      worktreeRoot: path.join(at, "wt"),
      stateDir: path.join(at, "state"),
      disk: { floorGB: 0, drives: [at], waitMinutes: 0 },
      memory: {
        freeGB: 0,
        commitHeadroomGB: 0,
        waitMinutes: 0,
        admitFreeGB: 0,
        admitCommitHeadroomGB: 0,
      },
      lock: { staleHours: 3, pollSeconds: 0.1, admitSettleSeconds: 0, ...lock },
    }),
  );
  return file;
}

function runCli(
  profile: string,
  cwd: string,
  argv: string[],
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...argv], {
      cwd,
      env: { ...process.env, MOSS_WS_PROFILE: profile, MOSS_WS_OWNER: "slots-test" },
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (code) => resolve({ code: code ?? -1, stderr }));
  });
}

/** Records start and end times; ends when `gate` exists (or after `ms`). */
function sleeper(log: string, tag: string, ms: number): string[] {
  const js =
    `const fs=require('fs');fs.appendFileSync(${JSON.stringify(log)},'${tag} start '+Date.now()+'\\n');` +
    `setTimeout(()=>{fs.appendFileSync(${JSON.stringify(log)},'${tag} end '+Date.now()+'\\n')},${ms})`;
  return [process.execPath, "-e", js];
}

function times(log: string): Record<string, number> {
  return Object.fromEntries(
    fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => {
        const [tag, what, t] = l.split(" ");
        return [`${tag}.${what}`, Number(t)];
      }),
  );
}

function queueLength(at: string): number {
  try {
    return fs
      .readdirSync(path.join(at, "state", "locks", "heavy.queue"))
      .filter((n) => n.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

async function until(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("ws lane with slots", () => {
  it("runs two jobs of classes that may share side by side when lock.heavySlots is 2", async () => {
    const at = base("lane-slots");
    const profile = profileAt(at, { heavySlots: 2 });
    const log = path.join(at, "times.log");
    for (const t of ["tree-a", "tree-b"]) fs.mkdirSync(path.join(at, t));
    const [a, b] = await Promise.all([
      runCli(profile, path.join(at, "tree-a"), [
        "lane",
        "a",
        "--class",
        "test",
        "--",
        ...sleeper(log, "a", 4000),
      ]),
      runCli(profile, path.join(at, "tree-b"), [
        "lane",
        "b",
        "--class",
        "typecheck",
        "--",
        ...sleeper(log, "b", 4000),
      ]),
    ]);
    expect([a.code, b.code]).toEqual([0, 0]);
    const t = times(log);
    expect(Math.max(t["a.start"]!, t["b.start"]!)).toBeLessThan(Math.min(t["a.end"]!, t["b.end"]!));
    expect(`${a.stderr}${b.stderr}`).toMatch(
      /lock held \(slot 2, beside [ab] \[(test|typecheck)\]\)/,
    );
    expect(
      fs.readdirSync(path.join(at, "state", "locks")).filter((n) => /^heavy(-\d+)?$/.test(n)),
    ).toEqual([]);
  });

  it("keeps the single-slot behaviour at heavySlots 1, classes or not", async () => {
    const at = base("lane-slots");
    const profile = profileAt(at, { heavySlots: 1 });
    const log = path.join(at, "times.log");
    for (const t of ["tree-a", "tree-b"]) fs.mkdirSync(path.join(at, t));
    const [a, b] = await Promise.all([
      runCli(profile, path.join(at, "tree-a"), [
        "lane",
        "a",
        "--class",
        "test",
        "--",
        ...sleeper(log, "a", 1500),
      ]),
      runCli(profile, path.join(at, "tree-b"), [
        "lane",
        "b",
        "--class",
        "test",
        "--",
        ...sleeper(log, "b", 1500),
      ]),
    ]);
    expect([a.code, b.code]).toEqual([0, 0]);
    const t = times(log);
    const [firstEnd, secondStart] =
      t["a.start"]! < t["b.start"]! ? [t["a.end"]!, t["b.start"]!] : [t["b.end"]!, t["a.start"]!];
    expect(secondStart).toBeGreaterThanOrEqual(firstEnd);
    expect(`${a.stderr}${b.stderr}`).toMatch(
      /waiting, position 1 in queue; held by slots-test \([ab], test, pid/,
    );
    expect(`${a.stderr}${b.stderr}`).not.toMatch(/slots busy/);
  });

  it("never runs two builds together, and takes a raised slot count without a restart", async () => {
    const at = base("lane-slots");
    const profile = profileAt(at, { heavySlots: 1 });
    const log = path.join(at, "times.log");
    for (const t of ["tree-a", "tree-b", "tree-c"]) fs.mkdirSync(path.join(at, t));
    const a = runCli(profile, path.join(at, "tree-a"), [
      "lane",
      "a",
      "--class",
      "build",
      "--",
      ...sleeper(log, "a", 8000),
    ]);
    // Each step waits for what it depends on, so a loaded machine cannot reorder them.
    await until(() => fs.existsSync(log) && fs.readFileSync(log, "utf8").includes("a start"));
    const b = runCli(profile, path.join(at, "tree-b"), [
      "lane",
      "b",
      "--class",
      "build",
      "--",
      ...sleeper(log, "b", 300),
    ]);
    await until(() => queueLength(at) === 1);
    const c = runCli(profile, path.join(at, "tree-c"), [
      "lane",
      "c",
      "--class",
      "typecheck",
      "--",
      ...sleeper(log, "c", 300),
    ]);
    await until(() => queueLength(at) === 2);
    // The lead raises the slot count while all three run or wait: the typecheck joins the build;
    // the second build still may not.
    profileAt(at, { heavySlots: 2 });
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect([ra.code, rb.code, rc.code]).toEqual([0, 0, 0]);
    const t = times(log);
    expect(t["b.start"]!).toBeGreaterThanOrEqual(t["a.end"]!);
    expect(t["c.start"]!).toBeLessThan(t["a.end"]!);
    expect(rb.stderr).toMatch(/build and build never run together/);
    expect(rc.stderr).toMatch(/lock held \(slot 2, beside a \[build\]\)/);
  });

  it("refuses an unknown class", async () => {
    const at = base("lane-slots");
    const r = await runCli(profileAt(at, {}), at, [
      "lane",
      "x",
      "--class",
      "huge",
      "--",
      process.execPath,
      "-e",
      "0",
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--class must be one of build, window, test, typecheck/);
  });

  it("parses the profile fields with their defaults", () => {
    const p = parseProfile({ primaryCheckout: "/m/p", worktreeRoot: "/m/wt" }, "/m/profile.json");
    expect(p.lock.heavySlots).toBe(1);
    expect(p.memory.admitFreeGB).toBe(8);
    expect(p.memory.admitCommitHeadroomGB).toBe(12);
    const q = parseProfile(
      {
        primaryCheckout: "/m/p",
        worktreeRoot: "/m/wt",
        lock: { heavySlots: 3.7 },
        memory: { admitFreeGB: 6 },
      },
      "/m/profile.json",
    );
    expect(q.lock.heavySlots).toBe(3);
    expect(q.memory.admitFreeGB).toBe(6);
  });
});
