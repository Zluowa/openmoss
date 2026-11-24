/**
 * Codex's curated-plugin snapshot (`CODEX_HOME/.tmp/plugins`).
 *
 * Every new Codex app-server syncs the `openai/plugins` repository at startup
 * (`git ls-remote`, then the GitHub zipball, then an export archive). In a home
 * that has no snapshot yet, Codex starts no turn until that sync ends; where
 * GitHub is unreachable it ends only after 12–40 s of failed attempts. With any
 * snapshot present (even an old one) turns start at once and the sync runs in
 * the background. So before Moss starts Codex on a home that has none, it copies
 * the newest snapshot already on this computer into it: a local copy, never a
 * network wait.
 *
 * The copy goes to a sibling folder first and is renamed into place only while
 * the home still has no snapshot, so it never collides with Codex's own sync.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const SNAPSHOT_DIR = path.join(".tmp", "plugins");
const SNAPSHOT_SHA_FILE = path.join(".tmp", "plugins.sha");
const SNAPSHOT_MARKER = path.join(".agents", "plugins", "marketplace.json");

export type CuratedSnapshotSeedOutcome = "present" | "seeded" | "no-source" | "failed";

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/** True when the home holds a usable curated snapshot. */
export function hasCuratedPluginSnapshot(codexHome: string): Promise<boolean> {
  return exists(path.join(codexHome, SNAPSHOT_DIR, SNAPSHOT_MARKER));
}

async function sameLocation(left: string, right: string): Promise<boolean> {
  if (path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()) return true;
  try {
    const [a, b] = await Promise.all([fs.realpath(left), fs.realpath(right)]);
    return a.toLowerCase() === b.toLowerCase();
  } catch {
    return false;
  }
}

/** The candidate home whose snapshot was updated last, or undefined when none has one. */
export async function findNewestCuratedPluginSnapshot(
  candidates: ReadonlyArray<string>,
): Promise<string | undefined> {
  let newest: { home: string; updatedAt: number } | undefined;
  for (const home of new Set(candidates.map((candidate) => path.resolve(candidate)))) {
    if (!(await hasCuratedPluginSnapshot(home))) continue;
    const stamp = await fs
      .stat(path.join(home, SNAPSHOT_SHA_FILE))
      .catch(() => fs.stat(path.join(home, SNAPSHOT_DIR, SNAPSHOT_MARKER)));
    const updatedAt = stamp.mtimeMs;
    if (!newest || updatedAt > newest.updatedAt) newest = { home, updatedAt };
  }
  return newest?.home;
}

/**
 * Gives `targetHome` a curated snapshot copied from the newest one among `candidates`,
 * unless it already has one. Never throws.
 */
export async function seedCuratedPluginSnapshot(
  targetHome: string,
  candidates: ReadonlyArray<string>,
): Promise<CuratedSnapshotSeedOutcome> {
  try {
    if (await hasCuratedPluginSnapshot(targetHome)) return "present";
    const others: string[] = [];
    for (const candidate of candidates) {
      if (!(await sameLocation(candidate, targetHome))) others.push(candidate);
    }
    const source = await findNewestCuratedPluginSnapshot(others);
    if (!source) return "no-source";

    const targetTmp = path.join(targetHome, ".tmp");
    await fs.mkdir(targetTmp, { recursive: true });
    const staging = path.join(targetTmp, `plugins.moss-seed-${randomUUID()}`);
    try {
      await fs.cp(path.join(source, SNAPSHOT_DIR), staging, { recursive: true });
      // Codex may have finished its own sync meanwhile: then its snapshot wins.
      if (await exists(path.join(targetHome, SNAPSHOT_DIR))) return "present";
      await fs.rename(staging, path.join(targetHome, SNAPSHOT_DIR));
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
    const sourceSha = path.join(source, SNAPSHOT_SHA_FILE);
    const targetSha = path.join(targetHome, SNAPSHOT_SHA_FILE);
    if ((await exists(sourceSha)) && !(await exists(targetSha))) {
      await fs.copyFile(sourceSha, targetSha).catch(() => undefined);
    }
    return "seeded";
  } catch {
    return (await hasCuratedPluginSnapshot(targetHome).catch(() => false)) ? "present" : "failed";
  }
}
