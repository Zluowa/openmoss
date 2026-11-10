import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { RoomBinding } from "./roomEnvelopeProtocol";
import type { RoomKeyProvider } from "./roomEnvelope";
import { makeRoomProfileAccess } from "./roomProfileStorage";
import { createRoomOwnerPublisher, type RoomOwnerProvider } from "./roomOwnerPublication";
import {
  createRoomDeviceInstaller,
  type CurrentOwnerAnchorProvider,
  type DeviceInstallProvider,
} from "./roomDeviceInstall";
import { makePrivateOwnerStore } from "./roomPrivateOwnerStore";
import { makePrivateDeviceStore } from "./roomPrivateDeviceStore";
import {
  RoomPrivateStoreError,
  type RoomPrivateStoreAuthority,
  type VerifiedOwnerControl,
  type VerifiedDeviceControl,
} from "./roomPrivateStoreAuthority";

export interface RoomPrivateStorageConfig {
  readonly authority: RoomPrivateStoreAuthority;
  readonly keys: RoomKeyProvider;
  readonly anchors: CurrentOwnerAnchorProvider;
}
function activeGrant<T extends VerifiedOwnerControl | VerifiedDeviceControl>(
  grant: T | null,
  profileRef: string,
) {
  if (!grant) return null;
  try {
    const deadline = grant.expiresAt,
      revoked = grant.revoked;
    if (
      !grant.active ||
      grant.target.profileRef !== profileRef ||
      !Number.isFinite(deadline) ||
      deadline - performance.now() > 30_000
    )
      throw new Error();
    const assertCurrent = () => {
      if (revoked.aborted || performance.now() >= deadline) throw new Error();
      grant.assertCurrent();
      if (revoked.aborted || performance.now() >= deadline) throw new Error();
    };
    assertCurrent();
    return {
      target: grant.target as T["target"],
      revoked,
      assertCurrent,
      release: () => grant.release(),
    };
  } catch {
    try {
      grant.release();
    } catch {
      /* Provider diagnostics stay private. */
    }
    return null;
  }
}
/** Explicit local composition only. Ordinary server startup never configures
 * an authority, opens a room key, or enrolls a device through this adapter. */
export const makeRoomPrivateStorage = (config?: RoomPrivateStorageConfig) =>
  Effect.gen(function* () {
    if (!config) return null;
    const sql = yield* SqlClient.SqlClient;
    const { storage: profile, assertCurrent } = yield* makeRoomProfileAccess;
    let closed = false;
    const checkStorage = Effect.gen(function* () {
      if (closed) return yield* Effect.fail(new RoomPrivateStoreError("authority-required"));
      yield* assertCurrent();
      const receipt =
        yield* sql`SELECT 1 FROM main.effect_sql_migrations WHERE migration_id=165 AND name='PageRoomPrivateStores'`;
      const [tables] = yield* sql<{
        n: number;
      }>`SELECT count(*) AS n FROM main.sqlite_schema WHERE type='table' AND name IN
      ('pages_room_owner_slots','pages_room_owner_publications','pages_room_owner_outbox','pages_room_device_slots','pages_room_device_installs')`;
      if (receipt.length !== 1 || tables?.n !== 5)
        return yield* Effect.fail(new RoomPrivateStoreError("storage-unavailable"));
    });
    yield* checkStorage;
    const ctx = {
      sql,
      profileRef: profile.profileRef,
      authority: config.authority,
      isClosed: () => closed,
      checkStorage,
    };
    const owner = makePrivateOwnerStore(ctx),
      device = makePrivateDeviceStore(ctx);
    // Original in-flight owner/device leases also carry the independently verified
    // deadline. Every store transaction reacquires and compares current control.
    const owners: RoomOwnerProvider = {
      capture: (room) => activeGrant(config.authority.owner(room), profile.profileRef),
    };
    const devices: DeviceInstallProvider = {
      capture: (room) => activeGrant(config.authority.device(room), profile.profileRef),
    };
    const publisher = createRoomOwnerPublisher(config.keys, owners, owner.store);
    const installer = createRoomDeviceInstaller(config.keys, devices, config.anchors, device.store);
    return Object.freeze({
      profileRef: profile.profileRef,
      publisher,
      installer,
      applyOwnerControl: (room: RoomBinding, expected: number | null) =>
        owner.applyControl(room, expected),
      refreshOwnerControl: (room: RoomBinding) => owner.applyControl(room, "existing"),
      applyDeviceControl: (room: RoomBinding, expected: number | null) =>
        device.applyControl(room, expected),
      refreshDeviceControl: (room: RoomBinding) => device.applyControl(room, "existing"),
      pendingDelivery: owner.pendingDelivery,
      pendingOwnerCheckpoint: owner.pendingOwnerCheckpoint,
      acknowledgeDelivery: owner.acknowledge,
      close() {
        closed = true;
        publisher.close();
        installer.close();
      },
    });
  });
