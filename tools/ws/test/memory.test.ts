import { describe, expect, it } from "vitest";

import { memoryShortfall, parseWindowsMemory, waitForMemory } from "../lib/memory.ts";
import { processesByOwner } from "../lib/owners.ts";
import type { ProcessInfo } from "../lib/proc.ts";

const KB_PER_GB = 1024 ** 2;

describe("memory floor", () => {
  it("reads Win32_OperatingSystem (KB) and names each shortfall", () => {
    // The 2026-11-18 evening: 1.8 GB free, 64.9 of 73.2 GB committed.
    const state = parseWindowsMemory(
      JSON.stringify({
        FreePhysicalMemory: 1.8 * KB_PER_GB,
        TotalVirtualMemorySize: 73.2 * KB_PER_GB,
        FreeVirtualMemory: 8.3 * KB_PER_GB,
      }),
    )!;
    expect(state.freeGB).toBeCloseTo(1.8, 5);
    expect(state.commitLimitGB).toBeCloseTo(73.2, 5);
    const reasons = memoryShortfall(state, { freeGB: 4, commitHeadroomGB: 8 });
    expect(reasons).toEqual([expect.stringMatching(/^free memory 1\.8 GB \(floor 4 GB\)$/)]);
    expect(
      memoryShortfall({ ...state, commitHeadroomGB: 5 }, { freeGB: 1, commitHeadroomGB: 8 }),
    ).toEqual([
      expect.stringMatching(/^commit headroom 5\.0 GB of a 73\.2 GB limit \(floor 8 GB\)$/),
    ]);
    expect(parseWindowsMemory("not json")).toBeUndefined();
  });

  it("waits while short, says so once, and goes when memory comes back", async () => {
    const free = [1, 2, 6];
    const lines: string[] = [];
    let slept = 0;
    const reasons = await waitForMemory(
      { freeGB: 4, commitHeadroomGB: 8 },
      {
        waitMs: 120_000,
        pollMs: 30_000,
        measure: () => ({ freeGB: free.shift() ?? 6, commitHeadroomGB: 20, commitLimitGB: 70 }),
        log: (line) => lines.push(line),
        sleep: async () => void (slept += 1),
      },
    );
    expect(reasons).toEqual([]);
    expect(slept).toBe(2);
    expect(lines).toEqual([expect.stringMatching(/^waiting for memory: free memory 1\.0 GB/)]);
  });

  it("gives up after the wait and returns what is still short", async () => {
    const reasons = await waitForMemory(
      { freeGB: 4, commitHeadroomGB: 8 },
      {
        waitMs: 60_000,
        pollMs: 30_000,
        measure: () => ({ freeGB: 1, commitHeadroomGB: undefined, commitLimitGB: undefined }),
        sleep: async () => {},
      },
    );
    expect(reasons).toHaveLength(1);
  });
});

describe("processesByOwner", () => {
  it("attributes heavy runtimes to the most specific of our folders, largest first", () => {
    const p = (pid: number, name: string, commandLine: string, mb: number): ProcessInfo => ({
      pid,
      ppid: 1,
      name,
      commandLine,
      memoryBytes: mb * 1024 ** 2,
    });
    const groups = processesByOwner(
      [
        p(
          1,
          "node.exe",
          "node D:/wt/pkg-size-build/apps/web/node_modules/vite/bin/vite.js build",
          5800,
        ),
        p(2, "Moss.exe", String.raw`"D:\wt\accept\app\Moss.exe" --type=renderer`, 300),
        p(3, "node.exe", "node D:/ceshi/shared/node_modules/vitest/vitest.mjs run", 190),
        p(4, "powershell.exe", "powershell D:/wt/pkg-size-build/x.ps1", 100),
        p(5, "node.exe", "node C:/elsewhere/app.js", 900),
      ],
      [
        { path: "D:/wt/pkg-size-build", owner: "moss-pkg-size (lease pkg-size-build)" },
        { path: "D:/wt/accept", owner: "moss-infra (lease accept)" },
        { path: "D:/ceshi/shared", owner: "shared checkout" },
      ],
    );
    expect(groups.map((g) => [g.owner, g.processes.map((x) => x.pid)])).toEqual([
      ["moss-pkg-size (lease pkg-size-build)", [1]],
      ["moss-infra (lease accept)", [2]],
      ["shared checkout", [3]],
    ]);
    expect(Math.round(groups[0]!.bytes / 1024 ** 2)).toBe(5800);
  });
});
