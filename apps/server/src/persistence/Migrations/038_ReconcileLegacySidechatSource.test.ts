import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationLineageError } from "../Errors.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const projectionThreadsColumnNames = (sql: SqlClient.SqlClient) =>
  sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_threads')
  `.pipe(Effect.map((rows) => rows.map((row) => row.name)));

const foreignTrackerLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

foreignTrackerLayer("038_ReconcileLegacySidechatSource lineage guard", (it) => {
  it.effect("rejects an unfingerprinted foreign migration 33 without mutation", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 32 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          deleted_at,
          runtime_mode,
          interaction_mode
        )
        VALUES (
          'thread-foreign-33',
          'project-foreign-33',
          'Foreign 33 sentinel',
          'feature/foreign-33',
          NULL,
          NULL,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          NULL,
          'full-access',
          'default'
        )
      `;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (33, 'BackfillMissingLiveThreadProjects')
      `;

      const trackerBefore = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      const columnsBefore = yield* projectionThreadsColumnNames(sql);
      const dataBefore = yield* sql`
        SELECT * FROM projection_threads WHERE thread_id = 'thread-foreign-33'
      `;

      const error = yield* Effect.flip(runMigrations({ toMigrationInclusive: 37 }));
      assert.instanceOf(error, MigrationLineageError);
      assert.strictEqual(error.firstDivergedId, 33);
      assert.strictEqual(error.expectedName, "ProjectionThreadsSidechatSource");
      assert.strictEqual(error.recordedName, "BackfillMissingLiveThreadProjects");

      assert.deepStrictEqual(
        yield* sql`
          SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
        `,
        trackerBefore,
      );
      assert.deepStrictEqual(yield* projectionThreadsColumnNames(sql), columnsBefore);
      assert.deepStrictEqual(
        yield* sql`
          SELECT * FROM projection_threads WHERE thread_id = 'thread-foreign-33'
        `,
        dataBefore,
      );
      assert.notInclude(columnsBefore, "sidechat_source_thread_id");
    }),
  );
});

const freshInstallLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

freshInstallLayer("038_ReconcileLegacySidechatSource fresh install", (it) => {
  it.effect("is a no-op when sidechat source already exists", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();
      yield* runMigrations();

      const columns = yield* projectionThreadsColumnNames(sql);
      assert.include(columns, "sidechat_source_thread_id");
    }),
  );
});
