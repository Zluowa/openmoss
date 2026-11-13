import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";
import { Effect, Exit, Layer } from "effect";

import { MigrationLineageError } from "./Errors.ts";
import {
  MigrationDivergenceConsentRequiredError,
  MigrationRepairFailedError,
  createMigrationBackup,
  inspectPendingMigrationRecovery,
  migrationBackupDirectory,
  migrationBackupProvenancePath,
  migrationRecoveryMarkerPath,
  resumeMarkedMigration,
  runWithPreMigrationBackup,
} from "./MigrationBackup.ts";
import {
  T3CODE_IMPORT_LAST_ACCEPTED_ID,
  inspectCurrentMigrationLineage,
} from "./MigrationLineage.ts";
import { migrationEntries, runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";
import { ProjectionThreadMessageRepository } from "./Services/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepositoryLive } from "./Layers/ProjectionThreadMessages.ts";
import { migrationRepairFailurePath } from "@moss/shared/migrationRecovery";
import { ORCHESTRATION_PROJECTOR_NAMES } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  T3CODE_V54_FIXTURE_COUNTS,
  T3CODE_V54_FIXTURE_MESSAGE,
  seedT3CodeV54Import,
} from "./t3codeV54ImportFixture.ts";

const LATEST_ID = Math.max(...migrationEntries.map(([id]) => id));
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function makeImportedDatabase(
  seed: (database: DatabaseSync) => void = (database) => seedT3CodeV54Import(database),
): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "moss-t3-import-"));
  directories.push(directory);
  const dbPath = path.join(directory, "state.sqlite");
  const database = new DatabaseSync(dbPath);
  try {
    seed(database);
  } finally {
    database.close();
  }
  return dbPath;
}

const runWithDatabase = <A, E, R>(dbPath: string, effect: Effect.Effect<A, E, R>) =>
  Effect.runPromiseExit(
    effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath }))) as Effect.Effect<
      A,
      E
    >,
  );

const failureOf = <A, E>(exit: Exit.Exit<A, E>): unknown => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure");
  const reason = exit.cause.reasons.find((entry) => entry._tag === "Fail");
  return reason?._tag === "Fail" ? reason.error : exit.cause;
};

const consentTokenFor = async (dbPath: string): Promise<string> => {
  const exit = await runWithDatabase(dbPath, runWithPreMigrationBackup(dbPath, runMigrations()));
  const error = failureOf(exit);
  expect(error).toBeInstanceOf(MigrationDivergenceConsentRequiredError);
  return (error as MigrationDivergenceConsentRequiredError).challenge.consentToken;
};

function rowCounts(dbPath: string, tables: ReadonlyArray<string>): Record<string, number> {
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Object.fromEntries(
      tables.map((table) => [
        table,
        (database.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n,
      ]),
    );
  } finally {
    database.close();
  }
}

function trackerOf(dbPath: string): ReadonlyArray<unknown> {
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return database
      .prepare("SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id")
      .all();
  } finally {
    database.close();
  }
}

const fixtureTables = Object.keys(T3CODE_V54_FIXTURE_COUNTS);
const exists = (file: string) =>
  fs.stat(file).then(
    () => true,
    () => false,
  );

