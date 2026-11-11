// Free disk and the disk floor.
import fs from "node:fs";
import { driveLabel } from "./paths.ts";

export interface DriveSpace {
  readonly drive: string;
  readonly path: string;
  readonly freeGB: number | undefined;
}

export const GB = 1024 ** 3;

export function freeSpace(p: string): DriveSpace {
  try {
    const s = fs.statfsSync(p);
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
