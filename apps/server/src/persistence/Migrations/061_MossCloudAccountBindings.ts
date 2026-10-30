import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Local, non-secret metadata for Supabase-backed Moss accounts.
 *
 * Access and refresh tokens live behind ServerSecretStore references. This
 * table deliberately contains no credential material and does not replace the
 * legacy phone-account tables introduced by migration 53.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS moss_cloud_account_bindings (
      account_id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      display_name TEXT,
      status TEXT NOT NULL,
      email_verified INTEGER NOT NULL DEFAULT 0,
      session_secret_ref TEXT NOT NULL,
      selected INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_moss_cloud_account_bindings_email
    ON moss_cloud_account_bindings(lower(email))
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_moss_cloud_account_bindings_selected
    ON moss_cloud_account_bindings(selected)
    WHERE selected = 1
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_moss_cloud_account_bindings_last_used
    ON moss_cloud_account_bindings(last_used_at DESC, updated_at DESC)
  `;
});
