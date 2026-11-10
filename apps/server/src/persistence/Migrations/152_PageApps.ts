import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// 应用页 (runnable HTML pages). Same owner boundary and scope_key domain as
// Pages (148). HTML bodies are immutable version rows; the item row holds the
// current metadata. At most 100 versions are kept per page.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS page_apps (
    app_id TEXT PRIMARY KEY,
    scope_key TEXT NOT NULL,
    space_id TEXT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL CHECK (revision > 0),
    capabilities_json TEXT NOT NULL DEFAULT '{}',
    favorite INTEGER NOT NULL DEFAULT 0,
    thumbnail TEXT,
    source_thread_id TEXT,
    html_chars INTEGER NOT NULL DEFAULT 0,
    trashed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS page_app_versions (
    app_id TEXT NOT NULL REFERENCES page_apps(app_id),
    revision INTEGER NOT NULL CHECK (revision > 0),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    capabilities_json TEXT NOT NULL,
    html TEXT NOT NULL,
    operation TEXT NOT NULL,
    author TEXT NOT NULL CHECK (author IN ('local-user', 'agent')),
    author_thread_id TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (app_id, revision)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS page_app_requests (
    scope_key TEXT NOT NULL,
    actor_key TEXT NOT NULL,
    request_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (scope_key, actor_key, request_id)
  )`;
  // Viewer answers to capability prompts, remembered per page.
  yield* sql`CREATE TABLE IF NOT EXISTS page_app_consents (
    app_id TEXT NOT NULL REFERENCES page_apps(app_id),
    viewer_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('granted', 'denied')),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (app_id, viewer_id, capability)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_page_apps_scope
    ON page_apps(scope_key, trashed_at, updated_at)`;
});
