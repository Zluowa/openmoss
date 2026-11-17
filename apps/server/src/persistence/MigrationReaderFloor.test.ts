// FILE: MigrationReaderFloor.test.ts
// Purpose: A database a newer Moss migrated opens in this build only when that build's reader
//          floor allows it; otherwise start-up refuses exactly as before. Covers the marker,
//          the real start-up path (backups, "database newer than Moss" block), older code's
//          writes on a database with two newer releases' columns, a downgrade followed by an
//          upgrade, an interrupted newer migration, and the additive-migration check.
// Layer: Persistence tests

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it as effectIt } from "@effect/vitest";
import { CommandId, DEFAULT_PROVIDER_INTERACTION_MODE, ProjectId, ThreadId } from "@moss/contracts";
import { Effect, Exit, Layer, ManagedRuntime } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "./Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "./Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "./Layers/Sqlite.ts";
import { MigrationSchemaTooNewError } from "./Errors.ts";
import {
  inspectMigrationBackupPlan,
  inspectPendingMigrationRecovery,
  migrationBackupDirectory,
  migrationRecoveryMarkerPath,
  resumeMarkedMigration,
  runWithPreMigrationBackup,
} from "./MigrationBackup.ts";
import {
  decodeMigrationReaderFloor,
  encodeMigrationReaderFloor,
  inspectCurrentMigrationLineage,
} from "./MigrationLineage.ts";
import {
  LATEST_MIGRATION_ID,
  MIGRATION_READER_FLOOR,
  MIGRATION_READER_FLOOR_MARKER,
  MIGRATIONS_OLDER_READERS_MAY_IGNORE,
  migrationEntries,
  runMigrations,
} from "./Migrations.ts";
import {
  checkAdditiveMigration,
  runMigrationsAsFloorRelease,
  runMigrationsAsRelease,
  writeAsNewerRelease,
} from "./migrationReaderFloorTesting.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";
import { MigrationSchemaTooNewStartupBlockError } from "./MigrationSchemaTooNewStartupBlock.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * Two newer releases, each adding one additive migration this build never reads: a nullable
 * column, then a table. The second release writes the floor for both (this build's newest).
 */
const NEWER_ADDITIVE: ReadonlyArray<{ id: number; name: string; sql: string }> = [
  {
    id: LATEST_MIGRATION_ID + 1,
    name: "FutureThreadLinks",
    sql: "ALTER TABLE projection_threads ADD COLUMN future_links_json TEXT;",
  },
  {
    id: LATEST_MIGRATION_ID + 2,
    name: "FutureLinkNotes",
    sql: "CREATE TABLE future_link_notes (note_id TEXT PRIMARY KEY, body TEXT NOT NULL);",
  },
];
const NEWEST = LATEST_MIGRATION_ID + 2;

/** A migration body made of plain statements, for checker cases. */
const statementsMigration = (...statements: string[]) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const statement of statements) yield* sql.unsafe(statement);
  });

const readUserVersion = (dbPath: string): number => {
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Number(
      (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    );
  } finally {
    database.close();
  }
};

/** Pre-migration snapshots start-up has written for this database. */
const backups = (dbPath: string) => {
  const directory = migrationBackupDirectory(dbPath);
  return fs.existsSync(directory)
    ? fs.readdirSync(directory).filter((name) => name.endsWith(".sqlite.gz"))
    : [];
};

const tempDatabase = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "moss-reader-floor-"));
  directories.push(directory);
  return path.join(directory, "state.sqlite");
};

/** The real start-up path on a database file: lifecycle lock, backup, migrations, too-new block. */
const startServer = async (dbPath: string) => {
  const layer = OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provideMerge(
      OrchestrationProjectionSnapshotQueryLive.pipe(
        Layer.provide(ServerSettingsService.layerTest()),
      ),
    ),
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(makeSqlitePersistenceLive(dbPath)),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "moss-reader-floor-test-" }),
    ),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  return {
    dispatch: (command: Parameters<typeof engine.dispatch>[0]) =>
      runtime.runPromise(engine.dispatch(command)),
    readModel: () => runtime.runPromise(engine.getReadModel()),
    dispose: () => runtime.dispose(),
  };
};

