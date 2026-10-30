import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.effect("copies legacy custom slots and seeds one durable order authority", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 108 });
    yield* sql`
      INSERT INTO projection_projects (
        project_id, kind, title, workspace_root, scripts_json, created_at, updated_at
      ) VALUES ('project-109', 'project', 'B03f', '/workspace/b03f', '[]',
        '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z')
    `;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, runtime_mode, interaction_mode, env_mode,
        created_at, updated_at, parent_thread_id, is_pinned, archived_at
      ) VALUES
        ('thread-custom', 'project-109', 'Custom', 'auto', 'default', 'local',
          '2026-08-31T00:00:01.000Z', '2026-08-31T00:00:01.000Z', NULL, 0, NULL),
        ('thread-pinned', 'project-109', 'Pinned', 'auto', 'default', 'local',
          '2026-08-31T00:00:02.000Z', '2026-08-31T00:00:02.000Z', NULL, 1, NULL),
        ('thread-child', 'project-109', 'Child', 'auto', 'default', 'local',
          '2026-08-31T00:00:03.000Z', '2026-08-31T00:00:03.000Z', 'thread-custom', 0, NULL),
        ('thread-archived', 'project-109', 'Archived', 'auto', 'default', 'local',
          '2026-08-31T00:00:04.000Z', '2026-08-31T00:00:04.000Z', NULL, 0,
          '2026-08-31T00:00:05.000Z')
    `;
    yield* sql`
      INSERT INTO projection_sidebar_sections (
        section_id, name, sort_order, is_collapsed, created_at, updated_at, deleted_at
      ) VALUES ('section-109', 'Research', 0, 0,
        '2026-08-31T00:00:00.500Z', '2026-08-31T00:00:00.500Z', NULL)
    `;
    yield* sql`
      INSERT INTO projection_sidebar_section_items (
        section_id, item_key, item_type, sort_order, created_at, updated_at
      ) VALUES
        ('section-109', 'project:project-109', 'project', 0,
          '2026-08-31T00:00:00.600Z', '2026-08-31T00:00:00.600Z'),
        ('section-109', 'thread:thread-custom', 'thread', 8,
          '2026-08-31T00:00:00.700Z', '2026-08-31T00:00:00.700Z')
    `;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, runtime_mode, interaction_mode, env_mode,
        created_at, updated_at, archived_at, archived_sidebar_section_id,
        archived_sidebar_section_created_at, archived_sidebar_sort_order,
        archived_by_command_id
      ) VALUES ('thread-archive-custom', 'project-109', 'Archive custom', 'auto', 'default', 'local',
        '2026-08-31T00:00:06.000Z', '2026-08-31T00:00:06.000Z',
        '2026-08-31T00:00:07.000Z', 'section-109', '2026-08-31T00:00:00.500Z', 2, 'archive-109')
    `;

    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 109 }), [
      [109, "ProjectionSidebarThreadOrder"],
    ]);
    const items = yield* sql<{
      readonly itemKey: string;
      readonly itemType: string;
      readonly destination: string;
      readonly sectionId: string | null;
      readonly sectionCreatedAt: string | null;
      readonly sortOrder: number;
    }>`
      SELECT item_key AS "itemKey", item_type AS "itemType", destination,
        section_id AS "sectionId", section_created_at AS "sectionCreatedAt", sort_order AS "sortOrder"
      FROM projection_sidebar_order_items
      ORDER BY item_key
    `;
    assert.deepStrictEqual(items, [
      {
        itemKey: "project:project-109",
        itemType: "project",
        destination: "custom",
        sectionId: "section-109",
        sectionCreatedAt: "2026-08-31T00:00:00.500Z",
        sortOrder: 0,
      },
      {
        itemKey: "thread:thread-custom",
        itemType: "thread",
        destination: "custom",
        sectionId: "section-109",
        sectionCreatedAt: "2026-08-31T00:00:00.500Z",
        sortOrder: 1,
      },
      {
        itemKey: "thread:thread-pinned",
        itemType: "thread",
        destination: "pinned",
        sectionId: null,
        sectionCreatedAt: null,
        sortOrder: 0,
      },
    ]);
    const archive = yield* sql<{
      readonly destination: string;
      readonly sectionId: string | null;
      readonly sectionCreatedAt: string | null;
      readonly sortOrder: number;
    }>`
      SELECT destination, section_id AS "sectionId", section_created_at AS "sectionCreatedAt", sort_order AS "sortOrder"
      FROM projection_sidebar_archive_placements
      WHERE thread_id = 'thread-archive-custom'
    `;
    assert.deepStrictEqual(archive, [
      {
        destination: "custom",
        sectionId: "section-109",
        sectionCreatedAt: "2026-08-31T00:00:00.500Z",
        sortOrder: 2,
      },
    ]);
    const [destination] = yield* sql<{ readonly value: string | null }>`
      SELECT archived_sidebar_destination AS value
      FROM projection_threads
      WHERE thread_id = 'thread-archive-custom'
    `;
    assert.strictEqual(destination?.value, "custom");
    const [state] = yield* sql<{ readonly migrationState: string }>`
      SELECT migration_state AS "migrationState"
      FROM projection_sidebar_order_state
      WHERE singleton_id = 1
    `;
    assert.strictEqual(state?.migrationState, "legacy_import_required");
    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 109 }), []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("keeps a default-only active profile behind the complete legacy import", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 108 });
    yield* sql`
      INSERT INTO projection_projects (
        project_id, kind, title, workspace_root, scripts_json, created_at, updated_at
      ) VALUES ('project-default-only', 'project', 'Default only', '/workspace/default-only', '[]',
        '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z')
    `;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, runtime_mode, interaction_mode, env_mode,
        created_at, updated_at, parent_thread_id, is_pinned, archived_at
      ) VALUES ('thread-default-only', 'project-default-only', 'Default only', 'auto', 'default', 'local',
        '2026-08-31T00:00:01.000Z', '2026-08-31T00:00:01.000Z', NULL, 0, NULL)
    `;
    yield* runMigrations({ toMigrationInclusive: 109 });
    const [state] = yield* sql<{ readonly migrationState: string }>`
      SELECT migration_state AS "migrationState"
      FROM projection_sidebar_order_state
      WHERE singleton_id = 1
    `;
    assert.strictEqual(state?.migrationState, "legacy_import_required");
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("marks a genuinely empty profile ready and enforces one slot per container", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 109 });
    const [state] = yield* sql<{ readonly migrationState: string }>`
      SELECT migration_state AS "migrationState"
      FROM projection_sidebar_order_state
      WHERE singleton_id = 1
    `;
    assert.strictEqual(state?.migrationState, "ready");
    yield* sql`
      INSERT INTO projection_sidebar_order_items (
        item_key, item_type, destination, section_id, section_created_at,
        sort_order, created_at, updated_at
      ) VALUES ('thread:slot-a', 'thread', 'default', NULL, NULL, 0,
        '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z')
    `;
    const duplicate = yield* Effect.result(sql`
      INSERT INTO projection_sidebar_order_items (
        item_key, item_type, destination, section_id, section_created_at,
        sort_order, created_at, updated_at
      ) VALUES ('thread:slot-b', 'thread', 'default', NULL, NULL, 0,
        '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z')
    `);
    assert.strictEqual(duplicate._tag, "Failure");
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
