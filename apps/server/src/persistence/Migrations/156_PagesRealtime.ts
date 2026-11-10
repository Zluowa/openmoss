import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The live Yjs document of a Page as of its last compaction into pages_versions. `generation`
  // changes only when the document is rebuilt, so editors never merge a stale offline copy into
  // a fresh one. `compacted_key` identifies the Page content the state was compacted from.
  yield* sql`CREATE TABLE IF NOT EXISTS pages_realtime_docs (
    page_id TEXT PRIMARY KEY REFERENCES pages_documents(page_id),
    generation TEXT NOT NULL,
    state BLOB NOT NULL,
    compacted_revision INTEGER NOT NULL CHECK (compacted_revision > 0),
    compacted_key TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  // Updates received since the last compaction, appended as they arrive so a crash loses none.
  yield* sql`CREATE TABLE IF NOT EXISTS pages_realtime_updates (
    page_id TEXT NOT NULL REFERENCES pages_documents(page_id),
    seq INTEGER NOT NULL,
    generation TEXT NOT NULL,
    update_data BLOB NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (page_id, seq)
  )`;
  // Document state per compacted revision, so a write made against an older revision (an agent
  // that read the Page earlier) merges as an edit instead of overwriting newer typing.
  yield* sql`CREATE TABLE IF NOT EXISTS pages_realtime_snapshots (
    page_id TEXT NOT NULL REFERENCES pages_documents(page_id),
    generation TEXT NOT NULL,
    revision INTEGER NOT NULL,
    state BLOB NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (page_id, generation, revision)
  )`;
});