const startFails = async (dbPath: string) => {
  const result = await startServer(dbPath).then(
    async (system) => {
      await system.dispose();
      return null;
    },
    (error: unknown) => error,
  );
  return result;
};

const projectId = ProjectId.makeUnsafe("reader-floor-project");
const threadId = ThreadId.makeUnsafe("reader-floor-thread");
const createdAt = "2026-11-18T00:00:00.000Z";
const model = { instanceId: "codex", provider: "codex", model: "gpt-5-codex" } as const;

/** A database this build created and migrated, with one project and chat in it. */
const seedDatabase = async (dbPath: string) => {
  const system = await startServer(dbPath);
  try {
    await system.dispatch({
      type: "project.create",
      commandId: CommandId.makeUnsafe("reader-floor-cmd-project"),
      projectId,
      title: "Reader floor",
      workspaceRoot: path.dirname(dbPath),
      defaultModelSelection: model,
      createdAt,
    });
    await system.dispatch({
      type: "thread.create",
      commandId: CommandId.makeUnsafe("reader-floor-cmd-thread"),
      threadId,
      projectId,
      title: "Before the downgrade",
      modelSelection: model,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt,
    });
  } finally {
    await system.dispose();
  }
};

const setFutureColumn = (dbPath: string, value: string) => {
  const database = new DatabaseSync(dbPath);
  try {
    database
      .prepare("UPDATE projection_threads SET future_links_json = ? WHERE thread_id = ?")
      .run(value, threadId);
    database
      .prepare("INSERT INTO future_link_notes (note_id, body) VALUES (?, ?)")
      .run("n1", value);
  } finally {
    database.close();
  }
};

const readFuture = (dbPath: string) => {
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = database
      .prepare("SELECT future_links_json AS links FROM projection_threads WHERE thread_id = ?")
      .get(threadId) as { links: string | null };
    const notes = database.prepare("SELECT COUNT(*) AS count FROM future_link_notes").get() as {
      count: number;
    };
    const tracker = database
      .prepare("SELECT MAX(migration_id) AS id FROM effect_sql_migrations")
      .get() as { id: number };
    return { links: row.links, notes: notes.count, latestRecorded: tracker.id };
  } finally {
    database.close();
  }
};

