import { ServiceMap } from "effect";
import type { PageSpaceSyncInput } from "@moss/contracts";
import { createRoomEnvelopeAuthority, type RoomKeyProvider } from "./roomEnvelope";
import { roomIdentity, type RoomBinding } from "./roomEnvelopeProtocol";
import type { RoomPrivateStoreAuthority, VerifiedOwnerControl } from "./roomPrivateStoreAuthority";
import { keyRef } from "./control/roomControlProtocol";
import type { LivePairGrant } from "./live/roomLiveAdmission";
import { openRoomLiveEndpoint, type LiveSocket } from "./live/roomLiveEndpoint";
import type { LiveRoomAdapter } from "./live/roomLiveYjs";
import { syncDigest } from "./spaceSyncPreference";
import type { RecoveryPublisherProvision } from "./control/accountRecoveryPublication";

export type SpaceTarget = Pick<PageSpaceSyncInput, "scopeSpaceId" | "spaceId">;
/** Injected only by an explicitly provisioned server composition. Reading entries
 * or owner() is local. Pair renewal and opening the relay socket may perform IO. */
export interface ProvisionedSpaceRoom extends SpaceTarget {
  /** Captured when the currently enrolled local account verified this registration. */
  readonly accountRevision: number;
  readonly pageId: string;
  readonly room: RoomBinding;
  readonly authority: RoomPrivateStoreAuthority;
  readonly keys: RoomKeyProvider;
  readonly pair: (signal: AbortSignal) => Promise<LivePairGrant>;
  readonly connect: (signal: AbortSignal) => Promise<LiveSocket>;
  readonly adapter: () => LiveRoomAdapter;
}
export interface SpaceSyncProvisionShape {
  readonly rooms: () => readonly ProvisionedSpaceRoom[];
  /** Emits when independent local provisioning changes. Never enrolls anyone. */
  readonly listen: (notify: () => void) => () => void;
  /** Optional owner-side inputs for confirmed account backups. */
  readonly accountRecovery?: () => RecoveryPublisherProvision | null;
}
export class SpaceSyncProvision extends ServiceMap.Service<
  SpaceSyncProvision,
  SpaceSyncProvisionShape
>()("moss/pages/SpaceSyncProvision") {}

export interface SpacePlan {
  rooms: readonly ProvisionedSpaceRoom[];
  owners: VerifiedOwnerControl[];
  binding: string;
  check: () => void;
  release: () => void;
  refreshOwner: (index: number) => void;
}
const unavailable = () => new Error("Space synchronization unavailable");
export function inspectSpacePlan(
  target: SpaceTarget,
  rooms: readonly ProvisionedSpaceRoom[],
  tenant: string,
  profile: string,
  pageIds: ReadonlySet<string>,
  revision: number,
  current: () => boolean,
): SpacePlan {
  if (rooms.length > 64) throw unavailable();
  const selected = rooms.filter(
    (r) => r.scopeSpaceId === target.scopeSpaceId && r.spaceId === target.spaceId,
  );
  if (
    !selected.length ||
    selected.length > 8 ||
    new Set(selected.map((r) => r.room.roomId)).size !== selected.length ||
    new Set(selected.map((r) => r.pageId)).size !== selected.length
  )
    throw unavailable();
  const owners: VerifiedOwnerControl[] = [];
  const release = () => {
    for (const grant of owners.splice(0)) grant.release();
  };
  const check = () => {
    if (!current()) throw unavailable();
    for (const owner of owners) {
      if (
        owner.revoked.aborted ||
        !Number.isFinite(owner.expiresAt) ||
        performance.now() >= owner.expiresAt ||
        owner.expiresAt - performance.now() > 30_000
      )
        throw unavailable();
      owner.assertCurrent();
    }
  };
  try {
    const identities = selected
      .map((entry) => {
        if (
          !entry.keys ||
          entry.accountRevision !== revision ||
          !pageIds.has(entry.pageId) ||
          entry.room.tenantRef !== tenant
        )
          throw unavailable();
        const owner = entry.authority.owner(entry.room);
        if (!owner) throw unavailable();
        owners.push(owner);
        const t = owner.target;
        if (
          !owner.active ||
          !Number.isSafeInteger(t.fence) ||
          t.fence < 1 ||
          t.profileRef !== profile ||
          t.pageId !== entry.pageId ||
          t.scopeKey !==
            (target.scopeSpaceId === null
              ? "local-default"
              : "project-space:" + target.scopeSpaceId) ||
          roomIdentity(t.room) !== roomIdentity(entry.room) ||
          !/^[a-f0-9]{64}$/.test(t.senderRef)
        )
          throw unavailable();
        return JSON.stringify([t.pageId, t.senderRef, t.fence, roomIdentity(t.room)]);
      })
      .sort();
    check();
    const binding = syncDigest([
      "moss-space-sync-consent",
      1,
      target.scopeSpaceId,
      target.spaceId,
      tenant,
      profile,
      identities,
    ]);
    const refreshOwner = (index: number) => {
      const entry = selected[index]!,
        before = owners[index]!,
        next = entry.authority.owner(entry.room);
      if (!next) throw unavailable();
      try {
        const a = before.target,
          b = next.target;
        if (
          !next.active ||
          next.authorityVersion !== before.authorityVersion ||
          b.profileRef !== a.profileRef ||
          b.pageId !== a.pageId ||
          b.scopeKey !== a.scopeKey ||
          b.senderRef !== a.senderRef ||
          b.fence !== a.fence ||
          roomIdentity(b.room) !== roomIdentity(a.room) ||
          !current()
        )
          throw unavailable();
        next.assertCurrent();
      } catch (cause) {
        next.release();
        throw cause;
      }
      owners[index] = next;
      before.release();
    };
    return { rooms: selected, owners, binding, check, release, refreshOwner };
  } catch (error) {
    release();
    throw error;
  }
}

