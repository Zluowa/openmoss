import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration from "./060_PendingApprovalLifecycleGeneration.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("060_PendingApprovalLifecycleGeneration", (it) => {
  it.effect("preserves legacy approvals and stores the emitting runtime generation", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 69 });
      yield* sql`
        INSERT INTO projection_pending_approvals (
          request_id,
          thread_id,
          status,
          decision,
          created_at,
          resolved_at
        ) VALUES (
          'provider-request-legacy',
          'thread-generation',
          'pending',
          NULL,
          '2026-07-14T14:00:00.000Z',
          NULL
        )
      `;

      const executed = yield* runMigrations({ toMigrationInclusive: 70 });
      assert.deepStrictEqual(executed, [[70, "PendingApprovalLifecycleGeneration"]]);
      const legacy = yield* sql<{ readonly lifecycleGeneration: string | null }>`
        SELECT lifecycle_generation AS "lifecycleGeneration"
        FROM projection_pending_approvals
        WHERE thread_id = 'thread-generation'
          AND request_id = 'provider-request-legacy'
      `;
      assert.deepStrictEqual(legacy, [{ lifecycleGeneration: null }]);

      yield* sql`
        UPDATE projection_pending_approvals
        SET lifecycle_generation = 'generation-current'
        WHERE thread_id = 'thread-generation'
          AND request_id = 'provider-request-legacy'
      `;
      const current = yield* sql<{ readonly lifecycleGeneration: string | null }>`
        SELECT lifecycle_generation AS "lifecycleGeneration"
        FROM projection_pending_approvals
        WHERE thread_id = 'thread-generation'
          AND request_id = 'provider-request-legacy'
      `;
      assert.deepStrictEqual(current, [{ lifecycleGeneration: "generation-current" }]);
    }),
  );

  it.effect("rejects a final interactions table with the wrong durable identity", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TABLE IF EXISTS projection_pending_interactions`;
      yield* sql`
        CREATE TABLE projection_pending_interactions (
          interaction_kind TEXT NOT NULL,
          request_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          turn_id TEXT,
          lifecycle_generation TEXT,
          status TEXT NOT NULL,
          decision TEXT,
          response_command_id TEXT,
          response_requested_at TEXT,
          created_at TEXT NOT NULL,
          resolved_at TEXT,
          PRIMARY KEY (request_id)
        )
      `;

      const error = yield* Effect.flip(Migration);
      assert.match(
        String(error),
        /expected primary key \(thread_id, interaction_kind, request_id\), found \(request_id\)/,
      );
    }),
  );
});
