import { assert, it } from "@effect/vitest";
import { ThreadId } from "@moss/contracts";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionThreadSessionRepositoryLive } from "../Layers/ProjectionThreadSessions.ts";
import { decodeMigrationReaderFloor, inspectCurrentMigrationLineage } from "../MigrationLineage.ts";
import { MIGRATION_READER_FLOOR, runMigrations } from "../Migrations.ts";
import { runMigrationsAsFloorRelease } from "../migrationReaderFloorTesting.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { ProjectionThreadSessionRepository } from "../Services/ProjectionThreadSessions.ts";
import migration174 from "./174_ProjectionThreadSessionSteering.ts";

const FLOOR_RELEASE_LATEST_MIGRATION_ID = 169;

const insertSession = (sql: SqlClient.SqlClient, threadId: string) =>
  sql`
    INSERT INTO projection_thread_sessions (
      thread_id,
      status,
      provider_name,
      runtime_mode,
      active_turn_id,
      last_error,
      updated_at
    )
    VALUES (
      ${threadId},
      'ready',
      'antigravity',
      'full-access',
      NULL,
      NULL,
      '2026-11-26T00:00:00.000Z'
    )
  `;

it.effect(
  "adds supports_native_turn_steering preserving existing sessions and replays idempotently",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ProjectionThreadSessionRepository;

      yield* runMigrations({ toMigrationInclusive: 173 });
      yield* insertSession(sql, "thread-existing");

      const executed = yield* runMigrations();
      assert.deepStrictEqual(
        executed.map(([id, name]) => [id, name]),
        [[174, "ProjectionThreadSessionSteering"]],
      );

      const existing = Option.getOrThrow(
        yield* repository.getByThreadId({ threadId: ThreadId.makeUnsafe("thread-existing") }),
      );
      assert.strictEqual(existing.supportsNativeTurnSteering, null);

      yield* repository.upsert({
        ...existing,
        supportsNativeTurnSteering: true,
        updatedAt: "2026-11-26T00:01:00.000Z",
      });
      const updated = Option.getOrThrow(
        yield* repository.getByThreadId({ threadId: ThreadId.makeUnsafe("thread-existing") }),
      );
      assert.strictEqual(updated.supportsNativeTurnSteering, true);

      // Enforces the 0/1 check constraint while keeping NULL valid.
      const rejected = yield* Effect.flip(
        sql`
          UPDATE projection_thread_sessions
          SET supports_native_turn_steering = 2
          WHERE thread_id = 'thread-existing'
        `,
      );
      assert.equal(rejected._tag, "SqlError");

      // Safe to run a second time.
      yield* migration174;
      const afterReplay = Option.getOrThrow(
        yield* repository.getByThreadId({ threadId: ThreadId.makeUnsafe("thread-existing") }),
      );
      assert.strictEqual(afterReplay.supportsNativeTurnSteering, true);
    }).pipe(
      Effect.provide(
        ProjectionThreadSessionRepositoryLive.pipe(
          Layer.provideMerge(NodeSqliteClient.layerMemory()),
        ),
      ),
    ),
);

it.effect("is declared additive, so the floor release opens a database migrated through 174", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: FLOOR_RELEASE_LATEST_MIGRATION_ID });
    yield* insertSession(sql, "thread-floor");
    yield* runMigrations();

    assert.equal(MIGRATION_READER_FLOOR, FLOOR_RELEASE_LATEST_MIGRATION_ID);
    const [marker] = yield* sql<{ readonly user_version: number }>`PRAGMA user_version`;
    assert.deepStrictEqual(decodeMigrationReaderFloor(marker?.user_version), {
      kind: "floor",
      floor: MIGRATION_READER_FLOOR,
      writtenAt: 174,
    });

    assert.deepStrictEqual(yield* runMigrationsAsFloorRelease(), []);
    assert.deepStrictEqual(yield* runMigrations(), []);
    const inspection = yield* inspectCurrentMigrationLineage;
    assert.deepStrictEqual(inspection.classification, { kind: "moss-prefix", highWaterMark: 174 });
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
