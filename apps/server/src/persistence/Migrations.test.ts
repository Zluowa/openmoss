import { assert, it } from "@effect/vitest";
import { createHash } from "node:crypto";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import WorkspaceInitializationMigration from "./Migrations/133_ProjectionTurnsWorkspaceInitialization.ts";
import ForkSourceMessageMigration from "./Migrations/134_ProjectionThreadsForkSourceMessage.ts";
import { migrationEntries, runMigrations } from "./Migrations.ts";
import {
  MigrationBackupRequiredError,
  MigrationLineageError,
  MigrationSchemaTooNewError,
} from "./Errors.ts";
import { MigrationBackupAuthorization } from "./MigrationLineage.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";
import BackfillThreadActivitySequenceMigration from "./Migrations/053_BackfillThreadActivitySequence.ts";
import ReservedDurableProviderCommandDeliveryMigration from "./Migrations/054_ReservedDurableProviderCommandDelivery.ts";
import ManagedAttachmentsMigration from "./Migrations/055_ManagedAttachments.ts";
import CommandReceiptFingerprintsMigration from "./Migrations/056_CommandReceiptFingerprints.ts";
import ThreadScopedProjectionMessageIdentityMigration from "./Migrations/057_ThreadScopedProjectionMessageIdentity.ts";
import ThreadScopedPendingApprovalIdentityMigration from "./Migrations/058_ThreadScopedPendingApprovalIdentity.ts";
import ProviderSessionLifecycleGenerationMigration from "./Migrations/059_ProviderSessionLifecycleGeneration.ts";
import PendingApprovalLifecycleGenerationMigration from "./Migrations/060_PendingApprovalLifecycleGeneration.ts";
import PendingApprovalSettlementStateMigration from "./Migrations/061_PendingApprovalSettlementState.ts";
import PendingInteractionSettlementParityMigration from "./Migrations/062_PendingInteractionSettlementParity.ts";
import ProjectionMessageCausalSequenceMigration from "./Migrations/063_ProjectionMessageCausalSequence.ts";
import DurableProviderCommandDeliveryMigration from "./Migrations/064_DurableProviderCommandDelivery.ts";
import DurableQueuedTurnPromotionsMigration from "./Migrations/065_DurableQueuedTurnPromotions.ts";
import DurableProviderRuntimeEventsMigration from "./Migrations/066_DurableProviderRuntimeEvents.ts";
import ProviderDeliveryReconciliationMigration from "./Migrations/067_ProviderDeliveryReconciliation.ts";
import GitHandoffOperationsMigration from "./Migrations/068_GitHandoffOperations.ts";
import PullRequestAutoFixMigration from "./Migrations/130_PullRequestAutoFix.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const trackerRows = (sql: SqlClient.SqlClient) =>
  sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id ASC
  `;

const projectionThreadsColumnNames = (sql: SqlClient.SqlClient) =>
  sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_threads')
  `.pipe(Effect.map((rows) => rows.map((row) => row.name)));

