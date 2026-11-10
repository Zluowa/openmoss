import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

/** Only version history admits guests; comments/drafts/typed items retain their owner authors. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (yield* columnExists(sql, "pages_versions", "author_guest_ref")) return;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      // Preserve locally present indexes/triggers as well as the canonical primary key.
      const objects = yield* sql<{ sql: string }>`SELECT sql FROM sqlite_master
      WHERE tbl_name = 'pages_versions' AND type IN ('index', 'trigger') AND sql IS NOT NULL`;
      yield* sql`CREATE TABLE pages_versions_guest_upgrade (
      page_id TEXT NOT NULL REFERENCES pages_documents(page_id),
      revision INTEGER NOT NULL CHECK (revision > 0),
      page_json TEXT NOT NULL,
      content TEXT NOT NULL,
      rich_content TEXT,
      operation TEXT NOT NULL,
      author TEXT NOT NULL CHECK (author IN ('local-user', 'agent', 'guest')),
      author_thread_id TEXT,
      created_at TEXT NOT NULL,
      author_guest_ref TEXT,
      CHECK ((author = 'guest' AND author_thread_id IS NULL AND author_guest_ref IS NOT NULL
          AND length(author_guest_ref) = 64 AND author_guest_ref NOT GLOB '*[^0-9a-f]*')
        OR (author <> 'guest' AND author_guest_ref IS NULL)),
      PRIMARY KEY (page_id, revision)
    )`;
      yield* sql`INSERT INTO pages_versions_guest_upgrade
      (page_id, revision, page_json, content, rich_content, operation, author, author_thread_id, created_at)
      SELECT page_id, revision, page_json, content, rich_content, operation, author, author_thread_id, created_at
      FROM pages_versions`;
      yield* sql`DROP TABLE pages_versions`;
      yield* sql`ALTER TABLE pages_versions_guest_upgrade RENAME TO pages_versions`;
      for (const object of objects) yield* sql.unsafe(object.sql);
    }),
  );
});
