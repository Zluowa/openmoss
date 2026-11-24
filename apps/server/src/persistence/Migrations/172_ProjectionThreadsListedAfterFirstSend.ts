// A chat made before anything was sent, so its agent warms up (an item's 问 Moss panel), is not
// listed until its first send (WALK-1 S-6). Nullable, no backfill: null means listed as before.
// Additive (MIGRATIONS_OLDER_READERS_MAY_IGNORE); safe to run twice.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* columnExists(sql, "projection_threads", "listed_after_first_send"))) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN listed_after_first_send INTEGER
    `;
  }
});
