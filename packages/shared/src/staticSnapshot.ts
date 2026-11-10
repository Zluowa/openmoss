// FILE: staticSnapshot.ts
// Purpose: Materializes a real-on-disk snapshot of static assets that live inside
//          an asar archive, so serving survives the archive being replaced on disk.
// Layer: Shared runtime utility (desktop main + server startup)
//
// Electron caches an asar's header per process. When app.asar is swapped beneath a
// running app (an updater retry racing a relaunch, a reinstall, a build copied over
// the bundle) every later archive read resolves against stale offsets and silently
// returns bytes from the wrong file: masked icons vanish, lazily-loaded route
// chunks arrive corrupted. Files extracted to a plain directory have no such shared
// header — each request opens a real file — so serving the UI from a per-archive
// snapshot prevents the corruption instead of merely detecting it.
//
// Snapshots are keyed by the source archive's identity (size/mtime/inode signature):
// the first launch of a given archive pays one recursive copy, later launches reuse
// it, and superseded snapshots are pruned best-effort.
//
// Everything here is asynchronous because the caller is Electron's main thread and
// the copy is thousands of small files: 5 seconds on an SSD, many minutes on a
// spinning disk or under heavy antivirus scanning. Disk work is bounded as well,
// since it shares libuv's four-thread pool with the rest of the process.

import fs from "node:fs";
import path from "node:path";

const ASAR_SUFFIX = ".asar";
const COPY_CONCURRENCY = 4;
const SOURCE_CHECK_INTERVAL_FILES = 64;

/**
 * Returns the path of the containing `.asar` archive when `candidatePath` points
 * inside one (`…/app.asar/apps/server/dist/client` → `…/app.asar`), or the path
 * itself when it IS an archive. Null for plain-directory paths, which need no
 * snapshot: real files are already immune to archive swaps.
 */
export function findAsarArchivePath(candidatePath: string): string | null {
  const segments = candidatePath.split(/[/\\]/);
  const archiveIndex = segments.findIndex((segment) => segment.endsWith(ASAR_SUFFIX));
  if (archiveIndex === -1) {
    return null;
  }
  return segments.slice(0, archiveIndex + 1).join(path.sep);
}

/** Turns an archive signature into a filesystem-safe snapshot directory name. */
export function snapshotDirectoryName(signature: string): string {
  return signature.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export interface StaticSnapshotProgress {
  readonly copiedFiles: number;
  readonly totalFiles: number;
}

export interface StaticSnapshotInput {
  /** Directory whose contents must survive archive swaps (may live inside an asar). */
  readonly sourceDir: string;
  /** Real-disk directory that owns every snapshot generation. */
  readonly cacheRoot: string;
  /** Identity of the source archive; a new signature forces a fresh snapshot. */
  readonly signature: string;
  /** File whose presence marks a snapshot as complete and the source as sane. */
  readonly sentinelFile?: string;
  /**
   * Fresh copies only, so a reused snapshot never reports: fires once with zero
   * copied files before the first disk write, then after every copied file.
   */
  readonly onProgress?: (progress: StaticSnapshotProgress) => void;
  /**
   * Throws when the source no longer holds the generation being copied. Runs
   * during the copy, so a long copy stops early, and once after the last read, so
   * a published snapshot can only hold bytes from one generation.
   */
  readonly assertSourceUnchanged?: () => void;
}

export interface StaticSnapshotResult {
  readonly dir: string;
  readonly reused: boolean;
}

interface StaticSnapshotFile {
  readonly sourcePath: string;
  readonly targetPath: string;
}

interface StaticSnapshotTree {
  readonly directories: string[];
  readonly files: StaticSnapshotFile[];
}

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await fs.promises.access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

async function listSourceTree(
  sourceDir: string,
  targetDir: string,
  tree: StaticSnapshotTree,
): Promise<void> {
  // Manual walk instead of fs.cp: reads go through Electron's asar-patched fs,
  // which supports readdir/readFile/stat inside archives but not the copyFile fast
  // path fs.cp prefers.
  tree.directories.push(targetDir);
  for (const entry of await fs.promises.readdir(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await listSourceTree(sourcePath, targetPath, tree);
    } else if (entry.isFile()) {
      tree.files.push({ sourcePath, targetPath });
    }
  }
}

async function copyFiles(
  files: ReadonlyArray<StaticSnapshotFile>,
  onFileCopied: () => void,
): Promise<void> {
  let nextIndex = 0;
  const failures: unknown[] = [];
  const copyNextFiles = async (): Promise<void> => {
    while (failures.length === 0 && nextIndex < files.length) {
      const file = files[nextIndex]!;
      nextIndex += 1;
      try {
        await fs.promises.writeFile(file.targetPath, await fs.promises.readFile(file.sourcePath));
        onFileCopied();
      } catch (error) {
        failures.push(error);
      }
    }
  };
  // Waits for every worker even after a failure, so the caller's cleanup can't
  // race a write still landing in the staging directory.
  await Promise.all(Array.from({ length: COPY_CONCURRENCY }, () => copyNextFiles()));
  if (failures.length > 0) {
    throw failures[0];
  }
}

/**
 * One operation at a time on purpose. fs.rm queues every child at once, and libuv's
 * queue is first-come, so on a slow disk the rest of the process would wait behind
 * thousands of deletes.
 */
async function removeDirectoryGently(directory: string): Promise<void> {
  for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await removeDirectoryGently(entryPath);
    } else {
      await fs.promises.rm(entryPath, { force: true });
    }
  }
  await fs.promises.rmdir(directory);
}

