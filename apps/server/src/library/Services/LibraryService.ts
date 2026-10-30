import type {
  LibraryCreateFolderInput,
  LibraryDeleteFolderInput,
  LibraryDeleteInput,
  LibraryFavoriteInput,
  LibraryFolderResult,
  LibraryImportInput,
  LibraryImportResult,
  LibraryItemsResult,
  LibraryListInput,
  LibraryListResult,
  LibraryMoveInput,
  LibraryRegisterInput,
  LibraryRenameFolderInput,
  LibraryRenameInput,
  LibraryRestoreInput,
  LibrarySyncResult,
  LibraryTrashInput,
} from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { LibraryServiceError } from "../Errors.ts";

export interface LibraryServiceShape {
  readonly list: (input: LibraryListInput) => Effect.Effect<LibraryListResult, LibraryServiceError>;
  /** Full rescan of every existing root, reconciling rows with the filesystem. */
  readonly sync: () => Effect.Effect<LibrarySyncResult, LibraryServiceError>;
  readonly favorite: (
    input: LibraryFavoriteInput,
  ) => Effect.Effect<LibraryItemsResult, LibraryServiceError>;
  readonly move: (
    input: LibraryMoveInput,
  ) => Effect.Effect<LibraryItemsResult, LibraryServiceError>;
  readonly rename: (
    input: LibraryRenameInput,
  ) => Effect.Effect<LibraryItemsResult, LibraryServiceError>;
  readonly trash: (
    input: LibraryTrashInput,
  ) => Effect.Effect<LibraryItemsResult, LibraryServiceError>;
  readonly restore: (
    input: LibraryRestoreInput,
  ) => Effect.Effect<LibraryItemsResult, LibraryServiceError>;
  /** Permanent delete: rows always go; files only under the Moss import root. */
  readonly deletePermanently: (
    input: LibraryDeleteInput,
  ) => Effect.Effect<LibraryItemsResult, LibraryServiceError>;
  readonly createFolder: (
    input: LibraryCreateFolderInput,
  ) => Effect.Effect<LibraryFolderResult, LibraryServiceError>;
  readonly renameFolder: (
    input: LibraryRenameFolderInput,
  ) => Effect.Effect<LibraryFolderResult, LibraryServiceError>;
  readonly deleteFolder: (
    input: LibraryDeleteFolderInput,
  ) => Effect.Effect<void, LibraryServiceError>;
  /** One-time legacy localStorage migration: metadata-only upserts by id. */
  readonly register: (
    input: LibraryRegisterInput,
  ) => Effect.Effect<LibraryItemsResult, LibraryServiceError>;
  /** Copy uploaded bytes into the Moss import area and index them. */
  readonly importFiles: (
    input: LibraryImportInput,
  ) => Effect.Effect<LibraryImportResult, LibraryServiceError>;
}

export class LibraryService extends ServiceMap.Service<LibraryService, LibraryServiceShape>()(
  "moss/library/Services/LibraryService",
) {}
