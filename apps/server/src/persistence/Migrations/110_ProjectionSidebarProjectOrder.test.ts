// FILE: 110_ProjectionSidebarProjectOrder.test.ts
// Purpose: Proves the project-order backfill admits only ordinary projects and is idempotent.
// Layer: SQLite migration test

import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import ProjectionSidebarProjectOrderMigration from "./110_ProjectionSidebarProjectOrder.ts";

const seedProjects = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 108 });
  yield* sql`
    INSERT INTO projection_projects (
      project_id, kind, title, workspace_root, scripts_json, created_at, updated_at,
      is_pinned, deleted_at
    ) VALUES
      ('project-custom', 'project', 'Custom', '/workspace/custom', '[]',
        '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z', 0, NULL),
      ('project-default-existing', 'project', 'Existing default', '/workspace/default', '[]',
        '2026-08-31T00:00:01.000Z', '2026-08-31T00:00:01.000Z', 0, NULL),
      ('project-pinned-existing', 'project', 'Existing pinned', '/workspace/pinned', '[]',
        '2026-08-31T00:00:02.000Z', '2026-08-31T00:00:02.000Z', 1, NULL),
      ('project-default-new', 'project', 'New default', '/workspace/new-default', '[]',
        '2026-08-31T00:00:03.000Z', '2026-08-31T00:00:03.000Z', 0, NULL),
      ('project-pinned-new', 'project', 'New pinned', '/workspace/new-pinned', '[]',
        '2026-08-31T00:00:04.000Z', '2026-08-31T00:00:04.000Z', 1, NULL),
      ('project-deleted', 'project', 'Deleted', '/workspace/deleted', '[]',
        '2026-08-31T00:00:05.000Z', '2026-08-31T00:00:05.000Z', 0,
        '2026-08-31T00:00:06.000Z'),
      ('managed-chat', 'chat', 'Chats', '/workspace/chats', '[]',
        '2026-08-31T00:00:07.000Z', '2026-08-31T00:00:07.000Z', 0, NULL),
      ('managed-studio', 'studio', 'Studio', '/workspace/studio', '[]',
        '2026-08-31T00:00:08.000Z', '2026-08-31T00:00:08.000Z', 0, NULL)
  `;
  yield* sql`
    INSERT INTO projection_sidebar_sections (
      section_id, name, sort_order, is_collapsed, created_at, updated_at, deleted_at
    ) VALUES (
      'section-project-order', 'Research', 0, 0,
      '2026-08-31T00:00:00.100Z', '2026-08-31T00:00:00.100Z', NULL
    )
  `;
  yield* sql`
    INSERT INTO projection_sidebar_section_items (
      section_id, item_key, item_type, sort_order, created_at, updated_at
    ) VALUES (
      'section-project-order', 'project:project-custom', 'project', 9,
      '2026-08-31T00:00:00.200Z', '2026-08-31T00:00:00.200Z'
    )
  `;
  yield* runMigrations({ toMigrationInclusive: 109 });
  yield* sql`
    INSERT INTO projection_sidebar_order_items (
      item_key, item_type, destination, section_id, section_created_at,
      sort_order, created_at, updated_at
    ) VALUES
      ('project:project-default-existing', 'project', 'default', NULL, NULL, 3,
        '2026-08-31T00:00:01.000Z', '2026-08-31T00:00:01.000Z'),
      ('project:project-pinned-existing', 'project', 'pinned', NULL, NULL, 7,
        '2026-08-31T00:00:02.000Z', '2026-08-31T00:00:02.000Z')
  `;
});

it.effect(
  "backfills ordinary projects while excluding hidden containers and retaining existing mixed slots",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedProjects;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 110 }), [
        [110, "ProjectionSidebarProjectOrder"],
      ]);

      const rows = yield* sql<{
        readonly itemKey: string;
        readonly destination: string;
        readonly sectionId: string | null;
        readonly sectionCreatedAt: string | null;
        readonly sortOrder: number;
      }>`
        SELECT item_key AS "itemKey", destination,
          section_id AS "sectionId", section_created_at AS "sectionCreatedAt", sort_order AS "sortOrder"
        FROM projection_sidebar_order_items
        ORDER BY CASE destination WHEN 'pinned' THEN 0 WHEN 'default' THEN 1 ELSE 2 END,
          sort_order, item_key
      `;
      assert.deepStrictEqual(rows, [
        {
          itemKey: "project:project-pinned-existing",
          destination: "pinned",
          sectionId: null,
          sectionCreatedAt: null,
          sortOrder: 7,
        },
        {
          itemKey: "project:project-pinned-new",
          destination: "pinned",
          sectionId: null,
          sectionCreatedAt: null,
          sortOrder: 8,
        },
        {
          itemKey: "project:project-default-existing",
          destination: "default",
          sectionId: null,
          sectionCreatedAt: null,
          sortOrder: 3,
        },
        {
          itemKey: "project:project-default-new",
          destination: "default",
          sectionId: null,
          sectionCreatedAt: null,
          sortOrder: 4,
        },
        {
          itemKey: "project:project-custom",
          destination: "custom",
          sectionId: "section-project-order",
          sectionCreatedAt: "2026-08-31T00:00:00.100Z",
          sortOrder: 0,
        },
      ]);

      assert.deepStrictEqual(
        yield* sql<{ readonly count: number; readonly uniqueCount: number }>`
          SELECT COUNT(*) AS count, COUNT(DISTINCT item_key) AS "uniqueCount"
          FROM projection_sidebar_order_items
        `,
        [{ count: 5, uniqueCount: 5 }],
      );
      assert.deepStrictEqual(
        yield* sql<{
          readonly destination: string;
          readonly sectionId: string | null;
          readonly sectionCreatedAt: string | null;
          readonly sortOrder: number;
        }>`
          SELECT destination, section_id AS "sectionId", section_created_at AS "sectionCreatedAt", sort_order AS "sortOrder"
          FROM projection_sidebar_order_items
          GROUP BY destination, section_id, section_created_at, sort_order
          HAVING COUNT(*) > 1
        `,
        [],
      );
      assert.deepStrictEqual(
        yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM projection_sidebar_order_items
          WHERE item_key IN ('project:managed-chat', 'project:managed-studio', 'project:project-deleted')
        `,
        [{ count: 0 }],
      );
      assert.deepStrictEqual(
        yield* sql<{ readonly migrationState: string; readonly revision: number }>`
          SELECT migration_state AS "migrationState", revision
          FROM projection_sidebar_order_state
          WHERE singleton_id = 1
        `,
        [{ migrationState: "legacy_import_required", revision: 0 }],
      );

      // Run the body again after the tracker has recorded it. Every identity and
      // slot must remain unchanged; this also exercises INSERT OR IGNORE directly.
      yield* ProjectionSidebarProjectOrderMigration;
      assert.deepStrictEqual(
        yield* sql<{
          readonly itemKey: string;
          readonly destination: string;
          readonly sortOrder: number;
        }>`
          SELECT item_key AS "itemKey", destination, sort_order AS "sortOrder"
          FROM projection_sidebar_order_items
          ORDER BY CASE destination WHEN 'pinned' THEN 0 WHEN 'default' THEN 1 ELSE 2 END,
            sort_order, item_key
        `,
        rows.map(({ itemKey, destination, sortOrder }) => ({ itemKey, destination, sortOrder })),
      );
      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 110 }), []);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
