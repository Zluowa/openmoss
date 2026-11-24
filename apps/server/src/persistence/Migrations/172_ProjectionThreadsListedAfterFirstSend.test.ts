import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe } from "vitest";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration0172 from "./172_ProjectionThreadsListedAfterFirstSend.ts";

const columnsOf = (sql: SqlClient.SqlClient) =>
  sql<{
    readonly name: string;
    readonly type: string;
    readonly notnull: number;
    readonly dflt_value: string | null;
  }>`SELECT name, type, "notnull", dflt_value FROM pragma_table_info('projection_threads')`;

/** A thread row as the previous schema (171) writes it: every required column, by name. */
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

describe("172_ProjectionThreadsListedAfterFirstSend", () => {
  it.effect(
    "adds a nullable column to a store that already has threads, touching nothing else",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 171 });
        yield* insertThreadRow(sql, "thread-before");
        // A fresh statement text each read: a cached `SELECT *` keeps the columns it was prepared with.
        const [before] = yield* sql.unsafe<Record<string, unknown>>(
          "SELECT * FROM projection_threads WHERE thread_id = 'thread-before' /* before */",
        );

        yield* runMigrations({ toMigrationInclusive: 172 });

        const column = (yield* columnsOf(sql)).find((c) => c.name === "listed_after_first_send");
        assert.isDefined(column);
        assert.equal(column!.notnull, 0);
        assert.isNull(column!.dflt_value);
        const [after] = yield* sql.unsafe<Record<string, unknown>>(
          "SELECT * FROM projection_threads WHERE thread_id = 'thread-before' /* after */",
        );
        // No backfill: an existing thread is listed as before; every other column as it was.
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
      yield* runMigrations({ toMigrationInclusive: 172 });
      assert.isDefined((yield* columnsOf(sql)).find((c) => c.name === "listed_after_first_send"));
      // Running the body again (an interrupted start) changes nothing and does not fail.
      yield* Migration0172;
      const columns = (yield* columnsOf(sql)).filter((c) => c.name === "listed_after_first_send");
      assert.lengthOf(columns, 1);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("an older build writing by named columns neither fails nor clears the mark", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 172 });
      // An older build inserts the columns it knows; the new one stays null (listed as before).
      yield* insertThreadRow(sql, "thread-older");
      const [inserted] = yield* sql<{ readonly listed: number | null }>`
        SELECT listed_after_first_send AS listed FROM projection_threads
        WHERE thread_id = 'thread-older'
      `;
      assert.isNull(inserted!.listed);
      // A newer build marked a warm-up chat; an older build then updates it by named columns.
      yield* sql`
        UPDATE projection_threads SET listed_after_first_send = 1 WHERE thread_id = 'thread-older'
      `;
      yield* sql`UPDATE projection_threads SET title = 'renamed' WHERE thread_id = 'thread-older'`;
      const [updated] = yield* sql<{ readonly listed: number | null; readonly title: string }>`
        SELECT listed_after_first_send AS listed, title FROM projection_threads
        WHERE thread_id = 'thread-older'
      `;
      assert.equal(updated!.listed, 1);
      assert.equal(updated!.title, "renamed");
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
