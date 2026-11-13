import { MIGRATION_LINEAGE_UNSUPPORTED_MESSAGE } from "@moss/shared/migrationRecovery";
import { Cause, Option, Schema, SchemaIssue } from "effect";

// ===============================
// Core Persistence Errors
// ===============================

export class PersistenceSqlError extends Schema.TaggedErrorClass<PersistenceSqlError>()(
  "PersistenceSqlError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `SQL error in ${this.operation}: ${this.detail}`;
  }
}

export class PersistenceDecodeError extends Schema.TaggedErrorClass<PersistenceDecodeError>()(
  "PersistenceDecodeError",
  {
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Decode error in ${this.operation}: ${this.issue}`;
  }
}

// ===============================
// Decode errors without stored values
// ===============================

const MAX_ISSUE_LINES = 3;
const MAX_PATH_KEY_CHARS = 64;

function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function kindOfOption(value: Option.Option<unknown>): string {
  return Option.match(value, { onNone: () => "no value", onSome: kindOf });
}

/** What the schema expected: written by the schema's author, never taken from data. */
function expectedOf(ast: unknown): string {
  const node = ast as {
    readonly _tag?: unknown;
    readonly annotations?: { readonly identifier?: unknown; readonly expected?: unknown };
    readonly getExpected?: (recur: (ast: unknown) => string) => string;
  };
  if (typeof node?.annotations?.identifier === "string") return node.annotations.identifier;
  if (typeof node?.getExpected === "function") {
    try {
      return node.getExpected(expectedOf);
    } catch {
      // Fall through to the node's kind.
    }
  }
  return typeof node?._tag === "string" ? node._tag : "a value";
}

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) return "";
  return ` at ${path
    .map((key) => {
      if (typeof key === "number") return `[${key}]`;
      const text = String(key);
      return `["${text.length > MAX_PATH_KEY_CHARS ? `${text.slice(0, MAX_PATH_KEY_CHARS)}…` : text}"]`;
    })
    .join("")}`;
}

function collectIssueLines(
  issue: SchemaIssue.Issue,
  path: ReadonlyArray<PropertyKey>,
  out: Array<string>,
): void {
  if (out.length >= MAX_ISSUE_LINES) return;
  const at = formatPath(path);
  switch (issue._tag) {
    case "Pointer":
      collectIssueLines(issue.issue, [...path, ...issue.path], out);
      return;
    case "Encoding":
      collectIssueLines(issue.issue, path, out);
      return;
    case "Composite":
      for (const nested of issue.issues) collectIssueLines(nested, path, out);
      return;
    case "AnyOf":
      if (issue.issues.length === 0) {
        out.push(`Expected ${expectedOf(issue.ast)}, got ${kindOf(issue.actual)}${at}`);
        return;
      }
      for (const nested of issue.issues) collectIssueLines(nested, path, out);
      return;
    case "Filter": {
      const expected = issue.filter.annotations?.expected;
      out.push(
        `Expected ${typeof expected === "string" ? expected : "a value that passes a check"}, got ${kindOf(issue.actual)}${at}`,
      );
      return;
    }
    case "InvalidType":
      out.push(`Expected ${expectedOf(issue.ast)}, got ${kindOfOption(issue.actual)}${at}`);
      return;
    case "InvalidValue":
      out.push(`Invalid ${kindOfOption(issue.actual)}${at}`);
      return;
    case "MissingKey":
      out.push(`Missing key${at}`);
      return;
    case "UnexpectedKey":
      out.push(`Unexpected key${at}`);
      return;
    case "Forbidden":
      out.push(`Forbidden operation${at}`);
      return;
    case "OneOf":
      out.push(`Expected exactly one member to match, got ${kindOf(issue.actual)}${at}`);
      return;
  }
}

/**
 * Describes a decode failure by its path, the expected type and the kind of
 * value found, e.g. `Expected string, got null at [0]["modelSelection"]`.
 * Effect's default formatter quotes the stored value itself (a title, a JSON
 * fragment, a prompt), and these messages reach logs that can leave the machine.
 */
export function describeSchemaIssue(issue: SchemaIssue.Issue): string {
  const lines: Array<string> = [];
  collectIssueLines(issue, [], lines);
  return lines.length > 0 ? lines.join("; ") : "Value did not decode";
}

/** Stands in for a `SchemaError` wherever an error is kept or printed. */
export class RedactedSchemaError extends Error {
  override readonly name = "SchemaError";
}

/** Replaces a `SchemaError` with one whose message names no stored value. */
export function redactSchemaError<A>(value: A): A | RedactedSchemaError {
  return Schema.isSchemaError(value)
    ? new RedactedSchemaError(describeSchemaIssue(value.issue))
    : value;
}

/** The same cause, with every top-level `SchemaError` replaced as above. */
export function redactSchemaErrorsInCause<E>(cause: Cause.Cause<E>): Cause.Cause<unknown> {
  return Cause.fromReasons(
    cause.reasons.map((reason) =>
      Cause.isFailReason(reason)
        ? Cause.makeFailReason(redactSchemaError(reason.error))
        : Cause.isDieReason(reason)
          ? Cause.makeDieReason(redactSchemaError(reason.defect))
          : reason,
    ),
  );
}

export function toPersistenceSqlError(operation: string) {
  return (rawCause: unknown): PersistenceSqlError => {
    const cause = redactSchemaError(rawCause);
    const messages: string[] = [];
    const seen = new Set<unknown>();
    let current: unknown = cause;
    while (current && typeof current === "object" && !seen.has(current)) {
      seen.add(current);
      if (current instanceof Error && current.message && !messages.includes(current.message)) {
        messages.push(current.message);
      }
      current = "cause" in current ? (current as { readonly cause?: unknown }).cause : undefined;
    }
    const causeDetail = messages.length > 0 ? ` (${messages.join(": ")})` : "";
    return new PersistenceSqlError({
      operation,
      detail: `Failed to execute ${operation}${causeDetail}`,
      cause,
    });
  };
}

export function toPersistenceDecodeError(operation: string) {
  return (error: Schema.SchemaError): PersistenceDecodeError =>
    new PersistenceDecodeError({
      operation,
      issue: describeSchemaIssue(error.issue),
      cause: redactSchemaError(error),
    });
}

export function toPersistenceSqlOrDecodeError(
  sqlOperation: string,
  decodeOperation: string,
): (cause: unknown) => PersistenceSqlError | PersistenceDecodeError {
  return (cause) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

export function toPersistenceDecodeCauseError(operation: string) {
  return (cause: unknown): PersistenceDecodeError =>
    new PersistenceDecodeError({
      operation,
      issue: `Failed to execute ${operation}`,
      cause: redactSchemaError(cause),
    });
}

/**
 * The projection cursor table is non-empty but a projector the snapshot
 * sequence depends on has no cursor row. The snapshot fence is unknowable in
 * this state: reporting any number would either serve stale data as fresh or
 * demand an unsatisfiable resnapshot forever. Reachable only through an
 * interrupted projection rebuild (repair/restore), so it names the missing
 * cursors and points at the recovery path instead of guessing.
 */
export class ProjectionStateIncompleteError extends Schema.TaggedErrorClass<ProjectionStateIncompleteError>()(
  "ProjectionStateIncompleteError",
  {
    missingProjectors: Schema.Array(Schema.String),
    knownProjectors: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return (
      `Projection state is incomplete: missing cursor rows for ${this.missingProjectors.join(", ")} ` +
      `(present: ${this.knownProjectors.join(", ") || "none"}). ` +
      "The snapshot sequence cannot be derived; restart the server so the projection " +
      "bootstrap can rebuild the missing cursors, or run repair local state."
    );
  }
}

export const isPersistenceError = (u: unknown) =>
  Schema.is(PersistenceSqlError)(u) ||
  Schema.is(PersistenceDecodeError)(u) ||
  Schema.is(ProjectionStateIncompleteError)(u);

export class MigrationLineageError extends Schema.TaggedErrorClass<MigrationLineageError>()(
  "MigrationLineageError",
  {
    firstDivergedId: Schema.Number,
    expectedName: Schema.String,
    recordedName: Schema.String,
  },
) {
  override get message(): string {
    return (
      `${MIGRATION_LINEAGE_UNSUPPORTED_MESSAGE}: migration ${this.firstDivergedId} ` +
      `is recorded as "${this.recordedName}" but Moss expects "${this.expectedName}". ` +
      `Refusing to run migrations against an unrecognized database.`
    );
  }
}

export class MigrationSchemaTooNewError extends Schema.TaggedErrorClass<MigrationSchemaTooNewError>()(
  "MigrationSchemaTooNewError",
  {
    databaseMigrationId: Schema.Number,
    latestSupportedMigrationId: Schema.Number,
  },
) {
  override get message(): string {
    return (
      `Database schema migration ${this.databaseMigrationId} is newer than this Moss build ` +
      `(latest supported migration: ${this.latestSupportedMigrationId}). ` +
      "Refusing writable startup; upgrade Moss or restore a compatible database backup."
    );
  }
}

export class MigrationBackupRequiredError extends Schema.TaggedErrorClass<MigrationBackupRequiredError>()(
  "MigrationBackupRequiredError",
  {
    sourceLineage: Schema.String,
    databaseMigrationId: Schema.Number,
  },
) {
  override get message(): string {
    return (
      `Migration adoption from ${this.sourceLineage} at migration ${this.databaseMigrationId} ` +
      "requires a durable pre-migration backup. Refusing to mutate the migration tracker."
    );
  }
}

// ===============================
// Provider Session Repository Errors
// ===============================

export class ProviderSessionRepositoryValidationError extends Schema.TaggedErrorClass<ProviderSessionRepositoryValidationError>()(
  "ProviderSessionRepositoryValidationError",
  {
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider session repository validation failed in ${this.operation}: ${this.issue}`;
  }
}

