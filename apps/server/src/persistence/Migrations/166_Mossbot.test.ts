import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { inspectMigrationBackupPlan } from "../MigrationBackup.ts";
import { runMigrations } from "../Migrations.ts";

// An installed Moss at 165 (main before Mossbot) with an existing hub, its thread and a message.
const released165 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 165 });
  yield* sql`INSERT INTO project_agent_configs (project_id, coordinator_thread_id, coordinator_name, coordinator_model_selection_json, limits_json, capture_enabled, enabled, revision, created_at, updated_at)
    VALUES ('existing-hub', 'hub-thread', '项目协调', '{"provider":"codex","model":"user-model","instanceId":"user-account"}', '{"maxConcurrentWorkers":2}', 1, 1, 7, '2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z')`;
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, kind, created_at, updated_at)
    VALUES ('existing-hub', '项目协调', '/test/hub', '[]', 'group', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`;
  yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, env_mode, created_at, updated_at)
    VALUES ('hub-thread', 'existing-hub', '项目协调', '{"provider":"codex","model":"user-model"}', 'full-access', 'default', 'local', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`;
  yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, source, created_at, updated_at)
    VALUES ('kept-message', 'hub-thread', NULL, 'user', '保留这条消息', 0, 'native', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`;
});

// The client caches prepared statements with their column list, so each read gets its own
// statement text: a `SELECT *` prepared before the ALTER would hide the new column.
let reads = 0;
const snapshot = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const read = (table: string, order: string) =>
    sql.unsafe(`SELECT * FROM ${table} ORDER BY ${order} -- read ${String(reads)}`);
  reads += 1;
  return {
    configs: yield* read("project_agent_configs", "project_id"),
    projects: yield* read("projection_projects", "project_id"),
    threads: yield* read("projection_threads", "thread_id"),
    messages: yield* read("projection_thread_messages", "message_id"),
  };
});

it.layer(NodeSqliteClient.layerMemory())(
  "166 Mossbot upgrade from a released 165 database",
  (it) => {
    it.effect("appends 166 without a backup gate, keeps every row and marks old hubs as hubs", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* released165;
        const before = yield* snapshot;
        const plan = yield* inspectMigrationBackupPlan;
        // An ordinary released prefix: no adoption, so no backup authorization is needed.
        assert.notEqual(plan?.sourceClassification, "mossbot-161-prefix");
        const executed = yield* runMigrations();
        assert.deepStrictEqual(
          executed.map(([id, name]) => [id, name]),
          [
            [166, "Mossbot"],
            [167, "UsageAnalyticsDeletedTokens"],
          ],
        );
        const after = yield* snapshot;
        assert.deepStrictEqual(
          after.configs,
          before.configs.map((row) => ({ ...row, agent_kind: "hub" })),
        );
        assert.deepStrictEqual(after.projects, before.projects);
        assert.deepStrictEqual(after.threads, before.threads);
        assert.deepStrictEqual(after.messages, before.messages);
        assert.deepStrictEqual(
          yield* sql`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id DESC LIMIT 3`,
          [
            { migration_id: 167, name: "UsageAnalyticsDeletedTokens" },
            { migration_id: 166, name: "Mossbot" },
            { migration_id: 165, name: "PageRoomPrivateStores" },
          ],
        );
        // Only the two known kinds are accepted.
        const rejected = yield* Effect.flip(
          sql`UPDATE project_agent_configs SET agent_kind = 'robot' WHERE project_id = 'existing-hub'`,
        );
        assert.equal(rejected._tag, "SqlError");
        assert.deepStrictEqual(yield* sql`SELECT agent_kind FROM project_agent_configs`, [
          { agent_kind: "hub" },
        ]);
      }),
    );

    it.effect(
      "replays 166 idempotently when the tracker row was lost after the column landed",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE project_agent_configs SET agent_kind = 'mossbot' WHERE project_id = 'existing-hub'`;
          const before = yield* snapshot;
          // 166 was the tip when its row was lost; later rows never landed either.
          yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 166`;
          const executed = yield* runMigrations();
          assert.deepStrictEqual(
            executed.map(([id]) => id),
            [166, 167],
          );
          assert.deepStrictEqual(yield* snapshot, before);
          assert.deepStrictEqual(
            yield* sql`SELECT count(*) AS n FROM effect_sql_migrations WHERE migration_id = 166`,
            [{ n: 1 }],
          );
        }),
    );
  },
);
