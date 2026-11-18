import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { waitForFloor } from "../lib/disk.ts";
import { createRunTemp, sweepRunTemps, treeBytes } from "../lib/runTemp.ts";
import { cleanup, linkType, tempDir } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) cleanup(d);
});

describe("run temp folders", () => {
  it("removes the run's folder with its contents, a link inside removed as a link", () => {
    const base = tempDir("runtmp");
    dirs.push(base);
    const outside = path.join(base, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "keep.txt"), "must survive");
    const run = createRunTemp(path.join(base, "root"), "lane name/with spaces");
    expect(path.basename(run.dir)).toMatch(/^lane-name-with-spaces-\d{8}-\d{6}-\d+$/u);
    expect(run.env).toEqual({ TEMP: run.dir, TMP: run.dir, TMPDIR: run.dir });
    fs.mkdirSync(path.join(run.dir, "fixture"));
    fs.writeFileSync(path.join(run.dir, "fixture", "db.sqlite"), Buffer.alloc(4096));
    fs.symlinkSync(outside, path.join(run.dir, "link"), linkType);
    expect(treeBytes(run.dir)).toBe(4096);
    expect(run.finish()).toEqual({ bytes: 4096, errors: [] });
    expect(fs.existsSync(run.dir)).toBe(false);
    expect(fs.readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("must survive");
  });

  it("sweeps only old folders of ended runs", () => {
    const base = tempDir("runtmp");
    dirs.push(base);
    const root = path.join(base, "root");
    const make = (name: string, ageHours: number) => {
      const dir = path.join(root, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "f"), "x");
      const when = new Date(Date.now() - ageHours * 3600_000);
      fs.utimesSync(dir, when, when);
      return dir;
    };
    const dead = make("lane-20261117-210000-999999999", 20);
    const live = make(`lane-20261117-210000-${process.pid}`, 20);
    const recent = make("lane-20261118-010000-999999998", 1);
    const other = make("not-a-run-folder", 20);
    const swept = sweepRunTemps(root);
    expect(swept.removed).toEqual([path.basename(dead)]);
    for (const kept of [live, recent, other]) expect(fs.existsSync(kept)).toBe(true);
  });
});

const drive = (freeGB: number) => ({ drive: "C:", path: "C:/", freeGB });

describe("waitForFloor", () => {
  it("waits until space comes back", async () => {
    const free = [2, 3, 9];
    const slept: number[] = [];
    const low = await waitForFloor(["C:/"], 6, {
      waitMs: 60_000,
      pollMs: 10_000,
      measure: () => drive(free.shift() ?? 9),
      sleep: async (ms) => void slept.push(ms),
    });
    expect(low).toEqual([]);
    expect(slept).toEqual([10_000, 10_000]);
  });

  it("returns the drives still low after the wait", async () => {
    const lines: string[] = [];
    const low = await waitForFloor(["C:/"], 6, {
      waitMs: 30_000,
      pollMs: 10_000,
      measure: () => drive(1),
      sleep: async () => {},
      log: (line) => lines.push(line),
    });
    expect(low).toEqual([drive(1)]);
    expect(lines[0]).toMatch(/below it: C: 1\.0 GB free; waiting up to 1 min/u);
  });
});
