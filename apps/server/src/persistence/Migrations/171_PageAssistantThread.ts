// FILE: 171_PageAssistantThread.ts
// Purpose: Additive migration recording each Space item's bound default assistant thread id.

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* columnExists(sql, "pages_documents", "default_assistant_thread_id"))) {
    yield* sql`ALTER TABLE pages_documents ADD COLUMN default_assistant_thread_id TEXT`;
  }
});
