// Test-only file SQLite schema. The production profile never creates these tables.
import { Effect } from "effect";
import { runMigrations } from "../../../../persistence/Migrations";
import { RECOVERY_BUNDLE_BYTES, copyRecoveryFloor, equalBytes } from "../roomRecoveryProtocol";
import { roomIdentity } from "../roomEnvelopeProtocol";
import {
  sameInstalledFloor,
  type DeviceInstallCAS,
  type DeviceInstallRead,
  type DeviceInstallStore,
  type DeviceInstallTarget,
  type DeviceInstallWrite,
} from "../roomDeviceInstall";
import { openPublicationFixture, type PublicationFixture } from "./ownerPublicationSqliteFixture";

export async function seedDeviceInstallFixture(filename: string) {
  const db = await openPublicationFixture(filename);
  try {
    await db.run(runMigrations({ toMigrationInclusive: 163 }));
    await db.run(
      db.sql.withTransaction(
        Effect.gen(function* () {
          yield* db.sql`CREATE TABLE fixture_c1c_device_registration (slot TEXT PRIMARY KEY, fence INTEGER NOT NULL, active INTEGER NOT NULL,
        approved_anchor TEXT NOT NULL, installed_once INTEGER NOT NULL, install_version INTEGER NOT NULL)`;
          yield* db.sql`CREATE TABLE fixture_c1c_device_doc (slot TEXT PRIMARY KEY REFERENCES fixture_c1c_device_registration(slot),
        install_version INTEGER NOT NULL, state_digest TEXT NOT NULL, state BLOB NOT NULL)`;
          yield* db.sql`CREATE TABLE fixture_c1c_device_floor (slot TEXT PRIMARY KEY REFERENCES fixture_c1c_device_registration(slot),
        install_version INTEGER NOT NULL, floor_json TEXT NOT NULL)`;
        }),
      ),
    );
  } finally {
    await db.close();
  }
}
export function deviceFixtureSlot(target: DeviceInstallTarget): string {
  return JSON.stringify([target.profileRef, target.deviceRef, roomIdentity(target.room)]);
}
type Registration = { installed_once: number; install_version: number; approved_anchor: string };
export function makeDeviceInstallFixtureStore(db: PublicationFixture) {
  const { sql, run } = db;
  const hooks: {
    beforeRead?: () => Promise<void>;
    beforeCommit?: () => Promise<void>;
    afterCommit?: () => void;
  } = {};
  const snapshot = (target: DeviceInstallTarget, lock: boolean) =>
    Effect.gen(function* () {
      const slot = deviceFixtureSlot(target);
      const [g] = lock
        ? yield* sql<Registration>`UPDATE fixture_c1c_device_registration SET fence=fence WHERE slot=${slot} AND active=1 AND fence=${target.fence}
      RETURNING installed_once,install_version,approved_anchor`
        : yield* sql<Registration>`SELECT installed_once,install_version,approved_anchor
      FROM fixture_c1c_device_registration WHERE slot=${slot} AND active=1 AND fence=${target.fence}`;
      if (!g) return { kind: "revoked" } as const;
      const [d] = yield* sql<{
        install_version: number;
        size: number;
        state: Uint8Array | null;
        state_digest: string;
      }>`SELECT install_version,state_digest,length(state) AS size,
      CASE WHEN length(state) <= ${RECOVERY_BUNDLE_BYTES} AND typeof(state)='blob' THEN state END AS state FROM fixture_c1c_device_doc WHERE slot=${slot}`;
      const [f] = yield* sql<{
        install_version: number;
        floor_json: string;
      }>`SELECT install_version,floor_json FROM fixture_c1c_device_floor WHERE slot=${slot}`;
      if (g.installed_once === 0 && g.install_version === 0 && !d && !f)
        return { kind: "enrolled", version: 0, approvedAnchorDigest: g.approved_anchor } as const;
      if (
        g.installed_once !== 1 ||
        g.install_version < 1 ||
        !d ||
        !f ||
        d.install_version !== g.install_version ||
        f.install_version !== g.install_version
      )
        return { kind: "owner-required" } as const;
      if (d.size > RECOVERY_BUNDLE_BYTES) return { kind: "over-budget" } as const;
      if (!d.state) return { kind: "owner-required" } as const;
      try {
        const floor = copyRecoveryFloor(JSON.parse(f.floor_json));
        if (!floor || roomIdentity(floor.room) !== roomIdentity(target.room))
          return { kind: "owner-required" } as const;
        return {
          kind: "installed",
          version: g.install_version,
          approvedAnchorDigest: g.approved_anchor,
          stateDigest: d.state_digest,
          update: new Uint8Array(d.state),
          floor,
        } as const;
      } catch {
        return { kind: "owner-required" } as const;
      }
    });
  const store: DeviceInstallStore = {
    async read(target): Promise<DeviceInstallRead> {
      await hooks.beforeRead?.();
      return run(sql.withTransaction(snapshot(target, false)));
    },
    async commit(input: DeviceInstallCAS): Promise<DeviceInstallWrite> {
      await hooks.beforeCommit?.(); // Test barrier strictly outside write transaction.
      const outcome = await run(
        sql.withTransaction(
          Effect.gen(function* () {
            const slot = deviceFixtureSlot(input.target);
            const current = yield* snapshot(input.target, true);
            if (current.kind === "revoked" || current.kind === "owner-required")
              return current.kind;
            if (current.kind === "over-budget") return "local-changed" as const;
            if (
              current.approvedAnchorDigest !== input.floor.bundleDigest ||
              current.approvedAnchorDigest !== input.expected.approvedAnchorDigest
            )
              return "anchor-changed" as const;
            if (current.kind !== input.expected.kind || current.version !== input.expected.version)
              return "conflict" as const;
            if (current.kind === "installed" && input.expected.kind === "installed") {
              if (!sameInstalledFloor(current.floor, input.expected.floor))
                return "conflict" as const;
              if (
                current.stateDigest !== input.expected.stateDigest ||
                !equalBytes(current.update, input.expected.update)
              )
                return "local-changed" as const;
            }
            try {
              input.assertCurrent();
            } catch {
              return "revoked" as const;
            }
            if (input.reuse) {
              if (
                current.kind !== "installed" ||
                !sameInstalledFloor(current.floor, input.floor) ||
                current.stateDigest !== input.stateDigest ||
                !equalBytes(current.update, input.update)
              )
                return "conflict" as const;
              return "reused" as const;
            }
            const version = current.version + 1;
            if (!Number.isSafeInteger(version)) return "conflict" as const;
            yield* sql`INSERT INTO fixture_c1c_device_doc(slot,install_version,state_digest,state) VALUES(${slot},${version},${input.stateDigest},${input.update})
          ON CONFLICT(slot) DO UPDATE SET install_version=excluded.install_version,state_digest=excluded.state_digest,state=excluded.state`;
            yield* sql`INSERT INTO fixture_c1c_device_floor(slot,install_version,floor_json) VALUES(${slot},${version},${JSON.stringify(input.floor)})
          ON CONFLICT(slot) DO UPDATE SET install_version=excluded.install_version,floor_json=excluded.floor_json`;
            const updated =
              yield* sql`UPDATE fixture_c1c_device_registration SET installed_once=1,install_version=${version}
          WHERE slot=${slot} AND active=1 AND fence=${input.target.fence} AND approved_anchor=${input.floor.bundleDigest}
            AND install_version=${current.version} RETURNING slot`;
            if (updated.length !== 1)
              return yield* Effect.fail(new Error("fixture device CAS lost during transaction"));
            yield* Effect.try({
              try: input.assertCurrent,
              catch: () => new Error("fixture grant changed before commit"),
            });
            return "installed" as const;
          }),
        ),
      );
      hooks.afterCommit?.();
      return outcome;
    },
  };
  return { store, hooks };
}
