import type { RoomKeyLease, RoomKeyProvider } from "./roomEnvelope";
import {
  copyBytes,
  copyRoomBinding,
  envelopeRecord,
  envelopeReference,
  roomByteLength,
  roomIdentity,
  type RoomBinding,
} from "./roomEnvelopeProtocol";
import {
  createRoomRecoveryAuthority,
  type RecoveryAnchorGrant,
  type RoomRecoveryVerifier,
  type VerifiedRecoveryCandidate,
} from "./roomRecoveryBundle";
import {
  RECOVERY_BUNDLE_BYTES,
  RoomRecoveryError,
  copyRecoveryAnchor,
  copyRecoveryBundle,
  copyRecoveryFloor,
  equalBytes,
  stateDigestInput,
  type RecoveryAnchor,
  type RecoveryBundle,
  type RecoveryErrorCode,
  type RecoveryFloor,
} from "./roomRecoveryProtocol";

/** Trusted composition inputs. Device identity comes from its grant. The owner
 * provider contributes a current anchor; the installed floor comes from local DB. */
export interface DeviceInstallTarget {
  readonly profileRef: string;
  readonly deviceRef: string;
  readonly room: RoomBinding;
  readonly fence: number;
}
export interface DeviceInstallGrant {
  readonly target: DeviceInstallTarget;
  readonly revoked: AbortSignal;
  assertCurrent(): void;
  release(): void;
}
export interface DeviceInstallProvider {
  capture(room: RoomBinding): DeviceInstallGrant | null;
}
export interface CurrentOwnerAnchorProvider {
  capture(room: RoomBinding): Omit<RecoveryAnchorGrant, "floor"> | null;
}
export type DeviceInstallSnapshot =
  | { readonly kind: "enrolled"; readonly version: 0; readonly approvedAnchorDigest: string }
  | {
      readonly kind: "installed";
      readonly version: number;
      readonly approvedAnchorDigest: string;
      readonly floor: RecoveryFloor;
      readonly stateDigest: string;
      readonly update: Uint8Array<ArrayBuffer>;
    };
export type DeviceInstallRead =
  | DeviceInstallSnapshot
  | { readonly kind: "revoked" | "owner-required" | "over-budget" };
export interface DeviceInstallCAS {
  readonly target: DeviceInstallTarget;
  readonly expected: DeviceInstallSnapshot;
  readonly floor: RecoveryFloor;
  readonly stateDigest: string;
  readonly update: Uint8Array<ArrayBuffer>;
  readonly reuse: boolean;
  readonly assertCurrent: () => void;
}
export type DeviceInstallWrite =
  | "installed"
  | "reused"
  | "conflict"
  | "revoked"
  | "anchor-changed"
  | "owner-required"
  | "local-changed";
/** One durable transaction must CAS the exact current device registration/fence,
 * trusted owner pin, prior install version/floor and state. Write update, floor
 * and advanced install marker together. Missing known state requires recovery. */
export interface DeviceInstallStore {
  read(target: DeviceInstallTarget): Promise<DeviceInstallRead>;
  commit(input: DeviceInstallCAS): Promise<DeviceInstallWrite>;
}
declare const ticketBrand: unique symbol;
export interface DeviceInstallTicket {
  readonly [ticketBrand]: true;
}
type DeviceInstallErrorCode =
  | RecoveryErrorCode
  | "device-required"
  | "conflict"
  | "anchor-changed"
  | "local-changed"
  | "storage-unavailable"
  | "commit-unknown";
