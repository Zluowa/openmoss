// FILE: schemaHelpers.ts
// Purpose: Shared SQLite schema-introspection helpers for idempotent migrations.
// Layer: Server persistence migrations
// Exports: columnExists, tableExists, primaryKeyColumnNames, assertTableShape,
//   assertPendingInteractionsTableShape

import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

// Checks SQLite table metadata without relying on driver-specific duplicate-column errors.
export const columnExists = (sql: SqlClient.SqlClient, tableName: string, columnName: string) =>
  sql<{ readonly exists: number }>`
    SELECT EXISTS(
      SELECT 1
      FROM pragma_table_info(${tableName})
      WHERE name = ${columnName}
    ) AS "exists"
  `.pipe(Effect.map(([row]) => row?.exists === 1));

export const tableExists = (sql: SqlClient.SqlClient, tableName: string) =>
  sql<{ readonly exists: number }>`
    SELECT EXISTS(
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table' AND name = ${tableName}
    ) AS "exists"
  `.pipe(Effect.map(([row]) => row?.exists === 1));

export const primaryKeyColumnNames = (sql: SqlClient.SqlClient, tableName: string) =>
  sql<{ readonly name: string }>`
    SELECT name
    FROM pragma_table_info(${tableName})
    WHERE pk > 0
    ORDER BY pk ASC
  `.pipe(Effect.map((rows) => rows.map((row) => row.name)));

const columnNames = (sql: SqlClient.SqlClient, tableName: string) =>
  sql<{ readonly name: string }>`
    SELECT name
    FROM pragma_table_info(${tableName})
    ORDER BY cid ASC
  `.pipe(Effect.map((rows) => rows.map((row) => row.name)));

/**
 * Refuse to treat a same-named table as an already-applied migration unless it
 * has every column the migration depends on and the exact durable identity.
 * Additional columns are allowed so replaying an older lineage preserves data
 * added by later migrations.
 */
export const assertTableShape = (
  sql: SqlClient.SqlClient,
  tableName: string,
  requiredColumns: ReadonlyArray<string>,
  expectedPrimaryKey: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const actualColumns = yield* columnNames(sql, tableName);
    const actualColumnSet = new Set(actualColumns);
    const missingColumns = requiredColumns.filter((column) => !actualColumnSet.has(column));
    const actualPrimaryKey = yield* primaryKeyColumnNames(sql, tableName);
    const primaryKeyMatches =
      actualPrimaryKey.length === expectedPrimaryKey.length &&
      actualPrimaryKey.every((column, index) => column === expectedPrimaryKey[index]);

    if (missingColumns.length === 0 && primaryKeyMatches) {
      return;
    }

    const problems: Array<string> = [];
    if (missingColumns.length > 0) {
      problems.push(`missing required columns (${missingColumns.join(", ")})`);
    }
    if (!primaryKeyMatches) {
      problems.push(
        `expected primary key (${expectedPrimaryKey.join(", ")}), found (${actualPrimaryKey.join(", ") || "none"})`,
      );
    }
    return yield* Effect.fail(
      new Error(`Incompatible SQLite schema for ${tableName}: ${problems.join("; ")}`),
    );
  });

const pendingInteractionRequiredColumns = [
  "interaction_kind",
  "request_id",
  "thread_id",
  "turn_id",
  "lifecycle_generation",
  "status",
  "decision",
  "response_command_id",
  "response_requested_at",
  "created_at",
  "resolved_at",
] as const;

export const assertPendingInteractionsTableShape = (sql: SqlClient.SqlClient) =>
  assertTableShape(sql, "projection_pending_interactions", pendingInteractionRequiredColumns, [
    "thread_id",
    "interaction_kind",
    "request_id",
  ]);
