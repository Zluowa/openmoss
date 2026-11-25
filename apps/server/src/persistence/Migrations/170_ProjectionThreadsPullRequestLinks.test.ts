// FILE: 170_ProjectionThreadsPullRequestLinks.test.ts
// Purpose: Migration 170 (upstream 144, #2132) backfills one legacy link per valid single-PR
//          slot, and stays additive: it passes the additive-migration check, the floor release
//          (newest migration 169) still opens a database it migrated, also after a later
//          additive release, its writes leave the newer columns alone, and it reads the
//          `thread.meta-updated` events that now carry links.
// Layer: Persistence migration tests

import { assert, it } from "@effect/vitest";
import { ThreadId, ThreadMetaUpdatedPayload } from "@moss/contracts";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionThreadRepositoryLive } from "../Layers/ProjectionThreads.ts";
import {
  decodeMigrationReaderFloor,
  encodeMigrationReaderFloor,
  inspectCurrentMigrationLineage,
} from "../MigrationLineage.ts";
import { MIGRATION_READER_FLOOR, migrationEntries, runMigrations } from "../Migrations.ts";
import {
  checkAdditiveMigration,
  runMigrationsAsFloorRelease,
} from "../migrationReaderFloorTesting.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { ProjectionThreadRepository } from "../Services/ProjectionThreads.ts";
import migration from "./170_ProjectionThreadsPullRequestLinks.ts";

/** The newest migration of the release before this one (1.0.7). */
/**
 * The oldest release the reader floor admits (1.0.7, newest migration 169). Additive migrations
 * are tested against it, with every additive migration above the floor applied together.
 */
const FLOOR_RELEASE_LATEST_MIGRATION_ID = 169;

const pullRequest = {
  number: 7,
  title: "Keep links",
  url: "https://github.com/acme/app/pull/7",
  baseBranch: "main",
  headBranch: "feat/links",
  state: "open",
};

