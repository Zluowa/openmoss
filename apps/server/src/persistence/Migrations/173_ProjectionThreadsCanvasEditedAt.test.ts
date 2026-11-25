import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe } from "vitest";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration0173 from "./173_ProjectionThreadsCanvasEditedAt.ts";

const columnsOf = (sql: SqlClient.SqlClient) =>
  sql<{
    readonly name: string;
    readonly type: string;
    readonly notnull: number;
    readonly dflt_value: string | null;
  }>`SELECT name, type, "notnull", dflt_value FROM pragma_table_info('projection_threads')`;

/** A thread row as the previous schema (172) holds it: every required column filled. */
const insertThreadRow = (sql: SqlClient.SqlClient, threadId: string) =>
  Effect.gen(function* () {
    const required = (yield* columnsOf(sql)).filter(
      (column) => column.notnull === 1 && column.dflt_value === null,
    );
    const names = ["thread_id", ...required.map((c) => c.name).filter((n) => n !== "thread_id")];
    const values = names.map((name) => {
      if (name === "thread_id") return `'${threadId}'`;
      const column = required.find((c) => c.name === name)!;
      return /INT|REAL|NUM/iu.test(column.type) ? "0" : `'x'`;
    });
    yield* sql.unsafe(
      `INSERT INTO projection_threads (${names.join(", ")}) VALUES (${values.join(", ")})`,
    );
  });

describe("173_ProjectionThreadsCanvasEditedAt", () => {
  it.effect(
    "adds a nullable column to a store that already has threads, touching nothing else",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 172 });
        yield* insertThreadRow(sql, "thread-before");
        const [before] = yield* sql<Record<string, unknown>>`
        SELECT * FROM projection_threads WHERE thread_id = 'thread-before'
      `;

        yield* runMigrations({ toMigrationInclusive: 173 });

        const column = (yield* columnsOf(sql)).find((c) => c.name === "canvas_edited_at");
        assert.isDefined(column);
        assert.equal(column!.notnull, 0);
        assert.isNull(column!.dflt_value);
        // A new statement text: a cached `SELECT *` would keep the columns it was prepared with.
        const [after] = yield* sql<Record<string, unknown>>`
        SELECT * FROM projection_threads WHERE thread_id = 'thread-before' AND 1 = 1
      `;
        // No backfill: null means "no 画布 with content"; every other column as it was. (The
        // client may rename result columns, so the new one is found as the only added key.)
        const added = Object.keys(after!).filter((key) => !(key in before!));
        assert.lengthOf(added, 1);
        assert.isNull(after![added[0]!]);
        for (const [key, value] of Object.entries(before!))
          assert.deepStrictEqual(after![key], value);
      }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("adds it to an empty store, and is safe to run twice", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 173 });
      assert.isDefined((yield* columnsOf(sql)).find((c) => c.name === "canvas_edited_at"));
      // Running the body again (an interrupted start) changes nothing and does not fail.
      yield* Migration0173;
      const columns = (yield* columnsOf(sql)).filter((c) => c.name === "canvas_edited_at");
      assert.lengthOf(columns, 1);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
