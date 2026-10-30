import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationBackupRequiredError } from "./Errors.ts";
import {
  migrationBackupDirectory,
  migrationRecoveryMarkerPath,
  runWithPreMigrationBackup,
} from "./MigrationBackup.ts";
import { migrationEntries, runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";
import Migration0053 from "./Migrations/053_BackfillThreadActivitySequence.ts";
import Migration0054 from "./Migrations/054_ReservedDurableProviderCommandDelivery.ts";
import Migration0055 from "./Migrations/055_ManagedAttachments.ts";
import Migration0056 from "./Migrations/056_CommandReceiptFingerprints.ts";
import Migration0057 from "./Migrations/057_ThreadScopedProjectionMessageIdentity.ts";
import Migration0058 from "./Migrations/058_ThreadScopedPendingApprovalIdentity.ts";
import Migration0059 from "./Migrations/059_ProviderSessionLifecycleGeneration.ts";
import Migration0060 from "./Migrations/060_PendingApprovalLifecycleGeneration.ts";
import Migration0061 from "./Migrations/061_PendingApprovalSettlementState.ts";
import Migration0062 from "./Migrations/062_PendingInteractionSettlementParity.ts";
import Migration0063 from "./Migrations/063_ProjectionMessageCausalSequence.ts";
import Migration0064 from "./Migrations/064_DurableProviderCommandDelivery.ts";
import Migration0065 from "./Migrations/065_DurableQueuedTurnPromotions.ts";
import Migration0066 from "./Migrations/066_DurableProviderRuntimeEvents.ts";
import Migration0067 from "./Migrations/067_ProviderDeliveryReconciliation.ts";
import Migration0068 from "./Migrations/068_GitHandoffOperations.ts";
import Migration0069 from "./Migrations/069_ProjectPullRequestPins.ts";
import Migration0070 from "./Migrations/070_AgentGatewayOperations.ts";
import Migration0071 from "./Migrations/071_ProjectionThreadsGatewayProvenance.ts";
import Migration0072 from "./Migrations/072_AgentGatewayOperationRetention.ts";
import Migration0073 from "./Migrations/073_OperationalDiagnostics.ts";
import Migration0074 from "./Migrations/074_ExternalMcpIntegrations.ts";
import Migration0075 from "./Migrations/075_ExternalMcpActiveCapacity.ts";
import Migration0076 from "./Migrations/076_ExternalMcpHardening.ts";
import Migration0077 from "./Migrations/077_ExternalMcpCompensatingCapacity.ts";
import Migration0078 from "./Migrations/078_ExternalMcpLiveTurnCapacity.ts";
import Migration0079 from "./Migrations/079_Spaces.ts";

const upstreamMigrations = [
  [53, "BackfillThreadActivitySequence", Migration0053],
  [54, "DurableProviderCommandDelivery", Migration0054],
  [55, "ManagedAttachments", Migration0055],
  [56, "CommandReceiptFingerprints", Migration0056],
  [57, "ThreadScopedProjectionMessageIdentity", Migration0057],
  [58, "ThreadScopedPendingApprovalIdentity", Migration0058],
  [59, "ProviderSessionLifecycleGeneration", Migration0059],
  [60, "PendingApprovalLifecycleGeneration", Migration0060],
  [61, "PendingApprovalSettlementState", Migration0061],
  [62, "PendingInteractionSettlementParity", Migration0062],
  [63, "ProjectionMessageCausalSequence", Migration0063],
  [64, "DurableProviderCommandDeliveryCutover", Migration0064],
  [65, "DurableQueuedTurnPromotions", Migration0065],
  [66, "DurableProviderRuntimeEvents", Migration0066],
  [67, "ProviderDeliveryReconciliation", Migration0067],
  [68, "GitHandoffOperations", Migration0068],
  [69, "ProjectPullRequestPins", Migration0069],
  [70, "AgentGatewayOperations", Migration0070],
  [71, "ProjectionThreadsGatewayProvenance", Migration0071],
  [72, "AgentGatewayOperationRetention", Migration0072],
  [73, "OperationalDiagnostics", Migration0073],
  [74, "ExternalMcpIntegrations", Migration0074],
  [75, "ExternalMcpActiveCapacity", Migration0075],
  [76, "ExternalMcpHardening", Migration0076],
  [77, "ExternalMcpCompensatingCapacity", Migration0077],
  [78, "ExternalMcpLiveTurnCapacity", Migration0078],
  [79, "Spaces", Migration0079],
] as const;

const latestMigrationId = migrationEntries.at(-1)?.[0] ?? 0;

const tempDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true })),
  );
});

