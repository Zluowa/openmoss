import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { LIBRARY_RENAME_EXTENSION_ERROR_CODE } from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { afterAll, vi } from "vitest";
import { LibraryRepositoryLive } from "../../persistence/Layers/LibraryRepository.ts";
import { LibraryRepository } from "../../persistence/Services/LibraryRepository.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { LIBRARY_TRASH_RETENTION_MS, makeLibraryServiceShape } from "./LibraryService.ts";
import { resolveLibraryScanRoots } from "../libraryScan.ts";
import { LibraryService } from "../Services/LibraryService.ts";

// Homes are fixed for the whole suite (the layer memoizes them); tests add and
// remove files under these roots and rescan between steps.
const tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "moss-library-test-"));
const homes = {
  codexHome: path.join(tempDir, ".codex"),
  claudeHome: path.join(tempDir, ".claude"),
  mossHome: path.join(tempDir, ".moss"),
};
let clockMs = 1_760_000_000_000;

const layer = it.layer(
  Layer.effect(
    LibraryService,
    makeLibraryServiceShape({
      roots: resolveLibraryScanRoots(homes),
      importRoot: path.join(homes.mossHome, "library"),
      now: () => clockMs,
    }),
  ).pipe(Layer.provideMerge(LibraryRepositoryLive), Layer.provideMerge(SqlitePersistenceMemory)),
);

async function writeFile(relative: string, contents: string = "x"): Promise<string> {
  const full = path.join(tempDir, relative);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, contents);
  return full;
}

