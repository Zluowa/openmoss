/**
 * Durable storage for the Moss 资料库 local index.
 *
 * The repository only persists rows; the library service owns ids, timestamps,
 * trash semantics, filesystem reconciliation, and import copies.
 */
import { LibraryFolder, LibraryItem } from "@synara/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect, Option } from "effect";

import type { LibraryRepositoryError } from "../Errors.ts";

export const LibraryItemByIdInput = Schema.Struct({
  id: Schema.String,
});
export type LibraryItemByIdInput = typeof LibraryItemByIdInput.Type;

export const LibraryItemByPathInput = Schema.Struct({
  path: Schema.String,
});
export type LibraryItemByPathInput = typeof LibraryItemByPathInput.Type;

export const LibraryListItemsInput = Schema.Struct({
  includeTrashed: Schema.Boolean,
});
export type LibraryListItemsInput = typeof LibraryListItemsInput.Type;

export const LibraryListExpiredTrashInput = Schema.Struct({
  /** ISO instant; rows trashed before it are due for permanent deletion. */
  trashedBefore: Schema.String,
});
export type LibraryListExpiredTrashInput = typeof LibraryListExpiredTrashInput.Type;

export interface LibraryRepositoryShape {
  readonly listItems: (
    input: LibraryListItemsInput,
  ) => Effect.Effect<ReadonlyArray<LibraryItem>, LibraryRepositoryError>;
  readonly listExpiredTrash: (
    input: LibraryListExpiredTrashInput,
  ) => Effect.Effect<ReadonlyArray<LibraryItem>, LibraryRepositoryError>;
  readonly getItemById: (
    input: LibraryItemByIdInput,
  ) => Effect.Effect<Option.Option<LibraryItem>, LibraryRepositoryError>;
  readonly getItemByPath: (
    input: LibraryItemByPathInput,
  ) => Effect.Effect<Option.Option<LibraryItem>, LibraryRepositoryError>;
  /** Scans provide a source key so a late scan cannot undo permanent deletion. */
  readonly upsertItem: (
    item: LibraryItem,
    options?: { readonly sourceKey: string },
  ) => Effect.Effect<void, LibraryRepositoryError>;
  /** Source keys record explicit permanent deletion of indexed/current file versions. */
  readonly deleteItem: (
    input: LibraryItemByIdInput & { readonly sourceKeys?: readonly string[] },
  ) => Effect.Effect<void, LibraryRepositoryError>;
  /** Includes media ids and namespaced scanned-source keys in the existing deletion ledger. */
  readonly listDeletedMediaIds: () => Effect.Effect<ReadonlyArray<string>, LibraryRepositoryError>;
  readonly listFolders: () => Effect.Effect<ReadonlyArray<LibraryFolder>, LibraryRepositoryError>;
  readonly insertFolder: (folder: LibraryFolder) => Effect.Effect<void, LibraryRepositoryError>;
  readonly saveFolder: (folder: LibraryFolder) => Effect.Effect<void, LibraryRepositoryError>;
  readonly deleteFolder: (
    input: LibraryItemByIdInput,
  ) => Effect.Effect<void, LibraryRepositoryError>;
  /** Files children out of a folder (virtual folders never touch the disk). */
  readonly clearFolderMembership: (
    input: LibraryItemByIdInput,
  ) => Effect.Effect<void, LibraryRepositoryError>;
}

export class LibraryRepository extends ServiceMap.Service<
  LibraryRepository,
  LibraryRepositoryShape
>()("moss/persistence/Services/LibraryRepository") {}
