// FILE: Layers/LibraryService.ts
// Purpose: Moss 资料库 local index service — scans agent data roots into SQLite,
//          keeps the index fresh with fs watchers, and owns all mutations.
//          Data safety: agent source files are read-only; deletes are two-stage
//          (DB trash, 30 days) and permanent deletes only remove Moss-owned
//          import copies plus the index row.
// Layer: Server service (Effect)

import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  LibraryImportResult,
  LibraryItem,
  LibraryItemsResult,
  LibraryListResult,
  LibraryRegisterItem,
  LibrarySyncResult,
} from "@synara/contracts";
import {
  LIBRARY_IMPORT_FILE_MAX_BYTES,
  LIBRARY_RENAME_EXTENSION_ERROR_CODE,
} from "@synara/contracts";
import { Effect, Layer } from "effect";
import * as Semaphore from "effect/Semaphore";

import { LibraryRepository } from "../../persistence/Services/LibraryRepository.ts";
import { LibraryServiceError } from "../Errors.ts";
import {
  buildScannedLibraryItemFields,
  isPathInsideLibraryRoot,
  isSkippableLibraryScanFile,
  libraryRenamePreservesExtension,
  resolveLibraryImportRoot,
  resolveLibraryScanRoots,
  sanitizeLibraryImportFileName,
  type LibraryScanRootSpec,
  type ScannedLibraryFile,
} from "../libraryScan.ts";
import { LibraryService, type LibraryServiceShape } from "../Services/LibraryService.ts";

/** Codex 回收站 keeps files for 30 days before permanent deletion (§2.6). */
export const LIBRARY_TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const WATCH_DEBOUNCE_MS = 750;

/** A new file version at the same path remains discoverable after deletion. */
function scannedSourceDeletionKey(file: ScannedLibraryFile): string {
  const resolved = path.resolve(file.path);
  const sourcePath = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const version = JSON.stringify([file.root.source, sourcePath, file.size, file.mtimeMs]);
  return `moss-library-source:v1:${createHash("sha256").update(version).digest("hex")}`;
}

export interface MakeLibraryServiceOptions {
  readonly roots: readonly LibraryScanRootSpec[];
  readonly importRoot: string;
  /** Test hook: deterministic clock (ms epoch). */
  readonly now?: () => number;
}

function toServiceError(message: string) {
  return (cause: unknown) =>
    cause instanceof LibraryServiceError ? cause : new LibraryServiceError({ message, cause });
}

