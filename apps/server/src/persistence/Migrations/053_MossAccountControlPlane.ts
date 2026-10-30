import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS moss_account_users (
      user_id TEXT PRIMARY KEY,
      phone_number TEXT NOT NULL UNIQUE,
      display_name TEXT,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS moss_account_sessions (
      session_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT,
      revoked_at TEXT,
      FOREIGN KEY (user_id) REFERENCES moss_account_users(user_id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_moss_account_sessions_active
    ON moss_account_sessions(user_id, expires_at, revoked_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS moss_account_sms_challenges (
      challenge_id TEXT PRIMARY KEY,
      phone_number TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      code_salt TEXT NOT NULL,
      provider TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_moss_account_sms_challenges_phone_created
    ON moss_account_sms_challenges(phone_number, created_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS moss_api_users (
      api_user_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS moss_api_keys (
      api_key_id TEXT PRIMARY KEY,
      api_user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      key_prefix TEXT NOT NULL UNIQUE,
      key_hash TEXT NOT NULL,
      key_salt TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT,
      FOREIGN KEY (api_user_id) REFERENCES moss_api_users(api_user_id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_moss_api_keys_user_active
    ON moss_api_keys(api_user_id, revoked_at)
  `;
});
