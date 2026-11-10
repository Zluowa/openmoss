import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Proposed page changes. A draft never edits pages_versions itself: the person who accepts it
  // saves the page through the normal path, and the draft only records that it was resolved.
  yield* sql`CREATE TABLE IF NOT EXISTS pages_drafts (
    draft_id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL REFERENCES pages_documents(page_id),
    scope_key TEXT NOT NULL,
    base_revision INTEGER NOT NULL CHECK (base_revision > 0),
    kind TEXT NOT NULL CHECK (kind IN ('text', 'image', 'visualization')),
    summary TEXT,
    ops_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'accepted', 'discarded')),
    author TEXT NOT NULL CHECK (author IN ('local-user', 'agent')),
    author_thread_id TEXT,
    actor_key TEXT NOT NULL,
    request_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    resolved_revision INTEGER,
    UNIQUE (scope_key, actor_key, request_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_pages_drafts_page
    ON pages_drafts(page_id, status, created_at)`;
});
