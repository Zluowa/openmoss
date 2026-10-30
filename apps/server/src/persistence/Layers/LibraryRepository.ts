import { LibraryFolder, LibraryItem } from "@synara/contracts";
import { Effect, Layer, Schema, Struct } from "effect";
import * as SchemaGetter from "effect/SchemaGetter";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  LibraryItemByIdInput,
  LibraryItemByPathInput,
  LibraryListExpiredTrashInput,
  LibraryListItemsInput,
  LibraryRepository,
  type LibraryRepositoryShape,
} from "../Services/LibraryRepository.ts";

const SqliteBoolean = Schema.Number.pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((value) => value !== 0),
    encode: SchemaGetter.transform((value) => (value ? 1 : 0)),
  }),
);

const LibraryItemDbRow = LibraryItem.mapFields(
  Struct.assign({
    favorite: SqliteBoolean,
  }),
);

const LIBRARY_ITEM_COLUMNS = `
  item_id AS "id",
  title,
  kind,
  source,
  source_cli AS "sourceCli",
  path,
  mime_type AS "mimeType",
  size,
  favorite,
  folder_id AS "folderId",
  trashed_at AS "trashedAt",
  origination_thread_id AS "originationThreadId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const makeLibraryRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listItemRows = SqlSchema.findAll({
    Request: LibraryListItemsInput,
    Result: LibraryItemDbRow,
    execute: ({ includeTrashed }) =>
      includeTrashed
        ? sql`
            SELECT ${sql.literal(LIBRARY_ITEM_COLUMNS)} FROM library_items
            ORDER BY updated_at DESC, item_id ASC
          `
        : sql`
            SELECT ${sql.literal(LIBRARY_ITEM_COLUMNS)} FROM library_items
            WHERE trashed_at IS NULL
            ORDER BY updated_at DESC, item_id ASC
          `,
  });

  const listExpiredTrashRows = SqlSchema.findAll({
    Request: LibraryListExpiredTrashInput,
    Result: LibraryItemDbRow,
    execute: ({ trashedBefore }) => sql`
      SELECT ${sql.literal(LIBRARY_ITEM_COLUMNS)} FROM library_items
      WHERE trashed_at IS NOT NULL AND trashed_at < ${trashedBefore}
      ORDER BY trashed_at ASC, item_id ASC
    `,
  });

  const getItemByIdRow = SqlSchema.findOneOption({
    Request: LibraryItemByIdInput,
    Result: LibraryItemDbRow,
    execute: ({ id }) => sql`
      SELECT ${sql.literal(LIBRARY_ITEM_COLUMNS)} FROM library_items
      WHERE item_id = ${id}
    `,
  });

  const getItemByPathRow = SqlSchema.findOneOption({
    Request: LibraryItemByPathInput,
    Result: LibraryItemDbRow,
    execute: ({ path }) => sql`
      SELECT ${sql.literal(LIBRARY_ITEM_COLUMNS)} FROM library_items
      WHERE path = ${path}
    `,
  });

  const upsertItemRow = SqlSchema.void({
    Request: LibraryItem,
    execute: (item) => sql`
      INSERT INTO library_items (
        item_id,
        title,
        kind,
        source,
        source_cli,
        path,
        mime_type,
        size,
        favorite,
        folder_id,
        trashed_at,
        origination_thread_id,
        created_at,
        updated_at
      )
      VALUES (
        ${item.id},
        ${item.title},
        ${item.kind},
        ${item.source},
        ${item.sourceCli},
        ${item.path},
        ${item.mimeType},
        ${item.size},
        ${item.favorite ? 1 : 0},
        ${item.folderId},
        ${item.trashedAt},
        ${item.originationThreadId},
        ${item.createdAt},
        ${item.updatedAt}
      )
      ON CONFLICT (item_id) DO UPDATE SET
        title = excluded.title,
        kind = excluded.kind,
        source = excluded.source,
        source_cli = excluded.source_cli,
        path = excluded.path,
        mime_type = excluded.mime_type,
        size = excluded.size,
        favorite = excluded.favorite,
        folder_id = excluded.folder_id,
        trashed_at = excluded.trashed_at,
        origination_thread_id = excluded.origination_thread_id,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
  });

  const deleteItemRow = SqlSchema.void({
    Request: LibraryItemByIdInput,
    execute: ({ id }) => sql`
      DELETE FROM library_items
      WHERE item_id = ${id}
    `,
  });

  const listFolderRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: LibraryFolder,
    execute: () => sql`
      SELECT
        folder_id AS "id",
        title,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM library_folders
      ORDER BY created_at ASC, folder_id ASC
    `,
  });

  const insertFolderRow = SqlSchema.void({
    Request: LibraryFolder,
    execute: (folder) => sql`
      INSERT INTO library_folders (folder_id, title, created_at, updated_at)
      VALUES (${folder.id}, ${folder.title}, ${folder.createdAt}, ${folder.updatedAt})
      ON CONFLICT (folder_id) DO NOTHING
    `,
  });

  const saveFolderRow = SqlSchema.void({
    Request: LibraryFolder,
    execute: (folder) => sql`
      UPDATE library_folders SET
        title = ${folder.title},
        updated_at = ${folder.updatedAt}
      WHERE folder_id = ${folder.id}
    `,
  });

  const deleteFolderRow = SqlSchema.void({
    Request: LibraryItemByIdInput,
    execute: ({ id }) => sql`
      DELETE FROM library_folders
      WHERE folder_id = ${id}
    `,
  });

  const clearFolderMembershipRows = SqlSchema.void({
    Request: LibraryItemByIdInput,
    execute: ({ id }) => sql`
      UPDATE library_items SET folder_id = NULL
      WHERE folder_id = ${id}
    `,
  });

  const listItems: LibraryRepositoryShape["listItems"] = (input) =>
    listItemRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "LibraryRepository.listItems:query",
          "LibraryRepository.listItems:decodeRows",
        ),
      ),
    );

  const listExpiredTrash: LibraryRepositoryShape["listExpiredTrash"] = (input) =>
    listExpiredTrashRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "LibraryRepository.listExpiredTrash:query",
          "LibraryRepository.listExpiredTrash:decodeRows",
        ),
      ),
    );

  const getItemById: LibraryRepositoryShape["getItemById"] = (input) =>
    getItemByIdRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "LibraryRepository.getItemById:query",
          "LibraryRepository.getItemById:decodeRow",
        ),
      ),
    );

  const getItemByPath: LibraryRepositoryShape["getItemByPath"] = (input) =>
    getItemByPathRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "LibraryRepository.getItemByPath:query",
          "LibraryRepository.getItemByPath:decodeRow",
        ),
      ),
    );

  const upsertItem: LibraryRepositoryShape["upsertItem"] = (item, options) => {
    const sourceKey = options?.sourceKey;
    const write = sourceKey
      ? sql.withTransaction(
          Effect.gen(function* () {
            // Serialize this check and write with deleteItem's short transaction.
            // A scan that captured the file before deletion must not revive it.
            const deleted = yield* sql<{ item_id: string }>`
              SELECT item_id FROM library_media_deletions WHERE item_id = ${sourceKey}
            `;
            if (deleted.length === 0) yield* upsertItemRow(item);
          }),
        )
      : upsertItemRow(item);
    return write.pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "LibraryRepository.upsertItem:query",
          "LibraryRepository.upsertItem:encodeRequest",
        ),
      ),
    );
  };

  const deleteItem: LibraryRepositoryShape["deleteItem"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          // The existing text-key ledger also holds namespaced file-version
          // keys. Reconciliation deletes omit sourceKeys; only user deletion
          // and trash expiry persist an intention to hide a retained file.
          for (const sourceKey of input.sourceKeys ?? [])
            yield* sql`INSERT OR IGNORE INTO library_media_deletions(item_id) VALUES (${sourceKey})`;
          if (input.id.startsWith("moss-media:"))
            yield* sql`INSERT OR IGNORE INTO library_media_deletions(item_id) VALUES (${input.id})`;
          yield* deleteItemRow({ id: input.id });
        }),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "LibraryRepository.deleteItem:query",
            "LibraryRepository.deleteItem:encodeRequest",
          ),
        ),
      );

  const listDeletedMediaIds: LibraryRepositoryShape["listDeletedMediaIds"] = () =>
    sql<{ item_id: string }>`SELECT item_id FROM library_media_deletions`.pipe(
      Effect.map((rows) => rows.map((row) => row.item_id)),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "LibraryRepository.listDeletedMediaIds:query",
          "LibraryRepository.listDeletedMediaIds:decodeRows",
        ),
      ),
    );

  const listFolders: LibraryRepositoryShape["listFolders"] = () =>
    listFolderRows().pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "LibraryRepository.listFolders:query",
          "LibraryRepository.listFolders:decodeRows",
        ),
      ),
    );

  const insertFolder: LibraryRepositoryShape["insertFolder"] = (folder) =>
    insertFolderRow(folder).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "LibraryRepository.insertFolder:query",
          "LibraryRepository.insertFolder:encodeRequest",
        ),
      ),
    );

  const saveFolder: LibraryRepositoryShape["saveFolder"] = (folder) =>
    saveFolderRow(folder).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "LibraryRepository.saveFolder:query",
          "LibraryRepository.saveFolder:encodeRequest",
        ),
      ),
    );

  const deleteFolder: LibraryRepositoryShape["deleteFolder"] = (input) =>
    deleteFolderRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "LibraryRepository.deleteFolder:query",
          "LibraryRepository.deleteFolder:encodeRequest",
        ),
      ),
    );

  const clearFolderMembership: LibraryRepositoryShape["clearFolderMembership"] = (input) =>
    clearFolderMembershipRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "LibraryRepository.clearFolderMembership:query",
          "LibraryRepository.clearFolderMembership:encodeRequest",
        ),
      ),
    );

  return {
    listDeletedMediaIds,
    listItems,
    listExpiredTrash,
    getItemById,
    getItemByPath,
    upsertItem,
    deleteItem,
    listFolders,
    insertFolder,
    saveFolder,
    deleteFolder,
    clearFolderMembership,
  } satisfies LibraryRepositoryShape;
});

export const LibraryRepositoryLive = Layer.effect(LibraryRepository, makeLibraryRepository);
