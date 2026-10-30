import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, it } from "@effect/vitest";
import { AutomationId, ProjectId, type AutomationCreateInput } from "@synara/contracts";
import { Deferred, Effect, Exit, Fiber, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { AutomationRepository } from "../Services/AutomationRepository.ts";
import { AutomationRepositoryLive } from "./AutomationRepository.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const now = "2026-10-25T00:00:00.000Z";
const input: AutomationCreateInput = {
  requestId: "create-once",
  name: "Update research",
  projectId: ProjectId.makeUnsafe("request-project"),
  prompt: "Update the existing page with verified findings.",
  enabled: false,
  schedule: { type: "daily", timeOfDay: "09:00" },
  modelSelection: { provider: "codex", instanceId: "codex", model: "gpt-5-codex" },
};
const request = (id: string, overrides: Partial<AutomationCreateInput> = {}) => ({
  id: AutomationId.makeUnsafe(id),
  input: { ...input, ...overrides },
  now,
  principalKey: "session:owner-a",
  nextRunAt: "2026-10-25T09:00:00.000Z",
});

const tests = it.layer(AutomationRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));
const resetMemoryFixture = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM automation_create_requests`;
  yield* sql`DELETE FROM automation_definitions`;
});
tests("durable automation creation identities", (it) => {
  it.effect("replays a lost result exactly without changing the saved definition", () =>
    Effect.gen(function* () {
      yield* resetMemoryFixture;
      const repository = yield* AutomationRepository;
      const first = yield* repository.createDefinition(request("first"));
      yield* repository.saveDefinition({
        definition: { ...first, enabled: true, name: "Later edit" },
        expectedUpdatedAt: first.updatedAt,
      });
      const retry = yield* repository.createDefinition({
        ...request("unused-retry-id"),
        now: "2026-10-26T00:00:00.000Z",
        nextRunAt: "2026-10-26T09:00:00.000Z",
      });
      assert.deepStrictEqual(retry, first);
      const current = Option.getOrThrow(yield* repository.getDefinitionById({ id: first.id }));
      assert.isTrue(current.enabled);
      assert.strictEqual(current.name, "Later edit");
      assert.strictEqual((yield* repository.list({ includeArchived: true })).definitions.length, 1);
    }),
  );

  it.effect("rejects a changed payload under the same identity", () =>
    Effect.gen(function* () {
      yield* resetMemoryFixture;
      const repository = yield* AutomationRepository;
      yield* repository.createDefinition(request("first"));
      const error = yield* Effect.flip(
        repository.createDefinition(request("second", { prompt: "Different work" })),
      );
      assert.strictEqual(error._tag, "PersistenceDecodeError");
      assert.include(error.message, "different input");
      assert.strictEqual((yield* repository.list({ includeArchived: true })).definitions.length, 1);
    }),
  );

  it.effect("scopes receipts to the trusted principal and authorized project", () =>
    Effect.gen(function* () {
      yield* resetMemoryFixture;
      const repository = yield* AutomationRepository;
      const first = yield* repository.createDefinition(request("first"));
      const otherOwner = yield* repository.createDefinition({
        ...request("owner-b"),
        principalKey: "session:owner-b",
      });
      const otherProject = yield* repository.createDefinition(
        request("project-b", { projectId: ProjectId.makeUnsafe("project-b") }),
      );
      assert.notStrictEqual(first.id, otherOwner.id);
      assert.notStrictEqual(first.id, otherProject.id);
      assert.deepStrictEqual(
        Option.getOrThrow(yield* repository.findCreateRequest(request("unused"))),
        first,
      );
      assert.strictEqual((yield* repository.list({ includeArchived: true })).definitions.length, 3);
    }),
  );

  it.effect("commits only one row for concurrent identical creations", () =>
    Effect.gen(function* () {
      yield* resetMemoryFixture;
      const repository = yield* AutomationRepository;
      const results = yield* Effect.all(
        Array.from({ length: 8 }, (_, index) =>
          repository.createDefinition(request(`concurrent-${index}`)),
        ),
        { concurrency: "unbounded" },
      );
      for (const result of results) assert.deepStrictEqual(result, results[0]);
      assert.strictEqual((yield* repository.list({ includeArchived: true })).definitions.length, 1);
    }),
  );

  it.effect("persists a terminal rejection and requires a new request for corrected input", () =>
    Effect.gen(function* () {
      yield* resetMemoryFixture;
      const repository = yield* AutomationRepository;
      const first = yield* Effect.flip(
        repository.createDefinition(
          request("invalid"),
          Effect.fail({ message: "Choose an available provider." }),
        ),
      );
      assert.strictEqual(first._tag, "AutomationCreateRequestRejectedError");
      const retry = yield* Effect.flip(
        repository.createDefinition(request("still-invalid"), Effect.void),
      );
      assert.deepStrictEqual(retry, first);
      const conflict = yield* Effect.flip(
        repository.createDefinition(request("changed", { prompt: "Corrected input" }), Effect.void),
      );
      assert.strictEqual(conflict._tag, "PersistenceDecodeError");
      assert.strictEqual((yield* repository.list({ includeArchived: true })).definitions.length, 0);
      const corrected = yield* repository.createDefinition(
        request("corrected", { requestId: "new-after-rejection", prompt: "Corrected input" }),
        Effect.void,
      );
      assert.strictEqual(corrected.id, "corrected");
    }),
  );

  it.effect("returns a concurrent accepted winner instead of storing a later rejection", () =>
    Effect.gen(function* () {
      yield* resetMemoryFixture;
      const repository = yield* AutomationRepository;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const winner = yield* Effect.forkChild(
        repository.createDefinition(
          request("winner"),
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }),
        ),
      );
      yield* Deferred.await(entered);
      let laterValidationCalls = 0;
      const later = yield* Effect.forkChild(
        repository.createDefinition(
          request("loser"),
          Effect.suspend(() => {
            laterValidationCalls += 1;
            return Effect.fail({ message: "A later provider setting is unavailable." });
          }),
        ),
      );
      yield* Deferred.succeed(release, undefined);
      const accepted = yield* Fiber.join(winner);
      assert.deepStrictEqual(yield* Fiber.join(later), accepted);
      assert.strictEqual(laterValidationCalls, 0);
      assert.strictEqual((yield* repository.list({ includeArchived: true })).definitions.length, 1);
    }),
  );

  it.effect("keeps a concurrent rejected winner terminal without inserting a later success", () =>
    Effect.gen(function* () {
      yield* resetMemoryFixture;
      const repository = yield* AutomationRepository;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const winner = yield* Effect.forkChild(
        Effect.flip(
          repository.createDefinition(
            request("rejected"),
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return yield* Effect.fail({ message: "Original validation rejected the request." });
            }),
          ),
        ),
      );
      yield* Deferred.await(entered);
      let laterValidationCalls = 0;
      const later = yield* Effect.forkChild(
        Effect.flip(
          repository.createDefinition(
            request("cannot-succeed"),
            Effect.sync(() => {
              laterValidationCalls += 1;
            }),
          ),
        ),
      );
      yield* Deferred.succeed(release, undefined);
      const rejected = yield* Fiber.join(winner);
      assert.strictEqual(rejected._tag, "AutomationCreateRequestRejectedError");
      assert.deepStrictEqual(yield* Fiber.join(later), rejected);
      assert.strictEqual(laterValidationCalls, 0);
      assert.strictEqual((yield* repository.list({ includeArchived: true })).definitions.length, 0);
    }),
  );

  it.effect("rolls back the definition if the receipt cannot be committed", () =>
    Effect.gen(function* () {
      yield* resetMemoryFixture;
      const repository = yield* AutomationRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TRIGGER reject_create_receipt BEFORE INSERT ON automation_create_requests
      BEGIN SELECT RAISE(ABORT, 'receipt storage unavailable'); END`;
      const result = yield* Effect.exit(repository.createDefinition(request("rolled-back")));
      assert.isTrue(Exit.isFailure(result));
      assert.strictEqual((yield* repository.list({ includeArchived: true })).definitions.length, 0);
      assert.strictEqual(
        (yield* sql<{ count: number }>`SELECT count(*) AS count FROM automation_create_requests`)[0]
          ?.count,
        0,
      );
      yield* sql`DROP TRIGGER reject_create_receipt`;
      const created = yield* repository.createDefinition(request("retry-after-rollback"));
      assert.strictEqual(created.id, "retry-after-rollback");
    }),
  );

  it.effect("keeps separate creations for callers that do not supply a request id", () =>
    Effect.gen(function* () {
      yield* resetMemoryFixture;
      const repository = yield* AutomationRepository;
      const { requestId: _requestId, ...legacy } = input;
      yield* repository.createDefinition({ ...request("legacy-a"), input: legacy });
      yield* repository.createDefinition({ ...request("legacy-b"), input: legacy });
      assert.strictEqual((yield* repository.list({ includeArchived: true })).definitions.length, 2);
    }),
  );
});

