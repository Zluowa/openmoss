import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The profile database, authorized project and trusted RPC principal jointly
  // bound a creation. Receipts survive restart and are published with the row.
  yield* sql`CREATE TABLE IF NOT EXISTS automation_create_requests (
    project_id TEXT NOT NULL,
    principal_key TEXT NOT NULL,
    request_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('accepted', 'rejected')),
    result_json TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, principal_key, request_id),
    CHECK ((status = 'accepted' AND result_json IS NOT NULL AND error_code IS NULL AND error_message IS NULL)
      OR (status = 'rejected' AND result_json IS NULL AND error_code = 'AUTOMATION_CREATE_REJECTED' AND error_message IS NOT NULL))
  )`;
});
