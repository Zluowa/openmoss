import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HEAVY_LOCK, LANE_ENV, lockPath } from "../../ws/lib/lock.ts";
import {
  describeLoad,
  heavyLane,
  loadSettings,
  takeSlot,
  waitForHeavyLane,
  type LoadSettings,
} from "../lib/load.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Settings for a machine with no profile: locks beside where the profile would be. */
function machine(): LoadSettings {
  const root = mkdtempSync(join(tmpdir(), "check-load-"));
  roots.push(root);
  const settings = loadSettings({ MOSS_WS_PROFILE: join(root, "profile.json") });
  expect(settings.locksDir).toBe(join(root, "locks"));
  return { ...settings, pollMs: 20 };
}

function holdHeavy(settings: LoadSettings, owner: string, pid = process.pid): string {
  const dir = lockPath(settings.locksDir, HEAVY_LOCK);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "owner.json"),
    JSON.stringify({ pid, owner, lane: "batch", sha: "", started: new Date().toISOString() }),
  );
  return dir;
}

function deadPid(): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", ""]);
    child.on("exit", () => resolve(child.pid!));
  });
}

describe("quick-gate slots", () => {
  it("lets two runs in at once and makes a third wait, naming whom it waits for", async () => {
    const settings = machine();
    const first = await takeSlot(settings, { owner: "a", sha: "" }, () => {});
    const second = await takeSlot(settings, { owner: "b", sha: "" }, () => {});
    const log: string[] = [];
    let third = false;
    const waiting = takeSlot(settings, { owner: "c", sha: "" }, (line) => log.push(line)).then(
      (lock) => {
        third = true;
        return lock;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(third).toBe(false);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatch(
      /^check: waiting, position 1 in queue; held by a \(check, .*\), b \(check/,
    );
    second.release();
    const lock = await waiting;
    expect(third).toBe(true);
    first.release();
    lock.release();
  });
});

describe("heavy lane", () => {
  it("is another owner's live heavy lock; not its own, not a stale one, not inside a lane", async () => {
    const settings = machine();
    expect(heavyLane(settings, "me", {})).toBeUndefined();
    const dir = holdHeavy(settings, "coordinator");
    expect(heavyLane(settings, "me", {})?.owner).toBe("coordinator");
    expect(heavyLane(settings, "coordinator", {})).toBeUndefined();
    expect(heavyLane(settings, "me", { [LANE_ENV]: "batch" })).toBeUndefined();
    rmSync(dir, { recursive: true });
    holdHeavy(settings, "ghost", await deadPid());
    expect(heavyLane(settings, "me", {})).toBeUndefined();
  });

  it("holds the tests until the lane ends, printing one line", async () => {
    const settings = machine();
    const dir = holdHeavy(settings, "coordinator");
    const log: string[] = [];
    setTimeout(() => rmSync(dir, { recursive: true }), 200);
    const wait = await waitForHeavyLane({
      settings,
      self: "me",
      env: {},
      maxWaitMs: 60_000,
      log: (line) => log.push(line),
    });
    expect(wait.gaveUp).toBe(false);
    expect(wait.lane).toBe("batch (coordinator)");
    expect(wait.waitedMs).toBeGreaterThanOrEqual(150);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatch(/^check: tests wait for heavy lane batch \(coordinator\).*--no-wait/);
  });

  it("stops waiting at the ceiling", async () => {
    const settings = { ...machine(), pollMs: 60_000 };
    holdHeavy(settings, "coordinator");
    let clock = 0;
    const wait = await waitForHeavyLane({
      settings,
      self: "me",
      env: {},
      maxWaitMs: 45 * 60_000,
      log: () => {},
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(wait).toEqual({ waitedMs: 45 * 60_000, lane: "batch (coordinator)", gaveUp: true });
  });

  it("does not wait when no other heavy lane runs", async () => {
    const settings = machine();
    const wait = await waitForHeavyLane({
      settings,
      self: "me",
      env: {},
      maxWaitMs: 1000,
      log: () => {},
    });
    expect(wait).toEqual({ waitedMs: 0, gaveUp: false });
  });
});

describe("the load line", () => {
  const base = { slotWaitMs: 0, testWaits: [], noWait: false };
  it("says whether the run waited or overlapped a heavy lane", () => {
    expect(describeLoad(base)).toBe("load: no heavy lane ran, no wait");
    expect(
      describeLoad({
        ...base,
        slotWaitMs: 90_000,
        heavyBeforeTests: "batch (c)",
        testWaits: [{ waitedMs: 180_000, lane: "batch (c)", gaveUp: false }],
      }),
    ).toBe(
      "load: waited 1.5 min for a slot; tests waited 3.0 min for heavy lane batch (c); tests did not overlap a heavy lane",
    );
    expect(describeLoad({ ...base, noWait: true, heavyDuringTests: "batch (c)" })).toBe(
      "load: tests overlapped heavy lane batch (c) (--no-wait)",
    );
    expect(
      describeLoad({
        ...base,
        heavyDuringTests: "batch (c)",
        testWaits: [{ waitedMs: 45 * 60_000, lane: "batch (c)", gaveUp: true }],
      }),
    ).toBe(
      "load: tests waited 45.0 min for heavy lane batch (c), then ran anyway (ceiling reached); tests overlapped heavy lane batch (c)",
    );
    expect(describeLoad({ ...base, heavyBeforeTests: "batch (c)" })).toBe(
      "load: static steps and types overlapped heavy lane batch (c); tests did not overlap a heavy lane",
    );
  });
});
