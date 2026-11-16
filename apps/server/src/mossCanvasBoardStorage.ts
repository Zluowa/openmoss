// Board storage identities are resolved by the pages service, never by filesystem input.
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, toNamespacedPath } from "node:path";
import { pathToFileURL } from "node:url";
import type { BoardItem } from "@moss/shared/spaceItems/itemData";
import { mediaAccountScope, type MossMediaIdentity } from "./mossMediaJobsService";

export interface CanvasBoardScope {
  readonly pageId: string;
  readonly canvasProjectKey: string;
  readonly scopeSpaceId: string | null;
}
export interface CanvasBoardBinding extends CanvasBoardScope {
  readonly version: BoardItem["version"];
}
const hash = (x: string | Uint8Array) => createHash("sha256").update(x).digest("hex");
const pending = new Map<string, Promise<unknown>>();
async function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = pending.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  pending.set(key, next);
  try {
    return await next;
  } finally {
    if (pending.get(key) === next) pending.delete(key);
  }
}
export function canvasBoardScopeFromUrl(url: URL): CanvasBoardScope | null {
  const names = ["canvasBoard", "canvasBoardKey", "canvasBoardSpace"];
  if (!names.some((n) => url.searchParams.has(n))) return null;
  if (
    names.some((n) => url.searchParams.getAll(n).length !== 1) ||
    url.searchParams.has("canvasThread")
  )
    throw new Error("invalid_canvas_board");
  const [pageId, canvasProjectKey, scope] = names.map((n) => url.searchParams.get(n)!);
  if (
    !pageId ||
    pageId !== pageId.trim() ||
    !/^[A-Za-z0-9:_-]{1,128}$/u.test(canvasProjectKey!) ||
    (scope !== "" && scope !== scope!.trim())
  )
    throw new Error("invalid_canvas_board");
  return { pageId: pageId!, canvasProjectKey: canvasProjectKey!, scopeSpaceId: scope || null };
}
export function matchesCanvasBoard(expected: unknown, actual: CanvasBoardScope | null): boolean {
  if (!actual) return expected === undefined;
  if (!expected || typeof expected !== "object") return false;
  const e = expected as Record<string, unknown>;
  return (
    e.pageId === actual.pageId &&
    e.canvasProjectKey === actual.canvasProjectKey &&
    e.scopeSpaceId === actual.scopeSpaceId
  );
}
export function mossCanvasBoardDirectory(
  state: string,
  identity: MossMediaIdentity,
  board: CanvasBoardScope,
): string {
  return join(
    state,
    "moss-canvas-boards",
    mediaAccountScope(identity),
    hash(`${board.pageId}\0${board.canvasProjectKey}`),
  );
}
// Reject every linked ancestor, including an existing target substituted after an earlier run.
async function safeDirectory(root: string, path: string): Promise<void> {
  const rel = relative(resolve(root), resolve(path));
  if (rel.startsWith("..") || resolve(root) === resolve(path))
    throw new Error("canvas_board_path_invalid");
  let current = resolve(root);
  for (const part of ["", ...rel.split(/[\\/]/u)]) {
    if (part) current = join(current, part);
    try {
      const s = await lstat(current);
      if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("canvas_board_path_invalid");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      try {
        await mkdir(current);
      } catch (race) {
        if ((race as NodeJS.ErrnoException).code !== "EEXIST") throw race;
      }
      const created = await lstat(current);
      if (!created.isDirectory() || created.isSymbolicLink())
        throw new Error("canvas_board_path_invalid");
    }
  }
}
async function existingDirectory(root: string, path: string): Promise<void> {
  const rel = relative(resolve(root), resolve(path));
  if (rel.startsWith("..")) throw new Error("canvas_board_path_invalid");
  let current = resolve(root);
  for (const part of ["", ...rel.split(/[\\/]/u).filter(Boolean)]) {
    if (part) current = join(current, part);
    const s = await lstat(current);
    if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("canvas_board_path_invalid");
  }
}
async function readJson(path: string): Promise<Record<string, unknown>> {
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > 64 * 1024 * 1024)
    throw new Error("canvas_board_manifest_invalid");
  const f = await open(path, "r");
  try {
    const a = await f.stat();
    if (a.ino !== s.ino || a.dev !== s.dev || a.size !== s.size)
      throw new Error("canvas_board_manifest_changed");
    return JSON.parse(await f.readFile("utf8"));
  } finally {
    await f.close();
  }
}
async function writeJson(path: string, value: unknown) {
  const f = await open(path, "wx", 0o600);
  try {
    await f.writeFile(JSON.stringify(value));
    await f.sync();
  } finally {
    await f.close();
  }
}
export async function registerLegacyCanvasBoards(
  state: string,
  boards: CanvasBoardScope[],
  bundle: string,
): Promise<void> {
  const path = join(state, "moss-canvas-board-legacy-registry.json");
  const validate = async () => {
    const r = await readJson(path);
    if (r.version !== 1 || !Array.isArray(r.boards) || r.digest !== hash(JSON.stringify(r.boards)))
      throw new Error("canvas_board_registry_invalid");
    for (const b of r.boards)
      if (
        !b ||
        typeof b.pageId !== "string" ||
        typeof b.canvasProjectKey !== "string" ||
        !(b.scopeSpaceId === null || typeof b.scopeSpaceId === "string")
      )
        throw new Error("canvas_board_registry_invalid");
  };
  await existingDirectory(state, state);
  try {
    await validate();
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  await serialized(path, async () => {
    const lock = join(state, "moss-canvas-board-registry-lock");
    await safeDirectory(state, lock);
    await withLease(bundle, lock, async () => {
      try {
        await validate();
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      const temporary = `${path}.pending-${randomUUID()}`;
      await writeJson(temporary, { version: 1, boards, digest: hash(JSON.stringify(boards)) });
      // All participants hold the process-identity lease; a confirmed registry is never replaced.
      // An interrupted temporary file is retained, while the next run can publish a new complete one.
      await rename(temporary, path);
      await validate();
    });
  });
}
async function assertLegacyBoard(state: string, board: CanvasBoardScope) {
  await existingDirectory(state, state);
  const r = await readJson(join(state, "moss-canvas-board-legacy-registry.json"));
  if (
    r.version !== 1 ||
    !Array.isArray(r.boards) ||
    r.digest !== hash(JSON.stringify(r.boards)) ||
    !r.boards.some(
      (b: CanvasBoardScope) =>
        b.pageId === board.pageId && b.canvasProjectKey === board.canvasProjectKey,
    )
  )
    throw new Error("canvas_board_not_legacy");
}
type FileProof = { path: string; size: number; sha256: string; directory?: true };
async function streamFile(path: string, dest?: string): Promise<{ size: number; sha256: string }> {
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1)
    throw new Error("canvas_legacy_snapshot_file_invalid");
  const input = await open(path, "r"),
    output = dest ? await open(dest, "wx", 0o600) : null;
  const digest = createHash("sha256");
  let size = 0;
  try {
    const before = await input.stat();
    if (before.ino !== s.ino || before.dev !== s.dev)
      throw new Error("canvas_legacy_snapshot_changed");
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      digest.update(chunk);
      size += bytesRead;
      if (output) await output.writeFile(chunk);
    }
    const after = await input.stat();
    if (
      after.size !== size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ino !== s.ino ||
      after.dev !== s.dev
    )
      throw new Error("canvas_legacy_snapshot_changed");
    await output?.sync();
    return { size, sha256: digest.digest("hex") };
  } finally {
    await input.close();
    await output?.close();
  }
}
async function files(root: string): Promise<FileProof[]> {
  const result: FileProof[] = [];
  async function walk(dir: string, depth: number) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, e.name),
        s = await lstat(path);
      if (s.isSymbolicLink()) throw new Error("canvas_legacy_snapshot_link");
      if (s.isDirectory()) {
        result.push({
          path: relative(root, path).replaceAll("\\", "/"),
          size: 0,
          sha256: hash("directory"),
          directory: true,
        });
        await walk(path, depth + 1);
        continue;
      }
      if (!s.isFile() || s.nlink !== 1) throw new Error("canvas_legacy_snapshot_file_invalid");
      // The writer lease is process state, not user data. Never transplant a live lease.
      if (
        relative(root, path).replaceAll("\\", "/") === "workspace/.hoola/canvas/writer.lease.json"
      )
        continue;
      result.push({
        path: relative(root, path).replaceAll("\\", "/"),
        ...(await streamFile(path)),
      });
    }
  }
  await walk(root, 0);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
