import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

// A page's icon (a glyph name or an emoji) above its title, and its cover band (a preset id).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* columnExists(sql, "pages_documents", "icon"))) {
    yield* sql`ALTER TABLE pages_documents ADD COLUMN icon TEXT`;
  }
  if (!(yield* columnExists(sql, "pages_documents", "cover"))) {
    yield* sql`ALTER TABLE pages_documents ADD COLUMN cover TEXT`;
  }
});