const insertThread = (sql: SqlClient.SqlClient, threadId: string, lastKnownPr: string | null) =>
  sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json,
    last_known_pr_json, created_at, updated_at)
  VALUES (${threadId}, 'project', 'Thread', '{"provider":"codex","model":"gpt-5-codex"}',
    ${lastKnownPr}, '2026-11-13T09:00:00.000Z', '2026-11-13T10:00:00.000Z')`;

const readLinks = (sql: SqlClient.SqlClient) =>
  sql<{ readonly threadId: string; readonly links: string | null; readonly pr: string | null }>`
    SELECT thread_id AS "threadId", pull_requests_json AS links, last_known_pr_json AS pr
    FROM projection_threads ORDER BY thread_id`;

// Upstream's test, renumbered 144 → 170.
it.effect("backfills one legacy link per valid PR, skips malformed rows, and replays safely", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 169 });
    yield* insertThread(sql, "a-object", JSON.stringify(pullRequest));
    yield* insertThread(sql, "b-none", null);
    yield* insertThread(sql, "c-malformed", "{not json");
    yield* insertThread(sql, "d-array", "[1,2]");
    yield* insertThread(sql, "e-string", '"text"');
    yield* runMigrations({ toMigrationInclusive: 170 });

    const rows = yield* readLinks(sql);
    assert.deepStrictEqual(JSON.parse(rows[0]!.links!), [
      { pullRequest, source: "legacy", linkedAt: "2026-11-13T10:00:00.000Z" },
    ]);
    assert.deepStrictEqual(
      rows.slice(1).map((row) => [row.threadId, row.links]),
      [
        ["b-none", null],
        ["c-malformed", null],
        ["d-array", null],
        ["e-string", null],
      ],
    );
    // Every PR slot is left exactly as it was.
    assert.deepStrictEqual(
      rows.map((row) => row.pr),
      [JSON.stringify(pullRequest), null, "{not json", "[1,2]", '"text"'],
    );

    // A lineage reconcile can replay the migration: links written since are kept.
    const linked = JSON.stringify([
      { pullRequest, source: "agent", linkedAt: "2026-11-13T11:00:00.000Z" },
    ]);
    yield* sql`UPDATE projection_threads SET pull_requests_json = ${linked} WHERE thread_id = 'a-object'`;
    yield* migration;
    assert.equal((yield* readLinks(sql))[0]!.links, linked);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("passes the additive-migration check against the database it migrates", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: FLOOR_RELEASE_LATEST_MIGRATION_ID });
    const sql = yield* SqlClient.SqlClient;
    yield* insertThread(sql, "a-object", JSON.stringify(pullRequest));
    const body = migrationEntries.find(([id]) => id === 170)![2];
    assert.deepStrictEqual(yield* checkAdditiveMigration(body), []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("is declared additive, so the floor release opens a database migrated past it", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: FLOOR_RELEASE_LATEST_MIGRATION_ID });
    yield* insertThread(sql, "a-object", JSON.stringify(pullRequest));
    yield* runMigrations();

    assert.equal(MIGRATION_READER_FLOOR, FLOOR_RELEASE_LATEST_MIGRATION_ID);
    const [marker] = yield* sql<{ readonly user_version: number }>`PRAGMA user_version`;
    assert.deepStrictEqual(decodeMigrationReaderFloor(marker?.user_version), {
      kind: "floor",
      floor: MIGRATION_READER_FLOOR,
      writtenAt: 173,
    });

    // The previous release opens it and runs nothing, and upgrading again runs nothing either.
    assert.deepStrictEqual(yield* runMigrationsAsFloorRelease(), []);
    assert.deepStrictEqual(yield* runMigrations(), []);
    const inspection = yield* inspectCurrentMigrationLineage;
    assert.deepStrictEqual(inspection.classification, { kind: "moss-prefix", highWaterMark: 173 });
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("keeps the links column through the previous release's whole-row thread writes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* ProjectionThreadRepository;
    yield* runMigrations({ toMigrationInclusive: FLOOR_RELEASE_LATEST_MIGRATION_ID });
    yield* insertThread(sql, "a-object", JSON.stringify(pullRequest));
    yield* runMigrations();
    const backfilled = (yield* readLinks(sql))[0]!.links;
    assert.isNotNull(backfilled);

    // The previous release's repository writes the single PR slot and the rest of the row; the
    // links column is not among its columns, so it stays as this release left it.
    yield* runMigrationsAsFloorRelease();
    const row = Option.getOrThrow(
      yield* repository.getById({ threadId: ThreadId.makeUnsafe("a-object") }),
    );
    const merged = { ...pullRequest, state: "merged" as const };
    yield* repository.upsert({ ...row, title: "Renamed", lastKnownPr: merged });

    const [stored] = yield* readLinks(sql);
    assert.equal(stored!.links, backfilled);
    assert.deepStrictEqual(JSON.parse(stored!.pr!), merged);
  }).pipe(
    Effect.provide(
      ProjectionThreadRepositoryLive.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
    ),
  ),
);

it.effect("opens for the floor release after a later additive release too (two steps down)", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* ProjectionThreadRepository;
    yield* runMigrations({ toMigrationInclusive: FLOOR_RELEASE_LATEST_MIGRATION_ID });
    yield* insertThread(sql, "a-object", JSON.stringify(pullRequest));
    yield* runMigrations();
    // A later release adds 174 (also additive) and writes the floor for it, still 169.
    yield* sql`ALTER TABLE projection_threads ADD COLUMN later_release_json TEXT`;
    yield* sql`UPDATE projection_threads SET later_release_json = '"kept"'`;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (174, 'LaterRelease')`;
    yield* sql.unsafe(
      `PRAGMA user_version = ${encodeMigrationReaderFloor(FLOOR_RELEASE_LATEST_MIGRATION_ID, 174)}`,
    );
    const linksBefore = (yield* readLinks(sql))[0]!.links;

    // 1.0.7 opens it, runs nothing, and its whole-row writes keep both newer columns.
    assert.deepStrictEqual(yield* runMigrationsAsFloorRelease(), []);
    const row = Option.getOrThrow(
      yield* repository.getById({ threadId: ThreadId.makeUnsafe("a-object") }),
    );
    yield* repository.upsert({ ...row, title: "Renamed by 1.0.7" });
    const [stored] = yield* sql<{ readonly links: string | null; readonly later: string | null }>`
      SELECT pull_requests_json AS links, later_release_json AS later FROM projection_threads`;
    assert.equal(stored!.links, linksBefore);
    assert.equal(stored!.later, '"kept"');
  }).pipe(
    Effect.provide(
      ProjectionThreadRepositoryLive.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
    ),
  ),
);

it("reads a thread.meta-updated payload with fields it does not know, as the previous release does", () => {
  // The links list rides on `thread.meta-updated` beside `lastKnownPr`. The previous release's
  // payload schema is this one without `pullRequests`; event schemas drop fields they do not
  // declare instead of failing, so that release reads these events and keeps the current PR.
  const decoded = Schema.decodeUnknownSync(ThreadMetaUpdatedPayload)({
    threadId: "a-object",
    lastKnownPr: pullRequest,
    pullRequestsFromANewerBuild: [{ pullRequest, source: "agent" }],
    updatedAt: "2026-11-13T11:00:00.000Z",
  });
  assert.deepStrictEqual(decoded.lastKnownPr, pullRequest);
  assert.notProperty(decoded, "pullRequestsFromANewerBuild");
});