const tableColumnNames = (sql: SqlClient.SqlClient, tableName: string) =>
  sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info(${tableName})
  `.pipe(Effect.map((rows) => rows.map((row) => row.name)));

const tableIndexNames = (sql: SqlClient.SqlClient, tableName: string) =>
  sql<{ readonly name: string }>`
    SELECT name FROM pragma_index_list(${tableName})
  `.pipe(Effect.map((rows) => rows.map((row) => row.name)));

it.effect("registers realtime handoff message persistence after sidebar migrations", () =>
  Effect.gen(function* () {
    const latest = migrationEntries.find(([id]) => id === 113);
    assert.deepStrictEqual(latest?.slice(0, 2), [113, "ProjectionThreadMessageRealtimeHandoffId"]);
    const projectSidebarOrder = migrationEntries.find(([id]) => id === 110);
    assert.deepStrictEqual(projectSidebarOrder?.slice(0, 2), [
      110,
      "ProjectionSidebarProjectOrder",
    ]);
    assert.equal(migrationEntries.filter(([id]) => id === 110).length, 1);
  }),
);

it.effect("appends upstream cursor invalidation without reusing Moss migration 99", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(migrationEntries.find(([id]) => id === 99)?.slice(0, 2), [
      99,
      "RecoverRetentionHiddenThreads",
    ]);
    assert.deepStrictEqual(migrationEntries.find(([id]) => id === 142)?.slice(0, 2), [
      142,
      "ProjectSourceFolders",
    ]);
    assert.deepStrictEqual(migrationEntries.find(([id]) => id === 147)?.slice(0, 2), [
      147,
      "ProjectionMessageTurnActivityIndex",
    ]);
    assert.deepStrictEqual(migrationEntries.find(([id]) => id === 148)?.slice(0, 2), [
      148,
      "Pages",
    ]);
    assert.deepStrictEqual(migrationEntries.find(([id]) => id === 149)?.slice(0, 2), [
      149,
      "AutomationCreateRequests",
    ]);
    assert.deepStrictEqual(migrationEntries.at(-1)?.slice(0, 2), [150, "GuestShares"]);
    assert.equal(new Set(migrationEntries.map(([id]) => id)).size, migrationEntries.length);
  }),
);

// Frozen tracker mapping from upstream/main@69304bc1d. The fixture schema is
// sanity-checked before Moss touches it, so a future migration-body edit cannot
// silently change what these legacy import cases exercise.
const upstreamLegacyMigrationEntries = [
  [53, "BackfillThreadActivitySequence", BackfillThreadActivitySequenceMigration],
  [54, "DurableProviderCommandDelivery", ReservedDurableProviderCommandDeliveryMigration],
  [55, "ManagedAttachments", ManagedAttachmentsMigration],
  [56, "CommandReceiptFingerprints", CommandReceiptFingerprintsMigration],
  [57, "ThreadScopedProjectionMessageIdentity", ThreadScopedProjectionMessageIdentityMigration],
  [58, "ThreadScopedPendingApprovalIdentity", ThreadScopedPendingApprovalIdentityMigration],
  [59, "ProviderSessionLifecycleGeneration", ProviderSessionLifecycleGenerationMigration],
  [60, "PendingApprovalLifecycleGeneration", PendingApprovalLifecycleGenerationMigration],
  [61, "PendingApprovalSettlementState", PendingApprovalSettlementStateMigration],
  [62, "PendingInteractionSettlementParity", PendingInteractionSettlementParityMigration],
  [63, "ProjectionMessageCausalSequence", ProjectionMessageCausalSequenceMigration],
  [64, "DurableProviderCommandDeliveryCutover", DurableProviderCommandDeliveryMigration],
  [65, "DurableQueuedTurnPromotions", DurableQueuedTurnPromotionsMigration],
  [66, "DurableProviderRuntimeEvents", DurableProviderRuntimeEventsMigration],
  [67, "ProviderDeliveryReconciliation", ProviderDeliveryReconciliationMigration],
  [68, "GitHandoffOperations", GitHandoffOperationsMigration],
] as const;

const applyUpstreamLegacyMigrationRange = (
  sql: SqlClient.SqlClient,
  fromMigrationExclusive: number,
  toMigrationInclusive: number,
) =>
  Effect.gen(function* () {
    for (const [id, name, migration] of upstreamLegacyMigrationEntries) {
      if (id <= fromMigrationExclusive || id > toMigrationInclusive) {
        continue;
      }
      yield* migration;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${id}, ${name})
      `;
    }
  });

const expectedCanonicalReplayFrom53 = migrationEntries
  .filter(([id]) => id >= 53)
  .map(([id, name]) => [id, name] as const);

const assertCanonicalTracker = (rows: ReadonlyArray<{ migration_id: number; name: string }>) =>
  assert.deepStrictEqual(
    rows.map((row) => [row.migration_id, row.name]),
    migrationEntries.map(([id, name]) => [id, name]),
  );

const upstreamOwnedSchemaSnapshot = (sql: SqlClient.SqlClient) =>
  sql<{
    readonly type: string;
    readonly name: string;
    readonly tableName: string;
    readonly definition: string | null;
  }>`
    SELECT
      type,
      name,
      tbl_name AS "tableName",
      replace(sql, ' IF NOT EXISTS', '') AS definition
    FROM sqlite_master
    WHERE tbl_name IN (
      'orchestration_command_receipts',
      'projection_thread_messages',
      'projection_pending_interactions',
      'managed_attachment_blobs',
      'managed_attachment_cleanup_jobs',
      'orchestration_consumer_state',
      'orchestration_event_deliveries',
      'queued_turn_promotions',
      'provider_runtime_events',
      'provider_runtime_open_turns',
      'provider_runtime_event_consumers',
      'provider_delivery_reconciliations',
      'git_handoff_operations'
    )
    ORDER BY type, name
  `;

const upstream56SchemaSnapshot = (sql: SqlClient.SqlClient) =>
  sql<{
    readonly type: string;
    readonly name: string;
    readonly tableName: string;
    readonly definition: string | null;
  }>`
    SELECT
      type,
      name,
      tbl_name AS "tableName",
      replace(sql, ' IF NOT EXISTS', '') AS definition
    FROM sqlite_master
    WHERE tbl_name IN (
      'orchestration_command_receipts',
      'managed_attachment_blobs',
      'managed_attachment_cleanup_jobs'
    )
    ORDER BY type, name
  `;

const schemaSnapshotDigest = (snapshot: ReadonlyArray<unknown>) =>
  createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");