export class RoomDeviceInstallError extends Error {
  constructor(readonly code: DeviceInstallErrorCode) {
    super(`Room device install: ${code}`);
  }
}
function fail(code: DeviceInstallErrorCode): never {
  throw new RoomDeviceInstallError(code);
}
const digest = /^[0-9a-f]{64}$/u;
function deviceTarget(value: unknown): DeviceInstallTarget {
  const v = envelopeRecord(value, ["profileRef", "deviceRef", "room", "fence"]);
  if (typeof v.fence !== "number" || !Number.isSafeInteger(v.fence) || v.fence < 1)
    fail("device-required");
  return Object.freeze({
    profileRef: envelopeReference(v.profileRef),
    deviceRef: envelopeReference(v.deviceRef),
    room: copyRoomBinding(v.room),
    fence: v.fence,
  });
}
export function sameInstalledFloor(a: RecoveryFloor, b: RecoveryFloor): boolean {
  return (
    roomIdentity(a.room) === roomIdentity(b.room) &&
    a.checkpointId === b.checkpointId &&
    a.checkpointVersion === b.checkpointVersion &&
    a.checkpointDigest === b.checkpointDigest &&
    a.commitIndex === b.commitIndex &&
    a.commitDigest === b.commitDigest &&
    a.bundleDigest === b.bundleDigest
  );
}
function installedFloor(a: RecoveryAnchor): RecoveryFloor {
  return Object.freeze({
    room: a.room,
    checkpointId: a.checkpointId,
    checkpointVersion: a.checkpointVersion,
    checkpointDigest: a.checkpointDigest,
    commitIndex: a.tailEndCommitIndex,
    commitDigest: a.tailHeadDigest,
    bundleDigest: a.bundleDigest,
  });
}
interface Attempt {
  readonly lease: RoomKeyLease;
  readonly target: DeviceInstallTarget;
  readonly grant: DeviceInstallGrant;
  readonly revoked: AbortSignal;
  readonly signal?: AbortSignal;
  readonly cleanup: Set<() => void>;
  expected?: DeviceInstallSnapshot;
  verifier?: RoomRecoveryVerifier;
  candidate?: VerifiedRecoveryCandidate;
  ticket?: DeviceInstallTicket;
  reason?: DeviceInstallErrorCode;
}

