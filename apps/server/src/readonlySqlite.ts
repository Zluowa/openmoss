// FILE: readonlySqlite.ts
// Purpose: Open another program's SQLite database read-only under either Bun or Node.
// Layer: Persistence infrastructure
// Exports: openReadonlySqlite, sqliteTableNames, sqliteTableColumns

import { importBunSqlite } from "./sqliteRuntime";

export type SqliteRow = Record<string, unknown>;

export interface ReadonlySqliteDatabase {
  readonly all: (
    sql: string,
    ...params: ReadonlyArray<string | number>
  ) => ReadonlyArray<SqliteRow>;
  readonly exec: (sql: string) => void;
  readonly close: () => void;
}

interface RawStatement {
  all: (...params: ReadonlyArray<string | number>) => ReadonlyArray<SqliteRow>;
}

interface RawDatabase {
  prepare?: (sql: string) => RawStatement;
  query?: (sql: string) => RawStatement;
  exec: (sql: string) => unknown;
  close: () => unknown;
}

export async function openReadonlySqlite(path: string): Promise<ReadonlySqliteDatabase> {
  let raw: RawDatabase;
  if (process.versions.bun !== undefined) {
    // Keep Bun's runtime-only module out of the Node bundle.
    const { Database } = importBunSqlite() as {
      Database: new (file: string, options: { readonly: boolean }) => RawDatabase;
    };
    raw = new Database(path, { readonly: true });
  } else {
    const { DatabaseSync } = await import("node:sqlite");
    raw = new DatabaseSync(path, { readOnly: true }) as unknown as RawDatabase;
  }
  return {
    all: (sql, ...params) => {
      const statement = raw.prepare?.(sql) ?? raw.query?.(sql);
      if (!statement) throw new Error("The SQLite reader is unavailable.");
      return statement.all(...params);
    },
    exec: (sql) => {
      raw.exec(sql);
    },
    close: () => {
      raw.close();
    },
  };
}

export function sqliteTableNames(database: ReadonlySqliteDatabase): Set<string> {
  return new Set(
    database
      .all("SELECT name FROM sqlite_master WHERE type = 'table'")
      .flatMap((row) => (typeof row.name === "string" ? [row.name] : [])),
  );
}

export function sqliteTableColumns(database: ReadonlySqliteDatabase, table: string): Set<string> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(table)) throw new Error("Invalid SQLite table name.");
  return new Set(
    database
      .all(`PRAGMA table_info(${table})`)
      .flatMap((row) => (typeof row.name === "string" ? [row.name] : [])),
  );
}
