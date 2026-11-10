import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import * as Y from "yjs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { applyPlateValue, readPageDoc, seedPageDoc } from "../pageYjsContent";
import { appendRoomUpdate, commitRoomCheckpoint } from "../pageRoomPublication";
import type { RoomKeyProvider } from "./roomEnvelope";
import { roomIdentity } from "./roomEnvelopeProtocol";
import type { RecoveryAnchor } from "./roomRecoveryProtocol";
import { createRoomOwnerPublisher } from "./roomOwnerPublication";
import {
  createRoomDeviceInstaller,
  RoomDeviceInstallError,
  type CurrentOwnerAnchorProvider,
  type DeviceInstallProvider,
  type DeviceInstallStore,
  type DeviceInstallTicket,
} from "./roomDeviceInstall";
import {
  makePublicationFixtureStore,
  openPublicationFixture,
  seedPublicationFixture,
  type PublicationFixture,
} from "./testing/ownerPublicationSqliteFixture";
import {
  deviceFixtureSlot,
  makeDeviceInstallFixtureStore,
  seedDeviceInstallFixture,
} from "./testing/deviceInstallSqliteFixture";

const room = {
  tenantRef: "fixture-tenant",
  roomId: "fixture-room",
  documentGeneration: "fixture-generation",
  keyEpoch: 1,
};
const target = {
  profileRef: "fixture-device-profile",
  deviceRef: "fixture-device-a",
  room,
  fence: 1,
};
const slot = deviceFixtureSlot(target),
  para = (text: string) => [{ type: "p", children: [{ text }] }];
