import { assert, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations";
import * as NodeSqliteClient from "../NodeSqliteClient";
import migration from "./162_PageGuestAuthors";

const oldColumns =
  "page_id, revision, page_json, content, rich_content, operation, author, author_thread_id, created_at";
const prepare161 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 161 });
  const tracker = yield* sql<{
    id: number;
  }>`SELECT max(migration_id) AS id FROM effect_sql_migrations`;
  assert.strictEqual(tracker[0]?.id, 161);
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_thread_messages)`;
  assert.ok(columns.some((row) => row.name === "dispatch_source_thread_id"));
  yield* sql`PRAGMA foreign_keys = ON`;
  yield* sql`INSERT INTO pages_documents (page_id, scope_key, root_page_id, title, revision, created_at, updated_at)
    VALUES ('legacy-page', 'local-default', 'legacy-page', '旧页面', 2, '2026-11-06', '2026-11-06')`;
  for (const [revision, author, thread] of [
    [1, "local-user", null],
    [2, "agent", "old-thread"],
  ] as const) {
    yield* sql`INSERT INTO pages_versions (page_id, revision, page_json, content, rich_content, operation, author, author_thread_id, created_at)
      VALUES ('legacy-page', ${revision}, ${'{ "keep": "原字节\\n" }'}, ${"中文\u0000tail"}, ${' [ {"text":"不重写"} ] '}, 'update', ${author}, ${thread}, '2026-11-06')`;
  }
  yield* sql`CREATE INDEX idx_guest_upgrade_fixture ON pages_versions(created_at, revision)`;
  return sql;
});

it.effect(
  "upgrades real 161 to 162 without rewriting old bytes, indexes or foreign keys; replays safely",
  () =>
    Effect.gen(function* () {
      const sql = yield* prepare161;
      const before = yield* sql.unsafe(
        `SELECT ${oldColumns} FROM pages_versions ORDER BY revision`,
      );
      const indexes =
        yield* sql`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='pages_versions' ORDER BY name`;
      const foreignKeys = yield* sql`PRAGMA foreign_key_list(pages_versions)`;
      yield* runMigrations({ toMigrationInclusive: 162 });
      assert.deepStrictEqual(
        yield* sql.unsafe(`SELECT ${oldColumns} FROM pages_versions ORDER BY revision`),
        before,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='pages_versions' ORDER BY name`,
        indexes,
      );
      assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_list(pages_versions)`, foreignKeys);
      assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
      yield* migration;
      assert.deepStrictEqual(
        yield* sql.unsafe(`SELECT ${oldColumns} FROM pages_versions ORDER BY revision`),
        before,
      );
      assert.deepStrictEqual(yield* sql`SELECT DISTINCT author_guest_ref FROM pages_versions`, [
        { author_guest_ref: null },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect(
  "enforces guest digest/thread and owner constraints without widening comments or typed authors",
  () =>
    Effect.gen(function* () {
      const sql = yield* prepare161;
      yield* runMigrations({ toMigrationInclusive: 162 });
      const insert = (
        author: string,
        ref: string | null,
        thread: string | null,
      ) => sql`INSERT INTO pages_versions
    (page_id, revision, page_json, content, operation, author, author_thread_id, created_at, author_guest_ref)
    VALUES ('legacy-page', 3, '{}', 'guest text', 'update', ${author}, ${thread}, '2026-11-06', ${ref})`;
      for (const [author, ref, thread] of [
        ["guest", null, null],
        ["guest", "a".repeat(63), null],
        ["guest", "G".repeat(64), null],
        ["guest", "a".repeat(64), "thread"],
        ["local-user", "a".repeat(64), null],
      ] as const)
        assert.ok(Exit.isFailure(yield* Effect.exit(insert(author, ref, thread))));
      yield* insert("guest", "a".repeat(64), null);
      assert.ok(Exit.isFailure(yield* Effect.exit(insert("guest", "a".repeat(64), null))));
      assert.ok(
        Exit.isFailure(
          yield* Effect.exit(sql`INSERT INTO pages_versions
    (page_id, revision, page_json, content, operation, author, created_at, author_guest_ref)
    VALUES ('missing-page', 1, '{}', 'x', 'update', 'guest', '2026-11-06', ${"a".repeat(64)})`),
        ),
      );
      const comment = yield* Effect.exit(sql`INSERT INTO pages_comments
    (comment_id, page_id, revision, content, author, created_at) VALUES ('comment', 'legacy-page', 3, 'x', 'guest', '2026-11-06')`);
      assert.ok(Exit.isFailure(comment));
      for (const table of ["pages_item_data", "page_app_versions", "pages_drafts"]) {
        const rows = yield* sql<{ sql: string }>`SELECT sql FROM sqlite_master WHERE name=${table}`;
        if (rows[0]) assert.ok(!rows[0].sql.includes("'guest'"));
      }
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("rolls back a failed table copy and retains the 161 tracker and original rows", () =>
  Effect.gen(function* () {
    const sql = yield* prepare161;
    yield* sql`PRAGMA ignore_check_constraints = ON`;
    yield* sql`UPDATE pages_versions SET author = 'invalid-legacy' WHERE revision=2`;
    yield* sql`PRAGMA ignore_check_constraints = OFF`;
    const before = yield* sql`SELECT * FROM pages_versions ORDER BY revision`;
    assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations({ toMigrationInclusive: 162 }))));
    assert.deepStrictEqual(yield* sql`SELECT * FROM pages_versions ORDER BY revision`, before);
    assert.deepStrictEqual(yield* sql`SELECT max(migration_id) AS id FROM effect_sql_migrations`, [
      { id: 161 },
    ]);
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM sqlite_master WHERE name='pages_versions_guest_upgrade'`,
      [],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
