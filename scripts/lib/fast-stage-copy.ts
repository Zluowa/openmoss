// FILE: fast-stage-copy.ts
// Purpose: Fast concurrent directory cloning (hardlink with automatic copy fallback) for build staging.
// Layer: Release/build helper

import { copyFile, link, lstat, mkdir, readdir, readlink, rm, symlink } from "node:fs/promises";
import * as Path from "node:path";

export interface CopyTreeFastOptions {
  readonly mode?: "hardlink" | "copy";
  readonly concurrency?: number;
}

export interface CopyTreeFastResult {
  readonly files: number;
  readonly hardlinked: number;
  readonly copied: number;
  readonly symlinks: number;
}

const HARDLINK_FALLBACK_CODES = new Set([
  "EXDEV",
  "EPERM",
  "EACCES",
  "EMLINK",
  "ENOSYS",
  "ENOTSUP",
  "EINVAL",
  "EROFS",
]);

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

/**
 * Replaces `targetPath` with an independent copy of `sourcePath`.
 * Always unlinks `targetPath` first so overwriting a file inside a hardlinked stage tree never
 * mutates the shared source inode.
 */
export async function copyFileReplacingTarget(
  sourcePath: string,
  targetPath: string,
): Promise<void> {
  await rm(targetPath, { force: true });
  await copyFile(sourcePath, targetPath);
}

export async function linkOrCopyFile(
  sourcePath: string,
  targetPath: string,
  preferHardlink = true,
): Promise<"hardlinked" | "copied"> {
  if (!preferHardlink) {
    await copyFileReplacingTarget(sourcePath, targetPath);
    return "copied";
  }
  try {
    await link(sourcePath, targetPath);
    return "hardlinked";
  } catch (error) {
    const code = errorCode(error);
    if (code === "EEXIST") {
      await rm(targetPath, { force: true });
      try {
        await link(sourcePath, targetPath);
        return "hardlinked";
      } catch (retryError) {
        if (!HARDLINK_FALLBACK_CODES.has(errorCode(retryError) ?? "")) throw retryError;
      }
    } else if (!HARDLINK_FALLBACK_CODES.has(code ?? "")) {
      throw error;
    }
    await copyFileReplacingTarget(sourcePath, targetPath);
    return "copied";
  }
}

export async function copyTreeFast(
  sourceDir: string,
  destinationDir: string,
  options: CopyTreeFastOptions = {},
): Promise<CopyTreeFastResult> {
  const preferHardlink = (options.mode ?? "hardlink") === "hardlink";
  const concurrency = Math.max(1, options.concurrency ?? 32);

  const directoryLevels: string[][] = [[destinationDir]];
  const files: Array<{ readonly src: string; readonly dst: string }> = [];
  const symlinks: Array<{ readonly src: string; readonly dst: string }> = [];

  let currentLevel: Array<{ readonly src: string; readonly dst: string }> = [
    { src: sourceDir, dst: destinationDir },
  ];
  while (currentLevel.length > 0) {
    const nextLevel: Array<{ readonly src: string; readonly dst: string }> = [];
    const nextLevelDsts: string[] = [];
    for (let start = 0; start < currentLevel.length; start += concurrency) {
      const batch = currentLevel.slice(start, start + concurrency);
      const listings = await Promise.all(
        batch.map(async (dir) => ({
          dir,
          entries: await readdir(dir.src, { withFileTypes: true }),
        })),
      );
      for (const { dir, entries } of listings) {
        for (const entry of entries) {
          const src = Path.join(dir.src, entry.name);
          const dst = Path.join(dir.dst, entry.name);
          if (entry.isDirectory()) {
            nextLevelDsts.push(dst);
            nextLevel.push({ src, dst });
          } else if (entry.isSymbolicLink()) {
            symlinks.push({ src, dst });
          } else if (entry.isFile()) {
            files.push({ src, dst });
          } else {
            const st = await lstat(src);
            if (st.isDirectory()) {
              nextLevelDsts.push(dst);
              nextLevel.push({ src, dst });
            } else if (st.isSymbolicLink()) {
              symlinks.push({ src, dst });
            } else {
              files.push({ src, dst });
            }
          }
        }
      }
    }
    if (nextLevelDsts.length > 0) directoryLevels.push(nextLevelDsts);
    currentLevel = nextLevel;
  }

  for (const level of directoryLevels) {
    for (let start = 0; start < level.length; start += concurrency) {
      await Promise.all(
        level.slice(start, start + concurrency).map((dir) => mkdir(dir, { recursive: true })),
      );
    }
  }

  let hardlinked = 0;
  let copied = 0;
  let nextFile = 0;
  const runFileWorker = async (): Promise<void> => {
    while (nextFile < files.length) {
      const item = files[nextFile]!;
      nextFile += 1;
      const outcome = await linkOrCopyFile(item.src, item.dst, preferHardlink);
      if (outcome === "hardlinked") hardlinked += 1;
      else copied += 1;
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, files.length) }, () => runFileWorker()),
  );

  for (const item of symlinks) {
    const target = await readlink(item.src);
    await rm(item.dst, { force: true });
    await symlink(target, item.dst);
  }

  return {
    files: files.length,
    hardlinked,
    copied,
    symlinks: symlinks.length,
  };
}
