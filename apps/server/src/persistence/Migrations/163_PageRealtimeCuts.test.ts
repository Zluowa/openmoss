import { assert, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { appendRoomUpdate, commitRoomCheckpoint } from "../../pages/realtime/pageRoomPublication";
import { runMigrations } from "../Migrations";
import * as NodeSqliteClient from "../NodeSqliteClient";
import migration from "./163_PageRealtimeCuts";

const legacy = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 162 });
  assert.deepStrictEqual(yield* sql`SELECT max(migration_id) AS id FROM effect_sql_migrations`, [
    { id: 162 },
  ]);
  yield* sql`INSERT INTO pages_documents(page_id,scope_key,root_page_id,title,revision,created_at,updated_at)
    VALUES ('p','local-default','p','原页面',1,'old','old')`;
  yield* sql`INSERT INTO pages_versions(page_id,revision,page_json,content,operation,author,created_at)
    VALUES ('p',1,'{ "keep": "原字节" }','原正文','create','local-user','old')`;
  yield* sql`INSERT INTO pages_realtime_docs(page_id,generation,state,compacted_revision,compacted_key,updated_at)
    VALUES ('p','g',${Uint8Array.of(0, 255, 1)},1,'old-key','old')`;
  for (const seq of [3, 8])
    yield* sql`INSERT INTO pages_realtime_updates(page_id,seq,generation,update_data,created_at)
    VALUES ('p',${seq},'g',${Uint8Array.of(seq, 0, 254)},'old')`;
  return sql;
});

it.effect(
  "upgrades real 162 bytes and null legacy author records without inventing contributors",
  () =>
    Effect.gen(function* () {
      const sql = yield* legacy;
      const original = () =>
        Effect.all([
          sql`SELECT * FROM pages_versions`,
          sql`SELECT page_id,generation,state,compacted_revision,compacted_key,updated_at FROM pages_realtime_docs`,
          sql`SELECT page_id,seq,generation,update_data,created_at FROM pages_realtime_updates ORDER BY seq`,
        ]);
      const before = yield* original();
      yield* runMigrations();
      assert.deepStrictEqual(yield* original(), before);
      assert.deepStrictEqual(
        yield* sql`SELECT next_sequence,compacted_through_sequence FROM pages_realtime_docs`,
        [{ next_sequence: 9, compacted_through_sequence: 0 }],
      );
      assert.deepStrictEqual(
        yield* sql`SELECT DISTINCT contributors_json FROM pages_realtime_updates`,
        [{ contributors_json: null }],
      );
      assert.deepStrictEqual(yield* sql`SELECT * FROM pages_version_contributors`, []);
      assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
      assert.deepStrictEqual(
        yield* sql`SELECT "table", "from", "to" FROM pragma_foreign_key_list('pages_version_contributors') ORDER BY seq`,
        [
          { table: "pages_versions", from: "page_id", to: "page_id" },
          { table: "pages_versions", from: "revision", to: "revision" },
        ],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect(
  "prunes only a fixed generation prefix and never reuses sequence after a full prune or replay",
  () =>
    Effect.gen(function* () {
      const sql = yield* legacy;
      yield* runMigrations();
      assert.strictEqual(yield* appendRoomUpdate(sql, "p", "g", Uint8Array.of(9), []), 9);
      const cut = {
        generation: "g",
        state: Uint8Array.of(1),
        revision: 1,
        key: "old-key",
        throughSequence: 8,
      };
      yield* commitRoomCheckpoint(sql, "p", cut);
      assert.deepStrictEqual(yield* sql`SELECT seq FROM pages_realtime_updates`, [{ seq: 9 }]);
      assert.strictEqual(yield* appendRoomUpdate(sql, "p", "g", Uint8Array.of(10), []), 10);
      yield* commitRoomCheckpoint(sql, "p", { ...cut, throughSequence: 10 });
      assert.deepStrictEqual(yield* sql`SELECT seq FROM pages_realtime_updates`, []);
      yield* migration;
      assert.strictEqual(yield* appendRoomUpdate(sql, "p", "g", Uint8Array.of(11), []), 11);
      assert.ok(Exit.isFailure(yield* Effect.exit(commitRoomCheckpoint(sql, "p", cut))));
      assert.ok(
        Exit.isFailure(
          yield* Effect.exit(
            commitRoomCheckpoint(sql, "p", { ...cut, generation: "wrong", throughSequence: 11 }),
          ),
        ),
      );
      assert.ok(
        Exit.isFailure(
          yield* Effect.exit(appendRoomUpdate(sql, "p", "wrong", Uint8Array.of(12), [])),
        ),
      );
      assert.deepStrictEqual(yield* sql`SELECT seq FROM pages_realtime_updates`, [{ seq: 11 }]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("rolls back an incomplete schema upgrade and leaves the canonical 162 tracker", () =>
  Effect.gen(function* () {
    const sql = yield* legacy;
    yield* sql`CREATE INDEX pages_version_contributors ON pages_versions(created_at)`;
    assert.ok(Exit.isFailure(yield* Effect.exit(runMigrations())));
    assert.deepStrictEqual(yield* sql`SELECT max(migration_id) AS id FROM effect_sql_migrations`, [
      { id: 162 },
    ]);
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM pragma_table_info('pages_realtime_docs') WHERE name='next_sequence'`,
      [],
    );
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM pragma_table_info('pages_realtime_updates') WHERE name='contributors_json'`,
      [],
    );
    assert.deepStrictEqual(yield* sql`SELECT seq FROM pages_realtime_updates ORDER BY seq`, [
      { seq: 3 },
      { seq: 8 },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
