import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(NodeSqliteClient.layerMemory());

layer("061_MossCloudAccountBindings", (it) => {
  it.effect("stores only account metadata and allows a single selected account", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(moss_cloud_account_bindings)
      `;
      const names = columns.map((column) => column.name);
      assert.includeMembers(names, ["account_id", "email", "session_secret_ref", "selected"]);
      assert.notInclude(names, "access_token");
      assert.notInclude(names, "refresh_token");
      assert.notInclude(names, "password");

      const now = "2026-07-12T00:00:00.000Z";
      yield* sql`
        INSERT INTO moss_cloud_account_bindings (
          account_id, email, display_name, status, email_verified,
          session_secret_ref, selected, created_at, updated_at, last_used_at
        ) VALUES (
          'account-a', 'a@example.com', NULL, 'active', 1,
          'secret-a', 1, ${now}, ${now}, ${now}
        )
      `;

      const duplicateSelection = yield* Effect.exit(sql`
        INSERT INTO moss_cloud_account_bindings (
          account_id, email, display_name, status, email_verified,
          session_secret_ref, selected, created_at, updated_at, last_used_at
        ) VALUES (
          'account-b', 'b@example.com', NULL, 'active', 1,
          'secret-b', 1, ${now}, ${now}, ${now}
        )
      `);
      assert.strictEqual(duplicateSelection._tag, "Failure");

      yield* sql`
        INSERT INTO moss_cloud_account_bindings (
          account_id, email, display_name, status, email_verified,
          session_secret_ref, selected, created_at, updated_at, last_used_at
        ) VALUES (
          'account-b', 'b@example.com', NULL, 'active', 1,
          'secret-b', 0, ${now}, ${now}, NULL
        )
      `;
      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count" FROM moss_cloud_account_bindings
      `;
      assert.strictEqual(Number(rows[0]?.count ?? 0), 2);
    }),
  );
});
