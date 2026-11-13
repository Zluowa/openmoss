import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

// A page's doc style (column width, fonts, language) for everyone who opens it, and the comment
// threads on words in a page, kept with the page instead of in one window's browser storage.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* columnExists(sql, "pages_documents", "doc_style"))) {
    yield* sql`ALTER TABLE pages_documents ADD COLUMN doc_style TEXT`;
  }
  yield* sql`
    CREATE TABLE IF NOT EXISTS pages_text_comments (
      comment_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      thread_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (page_id, comment_id)
    )
  `;
});
