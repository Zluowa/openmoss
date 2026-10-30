import { Schema } from "effect";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas";

// Moss 资料库 (Library): local multi-agent file index. Codex's cloud library is
// mapped to local data roots (codex attachments / generated images, claude
// downloads / file-history, and the user import area under ~/.moss/library).
// Agent source files are read-only; deletes are a two-stage DB trash, and
// permanent deletes only remove Moss-owned copies plus the index row.

/** Codex library_file_category equivalent, inferred locally from MIME/extension. */
export const LibraryItemKind = Schema.Literals(["image", "video", "archive", "document", "other"]);
export type LibraryItemKind = typeof LibraryItemKind.Type;

/** agent × artifact-type source dimension (Codex's uploaded/generated split). */
export const LibrarySource = Schema.Literals([
  "codex:attachment",
  "codex:generated",
  "claude:downloads",
  "claude:file-history",
  "user:import",
  // Metadata-only rows migrated from the pre-index localStorage catalog
  // (files only exist in the ChatGPT cloud library; nothing local to scan).
  "user:legacy",
]);
export type LibrarySource = typeof LibrarySource.Type;

export const LibrarySourceCli = Schema.Literals(["codex", "claude", "moss", "other"]);
export type LibrarySourceCli = typeof LibrarySourceCli.Type;

const LibraryIsoDateTime = IsoDateTime.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/),
);

export const LibraryItem = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  kind: LibraryItemKind,
  source: LibrarySource,
  sourceCli: LibrarySourceCli,
  /** Absolute path; null for metadata-only rows whose file is not local. */
  path: Schema.NullOr(Schema.String),
  mimeType: Schema.NullOr(Schema.String),
  size: Schema.Number,
  favorite: Schema.Boolean,
  folderId: Schema.NullOr(Schema.String),
  trashedAt: Schema.NullOr(LibraryIsoDateTime),
  /** Codex origination_thread_id equivalent (attachment/generation thread). */
  originationThreadId: Schema.NullOr(Schema.String),
  createdAt: LibraryIsoDateTime,
  updatedAt: LibraryIsoDateTime,
  /** Authenticated local media preview; projected from this account's saved job. */
  mediaJobId: Schema.optional(Schema.String),
  mediaImageIndex: Schema.optional(Schema.Number),
  previewPath: Schema.optional(Schema.String),
});
export type LibraryItem = typeof LibraryItem.Type;

/** Virtual folder — a DB label only; files never move on disk. */
export const LibraryFolder = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  createdAt: LibraryIsoDateTime,
  updatedAt: LibraryIsoDateTime,
});
export type LibraryFolder = typeof LibraryFolder.Type;

export const LibraryListInput = Schema.Struct({
  includeTrashed: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
});
export type LibraryListInput = typeof LibraryListInput.Type;

export const LibraryListResult = Schema.Struct({
  items: Schema.Array(LibraryItem),
  folders: Schema.Array(LibraryFolder),
});
export type LibraryListResult = typeof LibraryListResult.Type;

/** Rescan all configured roots and reconcile the index with the filesystem. */
export const LibrarySyncResult = Schema.Struct({
  scanned: Schema.Number,
  upserted: Schema.Number,
  removed: Schema.Number,
});
export type LibrarySyncResult = typeof LibrarySyncResult.Type;

export const LibraryItemsResult = Schema.Struct({
  items: Schema.Array(LibraryItem),
});
export type LibraryItemsResult = typeof LibraryItemsResult.Type;

export const LibraryFavoriteInput = Schema.Struct({
  ids: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
  favorite: Schema.Boolean,
});
export type LibraryFavoriteInput = typeof LibraryFavoriteInput.Type;

export const LibraryMoveInput = Schema.Struct({
  ids: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
  folderId: Schema.NullOr(TrimmedNonEmptyString),
});
export type LibraryMoveInput = typeof LibraryMoveInput.Type;

