import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// 应用页 capabilities that reach past the page: per-server answers for `mcp`
// (and destructive tools remembered for a page), the audit log of connector
// and file calls, the page's own assets, and its comments. Rows go with the
// page when it is erased.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // `tool` is '' for the server-level answer, else a destructive tool the
  // viewer chose to stop being asked about on this page.
  yield* sql`CREATE TABLE IF NOT EXISTS page_app_mcp_grants (
    app_id TEXT NOT NULL REFERENCES page_apps(app_id) ON DELETE CASCADE,
    viewer_id TEXT NOT NULL,
    server TEXT NOT NULL,
    tool TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL CHECK (state IN ('granted', 'denied')),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (app_id, viewer_id, server, tool)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS page_app_audit (
    audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id TEXT NOT NULL REFERENCES page_apps(app_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    viewer_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    method TEXT NOT NULL,
    target TEXT NOT NULL,
    outcome TEXT NOT NULL,
    detail TEXT,
    duration_ms INTEGER,
    created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_page_app_audit_app
    ON page_app_audit(app_id, audit_id)`;
  yield* sql`CREATE TABLE IF NOT EXISTS page_app_assets (
    asset_id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES page_apps(app_id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    data BLOB NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_page_app_assets_app
    ON page_app_assets(app_id, created_at)`;
  yield* sql`CREATE TABLE IF NOT EXISTS page_app_comments (
    comment_id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES page_apps(app_id) ON DELETE CASCADE,
    anchor_json TEXT NOT NULL,
    body TEXT NOT NULL,
    author_id TEXT NOT NULL,
    author_name TEXT NOT NULL,
    resolved_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_page_app_comments_app
    ON page_app_comments(app_id, created_at)`;
});
