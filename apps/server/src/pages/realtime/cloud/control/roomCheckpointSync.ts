import type { Effect } from "effect";
import type { RoomKeyLease } from "../roomEnvelope";
import type { makeRoomPrivateStorage } from "../roomPrivateStorage";
import type { openRoomControlClient } from "./roomControlClient";
import { reject } from "./roomControlProtocol";
import type { RecoveryAnchor } from "../roomRecoveryProtocol";

type Local = NonNullable<Effect.Success<ReturnType<typeof makeRoomPrivateStorage>>>;
type Control = NonNullable<ReturnType<typeof openRoomControlClient>>;
type AccountArchiveObserver = (anchor: RecoveryAnchor) => Promise<"confirmed" | "inactive">;
const observers = new WeakMap<Local, Map<string, AccountArchiveObserver>>();
export function observeConfirmedRoom(local: Local, id: string, observer: AccountArchiveObserver) {
  const rooms = observers.get(local) ?? new Map<string, AccountArchiveObserver>();
  if (rooms.has(id) || rooms.size >= 64) return reject();
  rooms.set(id, observer);
  observers.set(local, rooms);
  return () => {
    if (rooms.get(id) === observer) rooms.delete(id);
    if (!rooms.size) observers.delete(local);
  };
}
async function completed(local: Local, kind: "reused" | "confirmed", anchor: RecoveryAnchor) {
  const callback = observers.get(local)?.get(anchor.room.roomId);
  if (!callback) return { kind, anchor };
  const accountBackup = await callback(anchor).catch(() => "failed" as const);
  return { kind, anchor, accountBackup };
}

/** The caller explicitly enrolls each local slot first. Routine retries only
 * refresh existing slots. The relay receives bytes sealed by the owner publisher. */
export async function publishRoomCheckpoint(local: Local, control: Control, lease: RoomKeyLease) {
  const room = lease.binding,
    current = await control.request({ kind: "read" });
  if (!current.owner) return reject();
  await local.refreshOwnerControl(room);
  let pending = await local.pendingOwnerCheckpoint(room);
  if (!pending) {
    const published = await local.publisher.publish(lease);
    pending = await local.pendingOwnerCheckpoint(room);
    if (!pending) {
      if (current.head?.bundleDigest !== published.anchor.bundleDigest) return reject();
      return completed(local, "reused", published.anchor);
    }
  }
  const view = await control.publishCheckpoint(
    {
      kind: "publish",
      expected: pending.expected,
      previousCommit: pending.previousCommit,
      anchor: pending.anchor,
    },
    pending.bundle,
  );
  if (view.head?.bundleDigest !== pending.digest) return reject();
  // The external CAS has committed. A dropped reply retries this same immutable
  // record; a local ACK never manufactures an independent confirmed pin.
  await local.refreshOwnerControl(room);
  if (!(await local.acknowledgeDelivery(room, pending.fence, pending.digest))) return reject();
  return completed(local, "confirmed", pending.anchor);
}
export async function installRoomCheckpoint(local: Local, control: Control, lease: RoomKeyLease) {
  const room = lease.binding,
    initial = await control.request({ kind: "read" });
  const anchor = initial.pending ?? initial.head;
  if (!anchor) return reject();
  const fetched = await control.fetchCheckpoint(anchor.bundleDigest);
  if ((fetched.view.pending ?? fetched.view.head)?.bundleDigest !== anchor.bundleDigest)
    return reject();
  await local.refreshDeviceControl(room);
  const ticket = await local.installer.prepare(lease, fetched.bundle);
  const installed = await local.installer.install(ticket);
  const accepted = await control.request({
    kind: "accept",
    expected: fetched.view.accepted?.version ?? 0,
    digest: installed.floor.bundleDigest,
  });
  if (accepted.accepted?.floor.bundleDigest !== installed.floor.bundleDigest) return reject();
  await local.refreshDeviceControl(room);
  return installed;
}
