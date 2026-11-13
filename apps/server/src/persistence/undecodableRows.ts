// FILE: undecodableRows.ts
// Purpose: Bulk-decode projection rows, and when one row does not decode, skip it
//          with a privacy-safe reason instead of failing the whole read.
// Layer: Persistence
// Exports: UndecodableRow, DecodedRows, findAllSkippingUndecodable,
//          decodeEachSkippingUndecodable, readRowId, makeUndecodableRowReporter
// Why: the server builds its read model from these tables at startup. One odd row
//      (an import, a crash mid-write, a migration bug) used to stop the server from
//      starting at all. A skipped row stays in the table untouched.

import { Effect, Schema } from "effect";

import { describeSchemaIssue } from "./Errors.ts";

/** A row left out of a read, named by its id. Never carries the row's content. */
export interface UndecodableRow {
  readonly id: string;
  readonly reason: string;
  /** The row was already soft-deleted, so nobody would have seen it anyway. */
  readonly deleted?: boolean;
}

export interface DecodedRows<A> {
  readonly rows: Array<A>;
  readonly skipped: ReadonlyArray<UndecodableRow>;
}

const MAX_ID_CHARS = 128;
const MAX_LOGGED_ROWS = 20;

/** Reads a row's id column defensively: the row is, by definition, malformed. */
export function readRowId(row: unknown, ...keys: ReadonlyArray<string>): string {
  if (typeof row !== "object" || row === null) return "unknown";
  const parts = keys.map((key) => {
    const value = (row as Record<string, unknown>)[key];
    return typeof value === "string" || typeof value === "number" ? String(value) : "unknown";
  });
  const id = parts.join("/");
  return id.length > MAX_ID_CHARS ? `${id.slice(0, MAX_ID_CHARS)}…` : id;
}

/**
 * Decodes every row in one bulk call, the cost every healthy database pays.
 * Only when that fails does it decode row by row, keep what decodes and name
 * the rest.
 */
export function decodeEachSkippingUndecodable<I, A, E, R = never>(input: {
  readonly rows: ReadonlyArray<I>;
  readonly decodeAll: (rows: ReadonlyArray<I>) => Effect.Effect<Array<A>, E, R>;
  readonly decodeOne: (row: I) => Effect.Effect<A, E, R>;
  readonly rowId: (row: I) => string;
  readonly rowDeleted?: (row: I) => boolean;
  readonly describe: (error: E) => string;
}): Effect.Effect<DecodedRows<A>, never, R> {
  return input.decodeAll(input.rows).pipe(
    Effect.map((rows): DecodedRows<A> => ({ rows, skipped: [] })),
    Effect.catch(() =>
      Effect.gen(function* () {
        const rows: Array<A> = [];
        const skipped: Array<UndecodableRow> = [];
        for (const row of input.rows) {
          const result = yield* Effect.result(input.decodeOne(row));
          if (result._tag === "Success") {
            rows.push(result.success);
          } else {
            skipped.push({
              id: input.rowId(row),
              reason: input.describe(result.failure),
              ...(input.rowDeleted?.(row) ? { deleted: true } : {}),
            });
          }
        }
        return { rows, skipped };
      }),
    ),
  );
}

/**
 * `SqlSchema.findAll`, except that a row that does not decode is skipped and
 * named instead of failing the whole query. Query and request errors still fail.
 */
export function findAllSkippingUndecodable<
  Req extends Schema.Top,
  Res extends Schema.Top,
  E,
  R,
>(options: {
  readonly Request: Req;
  readonly Result: Res;
  readonly execute: (request: Req["Encoded"]) => Effect.Effect<ReadonlyArray<unknown>, E, R>;
  readonly rowId: (row: unknown) => string;
  readonly rowDeleted?: (row: unknown) => boolean;
}) {
  const encodeRequest = Schema.encodeEffect(options.Request);
  const decodeAll = Schema.decodeUnknownEffect(Schema.mutable(Schema.Array(options.Result)));
  const decodeOne = Schema.decodeUnknownEffect(options.Result);
  return (
    request: Req["Encoded"],
  ): Effect.Effect<
    DecodedRows<Res["Type"]>,
    E | Schema.SchemaError,
    Req["EncodingServices"] | Res["DecodingServices"] | R
  > =>
    encodeRequest(request).pipe(
      Effect.flatMap(options.execute),
      Effect.flatMap((rows) =>
        decodeEachSkippingUndecodable({
          rows,
          decodeAll,
          decodeOne,
          rowId: options.rowId,
          ...(options.rowDeleted ? { rowDeleted: options.rowDeleted } : {}),
          describe: (error: Schema.SchemaError) => describeSchemaIssue(error.issue),
        }),
      ),
    );
}

/**
 * Logs skipped rows once per table and reader: a reader that runs on every
 * client connect must not repeat the same warning, but a different set of
 * skipped rows is reported again.
 */
export function makeUndecodableRowReporter() {
  const lastReported = new Map<string, string>();
  return (input: {
    readonly table: string;
    readonly reader: string;
    readonly skipped: ReadonlyArray<UndecodableRow>;
  }): Effect.Effect<void> =>
    Effect.suspend(() => {
      const key = `${input.table}\u0000${input.reader}`;
      if (input.skipped.length === 0) {
        lastReported.delete(key);
        return Effect.void;
      }
      const fingerprint = input.skipped.map((row) => `${row.id}\u0000${row.reason}`).join("\n");
      if (lastReported.get(key) === fingerprint) return Effect.void;
      lastReported.set(key, fingerprint);
      const listed = input.skipped.slice(0, MAX_LOGGED_ROWS);
      return Effect.logWarning(
        "skipped projection rows that could not be read; they stay in the database unchanged",
      ).pipe(
        Effect.annotateLogs({
          table: input.table,
          reader: input.reader,
          skippedRowCount: input.skipped.length,
          rows: listed.map((row) => `${row.id}: ${row.reason}`).join(" | "),
          ...(input.skipped.length > listed.length
            ? { omittedRowCount: input.skipped.length - listed.length }
            : {}),
        }),
      );
    });
}

/** Reads a row's `deletedAt` column defensively. */
export function readRowDeleted(row: unknown): boolean {
  if (typeof row !== "object" || row === null) return false;
  const deletedAt = (row as Record<string, unknown>).deletedAt;
  return deletedAt !== null && deletedAt !== undefined;
}
