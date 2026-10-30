import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration from "./061_PendingApprovalSettlementState.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("061_PendingApprovalSettlementState", (it) => {
  it.effect("migrates resolved rows and persists one response owner", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 70 });
      yield* sql`
        INSERT INTO projection_pending_approvals (
          request_id, thread_id, status, decision, created_at, resolved_at
        ) VALUES (
          'request-settled', 'thread-settled', 'resolved', 'accept',
          '2026-07-14T12:00:00.000Z', '2026-07-14T12:00:01.000Z'
        )
      `;

      const executed = yield* runMigrations({ toMigrationInclusive: 71 });
      assert.deepStrictEqual(executed, [[71, "PendingApprovalSettlementState"]]);
      const rows = yield* sql<{
        readonly status: string;
        readonly responseCommandId: string | null;
        readonly responseRequestedAt: string | null;
      }>`
        SELECT
          status,
          response_command_id AS "responseCommandId",
          response_requested_at AS "responseRequestedAt"
        FROM projection_pending_approvals
        WHERE thread_id = 'thread-settled' AND request_id = 'request-settled'
      `;
      assert.deepStrictEqual(rows, [
        { status: "confirmed", responseCommandId: null, responseRequestedAt: null },
      ]);
    }),
  );

  it.effect("rejects a final interactions table that is missing lifecycle ownership", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TABLE IF EXISTS projection_pending_interactions`;
      yield* sql`
        CREATE TABLE projection_pending_interactions (
          interaction_kind TEXT NOT NULL,
          request_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          turn_id TEXT,
          status TEXT NOT NULL,
          decision TEXT,
          response_command_id TEXT,
          response_requested_at TEXT,
          created_at TEXT NOT NULL,
          resolved_at TEXT,
          PRIMARY KEY (thread_id, interaction_kind, request_id)
        )
      `;

      const error = yield* Effect.flip(Migration);
      assert.match(String(error), /missing required columns \(lifecycle_generation\)/);
    }),
  );
});
