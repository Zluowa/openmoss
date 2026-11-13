// FILE: undecodableRows.test.ts
// Purpose: Covers the bulk-first decode, the per-row fallback and the value-free reasons.
// Layer: Persistence test

import { Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  decodeEachSkippingUndecodable,
  findAllSkippingUndecodable,
  readRowId,
} from "./undecodableRows.ts";

const Row = Schema.Struct({
  id: Schema.String,
  title: Schema.String.check(Schema.isMaxLength(5)),
  payload: Schema.fromJsonString(Schema.Struct({ ok: Schema.Boolean })),
});

describe("decodeEachSkippingUndecodable", () => {
  it("decodes in bulk and never row by row when every row is fine", async () => {
    const decodeAll = vi.fn((rows: ReadonlyArray<number>) => Effect.succeed(rows.map(String)));
    const decodeOne = vi.fn((row: number) => Effect.succeed(String(row)));
    const result = await Effect.runPromise(
      decodeEachSkippingUndecodable({
        rows: [1, 2, 3],
        decodeAll,
        decodeOne,
        rowId: String,
        describe: String,
      }),
    );
    expect(result).toEqual({ rows: ["1", "2", "3"], skipped: [] });
    expect(decodeAll).toHaveBeenCalledOnce();
    expect(decodeOne).not.toHaveBeenCalled();
  });

  it("falls back to row by row only after the bulk decode fails, keeping order", async () => {
    const result = await Effect.runPromise(
      decodeEachSkippingUndecodable({
        rows: [1, 2, 3],
        decodeAll: () => Effect.fail("bulk failed"),
        decodeOne: (row: number) =>
          row === 2 ? Effect.fail(`row ${row} is bad`) : Effect.succeed(row * 10),
        rowId: (row) => `id-${row}`,
        describe: (error) => error,
      }),
    );
    expect(result).toEqual({ rows: [10, 30], skipped: [{ id: "id-2", reason: "row 2 is bad" }] });
  });
});

describe("findAllSkippingUndecodable", () => {
  it("keeps the rows that decode and names the one that does not", async () => {
    const find = findAllSkippingUndecodable({
      Request: Schema.Void,
      Result: Row,
      rowId: (row) => readRowId(row, "id"),
      execute: () =>
        Effect.succeed([
          { id: "a", title: "ok", payload: '{"ok":true}' },
          { id: "b", title: "a private title", payload: '{"ok":true}' },
          { id: "c", title: "ok", payload: '{"ok":false}' },
        ]),
    });
    const result = await Effect.runPromise(find(undefined));
    expect(result.rows.map((row) => row.id)).toEqual(["a", "c"]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.id).toBe("b");
    expect(result.skipped[0]?.reason).toMatch(/^Expected .*, got string at \["title"\]$/u);
    expect(result.skipped[0]?.reason).not.toContain("private");
  });

  it("still fails when the query itself fails", async () => {
    const find = findAllSkippingUndecodable({
      Request: Schema.Void,
      Result: Row,
      rowId: (row) => readRowId(row, "id"),
      execute: () => Effect.fail(new Error("no such table")),
    });
    await expect(Effect.runPromise(find(undefined))).rejects.toThrow("no such table");
  });
});

describe("readRowId", () => {
  it("reads ids defensively from a malformed row", () => {
    expect(readRowId({ threadId: "t", turnId: 3 }, "threadId", "turnId")).toBe("t/3");
    expect(readRowId({ threadId: null }, "threadId")).toBe("unknown");
    expect(readRowId(null, "threadId")).toBe("unknown");
  });
});
