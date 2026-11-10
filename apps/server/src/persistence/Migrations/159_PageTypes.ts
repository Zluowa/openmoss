import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Typed 资料空间 items (slides, sheet, board, app) keep their payload beside the page row.
  // One row per page revision that changed the payload; a read takes the newest row at or
  // below the page's revision, so the payload follows the page's own version history.
  yield* sql`CREATE TABLE IF NOT EXISTS pages_item_data (
    page_id TEXT NOT NULL REFERENCES pages_documents(page_id),
    revision INTEGER NOT NULL CHECK (revision > 0),
    kind TEXT NOT NULL CHECK (kind IN ('slides', 'sheet', 'board', 'app')),
    data TEXT NOT NULL,
    author TEXT NOT NULL CHECK (author IN ('local-user', 'agent')),
    author_thread_id TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (page_id, revision)
  )`;
  // Personal templates saved from any item. Built-in templates ship in code, not here.
  yield* sql`CREATE TABLE IF NOT EXISTS pages_templates (
    template_id TEXT PRIMARY KEY,
    scope_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('page', 'slides', 'sheet', 'app')),
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    rich_content TEXT,
    data TEXT,
    source_page_id TEXT,
    created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_pages_templates_scope
    ON pages_templates(scope_key, created_at)`;
});