afterAll(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

// The block shares one layer (one in-memory DB, one temp root), so each test
// starts from a clean index and clean directories.
const resetLibrary = Effect.gen(function* () {
  const library = yield* LibraryService;
  const { items, folders } = yield* library.list({ includeTrashed: true });
  if (items.length > 0) {
    yield* library.deletePermanently({ ids: items.map((item) => item.id) });
  }
  for (const folder of folders) {
    yield* library.deleteFolder({ id: folder.id });
  }
  yield* Effect.promise(async () => {
    for (const entry of await fs.readdir(tempDir)) {
      await fs.rm(path.join(tempDir, entry), { recursive: true, force: true });
    }
  });
  clockMs = 1_760_000_000_000;
});

layer("LibraryService", (it) => {
  it.effect("scans agent roots, classifies kinds, and links origination threads", () =>
    Effect.gen(function* () {
      yield* resetLibrary;
      yield* Effect.promise(async () => {
        await writeFile(".codex/attachments/thread-abc/image-1.png", "png");
        await writeFile(".codex/attachments/thread-abc/pasted-text.txt", "txt");
        await writeFile(".codex/attachments/pasted-text-attachments.json", "{}");
        await writeFile(".codex/generated_images/thread-def/exec-1.png", "png");
        await writeFile(".claude/downloads/report.pdf", "pdf");
        await writeFile(".claude/file-history/notes.md", "md");
        await writeFile(".claude/downloads/.hidden", "hidden");
      });
      const library = yield* LibraryService;
      const result = yield* library.sync();
      assert.strictEqual(result.scanned, 5);
      assert.strictEqual(result.removed, 0);
      const { items } = yield* library.list({});
      assert.strictEqual(items.length, 5);

      const byTitle = new Map(items.map((item) => [item.title, item]));
      const attachment = byTitle.get("image-1.png");
      assert.ok(attachment);
      assert.strictEqual(attachment.kind, "image");
      assert.strictEqual(attachment.source, "codex:attachment");
      assert.strictEqual(attachment.sourceCli, "codex");
      assert.strictEqual(attachment.originationThreadId, "thread-abc");
      assert.strictEqual(attachment.favorite, false);
      assert.strictEqual(attachment.trashedAt, null);

      assert.strictEqual(byTitle.get("pasted-text.txt")?.kind, "document");
      assert.strictEqual(byTitle.get("exec-1.png")?.source, "codex:generated");
      assert.strictEqual(byTitle.get("report.pdf")?.source, "claude:downloads");
      assert.strictEqual(byTitle.get("notes.md")?.source, "claude:file-history");
      // Dotfiles and the codex index json never enter the library.
      assert.strictEqual(byTitle.has(".hidden"), false);
      assert.strictEqual(byTitle.has("pasted-text-attachments.json"), false);
    }),
  );

  it.effect("keeps user metadata on rescan and drops rows whose file vanished", () =>
    Effect.gen(function* () {
      yield* resetLibrary;
      const filePath = yield* Effect.promise(() =>
        writeFile(".codex/attachments/thread-abc/image-1.png", "png"),
      );
      const library = yield* LibraryService;
      yield* library.sync();
      const { items: initial } = yield* library.list({});
      const item = initial.find((entry) => entry.path === filePath);
      assert.ok(item);

      yield* library.favorite({ ids: [item.id], favorite: true });
      yield* library.rename({ id: item.id, title: "renamed.png" });

      const rescan = yield* library.sync();
      assert.strictEqual(rescan.removed, 0);
      const { items: afterRescan } = yield* library.list({});
      assert.strictEqual(afterRescan.length, 1);
      assert.strictEqual(afterRescan[0]!.id, item.id);
      assert.strictEqual(afterRescan[0]!.favorite, true);
      assert.strictEqual(afterRescan[0]!.title, "renamed.png");

      const repository = yield* LibraryRepository;
      const deletionKeysBefore = yield* repository.listDeletedMediaIds();
      yield* Effect.promise(() => fs.rm(filePath));
      const afterDelete = yield* library.sync();
      assert.strictEqual(afterDelete.removed, 1);
      const { items: finalItems } = yield* library.list({});
      assert.strictEqual(finalItems.length, 0);
      assert.deepStrictEqual(yield* repository.listDeletedMediaIds(), deletionKeysBefore);

      yield* Effect.promise(() => writeFile(".codex/attachments/thread-abc/image-1.png", "png"));
      yield* library.sync();
      assert.strictEqual((yield* library.list({})).items[0]?.id, item.id);
    }),
  );

  it.effect("runs the two-stage trash and never deletes agent source files", () =>
    Effect.gen(function* () {
      yield* resetLibrary;
      const filePath = yield* Effect.promise(() =>
        writeFile(".codex/attachments/thread-abc/image-1.png", "png"),
      );
      const library = yield* LibraryService;
      yield* library.sync();
      const { items } = yield* library.list({});
      const item = items[0]!;

      yield* library.trash({ ids: [item.id] });
      const { items: visible } = yield* library.list({});
      assert.strictEqual(visible.length, 0);
      const { items: withTrashed } = yield* library.list({ includeTrashed: true });
      assert.strictEqual(withTrashed.length, 1);
      assert.ok(withTrashed[0]!.trashedAt !== null);

      yield* library.restore({ ids: [item.id] });
      const { items: restored } = yield* library.list({});
      assert.strictEqual(restored.length, 1);
      assert.strictEqual(restored[0]!.trashedAt, null);

      // Permanent delete removes the row but the agent source file stays.
      yield* library.trash({ ids: [item.id] });
      yield* library.deletePermanently({ ids: [item.id] });
      const { items: gone } = yield* library.list({ includeTrashed: true });
      assert.strictEqual(gone.length, 0);
      const stat = yield* Effect.promise(() => fs.stat(filePath).catch(() => null));
      assert.ok(stat !== null);

      yield* library.sync();
      assert.strictEqual((yield* library.list({ includeTrashed: true })).items.length, 0);
      const restarted = yield* makeLibraryServiceShape({
        roots: resolveLibraryScanRoots(homes),
        importRoot: path.join(homes.mossHome, "library"),
        now: () => clockMs,
      });
      yield* restarted.sync();
      assert.strictEqual((yield* restarted.list({ includeTrashed: true })).items.length, 0);
      assert.strictEqual(yield* Effect.promise(() => fs.readFile(filePath, "utf8")), "png");

      // A replacement at that path and a different asset are separate versions,
      // not a reason to revive the deleted original or hide all future outputs.
      yield* Effect.promise(async () => {
        await fs.writeFile(filePath, "new-png-version");
        await writeFile(".codex/attachments/thread-abc/new-image.png", "new-image");
      });
      yield* restarted.sync();
      const { items: newAssets } = yield* restarted.list({});
      assert.strictEqual(newAssets.length, 2);
      assert.ok(newAssets.some((entry) => entry.id === item.id && entry.size === 15));
      assert.ok(newAssets.some((entry) => entry.title === "new-image.png"));
    }),
  );

  it.effect("does not let a scan captured before permanent deletion write the old row back", () =>
    Effect.gen(function* () {
      yield* resetLibrary;
      const filePath = yield* Effect.promise(() =>
        writeFile(".codex/generated_images/thread-race/late-scan.png", "original-version"),
      );
      const library = yield* LibraryService;
      const repository = yield* LibraryRepository;
      yield* library.sync();
      const { items } = yield* library.list({});
      const scanned = items.find((item) => item.path === filePath);
      assert.ok(scanned);
      const previousKeys = new Set(yield* repository.listDeletedMediaIds());
      yield* library.deletePermanently({ ids: [scanned.id] });
      const sourceKey = (yield* repository.listDeletedMediaIds()).find(
        (key) => key.startsWith("moss-library-source:v1:") && !previousKeys.has(key),
      );
      assert.ok(sourceKey);

      // Model the old scan resuming at its final database write, after deletion.
      yield* repository.upsertItem(scanned, { sourceKey });
      assert.strictEqual((yield* repository.getItemById({ id: scanned.id }))._tag, "None");
      assert.strictEqual((yield* library.list({ includeTrashed: true })).items.length, 0);
      assert.strictEqual(
        yield* Effect.promise(() => fs.readFile(filePath, "utf8")),
        "original-version",
      );
    }),
  );

  it.effect("keeps the row and deletion ledger when the source stat is denied", () =>
    Effect.gen(function* () {
      yield* resetLibrary;
      const filePath = yield* Effect.promise(() =>
        writeFile(".codex/generated_images/thread-denied/retained.png", "retained-source"),
      );
      const library = yield* LibraryService;
      const repository = yield* LibraryRepository;
      yield* library.sync();
      const { items } = yield* library.list({});
      const item = items.find((entry) => entry.path === filePath);
      assert.ok(item);
      const previousKeys = yield* repository.listDeletedMediaIds();
      const denied = Object.assign(new Error("Permission denied"), { code: "EACCES" });
      const stat = vi.spyOn(fs, "stat").mockRejectedValueOnce(denied);
      const failure = yield* Effect.flip(library.deletePermanently({ ids: [item.id] })).pipe(
        Effect.ensuring(Effect.sync(() => stat.mockRestore())),
      );
      assert.strictEqual(failure._tag, "LibraryServiceError");
      assert.strictEqual((yield* repository.getItemById({ id: item.id }))._tag, "Some");
      assert.deepStrictEqual(yield* repository.listDeletedMediaIds(), previousKeys);
      assert.strictEqual(
        yield* Effect.promise(() => fs.readFile(filePath, "utf8")),
        "retained-source",
      );

      yield* library.deletePermanently({ ids: [item.id] });
      yield* library.sync();
      assert.strictEqual((yield* library.list({ includeTrashed: true })).items.length, 0);
      assert.strictEqual(
        yield* Effect.promise(() => fs.readFile(filePath, "utf8")),
        "retained-source",
      );
    }),
  );

  it.effect("serializes an uncommitted scan with deletion across source versions A, B, and C", () =>
    Effect.gen(function* () {
      yield* resetLibrary;
      const filePath = yield* Effect.promise(() =>
        writeFile(".codex/generated_images/thread-version/race.png", "version-A"),
      );
      const library = yield* LibraryService;
      const repository = yield* LibraryRepository;
      yield* library.sync();
      const { items } = yield* library.list({});
      const versionA = items.find((item) => item.path === filePath);
      assert.ok(versionA);
      const previousKeys = new Set(yield* repository.listDeletedMediaIds());
      // A fresh service has no in-memory key for the existing row (upgrade/restart).
      const restarted = yield* makeLibraryServiceShape({
        roots: resolveLibraryScanRoots(homes),
        importRoot: path.join(homes.mossHome, "library"),
        now: () => clockMs,
      });
      const capturedA = yield* Deferred.make<void>();
      const releaseA = yield* Deferred.make<void>();
      const getByPath = repository.getItemByPath;
      let paused = false;
      const pathRead = vi.spyOn(repository, "getItemByPath").mockImplementation((input) =>
        Effect.gen(function* () {
          if (input.path === filePath && !paused) {
            paused = true;
            yield* Deferred.succeed(capturedA, undefined);
            yield* Deferred.await(releaseA);
          }
          return yield* getByPath(input);
        }),
      );
      const itemRead = vi.spyOn(repository, "getItemById");
      try {
        const scanning = yield* restarted.sync().pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(capturedA);
        // The walk has captured A, but its index write has not happened yet.
        yield* Effect.promise(() => fs.writeFile(filePath, "version-B-is-longer"));
        const deleting = yield* restarted
          .deletePermanently({ ids: [versionA.id] })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        assert.strictEqual(itemRead.mock.calls.length, 0);
        yield* Deferred.succeed(releaseA, undefined);
        yield* Fiber.join(scanning);
        yield* Fiber.join(deleting);
      } finally {
        yield* Deferred.succeed(releaseA, undefined);
        pathRead.mockRestore();
        itemRead.mockRestore();
      }

      const deletedVersions = (yield* repository.listDeletedMediaIds()).filter(
        (key) => key.startsWith("moss-library-source:v1:") && !previousKeys.has(key),
      );
      assert.strictEqual(deletedVersions.length, 2);
      for (const sourceKey of deletedVersions) {
        // Neither the captured A nor the current B may be written back late.
        yield* repository.upsertItem(versionA, { sourceKey });
        assert.strictEqual((yield* repository.getItemById({ id: versionA.id }))._tag, "None");
      }
      yield* restarted.sync();
      assert.strictEqual((yield* restarted.list({ includeTrashed: true })).items.length, 0);
      assert.strictEqual(
        yield* Effect.promise(() => fs.readFile(filePath, "utf8")),
        "version-B-is-longer",
      );

      yield* Effect.promise(() => fs.writeFile(filePath, "version-C-is-a-new-output"));
      yield* restarted.sync();
      const visible = (yield* restarted.list({})).items;
      assert.strictEqual(visible.length, 1);
      assert.strictEqual(visible[0]?.id, versionA.id);
      assert.strictEqual(visible[0]?.size, Buffer.byteLength("version-C-is-a-new-output"));
    }),
  );

  it.effect("purges trash after the 30-day retention window", () =>
    Effect.gen(function* () {
      yield* resetLibrary;
      yield* Effect.promise(() => writeFile(".codex/attachments/thread-abc/image-1.png"));
      const library = yield* LibraryService;
      yield* library.sync();
      const { items } = yield* library.list({});
      yield* library.trash({ ids: [items[0]!.id] });

      // Still inside the window: a list must not purge.
      clockMs += LIBRARY_TRASH_RETENTION_MS - 1000;
      const { items: stillThere } = yield* library.list({ includeTrashed: true });
      assert.strictEqual(stillThere.length, 1);

      clockMs += 2000;
      const { items: purged } = yield* library.list({ includeTrashed: true });
      assert.strictEqual(purged.length, 0);
      yield* library.sync();
      assert.strictEqual((yield* library.list({ includeTrashed: true })).items.length, 0);
    }),
  );

  it.effect("treats folders as virtual labels over the same files", () =>
    Effect.gen(function* () {
      yield* resetLibrary;
      yield* Effect.promise(() => writeFile(".codex/attachments/thread-abc/image-1.png"));
      const library = yield* LibraryService;
      yield* library.sync();
      const { items } = yield* library.list({});
      const item = items[0]!;

      const { folder } = yield* library.createFolder({ id: "folder-1", title: "参考图" });
      yield* library.move({ ids: [item.id], folderId: folder.id });
      const { items: moved, folders } = yield* library.list({});
      assert.strictEqual(folders.length, 1);
      assert.strictEqual(moved[0]!.folderId, folder.id);

      // A stale destination is refused instead of silently un-filing.
      const stale = yield* Effect.exit(library.move({ ids: [item.id], folderId: "missing" }));
      assert.isTrue(Exit.isFailure(stale));

      // Deleting the folder files children back out; the row and file stay.
      yield* library.deleteFolder({ id: folder.id });
      const { items: filedOut, folders: noFolders } = yield* library.list({});
      assert.strictEqual(noFolders.length, 0);
      assert.strictEqual(filedOut.length, 1);
      assert.strictEqual(filedOut[0]!.folderId, null);
    }),
  );

  it.effect("refuses renames that change the extension", () =>
    Effect.gen(function* () {
      yield* resetLibrary;
      yield* Effect.promise(() => writeFile(".codex/attachments/thread-abc/image-1.png"));
      const library = yield* LibraryService;
      yield* library.sync();
      const { items } = yield* library.list({});
      const item = items[0]!;

      const failed = yield* Effect.flip(library.rename({ id: item.id, title: "image-1.jpg" }));
      assert.strictEqual(failed.code, LIBRARY_RENAME_EXTENSION_ERROR_CODE);
      const { items: unchanged } = yield* library.list({});
      assert.strictEqual(unchanged[0]!.title, "image-1.png");
    }),
  );

  it.effect("registers legacy localStorage items once without clobbering rows", () =>
    Effect.gen(function* () {
      yield* resetLibrary;
      const library = yield* LibraryService;
      const legacy = {
        id: "cli:codex:lovart/landing.png",
        title: "landing.png",
        kind: "image" as const,
        sourceCli: "codex" as const,
        favorite: true,
        updatedAt: 1_700_000_000_000,
      };
      const first = yield* library.register({ items: [legacy] });
      assert.strictEqual(first.items.length, 1);
      assert.strictEqual(first.items[0]!.source, "user:legacy");
      assert.strictEqual(first.items[0]!.path, null);
      assert.strictEqual(first.items[0]!.favorite, true);

      // Re-running the migration keeps the stored row instead of overwriting it.
      yield* library.favorite({ ids: [legacy.id], favorite: false });
      const second = yield* library.register({ items: [legacy] });
      assert.strictEqual(second.items[0]!.favorite, false);
    }),
  );

  it.effect("imports bytes into the Moss import area and indexes them", () =>
    Effect.gen(function* () {
      yield* resetLibrary;
      const library = yield* LibraryService;
      const result = yield* library.importFiles({
        files: [
          { name: "lovart-hero.png", dataBase64: Buffer.from("png-bytes").toString("base64") },
          { name: "../../evil.sh", dataBase64: Buffer.from("echo hi").toString("base64") },
          { name: ".hidden", dataBase64: Buffer.from("x").toString("base64") },
        ],
      });
      assert.strictEqual(result.imported, 2);
      assert.strictEqual(result.skipped, 1);

      const png = result.items.find((item) => item.title === "lovart-hero.png");
      assert.ok(png);
      assert.strictEqual(png.source, "user:import");
      assert.strictEqual(png.kind, "image");
      assert.ok(png.path !== null);
      assert.ok(png.path!.startsWith(path.join(homes.mossHome, "library")));
      // Traversal collapses to the basename inside the import area.
      const shell = result.items.find((item) => item.title === "evil.sh");
      assert.ok(shell?.path?.startsWith(path.join(homes.mossHome, "library")));

      // Permanent delete of an import removes both the row and the copy.
      yield* library.trash({ ids: [png.id] });
      yield* library.deletePermanently({ ids: [png.id] });
      const stat = yield* Effect.promise(() => fs.stat(png.path!).catch(() => null));
      assert.strictEqual(stat, null);
    }),
  );

  it.effect("renames Moss-owned import files on disk with collision-free rows", () =>
    Effect.gen(function* () {
      yield* resetLibrary;
      const library = yield* LibraryService;
      const { items } = yield* library.importFiles({
        files: [{ name: "hero.png", dataBase64: Buffer.from("png").toString("base64") }],
      });
      const item = items[0]!;
      const oldPath = item.path!;

      const renamed = yield* library.rename({ id: item.id, title: "hero-v2.png" });
      assert.strictEqual(renamed.items[0]!.title, "hero-v2.png");
      assert.ok(renamed.items[0]!.path!.endsWith("hero-v2.png"));
      const oldStat = yield* Effect.promise(() => fs.stat(oldPath).catch(() => null));
      assert.strictEqual(oldStat, null);
      const newStat = yield* Effect.promise(() =>
        fs.stat(renamed.items[0]!.path!).catch(() => null),
      );
      assert.ok(newStat !== null);

      // A rescan must not resurrect the old path or duplicate the renamed file.
      const sync = yield* library.sync();
      assert.strictEqual(sync.removed, 0);
      const { items: afterSync } = yield* library.list({});
      assert.strictEqual(afterSync.length, 1);
      assert.strictEqual(afterSync[0]!.title, "hero-v2.png");
    }),
  );

  it.effect("refuses rename traversal without changing files or metadata", () =>
    Effect.gen(function* () {
      yield* resetLibrary;
      const library = yield* LibraryService;
      const { items } = yield* library.importFiles({
        files: [{ name: "safe.png", dataBase64: Buffer.from("original").toString("base64") }],
      });
      const item = items[0]!;
      for (const title of ["../outside.png", "..\\outside.png", "C:outside.png"]) {
        const result = yield* Effect.exit(library.rename({ id: item.id, title }));
        assert.isTrue(Exit.isFailure(result));
      }
      const { items: after } = yield* library.list({});
      assert.strictEqual(after[0]!.title, "safe.png");
      assert.strictEqual(after[0]!.path, item.path);
      assert.strictEqual(yield* Effect.promise(() => fs.readFile(item.path!, "utf8")), "original");
    }),
  );

  it.effect("does not overwrite an existing destination during rename", () =>
    Effect.gen(function* () {
      yield* resetLibrary;
      const library = yield* LibraryService;
      const { items } = yield* library.importFiles({
        files: [{ name: "safe.png", dataBase64: Buffer.from("original").toString("base64") }],
      });
      const item = items[0]!;
      const destination = path.join(path.dirname(item.path!), "existing.png");
      yield* Effect.promise(() => fs.writeFile(destination, "keep-existing", { flag: "wx" }));
      const result = yield* Effect.exit(library.rename({ id: item.id, title: "existing.png" }));
      assert.isTrue(Exit.isFailure(result));
      assert.strictEqual(
        yield* Effect.promise(() => fs.readFile(destination, "utf8")),
        "keep-existing",
      );
      assert.strictEqual(yield* Effect.promise(() => fs.readFile(item.path!, "utf8")), "original");
      const { items: after } = yield* library.list({});
      assert.strictEqual(after[0]!.title, "safe.png");
      assert.strictEqual(after[0]!.path, item.path);
    }),
  );

  it.effect("reports a missing import instead of saving a successful display rename", () =>
    Effect.gen(function* () {
      yield* resetLibrary;
      const library = yield* LibraryService;
      const { items } = yield* library.importFiles({
        files: [{ name: "safe.png", dataBase64: Buffer.from("original").toString("base64") }],
      });
      const item = items[0]!;
      yield* Effect.promise(() => fs.unlink(item.path!));
      const result = yield* Effect.exit(library.rename({ id: item.id, title: "changed.png" }));
      assert.isTrue(Exit.isFailure(result));
      const repository = yield* LibraryRepository;
      const stored = yield* repository.getItemById({ id: item.id });
      assert.strictEqual(stored._tag, "Some");
      if (stored._tag === "Some") assert.strictEqual(stored.value.title, "safe.png");
    }),
  );
});

layer("media library deletion", (it) => {
  it.effect("keeps a deleted generated row deleted when media history is backfilled again", () =>
    Effect.gen(function* () {
      const library = yield* LibraryService;
      const entry = {
        id: "moss-media:fixture:completed:0",
        title: "saved.png",
        kind: "image" as const,
      };
      yield* library.register({ items: [entry] });
      yield* library.favorite({ ids: [entry.id], favorite: true });
      yield* library.register({ items: [entry] });
      assert.strictEqual(
        (yield* library.list({})).items.find((item) => item.id === entry.id)?.favorite,
        true,
      );
      yield* library.trash({ ids: [entry.id] });
      assert.ok(!(yield* library.list({})).items.some((item) => item.id === entry.id));
      yield* library.restore({ ids: [entry.id] });
      assert.ok((yield* library.list({})).items.some((item) => item.id === entry.id));
      yield* library.deletePermanently({ ids: [entry.id] });
      assert.strictEqual((yield* library.register({ items: [entry] })).items.length, 0);
      assert.ok(
        !(yield* library.list({ includeTrashed: true })).items.some((item) => item.id === entry.id),
      );
    }),
  );
});