export class ProviderSessionRepositoryPersistenceError extends Schema.TaggedErrorClass<ProviderSessionRepositoryPersistenceError>()(
  "ProviderSessionRepositoryPersistenceError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider session repository persistence error in ${this.operation}: ${this.detail}`;
  }
}

export type OrchestrationEventStoreError = PersistenceSqlError | PersistenceDecodeError;

export type ProviderSessionRepositoryError =
  | ProviderSessionRepositoryValidationError
  | ProviderSessionRepositoryPersistenceError;

export type OrchestrationCommandReceiptRepositoryError =
  | PersistenceSqlError
  | PersistenceDecodeError;

export type ProviderSessionRuntimeRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export type ProjectionRepositoryError =
  | PersistenceSqlError
  | PersistenceDecodeError
  | ProjectionStateIncompleteError;

export type AuthPairingLinkRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export type AuthSessionRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export class AutomationCreateRequestRejectedError extends Schema.TaggedErrorClass<AutomationCreateRequestRejectedError>()(
  "AutomationCreateRequestRejectedError",
  { message: Schema.String },
) {}

export type AutomationRepositoryError =
  | PersistenceSqlError
  | PersistenceDecodeError
  | AutomationCreateRequestRejectedError;

export type TodoRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export type LibraryRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export type GuestShareRepositoryError = PersistenceSqlError | PersistenceDecodeError;