/** Verify every enrolled page and actual nonextractable HKDF key before any
 * pair refresh or socket. If any page fails, close the complete attempted group. */
export async function startSpacePlan(
  plan: SpacePlan,
  lifetime: AbortController,
  track: <T>(operation: Promise<T>) => Promise<T>,
) {
  const cleanup: Array<() => void> = [];
  const bridges: Array<NonNullable<Awaited<ReturnType<typeof openRoomLiveEndpoint>>>> = [];
  const stop = () => lifetime.abort();
  const dispose = () => {
    for (const fn of cleanup.splice(0).reverse()) {
      try {
        fn();
      } catch {}
    }
  };
  lifetime.signal.addEventListener("abort", dispose, { once: true });
  const check = () => {
    if (lifetime.signal.aborted) throw unavailable();
    plan.check();
  };
  const follow = (signal: AbortSignal) => {
    if (signal.aborted) throw unavailable();
    signal.addEventListener("abort", stop, { once: true });
    cleanup.push(() => signal.removeEventListener("abort", stop));
  };
  function wait<T>(operation: Promise<T>, late: (value: T) => void) {
    const pending = track(operation);
    return new Promise<T>((resolve, reject) => {
      const cancel = () => reject(unavailable());
      lifetime.signal.addEventListener("abort", cancel, { once: true });
      if (lifetime.signal.aborted) cancel();
      pending
        .then((value) => {
          if (lifetime.signal.aborted) late(value);
          else resolve(value);
        }, reject)
        .finally(() => lifetime.signal.removeEventListener("abort", cancel));
    });
  }
  try {
    cleanup.push(plan.release);
    check();
    const providers = plan.rooms.map((room) => ({
      request: (...args: Parameters<RoomKeyProvider["request"]>) => {
        const grant = room.keys.request(...args);
        return { ...grant, key: track(grant.key) };
      },
    }));
    for (const [index, room] of plan.rooms.entries()) {
      const keys = createRoomEnvelopeAuthority(providers[index]!);
      cleanup.push(() => keys.close());
      const lease = await keys.acquireRoom(room.room, lifetime.signal);
      check();
      keys.assertCurrent(lease);
      follow(keys.revocationSignal(lease));
    }
    const pairs: LivePairGrant[] = [];
    for (const [index, room] of plan.rooms.entries()) {
      check();
      const raw = await wait(room.pair(lifetime.signal), (pair) => pair.release());
      let released = false;
      const pair = {
        ...raw,
        release: () => {
          if (!released) {
            released = true;
            raw.release();
          }
        },
      };
      cleanup.push(pair.release);
      if (lifetime.signal.aborted) throw unavailable();
      // The verified livePair receipt replaces the control client's previous
      // snapshot. Reacquire that same owner/fence before opening any socket.
      plan.refreshOwner(index);
      check();
      pair.assertCurrent();
      if (
        pair.localRole !== "host" ||
        keyRef(pair.localSigningKey) !== plan.owners[index]!.target.senderRef ||
        roomIdentity(pair.room) !== roomIdentity(room.room)
      )
        throw unavailable();
      follow(pair.revoked);
      pairs.push(pair);
    }
    const deadline = Math.min(...plan.owners.map((owner) => owner.expiresAt)) - performance.now();
    const expiry = setTimeout(stop, Math.max(1, deadline));
    cleanup.push(() => clearTimeout(expiry));
    for (const owner of plan.owners) follow(owner.revoked);
    for (const [index, room] of plan.rooms.entries()) {
      const pair = pairs[index]!;
      check();
      pair.assertCurrent();
      const socket = await wait(room.connect(lifetime.signal), (socket) => socket.close(1000));
      if (lifetime.signal.aborted) {
        socket.close(1000);
        throw unavailable();
      }
      cleanup.push(() => socket.close(1000));
      check();
      const adapter = room.adapter();
      const bridge = await wait(
        openRoomLiveEndpoint({
          room: room.room,
          keys: providers[index]!,
          capture: () => pair,
          socket,
          adapter,
        }),
        (bridge) => bridge?.close(),
      );
      if (!bridge) throw unavailable();
      if (lifetime.signal.aborted) {
        bridge.close();
        throw unavailable();
      }
      cleanup.push(bridge.close, socket.onClose(stop));
      bridges.push(bridge);
      check();
    }
    return { connected: () => !lifetime.signal.aborted && bridges.every((b) => b.ready) };
  } catch (error) {
    stop();
    dispose();
    throw error;
  }
}
