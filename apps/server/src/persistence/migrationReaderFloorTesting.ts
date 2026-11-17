// FILE: migrationReaderFloorTesting.ts
// Purpose: Test helpers for the migration reader floor: open a database the way an earlier
//          release would (the floor release first of all), stand in for a newer release on a
//          database file, and check that a migration declared additive is additive.
// Layer: Persistence test support
// Exports: runMigrationsAsRelease, runMigrationsAsFloorRelease, writeAsNewerRelease,
//          checkAdditiveMigration, AdditiveMigrationViolation

import { DatabaseSync } from "node:sqlite";

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Statement from "effect/unstable/sql/Statement";

import { MigrationReaderLatestId, encodeMigrationReaderFloor } from "./MigrationLineage.ts";
import { MIGRATION_READER_FLOOR, runMigrations, type RunMigrationsOptions } from "./Migrations.ts";

/**
 * Opens and migrates the current database as the release whose newest migration is
 * `releaseLatestMigrationId` would: that release's migration set and lineage rules, against a
 * database a newer migration set wrote. It fails exactly where that release would (too new
 * when the reader floor does not let it in).
 *
 * Every migration added to `MIGRATIONS_OLDER_READERS_MAY_IGNORE` is tested against the oldest
 * release the floor admits, with every additive migration above the floor applied together:
 * `runMigrations()`, then `runMigrationsAsFloorRelease()`, then that release's writes.
 */
export const runMigrationsAsRelease = (
  releaseLatestMigrationId: number,
  options: RunMigrationsOptions = {},
) =>
  runMigrations(options).pipe(
    Effect.provideService(MigrationReaderLatestId, releaseLatestMigrationId),
  );

/** Opens the database as the oldest release this build's reader floor admits. */
export const runMigrationsAsFloorRelease = (options: RunMigrationsOptions = {}) =>
  runMigrationsAsRelease(MIGRATION_READER_FLOOR, options);

export interface NewerReleaseMigration {
  readonly id: number;
  readonly name: string;
  /** Statements the newer release's migration runs. */
  readonly sql: string;
}

/**
 * Stands in for a newer Moss on a closed database file this build migrated: applies its extra
 * migrations, records them in the tracker, and writes its reader floor for the newest of
 * them (`{ raw }` writes any `user_version` instead, for missing or corrupt markers).
 */
export function writeAsNewerRelease(
  dbPath: string,
  input: {
    readonly migrations: ReadonlyArray<NewerReleaseMigration>;
    readonly readerFloor: number | { readonly raw: number };
  },
): void {
  const database = new DatabaseSync(dbPath);
  try {
    for (const migration of input.migrations) {
      database.exec(migration.sql);
      database
        .prepare("INSERT INTO effect_sql_migrations (migration_id, name) VALUES (?, ?)")
        .run(migration.id, migration.name);
    }
    const newest = input.migrations.at(-1)?.id;
    if (typeof input.readerFloor === "number" && newest === undefined) {
      throw new Error("A newer release writes its floor for the migrations it adds");
    }
    const marker =
      typeof input.readerFloor === "number"
        ? encodeMigrationReaderFloor(input.readerFloor, newest!)
        : input.readerFloor.raw;
    if (!Number.isSafeInteger(marker)) throw new Error(`Not an integer marker: ${marker}`);
    database.exec(`PRAGMA user_version = ${marker}`);
  } finally {
    database.close();
  }
}

export interface AdditiveMigrationViolation {
  readonly rule:
    | "changes-existing-table"
    | "not-null-without-default"
    | "unique-index-on-existing-table"
    | "trigger"
    | "foreign-key-into-existing-table"
    | "rewrites-existing-data";
  readonly detail: string;
}

interface SchemaColumn {
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: string | null;
  readonly pk: number;
}

interface SchemaSnapshot {
  readonly tables: ReadonlyMap<string, ReadonlyArray<SchemaColumn>>;
  readonly indexes: ReadonlyMap<string, { readonly table: string; readonly unique: boolean }>;
  readonly triggers: ReadonlySet<string>;
  /** JSON of [table, column, referenced table, ON DELETE action]. */
  readonly foreignKeys: ReadonlySet<string>;
}

const snapshotSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const master = yield* sql<{ readonly type: string; readonly name: string }>`
    SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`;
  const tables = new Map<string, ReadonlyArray<SchemaColumn>>();
  const indexes = new Map<string, { readonly table: string; readonly unique: boolean }>();
  const foreignKeys = new Set<string>();
  for (const { name } of master.filter((row) => row.type === "table")) {
    tables.set(
      name,
      yield* sql<SchemaColumn>`
        SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(${name}) ORDER BY cid`,
    );
    const indexList = yield* sql<{ readonly name: string; readonly unique: number }>`
      SELECT name, "unique" FROM pragma_index_list(${name})`;
    for (const index of indexList) {
      indexes.set(index.name, { table: name, unique: index.unique === 1 });
    }
    const keys = yield* sql<{
      readonly table: string;
      readonly from: string;
      readonly on_delete: string;
    }>`
      SELECT "table", "from", on_delete FROM pragma_foreign_key_list(${name})`;
    for (const key of keys) {
      foreignKeys.add(JSON.stringify([name, key.from, key.table, key.on_delete.toUpperCase()]));
    }
  }
  const triggers = new Set(master.filter((row) => row.type === "trigger").map((row) => row.name));
  return { tables, indexes, triggers, foreignKeys } satisfies SchemaSnapshot;
});