describe("T3 Code import lineage", () => {
  it("recognizes the exact imported state and asks for consent before changing anything", async () => {
    const dbPath = await makeImportedDatabase();
    const before = trackerOf(dbPath);

    const classification = await runWithDatabase(
      dbPath,
      inspectCurrentMigrationLineage.pipe(Effect.map((inspection) => inspection.classification)),
    );
    expect(Exit.isSuccess(classification) && classification.value).toEqual({
      kind: "t3code-import-prefix",
      highWaterMark: 54,
      firstDivergedId: 17,
    });

    const exit = await runWithDatabase(dbPath, runWithPreMigrationBackup(dbPath, runMigrations()));
    const error = failureOf(exit) as MigrationDivergenceConsentRequiredError;
    expect(error).toBeInstanceOf(MigrationDivergenceConsentRequiredError);
    expect(error.challenge).toMatchObject({
      firstDivergedId: 17,
      recordedName: "ProjectionThreadsArchivedAt",
      expectedName: "ThreadHandoffMetadata",
      sourceVersion: "imported-v54-from17",
      targetVersion: LATEST_ID,
    });
    expect(trackerOf(dbPath)).toEqual(before);
    expect(await exists(migrationBackupDirectory(dbPath))).toBe(false);
  });

  it("keeps what the consent promises: backup, then a migrated database with data intact", async () => {
    const dbPath = await makeImportedDatabase();
    const consent = await consentTokenFor(dbPath);

    const exit = await runWithDatabase(
      dbPath,
      runWithPreMigrationBackup(dbPath, runMigrations(), { divergenceConsent: consent }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);

    const after = await runWithDatabase(
      dbPath,
      inspectCurrentMigrationLineage.pipe(Effect.map((inspection) => inspection.classification)),
    );
    expect(Exit.isSuccess(after) && after.value).toEqual({
      kind: "moss-prefix",
      highWaterMark: LATEST_ID,
    });
    expect(rowCounts(dbPath, fixtureTables)).toEqual(T3CODE_V54_FIXTURE_COUNTS);

    // Through the repository the app reads with, not just raw counts.
    const messages = await runWithDatabase(
      dbPath,
      Effect.gen(function* () {
        const repository = yield* ProjectionThreadMessageRepository;
        return yield* repository.listByThreadId({
          threadId: T3CODE_V54_FIXTURE_MESSAGE.threadId as never,
        });
      }).pipe(Effect.provide(ProjectionThreadMessageRepositoryLive)),
    );
    expect(Exit.isSuccess(messages)).toBe(true);
    if (Exit.isSuccess(messages)) {
      expect(messages.value.map((message) => message.text)).toContain(
        T3CODE_V54_FIXTURE_MESSAGE.text,
      );
    }

    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      database.close();
    }

    expect(await exists(migrationRecoveryMarkerPath(dbPath))).toBe(false);
    expect(await exists(migrationBackupProvenancePath(dbPath))).toBe(true);
    const backups = (await fs.readdir(migrationBackupDirectory(dbPath))).filter((name) =>
      name.endsWith(".sqlite.gz"),
    );
    expect(backups).toHaveLength(1);
    const inspection = path.join(path.dirname(dbPath), "backup-inspection.sqlite");
    await fs.writeFile(
      inspection,
      gunzipSync(await fs.readFile(path.join(migrationBackupDirectory(dbPath), backups[0]!))),
    );
    expect(trackerOf(inspection)).toHaveLength(54);
    expect(rowCounts(inspection, fixtureTables)).toEqual(T3CODE_V54_FIXTURE_COUNTS);
    await fs.rm(inspection, { force: true });

    // The next launch has nothing left to ask.
    const again = await runWithDatabase(dbPath, runWithPreMigrationBackup(dbPath, runMigrations()));
    expect(Exit.isSuccess(again)).toBe(true);
  });

  it("starts the read model when an imported thread has no model selection", async () => {
    // Migration 16 backfilled NULL model selections in Moss's own lineage, but an
    // import replays only from 17, so a T3 Code thread without one arrives as is.
    const dbPath = await makeImportedDatabase((database) => {
      seedT3CodeV54Import(database);
      database
        .prepare(
          `INSERT INTO projection_threads
            (thread_id, project_id, title, created_at, updated_at, model_selection_json)
           VALUES ('imported-without-model', 'fixture-project-1', 'No model', ?, ?, NULL)`,
        )
        .run("2026-09-01T08:00:00.000Z", "2026-09-01T08:00:00.000Z");
    });
    const consent = await consentTokenFor(dbPath);
    const migrated = await runWithDatabase(
      dbPath,
      runWithPreMigrationBackup(dbPath, runMigrations(), { divergenceConsent: consent }),
    );
    expect(Exit.isSuccess(migrated)).toBe(true);
    // What the projection bootstrap does first on an empty journal: give every
    // projector a cursor.
    const cursors = new DatabaseSync(dbPath);
    try {
      const insert = cursors.prepare(
        `INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
         VALUES (?, 0, '2026-09-01T08:00:00.000Z') ON CONFLICT (projector) DO NOTHING`,
      );
      for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) insert.run(projector);
    } finally {
      cursors.close();
    }

    const readModel = await runWithDatabase(
      dbPath,
      Effect.gen(function* () {
        const query = yield* ProjectionSnapshotQuery;
        return yield* query.getCommandReadModel();
      }).pipe(
        Effect.provide(
          OrchestrationProjectionSnapshotQueryLive.pipe(
            Layer.provide(ServerSettingsService.layerTest()),
          ),
        ),
      ),
    );
    expect(Exit.isSuccess(readModel)).toBe(true);
    if (Exit.isSuccess(readModel)) {
      expect(readModel.value.threads.map((thread) => thread.id).toSorted()).toEqual([
        "fixture-thread-1",
        "fixture-thread-2",
        "fixture-thread-3",
      ]);
    }
    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(
        database
          .prepare(
            "SELECT model_selection_json AS model FROM projection_threads WHERE thread_id = 'imported-without-model'",
          )
          .get(),
      ).toEqual({ model: null });
    } finally {
      database.close();
    }
  });

  it("rolls a failed replay back whole, says so once, and doesn't offer the same repair again", async () => {
    // A foreign view named like a table a later migration creates: a real failure well past 17.
    const dbPath = await makeImportedDatabase((database) => {
      seedT3CodeV54Import(database);
      database.exec("CREATE VIEW automation_definitions AS SELECT 1 AS id");
    });
    const before = trackerOf(dbPath);
    const consent = await consentTokenFor(dbPath);

    const exit = await runWithDatabase(
      dbPath,
      runWithPreMigrationBackup(dbPath, runMigrations(), { divergenceConsent: consent }),
    );
    const error = failureOf(exit);
    expect(error).toBeInstanceOf(MigrationRepairFailedError);

    expect(trackerOf(dbPath)).toEqual(before);
    expect(rowCounts(dbPath, fixtureTables)).toEqual(T3CODE_V54_FIXTURE_COUNTS);
    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const tables = database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projection_spaces'",
        )
        .all();
      expect(tables, "no half-applied schema").toEqual([]);
    } finally {
      database.close();
    }

    // No recovery dialog to loop on: nothing needs restoring.
    expect(await exists(migrationRecoveryMarkerPath(dbPath))).toBe(false);
    expect(await Effect.runPromise(inspectPendingMigrationRecovery(dbPath))).toBeNull();

    const nextLaunch = await runWithDatabase(
      dbPath,
      runWithPreMigrationBackup(dbPath, runMigrations(), { divergenceConsent: consent }),
    );
    expect(failureOf(nextLaunch)).toBeInstanceOf(MigrationRepairFailedError);
    expect(trackerOf(dbPath)).toEqual(before);
    // The dialog points at this backup, so a later launch must not have pruned it.
    const namedBackup = (failureOf(nextLaunch) as MigrationRepairFailedError).failure.backupPath;
    expect(await exists(namedBackup)).toBe(true);

    // A build with a newer target gets its own attempt, and consent is asked for again.
    const recordPath = migrationRepairFailurePath(dbPath);
    const record = JSON.parse(await fs.readFile(recordPath, "utf8")) as Record<string, unknown>;
    await fs.writeFile(recordPath, JSON.stringify({ ...record, targetVersion: LATEST_ID - 1 }));
    const newerBuild = await runWithDatabase(
      dbPath,
      runWithPreMigrationBackup(dbPath, runMigrations()),
    );
    expect(failureOf(newerBuild)).toBeInstanceOf(MigrationDivergenceConsentRequiredError);
    expect(await exists(recordPath)).toBe(false);
  });

  it("finishes the job for a database a refusing build left with a recovery marker", async () => {
    const dbPath = await makeImportedDatabase();
    const markerPath = migrationRecoveryMarkerPath(dbPath);
    const backup = await runWithDatabase(
      dbPath,
      createMigrationBackup(dbPath, {
        sourceVersion: "imported-v54-from17",
        targetVersion: LATEST_ID,
      }),
    );
    if (!Exit.isSuccess(backup)) throw new Error("the fixture backup failed");
    const backupPath = backup.value.backupPath;
    await fs.writeFile(
      markerPath,
      JSON.stringify({
        version: 1,
        databasePath: dbPath,
        backupPath,
        sourceVersion: "imported-v54-from17",
        targetVersion: LATEST_ID,
        phase: "migration-in-progress",
        createdAt: "2026-11-01T00:00:00.000Z",
        resumeAttempts: 1,
      }),
    );

    const marker = await Effect.runPromise(inspectPendingMigrationRecovery(dbPath));
    expect(marker).not.toBeNull();
    const exit = await runWithDatabase(
      dbPath,
      resumeMarkedMigration(dbPath, marker!, runMigrations()),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(trackerOf(dbPath)).toHaveLength(LATEST_ID);
    expect(rowCounts(dbPath, fixtureTables)).toEqual(T3CODE_V54_FIXTURE_COUNTS);
    expect(await exists(markerPath)).toBe(false);
  });

  it("refuses a T3 Code tracker past its last V1 migration", async () => {
    expect(T3CODE_IMPORT_LAST_ACCEPTED_ID).toBe(54);
    const past = await makeImportedDatabase((database) => {
      seedT3CodeV54Import(database);
      database
        .prepare(
          "INSERT INTO effect_sql_migrations (migration_id, name) VALUES (55, 'OrchestrationV2')",
        )
        .run();
    });
    const exit = await runWithDatabase(past, runWithPreMigrationBackup(past, runMigrations()));
    expect(failureOf(exit)).toBeInstanceOf(MigrationLineageError);
    expect(await exists(migrationBackupDirectory(past))).toBe(false);
  });

  const refusals: ReadonlyArray<readonly [string, (database: DatabaseSync) => void]> = [
    [
      "a forged tracker whose schema proof is missing",
      (database) => {
        seedT3CodeV54Import(database);
        database.exec("DROP TABLE pull_request_files_viewed");
      },
    ],
    [
      "a mixed name inside the T3 Code range",
      (database) => {
        seedT3CodeV54Import(database);
        database.exec("UPDATE effect_sql_migrations SET name = 'Mystery' WHERE migration_id = 30");
      },
    ],
    [
      "a gap in the tracker",
      (database) => {
        seedT3CodeV54Import(database);
        database.exec("DELETE FROM effect_sql_migrations WHERE migration_id = 40");
      },
    ],
    [
      "a divergence inside the shared range",
      (database) => {
        seedT3CodeV54Import(database);
        database.exec("UPDATE effect_sql_migrations SET name = 'Mystery' WHERE migration_id = 5");
      },
    ],
    [
      "wholly foreign names past the shared range",
      (database) => {
        seedT3CodeV54Import(database);
        database.exec(
          "UPDATE effect_sql_migrations SET name = 'Foreign' || migration_id WHERE migration_id >= 17",
        );
      },
    ],
  ];

  for (const [label, seed] of refusals) {
    it(`refuses ${label}, with no consent offered and nothing changed`, async () => {
      const dbPath = await makeImportedDatabase(seed);
      const before = trackerOf(dbPath);
      const exit = await runWithDatabase(
        dbPath,
        runWithPreMigrationBackup(dbPath, runMigrations(), { divergenceConsent: "anything" }),
      );
      expect(failureOf(exit)).toBeInstanceOf(MigrationLineageError);
      expect(trackerOf(dbPath)).toEqual(before);
      expect(await exists(migrationBackupDirectory(dbPath))).toBe(false);
      expect(await exists(migrationRecoveryMarkerPath(dbPath))).toBe(false);
    });
  }
});
