/**
 * Adds `dispatch_source_thread_id` to projected thread messages so a message
 * another thread's agent sent (moss_send_message) can name its sender in the
 * transcript. Nullable: absent/NULL means a human send or an unknown sender.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "projection_thread_messages", "dispatch_source_thread_id"))) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN dispatch_source_thread_id TEXT
    `;
  }
});