export function createRoomDeviceInstaller(
  keys: RoomKeyProvider,
  devices: DeviceInstallProvider,
  owners: CurrentOwnerAnchorProvider,
  store: DeviceInstallStore,
) {
  let closed = false,
    busy = false,
    active: Attempt | undefined;
  function finish(state: Attempt, reason: DeviceInstallErrorCode) {
    if (state.reason) return;
    state.reason = reason;
    if (active === state) active = undefined;
    delete state.ticket;
    state.verifier?.close();
    for (const unlink of state.cleanup) {
      try {
        unlink();
      } catch {
        /* No external diagnostics escape. */
      }
    }
    state.cleanup.clear();
    try {
      state.grant.release();
    } catch {
      /* Already invalid. */
    }
  }
  function follow(state: Attempt, signal: AbortSignal, reason: DeviceInstallErrorCode) {
    if (state.reason) fail(state.reason);
    const abort = () => finish(state, reason);
    state.cleanup.add(() => signal.removeEventListener("abort", abort));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  }
  function checkDevice(state: Attempt) {
    if (state.reason) fail(state.reason);
    if (closed || active !== state) fail("closed");
    if (state.signal?.aborted) fail("aborted");
    try {
      if (state.revoked.aborted) fail("revoked");
      recovery.assertCurrent(state.lease);
      state.grant.assertCurrent();
      recovery.assertCurrent(state.lease);
      if (state.revoked.aborted) fail("revoked");
    } catch {
      fail("revoked");
    }
    if (state.reason) fail(state.reason);
    if (closed || active !== state) fail("closed");
    if (state.signal?.aborted) fail("aborted");
  }
  // C1b verifies the trusted owner's current anchor against THIS device's exact
  // persisted floor. The relay bundle cannot contribute either authority input.
  const recovery = createRoomRecoveryAuthority(keys, {
    capture(room) {
      const state = active;
      if (!state?.expected || roomIdentity(room) !== roomIdentity(state.target.room)) return null;
      let owner: Omit<RecoveryAnchorGrant, "floor"> | null = null;
      try {
        checkDevice(state);
        owner = owners.capture(room);
        if (!owner) return null;
        const anchor = copyRecoveryAnchor(owner.anchor);
        if (anchor.bundleDigest !== state.expected.approvedAnchorDigest) {
          finish(state, "anchor-changed");
          fail("anchor-changed");
        }
        const signal = owner.revoked;
        follow(state, signal, "revoked");
        checkDevice(state);
        const captured = owner;
        return {
          anchor,
          floor: state.expected.kind === "installed" ? state.expected.floor : null,
          revoked: signal,
          assertCurrent() {
            checkDevice(state);
            captured.assertCurrent();
            checkDevice(state);
          },
          release() {
            captured.release();
          },
        };
      } catch {
        if (owner) {
          try {
            owner.release();
          } catch {
            /* Fixed failure boundary. */
          }
        }
        return null;
      }
    },
  });
  function checkAll(state: Attempt) {
    checkDevice(state);
    try {
      state.verifier?.assertCurrent();
    } catch {
      fail("revoked");
    }
    checkDevice(state);
  }
  function knownTicket(ticket: DeviceInstallTicket) {
    const state = active;
    if (!state || !state.ticket || state.ticket !== ticket) fail("invalid-capability");
    return state;
  }
  function begin(lease: RoomKeyLease, signal?: AbortSignal): Attempt {
    if (closed) fail("closed");
    if (signal?.aborted) fail("aborted");
    try {
      recovery.assertCurrent(lease);
    } catch {
      fail("invalid-capability");
    }
    let grant: DeviceInstallGrant | null = null;
    let state: Attempt | undefined;
    try {
      grant = devices.capture(lease.binding);
      if (!grant) fail("device-required");
      const target = deviceTarget(grant.target);
      if (roomIdentity(target.room) !== roomIdentity(lease.binding)) fail("device-required");
      state = {
        lease,
        target,
        grant,
        revoked: grant.revoked,
        cleanup: new Set(),
        ...(signal ? { signal } : {}),
      };
      active = state;
      follow(state, state.revoked, "revoked");
      if (signal) follow(state, signal, "aborted");
    } catch {
      if (state) finish(state, state.reason ?? "device-required");
      else if (grant) {
        try {
          grant.release();
        } catch {
          /* Fixed failure boundary. */
        }
      }
      fail(state?.reason ?? "device-required");
    }
    return state;
  }
  async function readLocal(state: Attempt): Promise<DeviceInstallSnapshot> {
    let expected: DeviceInstallSnapshot;
    let raw: DeviceInstallRead;
    try {
      raw = await store.read(state.target);
    } catch {
      checkDevice(state);
      fail("storage-unavailable");
    }
    checkDevice(state);
    // Read only strict own data fields; never trust an exception object from
    // an injected store/getter as evidence of authority, floor or error code.
    let fields: Record<string, unknown>;
    try {
      const kind = Object.getOwnPropertyDescriptor(raw, "kind")?.value;
      const keys =
        kind === "enrolled"
          ? ["kind", "version", "approvedAnchorDigest"]
          : kind === "installed"
            ? ["kind", "version", "approvedAnchorDigest", "floor", "stateDigest", "update"]
            : ["kind"];
      fields = envelopeRecord(raw, keys);
    } catch {
      fail("storage-unavailable");
    }
    if (
      fields.kind === "revoked" ||
      fields.kind === "owner-required" ||
      fields.kind === "over-budget"
    )
      fail(fields.kind);
    if (
      typeof fields.approvedAnchorDigest !== "string" ||
      !digest.test(fields.approvedAnchorDigest)
    )
      fail("owner-required");
    if (fields.kind === "enrolled") {
      if (fields.version !== 0) fail("owner-required");
      expected = Object.freeze({
        kind: "enrolled",
        version: 0,
        approvedAnchorDigest: fields.approvedAnchorDigest,
      });
    } else {
      if (
        fields.kind !== "installed" ||
        typeof fields.version !== "number" ||
        !Number.isSafeInteger(fields.version) ||
        fields.version < 1 ||
        typeof fields.stateDigest !== "string" ||
        !digest.test(fields.stateDigest)
      )
        fail("owner-required");
      let floor: RecoveryFloor | null, size: number;
      try {
        floor = copyRecoveryFloor(fields.floor);
        size = roomByteLength(fields.update);
      } catch {
        fail("owner-required");
      }
      if (!floor || roomIdentity(floor.room) !== roomIdentity(state.target.room))
        fail("owner-required");
      if (size > RECOVERY_BUNDLE_BYTES) fail("over-budget");
      let update: Uint8Array<ArrayBuffer>;
      try {
        update = copyBytes(fields.update, RECOVERY_BUNDLE_BYTES, 1);
      } catch {
        fail("owner-required");
      }
      expected = Object.freeze({
        kind: "installed",
        version: fields.version,
        approvedAnchorDigest: fields.approvedAnchorDigest,
        floor,
        stateDigest: fields.stateDigest,
        update,
      });
    }
    checkDevice(state);
    if (expected.kind === "installed") {
      let hash: ArrayBuffer;
      try {
        hash = await globalThis.crypto.subtle.digest("SHA-256", stateDigestInput(expected.update));
      } catch {
        checkDevice(state);
        fail("hash-failed");
      }
      checkDevice(state);
      const actual = Array.from(new Uint8Array(hash), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      if (actual !== expected.stateDigest) fail("local-changed");
    }
    return expected;
  }
  return Object.freeze({
    acquireRoom: recovery.acquireRoom,
    async prepare(
      lease: RoomKeyLease,
      input: RecoveryBundle | null,
      signal?: AbortSignal,
    ): Promise<DeviceInstallTicket> {
      if (busy) fail("busy");
      busy = true;
      let state: Attempt | undefined;
      try {
        const previous = active;
        if (previous) {
          // A key generation can be revoked without a device/owner signal.
          // Retire its old ticket before a newly authorized lease starts.
          let usable = true;
          try {
            checkAll(previous);
          } catch {
            usable = false;
          }
          if (usable) fail("busy");
          finish(previous, "revoked");
        }
        state = begin(lease, signal);
        checkDevice(state);
        let bundle: RecoveryBundle | null;
        try {
          bundle = input === null ? null : copyRecoveryBundle(input);
        } catch (error) {
          fail(
            error instanceof RoomRecoveryError && error.code === "over-budget"
              ? "over-budget"
              : "invalid-bundle",
          );
        }
        state.expected = await readLocal(state);
        checkDevice(state);
        const verifier = recovery.openVerifier(recovery.admit(lease));
        if (state.reason) {
          verifier.close();
          fail(state.reason);
        }
        state.verifier = verifier;
        state.candidate = await verifier.prepare(bundle, signal);
        checkAll(state);
        const ticket = Object.freeze({}) as DeviceInstallTicket;
        state.ticket = ticket;
        return ticket;
      } catch (error) {
        const reason =
          state?.reason ??
          (error instanceof RoomDeviceInstallError || error instanceof RoomRecoveryError
            ? error.code
            : "storage-unavailable");
        if (state) finish(state, reason);
        fail(reason);
      } finally {
        busy = false;
      }
    },
    async install(ticket: DeviceInstallTicket) {
      if (busy) fail("busy");
      const state = knownTicket(ticket);
      delete state.ticket;
      busy = true;
      let update: Uint8Array<ArrayBuffer> | undefined;
      try {
        checkAll(state);
        const expected = state.expected!,
          verified = state.verifier!.take(state.candidate!);
        update = verified.update;
        const floor = installedFloor(verified.anchor);
        if (floor.bundleDigest !== expected.approvedAnchorDigest) fail("anchor-changed");
        const reuse = expected.kind === "installed" && sameInstalledFloor(expected.floor, floor);
        if (
          reuse &&
          expected.kind === "installed" &&
          (expected.stateDigest !== verified.anchor.finalStateDigest ||
            !equalBytes(expected.update, update))
        )
          fail("local-changed");
        checkAll(state);
        let result: DeviceInstallWrite;
        try {
          result = await store.commit({
            target: state.target,
            expected,
            floor,
            stateDigest: verified.anchor.finalStateDigest,
            update,
            reuse,
            assertCurrent: () => checkAll(state),
          });
        } catch {
          checkAll(state);
          fail("commit-unknown");
        }
        checkAll(state);
        if ((result === "installed" && !reuse) || (result === "reused" && reuse))
          return Object.freeze({ kind: result, floor });
        switch (result) {
          case "conflict":
          case "revoked":
          case "anchor-changed":
          case "owner-required":
          case "local-changed":
            fail(result);
          default:
            fail("commit-unknown");
        }
      } catch (error) {
        fail(
          state.reason ??
            (error instanceof RoomDeviceInstallError || error instanceof RoomRecoveryError
              ? error.code
              : "commit-unknown"),
        );
      } finally {
        update?.fill(0);
        finish(state, "closed");
        busy = false;
      }
    },
    discard(ticket: DeviceInstallTicket) {
      finish(knownTicket(ticket), "closed");
    },
    close() {
      closed = true;
      if (active) finish(active, "closed");
      recovery.close();
    },
  });
}