it.effect("retains creation receipts after closing and reopening the SQLite file", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "moss-automation-create-"))),
    (directory) =>
      Effect.gen(function* () {
        const inDatabase = <A, E>(
          effect: Effect.Effect<A, E, SqlClient.SqlClient | AutomationRepository>,
        ) =>
          effect.pipe(
            Effect.provide(
              AutomationRepositoryLive.pipe(
                Layer.provideMerge(
                  NodeSqliteClient.layer({ filename: join(directory, "state.sqlite") }),
                ),
              ),
            ),
          );
        const first = yield* inDatabase(
          Effect.gen(function* () {
            yield* runMigrations();
            const repository = yield* AutomationRepository;
            yield* Effect.flip(
              repository.createDefinition(
                request("durable-rejected", { requestId: "rejected-once" }),
                Effect.fail({ message: "Original validation rejected the request." }),
              ),
            );
            return yield* repository.createDefinition(request("durable-first"));
          }),
        );
        const retried = yield* inDatabase(
          Effect.gen(function* () {
            yield* runMigrations();
            const repository = yield* AutomationRepository;
            const rejection = yield* Effect.flip(
              repository.createDefinition(
                request("must-not-insert", { requestId: "rejected-once" }),
                Effect.void,
              ),
            );
            assert.strictEqual(rejection._tag, "AutomationCreateRequestRejectedError");
            assert.include(rejection.message, "Original validation rejected");
            const result = yield* repository.createDefinition(request("must-not-create"));
            assert.strictEqual(
              (yield* repository.list({ includeArchived: true })).definitions.length,
              1,
            );
            return result;
          }),
        );
        assert.deepStrictEqual(retried, first);
      }),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  ),
);