const UPSTREAM_69304_SCHEMA_DIGESTS = {
  through56: "1eae14a30c72db66ae6e3731a538bd92ceaff608ab3ffd1568be7ab1782b2058",
  through68: "f02e70d405fea1cbf1e3cf77a47ae42f0282ca150b16cbd2dca8c9d35f53cca2",
} as const;

const upstream68DataSnapshot = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const receipts = yield* sql`
      SELECT command_id AS "commandId", fingerprint_version AS "fingerprintVersion",
        command_fingerprint AS "commandFingerprint"
      FROM orchestration_command_receipts
      WHERE command_id = 'command-upstream-68'
    `;
    const attachments = yield* sql`
      SELECT attachment_id AS "attachmentId", owner_thread_id AS "ownerThreadId",
        state, size_bytes AS "sizeBytes", sha256, relative_path AS "relativePath"
      FROM managed_attachment_blobs
      WHERE attachment_id = 'attachment-upstream-68'
    `;
    const cleanupJobs = yield* sql`
      SELECT attachment_id AS "attachmentId", reason, attempt_count AS "attemptCount",
        next_attempt_at AS "nextAttemptAt", lease_owner AS "leaseOwner",
        lease_expires_at AS "leaseExpiresAt", last_error AS "lastError",
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM managed_attachment_cleanup_jobs
      WHERE attachment_id = 'attachment-upstream-68'
    `;
    const messages = yield* sql`
      SELECT message_id AS "messageId", thread_id AS "threadId", text, sequence
      FROM projection_thread_messages
      WHERE message_id = 'message-upstream-68'
      ORDER BY thread_id
    `;
    const interactions = yield* sql`
      SELECT interaction_kind AS "interactionKind", request_id AS "requestId",
        thread_id AS "threadId", lifecycle_generation AS "lifecycleGeneration",
        status, decision, response_command_id AS "responseCommandId",
        response_requested_at AS "responseRequestedAt"
      FROM projection_pending_interactions
      WHERE thread_id = 'thread-upstream-68'
      ORDER BY interaction_kind, request_id
    `;
    const projectionState = yield* sql`
      SELECT projector, last_applied_sequence AS "lastAppliedSequence", updated_at AS "updatedAt"
      FROM projection_state
      WHERE projector = 'projection.pending-approvals'
    `;
    const runtime = yield* sql`
      SELECT thread_id AS "threadId", provider_name AS "providerName",
        lifecycle_generation AS "lifecycleGeneration", status,
        runtime_payload_json AS "runtimePayloadJson"
      FROM provider_session_runtime
      WHERE thread_id = 'thread-upstream-68'
    `;
    const deliveryConsumer = yield* sql`
      SELECT consumer_name AS "consumerName", last_acked_sequence AS "lastAckedSequence",
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM orchestration_consumer_state
      WHERE consumer_name = 'provider-command-reactor.v1'
    `;
    const deliveries = yield* sql`
      SELECT consumer_name AS "consumerName", event_sequence AS "eventSequence",
        thread_id AS "threadId", state, attempt_count AS "attemptCount",
        last_error AS "lastError", updated_at AS "updatedAt"
      FROM orchestration_event_deliveries
      WHERE thread_id = 'thread-upstream-68'
    `;
    const promotions = yield* sql`
      SELECT queued_event_sequence AS "queuedEventSequence", thread_id AS "threadId",
        message_id AS "messageId", dispatch_mode AS "dispatchMode", state,
        attempt_count AS "attemptCount", updated_at AS "updatedAt"
      FROM queued_turn_promotions
      WHERE thread_id = 'thread-upstream-68'
    `;
    const runtimeEvents = yield* sql`
      SELECT event_id AS "eventId", thread_id AS "threadId", turn_id AS "turnId",
        lifecycle_generation AS "lifecycleGeneration", event_type AS "eventType",
        event_json AS "eventJson", persisted_at AS "persistedAt"
      FROM provider_runtime_events
      WHERE thread_id = 'thread-upstream-68'
    `;
    const runtimeConsumers = yield* sql`
      SELECT consumer_name AS "consumerName", last_acked_sequence AS "lastAckedSequence",
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM provider_runtime_event_consumers
    `;
    const openTurns = yield* sql`
      SELECT thread_id AS "threadId", turn_id AS "turnId",
        first_sequence AS "firstSequence", updated_at AS "updatedAt"
      FROM provider_runtime_open_turns
      WHERE thread_id = 'thread-upstream-68'
    `;
    const reconciliations = yield* sql`
      SELECT reconciliation_id AS "reconciliationId", consumer_name AS "consumerName",
        event_sequence AS "eventSequence", thread_id AS "threadId", previous_state AS "previousState",
        outcome, reconciled_by AS "reconciledBy", note, reconciled_at AS "reconciledAt"
      FROM provider_delivery_reconciliations
      WHERE thread_id = 'thread-upstream-68'
    `;
    const handoffs = yield* sql`
      SELECT command_id AS "commandId", thread_id AS "threadId", input_json AS "inputJson",
        phase, result_json AS "resultJson", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM git_handoff_operations
      WHERE thread_id = 'thread-upstream-68'
    `;

    return {
      receipts,
      attachments,
      cleanupJobs,
      messages,
      interactions,
      projectionState,
      runtime,
      deliveryConsumer,
      deliveries,
      promotions,
      runtimeEvents,
      runtimeConsumers,
      openTurns,
      reconciliations,
      handoffs,
    };
  });

