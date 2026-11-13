import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Typed 资料空间 kinds are validated in code (`parseItemData`, the template kinds), so the
 * payload and template tables stop pinning them with a CHECK. 设计 (`design`) is the first kind
 * added this way; later kinds need no migration. Rebuilds keep rows, indexes and triggers.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const definition = (table: string) =>
    sql<{
      sql: string;
    }>`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${table}`.pipe(
      Effect.map((rows) => rows[0]?.sql ?? ""),
    );
  const pinned = (create: string) => /CHECK\s*\(\s*kind\s+IN\b/iu.test(create);
  const objects = (table: string) =>
    sql<{ sql: string }>`SELECT sql FROM sqlite_master
      WHERE tbl_name = ${table} AND type IN ('index', 'trigger') AND sql IS NOT NULL`;

  if (pinned(yield* definition("pages_item_data"))) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const kept = yield* objects("pages_item_data");
        yield* sql`CREATE TABLE pages_item_data_open_kinds (
          page_id TEXT NOT NULL REFERENCES pages_documents(page_id),
          revision INTEGER NOT NULL CHECK (revision > 0),
          kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 40),
          data TEXT NOT NULL,
          author TEXT NOT NULL CHECK (author IN ('local-user', 'agent')),
          author_thread_id TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (page_id, revision)
        )`;
        yield* sql`INSERT INTO pages_item_data_open_kinds
          (page_id, revision, kind, data, author, author_thread_id, created_at)
          SELECT page_id, revision, kind, data, author, author_thread_id, created_at FROM pages_item_data`;
        yield* sql`DROP TABLE pages_item_data`;
        yield* sql`ALTER TABLE pages_item_data_open_kinds RENAME TO pages_item_data`;
        for (const object of kept) yield* sql.unsafe(object.sql);
      }),
    );
  }

  if (pinned(yield* definition("pages_templates"))) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const kept = yield* objects("pages_templates");
        yield* sql`CREATE TABLE pages_templates_open_kinds (
          template_id TEXT PRIMARY KEY,
          scope_key TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 40),
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          content TEXT NOT NULL DEFAULT '',
          rich_content TEXT,
          data TEXT,
          source_page_id TEXT,
          created_at TEXT NOT NULL
        )`;
        yield* sql`INSERT INTO pages_templates_open_kinds
          (template_id, scope_key, kind, title, description, content, rich_content, data, source_page_id, created_at)
          SELECT template_id, scope_key, kind, title, description, content, rich_content, data, source_page_id, created_at
          FROM pages_templates`;
        yield* sql`DROP TABLE pages_templates`;
        yield* sql`ALTER TABLE pages_templates_open_kinds RENAME TO pages_templates`;
        for (const object of kept) yield* sql.unsafe(object.sql);
      }),
    );
  }
});