async function walkLibraryRoot(root: LibraryScanRootSpec): Promise<ScannedLibraryFile[]> {
  const found: ScannedLibraryFile[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth < 1) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (isSkippableLibraryScanFile(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, depth - 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(fullPath).catch(() => null);
      if (!stat) continue;
      found.push({ root, path: fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  };
  await walk(root.dir, root.depth);
  return found;
}

async function pathIsDirectory(candidate: string): Promise<boolean> {
  const stat = await fs.stat(candidate).catch(() => null);
  return stat?.isDirectory() === true;
}

/**
 * Builds the service shape. Scan/watch lifecycle stays with the caller so unit
 * tests can drive sync() explicitly; LibraryServiceLive forks the startup scan
 * and the filesystem watchers into the server scope.
 */
export const makeLibraryServiceShape = (options: MakeLibraryServiceOptions) =>
  Effect.gen(function* () {
    const repository = yield* LibraryRepository;
    const now = options.now ?? Date.now;
    const isoNow = () => new Date(now()).toISOString();
    // Only source scans and permanent removal share this permit. UI metadata
    // actions remain independent; an active walk cannot commit after deletion.
    const sourceRemoval = yield* Semaphore.make(1);
    const scannedSourceKeys = new Map<string, string>();

    const permanentDeletionInput = (item: LibraryItem) =>
      Effect.gen(function* () {
        const root = item.path
          ? options.roots.find(
              (candidate) =>
                candidate.source === item.source &&
                isPathInsideLibraryRoot(item.path!, candidate.dir),
            )
          : undefined;
        const stat =
          item.path && root
            ? yield* Effect.tryPromise({
                try: async () => {
                  try {
                    return await fs.stat(item.path!);
                  } catch (cause) {
                    const code = (cause as NodeJS.ErrnoException | null)?.code;
                    if (code === "ENOENT" || code === "ENOTDIR") return null;
                    throw cause;
                  }
                },
                catch: toServiceError("无法确认原文件状态，资料仍保留，请稍后重试。"),
              })
            : null;
        const sourceKeys = new Set<string>();
        const indexedSourceKey = scannedSourceKeys.get(item.id);
        if (indexedSourceKey) sourceKeys.add(indexedSourceKey);
        if (root && stat?.isFile()) {
          sourceKeys.add(
            scannedSourceDeletionKey({
              root,
              path: item.path!,
              size: stat.size,
              mtimeMs: stat.mtimeMs,
            }),
          );
        }
        return {
          id: item.id,
          sourceKeys: [...sourceKeys],
        };
      });

    const purgeExpiredTrashUnlocked = Effect.gen(function* () {
      const trashedBefore = new Date(now() - LIBRARY_TRASH_RETENTION_MS).toISOString();
      const expired = yield* repository.listExpiredTrash({ trashedBefore });
      for (const item of expired) {
        yield* repository.deleteItem(yield* permanentDeletionInput(item));
        scannedSourceKeys.delete(item.id);
        // Only Moss-owned import copies may ever leave the disk.
        if (item.path && isPathInsideLibraryRoot(item.path, options.importRoot)) {
          yield* Effect.promise(() => fs.rm(item.path!, { force: true }).catch(() => undefined));
        }
      }
      return expired.length;
    }).pipe(Effect.mapError(toServiceError("Failed to purge expired library trash.")));
    const purgeExpiredTrash = Effect.gen(function* () {
      const expired = yield* repository.listExpiredTrash({
        trashedBefore: new Date(now() - LIBRARY_TRASH_RETENTION_MS).toISOString(),
      });
      // Listing a healthy catalog need not wait behind the startup filesystem walk.
      if (expired.length === 0) return 0;
      return yield* sourceRemoval.withPermits(1)(purgeExpiredTrashUnlocked);
    });

    const indexScannedFile = (
      file: ScannedLibraryFile,
      createdAt: string,
    ): Effect.Effect<LibraryItem, LibraryServiceError> =>
      Effect.gen(function* () {
        const fields = buildScannedLibraryItemFields(file);
        const sourceKey = scannedSourceDeletionKey(file);
        const existing = yield* repository.getItemByPath({ path: fields.path });
        if (existing._tag === "Some") {
          const current = existing.value;
          // Scans refresh file facts only — user metadata (title/favorite/folder/
          // trash) always wins over the filesystem.
          const next: LibraryItem = {
            ...current,
            kind: fields.kind,
            source: fields.source,
            sourceCli: fields.sourceCli,
            mimeType: fields.mimeType,
            size: fields.size,
            originationThreadId: fields.originationThreadId,
            updatedAt:
              Date.parse(fields.updatedAt) > Date.parse(current.updatedAt)
                ? fields.updatedAt
                : current.updatedAt,
          };
          if (JSON.stringify(next) !== JSON.stringify(current)) {
            yield* repository.upsertItem(next, { sourceKey });
          }
          scannedSourceKeys.set(next.id, sourceKey);
          return next;
        }
        const inserted: LibraryItem = {
          ...fields,
          favorite: false,
          folderId: null,
          trashedAt: null,
          createdAt,
          updatedAt: fields.updatedAt,
        };
        yield* repository.upsertItem(inserted, { sourceKey });
        scannedSourceKeys.set(inserted.id, sourceKey);
        return inserted;
      }).pipe(Effect.mapError(toServiceError("Failed to index a library file.")));

    const sync: LibraryServiceShape["sync"] = () =>
      Effect.gen(function* () {
        const existingRoots: LibraryScanRootSpec[] = [];
        for (const root of options.roots) {
          if (yield* Effect.promise(() => pathIsDirectory(root.dir))) {
            existingRoots.push(root);
          }
        }
        const seenPaths = new Set<string>();
        const deletedSources = new Set(yield* repository.listDeletedMediaIds());
        let scanned = 0;
        let upserted = 0;
        const createdAt = isoNow();
        for (const root of existingRoots) {
          const files = yield* Effect.promise(() => walkLibraryRoot(root));
          for (const file of files) {
            scanned += 1;
            seenPaths.add(path.resolve(file.path));
            if (deletedSources.has(scannedSourceDeletionKey(file))) continue;
            yield* indexScannedFile(file, createdAt);
            upserted += 1;
          }
        }
        // Reconcile removals: rows under a scanned root whose file is gone leave
        // the index (a trashed row whose file vanished can never be restored).
        const rows = yield* repository.listItems({ includeTrashed: true });
        let removed = 0;
        for (const row of rows) {
          if (!row.path) continue;
          const underScannedRoot = existingRoots.some((root) =>
            isPathInsideLibraryRoot(row.path!, root.dir),
          );
          if (!underScannedRoot) continue;
          if (!seenPaths.has(path.resolve(row.path))) {
            yield* repository.deleteItem({ id: row.id });
            scannedSourceKeys.delete(row.id);
            removed += 1;
          }
        }
        yield* purgeExpiredTrashUnlocked;
        const result: LibrarySyncResult = { scanned, upserted, removed };
        return result;
      }).pipe(
        Effect.mapError(toServiceError("Failed to sync the library index.")),
        sourceRemoval.withPermits(1),
      );

    const list: LibraryServiceShape["list"] = (input) =>
      Effect.gen(function* () {
        yield* purgeExpiredTrash;
        const includeTrashed = input.includeTrashed ?? false;
        const [items, folders] = yield* Effect.all([
          repository.listItems({ includeTrashed }),
          repository.listFolders(),
        ]);
        const result: LibraryListResult = { items: [...items], folders: [...folders] };
        return result;
      }).pipe(Effect.mapError(toServiceError("Failed to list library items.")));

    const patchItems = (
      ids: readonly string[],
      patch: (item: LibraryItem) => LibraryItem | null,
    ): Effect.Effect<LibraryItemsResult, LibraryServiceError> =>
      Effect.gen(function* () {
        const updated: LibraryItem[] = [];
        for (const id of ids) {
          const existing = yield* repository.getItemById({ id });
          if (existing._tag === "None") continue;
          const next = patch(existing.value);
          if (next === null) continue;
          yield* repository.upsertItem(next);
          updated.push(next);
        }
        const result: LibraryItemsResult = { items: updated };
        return result;
      }).pipe(Effect.mapError(toServiceError("Failed to update library items.")));

    const favorite: LibraryServiceShape["favorite"] = (input) =>
      patchItems(input.ids, (item) => ({
        ...item,
        favorite: input.favorite,
      }));

    const move: LibraryServiceShape["move"] = (input) =>
      Effect.gen(function* () {
        if (input.folderId !== null) {
          const folders = yield* repository.listFolders();
          if (!folders.some((folder) => folder.id === input.folderId)) {
            return yield* new LibraryServiceError({
              message: "The destination folder no longer exists.",
            });
          }
        }
        return yield* patchItems(input.ids, (item) => ({
          ...item,
          folderId: input.folderId,
        }));
      }).pipe(Effect.mapError(toServiceError("Failed to move library items.")));

    const rename: LibraryServiceShape["rename"] = (input) =>
      Effect.gen(function* () {
        const existing = yield* repository.getItemById({ id: input.id });
        if (existing._tag === "None") {
          return yield* new LibraryServiceError({ message: "This library item no longer exists." });
        }
        const item = existing.value;
        if (
          sanitizeLibraryImportFileName(input.title) !== input.title ||
          /[<>:"/\\|?*\u0000-\u001f]/.test(input.title) ||
          /[. ]$/.test(input.title)
        ) {
          return yield* new LibraryServiceError({ message: "请输入有效的文件名。" });
        }
        // Codex 重命名 rule: the extension cannot change.
        if (!libraryRenamePreservesExtension(item.title, input.title)) {
          return yield* new LibraryServiceError({
            message: "无法更改文件扩展名。",
            code: LIBRARY_RENAME_EXTENSION_ERROR_CODE,
          });
        }
        let nextPath = item.path;
        // Only Moss-owned import copies are renamed on disk; agent source files
        // keep their path and get a display-title override.
        if (item.path && isPathInsideLibraryRoot(item.path, options.importRoot)) {
          const candidate = path.join(path.dirname(item.path), input.title);
          if (candidate !== item.path) {
            yield* Effect.tryPromise({
              try: async () => {
                const [root, parent, sourceStat] = await Promise.all([
                  fs.realpath(options.importRoot),
                  fs.realpath(path.dirname(item.path!)),
                  fs.lstat(item.path!),
                ]);
                if (
                  !sourceStat.isFile() ||
                  sourceStat.isSymbolicLink() ||
                  !isPathInsideLibraryRoot(path.join(parent, path.basename(candidate)), root)
                ) {
                  throw new Error("Library import path is no longer owned.");
                }
                // link() creates the new name atomically and refuses an existing
                // destination. rename() could overwrite another imported file.
                await fs.link(item.path!, candidate);
                try {
                  await fs.unlink(item.path!);
                } catch (cause) {
                  const linkedStat = await fs.lstat(candidate).catch(() => null);
                  if (linkedStat?.ino === sourceStat.ino && linkedStat.dev === sourceStat.dev) {
                    await fs.unlink(candidate).catch(() => undefined);
                  }
                  throw cause;
                }
              },
              catch: toServiceError("无法重命名文件，请确认文件仍存在且名称未被使用。"),
            });
            nextPath = candidate;
          }
        }
        const next: LibraryItem = {
          ...item,
          title: input.title,
          path: nextPath,
          updatedAt: isoNow(),
        };
        yield* repository.upsertItem(next);
        const result: LibraryItemsResult = { items: [next] };
        return result;
      }).pipe(Effect.mapError(toServiceError("Failed to rename the library item.")));

    const trash: LibraryServiceShape["trash"] = (input) =>
      patchItems(input.ids, (item) =>
        item.trashedAt !== null ? item : { ...item, trashedAt: isoNow() },
      );

    const restore: LibraryServiceShape["restore"] = (input) =>
      patchItems(input.ids, (item) => ({ ...item, trashedAt: null }));

    const deletePermanently: LibraryServiceShape["deletePermanently"] = (input) =>
      Effect.gen(function* () {
        const deleted: LibraryItem[] = [];
        for (const id of input.ids) {
          const existing = yield* repository.getItemById({ id });
          if (existing._tag === "None") continue;
          const item = existing.value;
          yield* repository.deleteItem(yield* permanentDeletionInput(item));
          scannedSourceKeys.delete(item.id);
          if (item.path && isPathInsideLibraryRoot(item.path, options.importRoot)) {
            yield* Effect.promise(() => fs.rm(item.path!, { force: true }).catch(() => undefined));
          }
          deleted.push(item);
        }
        const result: LibraryItemsResult = { items: deleted };
        return result;
      }).pipe(
        Effect.mapError(toServiceError("Failed to permanently delete library items.")),
        sourceRemoval.withPermits(1),
      );

    const createFolder: LibraryServiceShape["createFolder"] = (input) =>
      Effect.gen(function* () {
        const nowIso = isoNow();
        const folder = {
          id: input.id,
          title: input.title,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        yield* repository.insertFolder(folder);
        return { folder };
      }).pipe(Effect.mapError(toServiceError("Failed to create the library folder.")));

    const renameFolder: LibraryServiceShape["renameFolder"] = (input) =>
      Effect.gen(function* () {
        const folders = yield* repository.listFolders();
        const folder = folders.find((candidate) => candidate.id === input.id);
        if (!folder) {
          return yield* new LibraryServiceError({
            message: "This library folder no longer exists.",
          });
        }
        const next = { ...folder, title: input.title, updatedAt: isoNow() };
        yield* repository.saveFolder(next);
        return { folder: next };
      }).pipe(Effect.mapError(toServiceError("Failed to rename the library folder.")));

    const deleteFolder: LibraryServiceShape["deleteFolder"] = (input) =>
      Effect.gen(function* () {
        // Virtual folders never touch the disk: children are filed back out.
        yield* repository.clearFolderMembership({ id: input.id });
        yield* repository.deleteFolder({ id: input.id });
      }).pipe(Effect.mapError(toServiceError("Failed to delete the library folder.")));

    const register: LibraryServiceShape["register"] = (input) =>
      Effect.gen(function* () {
        const deletedMedia = new Set(yield* repository.listDeletedMediaIds());
        const upserted: LibraryItem[] = [];
        for (const entry of input.items) {
          if (deletedMedia.has(entry.id)) continue;
          const existing = yield* repository.getItemById({ id: entry.id });
          if (existing._tag === "Some") {
            // A previously migrated (or scanned) row always wins over a re-run
            // of the one-time localStorage migration.
            upserted.push(existing.value);
            continue;
          }
          upserted.push(yield* insertRegisteredItem(entry));
        }
        const result: LibraryItemsResult = { items: upserted };
        return result;
      }).pipe(Effect.mapError(toServiceError("Failed to register legacy library items.")));

    const insertRegisteredItem = (
      entry: LibraryRegisterItem,
    ): Effect.Effect<LibraryItem, LibraryServiceError> =>
      Effect.gen(function* () {
        const nowIso = isoNow();
        const updatedAt =
          typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
            ? new Date(Math.max(0, entry.updatedAt)).toISOString()
            : nowIso;
        const item: LibraryItem = {
          id: entry.id,
          title: entry.title,
          kind: entry.kind ?? "other",
          source: "user:legacy",
          sourceCli: entry.sourceCli ?? "other",
          path: entry.path ?? null,
          mimeType: entry.mimeType ?? null,
          size: 0,
          favorite: entry.favorite ?? false,
          folderId: entry.folderId ?? null,
          trashedAt: null,
          originationThreadId: null,
          createdAt: nowIso,
          updatedAt,
        };
        yield* repository.upsertItem(item);
        return item;
      }).pipe(Effect.mapError(toServiceError("Failed to register a legacy library item.")));

    const importRootSpec = (): LibraryScanRootSpec => ({
      id: "moss-library-imports",
      source: "user:import",
      sourceCli: "moss",
      dir: options.importRoot,
      depth: 6,
      threadIdFromParentDir: false,
    });

    const importFiles: LibraryServiceShape["importFiles"] = (input) =>
      Effect.gen(function* () {
        const root = importRootSpec();
        const stamp = new Date(now()).toISOString().slice(0, 10);
        const batchDir = path.join(options.importRoot, `imports-${stamp}`);
        const imported: LibraryItem[] = [];
        let skipped = 0;
        for (const file of input.files) {
          const safeName = sanitizeLibraryImportFileName(file.name);
          const bytes = Buffer.from(file.dataBase64, "base64");
          if (
            !safeName ||
            bytes.byteLength === 0 ||
            bytes.byteLength > LIBRARY_IMPORT_FILE_MAX_BYTES
          ) {
            skipped += 1;
            continue;
          }
          const written = yield* Effect.promise(async () => {
            await fs.mkdir(batchDir, { recursive: true });
            let candidate = path.join(batchDir, safeName);
            const ext = path.extname(safeName);
            const stem = safeName.slice(0, safeName.length - ext.length);
            for (let attempt = 2; await pathIsDirectoryOrFile(candidate); attempt += 1) {
              candidate = path.join(batchDir, `${stem}-${attempt}${ext}`);
            }
            await fs.writeFile(candidate, bytes);
            const stat = await fs.stat(candidate);
            return { path: candidate, size: stat.size, mtimeMs: stat.mtimeMs };
          }).pipe(Effect.mapError(toServiceError("Failed to copy an imported library file.")));
          imported.push(
            yield* indexScannedFile(
              { root, path: written.path, size: written.size, mtimeMs: written.mtimeMs },
              isoNow(),
            ),
          );
        }
        const result: LibraryImportResult = {
          items: imported,
          imported: imported.length,
          skipped,
        };
        return result;
      }).pipe(Effect.mapError(toServiceError("Failed to import library files.")));

    return {
      list,
      sync,
      favorite,
      move,
      rename,
      trash,
      restore,
      deletePermanently,
      createFolder,
      renameFolder,
      deleteFolder,
      register,
      importFiles,
    } satisfies LibraryServiceShape;
  });

async function pathIsDirectoryOrFile(candidate: string): Promise<boolean> {
  return (await fs.stat(candidate).catch(() => null)) !== null;
}

function defaultLibraryHomes(): {
  readonly codexHome: string;
  readonly claudeHome: string;
  readonly mossHome: string;
} {
  const home = os.homedir();
  const env = process.env;
  return {
    codexHome: env.CODEX_HOME?.trim() || path.join(home, ".codex"),
    claudeHome: env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, ".claude"),
    mossHome: env.MOSS_HOME?.trim() || path.join(home, ".moss"),
  };
}

export const LibraryServiceLive = Layer.effect(
  LibraryService,
  Effect.gen(function* () {
    const homes = defaultLibraryHomes();
    const roots = resolveLibraryScanRoots(homes);
    const importRoot = resolveLibraryImportRoot(homes.mossHome);
    const shape = yield* makeLibraryServiceShape({ roots, importRoot });

    // Startup full scan runs in the background so server boot never blocks on
    // large agent data roots; failures are logged, never fatal.
    yield* shape.sync().pipe(
      Effect.catch((error) =>
        Effect.logWarning("Library startup scan failed", { error: error.message }),
      ),
      Effect.forkScoped,
    );

    // Incremental freshness: watch every existing root and debounce into sync().
    // Watching is best-effort — platforms without recursive watch simply rely on
    // the startup scan plus explicit library.sync calls.
    yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const watchers: FSWatcher[] = [];
        let timer: ReturnType<typeof setTimeout> | null = null;
        const schedule = () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            void Effect.runPromise(shape.sync().pipe(Effect.catch(() => Effect.void))).catch(
              () => undefined,
            );
          }, WATCH_DEBOUNCE_MS);
        };
        for (const root of roots) {
          if (!(await pathIsDirectory(root.dir))) continue;
          try {
            watchers.push(
              watch(root.dir, { recursive: process.platform !== "linux" }, () => schedule()),
            );
          } catch {
            // A root that cannot be watched still scans at startup and on demand.
          }
        }
        return { watchers, clearTimer: () => timer && clearTimeout(timer) };
      }),
      (handle) =>
        Effect.sync(() => {
          handle.clearTimer();
          for (const watcher of handle.watchers) watcher.close();
        }),
    );

    return shape;
  }),
);
