import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

// 资料空间 items: every item stays a pages_documents row and gains a kind
// (page, app, slides…; old rows are pages). Spaces gain an icon. Files agents
// created in chats are read from turn checkpoints, not copied; this table only
// remembers what the user did with one (trashed it, purged it), keyed by
// thread + path inside the same authorization scope as pages.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* columnExists(sql, "pages_documents", "kind"))) {
    yield* sql`ALTER TABLE pages_documents ADD COLUMN kind TEXT NOT NULL DEFAULT 'page'`;
  }
  if (!(yield* columnExists(sql, "pages_spaces", "icon"))) {
    yield* sql`ALTER TABLE pages_spaces ADD COLUMN icon TEXT`;
  }
  yield* sql`CREATE TABLE IF NOT EXISTS pages_output_states (
    scope_key TEXT NOT NULL,
    output_key TEXT NOT NULL,
    trashed_at TEXT,
    purged_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (scope_key, output_key)
  )`;
  // The 30-day trash sweep reads trashed rows by age.
  yield* sql`CREATE INDEX IF NOT EXISTS idx_pages_documents_trashed
    ON pages_documents(trashed_at) WHERE trashed_at IS NOT NULL`;
});