describe("migration reader floor marker", () => {
  it("round-trips a floor and reads anything else as absent or invalid", () => {
    expect(decodeMigrationReaderFloor(encodeMigrationReaderFloor(169, 170))).toEqual({
      kind: "floor",
      floor: 169,
      writtenAt: 170,
    });
    expect(decodeMigrationReaderFloor(0)).toEqual({ kind: "absent" });
    expect(decodeMigrationReaderFloor(0n)).toEqual({ kind: "absent" });
    // Another program's user_version, a floor above the migration it was written for, a
    // missing half, out-of-range or non-integer values.
    for (const raw of [1, 169, 42_000, 0x00a9_00aa, 0x00a9_0000, 0x8000_0001, -5, 1.5, "169"]) {
      expect(decodeMigrationReaderFloor(raw).kind).toBe("invalid");
    }
    expect(() => encodeMigrationReaderFloor(0, 169)).toThrow();
    expect(() => encodeMigrationReaderFloor(170, 169)).toThrow();
    expect(() => encodeMigrationReaderFloor(1, 40_000)).toThrow();
  });

  it("derives the floor from the declared additive migrations, which must name real ones", () => {
    const names = new Map<number, string>(migrationEntries.map(([id, name]) => [id, name]));
    for (const [id, name] of MIGRATIONS_OLDER_READERS_MAY_IGNORE) {
      expect(names.get(id)).toBe(name);
      // An additive migration below the floor would be a dead entry: nothing older skips it.
      expect(id).toBeGreaterThan(MIGRATION_READER_FLOOR);
    }
    expect(MIGRATION_READER_FLOOR).toBeLessThanOrEqual(LATEST_MIGRATION_ID);
    // An unbroken run at the end of the migrations: the floor is the one just before it.
    expect(MIGRATIONS_OLDER_READERS_MAY_IGNORE.map(([id]) => id)).toEqual(
      Array.from(
        { length: LATEST_MIGRATION_ID - MIGRATION_READER_FLOOR },
        (_, index) => MIGRATION_READER_FLOOR + 1 + index,
      ),
    );
    // The marker this build writes is encodable (checked at module load as well), so no ID
    // past the encoding's limit can reach a migration that has already committed.
    expect(decodeMigrationReaderFloor(MIGRATION_READER_FLOOR_MARKER)).toEqual({
      kind: "floor",
      floor: MIGRATION_READER_FLOOR,
      writtenAt: LATEST_MIGRATION_ID,
    });
  });

  effectIt.effect("is written whenever the database is at this build's newest migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const userVersion = () =>
        sql<{ user_version: number }>`PRAGMA user_version`.pipe(
          Effect.map((rows) => Number(rows[0]?.user_version)),
        );
      // A partial run's floor would name migrations not applied: nothing is written.
      yield* runMigrations({ toMigrationInclusive: 100 });
      assert.equal(yield* userVersion(), 0);
      yield* runMigrations();
      assert.equal(yield* userVersion(), MIGRATION_READER_FLOOR_MARKER);

      // The start that committed the migrations stopped before writing (crash, full disk):
      // the next start has nothing to run and still writes it.
      yield* sql.unsafe("PRAGMA user_version = 0");
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.equal(yield* userVersion(), MIGRATION_READER_FLOOR_MARKER);

      // A stale marker (another build's floor for the same migrations) is replaced too.
      yield* sql.unsafe(
        `PRAGMA user_version = ${encodeMigrationReaderFloor(150, LATEST_MIGRATION_ID)}`,
      );
      yield* runMigrations();
      assert.equal(yield* userVersion(), MIGRATION_READER_FLOOR_MARKER);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  effectIt.effect("lets an earlier release open the database only as far as the floor says", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const previous = LATEST_MIGRATION_ID - 1;
      // A floor at this build's newest migration (nothing declared additive) keeps the release
      // before it out.
      yield* sql.unsafe(
        `PRAGMA user_version = ${encodeMigrationReaderFloor(LATEST_MIGRATION_ID, LATEST_MIGRATION_ID)}`,
      );
      const refused = yield* Effect.exit(runMigrationsAsRelease(previous));
      assert.isTrue(Exit.isFailure(refused));
      assert.include(String(refused), "MigrationSchemaTooNewError");

      // With its newest migration declared additive, the floor lets it in, and it runs, undoes
      // and writes nothing.
      const allowed = encodeMigrationReaderFloor(previous, LATEST_MIGRATION_ID);
      yield* sql.unsafe(`PRAGMA user_version = ${allowed}`);
      assert.deepStrictEqual(yield* runMigrationsAsRelease(previous), []);
      const [afterOlder] = yield* sql<{ user_version: number }>`PRAGMA user_version`;
      assert.equal(Number(afterOlder?.user_version), allowed);

      // Upgrade again: this build finds its own migrations recorded, runs and backs up
      // nothing, and writes its own floor; reconciling rows the older build wrote is the
      // additive migration's own code, on every start (see MIGRATIONS_OLDER_READERS_MAY_IGNORE).
      assert.deepStrictEqual(yield* runMigrations(), []);
      const inspection = yield* inspectCurrentMigrationLineage;
      assert.deepStrictEqual(inspection.classification, {
        kind: "moss-prefix",
        highWaterMark: LATEST_MIGRATION_ID,
      });
      assert.isNull(yield* inspectMigrationBackupPlan);
      assert.deepStrictEqual(inspection.readerFloor, {
        kind: "floor",
        floor: MIGRATION_READER_FLOOR,
        writtenAt: LATEST_MIGRATION_ID,
      });
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});

describe("checking a migration declared additive", () => {
  effectIt.effect("passes every migration on the additive list, against the floor release", () =>
    Effect.gen(function* () {
      for (const [id] of MIGRATIONS_OLDER_READERS_MAY_IGNORE) {
        yield* runMigrations({ toMigrationInclusive: id - 1 });
        const body = migrationEntries.find(([entryId]) => entryId === id)![2];
        assert.deepStrictEqual(yield* checkAdditiveMigration(body), [], `migration ${id}`);
      }
      // Every additive migration together, opened by the oldest release the floor admits.
      yield* runMigrations();
      assert.deepStrictEqual(yield* runMigrationsAsFloorRelease(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  effectIt.effect(
    "accepts a nullable column with its backfill, a new table and a plain index",
    () =>
      Effect.gen(function* () {
        yield* runMigrations();
        const violations = yield* checkAdditiveMigration(
          statementsMigration(
            "ALTER TABLE projection_threads ADD COLUMN probe_json TEXT",
            "UPDATE projection_threads SET probe_json = json_array(title) WHERE probe_json IS NULL",
            `CREATE TABLE probe_notes (note_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL
             REFERENCES projection_threads(thread_id) ON DELETE CASCADE, body TEXT NOT NULL)`,
            "CREATE INDEX idx_probe_threads ON projection_threads(probe_json)",
            "CREATE UNIQUE INDEX idx_probe_notes_body ON probe_notes(body)",
          ),
        );
        assert.deepStrictEqual(violations, []);
      }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  effectIt.effect("names each way a migration is not additive", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const rulesOf = (...statements: string[]) =>
        checkAdditiveMigration(statementsMigration(...statements)).pipe(
          Effect.map((violations) => violations.map((violation) => violation.rule)),
        );
      assert.deepStrictEqual(
        yield* rulesOf("CREATE UNIQUE INDEX idx_probe_u ON projection_threads(title) WHERE 1"),
        ["unique-index-on-existing-table"],
      );
      assert.deepStrictEqual(
        yield* rulesOf(
          `CREATE TABLE probe_refs (id TEXT PRIMARY KEY,
             thread_id TEXT REFERENCES projection_threads(thread_id))`,
        ),
        ["foreign-key-into-existing-table"],
      );
      assert.deepStrictEqual(
        yield* rulesOf(
          `CREATE TRIGGER probe_trigger AFTER INSERT ON projection_threads
             BEGIN SELECT 1; END`,
        ),
        ["trigger"],
      );
      assert.deepStrictEqual(yield* rulesOf("UPDATE projection_threads SET title = 'x' WHERE 0"), [
        "rewrites-existing-data",
      ]);
      assert.deepStrictEqual(yield* rulesOf("DELETE FROM projection_threads WHERE 0"), [
        "rewrites-existing-data",
      ]);
      // A rebuilt table: a NOT NULL column without a default, and the drop and rename.
      const rebuilt = yield* rulesOf(
        "CREATE TABLE probe_rebuild AS SELECT * FROM projection_projects",
        "DROP TABLE probe_rebuild",
        "ALTER TABLE projection_projects RENAME TO projection_projects_old",
        `CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, required TEXT NOT NULL)`,
      );
      assert.includeMembers(rebuilt, ["changes-existing-table", "not-null-without-default"]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});

describe("starting on a database a newer Moss migrated", () => {
  it("refuses with the current block when the database has no marker", async () => {
    const dbPath = tempDatabase();
    await seedDatabase(dbPath);
    writeAsNewerRelease(dbPath, { migrations: NEWER_ADDITIVE, readerFloor: { raw: 0 } });

    const error = await startFails(dbPath);
    expect(error).toBeInstanceOf(MigrationSchemaTooNewStartupBlockError);
    expect((error as MigrationSchemaTooNewStartupBlockError).block).toMatchObject({
      databaseMigrationId: NEWEST,
      latestSupportedMigrationId: LATEST_MIGRATION_ID,
    });
  });

  it.each([
    // The second newer release was not additive and raised the floor past this build.
    ["a floor above this build", () => encodeMigrationReaderFloor(LATEST_MIGRATION_ID + 1, NEWEST)],
    // Only the first newer release wrote a marker; the second recorded its migration without.
    [
      "a marker the second newer release did not rewrite",
      () => encodeMigrationReaderFloor(LATEST_MIGRATION_ID, LATEST_MIGRATION_ID + 1),
    ],
    // A later migration recorded by something that did not write its own marker: the marker
    // left by this build speaks only for this build's migrations.
    [
      "a marker written for an earlier migration",
      () => encodeMigrationReaderFloor(MIGRATION_READER_FLOOR, LATEST_MIGRATION_ID),
    ],
    [
      "a marker written for a migration the database lacks",
      () => encodeMigrationReaderFloor(LATEST_MIGRATION_ID, LATEST_MIGRATION_ID + 9),
    ],
    ["a marker in another format", () => 12_345],
    ["a marker without a floor", () => NEWEST * 0x10000],
    ["a negative marker", () => -1],
  ])("refuses with the current block on %s", async (_label, marker) => {
    const dbPath = tempDatabase();
    await seedDatabase(dbPath);
    writeAsNewerRelease(dbPath, { migrations: NEWER_ADDITIVE, readerFloor: { raw: marker() } });

    expect(await startFails(dbPath)).toBeInstanceOf(MigrationSchemaTooNewStartupBlockError);
  });

  // Two steps down: two newer releases each added an additive migration, and this build (the
  // floor release they declare) opens what neither was tested against alone.
  it("opens two newer releases' database when the floor allows it and keeps their data through a session", async () => {
    const dbPath = tempDatabase();
    await seedDatabase(dbPath);
    expect(decodeMigrationReaderFloor(readUserVersion(dbPath))).toEqual({
      kind: "floor",
      floor: MIGRATION_READER_FLOOR,
      writtenAt: LATEST_MIGRATION_ID,
    });
    writeAsNewerRelease(dbPath, {
      migrations: NEWER_ADDITIVE,
      readerFloor: LATEST_MIGRATION_ID,
    });
    setFutureColumn(dbPath, '[{"url":"https://example.invalid/pull/1"}]');
    const markerBefore = readUserVersion(dbPath);
    expect(backups(dbPath)).toEqual([]);

    // This build is the older reader: it starts, and a session of writes to the same chat
    // (rename, archive, restore, a new chat) leaves the newer column and table alone.
    const system = await startServer(dbPath);
    try {
      await system.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("reader-floor-cmd-rename"),
        threadId,
        title: "Renamed by the older build",
      });
      await system.dispatch({
        type: "thread.archive",
        commandId: CommandId.makeUnsafe("reader-floor-cmd-archive"),
        threadId,
      });
      await system.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.makeUnsafe("reader-floor-cmd-unarchive"),
        threadId,
      });
      await system.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("reader-floor-cmd-thread-2"),
        threadId: ThreadId.makeUnsafe("reader-floor-thread-2"),
        projectId,
        title: "Written by the older build",
        modelSelection: model,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      });
      const readModel = await system.readModel();
      expect(readModel.threads.find((thread) => thread.id === threadId)?.title).toBe(
        "Renamed by the older build",
      );
    } finally {
      await system.dispose();
    }

    expect(readFuture(dbPath)).toEqual({
      links: '[{"url":"https://example.invalid/pull/1"}]',
      notes: 1,
      latestRecorded: NEWEST,
    });
    // Nothing ran, so no pre-migration backup was taken and the marker is the newer build's.
    expect(backups(dbPath)).toEqual([]);
    expect(readUserVersion(dbPath)).toBe(markerBefore);
    // Opened again later it reads the same way: still allowed, still nothing to run or back up.
    const reopened = await Effect.runPromise(
      Effect.gen(function* () {
        const inspection = yield* inspectCurrentMigrationLineage;
        const plan = yield* inspectMigrationBackupPlan;
        return { classification: inspection.classification, plan };
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath }))),
    );
    expect(reopened.classification).toEqual({
      kind: "moss-prefix",
      highWaterMark: NEWEST,
      newerMigrationsIgnoredFrom: LATEST_MIGRATION_ID + 1,
    });
    expect(reopened.plan).toBeNull();
  });

  it("resumes or refuses a newer build's interrupted migration as that build left it", async () => {
    // The newer build is this one; the older reader is the release before it.
    const previous = LATEST_MIGRATION_ID - 1;
    const interrupted = async () => {
      const dbPath = tempDatabase();
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* runMigrations({ toMigrationInclusive: previous });
          yield* runWithPreMigrationBackup(
            dbPath,
            Effect.fail(new Error("interrupted mid-flight")),
          );
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath }))),
      ).catch(() => undefined);
      const marker = await Effect.runPromise(inspectPendingMigrationRecovery(dbPath));
      expect(marker).not.toBeNull();
      return { dbPath, marker: marker! };
    };
    const resumeAsOlder = (
      dbPath: string,
      marker: NonNullable<Awaited<ReturnType<typeof interrupted>>["marker"]>,
    ) =>
      Effect.runPromise(
        resumeMarkedMigration(dbPath, marker, runMigrationsAsRelease(previous)).pipe(
          Effect.provide(NodeSqliteClient.layer({ filename: dbPath })),
        ),
      );
    const commitAsNewer = (dbPath: string) =>
      Effect.runPromise(
        runMigrations({ toMigrationInclusive: LATEST_MIGRATION_ID }).pipe(
          Effect.provide(NodeSqliteClient.layer({ filename: dbPath })),
        ),
      );

    // Stopped before its migration committed: the older reader finds nothing it lacks,
    // finishes the resume and clears the marker; the newer build migrates again later.
    const beforeCommit = await interrupted();
    await expect(resumeAsOlder(beforeCommit.dbPath, beforeCommit.marker)).resolves.toEqual([]);
    expect(fs.existsSync(migrationRecoveryMarkerPath(beforeCommit.dbPath))).toBe(false);

    // Committed, then stopped before its floor was written: the older reader refuses as
    // "database newer than Moss" and the marker (and its backup) stay for the restore.
    const noFloor = await interrupted();
    await commitAsNewer(noFloor.dbPath);
    const setMarker = (dbPath: string, value: number) => {
      const database = new DatabaseSync(dbPath);
      try {
        database.exec(`PRAGMA user_version = ${value}`);
      } finally {
        database.close();
      }
    };
    setMarker(noFloor.dbPath, 0);
    await expect(resumeAsOlder(noFloor.dbPath, noFloor.marker)).rejects.toBeInstanceOf(
      MigrationSchemaTooNewError,
    );
    expect(fs.existsSync(migrationRecoveryMarkerPath(noFloor.dbPath))).toBe(true);

    // Committed with a floor that admits the older reader: it opens and finishes the resume.
    const admitted = await interrupted();
    await commitAsNewer(admitted.dbPath);
    setMarker(admitted.dbPath, encodeMigrationReaderFloor(previous, LATEST_MIGRATION_ID));
    await expect(resumeAsOlder(admitted.dbPath, admitted.marker)).resolves.toEqual([]);
    expect(fs.existsSync(migrationRecoveryMarkerPath(admitted.dbPath))).toBe(false);
  });

  it("still backs up and migrates an older database as before", async () => {
    const dbPath = tempDatabase();
    await Effect.runPromise(
      runMigrations({ toMigrationInclusive: LATEST_MIGRATION_ID - 1 }).pipe(
        Effect.provide(NodeSqliteClient.layer({ filename: dbPath })),
      ),
    );
    expect(readUserVersion(dbPath)).toBe(0);
    expect(backups(dbPath)).toEqual([]);

    const system = await startServer(dbPath);
    await system.dispose();

    // The pre-migration snapshot is taken as today, and the run that
    // migrated the database records this build's floor.
    expect(backups(dbPath)).toHaveLength(1);
    expect(decodeMigrationReaderFloor(readUserVersion(dbPath))).toEqual({
      kind: "floor",
      floor: MIGRATION_READER_FLOOR,
      writtenAt: LATEST_MIGRATION_ID,
    });
  });
});