/** Never rejects, so callers can leave it running in the background. */
export async function pruneStaticSnapshotCache(
  cacheRoot: string,
  keepName?: string,
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(cacheRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === keepName) continue;
    try {
      await removeDirectoryGently(path.join(cacheRoot, entry.name));
    } catch {
      // A stale snapshot held open elsewhere is disk waste, not a correctness
      // problem; the next launch retries the prune.
    }
  }
}

/**
 * Ensures a complete real-disk copy of `sourceDir` exists for `signature` and
 * returns its path. Reuses an existing snapshot when the sentinel file is present;
 * otherwise copies into a temp directory and atomically renames it into place, so
 * a crash mid-copy can never yield a half-snapshot that looks complete, and a
 * concurrent process racing the same signature safely loses the rename and reuses
 * the winner's copy. Rejects on failure — callers fall back to serving `sourceDir`.
 * Superseded snapshots keep being pruned in the background after this settles.
 */
export async function ensureStaticSnapshot(
  input: StaticSnapshotInput,
): Promise<StaticSnapshotResult> {
  const sentinelFile = input.sentinelFile ?? "index.html";
  const snapshotName = snapshotDirectoryName(input.signature);
  const snapshotDir = path.join(input.cacheRoot, snapshotName);

  if (await pathExists(path.join(snapshotDir, sentinelFile))) {
    void pruneStaticSnapshotCache(input.cacheRoot, snapshotName);
    return { dir: snapshotDir, reused: true };
  }

  if (!(await pathExists(path.join(input.sourceDir, sentinelFile)))) {
    throw new Error(`Static snapshot source is missing ${sentinelFile}: ${input.sourceDir}`);
  }

  const stagingDir = path.join(input.cacheRoot, `.staging-${snapshotName}-${process.pid}`);
  const tree: StaticSnapshotTree = { directories: [], files: [] };
  await listSourceTree(input.sourceDir, stagingDir, tree);
  const totalFiles = tree.files.length;
  input.onProgress?.({ copiedFiles: 0, totalFiles });

  await fs.promises.mkdir(input.cacheRoot, { recursive: true });
  // A leftover here belongs to an earlier process that had this pid. Its files
  // must not end up in this snapshot.
  await fs.promises.rm(stagingDir, { recursive: true, force: true });
  try {
    for (const directory of tree.directories) {
      await fs.promises.mkdir(directory, { recursive: true });
    }
    let copiedFiles = 0;
    await copyFiles(tree.files, () => {
      copiedFiles += 1;
      input.onProgress?.({ copiedFiles, totalFiles });
      if (copiedFiles % SOURCE_CHECK_INTERVAL_FILES === 0) {
        input.assertSourceUnchanged?.();
      }
    });
    input.assertSourceUnchanged?.();
    await fs.promises.rename(stagingDir, snapshotDir);
  } catch (error) {
    // Not awaited: staging is never reused, the next launch's prune finishes the
    // job, and the caller's fallback shouldn't wait on a slow disk.
    void removeDirectoryGently(stagingDir).catch(() => undefined);
    // Lost the rename race to a concurrent process: its completed copy is
    // equivalent, so serve that instead of failing startup.
    if (await pathExists(path.join(snapshotDir, sentinelFile))) {
      return { dir: snapshotDir, reused: true };
    }
    throw error;
  }

  void pruneStaticSnapshotCache(input.cacheRoot, snapshotName);
  return { dir: snapshotDir, reused: false };
}
