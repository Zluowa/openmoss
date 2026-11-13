import { assert, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations";
import * as NodeSqliteClient from "../NodeSqliteClient";
import migration from "./168_PageItemKindsOpen";

it.effect("opens typed item kinds in 168 without losing rows or indexes; replays safely", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 167 });
    yield* sql`PRAGMA foreign_keys = ON`;
    yield* sql`INSERT INTO pages_documents (page_id, scope_key, root_page_id, title, revision, created_at, updated_at)
      VALUES ('deck', 'local-default', 'deck', '旧幻灯片', 1, '2026-11-13', '2026-11-13')`;
    yield* sql`INSERT INTO pages_item_data (page_id, revision, kind, data, author, author_thread_id, created_at)
      VALUES ('deck', 1, 'slides', '{"version":2}', 'agent', 'thread-1', '2026-11-13')`;
    yield* sql`INSERT INTO pages_templates (template_id, scope_key, kind, title, created_at)
      VALUES ('tpl_1', 'local-default', 'sheet', '预算', '2026-11-13')`;
    const designBefore = yield* Effect.exit(
      sql`INSERT INTO pages_item_data (page_id, revision, kind, data, author, created_at)
        VALUES ('deck', 2, 'design', '{}', 'local-user', '2026-11-13')`,
    );
    assert.ok(Exit.isFailure(designBefore), "167 still pins the kinds");
    const indexes =
      yield* sql`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='pages_templates' ORDER BY name`;

    yield* runMigrations({ toMigrationInclusive: 168 });
    yield* sql`INSERT INTO pages_item_data (page_id, revision, kind, data, author, created_at)
      VALUES ('deck', 2, 'design', '{}', 'local-user', '2026-11-13')`;
    yield* sql`INSERT INTO pages_templates (template_id, scope_key, kind, title, created_at)
      VALUES ('tpl_2', 'local-default', 'design', '落地页', '2026-11-13')`;
    assert.deepStrictEqual(
      yield* sql`SELECT revision, kind, author, author_thread_id FROM pages_item_data ORDER BY revision`,
      [
        { revision: 1, kind: "slides", author: "agent", author_thread_id: "thread-1" },
        { revision: 2, kind: "design", author: "local-user", author_thread_id: null },
      ],
    );
    assert.deepStrictEqual(
      yield* sql`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='pages_templates' ORDER BY name`,
      indexes,
    );
    assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
    const badAuthor = yield* Effect.exit(
      sql`INSERT INTO pages_item_data (page_id, revision, kind, data, author, created_at)
        VALUES ('deck', 3, 'design', '{}', 'stranger', '2026-11-13')`,
    );
    assert.ok(Exit.isFailure(badAuthor), "the author check stays");
    yield* migration;
    assert.strictEqual(
      (yield* sql<{ n: number }>`SELECT count(*) AS n FROM pages_templates`)[0]?.n,
      2,
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
