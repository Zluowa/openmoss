import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // One live "share with guest" per thread. A share is 24-hour collaboration
  // state, so it lives beside the thread history rather than in the event log,
  // and an ended share is deleted instead of tombstoned.
  yield* sql`CREATE TABLE IF NOT EXISTS guest_shares (
    share_id TEXT PRIMARY KEY CHECK (length(share_id) = 22),
    thread_id TEXT NOT NULL UNIQUE CHECK (length(thread_id) > 0),
    relay_origin TEXT NOT NULL CHECK (length(relay_origin) > 0),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    guest_name TEXT CHECK (guest_name IS NULL OR length(guest_name) > 0),
    guest_joined_at TEXT,
    messages_json TEXT NOT NULL DEFAULT '[]',
    sent_messages_json TEXT NOT NULL DEFAULT '[]',
    CHECK ((guest_name IS NULL) = (guest_joined_at IS NULL))
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_guest_shares_expires_at ON guest_shares (expires_at)`;
});
