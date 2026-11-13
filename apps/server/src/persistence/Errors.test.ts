import { describe, expect, it } from "vitest";
import { Cause, Effect, Result, Schema } from "effect";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  RedactedSchemaError,
  describeSchemaIssue,
  redactSchemaErrorsInCause,
  toPersistenceDecodeError,
  toPersistenceSqlError,
  toPersistenceSqlOrDecodeError,
} from "./Errors.ts";

function captureSchemaError(): Schema.SchemaError {
  const result = Effect.runSync(Schema.decodeUnknownEffect(Schema.String)(42).pipe(Effect.result));
  if (Result.isFailure(result) && Schema.isSchemaError(result.failure)) {
    return result.failure;
  }
  throw new Error("Expected schema decoding to fail.");
}

describe("toPersistenceSqlOrDecodeError", () => {
  it("maps schema failures to the decode operation", () => {
    const cause = captureSchemaError();
    const error = toPersistenceSqlOrDecodeError("repository.query", "repository.decode")(cause);

    expect(error).toBeInstanceOf(PersistenceDecodeError);
    expect(error.operation).toBe("repository.decode");
    expect(error.cause).toBeInstanceOf(RedactedSchemaError);
    expect((error as PersistenceDecodeError).issue).toBe("Expected string, got number");
  });

  it("maps non-schema failures to the SQL operation", () => {
    const cause = new Error("database unavailable");
    const error = toPersistenceSqlOrDecodeError("repository.query", "repository.decode")(cause);

    expect(error).toBeInstanceOf(PersistenceSqlError);
    expect(error.operation).toBe("repository.query");
    expect(error.cause).toBe(cause);
  });
});

const SECRET = "sk-live-0123456789abcdefSECRET";

const Row = Schema.Struct({
  id: Schema.String,
  isPinned: Schema.Number,
  title: Schema.String.check(Schema.isMaxLength(5)),
  payload: Schema.fromJsonString(Schema.Struct({ ok: Schema.Boolean })),
  mode: Schema.Literals(["a", "b"]),
});

const failure = (input: unknown): Schema.SchemaError => {
  const result = Effect.runSync(
    Schema.decodeUnknownEffect(Schema.Array(Row))([input]).pipe(Effect.result),
  );
  if (Result.isFailure(result)) return result.failure;
  throw new Error("Expected schema decoding to fail.");
};

const goodRow = { id: "row-1", isPinned: 0, title: "ok", payload: '{"ok":true}', mode: "a" };

describe("decode errors never carry stored values", () => {
  const cases = {
    "a secret in a number column": { ...goodRow, isPinned: SECRET },
    "a secret that breaks a length check": { ...goodRow, title: SECRET },
    "a secret in a JSON column that is not JSON": { ...goodRow, payload: `${SECRET} {` },
    "a secret in a literal column": { ...goodRow, mode: SECRET },
  };

  for (const [name, row] of Object.entries(cases)) {
    it(`keeps out ${name}`, () => {
      const schemaError = failure(row);
      // Effect's own text quotes it: this is what used to reach the logs.
      expect(schemaError.message).toContain(SECRET.slice(0, 8));

      const decode = toPersistenceDecodeError("repository.decode")(schemaError);
      // The engine wraps a failed read model load like this before logging it.
      const sql = toPersistenceSqlError("OrchestrationEngine.rebuildSidebarOrder")(decode);
      const rawSql = toPersistenceSqlError("repository.query")(schemaError);
      for (const text of [
        decode.message,
        decode.issue,
        sql.message,
        rawSql.message,
        Cause.pretty(Cause.fail(sql)),
        Cause.pretty(Cause.fail(rawSql)),
        Cause.pretty(redactSchemaErrorsInCause(Cause.fail(schemaError))),
        Cause.pretty(redactSchemaErrorsInCause(Cause.die(schemaError))),
      ]) {
        expect(text).not.toContain(SECRET.slice(0, 8));
      }
    });
  }

  it("names the path, the expected type and the kind of value found", () => {
    expect(describeSchemaIssue(failure({ ...goodRow, isPinned: SECRET }).issue)).toBe(
      'Expected number, got string at [0]["isPinned"]',
    );
    expect(describeSchemaIssue(failure({ ...goodRow, payload: null }).issue)).toBe(
      'Expected string, got null at [0]["payload"]',
    );
    expect(describeSchemaIssue(failure({ ...goodRow, title: SECRET }).issue)).toMatch(
      /^Expected .+, got string at \[0\]\["title"\]$/u,
    );
    const { mode: _mode, ...missingMode } = goodRow;
    expect(describeSchemaIssue(failure(missingMode).issue)).toBe('Missing key at [0]["mode"]');
  });
});
