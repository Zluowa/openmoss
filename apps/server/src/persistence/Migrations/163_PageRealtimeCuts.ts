import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

/** Add cut/sequence metadata without rewriting any existing Page, state or update bytes.
 * NULL contributor metadata means legacy/unrecorded; it is never an owner identity.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* columnExists(sql, "pages_realtime_docs", "next_sequence"))) {
        yield* sql`ALTER TABLE pages_realtime_docs ADD COLUMN next_sequence INTEGER NOT NULL DEFAULT 1 CHECK(next_sequence > 0)`;
        yield* sql`UPDATE pages_realtime_docs SET next_sequence = COALESCE((SELECT max(u.seq) + 1
        FROM pages_realtime_updates u WHERE u.page_id = pages_realtime_docs.page_id), 1)`;
      }
      if (!(yield* columnExists(sql, "pages_realtime_docs", "compacted_through_sequence")))
        yield* sql`ALTER TABLE pages_realtime_docs ADD COLUMN compacted_through_sequence INTEGER NOT NULL DEFAULT 0 CHECK(compacted_through_sequence >= 0)`;
      if (!(yield* columnExists(sql, "pages_realtime_updates", "contributors_json")))
        yield* sql`ALTER TABLE pages_realtime_updates ADD COLUMN contributors_json TEXT`;
      yield* sql`CREATE TABLE IF NOT EXISTS pages_version_contributors (
      page_id TEXT NOT NULL, revision INTEGER NOT NULL, contributors_json TEXT NOT NULL,
      PRIMARY KEY(page_id, revision),
      FOREIGN KEY(page_id, revision) REFERENCES pages_versions(page_id, revision) ON DELETE CASCADE
    )`;
    }),
  );
});
