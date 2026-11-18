import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { LONG_WAIT_MS, orderTickets, QUICK_STREAK, type Ticket } from "../lib/lock.ts";
import { descendantsOf, type ProcessInfo } from "../lib/proc.ts";
import { cleanup, tempDir } from "./helpers.ts";

const NOW = 1_800_000_000_000;
const t = (
  name: string,
  jobClass: Ticket["jobClass"],
  waitedMs: number,
  priority = false,
): Ticket => ({
  name,
  file: name,
  pid: 1,
  owner: priority ? "lead" : "s",
  priority,
  jobClass,
  sinceMs: NOW - waitedMs,
});

describe("lane queue order", () => {
  it("puts quick jobs ahead of long ones, the lead ahead of all, and keeps time order inside a class", () => {
    const order = orderTickets(
      [
        t("1-long", "long", 50 * 60_000),
        t("2-quick", "quick", 60_000),
        t("3-long-lead", "long", 1000, true),
        t("4-quick", "quick", 0),
      ],
      0,
      NOW,
    ).map((x) => x.name);
    expect(order).toEqual(["3-long-lead", "2-quick", "4-quick", "1-long"]);
  });

  it(`lets a long job that waited ${LONG_WAIT_MS / 60_000} min go next after ${QUICK_STREAK} quick runs in a row`, () => {
    const tickets = [
      t("1-long", "long", LONG_WAIT_MS + 1),
      t("2-long", "long", 1000),
      t("3-quick", "quick", 0),
    ];
    expect(orderTickets(tickets, QUICK_STREAK - 1, NOW).map((x) => x.name)).toEqual([
      "3-quick",
      "1-long",
      "2-long",
    ]);
    expect(orderTickets(tickets, QUICK_STREAK, NOW).map((x) => x.name)).toEqual([
      "1-long",
      "3-quick",
      "2-long",
    ]);
  });
});

describe("descendantsOf", () => {
  it("follows children that started after the run, never a process that only reuses a parent PID", () => {
    const p = (pid: number, ppid: number, startedMs: number): ProcessInfo => ({
      pid,
      ppid,
      name: "node.exe",
      commandLine: "",
      startedMs,
    });
    const tree = descendantsOf(
      [p(10, 1, 5000), p(11, 10, 6000), p(12, 11, 7000), p(13, 10, 1000), p(14, 13, 8000)],
      10,
      4000,
    );
    // 13 claims parent 10 but started before the run: someone else's, and so is its child 14.
    expect(tree.map((x) => x.pid).toSorted()).toEqual([10, 11, 12]);
  });
});

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.ts");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) cleanup(d);
});

describe("ws lane --quick", () => {
  it("stops a quick run that overstays its cap and gives the lane back", async () => {
    const base = tempDir("lane-quick");
    dirs.push(base);
    const profile = path.join(base, "profile.json");
    fs.writeFileSync(
      profile,
      JSON.stringify({
        primaryCheckout: path.join(base, "primary"),
        worktreeRoot: path.join(base, "wt"),
        stateDir: path.join(base, "state"),
        disk: { floorGB: 0, drives: [base], waitMinutes: 0 },
        memory: { freeGB: 0, commitHeadroomGB: 0, waitMinutes: 0 },
        lock: { staleHours: 3, pollSeconds: 0.1, quickCapMinutes: 0.05 },
      }),
    );
    const started = Date.now();
    const r = await new Promise<{ code: number; stderr: string }>((resolve) => {
      const child = spawn(
        process.execPath,
        [
          CLI,
          "lane",
          "short",
          "--quick",
          "--",
          process.execPath,
          "-e",
          "setTimeout(() => {}, 60000)",
        ],
        {
          env: { ...process.env, MOSS_WS_PROFILE: profile, MOSS_WS_OWNER: "lane-test" },
        },
      );
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.on("exit", (code) => resolve({ code: code ?? 1, stderr }));
    });
    expect(Date.now() - started).toBeLessThan(40_000);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/--quick run still going after 0\.05 min; stopping it/);
    expect(fs.readdirSync(path.join(base, "state", "locks")).filter((n) => n === "heavy")).toEqual(
      [],
    );
  }, 60_000);
});

describe("no tree kill", () => {
  it("ws never runs taskkill /T: stale parent PIDs would reach other programs", () => {
    const lib = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib");
    for (const name of fs.readdirSync(lib).filter((f) => f.endsWith(".ts"))) {
      const text = fs.readFileSync(path.join(lib, name), "utf8");
      expect(text, name).not.toMatch(/["']\/T["']/);
      expect(text, name).not.toMatch(/stopProcessTree/);
    }
  });
});
