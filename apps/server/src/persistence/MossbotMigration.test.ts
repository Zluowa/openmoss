import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";
import { MigrationBackupRequiredError } from "./Errors.ts";
import { MigrationBackupAuthorization } from "./MigrationLineage.ts";
import { inspectMigrationBackupPlan } from "./MigrationBackup.ts";
import { runMigrations } from "./Migrations.ts";
import MossbotMigration from "./Migrations/166_Mossbot.ts";

const legacy = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 160 });
  yield* MossbotMigration;
  yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (161, 'Mossbot')`;
  yield* sql`INSERT INTO project_agent_configs (project_id, coordinator_thread_id, coordinator_name, coordinator_model_selection_json, limits_json, capture_enabled, enabled, revision, created_at, updated_at, agent_kind)
    VALUES ('legacy-moss', 'legacy-dm', 'Moss', '{"provider":"codex","model":"user-model","instanceId":"user-account"}', '{}', 1, 1, 3, '2026-11-06T00:00:00Z', '2026-11-06T00:00:00Z', 'mossbot')`;
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, kind, created_at, updated_at)
    VALUES ('legacy-moss', 'Moss', '/test/moss', '[]', 'group', '2026-11-06T00:00:00Z', '2026-11-06T00:00:00Z')`;
  yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, env_mode, created_at, updated_at)
    VALUES ('legacy-dm', 'legacy-moss', 'Moss', '{"provider":"codex","model":"user-model"}', 'full-access', 'default', 'local', '2026-11-06T00:00:00Z', '2026-11-06T00:00:00Z')`;
  yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, source, created_at, updated_at)
    VALUES ('kept-message', 'legacy-dm', NULL, 'assistant', 'Keep this conversation', 0, 'native', '2026-11-06T00:00:00Z', '2026-11-06T00:00:00Z')`;
});

it.layer(NodeSqliteClient.layerMemory())("published Mossbot 161 upgrade", (it) => {
  it.effect(
    "backs up and transactionally adopts the exact branch without changing identity, account or history",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* legacy;
        const before = yield* sql`SELECT * FROM project_agent_configs`;
        const messages = yield* sql`SELECT * FROM projection_thread_messages`;
        const plan = yield* inspectMigrationBackupPlan;
        assert.equal(plan?.sourceClassification, "mossbot-161-prefix");
        assert.equal(plan?.targetVersion, 167);
        const unauthorized = yield* Effect.flip(runMigrations());
        assert.instanceOf(unauthorized, MigrationBackupRequiredError);
        assert.deepStrictEqual(
          yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id = 161`,
          [{ migration_id: 161, name: "Mossbot" }],
        );
        const executed = yield* runMigrations().pipe(
          Effect.provideService(MigrationBackupAuthorization, true),
        );
        assert.deepStrictEqual(
          executed.map(([id]) => id),
          [161, 162, 163, 164, 165, 166, 167],
        );
        assert.deepStrictEqual(yield* sql`SELECT * FROM project_agent_configs`, before);
        const afterMessages =
          yield* sql`SELECT message_id, thread_id, role, text FROM projection_thread_messages`;
        assert.deepStrictEqual(
          afterMessages,
          messages.map(({ message_id, thread_id, role, text }) => ({
            message_id,
            thread_id,
            role,
            text,
          })),
        );
        assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
        assert.deepStrictEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
        assert.deepStrictEqual(yield* runMigrations(), []);
      }),
  );
});

it.layer(NodeSqliteClient.layerMemory())("Mossbot upgrade transaction rollback", (it) => {
  it.effect("retains the legacy tracker and assistant after an interrupted reconciliation", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* legacy;
      const before = yield* sql`SELECT * FROM project_agent_configs`;
      const error = yield* Effect.flip(
        runMigrations({ injectFailureAfterLineageReconciliation: true }).pipe(
          Effect.provideService(MigrationBackupAuthorization, true),
        ),
      );
      assert.match(String(error), /injected failure/);
      assert.deepStrictEqual(
        yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id = 161`,
        [{ migration_id: 161, name: "Mossbot" }],
      );
      assert.deepStrictEqual(yield* sql`SELECT * FROM project_agent_configs`, before);
    }),
  );
});
