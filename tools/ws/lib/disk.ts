// Free disk and the disk floor.
import fs from "node:fs";
import path from "node:path";
import { driveLabel } from "./paths.ts";

export interface DriveSpace {
  readonly drive: string;
  readonly path: string;
  readonly freeGB: number | undefined;
}

export const GB = 1024 ** 3;

export function freeSpace(p: string): DriveSpace {
  try {
    // A folder that does not exist yet (a temp root before its first run) is on the drive of its
    // nearest existing parent.
    let at = p;
    while (!fs.existsSync(at) && path.dirname(at) !== at) at = path.dirname(at);
    const s = fs.statfsSync(at);
    return { drive: driveLabel(p), path: p, freeGB: (Number(s.bavail) * Number(s.bsize)) / GB };
  } catch {
    return { drive: driveLabel(p), path: p, freeGB: undefined };
  }
}

/** Drives below the floor (an unreadable drive counts as below, so a typo fails closed). */
export function belowFloor(
  paths: readonly string[],
  floorGB: number,
  measure = freeSpace,
): DriveSpace[] {
  return paths.map((p) => measure(p)).filter((d) => d.freeGB === undefined || d.freeGB < floorGB);
}

/**
 * Waits while any of `paths` is below the floor, up to `waitMs`, checking every `pollMs`. Free
 * space on this PC swings by many GB within minutes while other runs write temp data, so a run
 * queues for it instead of refusing at once. Returns the drives still below the floor (empty: go).
 */
export async function waitForFloor(
  paths: readonly string[],
  floorGB: number,
  options: {
    waitMs: number;
    pollMs?: number;
    measure?: typeof freeSpace;
    log?: (line: string) => void;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<DriveSpace[]> {
  const measure = options.measure ?? freeSpace;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const pollMs = options.pollMs ?? 30_000;
  let low = belowFloor(paths, floorGB, measure);
  let waited = 0;
  if (low.length > 0 && options.waitMs > 0) {
    options.log?.(
      `${floorMessage(low, floorGB).split(". Free")[0]}; waiting up to ${Math.round(options.waitMs / 60_000)} min for space`,
    );
  }
  while (low.length > 0 && waited < options.waitMs) {
    await sleep(pollMs);
    waited += pollMs;
    low = belowFloor(paths, floorGB, measure);
  }
  return low;
}

export function formatGB(n: number | undefined): string {
  return n === undefined ? "unknown" : `${n.toFixed(1)} GB`;
}

export function floorMessage(low: readonly DriveSpace[], floorGB: number): string {
  return (
    `Disk floor is ${floorGB} GB; below it: ` +
    low.map((d) => `${d.drive} ${formatGB(d.freeGB)} free`).join(", ") +
    ". Free space (ws reap --dry-run shows what can go) before starting heavy work."
  );
}
