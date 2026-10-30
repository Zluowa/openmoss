import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration from "./062_PendingInteractionSettlementParity.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("062_PendingInteractionSettlementParity", (it) => {
  it.effect("migrates approval settlement and admits the same request id for user input", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 71 });
      yield* sql`
        INSERT INTO projection_pending_approvals (
          request_id, thread_id, lifecycle_generation, status, decision,
          response_command_id, response_requested_at, created_at, resolved_at
        ) VALUES (
          'shared-request', 'thread-interactions', 'generation-a', 'responding', 'accept',
          'command-a', '2026-07-14T12:00:01.000Z', '2026-07-14T12:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES ('projection.pending-approvals', 42, '2026-07-14T12:00:02.000Z')
      `;

      const executed = yield* runMigrations({ toMigrationInclusive: 72 });
      assert.deepStrictEqual(executed, [[72, "PendingInteractionSettlementParity"]]);
      yield* sql`
        INSERT INTO projection_pending_interactions (
          interaction_kind, request_id, thread_id, lifecycle_generation, status, created_at
        ) VALUES (
          'userInput', 'shared-request', 'thread-interactions', 'generation-a', 'pending',
          '2026-07-14T12:00:03.000Z'
        )
      `;

      const rows = yield* sql<{
        readonly interactionKind: string;
        readonly status: string;
        readonly responseCommandId: string | null;
      }>`
        SELECT
          interaction_kind AS "interactionKind",
          status,
          response_command_id AS "responseCommandId"
        FROM projection_pending_interactions
        WHERE thread_id = 'thread-interactions' AND request_id = 'shared-request'
        ORDER BY interaction_kind
      `;
      assert.deepStrictEqual(rows, [
        { interactionKind: "approval", status: "responding", responseCommandId: "command-a" },
        { interactionKind: "userInput", status: "pending", responseCommandId: null },
      ]);

      const oldTable = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM sqlite_master
        WHERE type = 'table' AND name = 'projection_pending_approvals'
      `;
      assert.strictEqual(oldTable[0]?.count, 0);
      const oldCursor = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM projection_state
        WHERE projector = 'projection.pending-approvals'
      `;
      assert.strictEqual(oldCursor[0]?.count, 0);
    }),
  );

  it.effect("rejects an already-migrated interactions table with a reordered primary key", () =>
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
          PRIMARY KEY (interaction_kind, thread_id, request_id)
        )
      `;

      const error = yield* Effect.flip(Migration);
      assert.match(
        String(error),
        /expected primary key \(thread_id, interaction_kind, request_id\), found \(interaction_kind, thread_id, request_id\)/,
      );
    }),
  );
});
