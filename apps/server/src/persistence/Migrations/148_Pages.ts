import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The existing state.sqlite/profile is the owner boundary. scope_key is an
  // existing project-space authorization domain, not a Pages document-space id.
  yield* sql`CREATE TABLE IF NOT EXISTS pages_spaces (
    space_id TEXT PRIMARY KEY,
    scope_key TEXT NOT NULL,
    root_page_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    trashed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS pages_documents (
    page_id TEXT PRIMARY KEY,
    scope_key TEXT NOT NULL,
    space_id TEXT,
    parent_page_id TEXT,
    root_page_id TEXT NOT NULL,
    title TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    pinned INTEGER NOT NULL DEFAULT 0,
    trashed_at TEXT,
    trash_batch TEXT,
    source_thread_id TEXT,
    asset_ids_json TEXT NOT NULL DEFAULT '[]',
    automation_ids_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  // Content and its complete metadata snapshot are published in one SQLite
  // transaction. There is no second mutable document copy to get out of sync.
  yield* sql`CREATE TABLE IF NOT EXISTS pages_versions (
    page_id TEXT NOT NULL REFERENCES pages_documents(page_id),
    revision INTEGER NOT NULL CHECK (revision > 0),
    page_json TEXT NOT NULL,
    content TEXT NOT NULL,
    rich_content TEXT,
    operation TEXT NOT NULL,
    author TEXT NOT NULL CHECK (author IN ('local-user', 'agent')),
    author_thread_id TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (page_id, revision)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS pages_comments (
    comment_id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL REFERENCES pages_documents(page_id),
    revision INTEGER NOT NULL,
    content TEXT NOT NULL,
    author TEXT NOT NULL CHECK (author IN ('local-user', 'agent')),
    author_thread_id TEXT,
    created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS pages_requests (
    scope_key TEXT NOT NULL,
    actor_key TEXT NOT NULL,
    request_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (scope_key, actor_key, request_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_pages_documents_scope
    ON pages_documents(scope_key, trashed_at, updated_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_pages_documents_parent
    ON pages_documents(parent_page_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_pages_spaces_scope
    ON pages_spaces(scope_key, trashed_at, updated_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_pages_comments_page
    ON pages_comments(page_id, revision, comment_id)`;
});
