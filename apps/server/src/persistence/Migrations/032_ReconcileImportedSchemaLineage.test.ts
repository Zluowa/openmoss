import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationLineageError } from "../Errors.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import ReconcileImportedSchemaLineage from "./032_ReconcileImportedSchemaLineage.ts";

const importedTrackerGuardLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const projectionThreadsColumnNames = (sql: SqlClient.SqlClient) =>
  sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_threads')
  `.pipe(Effect.map((rows) => rows.map((row) => row.name)));

const projectionThreadMessagesColumnNames = (sql: SqlClient.SqlClient) =>
  sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_thread_messages')
  `.pipe(Effect.map((rows) => rows.map((row) => row.name)));

const projectionProjectsColumnNames = (sql: SqlClient.SqlClient) =>
  sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_projects')
  `.pipe(Effect.map((rows) => rows.map((row) => row.name)));

importedTrackerGuardLayer("032_ReconcileImportedSchemaLineage lineage guard", (it) => {
  it.effect("rejects illustrative foreign names before tracker, schema, or data mutation", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 16 });
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
          'thread-unknown-lineage',
          'project-unknown-lineage',
          'Unknown lineage sentinel',
          'feature/unknown-lineage',
          '/tmp/unknown-lineage',
          'turn-unknown-lineage',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          NULL,
          'full-access',
          'default'
        )
      `;

      // These names came from an old illustrative test fixture, not a frozen,
      // fingerprinted release descriptor. Treating only the numeric IDs as
      // trustworthy would turn arbitrary/mixed trackers into writable input.
      const importedMigrationNames: ReadonlyArray<readonly [number, string]> = [
        [17, "ProjectionThreadsArchivedAt"],
        [18, "ProjectionThreadsArchivedAtIndex"],
        [19, "ProjectionSnapshotLookupIndexes"],
        [20, "AuthAccessManagement"],
        [21, "AuthSessionClientMetadata"],
        [22, "AuthSessionLastConnectedAt"],
        [23, "ProjectionThreadShellSummary"],
        [24, "BackfillProjectionThreadShellSummary"],
        [25, "ProjectionThreadsSubagents"],
        [26, "ProjectionThreadShellSummary"],
        [27, "BackfillProjectionThreadShellSummary"],
        [28, "ProjectionProjectsKind"],
        [29, "ProjectionThreadsLastKnownPr"],
        [30, "ProjectionThreadMessagesDispatchMode"],
        [31, "ProjectionThreadsCreateBranchFlowCompleted"],
      ];
      for (const [id, name] of importedMigrationNames) {
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (${id}, ${name})
        `;
      }

      const trackerBefore = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`
        SELECT migration_id, name
        FROM effect_sql_migrations
        ORDER BY migration_id
      `;
      const schemaBefore = yield* sql<{
        readonly type: string;
        readonly name: string;
        readonly definition: string | null;
      }>`
        SELECT type, name, sql AS definition
        FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name
      `;
      const dataBefore = yield* sql`
        SELECT *
        FROM projection_threads
        WHERE thread_id = 'thread-unknown-lineage'
      `;

      const error = yield* Effect.flip(runMigrations({ toMigrationInclusive: 32 }));
      assert.instanceOf(error, MigrationLineageError);
      assert.strictEqual(error.firstDivergedId, 17);
      assert.strictEqual(error.expectedName, "ThreadHandoffMetadata");
      assert.strictEqual(error.recordedName, "ProjectionThreadsArchivedAt");

      const trackerAfter = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`
        SELECT migration_id, name
        FROM effect_sql_migrations
        ORDER BY migration_id
      `;
      const schemaAfter = yield* sql<{
        readonly type: string;
        readonly name: string;
        readonly definition: string | null;
      }>`
        SELECT type, name, sql AS definition
        FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name
      `;
      const dataAfter = yield* sql`
        SELECT *
        FROM projection_threads
        WHERE thread_id = 'thread-unknown-lineage'
      `;
      assert.deepStrictEqual(trackerAfter, trackerBefore);
      assert.deepStrictEqual(schemaAfter, schemaBefore);
      assert.deepStrictEqual(dataAfter, dataBefore);
      assert.notInclude(yield* projectionThreadsColumnNames(sql), "env_mode");
    }),
  );
});

const legacyBodyLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

legacyBodyLayer("032_ReconcileImportedSchemaLineage immutable body", (it) => {
  // Simulates a legacy ~/.moss import where the imported `effect_sql_migrations`
  // schema lacks the columns from migrations 17-31. The strict startup lineage
  // guard above will not adopt an illustrative tracker, but this released body
  // remains immutable and safe to replay for a future exact legacy descriptor.
  it.effect("repairs a legacy-shaped schema idempotently when explicitly replayed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // Bring the schema to where Moss and Moss last agreed.
      yield* runMigrations({ toMigrationInclusive: 16 });

      // Seed a thread row with the Moss-era column set so the data-rewrite
      // branches in #032 have something to operate on.
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
          'thread-legacy',
          'project-legacy',
          'Legacy thread',
          'feature/legacy',
          '/tmp/legacy-worktree',
          'turn-1',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          NULL,
          'full-access',
          'default'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          'message-user-1',
          'thread-legacy',
          'turn-1',
          'user',
          'Please make this change',
          0,
          '2026-01-01T00:00:01.000Z',
          '2026-01-01T00:00:01.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          created_at,
          sequence
        )
        VALUES
          (
            'activity-approval-1',
            'thread-legacy',
            'turn-1',
            'info',
            'approval.requested',
            'Approval requested',
            '{"requestId":"approval-1"}',
            '2026-01-01T00:00:02.000Z',
            1
          ),
          (
            'activity-input-1',
            'thread-legacy',
            'turn-1',
            'info',
            'user-input.requested',
            'User input requested',
            '{"requestId":"input-1"}',
            '2026-01-01T00:00:03.000Z',
            2
          )
      `;
      yield* sql`
        INSERT INTO projection_thread_proposed_plans (
          plan_id,
          thread_id,
          turn_id,
          plan_markdown,
          created_at,
          updated_at,
          implemented_at,
          implementation_thread_id
        )
        VALUES (
          'plan-1',
          'thread-legacy',
          'turn-1',
          '- Do the thing',
          '2026-01-01T00:00:04.000Z',
          '2026-01-01T00:00:04.000Z',
          NULL,
          NULL
        )
      `;

      // Sanity check: env_mode shouldn't exist yet.
      const beforeColumns = yield* projectionThreadsColumnNames(sql);
      assert.notInclude(beforeColumns, "env_mode");

      yield* ReconcileImportedSchemaLineage;
      yield* ReconcileImportedSchemaLineage;

      const afterThreadsColumns = yield* projectionThreadsColumnNames(sql);
      const afterMessagesColumns = yield* projectionThreadMessagesColumnNames(sql);
      const afterProjectsColumns = yield* projectionProjectsColumnNames(sql);

      // #017 + #018 columns
      assert.include(afterThreadsColumns, "handoff_json");
      assert.include(afterMessagesColumns, "source");
      assert.include(afterMessagesColumns, "skills_json");
      assert.include(afterMessagesColumns, "mentions_json");

      // #019 + the columns from #020-#023
      assert.include(afterThreadsColumns, "env_mode");
      assert.include(afterThreadsColumns, "fork_source_thread_id");
      assert.include(afterThreadsColumns, "associated_worktree_path");
      assert.include(afterThreadsColumns, "associated_worktree_branch");
      assert.include(afterThreadsColumns, "associated_worktree_ref");

      // #024-#031 columns can be skipped by the same max-ID gate and must be
      // healed before read-model queries touch them on startup.
      assert.include(afterThreadsColumns, "archived_at");
      assert.include(afterThreadsColumns, "parent_thread_id");
      assert.include(afterThreadsColumns, "subagent_agent_id");
      assert.include(afterThreadsColumns, "subagent_nickname");
      assert.include(afterThreadsColumns, "subagent_role");
      assert.include(afterThreadsColumns, "latest_user_message_at");
      assert.include(afterThreadsColumns, "pending_approval_count");
      assert.include(afterThreadsColumns, "pending_user_input_count");
      assert.include(afterThreadsColumns, "has_actionable_proposed_plan");
      assert.include(afterProjectsColumns, "kind");
      assert.include(afterThreadsColumns, "last_known_pr_json");
      assert.include(afterMessagesColumns, "dispatch_mode");
      assert.include(afterThreadsColumns, "create_branch_flow_completed");

      // Data-rewrite branches: env_mode derived from worktree_path,
      // associated_* mirrored from existing branch / worktree fields.
      const [seeded] = yield* sql<{
        readonly env_mode: string;
        readonly associated_worktree_path: string | null;
        readonly associated_worktree_branch: string | null;
        readonly associated_worktree_ref: string | null;
        readonly latest_user_message_at: string | null;
        readonly pending_approval_count: number;
        readonly pending_user_input_count: number;
        readonly has_actionable_proposed_plan: number;
      }>`
        SELECT
          env_mode,
          associated_worktree_path,
          associated_worktree_branch,
          associated_worktree_ref,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan
        FROM projection_threads
        WHERE thread_id = 'thread-legacy'
      `;
      assert.strictEqual(seeded?.env_mode, "worktree");
      assert.strictEqual(seeded?.associated_worktree_path, "/tmp/legacy-worktree");
      assert.strictEqual(seeded?.associated_worktree_branch, "feature/legacy");
      assert.strictEqual(seeded?.associated_worktree_ref, "feature/legacy");
      assert.strictEqual(seeded?.latest_user_message_at, "2026-01-01T00:00:01.000Z");
      assert.strictEqual(seeded?.pending_approval_count, 1);
      assert.strictEqual(seeded?.pending_user_input_count, 1);
      assert.strictEqual(seeded?.has_actionable_proposed_plan, 1);

      const [pendingApproval] = yield* sql<{ readonly status: string }>`
        SELECT status
        FROM projection_pending_approvals
        WHERE request_id = 'approval-1'
      `;
      assert.strictEqual(pendingApproval?.status, "pending");
    }),
  );
});

const freshInstallLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

freshInstallLayer("032_ReconcileImportedSchemaLineage fresh install", (it) => {
  it.effect("is a no-op on a fresh Moss install", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // Run the entire chain in order, the way a fresh install would.
      yield* runMigrations();

      // Nothing should blow up if we run it again.
      yield* runMigrations();

      const threadsColumns = yield* projectionThreadsColumnNames(sql);
      const messagesColumns = yield* projectionThreadMessagesColumnNames(sql);

      // Columns from the regular in-order runs of 17-23 are still there,
      // confirming #032 didn't try to ADD COLUMN on top of existing ones.
      assert.include(threadsColumns, "env_mode");
      assert.include(threadsColumns, "associated_worktree_ref");
      assert.include(threadsColumns, "create_branch_flow_completed");
      assert.include(messagesColumns, "skills_json");
      assert.include(messagesColumns, "dispatch_mode");
    }),
  );
});
