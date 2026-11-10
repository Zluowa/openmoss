import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { columnExists } from "./schemaHelpers.ts";

/** The slot outlives a removed version. Neither pruning nor revoke turns an
 * old first-publication request (expectedGeneration=0) into a valid retry. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* columnExists(sql, "pages_sites", "publication_epoch")))
        yield* sql`ALTER TABLE pages_sites ADD COLUMN publication_epoch INTEGER NOT NULL DEFAULT 1 CHECK(publication_epoch > 0)`;
      yield* sql`CREATE TABLE IF NOT EXISTS page_app_publication_slots (
      entry_kind TEXT NOT NULL CHECK(entry_kind IN ('link','site')), entry_id TEXT NOT NULL,
      page_id TEXT NOT NULL REFERENCES pages_documents(page_id) ON DELETE CASCADE,
      node_path TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation > 0),
      PRIMARY KEY(entry_kind, entry_id, page_id, node_path)
    )`;
      yield* sql`CREATE TABLE IF NOT EXISTS page_app_publications (
      publication_id TEXT PRIMARY KEY, entry_kind TEXT NOT NULL, entry_id TEXT NOT NULL, page_id TEXT NOT NULL,
      node_path TEXT NOT NULL, generation INTEGER NOT NULL, policy_stamp TEXT NOT NULL,
      page_revision INTEGER NOT NULL, scope_key TEXT NOT NULL, space_id TEXT, body_digest TEXT NOT NULL,
      app_id TEXT NOT NULL, app_revision INTEGER NOT NULL, app_digest TEXT NOT NULL,
      UNIQUE(entry_kind,entry_id,page_id,node_path),
      FOREIGN KEY(entry_kind,entry_id,page_id,node_path) REFERENCES page_app_publication_slots ON DELETE CASCADE,
      FOREIGN KEY(page_id,page_revision) REFERENCES pages_versions(page_id,revision) ON DELETE CASCADE,
      FOREIGN KEY(app_id,app_revision) REFERENCES page_app_versions(app_id,revision) ON DELETE CASCADE
    )`;
      yield* sql`CREATE INDEX IF NOT EXISTS idx_page_app_publications_version ON page_app_publications(app_id,app_revision)`;
      yield* sql`CREATE INDEX IF NOT EXISTS idx_page_app_publications_host ON page_app_publications(page_id,page_revision)`;
      yield* sql`CREATE TRIGGER IF NOT EXISTS revoke_page_app_host_on_move_or_trash
      AFTER UPDATE OF scope_key,space_id,trashed_at ON pages_documents
      WHEN NEW.scope_key IS NOT OLD.scope_key OR NEW.space_id IS NOT OLD.space_id OR NEW.trashed_at IS NOT OLD.trashed_at
      BEGIN DELETE FROM page_app_publications WHERE page_id=OLD.page_id; END`;
      yield* sql`CREATE TRIGGER IF NOT EXISTS revoke_page_app_on_move_or_trash
      AFTER UPDATE OF scope_key,space_id,trashed_at ON page_apps
      WHEN NEW.scope_key IS NOT OLD.scope_key OR NEW.space_id IS NOT OLD.space_id OR NEW.trashed_at IS NOT OLD.trashed_at
      BEGIN DELETE FROM page_app_publications WHERE app_id=OLD.app_id; END`;
    }),
  );
});
