import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import * as path from "node:path";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig, type ServerConfigShape } from "../../../config";
import { ServerEnvironment } from "../../../environment/Services/ServerEnvironment";
import { readPageRoomCommittedCut, type CommittedCutLocator } from "./pageRoomCommittedCut";

type ProfileStorageErrorCode =
  | "profile-mismatch"
  | "profile-id-invalid"
  | "storage-policy-mismatch"
  | "source-schema-unavailable"
  | "fixture-storage";
export class RoomProfileStorageError extends Error {
  constructor(readonly code: ProfileStorageErrorCode) {
    super(`Room profile storage: ${code}`);
  }
}
const problem = (code: ProfileStorageErrorCode) => Effect.fail(new RoomProfileStorageError(code));
const sqlRead = <A, E, R>(effect: Effect.Effect<A, E, R>, code: ProfileStorageErrorCode) =>
  effect.pipe(Effect.mapError(() => new RoomProfileStorageError(code)));

// Only directory realpaths and file metadata. Never open another descriptor
// for the live DB, WAL or SHM: on POSIX its close could disturb process locks.
async function matchesProfile(config: ServerConfigShape, mainFile: string): Promise<boolean> {
  if (
    ![config.baseDir, config.stateDir, config.dbPath, mainFile].every(
      (value) => typeof value === "string" && path.isAbsolute(value),
    )
  )
    return false;
  const directory = config.devUrl === undefined ? "userdata" : "dev";
  if (
    path.resolve(config.stateDir) !== path.resolve(config.baseDir, directory) ||
    path.resolve(config.dbPath) !== path.resolve(config.stateDir, "state.sqlite") ||
    path.resolve(config.environmentIdPath) !== path.resolve(config.stateDir, "environment-id") ||
    path.basename(mainFile) !== "state.sqlite"
  )
    return false;
  const [base, stateDir, mainParent, directoryStat, databaseStat] = await Promise.all([
    realpath(config.baseDir),
    realpath(config.stateDir),
    realpath(path.dirname(mainFile)),
    lstat(config.stateDir),
    lstat(config.dbPath),
  ]);
  return (
    stateDir === path.join(base, directory) &&
    mainParent === stateDir &&
    directoryStat.isDirectory() &&
    !directoryStat.isSymbolicLink() &&
    databaseStat.isFile() &&
    !databaseStat.isSymbolicLink() &&
    databaseStat.nlink === 1
  );
}
const inspectConnection = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const files = yield* sqlRead(
      sql<{ name: string; file: string }>`PRAGMA database_list`,
      "profile-mismatch",
    );
    const main = files.filter((row) => row.name === "main");
    if (
      main.length !== 1 ||
      !main[0]?.file ||
      files.some((row) => row.name !== "main" && row.name !== "temp")
    )
      return yield* problem("profile-mismatch");
    const [journal] = yield* sqlRead(
      sql<{ journal_mode: string }>`PRAGMA main.journal_mode`,
      "storage-policy-mismatch",
    );
    const [locks] = yield* sqlRead(
      sql<{ locking_mode: string }>`PRAGMA main.locking_mode`,
      "storage-policy-mismatch",
    );
    const [fk] = yield* sqlRead(
      sql<{ foreign_keys: number }>`PRAGMA foreign_keys`,
      "storage-policy-mismatch",
    );
    const [sync] = yield* sqlRead(
      sql<{ synchronous: number }>`PRAGMA main.synchronous`,
      "storage-policy-mismatch",
    );
    if (
      journal?.journal_mode !== "wal" ||
      locks?.locking_mode !== "exclusive" ||
      fk?.foreign_keys !== 1 ||
      !sync ||
      (sync.synchronous !== 1 && sync.synchronous !== 2 && sync.synchronous !== 3)
    )
      return yield* problem("storage-policy-mismatch");
    const durability =
      sync.synchronous === 1
        ? ("wal-normal" as const)
        : sync.synchronous === 2
          ? ("wal-full" as const)
          : ("wal-extra" as const);
    return { file: main[0].file, durability };
  });
const inspectSourceSchema = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const fixture = yield* sqlRead(
      sql`SELECT 1 FROM main.sqlite_schema WHERE name GLOB 'fixture_c1c_*' LIMIT 1`,
      "source-schema-unavailable",
    );
    if (fixture.length) return yield* problem("fixture-storage");
    const migration = yield* sqlRead(
      sql`SELECT 1 FROM main.effect_sql_migrations WHERE migration_id=163 AND name='PageRealtimeCuts'`,
      "source-schema-unavailable",
    );
    const [columns] = yield* sqlRead(
      sql<{
        n: number;
      }>`SELECT count(DISTINCT name) AS n FROM pragma_table_info('pages_realtime_docs','main')
    WHERE name IN ('page_id','generation','state','compacted_revision','compacted_key','next_sequence','compacted_through_sequence')`,
      "source-schema-unavailable",
    );
    if (migration.length !== 1 || columns?.n !== 7)
      return yield* problem("source-schema-unavailable");
  });

/** Read-only binding for a caller composed with SqlitePersistenceLive. It does
 * not register a service, open another database, issue an owner/device grant,
 * or interpret the environment namespace/locking mode as proof of freshness.
 */
export const makeRoomProfileAccess = Effect.gen(function* () {
  const config = yield* ServerConfig,
    environment = yield* ServerEnvironment,
    sql = yield* SqlClient.SqlClient;
  const descriptor = yield* environment.getDescriptor;
  const id: string = descriptor.environmentId;
  if (typeof id !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(id))
    return yield* problem("profile-id-invalid");
  const connection = yield* inspectConnection(sql);
  const matches = yield* Effect.tryPromise({
    try: () => matchesProfile(config, connection.file),
    catch: () => new RoomProfileStorageError("profile-mismatch"),
  });
  if (!matches) return yield* problem("profile-mismatch");
  yield* inspectSourceSchema(sql);
  // Home migration may copy environment-id. A matching public namespace says
  // nothing about independent device possession or rollback of the profile.
  const profileRef = `moss-room-profile-${createHash("sha256")
    .update(JSON.stringify(["moss-room-profile", 1, id]))
    .digest("hex")}`;
  const assertCurrent = () =>
    Effect.gen(function* () {
      const current = yield* inspectConnection(sql);
      if (current.file !== connection.file || current.durability !== connection.durability)
        return yield* problem("storage-policy-mismatch");
      yield* inspectSourceSchema(sql);
    });
  const storage = Object.freeze({
    profileRef,
    durability: connection.durability,
    readCommittedCut(expectedProfileRef: string, locator: CommittedCutLocator) {
      if (expectedProfileRef !== profileRef) return problem("profile-mismatch");
      const read = Effect.gen(function* () {
        yield* assertCurrent();
        return yield* sqlRead(readPageRoomCommittedCut(sql, locator), "source-schema-unavailable");
      });
      // Preserve our own fixed guard results, but redact transaction-open/close
      // driver errors as well. This read transaction never mutates user state.
      return sqlRead(sql.withTransaction(Effect.result(read)), "source-schema-unavailable").pipe(
        Effect.flatMap((result) =>
          result._tag === "Failure" ? Effect.fail(result.failure) : Effect.succeed(result.success),
        ),
      );
    },
  });
  return { storage, assertCurrent };
});

export const makeRoomProfileStorage = makeRoomProfileAccess.pipe(
  Effect.map(({ storage }) => storage),
);