type Issued = Awaited<ReturnType<ReturnType<typeof createRoomOwnerPublisher>["publish"]>>;
let root: string, template: string, a: Issued, b: Issued;
const cleanups: Array<() => void | Promise<void>> = [];
function keys() {
  const key = crypto.subtle.importKey("raw", new Uint8Array(32).fill(7), "HKDF", false, [
    "deriveKey",
  ]);
  let revoked = new AbortController();
  const request: RoomKeyProvider["request"] = () => {
    const captured = revoked;
    return {
      key,
      revoked: captured.signal,
      assertCurrent() {
        if (captured.signal.aborted) throw new Error("private key");
      },
      release() {},
    };
  };
  return {
    request,
    get revoked() {
      return revoked;
    },
    rotate() {
      revoked.abort();
      revoked = new AbortController();
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "moss-c1c-device-fixture-"));
  const ownerFile = join(root, "separate-fixture-owner.sqlite");
  await seedPublicationFixture(ownerFile);
  const db = await openPublicationFixture(ownerFile),
    source = new Y.Doc();
  const owner = {
    room,
    pageId: "fixture-page",
    scopeKey: "local-default",
    profileRef: "fixture-owner-profile",
    senderRef: "fixture-owner",
    fence: 1,
  };
  const api = createRoomOwnerPublisher(
    keys(),
    {
      capture: () => ({
        target: owner,
        revoked: new AbortController().signal,
        assertCurrent() {},
        release() {},
      }),
    },
    makePublicationFixtureStore(db).store,
  );
  try {
    seedPageDoc(source, para("A"));
    source.getText("history").insert(0, "ABC");
    source.getMap("binary").set("bytes", Uint8Array.of(0, 17, 255));
    const rich = JSON.stringify(readPageDoc(source));
    await db.run(
      db.sql.withTransaction(
        Effect.gen(function* () {
          yield* db.sql`INSERT INTO pages_documents(page_id,scope_key,root_page_id,title,revision,created_at,updated_at) VALUES(${owner.pageId},${owner.scopeKey},${owner.pageId},'fixture',1,'fixture','fixture')`;
          yield* db.sql`INSERT INTO pages_versions(page_id,revision,page_json,content,rich_content,operation,author,created_at) VALUES(${owner.pageId},1,'{}','A',${rich},'create','local-user','fixture')`;
          yield* commitRoomCheckpoint(db.sql, owner.pageId, {
            generation: room.documentGeneration,
            revision: 1,
            throughSequence: 0,
            key: rich,
            state: Y.encodeStateAsUpdate(source),
          });
          yield* db.sql`INSERT INTO fixture_c1c_grant VALUES(${roomIdentity(room)},${owner.profileRef},${owner.scopeKey},${owner.pageId},${owner.senderRef},1,1,1)`;
        }),
      ),
    );
    const lease = await api.acquireRoom(room);
    a = await api.publish(lease);
    const vector = Y.encodeStateVector(source);
    source.getText("history").delete(1, 1);
    applyPlateValue(source, para("B"), "fixture");
    source.getMap("binary").set("bytes", Uint8Array.of(255, 0, 52));
    const seq = await db.run(
      appendRoomUpdate(
        db.sql,
        owner.pageId,
        room.documentGeneration,
        Y.encodeStateAsUpdate(source, vector),
        [{ kind: "local-user" }],
      ),
    );
    const next = JSON.stringify(readPageDoc(source));
    await db.run(
      db.sql.withTransaction(
        Effect.gen(function* () {
          yield* db.sql`UPDATE pages_documents SET revision=2 WHERE page_id=${owner.pageId}`;
          yield* db.sql`INSERT INTO pages_versions(page_id,revision,page_json,content,rich_content,operation,author,created_at) VALUES(${owner.pageId},2,'{}','B',${next},'update','local-user','fixture')`;
          yield* commitRoomCheckpoint(db.sql, owner.pageId, {
            generation: room.documentGeneration,
            revision: 2,
            throughSequence: seq,
            key: next,
            state: Y.encodeStateAsUpdate(source),
          });
        }),
      ),
    );
    b = await api.publish(lease);
  } finally {
    api.close();
    source.destroy();
    await db.close();
  }
  template = join(root, "separate-fixture-device-template.sqlite");
  await seedDeviceInstallFixture(template);
  const device = await openPublicationFixture(template);
  try {
    await device.run(
      device.sql`INSERT INTO fixture_c1c_device_registration VALUES(${slot},1,1,${a.anchor.bundleDigest},0,0)`,
    );
  } finally {
    await device.close();
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function connect(file: string) {
  const db = await openPublicationFixture(file);
  cleanups.push(() => db.close());
  return db;
}
async function setup() {
  const file = join(root, `${randomUUID()}.sqlite`);
  await copyFile(template, file);
  return { file, db: await connect(file) };
}
async function local(
  db: PublicationFixture,
  anchor: RecoveryAnchor = a.anchor,
  useStore?: (s: DeviceInstallStore) => DeviceInstallStore,
  fence = 1,
) {
  const deviceKeys = keys(),
    deviceSignal = new AbortController(),
    anchorSignal = new AbortController();
  const deviceRelease = vi.fn(),
    ownerRelease = vi.fn(),
    backing = makeDeviceInstallFixtureStore(db);
  const deviceCapture = vi.fn<DeviceInstallProvider["capture"]>(() => ({
    target: { ...target, fence },
    revoked: deviceSignal.signal,
    assertCurrent() {},
    release: deviceRelease,
  }));
  const ownerCapture = vi.fn<CurrentOwnerAnchorProvider["capture"]>(() => ({
    anchor,
    revoked: anchorSignal.signal,
    assertCurrent() {},
    release: ownerRelease,
  }));
  const api = createRoomDeviceInstaller(
    deviceKeys,
    { capture: deviceCapture },
    { capture: ownerCapture },
    useStore ? useStore(backing.store) : backing.store,
  );
  cleanups.push(() => api.close());
  const lease = await api.acquireRoom(room);
  return {
    api,
    lease,
    deviceKeys,
    deviceSignal,
    anchorSignal,
    deviceCapture,
    ownerCapture,
    ownerRelease,
    deviceRelease,
    ...backing,
    prepare: (data: Issued, signal?: AbortSignal) => api.prepare(lease, data.bundle, signal),
    apply: async (data: Issued) => api.install(await api.prepare(lease, data.bundle)),
  };
}
const pin = (db: PublicationFixture, anchor: RecoveryAnchor) =>
  db.run(
    db.sql`UPDATE fixture_c1c_device_registration SET approved_anchor=${anchor.bundleDigest} WHERE slot=${slot}`,
  );
async function installed(db: PublicationFixture) {
  const value = await makeDeviceInstallFixtureStore(db).store.read(target);
  if (value.kind !== "installed") throw new Error("Expected fixture device installation");
  const doc = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(doc, value.update);
    return {
      version: value.version,
      floor: value.floor,
      update: value.update,
      body: readPageDoc(doc),
      text: doc.getText("history").toString(),
      binary: new Uint8Array(doc.getMap("binary").get("bytes") as Uint8Array),
    };
  } finally {
    doc.destroy();
  }
}

describe("device document/floor installation in file SQLite", () => {
  it("installs real owner bundles, advances only after commit, and reopens matching deletes/binary bytes/floor", async () => {
    const { db, file } = await setup(),
      first = await local(db);
    const t = await first.prepare(a);
    expect((await first.store.read(target)).kind).toBe("enrolled");
    expect((await first.api.install(t)).kind).toBe("installed");
    const v1 = await installed(db);
    expect(v1.version).toBe(1);
    expect(v1.floor.bundleDigest).toBe(a.anchor.bundleDigest);
    expect(v1.text).toBe("ABC");
    await pin(db, b.anchor);
    const next = await local(db, b.anchor);
    await next.apply(b);
    await db.close();
    const reopened = await connect(file),
      v2 = await installed(reopened);
    expect(v2.version).toBe(2);
    expect(v2.floor.bundleDigest).toBe(b.anchor.bundleDigest);
    expect(v2.body).toEqual(para("B"));
    expect(v2.text).toBe("AC");
    expect(v2.binary).toEqual(Uint8Array.of(255, 0, 52));
    expect((await (await local(reopened, b.anchor)).apply(b)).kind).toBe("reused");
    expect((await installed(reopened)).version).toBe(2);
  });

  it.each(["doc", "floor", "marker"] as const)(
    "rolls back a mid-install %s failure and retries from a new verified candidate",
    async (stage) => {
      const { db, file } = await setup();
      await (await local(db)).apply(a);
      const before = await installed(db);
      await pin(db, b.anchor);
      const next = await local(db, b.anchor),
        ticket = await next.prepare(b);
      const table =
        stage === "marker" ? "fixture_c1c_device_registration" : `fixture_c1c_device_${stage}`;
      const operation = stage === "marker" ? "UPDATE OF install_version" : "UPDATE";
      await db.run(
        db.sql.unsafe(
          `CREATE TRIGGER fixture_device_abort BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'fixture device failure'); END`,
        ),
      );
      await expect(next.api.install(ticket)).rejects.toMatchObject({ code: "commit-unknown" });
      await expect(next.api.install(ticket)).rejects.toMatchObject({ code: "invalid-capability" });
      await db.close();
      const reopened = await connect(file);
      expect(await installed(reopened)).toEqual(before);
      await reopened.run(reopened.sql`DROP TRIGGER fixture_device_abort`);
      expect((await (await local(reopened, b.anchor)).apply(b)).kind).toBe("installed");
      expect((await installed(reopened)).floor.bundleDigest).toBe(b.anchor.bundleDigest);
    },
  );

  it("recovers a lost COMMIT reply on a new connection without advancing the installed version twice", async () => {
    const { db, file } = await setup(),
      device = await local(db);
    device.hooks.afterCommit = () => {
      throw new RoomDeviceInstallError("rollback");
    };
    await expect(device.apply(a)).rejects.toMatchObject({
      code: "commit-unknown",
      message: "Room device install: commit-unknown",
    });
    await db.close();
    const reopened = await connect(file),
      fresh = await local(reopened);
    const result = await fresh.apply(a);
    expect(result.kind).toBe("reused");
    expect(result.floor.bundleDigest).toBe(a.anchor.bundleDigest);
    expect((await installed(reopened)).version).toBe(1);
  });

  it("competing tickets on separate connections have one winner and a consumed loser", async () => {
    const { db, file } = await setup(),
      other = await connect(file),
      one = await local(db),
      two = await local(other);
    const left = await one.prepare(a),
      right = await two.prepare(a),
      entered = deferred<void>(),
      release = deferred<void>();
    one.hooks.beforeCommit = async () => {
      entered.resolve();
      await release.promise;
    };
    const lost = expect(one.api.install(left)).rejects.toMatchObject({ code: "conflict" });
    try {
      await entered.promise;
      expect((await two.api.install(right)).kind).toBe("installed");
      release.resolve();
      await lost;
      await expect(one.api.install(left)).rejects.toMatchObject({ code: "invalid-capability" });
      expect((await one.apply(a)).kind).toBe("reused");
      expect((await installed(db)).version).toBe(1);
    } finally {
      release.resolve();
    }
  });

  it.each(["floor", "doc", "both", "wrong-floor-version", "wrong-room"])(
    "refuses known-install %s loss/corruption instead of inferring fresh enrollment",
    async (variant) => {
      const { db, file } = await setup();
      await (await local(db)).apply(a);
      if (variant === "floor" || variant === "both")
        await db.run(db.sql`DELETE FROM fixture_c1c_device_floor`);
      if (variant === "doc" || variant === "both")
        await db.run(db.sql`DELETE FROM fixture_c1c_device_doc`);
      if (variant === "wrong-floor-version")
        await db.run(db.sql`UPDATE fixture_c1c_device_floor SET install_version=0`);
      if (variant === "wrong-room") {
        const previous = await installed(db),
          floor = { ...previous.floor, room: { ...room, roomId: "other-room" } };
        await db.run(
          db.sql`UPDATE fixture_c1c_device_floor SET floor_json=${JSON.stringify(floor)}`,
        );
      }
      await db.close();
      const reopened = await connect(file);
      await pin(reopened, b.anchor);
      const next = await local(reopened, b.anchor);
      await expect(next.prepare(b)).rejects.toMatchObject({ code: "owner-required" });
      expect(
        await reopened.run(
          reopened.sql`SELECT installed_once,install_version FROM fixture_c1c_device_registration`,
        ),
      ).toEqual([{ installed_once: 1, install_version: 1 }]);
    },
  );

  it("rejects an older current-owner snapshot after a newer persisted device floor even across restart", async () => {
    const { db, file } = await setup();
    await (await local(db)).apply(a);
    await pin(db, b.anchor);
    await (await local(db, b.anchor)).apply(b);
    await db.close();
    const reopened = await connect(file);
    await pin(reopened, a.anchor);
    await expect((await local(reopened, a.anchor)).prepare(a)).rejects.toMatchObject({
      code: "rollback",
    });
    expect((await installed(reopened)).floor.bundleDigest).toBe(b.anchor.bundleDigest);
  });

  it("preserves local bytes changed before prepare or between prepare and commit", async () => {
    const { db } = await setup();
    await (await local(db)).apply(a);
    const old = await installed(db);
    await pin(db, b.anchor);
    const next = await local(db, b.anchor),
      ticket = await next.prepare(b),
      changed = old.update.slice();
    changed[0] = changed[0]! ^ 1;
    await db.run(db.sql`UPDATE fixture_c1c_device_doc SET state=${changed}`);
    await expect(next.api.install(ticket)).rejects.toMatchObject({ code: "local-changed" });
    await expect(next.prepare(b)).rejects.toMatchObject({ code: "local-changed" });
    const [row] = await db.run(
      db.sql<{ state: Uint8Array }>`SELECT state FROM fixture_c1c_device_doc`,
    );
    expect(new Uint8Array(row!.state)).toEqual(changed);
    expect(await db.run(db.sql`SELECT install_version FROM fixture_c1c_device_floor`)).toEqual([
      { install_version: 1 },
    ]);
  });

  it("CAS rejects a rewritten prior floor without replacing the currently stored document", async () => {
    const { db } = await setup();
    await (await local(db)).apply(a);
    const before = await installed(db);
    await pin(db, b.anchor);
    const next = await local(db, b.anchor),
      ticket = await next.prepare(b);
    await db.run(
      db.sql`UPDATE fixture_c1c_device_floor SET floor_json=${JSON.stringify({ ...before.floor, commitDigest: "e".repeat(64) })}`,
    );
    await expect(next.api.install(ticket)).rejects.toMatchObject({ code: "conflict" });
    expect((await installed(db)).update).toEqual(before.update);
  });
});

describe("device/owner authority, candidate and relay boundaries", () => {
  it("requires the trusted owner pin and cannot get a floor or anchor from a relay object", async () => {
    const { db } = await setup(),
      old = await local(db, a.anchor);
    await expect(
      old.api.prepare(old.lease, { ...a.bundle, floor: b.anchor } as never),
    ).rejects.toMatchObject({ code: "invalid-bundle" });
    await expect(old.prepare(b)).rejects.toMatchObject({ code: "binding-mismatch" });
    old.ownerCapture.mockReturnValueOnce(null);
    await expect(old.prepare(a)).rejects.toMatchObject({ code: "anchor-required" });
    await pin(db, b.anchor);
    await expect(old.prepare(a)).rejects.toMatchObject({ code: "anchor-changed" });
    expect((await old.store.read(target)).kind).toBe("enrolled");
  });

  it.each(["pin", "fence", "disabled"])(
    "rejects a stale %s old ticket at the durable CAS",
    async (variant) => {
      const { db } = await setup(),
        device = await local(db),
        ticket = await device.prepare(a);
      if (variant === "pin") await pin(db, b.anchor);
      if (variant === "fence")
        await db.run(db.sql`UPDATE fixture_c1c_device_registration SET fence=2`);
      if (variant === "disabled")
        await db.run(db.sql`UPDATE fixture_c1c_device_registration SET active=0`);
      await expect(device.api.install(ticket)).rejects.toMatchObject({
        code: variant === "pin" ? "anchor-changed" : "revoked",
      });
      expect(await db.run(db.sql`SELECT count(*) AS n FROM fixture_c1c_device_doc`)).toEqual([
        { n: 0 },
      ]);
      if (variant === "fence")
        expect((await (await local(db, a.anchor, undefined, 2)).apply(a)).kind).toBe("installed");
    },
  );

  it.each(["device", "owner", "key", "operation"])(
    "rejects %s revocation after candidate take but before transaction commit",
    async (variant) => {
      const { db } = await setup(),
        device = await local(db),
        signal = new AbortController();
      const ticket = await device.prepare(a, signal.signal);
      device.hooks.beforeCommit = async () => {
        if (variant === "device") device.deviceSignal.abort();
        if (variant === "owner") device.anchorSignal.abort();
        if (variant === "key") device.deviceKeys.revoked.abort();
        if (variant === "operation") signal.abort();
      };
      await expect(device.api.install(ticket)).rejects.toMatchObject({
        code: variant === "operation" ? "aborted" : "revoked",
      });
      expect(
        await db.run(
          db.sql`SELECT installed_once,install_version FROM fixture_c1c_device_registration`,
        ),
      ).toEqual([{ installed_once: 0, install_version: 0 }]);
    },
  );

  it("rejects foreign/copied tickets and leases, accepts only one pending install ticket", async () => {
    const { db } = await setup(),
      left = await local(db),
      right = await local(db);
    await expect(left.api.prepare(right.lease, a.bundle)).rejects.toMatchObject({
      code: "invalid-capability",
    });
    const ticket = await left.prepare(a);
    await expect(right.api.install(ticket)).rejects.toMatchObject({ code: "invalid-capability" });
    await expect(left.api.install({ ...ticket } as DeviceInstallTicket)).rejects.toMatchObject({
      code: "invalid-capability",
    });
    await expect(left.prepare(a)).rejects.toMatchObject({ code: "busy" });
    left.api.discard(ticket);
    await expect(left.api.install(ticket)).rejects.toMatchObject({ code: "invalid-capability" });
    expect((await left.apply(a)).kind).toBe("installed");
  });

  it("retires a key-revoked held ticket before accepting another authorized generation", async () => {
    const { db } = await setup(),
      device = await local(db),
      old = await device.prepare(a);
    device.deviceKeys.rotate();
    const lease = await device.api.acquireRoom(room);
    // Old historical streams may only be read on a new key lease via a fresh
    // stream. B was minted on another stream and is explicitly approved here.
    await pin(db, b.anchor);
    device.ownerCapture.mockReturnValueOnce({
      anchor: b.anchor,
      revoked: new AbortController().signal,
      assertCurrent() {},
      release() {},
    });
    const fresh = await device.api.prepare(lease, b.bundle);
    await expect(device.api.install(old)).rejects.toMatchObject({ code: "invalid-capability" });
    expect((await device.api.install(fresh)).floor.bundleDigest).toBe(b.anchor.bundleDigest);
  });

  it("does not borrow another profile/device's installation record", async () => {
    const { db } = await setup(),
      device = await local(db);
    await device.apply(a);
    device.deviceCapture.mockReturnValueOnce({
      target: { ...target, deviceRef: "another-device" },
      revoked: new AbortController().signal,
      assertCurrent() {},
      release() {},
    });
    await expect(device.prepare(a)).rejects.toMatchObject({ code: "revoked" });
    device.deviceCapture.mockReturnValueOnce({
      target: { ...target, profileRef: "other-profile" },
      revoked: new AbortController().signal,
      assertCurrent() {},
      release() {},
    });
    await expect(device.prepare(a)).rejects.toMatchObject({ code: "revoked" });
    expect((await installed(db)).version).toBe(1);
  });

  it("copies relay bytes before the first file-read await", async () => {
    const { db } = await setup(),
      device = await local(db),
      entered = deferred<void>(),
      go = deferred<void>();
    device.hooks.beforeRead = async () => {
      entered.resolve();
      await go.promise;
    };
    const frame = structuredClone(a.bundle),
      pending = device.api.prepare(device.lease, frame);
    await entered.promise;
    frame.checkpoint.ciphertext.fill(0);
    go.resolve();
    expect((await device.api.install(await pending)).kind).toBe("installed");
  });

  it("holds the slot until an aborted native installed-state hash settles", async () => {
    const { db } = await setup(),
      device = await local(db);
    await device.apply(a);
    const entered = deferred<void>(),
      native = deferred<ArrayBuffer>(),
      abort = new AbortController();
    const sha = vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(() => {
      entered.resolve();
      return native.promise;
    });
    const pending = expect(device.prepare(a, abort.signal)).rejects.toMatchObject({
      code: "aborted",
    });
    await entered.promise;
    abort.abort();
    await expect(device.prepare(a)).rejects.toMatchObject({ code: "busy" });
    expect(sha).toHaveBeenCalledTimes(1);
    native.resolve(new ArrayBuffer(32));
    await pending;
    expect((await device.apply(a)).kind).toBe("reused");
  });

  it.each(["device", "owner", "read", "read-getter", "commit"])(
    "redacts external %s exception objects",
    async (variant) => {
      const { db } = await setup(),
        privateError = new RoomDeviceInstallError("fork");
      privateError.message = "private device fixture diagnostic";
      privateError.cause = "private cause";
      const device = await local(db, a.anchor, (s) => ({
        read: async (t) => {
          if (variant === "read") throw privateError;
          if (variant === "read-getter")
            return {
              get kind() {
                throw privateError;
              },
            } as never;
          return s.read(t);
        },
        commit: async (input) => {
          if (variant === "commit") throw privateError;
          return s.commit(input);
        },
      }));
      if (variant === "device")
        device.deviceCapture.mockImplementationOnce(() => {
          throw privateError;
        });
      if (variant === "owner")
        device.ownerCapture.mockImplementationOnce(() => {
          throw privateError;
        });
      const result = await device.apply(a).catch((error: unknown) => error);
      const code =
        variant === "device"
          ? "device-required"
          : variant === "owner"
            ? "anchor-required"
            : variant === "commit"
              ? "commit-unknown"
              : "storage-unavailable";
      expect(result).toMatchObject({ code, message: `Room device install: ${code}` });
      expect(result).not.toBe(privateError);
      expect(result).not.toHaveProperty("cause");
    },
  );
});