layer("Library migration restarts", (it) => {
  it.effect("reopens a current Library database without restoring or replaying data", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
        VALUES ('saved-image-thread', 'project', 'Existing image conversation', '2026-10-14T05:47:00.000Z', '2026-10-14T05:47:00.000Z')`;
      yield* sql`INSERT INTO library_media_deletions(item_id) VALUES ('moss-media:scope:moss_saved:0')`;
      const before = yield* trackerRows(sql);
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* trackerRows(sql), before);
      assert.deepStrictEqual(
        yield* sql`SELECT title FROM projection_threads WHERE thread_id = 'saved-image-thread'`,
        [{ title: "Existing image conversation" }],
      );
      assert.deepStrictEqual(yield* sql`SELECT item_id FROM library_media_deletions`, [
        { item_id: "moss-media:scope:moss_saved:0" },
      ]);
    }),
  );
});

layer("reconcileMigrationLineage", (it) => {
  it.effect("rejects an unknown imported tracker before mutation", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 16 });
      const latestMossId = Math.max(...migrationEntries.map(([id]) => id));
      for (let id = 17; id <= latestMossId + 3; id += 1) {
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (${id}, ${`ForeignMigration${id}`})
        `;
      }
      const before = yield* trackerRows(sql);
      const error = yield* Effect.flip(runMigrations());
      assert.instanceOf(error, MigrationLineageError);
      assert.strictEqual(error._tag, "MigrationLineageError");
      assert.deepStrictEqual(yield* trackerRows(sql), before);

      // Restore the shared fixture for the remaining cases in this layer.
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 17`;
      yield* runMigrations();
    }),
  );

  it.effect(
    "adds workspace classification without changing existing turns or erasing it on replay",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 132 });
        yield* sql`INSERT INTO projection_turns (thread_id, turn_id, state, requested_at, checkpoint_files_json)
        VALUES ('old-workspace-thread', 'old-workspace-turn', 'completed', '2026-10-10T10:00:00.000Z', '[]')`;
        yield* runMigrations();
        const read = () => sql<{
          state: string;
          marker: number;
        }>`SELECT state, started_without_git_workspace AS marker
        FROM projection_turns WHERE turn_id = 'old-workspace-turn'`;
        assert.deepStrictEqual(yield* read(), [{ state: "completed", marker: 0 }]);
        yield* sql`UPDATE projection_turns SET started_without_git_workspace = 1 WHERE turn_id = 'old-workspace-turn'`;
        yield* WorkspaceInitializationMigration;
        assert.deepStrictEqual(yield* read(), [{ state: "completed", marker: 1 }]);
      }),
  );

  it.effect(
    "adds a nullable fork cutoff without modifying legacy threads or clearing it on replay",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 133 });
        yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
        VALUES ('legacy-fork', 'project', 'Keep this', '2026-10-10T10:00:00.000Z', '2026-10-10T10:00:00.000Z')`;
        yield* runMigrations();
        const read = () => sql<{
          title: string;
          cutoff: string | null;
        }>`SELECT title, fork_source_message_id AS cutoff
        FROM projection_threads WHERE thread_id = 'legacy-fork'`;
        assert.deepStrictEqual(yield* read(), [{ title: "Keep this", cutoff: null }]);
        yield* sql`UPDATE projection_threads SET fork_source_message_id = 'chosen-message' WHERE thread_id = 'legacy-fork'`;
        yield* ForkSourceMessageMigration;
        assert.deepStrictEqual(yield* read(), [{ title: "Keep this", cutoff: "chosen-message" }]);
      }),
  );

  it.effect("leaves a healthy tracker alone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(
        (yield* trackerRows(sql)).map((row) => [row.migration_id, row.name]),
        migrationEntries.map(([id, name]) => [id, name]),
      );
    }),
  );

  it.effect("rejects a non-canonical migration 32 without renaming it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        UPDATE effect_sql_migrations
        SET name = 'PreviousMigration32Name'
        WHERE migration_id = 32
      `;
      const before = yield* trackerRows(sql);
      const error = yield* Effect.flip(runMigrations());
      assert.instanceOf(error, MigrationLineageError);
      assert.strictEqual(error._tag, "MigrationLineageError");
      assert.deepStrictEqual(yield* trackerRows(sql), before);
      yield* sql`
        UPDATE effect_sql_migrations
        SET name = 'ReconcileImportedSchemaLineage'
        WHERE migration_id = 32
      `;
    }),
  );

  it.effect("refuses writable migration startup for a newer Moss schema", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const futureId = Math.max(...migrationEntries.map(([id]) => id)) + 1;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${futureId}, 'FutureMossMigration')
      `;
      const before = yield* trackerRows(sql);
      const error = yield* Effect.flip(runMigrations());
      assert.instanceOf(error, MigrationSchemaTooNewError);
      assert.strictEqual(error.databaseMigrationId, futureId);
      assert.strictEqual(error.latestSupportedMigrationId, futureId - 1);
      assert.deepStrictEqual(yield* trackerRows(sql), before);
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = ${futureId}`;
    }),
  );

  it.effect("refuses a mixed name anywhere in the canonical prefix", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        UPDATE effect_sql_migrations
        SET name = 'NotAKnownLineage'
        WHERE migration_id = 5
      `;
      const before = yield* trackerRows(sql);
      const error = yield* Effect.flip(runMigrations());
      assert.instanceOf(error, MigrationLineageError);
      assert.strictEqual(error._tag, "MigrationLineageError");
      assert.deepStrictEqual(yield* trackerRows(sql), before);
      yield* sql`
        UPDATE effect_sql_migrations
        SET name = 'Projections'
        WHERE migration_id = 5
      `;
    }),
  );

  it.effect("continues when provider instance columns were partially migrated", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 48 });
      const now = new Date().toISOString();
      yield* sql`
        ALTER TABLE projection_thread_sessions
        ADD COLUMN provider_instance_id TEXT
      `;
      yield* sql`
        ALTER TABLE provider_session_runtime
        ADD COLUMN provider_instance_id TEXT
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          env_mode,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-codex-work',
          'project-provider-instance',
          'Work Account Thread',
          ${JSON.stringify({ instanceId: "codex_work", model: "gpt-5.4" })},
          'full-access',
          'default',
          'local',
          ${now},
          ${now},
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_instance_id,
          runtime_mode,
          active_turn_id,
          last_error,
          updated_at
        )
        VALUES
          (
            'thread-codex-work',
            'running',
            'codex',
            NULL,
            'full-access',
            NULL,
            NULL,
            ${now}
          ),
          (
            'thread-no-model-selection',
            'running',
            'codex',
            NULL,
            'full-access',
            NULL,
            NULL,
            ${now}
          )
      `;
      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id,
          provider_name,
          provider_instance_id,
          adapter_key,
          runtime_mode,
          status,
          last_seen_at,
          resume_cursor_json,
          runtime_payload_json
        )
        VALUES
          (
            'thread-codex-work',
            'codex',
            NULL,
            'codex',
            'full-access',
            'running',
            ${now},
            NULL,
            ${JSON.stringify({ modelSelection: { instanceId: "codex_bound", model: "gpt-5.4" } })}
          ),
          (
            'runtime-codex-work',
            'codex',
            NULL,
            'codex',
            'full-access',
            'running',
            ${now},
            NULL,
            ${JSON.stringify({ modelSelection: { instanceId: "codex_work", model: "gpt-5.4" } })}
          ),
          (
            'runtime-no-instance',
            'codex',
            NULL,
            'codex',
            'full-access',
            'running',
            ${now},
            NULL,
            ${JSON.stringify({})}
          )
      `;

      const executed = yield* runMigrations({ toMigrationInclusive: 55 });
      assert.deepStrictEqual(
        executed.map(([id]) => id),
        [49, 50, 51, 52, 53, 54, 55],
      );

      const projectionSessionColumns = yield* tableColumnNames(sql, "projection_thread_sessions");
      const runtimeColumns = yield* tableColumnNames(sql, "provider_session_runtime");
      assert.include(projectionSessionColumns, "provider_instance_id");
      assert.include(runtimeColumns, "provider_instance_id");

      const projectionSessionIndexes = yield* tableIndexNames(sql, "projection_thread_sessions");
      const runtimeIndexes = yield* tableIndexNames(sql, "provider_session_runtime");
      assert.include(projectionSessionIndexes, "idx_projection_thread_sessions_provider_instance");
      assert.include(runtimeIndexes, "idx_provider_session_runtime_provider_instance");

      const projectionRows = yield* sql<{
        readonly threadId: string;
        readonly providerInstanceId: string | null;
      }>`
        SELECT
          thread_id AS "threadId",
          provider_instance_id AS "providerInstanceId"
        FROM projection_thread_sessions
        WHERE thread_id IN ('thread-codex-work', 'thread-no-model-selection')
        ORDER BY thread_id ASC
      `;
      assert.deepStrictEqual(projectionRows, [
        { threadId: "thread-codex-work", providerInstanceId: "codex_bound" },
        { threadId: "thread-no-model-selection", providerInstanceId: "codex" },
      ]);

      const runtimeRows = yield* sql<{
        readonly threadId: string;
        readonly providerInstanceId: string | null;
      }>`
        SELECT
          thread_id AS "threadId",
          provider_instance_id AS "providerInstanceId"
        FROM provider_session_runtime
        WHERE thread_id IN ('runtime-codex-work', 'runtime-no-instance', 'thread-codex-work')
        ORDER BY thread_id ASC
      `;
      assert.deepStrictEqual(runtimeRows, [
        { threadId: "runtime-codex-work", providerInstanceId: "codex_work" },
        { threadId: "runtime-no-instance", providerInstanceId: "codex" },
        { threadId: "thread-codex-work", providerInstanceId: "codex_bound" },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("backfills provider instances without parsing malformed legacy JSON", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* runMigrations({ toMigrationInclusive: 48 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          env_mode,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-malformed-runtime',
          'project-provider-instance',
          'Malformed Legacy Runtime',
          'not-json',
          'full-access',
          'default',
          'local',
          ${now},
          ${now},
          NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          runtime_mode,
          active_turn_id,
          last_error,
          updated_at
        )
        VALUES (
          'thread-malformed-runtime',
          'stopped',
          'codex',
          'full-access',
          NULL,
          NULL,
          ${now}
        )
      `;
      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id,
          provider_name,
          adapter_key,
          runtime_mode,
          status,
          last_seen_at,
          resume_cursor_json,
          runtime_payload_json
        )
        VALUES (
          'thread-malformed-runtime',
          'codex',
          'codex',
          'full-access',
          'stopped',
          ${now},
          NULL,
          'not-json'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 55 });

      const [projectionSession] = yield* sql<{
        readonly providerInstanceId: string | null;
      }>`
        SELECT provider_instance_id AS "providerInstanceId"
        FROM projection_thread_sessions
        WHERE thread_id = 'thread-malformed-runtime'
      `;
      const [runtime] = yield* sql<{
        readonly providerInstanceId: string | null;
        readonly runtimePayloadJson: string | null;
      }>`
        SELECT
          provider_instance_id AS "providerInstanceId",
          runtime_payload_json AS "runtimePayloadJson"
        FROM provider_session_runtime
        WHERE thread_id = 'thread-malformed-runtime'
      `;

      assert.deepStrictEqual(projectionSession, { providerInstanceId: "codex" });
      assert.deepStrictEqual(runtime, {
        providerInstanceId: "codex",
        runtimePayloadJson: "not-json",
      });
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});

const upstreamAdoptionLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

upstreamAdoptionLayer("exact upstream lineage adoption", (it) => {
  it.effect("requires backup authorization and adopts the complete lineage transactionally", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* applyUpstreamLegacyMigrationRange(sql, 52, 68);

      const upstreamTracker = yield* trackerRows(sql);
      const unauthorized = yield* Effect.flip(runMigrations());
      assert.instanceOf(unauthorized, MigrationBackupRequiredError);
      assert.deepStrictEqual(yield* trackerRows(sql), upstreamTracker);

      const executed = yield* runMigrations().pipe(
        Effect.provideService(MigrationBackupAuthorization, true),
      );
      assert.deepStrictEqual(executed, expectedCanonicalReplayFrom53);
      assertCanonicalTracker(yield* trackerRows(sql));
      assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
      assert.deepStrictEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
    }),
  );
});

const upstreamAdoptionRollbackLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

upstreamAdoptionRollbackLayer("exact upstream lineage adoption rollback", (it) => {
  it.effect("restores the upstream tracker when adoption fails after reconciliation", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* applyUpstreamLegacyMigrationRange(sql, 52, 68);
      const upstreamTracker = yield* trackerRows(sql);

      const error = yield* Effect.flip(
        runMigrations({ injectFailureAfterLineageReconciliation: true }).pipe(
          Effect.provideService(MigrationBackupAuthorization, true),
        ),
      );
      assert.match(String(error), /injected failure after lineage reconciliation/);
      assert.deepStrictEqual(yield* trackerRows(sql), upstreamTracker);
    }),
  );
});

const providerDeliveryCutoverLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

providerDeliveryCutoverLayer(
  "registered DurableProviderCommandDelivery cutover migration",
  (it) => {
    it.effect("initializes at the event high-water mark when cutover explicitly runs", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 73 });
        const now = new Date().toISOString();

        const inserted = yield* sql<{ readonly sequence: number }>`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, causation_event_id, correlation_id,
          actor_kind, payload_json, metadata_json
        ) VALUES (
          'evt-before-durable-delivery', 'thread', 'thread-before-durable-delivery', 0,
          'thread.turn-start-requested', ${now}, 'cmd-before-durable-delivery',
          NULL, NULL, 'user', '{"threadId":"thread-before-durable-delivery"}', '{}'
        )
        RETURNING sequence
      `;

        const executed = yield* runMigrations({ toMigrationInclusive: 74 });
        assert.deepStrictEqual(executed, [[74, "DurableProviderCommandDeliveryCutover"]]);
        const rows = yield* sql<{ readonly lastAckedSequence: number }>`
        SELECT last_acked_sequence AS "lastAckedSequence"
        FROM orchestration_consumer_state
        WHERE consumer_name = 'provider-command-reactor.v1'
      `;
        assert.strictEqual(rows[0]?.lastAckedSequence, inserted[0]?.sequence);

        yield* DurableProviderCommandDeliveryMigration;
        const idempotentRows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_consumer_state
        WHERE consumer_name = 'provider-command-reactor.v1'
      `;
        assert.strictEqual(idempotentRows[0]?.count, 1);
      }),
    );
  },
);

const managedAttachmentsFreshLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

managedAttachmentsFreshLayer("managed attachment migration on a fresh database", (it) => {
  it.effect("reserves legacy migration 54 and creates the managed ledger on a fresh database", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const executed = yield* runMigrations();
      assert.deepInclude(executed, [64, "DurableProviderCommandDelivery"]);
      assert.deepInclude(executed, [65, "ManagedAttachments"]);
      assert.deepInclude(executed, [74, "DurableProviderCommandDeliveryCutover"]);
      assert.deepInclude(executed, [75, "DurableQueuedTurnPromotions"]);
      assert.deepInclude(executed, [76, "DurableProviderRuntimeEvents"]);
      assert.deepInclude(executed, [77, "ProviderDeliveryReconciliation"]);
      assert.deepInclude(executed, [78, "GitHandoffOperations"]);
      assert.deepInclude(executed, [139, "ProjectionThreadsSnooze"]);
      assert.deepInclude(executed, [140, "PullRequestAutoFix"]);

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('managed_attachment_blobs', 'managed_attachment_cleanup_jobs')
        ORDER BY name
      `;
      assert.deepStrictEqual(
        tables.map((row) => row.name),
        ["managed_attachment_blobs", "managed_attachment_cleanup_jobs"],
      );

      const providerDeliveryTables = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('orchestration_consumer_state', 'orchestration_event_deliveries')
      `;
      assert.strictEqual(providerDeliveryTables[0]?.count, 2);
    }),
  );
});

const managedAttachmentsConstraintsLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

managedAttachmentsConstraintsLayer("managed attachment schema constraints", (it) => {
  it.effect(
    "enforces lifecycle, immutable metadata, cleanup ownership, and indexed quota scans",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        const now = "2026-07-14T00:00:00.000Z";
        const expiry = "2026-07-15T00:00:00.000Z";

        yield* sql`
        INSERT INTO managed_attachment_blobs (
          attachment_id, owner_thread_id, owner_kind, owner_id, kind,
          original_name, mime_type, reserved_bytes, size_bytes, sha256,
          relative_path, state, staging_expires_at, claim_command_id,
          claim_message_id, claimed_at, delete_reason, delete_requested_at,
          deleted_at, created_at, updated_at
        ) VALUES (
          'att-v2-one', 'Thread/Exact', 'session', 'session-one', 'file',
          'notes.txt', 'text/plain', 1024, NULL, NULL,
          'objects/at/att-v2-one.bin', 'uploading', ${expiry}, NULL,
          NULL, NULL, NULL, NULL, NULL, ${now}, ${now}
        )
      `;

        yield* sql`
        UPDATE managed_attachment_blobs
        SET
          size_bytes = 5,
          sha256 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          state = 'staged',
          updated_at = ${now}
        WHERE attachment_id = 'att-v2-one'
      `;
        yield* sql`
        UPDATE managed_attachment_blobs
        SET
          state = 'claimed',
          claim_command_id = 'command-one',
          claim_message_id = 'message-one',
          claimed_at = ${now},
          updated_at = ${now}
        WHERE attachment_id = 'att-v2-one'
      `;
        yield* sql`
        UPDATE managed_attachment_blobs
        SET
          state = 'deleting',
          delete_reason = 'rollback',
          delete_requested_at = ${now},
          updated_at = ${now}
        WHERE attachment_id = 'att-v2-one'
      `;
        yield* sql`
        INSERT INTO managed_attachment_cleanup_jobs (
          attachment_id, reason, attempt_count, next_attempt_at,
          lease_owner, lease_expires_at, last_error, created_at, updated_at
        ) VALUES (
          'att-v2-one', 'rollback', 0, ${now}, NULL, NULL, NULL, ${now}, ${now}
        )
      `;

        const invalidState = yield* Effect.flip(sql`
        UPDATE managed_attachment_blobs
        SET state = 'staged', updated_at = ${now}
        WHERE attachment_id = 'att-v2-one'
      `);
        assert.isDefined(invalidState);

        const mutatedOwner = yield* Effect.flip(sql`
        UPDATE managed_attachment_blobs
        SET owner_thread_id = 'different-thread'
        WHERE attachment_id = 'att-v2-one'
      `);
        assert.isDefined(mutatedOwner);

        const duplicatePath = yield* Effect.flip(sql`
        INSERT INTO managed_attachment_blobs (
          attachment_id, owner_thread_id, owner_kind, owner_id, kind,
          original_name, mime_type, reserved_bytes, relative_path, state,
          staging_expires_at, created_at, updated_at
        ) VALUES (
          'att-v2-two', 'thread-two', 'session', 'session-two', 'image',
          'image.png', 'image/png', 2048, 'objects/at/att-v2-one.bin',
          'uploading', ${expiry}, ${now}, ${now}
        )
      `);
        assert.isDefined(duplicatePath);

        const missingBlobJob = yield* Effect.flip(sql`
        INSERT INTO managed_attachment_cleanup_jobs (
          attachment_id, reason, attempt_count, next_attempt_at,
          created_at, updated_at
        ) VALUES ('missing', 'gc', 0, ${now}, ${now}, ${now})
      `);
        assert.isDefined(missingBlobJob);

        const quota = yield* sql<{
          readonly reservedBytes: number;
          readonly reservedCount: number;
        }>`
        SELECT
          COALESCE(SUM(reserved_bytes), 0) AS "reservedBytes",
          COUNT(*) AS "reservedCount"
        FROM managed_attachment_blobs
        WHERE state <> 'deleted'
      `;
        assert.deepStrictEqual(quota[0], { reservedBytes: 1024, reservedCount: 1 });

        const blobIndexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_index_list('managed_attachment_blobs')
      `;
        assert.includeMembers(
          blobIndexes.map((row) => row.name),
          [
            "idx_managed_attachment_blobs_state_expiry",
            "idx_managed_attachment_blobs_state_reserved",
            "idx_managed_attachment_blobs_owner_thread",
            "idx_managed_attachment_blobs_owner_principal",
            "idx_managed_attachment_blobs_claim",
          ],
        );
        const cleanupIndexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_index_list('managed_attachment_cleanup_jobs')
      `;
        assert.include(
          cleanupIndexes.map((row) => row.name),
          "idx_managed_attachment_cleanup_jobs_due",
        );
      }),
  );
});

const managedAttachmentsIdempotencyLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

managedAttachmentsIdempotencyLayer("managed attachment migration idempotency", (it) => {
  it.effect("is idempotent after the managed attachment schema is registered", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const executed = yield* runMigrations();
      assert.lengthOf(executed, 0);
    }),
  );
});

layer("Auto-fix migration replay", (it) => {
  it.effect(
    "adds the optional alias to an existing Auto-fix table and preserves its watch on replay",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DROP TABLE IF EXISTS pull_request_auto_fix`;
        yield* sql`CREATE TABLE pull_request_auto_fix (
      thread_id TEXT NOT NULL, pull_request_url TEXT NOT NULL, status TEXT NOT NULL,
      pause_reason TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_handled_head_sha TEXT,
      updated_at TEXT NOT NULL, PRIMARY KEY (thread_id, pull_request_url)
    )`;
        yield* sql`INSERT INTO pull_request_auto_fix (thread_id, pull_request_url, status, attempts, last_handled_head_sha, updated_at)
      VALUES ('chat', 'https://github.com/o/r/pull/1', 'watching', 1, 'original-head', '2026-10-03T10:00:00.000Z')`;
        yield* PullRequestAutoFixMigration;
        yield* PullRequestAutoFixMigration;
        assert.include(
          yield* tableColumnNames(sql, "pull_request_auto_fix"),
          "requested_pull_request_url",
        );
        assert.include(
          yield* tableIndexNames(sql, "pull_request_auto_fix"),
          "pull_request_auto_fix_active_owner",
        );
        const rows = yield* sql<{
          thread_id: string;
          status: string;
          attempts: number;
          last_handled_head_sha: string;
          requested_pull_request_url: string | null;
        }>`SELECT thread_id, status, attempts, last_handled_head_sha, requested_pull_request_url FROM pull_request_auto_fix`;
        assert.deepStrictEqual(rows, [
          {
            thread_id: "chat",
            status: "watching",
            attempts: 1,
            last_handled_head_sha: "original-head",
            requested_pull_request_url: null,
          },
        ]);
      }),
  );
});
