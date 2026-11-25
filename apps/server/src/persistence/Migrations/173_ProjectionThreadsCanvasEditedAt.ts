// When a conversation's 画布 first held content (WALK-7 N7-1): a chat nothing was sent in is
// listed once its 画布 has something on it. Nullable, no backfill: null means no 画布 with
// content. Additive (MIGRATIONS_OLDER_READERS_MAY_IGNORE); safe to run twice.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* columnExists(sql, "projection_threads", "canvas_edited_at"))) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN canvas_edited_at TEXT
    `;
  }
});
