// When the disk floor refuses `ws new` or `ws lane`, say which of our folders on that drive are the
// largest and leave a record the lead can read (`ws doctor`), instead of each session finding out
// alone (2026-11-18: C: fell under the floor and refused two sessions before anyone looked).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DriveSpace } from "./disk.ts";
import { driveLabel, normalize, pathKey } from "./paths.ts";
import type { Profile } from "./profile.ts";
import { readRegistry } from "./registry.ts";
import { formatSize, sizeDirs, type DirSize } from "./size.ts";

export const DISK_ALERT_LOG = "disk-alerts.log";
const SHOWN = 8;

export interface DiskAlertRecord {
  readonly at: string;
  readonly command: string;
  readonly owner: string;
  readonly drives: readonly { drive: string; freeGB: number | undefined }[];
  readonly largest: readonly { path: string; bytes: number; partial: boolean; owner?: string }[];
}

export interface DiskAlertDeps {
  readonly sizes?: (dirs: readonly string[]) => Promise<Map<string, DirSize>>;
  readonly now?: () => Date;
  readonly localAppData?: string | undefined;
}

function children(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.isSymbolicLink())
      .map((e) => normalize(path.join(dir, e.name)));
  } catch {
    return [];
  }
}

/** Our folders: worktrees, scratch folders, the run-temp root and the fast-refresh state at its old default. */
export function ourFolders(profile: Profile, localAppData?: string): string[] {
  const appData =
    localAppData ?? process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  const dirs = [
    ...children(profile.worktreeRoot),
    ...children(profile.scratchRoot),
    ...(profile.tempRoot ? [normalize(profile.tempRoot)] : []),
    normalize(path.join(appData, "moss-fast-refresh")),
  ];
  return [...new Map(dirs.filter((d) => fs.existsSync(d)).map((d) => [pathKey(d), d])).values()];
}

/**
 * Measures our folders on the drives in `low`, records the alert in the state folder and returns
 * the lines to print. Never throws: a failed measurement still records and prints the refusal.
 */
export async function diskAlert(
  profile: Profile,
  low: readonly DriveSpace[],
  context: { command: string; owner: string },
  deps: DiskAlertDeps = {},
): Promise<string[]> {
  const drives = new Set(low.map((d) => driveLabel(d.path)));
  const dirs = ourFolders(profile, deps.localAppData).filter((d) => drives.has(driveLabel(d)));
  let sizes = new Map<string, DirSize>();
  try {
    sizes = await (
      deps.sizes ??
      ((ds) =>
        sizeDirs(ds, {
          cacheFile: path.join(profile.stateDir, "size-cache.json"),
          budgetMs: 20_000,
        }))
    )(dirs);
  } catch {
    // keep the empty map
  }
  const owners = new Map<string, string>();
  try {
    for (const lease of Object.values(readRegistry(profile).leases)) {
      owners.set(pathKey(lease.path), `lease ${lease.name}, owner ${lease.owner}`);
    }
  } catch {
    // no registry
  }
  const largest = dirs
    .map((d) => ({ dir: d, size: sizes.get(pathKey(d)) }))
    .filter((e): e is { dir: string; size: DirSize } => e.size !== undefined)
    .toSorted((a, b) => b.size.bytes - a.size.bytes)
    .slice(0, SHOWN);
  const record: DiskAlertRecord = {
    at: (deps.now ?? (() => new Date()))().toISOString(),
    command: context.command,
    owner: context.owner,
    drives: low.map((d) => ({ drive: d.drive, freeGB: d.freeGB })),
    largest: largest.map((e) => ({
      path: e.dir,
      bytes: e.size.bytes,
      partial: e.size.partial === true,
      ...(owners.get(pathKey(e.dir)) ? { owner: owners.get(pathKey(e.dir))! } : {}),
    })),
  };
  try {
    fs.mkdirSync(profile.stateDir, { recursive: true });
    fs.appendFileSync(path.join(profile.stateDir, DISK_ALERT_LOG), `${JSON.stringify(record)}\n`);
  } catch {
    // best effort
  }
  const lines = [
    `Largest of our folders on ${[...drives].join(", ")}:`,
    ...(largest.length
      ? record.largest.map(
          (e) =>
            `  ${formatSize(e.bytes, e.partial).padStart(8)}  ${e.path}${e.owner ? `  (${e.owner})` : ""}`,
        )
      : ["  (none measured in time)"]),
    `Recorded in ${normalize(path.join(profile.stateDir, DISK_ALERT_LOG))}; \`ws doctor\` shows the latest.`,
    "Tell the lead now, with these lines, before waiting or retrying.",
  ];
  return lines;
}

/** The latest alert, for `ws doctor`. */
export function latestDiskAlert(profile: Pick<Profile, "stateDir">): DiskAlertRecord | undefined {
  try {
    const lines = fs
      .readFileSync(path.join(profile.stateDir, DISK_ALERT_LOG), "utf8")
      .trim()
      .split("\n");
    return JSON.parse(lines.at(-1)!) as DiskAlertRecord;
  } catch {
    return undefined;
  }
}
