import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ProjectionSidebarArchivePlacement,
  ProjectionSidebarOrderRepository,
  ProjectionSidebarOrderState,
  type ProjectionSidebarOrderRepositoryShape,
  UpsertProjectionSidebarArchivePlacementInput,
} from "../Services/ProjectionSidebarOrder.ts";
import { OrchestrationSidebarOrderItem } from "@synara/contracts";

const GetStateRequest = Schema.Struct({});

const makeProjectionSidebarOrderRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getStateRow = SqlSchema.findOne({
    Request: GetStateRequest,
    Result: ProjectionSidebarOrderState,
    execute: () => sql`
      SELECT revision, migration_state AS "migrationState", updated_at AS "updatedAt"
      FROM projection_sidebar_order_state
      WHERE singleton_id = 1
    `,
  });

  const listItemRows = SqlSchema.findAll({
    Request: GetStateRequest,
    Result: OrchestrationSidebarOrderItem,
    execute: () => sql`
      SELECT
        item_key AS "key",
        item_type AS "itemType",
        destination,
        section_id AS "sectionId",
        section_created_at AS "sectionCreatedAt",
        sort_order AS "sortOrder",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_sidebar_order_items
      ORDER BY destination ASC, section_id ASC, section_created_at ASC,
               sort_order ASC, item_key ASC
    `,
  });

  const insertItemRow = SqlSchema.void({
    Request: OrchestrationSidebarOrderItem,
    execute: (item) => sql`
      INSERT INTO projection_sidebar_order_items (
        item_key, item_type, destination, section_id, section_created_at,
        sort_order, created_at, updated_at
      ) VALUES (
        ${item.key}, ${item.itemType}, ${item.destination}, ${item.sectionId},
        ${item.sectionCreatedAt}, ${item.sortOrder}, ${item.createdAt}, ${item.updatedAt}
      )
      ON CONFLICT (item_key) DO UPDATE SET
        item_type = excluded.item_type,
        destination = excluded.destination,
        section_id = excluded.section_id,
        section_created_at = excluded.section_created_at,
        sort_order = excluded.sort_order,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
  });

  const updateStateRow = SqlSchema.void({
    Request: ProjectionSidebarOrderState,
    execute: (state) => sql`
      INSERT INTO projection_sidebar_order_state (
        singleton_id, revision, migration_state, updated_at
      ) VALUES (1, ${state.revision}, ${state.migrationState}, ${state.updatedAt})
      ON CONFLICT (singleton_id) DO UPDATE SET
        revision = excluded.revision,
        migration_state = excluded.migration_state,
        updated_at = excluded.updated_at
    `,
  });

  const getArchivePlacementRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: Schema.String }),
    Result: ProjectionSidebarArchivePlacement,
    execute: ({ threadId }) => sql`
      SELECT
        thread_id AS "threadId",
        destination,
        section_id AS "sectionId",
        section_created_at AS "sectionCreatedAt",
        sort_order AS "sortOrder",
        archived_by_command_id AS "archivedByCommandId",
        updated_at AS "updatedAt"
      FROM projection_sidebar_archive_placements
      WHERE thread_id = ${threadId}
    `,
  });

  const upsertArchivePlacementRow = SqlSchema.void({
    Request: UpsertProjectionSidebarArchivePlacementInput,
    execute: (placement) => sql`
      INSERT INTO projection_sidebar_archive_placements (
        thread_id, destination, section_id, section_created_at, sort_order,
        archived_by_command_id, updated_at
      ) VALUES (
        ${placement.threadId}, ${placement.destination}, ${placement.sectionId},
        ${placement.sectionCreatedAt}, ${placement.sortOrder},
        ${placement.archivedByCommandId}, ${placement.updatedAt}
      )
      ON CONFLICT (thread_id) DO UPDATE SET
        destination = excluded.destination,
        section_id = excluded.section_id,
        section_created_at = excluded.section_created_at,
        sort_order = excluded.sort_order,
        archived_by_command_id = excluded.archived_by_command_id,
        updated_at = excluded.updated_at
    `,
  });

  const getState: ProjectionSidebarOrderRepositoryShape["getState"] = () =>
    getStateRow({}).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionSidebarOrderRepository.getState")),
    );

  const listAll: ProjectionSidebarOrderRepositoryShape["listAll"] = () =>
    listItemRows({}).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionSidebarOrderRepository.listAll")),
    );

  const replaceAll: ProjectionSidebarOrderRepositoryShape["replaceAll"] = (input) =>
    Effect.gen(function* () {
      yield* sql`DELETE FROM projection_sidebar_order_items`;
      for (const item of input.items) yield* insertItemRow(item);
      yield* updateStateRow({
        revision: input.revision,
        migrationState: input.migrationState,
        updatedAt: input.updatedAt,
      });
    }).pipe(Effect.mapError(toPersistenceSqlError("ProjectionSidebarOrderRepository.replaceAll")));

  const compareAndSwap: ProjectionSidebarOrderRepositoryShape["compareAndSwap"] = (input) =>
    Effect.gen(function* () {
      const updated = yield* sql<{ readonly revision: number }>`
        UPDATE projection_sidebar_order_state
        SET revision = ${input.nextRevision},
            migration_state = ${input.migrationState},
            updated_at = ${input.updatedAt}
        WHERE singleton_id = 1 AND revision = ${input.expectedRevision}
        RETURNING revision
      `;
      if (updated.length === 0) return false;
      yield* sql`DELETE FROM projection_sidebar_order_items`;
      for (const item of input.items) yield* insertItemRow(item);
      return true;
    }).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionSidebarOrderRepository.compareAndSwap")),
    );

  const upsertItem: ProjectionSidebarOrderRepositoryShape["upsertItem"] = (item) =>
    insertItemRow(item).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionSidebarOrderRepository.upsertItem")),
    );

  const deleteItem: ProjectionSidebarOrderRepositoryShape["deleteItem"] = ({ itemKey }) =>
    sql`DELETE FROM projection_sidebar_order_items WHERE item_key = ${itemKey}`.pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionSidebarOrderRepository.deleteItem")),
      Effect.asVoid,
    );

  const getArchivePlacement: ProjectionSidebarOrderRepositoryShape["getArchivePlacement"] = ({
    threadId,
  }) =>
    getArchivePlacementRow({ threadId }).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionSidebarOrderRepository.getArchivePlacement"),
      ),
    );

  const upsertArchivePlacement: ProjectionSidebarOrderRepositoryShape["upsertArchivePlacement"] = (
    placement,
  ) =>
    upsertArchivePlacementRow(placement).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionSidebarOrderRepository.upsertArchivePlacement"),
      ),
    );

  const deleteArchivePlacement: ProjectionSidebarOrderRepositoryShape["deleteArchivePlacement"] = ({
    threadId,
  }) =>
    sql`DELETE FROM projection_sidebar_archive_placements WHERE thread_id = ${threadId}`.pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionSidebarOrderRepository.deleteArchivePlacement"),
      ),
      Effect.asVoid,
    );

  return {
    getState,
    listAll,
    replaceAll,
    compareAndSwap,
    upsertItem,
    deleteItem,
    getArchivePlacement,
    upsertArchivePlacement,
    deleteArchivePlacement,
  } satisfies ProjectionSidebarOrderRepositoryShape;
});

export const ProjectionSidebarOrderRepositoryLive = Layer.effect(
  ProjectionSidebarOrderRepository,
  makeProjectionSidebarOrderRepository,
);
