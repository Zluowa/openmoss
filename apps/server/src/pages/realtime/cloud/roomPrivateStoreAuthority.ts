import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  type RoomBinding,
  copyRoomBinding,
  envelopeReference,
  roomIdentity,
} from "./roomEnvelopeProtocol";
import { copyRecoveryFloor, type RecoveryFloor } from "./roomRecoveryProtocol";
import type { OwnerPublicationTarget } from "./roomOwnerPublication";
import type { DeviceInstallTarget } from "./roomDeviceInstall";

type Target = OwnerPublicationTarget | DeviceInstallTarget;
type Role = "owner" | "device";
/** Issued only after independent verification. expiresAt is a local monotonic
 * deadline translated by that verifier, never a timestamp from a relay. */
interface VerifiedControl<T extends Target> {
  readonly target: T;
  readonly authorityVersion: number;
  readonly expiresAt: number;
  readonly active: boolean;
  readonly mayEnroll: boolean;
  readonly revoked: AbortSignal;
  assertCurrent(): void;
  release(): void;
}
export interface VerifiedOwnerControl extends VerifiedControl<OwnerPublicationTarget> {
  readonly confirmedDigest: string | null;
  readonly authorizeGenesis: boolean;
}
export interface VerifiedDeviceControl extends VerifiedControl<DeviceInstallTarget> {
  readonly approvedDigest: string;
  /** Independent per-device accepted installation, including exact durable version. */
  readonly accepted: { readonly version: number; readonly floor: RecoveryFloor } | null;
}
export interface RoomPrivateStoreAuthority {
  owner(room: RoomBinding): VerifiedOwnerControl | null;
  device(room: RoomBinding): VerifiedDeviceControl | null;
}
export class RoomPrivateStoreError extends Error {
  constructor(readonly code: "authority-required" | "conflict" | "storage-unavailable") {
    super(`Room private store: ${code}`);
  }
}
export const denied = () => new RoomPrivateStoreError("authority-required");
export const safeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
export const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
export function targetMatches(a: Target, b: Target): boolean {
  if (
    a.profileRef !== b.profileRef ||
    a.fence !== b.fence ||
    roomIdentity(a.room) !== roomIdentity(b.room)
  )
    return false;
  if ("deviceRef" in a) return "deviceRef" in b && a.deviceRef === b.deviceRef;
  return (
    "senderRef" in b &&
    a.senderRef === b.senderRef &&
    a.pageId === b.pageId &&
    a.scopeKey === b.scopeKey
  );
}
export function bound(sql: SqlClient.SqlClient, t: Target) {
  const room = t.room;
  const owner = sql`profile_ref=${t.profileRef} AND tenant_ref=${room.tenantRef} AND room_id=${room.roomId}
    AND document_generation=${room.documentGeneration} AND key_epoch=${room.keyEpoch}`;
  return "deviceRef" in t ? sql`${owner} AND device_ref=${t.deviceRef}` : owner;
}
export function bindingValues(sql: SqlClient.SqlClient, t: Target) {
  const room = t.room;
  const owner = sql`${t.profileRef},${room.tenantRef},${room.roomId},${room.documentGeneration},${room.keyEpoch}`;
  return "deviceRef" in t ? sql`${owner},${t.deviceRef}` : owner;
}

