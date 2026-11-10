import { Effect } from "effect";
import {
  sameInstalledFloor,
  type DeviceInstallStore,
  type DeviceInstallTarget,
  type DeviceInstallRead,
} from "./roomDeviceInstall";
import { copyRecoveryFloor, equalBytes, RECOVERY_BUNDLE_BYTES } from "./roomRecoveryProtocol";
import { roomIdentity } from "./roomEnvelopeProtocol";
import {
  RoomPrivateStoreError,
  bindingValues,
  bound,
  denied,
  targetMatches,
  withControl,
  type PrivateStoreContext,
  type VerifiedDeviceControl,
} from "./roomPrivateStoreAuthority";

interface Slot {
  fence: number;
  authority_version: number;
  active: number;
  approved_anchor_digest: string;
  install_version: number;
  installed_once: number;
}
export function makePrivateDeviceStore(ctx: PrivateStoreContext) {
  const { sql } = ctx;
  const lookup = (
    t: DeviceInstallTarget,
  ) => sql<Slot>`SELECT fence,authority_version,active,approved_anchor_digest,install_version,installed_once
    FROM main.pages_room_device_slots WHERE ${bound(sql, t)}`;
  const local = (t: DeviceInstallTarget, s: Slot) =>
    Effect.gen(function* () {
      const [r] = yield* sql<{
        install_version: number;
        state_digest: string;
        bundle_digest: string;
        size: number;
        floor: string | null;
        state: Uint8Array | null;
      }>`
      SELECT install_version,state_digest,bundle_digest,length(state) AS size,
      CASE WHEN typeof(floor_json)='text' AND length(CAST(floor_json AS BLOB))<=4096 THEN floor_json END AS floor,
      CASE WHEN typeof(state)='blob' AND length(state) BETWEEN 1 AND ${RECOVERY_BUNDLE_BYTES} THEN state END AS state
      FROM main.pages_room_device_installs WHERE ${bound(sql, t)}`;
      if (s.installed_once === 0 && s.install_version === 0 && !r)
        return {
          kind: "enrolled",
          version: 0,
          approvedAnchorDigest: s.approved_anchor_digest,
        } as const;
      if (
        !r ||
        !s.installed_once ||
        r.install_version !== s.install_version ||
        r.install_version < 1
      )
        return { kind: "owner-required" } as const;
      if (r.size > RECOVERY_BUNDLE_BYTES) return { kind: "over-budget" } as const;
      try {
        const floor = r.floor && copyRecoveryFloor(JSON.parse(r.floor));
        if (
          !floor ||
          !r.state ||
          floor.bundleDigest !== r.bundle_digest ||
          roomIdentity(floor.room) !== roomIdentity(t.room)
        )
          return { kind: "owner-required" } as const;
        return {
          kind: "installed",
          version: r.install_version,
          approvedAnchorDigest: s.approved_anchor_digest,
          floor,
          stateDigest: r.state_digest,
          update: new Uint8Array(r.state),
        } as const;
      } catch {
        return { kind: "owner-required" } as const;
      }
    });
  const backed = (c: VerifiedDeviceControl, state: DeviceInstallRead): boolean => {
    if (state.kind === "enrolled") return c.accepted === null;
    if (state.kind !== "installed") return false;
    if (state.version === c.accepted?.version)
      return sameInstalledFloor(state.floor, c.accepted.floor);
    // A locally committed install can precede its external ACK by one. Only
    // the independent current approved digest can identify that pending state.
    return (
      state.version === (c.accepted?.version ?? 0) + 1 &&
      state.floor.bundleDigest === c.approvedDigest
    );
  };
  const snapshot = (c: VerifiedDeviceControl, t: DeviceInstallTarget) =>
    Effect.gen(function* () {
      const [s] = yield* lookup(t);
      if (
        !targetMatches(c.target, t) ||
        !s?.active ||
        !c.active ||
        s.fence !== t.fence ||
        s.authority_version !== c.authorityVersion ||
        s.approved_anchor_digest !== c.approvedDigest
      )
        return { kind: "revoked" } as const;
      const state = yield* local(t, s);
      if (state.kind === "over-budget") return state;
      return backed(c, state) ? state : ({ kind: "owner-required" } as const);
    });
  const store: DeviceInstallStore = {
    read(t) {
      return withControl(ctx, "device", t.room, (c) => snapshot(c, t)).catch(() => ({
        kind: "owner-required",
      }));
    },
    commit(input) {
      const t = input.target;
      return withControl(ctx, "device", t.room, (c) =>
        Effect.gen(function* () {
          yield* sql`UPDATE main.pages_room_device_slots SET fence=fence WHERE ${bound(sql, t)}`;
          const current = yield* snapshot(c, t);
          if (current.kind === "owner-required" || current.kind === "revoked") return current.kind;
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
          yield* Effect.try({ try: input.assertCurrent, catch: denied });
          if (input.reuse)
            return current.kind === "installed" &&
              sameInstalledFloor(input.floor, current.floor) &&
              current.stateDigest === input.stateDigest &&
              equalBytes(current.update, input.update)
              ? ("reused" as const)
              : ("conflict" as const);
          const next = current.version + 1;
          if (!Number.isSafeInteger(next)) return "conflict" as const;
          yield* sql`INSERT INTO main.pages_room_device_installs VALUES(${bindingValues(sql, t)},${next},${input.floor.bundleDigest},
          ${input.stateDigest},${JSON.stringify(input.floor)},${input.update})
          ON CONFLICT DO UPDATE SET install_version=excluded.install_version,bundle_digest=excluded.bundle_digest,
          state_digest=excluded.state_digest,floor_json=excluded.floor_json,state=excluded.state`;
          const rows =
            yield* sql`UPDATE main.pages_room_device_slots SET installed_once=1,install_version=${next}
          WHERE ${bound(sql, t)} AND active=1 AND fence=${t.fence} AND install_version=${current.version} AND approved_anchor_digest=${input.floor.bundleDigest}
          RETURNING install_version`;
          if (rows.length !== 1) return yield* Effect.fail(new RoomPrivateStoreError("conflict"));
          yield* Effect.try({ try: input.assertCurrent, catch: denied });
          return "installed" as const;
        }),
      );
    },
  };
  return {
    store,
    applyControl(room: DeviceInstallTarget["room"], expectedVersion: number | null | "existing") {
      return withControl(ctx, "device", room, (c) =>
        Effect.gen(function* () {
          const t = c.target;
          yield* sql`UPDATE main.pages_room_device_slots SET fence=fence WHERE ${bound(sql, t)}`;
          const [s] = yield* lookup(t);
          if (!s) {
            if (expectedVersion !== null || !c.active || !c.mayEnroll || c.accepted !== null)
              return yield* Effect.fail(denied());
            yield* sql`INSERT INTO main.pages_room_device_slots VALUES(${bindingValues(sql, t)},${t.fence},${c.authorityVersion},1,${c.approvedDigest},0,0)`;
            return c.authorityVersion;
          }
          if (
            (expectedVersion !== "existing" && s.authority_version !== expectedVersion) ||
            c.authorityVersion < s.authority_version ||
            t.fence < s.fence
          )
            return yield* Effect.fail(new RoomPrivateStoreError("conflict"));
          // Revocation can always fence an otherwise damaged known installation.
          if (c.active && !backed(c, yield* local(t, s))) return yield* Effect.fail(denied());
          if (c.authorityVersion === s.authority_version) {
            if (
              t.fence !== s.fence ||
              !!s.active !== c.active ||
              s.approved_anchor_digest !== c.approvedDigest
            )
              return yield* Effect.fail(denied());
            return c.authorityVersion;
          }
          if (!!s.active !== c.active && t.fence <= s.fence) return yield* Effect.fail(denied());
          yield* sql`UPDATE main.pages_room_device_slots SET fence=${t.fence},active=${Number(c.active)},authority_version=${c.authorityVersion},
          approved_anchor_digest=${c.approvedDigest} WHERE ${bound(sql, t)}`;
          return c.authorityVersion;
        }),
      );
    },
  };
}