/** Rename keeps the extension — the server refuses a title that changes it. */
export const LibraryRenameInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
});
export type LibraryRenameInput = typeof LibraryRenameInput.Type;

const LibraryIdsInput = Schema.Struct({
  ids: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
});

export const LibraryTrashInput = LibraryIdsInput;
export type LibraryTrashInput = typeof LibraryTrashInput.Type;

export const LibraryRestoreInput = LibraryIdsInput;
export type LibraryRestoreInput = typeof LibraryRestoreInput.Type;

/** Permanent delete: rows go; files are removed only under the Moss import root. */
export const LibraryDeleteInput = LibraryIdsInput;
export type LibraryDeleteInput = typeof LibraryDeleteInput.Type;

export const LibraryCreateFolderInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString.check(
    // Codex rule: a folder name must not start with ".".
    Schema.makeFilter((value) => !value.startsWith("."), {
      title: "LibraryFolderName",
      description: "Folder names must not start with a dot.",
    }),
  ),
});
export type LibraryCreateFolderInput = typeof LibraryCreateFolderInput.Type;

export const LibraryRenameFolderInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
});
export type LibraryRenameFolderInput = typeof LibraryRenameFolderInput.Type;

export const LibraryDeleteFolderInput = Schema.Struct({
  id: TrimmedNonEmptyString,
});
export type LibraryDeleteFolderInput = typeof LibraryDeleteFolderInput.Type;

export const LibraryFolderResult = Schema.Struct({
  folder: LibraryFolder,
});
export type LibraryFolderResult = typeof LibraryFolderResult.Type;

/**
 * One-time migration of the legacy localStorage catalog (Lovart-era cloud items
 * with no local file). Server upserts metadata-only rows by id.
 */
export const LibraryRegisterItem = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  kind: Schema.optional(LibraryItemKind),
  sourceCli: Schema.optional(LibrarySourceCli),
  path: Schema.optional(Schema.String),
  mimeType: Schema.optional(Schema.String),
  favorite: Schema.optional(Schema.Boolean),
  folderId: Schema.optional(Schema.NullOr(Schema.String)),
  /** Milliseconds epoch from the legacy store. */
  updatedAt: Schema.optional(Schema.Number),
});
export type LibraryRegisterItem = typeof LibraryRegisterItem.Type;

export const LibraryRegisterInput = Schema.Struct({
  items: Schema.Array(LibraryRegisterItem).check(Schema.isMinLength(1)),
});
export type LibraryRegisterInput = typeof LibraryRegisterInput.Type;

/**
 * Drag/drop + 从 ChatGPT 资料库导入 upload: the client reads picked files and
 * streams their bytes; the server copies them under ~/.moss/library/ and
 * indexes them as user:import.
 */
export const LIBRARY_IMPORT_FILE_MAX_BYTES = 64 * 1024 * 1024;

export const LibraryImportFile = Schema.Struct({
  name: TrimmedNonEmptyString.check(
    Schema.makeFilter((value) => !value.startsWith("."), {
      title: "LibraryImportFileName",
      description: "File names must not start with a dot.",
    }),
  ),
  mimeType: Schema.optional(Schema.String),
  dataBase64: Schema.String,
});
export type LibraryImportFile = typeof LibraryImportFile.Type;

export const LibraryImportInput = Schema.Struct({
  files: Schema.Array(LibraryImportFile).check(Schema.isMinLength(1)),
});
export type LibraryImportInput = typeof LibraryImportInput.Type;

export const LibraryImportResult = Schema.Struct({
  items: Schema.Array(LibraryItem),
  imported: Schema.Number,
  skipped: Schema.Number,
});
export type LibraryImportResult = typeof LibraryImportResult.Type;

/** WsRpcError code when a rename tries to change a file extension. */
export const LIBRARY_RENAME_EXTENSION_ERROR_CODE = "LIBRARY_RENAME_EXTENSION";