async function copyVerified(source: string, target: string, entries: FileProof[]) {
  for (const e of entries) {
    if (
      !e.path ||
      e.path.split("/").some((p) => !p || p === "." || p === "..") ||
      e.path.includes("\\") ||
      e.path.includes(":")
    )
      throw new Error("canvas_legacy_manifest_invalid");
    if (e.directory) {
      await existingDirectory(source, join(source, e.path));
      await mkdir(join(target, e.path), { recursive: true });
      continue;
    }
    const dest = join(target, e.path);
    await mkdir(join(dest, ".."), { recursive: true });
    await existingDirectory(source, join(source, e.path, ".."));
    const copied = await streamFile(join(source, e.path), dest);
    if (copied.size !== e.size || copied.sha256 !== e.sha256)
      throw new Error("canvas_legacy_snapshot_changed");
  }
}
async function readManifest(root: string) {
  const value = (await readJson(join(root, "board-source.json"))) as {
    version: number;
    digest: string;
    files: FileProof[];
    source: string;
  };
  if (
    value.version !== 1 ||
    !Array.isArray(value.files) ||
    value.digest !== hash(JSON.stringify(value.files))
  )
    throw new Error("canvas_legacy_manifest_invalid");
  return value;
}
// Only known storage metadata is relocated. User text and the immutable source archive
// are never searched/replaced. The hosted store already rejects paths outside its root.
//
// A path written before the store last moved (a relocated or copied profile, an older state
// directory) lies outside `source`. That must not keep the board from opening (2026-11-16: a
// profile copied from another folder left every old board on "restoring" forever). Such a path
// is re-anchored by its tail below the store root when the copy holds that file; otherwise it
// names nothing in this store: a recent-file entry is dropped and an asset row keeps its value.
const STORE_ROOT_ENTRIES: ReadonlySet<string> = new Set(["workspace", "assets"]);
async function tailInStore(target: string, value: string): Promise<string | null> {
  const parts = value.replaceAll("\\", "/").split("/");
  for (let i = 1; i < parts.length - 1; i++) {
    if (!STORE_ROOT_ENTRIES.has(parts[i]!)) continue;
    const tail = parts.slice(i);
    if (tail.some((part) => !part || part === "." || part === ".." || part.includes(":"))) continue;
    try {
      const found = await lstat(join(target, ...tail));
      if (found.isFile() && !found.isSymbolicLink()) return join(...tail);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return null;
}
async function relocateBoardMetadata(target: string, source: string, destination: string) {
  /** `undefined`: an absolute path that names nothing in this store. */
  const relocate = async (value: string | null): Promise<string | null | undefined> => {
    if (value === null || !isAbsolute(value)) return value;
    const rel = relative(resolve(source), resolve(value));
    if (!rel.startsWith("..") && !isAbsolute(rel)) return join(destination, rel);
    const tail = await tailInStore(target, value);
    return tail === null ? undefined : join(destination, tail);
  };
  const recentPath = join(target, "workspace/.hoola/canvas/recent-tldr-files.json");
  try {
    await existingDirectory(target, join(recentPath, ".."));
    const s = await lstat(recentPath);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > 1024 * 1024)
      throw new Error("canvas_legacy_recent_invalid");
    const f = await open(recentPath, "r");
    let entries;
    try {
      entries = JSON.parse(await f.readFile("utf8"));
    } finally {
      await f.close();
    }
    if (!Array.isArray(entries)) throw new Error("canvas_legacy_recent_invalid");
    const updated = [];
    for (const e of entries) {
      if (!e || typeof e.filePath !== "string") throw new Error("canvas_legacy_recent_invalid");
      const filePath = await relocate(e.filePath);
      if (filePath !== undefined) updated.push({ ...e, filePath });
    }
    const out = await open(recentPath, "r+");
    try {
      await out.truncate(0);
      await out.writeFile(JSON.stringify(updated));
      await out.sync();
    } finally {
      await out.close();
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const databasePath = join(target, "hoola-canvas.sqlite3");
  try {
    const s = await lstat(databasePath);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1)
      throw new Error("canvas_legacy_database_invalid");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(toNamespacedPath(databasePath));
    try {
      if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok")
        throw new Error("canvas_legacy_database_invalid");
      const present = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='assets_meta'")
        .get();
      if (present) {
        const rows = db
          .prepare("SELECT asset_id,local_path,preview_path FROM assets_meta")
          .all() as { asset_id: string; local_path: string; preview_path: string | null }[];
        const moved = [];
        for (const r of rows) {
          const local = await relocate(r.local_path),
            preview = await relocate(r.preview_path);
          moved.push({
            assetId: r.asset_id,
            local: local === undefined ? r.local_path : local,
            preview: preview === undefined ? r.preview_path : preview,
          });
        }
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const m of moved)
            db.prepare("UPDATE assets_meta SET local_path=?,preview_path=? WHERE asset_id=?").run(
              m.local,
              m.preview,
              m.assetId,
            );
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      }
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
// The native lease uses PID plus process creation identity on Windows and refuses live writers.
async function withLease<T>(bundle: string, directory: string, work: () => Promise<T>): Promise<T> {
  await safeDirectory(directory, join(directory, "workspace/.hoola/canvas"));
  const m = await import(
    pathToFileURL(join(bundle, "apps/codex-canvas/electron/workspace-persistence.mjs")).href
  );
  const identity = m.resolveProjectIdentity(join(directory, "workspace"));
  const paths = m.createProjectPaths(identity);
  await mkdir(paths.canvasRoot, { recursive: true });
  const held = m.acquireProjectWriterLease({ identity, paths });
  if (!held.ok) throw new Error("canvas_writer_busy");
  try {
    return await work();
  } finally {
    held.lease.release();
  }
}
export async function freezeLegacyBoardSource(
  state: string,
  identity: MossMediaIdentity,
  bundle: string,
): Promise<string> {
  const source = join(state, "moss-canvas", mediaAccountScope(identity));
  const parent = join(state, "moss-canvas-board-legacy", mediaAccountScope(identity));
  const archive = join(parent, "snapshot");
  return serialized(archive, async () => {
    await safeDirectory(state, parent);
    try {
      await existingDirectory(state, archive);
      await readManifest(archive);
      return archive;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    await safeDirectory(state, source);
    return withLease(bundle, source, async () => {
      const entries = await files(source),
        temporary = join(parent, `snapshot-pending-${randomUUID()}`);
      await mkdir(temporary);
      await copyVerified(source, temporary, entries);
      if (JSON.stringify(entries) !== JSON.stringify(await files(source)))
        throw new Error("canvas_legacy_snapshot_changed");
      await writeJson(join(temporary, "board-source.json"), {
        version: 1,
        digest: hash(JSON.stringify(entries)),
        files: entries,
        excludedRuntimePaths: ["workspace/.hoola/canvas/writer.lease.json"],
        source,
        capturedAt: new Date().toISOString(),
      });
      // No deletion: failed/interrupted attempts remain available for diagnosis.
      // Native source lease serializes processes; recheck an archive published by another one.
      try {
        await readManifest(archive);
        return archive;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      await rename(temporary, archive);
      return archive;
    });
  });
}
export async function initializeCanvasBoard(
  state: string,
  identity: MossMediaIdentity,
  board: CanvasBoardBinding,
  bundle: string,
): Promise<string> {
  const target = mossCanvasBoardDirectory(state, identity, board);
  return serialized(target, async () => {
    const lock = join(
      state,
      "moss-canvas-board-locks",
      mediaAccountScope(identity),
      hash(board.pageId),
    );
    await safeDirectory(state, lock);
    return withLease(bundle, lock, async () => {
      try {
        await existingDirectory(state, target);
        const r = await readJson(join(target, "board-initialization.json"));
        if (
          r.pageId !== board.pageId ||
          r.canvasProjectKey !== board.canvasProjectKey ||
          r.version !== board.version
        )
          throw new Error("canvas_board_binding_changed");
        await safeDirectory(state, target);
        return target;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      const parent = join(target, "..");
      await safeDirectory(state, parent);
      const temporary = `${target}.pending-${randomUUID()}`;
      await mkdir(temporary);
      try {
        let sourceDigest: string | null = null;
        if (board.version === 1) {
          await assertLegacyBoard(state, board);
          const source = await freezeLegacyBoardSource(state, identity, bundle),
            manifest = await readManifest(source);
          await copyVerified(source, temporary, manifest.files);
          sourceDigest = manifest.digest;
          // Use the final destination in persistent paths, never the staging directory.
          await relocateBoardMetadata(temporary, manifest.source, target);
        }
        await writeJson(join(temporary, "board-initialization.json"), {
          ...board,
          sourceDigest,
          initializedAt: new Date().toISOString(),
        });
        await rename(temporary, target);
      } catch (error) {
        // The staging copy holds nothing the frozen snapshot does not: remove it, so a board
        // that cannot be seeded does not leave one more full copy behind on every open.
        await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      return target;
    });
  });
}
