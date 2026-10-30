import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema, Struct } from "effect";
import * as SchemaGetter from "effect/SchemaGetter";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionSidebarSectionItemInput,
  GetProjectionSidebarSectionInput,
  ProjectionSidebarSection,
  ProjectionSidebarSectionItem,
  ProjectionSidebarSectionRepository,
  type ProjectionSidebarSectionRepositoryShape,
  UpsertProjectionSidebarSectionItemInput,
} from "../Services/ProjectionSidebarSections.ts";

const SqliteBoolean = Schema.Number.pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((value) => value !== 0),
    encode: SchemaGetter.transform((value) => (value ? 1 : 0)),
  }),
);

const ProjectionSidebarSectionDbRow = ProjectionSidebarSection.mapFields(
  Struct.assign({
    isCollapsed: SqliteBoolean,
    items: Schema.fromJsonString(Schema.Array(ProjectionSidebarSectionItem)),
  }),
);
type ProjectionSidebarSectionDbRow = typeof ProjectionSidebarSectionDbRow.Type;

const makeProjectionSidebarSectionRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertSectionRow = SqlSchema.void({
    Request: ProjectionSidebarSection,
    execute: (row) => sql`
      INSERT INTO projection_sidebar_sections (
        section_id, name, sort_order, is_collapsed, created_at, updated_at, deleted_at
      ) VALUES (
        ${row.sectionId}, ${row.name}, ${row.sortOrder}, ${row.isCollapsed ? 1 : 0},
        ${row.createdAt}, ${row.updatedAt}, ${row.deletedAt}
      )
      ON CONFLICT (section_id) DO UPDATE SET
        name = excluded.name,
        sort_order = excluded.sort_order,
        is_collapsed = excluded.is_collapsed,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        deleted_at = excluded.deleted_at
    `,
  });

  const getSectionRow = SqlSchema.findOneOption({
    Request: GetProjectionSidebarSectionInput,
    Result: ProjectionSidebarSectionDbRow,
    execute: ({ sectionId }) => sql`
      SELECT
        section_id AS "sectionId",
        name,
        sort_order AS "sortOrder",
        is_collapsed AS "isCollapsed",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        deleted_at AS "deletedAt",
        json('[]') AS items
      FROM projection_sidebar_sections
      WHERE section_id = ${sectionId}
        AND deleted_at IS NULL
    `,
  });

  const listSectionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionSidebarSectionDbRow,
    execute: () => sql`
      SELECT
        section_id AS "sectionId",
        name,
        sort_order AS "sortOrder",
        is_collapsed AS "isCollapsed",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        deleted_at AS "deletedAt",
        json('[]') AS items
      FROM projection_sidebar_sections
      WHERE deleted_at IS NULL
      ORDER BY sort_order ASC, section_id ASC
    `,
  });

  const listItemRows = SqlSchema.findAll({
    Request: GetProjectionSidebarSectionInput,
    Result: ProjectionSidebarSectionItem,
    execute: ({ sectionId }) => sql`
      SELECT
        section_id AS "sectionId",
        item_key AS "itemKey",
        item_type AS "itemType",
        sort_order AS "sortOrder",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_sidebar_section_items
      WHERE section_id = ${sectionId}
      ORDER BY sort_order ASC, item_key ASC
    `,
  });

  const upsertItemRow = SqlSchema.void({
    Request: UpsertProjectionSidebarSectionItemInput,
    execute: (row) => sql`
      INSERT INTO projection_sidebar_section_items (
        section_id, item_key, item_type, sort_order, created_at, updated_at
      ) VALUES (
        ${row.sectionId}, ${row.itemKey}, ${row.itemType},
        ${row.sortOrder}, ${row.createdAt}, ${row.updatedAt}
      )
      ON CONFLICT (item_key) DO UPDATE SET
        section_id = excluded.section_id,
        item_type = excluded.item_type,
        sort_order = excluded.sort_order,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
  });

  const deleteItemRow = SqlSchema.void({
    Request: DeleteProjectionSidebarSectionItemInput,
    execute: ({ itemKey }) => sql`
      DELETE FROM projection_sidebar_section_items
      WHERE item_key = ${itemKey}
    `,
  });

  const replaceItems: ProjectionSidebarSectionRepositoryShape["replaceItems"] = (input) =>
    Effect.gen(function* () {
      yield* sql`
        DELETE FROM projection_sidebar_section_items
        WHERE section_id = ${input.sectionId}
      `;
      for (const item of input.items) {
        yield* upsertItemRow(item);
      }
    }).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionSidebarSectionRepository.replaceItems")),
    );

  const deleteSectionRow = SqlSchema.void({
    Request: GetProjectionSidebarSectionInput,
    execute: ({ sectionId }) =>
      sql`
      DELETE FROM projection_sidebar_section_items
      WHERE section_id = ${sectionId}
    `.pipe(
        Effect.flatMap(
          () =>
            sql`
          DELETE FROM projection_sidebar_sections
          WHERE section_id = ${sectionId}
        `,
        ),
      ),
  });

  const upsertSection: ProjectionSidebarSectionRepositoryShape["upsertSection"] = (row) =>
    upsertSectionRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionSidebarSectionRepository.upsertSection")),
    );

  const getById: ProjectionSidebarSectionRepositoryShape["getById"] = (input) =>
    getSectionRow(input).pipe(
      Effect.flatMap((section) =>
        Option.match(section, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            listItemRows(input).pipe(
              Effect.map((items) =>
                Option.some({
                  ...row,
                  items,
                }),
              ),
            ),
        }),
      ),
      Effect.mapError(toPersistenceSqlError("ProjectionSidebarSectionRepository.getById")),
    );

  const listAll: ProjectionSidebarSectionRepositoryShape["listAll"] = () =>
    listSectionRows().pipe(
      Effect.flatMap((sections) =>
        Effect.forEach(sections, (section) =>
          listItemRows({ sectionId: section.sectionId }).pipe(
            Effect.map((items) => ({ ...section, items })),
          ),
        ),
      ),
      Effect.mapError(toPersistenceSqlError("ProjectionSidebarSectionRepository.listAll")),
    );

  const upsertItem: ProjectionSidebarSectionRepositoryShape["upsertItem"] = (row) =>
    upsertItemRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionSidebarSectionRepository.upsertItem")),
    );

  const deleteItem: ProjectionSidebarSectionRepositoryShape["deleteItem"] = (input) =>
    deleteItemRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionSidebarSectionRepository.deleteItem")),
    );

  const deleteSection: ProjectionSidebarSectionRepositoryShape["deleteSection"] = (input) =>
    deleteSectionRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionSidebarSectionRepository.deleteSection")),
    );

  return {
    upsertSection,
    getById,
    listAll,
    upsertItem,
    deleteItem,
    replaceItems,
    deleteSection,
  } satisfies ProjectionSidebarSectionRepositoryShape;
});

export const ProjectionSidebarSectionRepositoryLive = Layer.effect(
  ProjectionSidebarSectionRepository,
  makeProjectionSidebarSectionRepository,
);
