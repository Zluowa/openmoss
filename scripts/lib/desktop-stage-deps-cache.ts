// FILE: desktop-stage-deps-cache.ts
// Purpose: Opt-in content-addressed cache for the frozen desktop stage `node_modules` install.
// Layer: Release/build helper

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import * as Path from "node:path";

import { copyTreeFast } from "./fast-stage-copy.ts";

export const DESKTOP_STAGE_DEPS_CACHE_ENV = "MOSS_DESKTOP_STAGE_DEPS_CACHE";
const CACHE_FORMAT_VERSION = "moss-desktop-stage-deps-cache-v1";
const CACHE_ENTRY_NAME = /^[0-9a-f]{64}$/u;

export interface DesktopStageDepsCacheKeyInput {
  readonly platform: string;
  readonly arch: string;
  readonly os: string;
  readonly cpu: string;
  readonly bunVersion: string;
  readonly stagePackageJsonText: string;
  readonly stageBunLockBytes: Buffer | Uint8Array;
  readonly patches: ReadonlyArray<{
    readonly path: string;
    readonly contents: Buffer | Uint8Array;
  }>;
}

interface CacheReceipt {
  readonly formatVersion: string;
  readonly cacheKey: string;
  readonly savedAt: string;
}

export interface RestoreDesktopStageDepsResult {
  readonly hit: boolean;
  readonly files: number;
  readonly hardlinked: number;
  readonly copied: number;
}

function sha256Hex(bytes: Buffer | Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function resolveDesktopStageDepsCacheDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const raw = env[DESKTOP_STAGE_DEPS_CACHE_ENV]?.trim();
  return raw ? Path.resolve(raw) : undefined;
}

export function computeDesktopStageDepsCacheKey(input: DesktopStageDepsCacheKeyInput): string {
  const sortedPatches = [...input.patches]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((patch) => ({
      path: patch.path,
      sha256: sha256Hex(patch.contents),
    }));

  return sha256Hex(
    JSON.stringify({
      formatVersion: CACHE_FORMAT_VERSION,
      platform: input.platform,
      arch: input.arch,
      os: input.os,
      cpu: input.cpu,
      bunVersion: input.bunVersion.trim(),
      stagePackageJsonSha256: sha256Hex(input.stagePackageJsonText),
      stageBunLockSha256: sha256Hex(input.stageBunLockBytes),
      patches: sortedPatches,
    }),
  );
}

async function hasValidCacheReceipt(entryDir: string, expectedKey: string): Promise<boolean> {
  try {
    const receipt = JSON.parse(
      await readFile(Path.join(entryDir, "complete.json"), "utf8"),
    ) as Partial<CacheReceipt>;
    if (receipt.formatVersion !== CACHE_FORMAT_VERSION || receipt.cacheKey !== expectedKey) {
      return false;
    }
    const nmStat = await stat(Path.join(entryDir, "node_modules"));
    return nmStat.isDirectory();
  } catch {
    return false;
  }
}

export async function restoreDesktopStageDepsFromCache(input: {
  readonly cacheDir: string;
  readonly cacheKey: string;
  readonly targetNodeModulesDir: string;
}): Promise<RestoreDesktopStageDepsResult> {
  const entryDir = Path.join(input.cacheDir, input.cacheKey);
  if (!(await hasValidCacheReceipt(entryDir, input.cacheKey))) {
    return { hit: false, files: 0, hardlinked: 0, copied: 0 };
  }
  try {
    await rm(input.targetNodeModulesDir, { recursive: true, force: true });
    const cloned = await copyTreeFast(
      Path.join(entryDir, "node_modules"),
      input.targetNodeModulesDir,
      { mode: "hardlink" },
    );
    return {
      hit: true,
      files: cloned.files,
      hardlinked: cloned.hardlinked,
      copied: cloned.copied,
    };
  } catch {
    await rm(input.targetNodeModulesDir, { recursive: true, force: true }).catch(() => undefined);
    return { hit: false, files: 0, hardlinked: 0, copied: 0 };
  }
}

export async function saveDesktopStageDepsToCache(input: {
  readonly cacheDir: string;
  readonly cacheKey: string;
  readonly sourceNodeModulesDir: string;
  readonly keepEntries?: number;
}): Promise<{ readonly saved: boolean; readonly pruned: number }> {
  await mkdir(input.cacheDir, { recursive: true });
  const entryDir = Path.join(input.cacheDir, input.cacheKey);
  if (await hasValidCacheReceipt(entryDir, input.cacheKey)) {
    const pruned = await pruneOldStageDepsCacheEntries(
      input.cacheDir,
      input.cacheKey,
      input.keepEntries ?? 2,
    );
    return { saved: false, pruned };
  }

  const tempDir = Path.join(input.cacheDir, `.tmp-${input.cacheKey.slice(0, 12)}-${process.pid}`);
  await rm(tempDir, { recursive: true, force: true });
  try {
    await mkdir(tempDir, { recursive: true });
    await copyTreeFast(input.sourceNodeModulesDir, Path.join(tempDir, "node_modules"), {
      mode: "hardlink",
    });
    const receipt: CacheReceipt = {
      formatVersion: CACHE_FORMAT_VERSION,
      cacheKey: input.cacheKey,
      savedAt: new Date().toISOString(),
    };
    await writeFile(Path.join(tempDir, "complete.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    await rm(entryDir, { recursive: true, force: true });
    await rename(tempDir, entryDir);
    const pruned = await pruneOldStageDepsCacheEntries(
      input.cacheDir,
      input.cacheKey,
      input.keepEntries ?? 2,
    );
    return { saved: true, pruned };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function pruneOldStageDepsCacheEntries(
  cacheDir: string,
  activeKey: string,
  keepEntries: number,
): Promise<number> {
  const limit = Math.max(1, keepEntries);
  const names = await readdir(cacheDir).catch(() => [] as string[]);
  const others: Array<{ readonly name: string; readonly mtimeMs: number }> = [];
  for (const name of names) {
    if (!CACHE_ENTRY_NAME.test(name) || name === activeKey) continue;
    try {
      const info = await stat(Path.join(cacheDir, name));
      others.push({ name, mtimeMs: info.mtimeMs });
    } catch {
      // Ignore entries disappearing concurrently.
    }
  }
  others.sort((left, right) => right.mtimeMs - left.mtimeMs);
  let pruned = 0;
  for (const stale of others.slice(limit - 1)) {
    await rm(Path.join(cacheDir, stale.name), { recursive: true, force: true }).catch(
      () => undefined,
    );
    pruned += 1;
  }
  return pruned;
}