/** The columns an UPDATE's SET list assigns, read at parenthesis depth 0. */
function assignedColumns(setClause: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < setClause.length; index += 1) {
    const char = setClause[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(setClause.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(setClause.slice(start));
  return parts.flatMap((part) => {
    const match = /^\s*["`[]?(\w+)["`\]]?\s*=/u.exec(part);
    return match ? [match[1]!] : [];
  });
}

const DROP_OR_RENAME = /^(?:DROP\b|ALTER TABLE \S+ (?:RENAME|DROP)\b)/iu;
const ROW_WRITE = /^(?:INSERT(?: OR \w+)? INTO|REPLACE INTO|DELETE FROM) ["`[]?(\w+)/iu;
const UPDATE_SET = /^UPDATE ["`[]?(\w+)["`\]]? SET (.*?)(?: WHERE |$)/iu;

/**
 * Runs `migration` on the current database and reports every way it is not additive for an
 * older build (see `MIGRATIONS_OLDER_READERS_MAY_IGNORE`). The schema before and after is
 * compared (tables, columns, indexes, triggers, foreign keys), and the statements it runs are
 * read for drops, renames and writes to data that existed before. An UPDATE may only set
 * columns this migration added (a backfill).
 */
export const checkAdditiveMigration = <E, R>(migration: Effect.Effect<unknown, E, R>) =>
  Effect.gen(function* () {
    const before = yield* snapshotSchema;
    const statements: string[] = [];
    const record: Statement.Transformer = (statement) =>
      Effect.sync(() => {
        statements.push(statement.compile()[0]);
        return statement;
      });
    yield* migration.pipe(Effect.provideService(Statement.CurrentTransformer, record));
    const after = yield* snapshotSchema;
    const violations: AdditiveMigrationViolation[] = [];
    const existed = (table: string) => before.tables.has(table);

    for (const [table, columns] of before.tables) {
      const next = after.tables.get(table);
      if (!next) {
        violations.push({ rule: "changes-existing-table", detail: `drops table ${table}` });
        continue;
      }
      for (const column of columns) {
        const now = next.find((candidate) => candidate.name === column.name);
        if (!now || JSON.stringify(now) !== JSON.stringify(column)) {
          violations.push({
            rule: "changes-existing-table",
            detail: `changes or drops ${table}.${column.name}`,
          });
        }
      }
      for (const column of next) {
        if (columns.some((candidate) => candidate.name === column.name)) continue;
        if (column.notnull === 1 && column.dflt_value === null) {
          violations.push({
            rule: "not-null-without-default",
            detail: `${table}.${column.name} is NOT NULL without a default`,
          });
        }
      }
    }
    for (const [name, index] of after.indexes) {
      if (index.unique && existed(index.table) && before.indexes.get(name)?.unique !== true) {
        violations.push({
          rule: "unique-index-on-existing-table",
          detail: `${name} is a UNIQUE index on ${index.table}`,
        });
      }
    }
    for (const name of after.triggers) {
      if (!before.triggers.has(name)) {
        violations.push({ rule: "trigger", detail: `adds trigger ${name}` });
      }
    }
    for (const key of after.foreignKeys) {
      if (before.foreignKeys.has(key)) continue;
      const [table, from, target, onDelete] = JSON.parse(key) as [string, string, string, string];
      if (existed(target) && onDelete !== "CASCADE" && onDelete !== "SET NULL") {
        violations.push({
          rule: "foreign-key-into-existing-table",
          detail: `${table}.${from} references ${target} with ON DELETE ${onDelete}`,
        });
      }
    }
    for (const statement of statements) {
      const text = statement
        .replace(/--[^\n]*/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
      if (DROP_OR_RENAME.test(text)) {
        violations.push({ rule: "changes-existing-table", detail: text.slice(0, 120) });
        continue;
      }
      const write = ROW_WRITE.exec(text);
      if (write && existed(write[1]!)) {
        violations.push({ rule: "rewrites-existing-data", detail: text.slice(0, 120) });
        continue;
      }
      const update = UPDATE_SET.exec(text);
      if (update && existed(update[1]!)) {
        const table = update[1]!;
        const previousColumns = before.tables.get(table) ?? [];
        const rewritten = assignedColumns(update[2]!).filter((column) =>
          previousColumns.some((candidate) => candidate.name === column),
        );
        if (rewritten.length > 0) {
          violations.push({
            rule: "rewrites-existing-data",
            detail: `UPDATE ${table} sets ${rewritten.join(", ")}`,
          });
        }
      }
    }
    return violations;
  });
