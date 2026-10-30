import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

/** Persists the provider-owned realtime handoff block identity on messages. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "projection_thread_messages", "realtime_handoff_id"))) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN realtime_handoff_id TEXT
    `;
  }
});
