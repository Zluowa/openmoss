import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A page or 应用页 published as a 站点. Guests see published_revision, not the live draft.
  // Unpublishing keeps the row (and its pin and history) with published_at NULL.
  yield* sql`CREATE TABLE IF NOT EXISTS pages_sites (
    site_id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL UNIQUE,
    scope_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('page', 'app')),
    title TEXT NOT NULL,
    visibility TEXT NOT NULL CHECK (visibility IN ('private', 'link', 'anyone')),
    link_id TEXT NOT NULL UNIQUE CHECK (length(link_id) = 22),
    published_revision INTEGER,
    published_at TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((published_at IS NULL) = (published_revision IS NULL))
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_pages_sites_scope
    ON pages_sites (scope_key, updated_at)`;
  // Profile-wide facts about publishing, such as when the first-publish notice was accepted.
  yield* sql`CREATE TABLE IF NOT EXISTS pages_sites_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`;
});
