import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// The `db` capability of 应用页: JSON documents at slash paths, one store per
// page, erased with the page. `collection_path` is the parent collection so a
// collection listing is one indexed range.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS page_app_documents (
    app_id TEXT NOT NULL REFERENCES page_apps(app_id),
    path TEXT NOT NULL,
    collection_path TEXT NOT NULL,
    doc_id TEXT NOT NULL,
    data_json TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    updated_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (app_id, path)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_page_app_documents_collection
    ON page_app_documents(app_id, collection_path, doc_id)`;
});
