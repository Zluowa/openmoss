// Additive columns for version pinning and removable starter metadata, plus permanent starter dismissal tracking.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (!(yield* columnExists(sql, "page_apps", "pinned_revision"))) {
    yield* sql`ALTER TABLE page_apps ADD COLUMN pinned_revision INTEGER`;
  }
  if (!(yield* columnExists(sql, "page_apps", "starter_id"))) {
    yield* sql`ALTER TABLE page_apps ADD COLUMN starter_id TEXT`;
  }
  yield* sql`
    CREATE TABLE IF NOT EXISTS page_app_dismissed_starters (
      starter_id TEXT PRIMARY KEY,
      dismissed_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_page_apps_starter ON page_apps(starter_id)`;
});