async function makeDbPath(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "moss-upstream-adoption-"));
  tempDirectories.push(directory);
  return path.join(directory, "state.sqlite");
}

const runWithDatabase = <A, E>(dbPath: string, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath }))));

const trackerRows = (sql: SqlClient.SqlClient) =>
  sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;

const seedUpstream = (highWaterMark: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 52 });
    for (const [id, name, migration] of upstreamMigrations) {
      if (id > highWaterMark) break;
      yield* migration;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${id}, ${name})
      `;
    }
  });

const schemaHash = (sql: SqlClient.SqlClient) =>
  sql<{ readonly type: string; readonly name: string; readonly sql: string | null }>`
    SELECT type, name, sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `.pipe(Effect.map((rows) => createHash("sha256").update(JSON.stringify(rows)).digest("hex")));

describe("upstream 3cefd5a database adoption", () => {
  it("requires a durable backup before changing an exact upstream tracker", async () => {
    const dbPath = await makeDbPath();
    await runWithDatabase(
      dbPath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedUpstream(79);
        const before = yield* trackerRows(sql);
        const error = yield* Effect.flip(runMigrations());
        expect(error).toBeInstanceOf(MigrationBackupRequiredError);
        if (!(error instanceof MigrationBackupRequiredError)) {
          throw error;
        }
        expect({ tag: error._tag, message: error.message }).toEqual({
          tag: "MigrationBackupRequiredError",
          message: expect.stringContaining("requires a durable pre-migration backup"),
        });
        expect(yield* trackerRows(sql)).toEqual(before);
      }),
    );
    await expect(fs.stat(migrationBackupDirectory(dbPath))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("adopts every exact upstream high-water mark 69-79 and is repeatable", async () => {
    for (let highWaterMark = 69; highWaterMark <= 79; highWaterMark += 1) {
      const dbPath = await makeDbPath();
      await runWithDatabase(
        dbPath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* seedUpstream(highWaterMark);
          yield* sql`CREATE TABLE adoption_sentinel(value TEXT NOT NULL)`;
          yield* sql`INSERT INTO adoption_sentinel(value) VALUES (${`sentinel-${highWaterMark}`})`;

          const executed = yield* runWithPreMigrationBackup(dbPath, runMigrations());
          expect(executed).toEqual(
            migrationEntries.filter(([id]) => id >= 53).map(([id, name]) => [id, name]),
          );
          expect(yield* trackerRows(sql)).toEqual(
            migrationEntries.map(([migration_id, name]) => ({ migration_id, name })),
          );
          expect(yield* sql`SELECT value FROM adoption_sentinel`).toEqual([
            { value: `sentinel-${highWaterMark}` },
          ]);
          expect(yield* sql`PRAGMA foreign_key_check`).toEqual([]);
          expect(yield* sql`PRAGMA integrity_check`).toEqual([{ integrity_check: "ok" }]);
          const hash = yield* schemaHash(sql);
          expect(yield* runWithPreMigrationBackup(dbPath, runMigrations())).toEqual([]);
          expect(yield* schemaHash(sql)).toBe(hash);
        }),
      );
      expect(
        (await fs.readdir(migrationBackupDirectory(dbPath))).filter((name) =>
          name.endsWith(".sqlite.gz"),
        ),
      ).toHaveLength(1);
    }
  }, 30_000);

  it("rolls the tracker back when adoption fails after reconciliation", async () => {
    const dbPath = await makeDbPath();
    let trackerBefore: ReadonlyArray<{ readonly migration_id: number; readonly name: string }> = [];
    await expect(
      runWithDatabase(
        dbPath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* seedUpstream(79);
          trackerBefore = yield* trackerRows(sql);
          yield* runWithPreMigrationBackup(
            dbPath,
            runMigrations({ injectFailureAfterLineageReconciliation: true }),
          );
        }),
      ),
    ).rejects.toThrow("injected failure after lineage reconciliation");

    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(
        database
          .prepare("SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id")
          .all(),
      ).toEqual(trackerBefore);
    } finally {
      database.close();
    }
    await expect(fs.stat(migrationRecoveryMarkerPath(dbPath))).resolves.toBeDefined();
  });

  it("resumes every exact partial Moss upgrade from 79 through the current predecessor without deleting tracker or application rows", async () => {
    for (let highWaterMark = 79; highWaterMark < latestMigrationId; highWaterMark += 1) {
      const dbPath = await makeDbPath();
      await runWithDatabase(
        dbPath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations({ toMigrationInclusive: highWaterMark });
          const trackerPrefix = yield* trackerRows(sql);
          const expectedPrefix = migrationEntries
            .filter(([id]) => id <= highWaterMark)
            .map(([migration_id, name]) => ({ migration_id, name }));
          const expectedSuffix = migrationEntries
            .filter(([id]) => id > highWaterMark)
            .map(([id, name]) => [id, name]);

          yield* sql`CREATE TABLE partial_upgrade_sentinel(value TEXT NOT NULL)`;
          yield* sql`
            INSERT INTO partial_upgrade_sentinel(value)
            VALUES (${`sentinel-${highWaterMark}`})
          `;
          yield* sql`
            INSERT INTO orchestration_events(
              event_id,
              aggregate_kind,
              stream_id,
              stream_version,
              event_type,
              occurred_at,
              command_id,
              causation_event_id,
              correlation_id,
              actor_kind,
              payload_json,
              metadata_json
            ) VALUES (
              ${`event-${highWaterMark}`},
              'project',
              ${`project-${highWaterMark}`},
              1,
              'project.created',
              '2026-07-22T00:00:00.000Z',
              ${`command-${highWaterMark}`},
              NULL,
              ${`correlation-${highWaterMark}`},
              'user',
              ${JSON.stringify({ projectId: `project-${highWaterMark}`, preserved: true })},
              ${JSON.stringify({ source: "partial-upgrade-test" })}
            )
          `;

          expect(trackerPrefix).toEqual(expectedPrefix);

          expect(expectedSuffix.map(([id]) => id)).toEqual(
            Array.from(
              { length: latestMigrationId - highWaterMark },
              (_, index) => highWaterMark + index + 1,
            ),
          );
          expect(yield* runWithPreMigrationBackup(dbPath, runMigrations())).toEqual(expectedSuffix);
          expect(yield* trackerRows(sql)).toEqual(
            migrationEntries.map(([migration_id, name]) => ({ migration_id, name })),
          );
          expect((yield* trackerRows(sql)).slice(0, highWaterMark)).toEqual(trackerPrefix);
          expect(yield* sql`SELECT value FROM partial_upgrade_sentinel`).toEqual([
            { value: `sentinel-${highWaterMark}` },
          ]);
          expect(
            yield* sql`
              SELECT event_id, stream_id, command_id, correlation_id, payload_json, metadata_json
              FROM orchestration_events
              WHERE event_id = ${`event-${highWaterMark}`}
            `,
          ).toEqual([
            {
              event_id: `event-${highWaterMark}`,
              stream_id: `project-${highWaterMark}`,
              command_id: `command-${highWaterMark}`,
              correlation_id: `correlation-${highWaterMark}`,
              payload_json: JSON.stringify({
                projectId: `project-${highWaterMark}`,
                preserved: true,
              }),
              metadata_json: JSON.stringify({ source: "partial-upgrade-test" }),
            },
          ]);
          expect(yield* sql`PRAGMA foreign_key_check`).toEqual([]);
          expect(yield* sql`PRAGMA integrity_check`).toEqual([{ integrity_check: "ok" }]);
        }),
      );
      expect(
        (await fs.readdir(migrationBackupDirectory(dbPath))).filter((name) =>
          name.endsWith(".sqlite.gz"),
        ),
      ).toHaveLength(1);
    }
  }, 30_000);
});
