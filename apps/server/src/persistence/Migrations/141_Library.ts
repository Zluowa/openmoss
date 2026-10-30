import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Moss 资料库 local index. Rows point at files owned by agent data roots
  // (read-only) or the Moss import area; folders are virtual labels and never
  // move files on disk. No foreign keys to projections: agent threads and
  // folders come and go independently of the index.
  yield* sql`CREATE TABLE IF NOT EXISTS library_items (
    item_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'other'
      CHECK (kind IN ('image', 'video', 'archive', 'document', 'other')),
    source TEXT NOT NULL
      CHECK (source IN (
        'codex:attachment',
        'codex:generated',
        'claude:downloads',
        'claude:file-history',
        'user:import',
        'user:legacy'
      )),
    source_cli TEXT NOT NULL DEFAULT 'other'
      CHECK (source_cli IN ('codex', 'claude', 'moss', 'other')),
    path TEXT,
    mime_type TEXT,
    size INTEGER NOT NULL DEFAULT 0,
    favorite INTEGER NOT NULL DEFAULT 0,
    folder_id TEXT,
    trashed_at TEXT,
    origination_thread_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  // One row per on-disk file; metadata-only rows (user:legacy) carry no path.
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_library_items_path
    ON library_items(path) WHERE path IS NOT NULL`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_library_items_trashed_at
    ON library_items(trashed_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_library_items_folder_id
    ON library_items(folder_id)`;
  yield* sql`CREATE TABLE IF NOT EXISTS library_folders (
    folder_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
});