export interface PrivateStoreContext {
  readonly profileRef: string;
  readonly sql: SqlClient.SqlClient;
  readonly checkStorage: Effect.Effect<void, unknown>;
  isClosed(): boolean;
  readonly authority: RoomPrivateStoreAuthority;
}
type BothControls = VerifiedOwnerControl | VerifiedDeviceControl;
type ControlOperation<G, T, E> = (control: G, check: () => void) => Effect.Effect<T, E>;
export function withControl<T, E>(
  ctx: PrivateStoreContext,
  role: "owner",
  room: RoomBinding,
  op: (control: VerifiedOwnerControl, check: () => void) => Effect.Effect<T, E>,
): Promise<T>;
export function withControl<T, E>(
  ctx: PrivateStoreContext,
  role: "device",
  room: RoomBinding,
  op: (control: VerifiedDeviceControl, check: () => void) => Effect.Effect<T, E>,
): Promise<T>;
export async function withControl<T, E>(
  ctx: PrivateStoreContext,
  role: Role,
  room: RoomBinding,
  op: ControlOperation<VerifiedOwnerControl, T, E> | ControlOperation<VerifiedDeviceControl, T, E>,
): Promise<T> {
  let grant: VerifiedOwnerControl | VerifiedDeviceControl | null = null;
  let failureCode: RoomPrivateStoreError["code"] = "authority-required";
  try {
    if (ctx.isClosed()) throw denied();
    const requested = copyRoomBinding(room);
    grant = role === "owner" ? ctx.authority.owner(requested) : ctx.authority.device(requested);
    if (!grant) throw denied();
    const g = grant,
      target = g.target;
    if (
      ctx.profileRef !== target.profileRef ||
      !safeInteger(target.fence) ||
      roomIdentity(copyRoomBinding(target.room)) !== roomIdentity(requested) ||
      !safeInteger(g.authorityVersion) ||
      typeof g.mayEnroll !== "boolean" ||
      typeof g.active !== "boolean"
    )
      throw denied();
    const deadline = g.expiresAt;
    if (!Number.isFinite(deadline) || deadline - performance.now() > 30_000) throw denied();
    const check = () => {
      try {
        if (ctx.isClosed() || g.revoked.aborted || performance.now() >= deadline) throw denied();
        g.assertCurrent();
        if (ctx.isClosed() || g.revoked.aborted || performance.now() >= deadline) throw denied();
      } catch {
        throw denied();
      }
    };
    let snapshot: VerifiedOwnerControl | VerifiedDeviceControl;
    const base = {
      active: g.active,
      mayEnroll: g.mayEnroll,
      authorityVersion: g.authorityVersion,
      expiresAt: deadline,
      revoked: g.revoked,
      assertCurrent: check,
      release: () => {},
    };
    if (role === "owner") {
      const x = g as VerifiedOwnerControl,
        t = x.target;
      if (
        !(x.confirmedDigest === null || digest(x.confirmedDigest)) ||
        typeof x.authorizeGenesis !== "boolean" ||
        !/^(?:local-default|project-space:[A-Za-z0-9_-]{1,128})$/u.test(t.scopeKey)
      )
        throw denied();
      snapshot = {
        ...base,
        target: {
          room: requested,
          profileRef: ctx.profileRef,
          fence: t.fence,
          pageId: envelopeReference(t.pageId),
          senderRef: envelopeReference(t.senderRef),
          scopeKey: t.scopeKey,
        },
        confirmedDigest: x.confirmedDigest,
        authorizeGenesis: x.authorizeGenesis,
      };
    } else {
      const x = g as VerifiedDeviceControl,
        t = x.target,
        accepted = x.accepted;
      if (!digest(x.approvedDigest) || (accepted !== null && !safeInteger(accepted.version)))
        throw denied();
      const floor = accepted && copyRecoveryFloor(accepted.floor);
      if (accepted && (!floor || roomIdentity(floor.room) !== roomIdentity(requested)))
        throw denied();
      snapshot = {
        ...base,
        target: {
          room: requested,
          profileRef: ctx.profileRef,
          fence: t.fence,
          deviceRef: envelopeReference(t.deviceRef),
        },
        approvedDigest: x.approvedDigest,
        accepted: accepted && floor ? { version: accepted.version, floor } : null,
      };
    }
    check();
    // Failure during the final in-transaction check rolls back all preceding writes.
    const result = await Effect.runPromise(
      Effect.result(
        ctx.sql.withTransaction(
          Effect.gen(function* () {
            yield* ctx.checkStorage;
            yield* Effect.try({ try: check, catch: denied });
            const value = yield* (op as ControlOperation<BothControls, T, E>)(snapshot, check);
            yield* Effect.try({ try: check, catch: denied });
            return value;
          }),
        ),
      ),
    );
    if (result._tag === "Failure") {
      failureCode =
        result.failure instanceof RoomPrivateStoreError
          ? result.failure.code
          : "storage-unavailable";
      throw new RoomPrivateStoreError(failureCode);
    }
    check();
    return result.success;
  } catch {
    // Only the internal transaction result selects a code. Provider exceptions,
    // including arbitrary getters/subclass instances, are never inspected.
    throw new RoomPrivateStoreError(failureCode);
  } finally {
    try {
      grant?.release();
    } catch {
      /* The local operation has already ended. */
    }
  }
}
