// Free memory and the memory floor. On 2026-11-18 the shared PC ran out of memory (31.8 GB RAM,
// 1.8 GB free, commit charge 64.9 of a 73.2 GB limit) while several heavy runs went side by side;
// the page file grew to 41 GB on C:, which looked like disk use. A heavy-lane run now waits while
// free physical memory or the commit headroom is under its floor, and says so.
import os from "node:os";

import { runSync } from "./run.ts";

export interface MemoryState {
  /** Free physical memory. */
  readonly freeGB: number;
  /** Commit limit minus commit charge (RAM plus page file still promisable), when the OS reports it. */
  readonly commitHeadroomGB: number | undefined;
  readonly commitLimitGB: number | undefined;
}

export interface MemoryFloor {
  readonly freeGB: number;
  readonly commitHeadroomGB: number;
}

const GB_PER_KB = 1 / 1024 ** 2;

/** Windows: Win32_OperatingSystem reports free RAM and the commit limit and headroom, in KB. */
export function parseWindowsMemory(json: string): MemoryState | undefined {
  try {
    const r = JSON.parse(json) as {
      FreePhysicalMemory?: number;
      TotalVirtualMemorySize?: number;
      FreeVirtualMemory?: number;
    };
    if (typeof r.FreePhysicalMemory !== "number") return undefined;
    return {
      freeGB: r.FreePhysicalMemory * GB_PER_KB,
      commitHeadroomGB:
        typeof r.FreeVirtualMemory === "number" ? r.FreeVirtualMemory * GB_PER_KB : undefined,
      commitLimitGB:
        typeof r.TotalVirtualMemorySize === "number"
          ? r.TotalVirtualMemorySize * GB_PER_KB
          : undefined,
    };
  } catch {
    return undefined;
  }
}

export function memoryState(): MemoryState {
  if (process.platform === "win32") {
    const r = runSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_OperatingSystem | Select-Object FreePhysicalMemory,TotalVirtualMemorySize,FreeVirtualMemory | ConvertTo-Json -Compress",
      ],
      process.cwd(),
      30_000,
    );
    const parsed = r.code === 0 ? parseWindowsMemory(r.stdout) : undefined;
    if (parsed) return parsed;
  }
  return {
    freeGB: os.freemem() / 1024 ** 3,
    commitHeadroomGB: undefined,
    commitLimitGB: undefined,
  };
}

/** Why memory is under the floor, or an empty list. */
export function memoryShortfall(state: MemoryState, floor: MemoryFloor): string[] {
  const reasons: string[] = [];
  if (state.freeGB < floor.freeGB)
    reasons.push(`free memory ${state.freeGB.toFixed(1)} GB (floor ${floor.freeGB} GB)`);
  if (state.commitHeadroomGB !== undefined && state.commitHeadroomGB < floor.commitHeadroomGB)
    reasons.push(
      `commit headroom ${state.commitHeadroomGB.toFixed(1)} GB of a ${state.commitLimitGB?.toFixed(1) ?? "?"} GB limit (floor ${floor.commitHeadroomGB} GB)`,
    );
  return reasons;
}

/** Waits while memory is under the floor, up to `waitMs`. Returns the reasons still standing (empty: go). */
export async function waitForMemory(
  floor: MemoryFloor,
  options: {
    waitMs: number;
    pollMs?: number;
    measure?: () => MemoryState;
    log?: (line: string) => void;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<string[]> {
  const measure = options.measure ?? memoryState;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const pollMs = options.pollMs ?? 30_000;
  let reasons = memoryShortfall(measure(), floor);
  if (reasons.length && options.waitMs > 0)
    options.log?.(
      `waiting for memory: ${reasons.join("; ")}; up to ${Math.round(options.waitMs / 60_000)} min (close what you left running)`,
    );
  let waited = 0;
  while (reasons.length && waited < options.waitMs) {
    await sleep(pollMs);
    waited += pollMs;
    reasons = memoryShortfall(measure(), floor);
  }
  return reasons;
}
