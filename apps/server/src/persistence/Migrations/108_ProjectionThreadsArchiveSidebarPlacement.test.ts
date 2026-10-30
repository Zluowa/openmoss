import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.effect("adds archive provenance columns and backfills only proven cohorts", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 107 });

    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, runtime_mode, interaction_mode, env_mode,
        created_at, updated_at, archived_at, deleted_at
      ) VALUES
        ('legacy-proven', 'project-108', 'Legacy proven', 'auto', 'default', 'local',
          '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z',
          '2026-08-31T00:00:01.000Z', NULL),
        ('legacy-null', 'project-108', 'Legacy null', 'auto', 'default', 'local',
          '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z',
          '2026-08-31T00:00:01.000Z', NULL),
        ('legacy-rearchived-null', 'project-108', 'Legacy rearchived null', 'auto', 'default', 'local',
          '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z',
          '2026-08-31T00:00:03.000Z', NULL)
    `;
    yield* sql`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, command_id, actor_kind, payload_json, metadata_json
      ) VALUES
        ('event-108-proven', 'thread', 'legacy-proven', 1, 'thread.archived',
          '2026-08-31T00:00:01.000Z', 'archive-command-108', 'server',
          '{"threadId":"legacy-proven","archivedAt":"2026-08-31T00:00:01.000Z"}', '{}'),
        ('event-108-null', 'thread', 'legacy-null', 1, 'thread.archived',
          '2026-08-31T00:00:01.000Z', NULL, 'server',
          '{"threadId":"legacy-null","archivedAt":"2026-08-31T00:00:01.000Z"}', '{}'),
        ('event-108-rearchived-old', 'thread', 'legacy-rearchived-null', 1, 'thread.archived',
          '2026-08-31T00:00:01.000Z', 'archive-old-108', 'server',
          '{"threadId":"legacy-rearchived-null","archivedAt":"2026-08-31T00:00:01.000Z"}', '{}'),
        ('event-108-rearchived-new', 'thread', 'legacy-rearchived-null', 2, 'thread.archived',
          '2026-08-31T00:00:03.000Z', NULL, 'server',
          '{"threadId":"legacy-rearchived-null","archivedAt":"2026-08-31T00:00:03.000Z"}', '{}')
    `;

    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 108 }), [
      [108, "ProjectionThreadsArchiveSidebarPlacement"],
    ]);

    const columns = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info('projection_threads')
      WHERE name IN (
        'archived_by_command_id', 'archived_sidebar_section_id',
        'archived_sidebar_section_created_at', 'archived_sidebar_sort_order'
      )
      ORDER BY name
    `;
    assert.deepStrictEqual(
      columns.map((column) => column.name),
      [
        "archived_by_command_id",
        "archived_sidebar_section_created_at",
        "archived_sidebar_section_id",
        "archived_sidebar_sort_order",
      ],
    );

    const rows = yield* sql<{
      readonly threadId: string;
      readonly archivedByCommandId: string | null;
      readonly archivedSidebarSectionId: string | null;
      readonly archivedSidebarSortOrder: number | null;
    }>`
      SELECT
        thread_id AS "threadId",
        archived_by_command_id AS "archivedByCommandId",
        archived_sidebar_section_id AS "archivedSidebarSectionId",
        archived_sidebar_sort_order AS "archivedSidebarSortOrder"
      FROM projection_threads
      ORDER BY thread_id
    `;
    assert.deepStrictEqual(rows, [
      {
        threadId: "legacy-null",
        archivedByCommandId: null,
        archivedSidebarSectionId: null,
        archivedSidebarSortOrder: null,
      },
      {
        threadId: "legacy-proven",
        archivedByCommandId: "archive-command-108",
        archivedSidebarSectionId: null,
        archivedSidebarSortOrder: null,
      },
      {
        threadId: "legacy-rearchived-null",
        archivedByCommandId: null,
        archivedSidebarSectionId: null,
        archivedSidebarSortOrder: null,
      },
    ]);

    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 108 }), []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
