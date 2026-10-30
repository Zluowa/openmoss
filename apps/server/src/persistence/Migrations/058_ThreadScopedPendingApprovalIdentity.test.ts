import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration from "./058_ThreadScopedPendingApprovalIdentity.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("058_ThreadScopedPendingApprovalIdentity", (it) => {
  it.effect("preserves legacy rows and permits the same request id in another thread", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 67 });
      yield* sql`
        INSERT INTO projection_pending_approvals (
          request_id,
          thread_id,
          status,
          decision,
          created_at,
          resolved_at
        ) VALUES (
          'provider-request-1',
          'thread-a',
          'pending',
          NULL,
          '2026-07-14T12:00:00.000Z',
          NULL
        )
      `;

      const executed = yield* runMigrations({ toMigrationInclusive: 68 });
      assert.deepStrictEqual(executed, [[68, "ThreadScopedPendingApprovalIdentity"]]);
      yield* sql`
        INSERT INTO projection_pending_approvals (
          request_id,
          thread_id,
          status,
          decision,
          created_at,
          resolved_at
        ) VALUES (
          'provider-request-1',
          'thread-b',
          'resolved',
          'accept',
          '2026-07-14T12:00:01.000Z',
          '2026-07-14T12:00:02.000Z'
        )
      `;

      const primaryKey = yield* sql<{ readonly name: string; readonly position: number }>`
        SELECT name, pk AS position
        FROM pragma_table_info('projection_pending_approvals')
        WHERE pk > 0
        ORDER BY pk ASC
      `;
      assert.deepStrictEqual(primaryKey, [
        { name: "thread_id", position: 1 },
        { name: "request_id", position: 2 },
      ]);
      const requestIdIndex = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM pragma_index_list('projection_pending_approvals')
        WHERE name = 'idx_projection_pending_approvals_request_id'
      `;
      assert.deepStrictEqual(requestIdIndex, [
        { name: "idx_projection_pending_approvals_request_id" },
      ]);

      const rows = yield* sql<{
        readonly threadId: string;
        readonly status: string;
        readonly decision: string | null;
      }>`
        SELECT thread_id AS "threadId", status, decision
        FROM projection_pending_approvals
        WHERE request_id = 'provider-request-1'
        ORDER BY thread_id ASC
      `;
      assert.deepStrictEqual(rows, [
        { threadId: "thread-a", status: "pending", decision: null },
        { threadId: "thread-b", status: "resolved", decision: "accept" },
      ]);
    }),
  );

  it.effect("rejects a final interactions table that is missing a settlement column", () =>
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
          created_at TEXT NOT NULL,
          resolved_at TEXT,
          PRIMARY KEY (thread_id, interaction_kind, request_id)
        )
      `;

      const error = yield* Effect.flip(Migration);
      assert.match(String(error), /missing required columns \(response_requested_at\)/);
    }),
  );
});
