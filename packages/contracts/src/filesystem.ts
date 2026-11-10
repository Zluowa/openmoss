import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";

const FILESYSTEM_PATH_MAX_LENGTH = 512;

export const FilesystemBrowseInput = Schema.Struct({
  partialPath: TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH)),
  cwd: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH))),
});
export type FilesystemBrowseInput = typeof FilesystemBrowseInput.Type;

export const FilesystemBrowseEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  fullPath: TrimmedNonEmptyString,
});
export type FilesystemBrowseEntry = typeof FilesystemBrowseEntry.Type;

export const FilesystemBrowseResult = Schema.Struct({
  parentPath: TrimmedNonEmptyString,
  entries: Schema.Array(FilesystemBrowseEntry),
});
export type FilesystemBrowseResult = typeof FilesystemBrowseResult.Type;

// dialogs.pickFolder: the server raises an OS folder picker on the browser's
// behalf. `path` is null when no folder was chosen. `unavailable` is true when
// the host could not show a picker at all (no picker on this platform, helper
// missing or failed), as opposed to the person cancelling it.
export const DialogsPickFolderResult = Schema.Struct({
  path: Schema.NullOr(TrimmedNonEmptyString),
  unavailable: Schema.optional(Schema.Boolean),
});
export type DialogsPickFolderResult = typeof DialogsPickFolderResult.Type;
