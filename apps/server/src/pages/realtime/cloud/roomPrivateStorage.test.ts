import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ManagedRuntime } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { copyFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { ServerConfig } from "../../../config";
import { ServerEnvironmentLive } from "../../../environment/Layers/ServerEnvironment";
import { layerConfig } from "../../../persistence/Layers/Sqlite";
import { readPageDoc, seedPageDoc } from "../pageYjsContent";
import { commitRoomCheckpoint } from "../pageRoomPublication";
import { makeRoomProfileStorage } from "./roomProfileStorage";
import { makeRoomPrivateStorage } from "./roomPrivateStorage";
import { type VerifiedOwnerControl, type VerifiedDeviceControl } from "./roomPrivateStoreAuthority";
import { type RoomBinding } from "./roomEnvelopeProtocol";
import { type RecoveryAnchor } from "./roomRecoveryProtocol";

const room: RoomBinding = {
  tenantRef: "test-tenant",
  roomId: "test-room",
  documentGeneration: "doc-1",
  keyEpoch: 1,
};
const pageId = "test-page",
  scopeKey = "local-default";
const close: Array<() => Promise<void>> = [];
let root: string, template: string;
const profile = (base: string) => {
  const config = ServerConfig.layerTest(process.cwd(), base);
  const layer = Layer.mergeAll(ServerEnvironmentLive, layerConfig).pipe(
    Layer.provideMerge(config),
    Layer.provide(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);
  close.push(() => runtime.dispose());
  return runtime;
};
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "p165-"));
  template = join(root, "base");
  const rt = profile(template);
  await rt.runPromise(makeRoomProfileStorage);
  await rt.dispose();
});
afterEach(async () => {
  while (close.length) await close.pop()!();
});
async function setup() {
  const base = await mkdtemp(join(root, "p-"));
  await mkdir(join(base, "userdata"));
  await copyFile(join(template, "userdata/state.sqlite"), join(base, "userdata/state.sqlite"));
  const rt = profile(base),
    sql = await rt.runPromise(Effect.service(SqlClient.SqlClient)),
    p = await rt.runPromise(makeRoomProfileStorage);
  const original = { profileRef: p.profileRef, room, fence: 1 };
  const signal = new AbortController();
  let anchor: RecoveryAnchor | null = null,
    assertions = 0,
    ttl = 15_000,
    issue = true;
  const owner = {
    target: { ...original, scopeKey, pageId, senderRef: "test-owner" },
    active: true,
    mayEnroll: true,
    authorizeGenesis: true,
    authorityVersion: 1,
    confirmedDigest: null as string | null,
  };
  const device = {
    target: { ...original, deviceRef: "test-device" },
    active: true,
    mayEnroll: true,
    authorityVersion: 1,
    approvedDigest: "a".repeat(64),
    accepted: null as VerifiedDeviceControl["accepted"],
  };
  function grant<T extends typeof owner | typeof device>(data: T) {
    const ver = data.authorityVersion,
      deadline = performance.now() + ttl;
    return {
      ...data,
      expiresAt: deadline,
      revoked: signal.signal,
      assertCurrent() {
        assertions++;
        if (ver !== data.authorityVersion || !issue) throw new Error("private-test-value");
      },
      release() {},
    };
  }
  const key = crypto.subtle.importKey("raw", new Uint8Array(32).fill(17), "HKDF", false, [
    "deriveKey",
  ]);
  const config = {
    authority: {
      owner: (): VerifiedOwnerControl | null => (issue ? grant(owner) : null),
      device: (): VerifiedDeviceControl | null => (issue ? grant(device) : null),
    },
    keys: { request: () => ({ key, revoked: signal.signal, assertCurrent() {}, release() {} }) },
    anchors: {
      capture: () => anchor && { anchor, revoked: signal.signal, assertCurrent() {}, release() {} },
    },
  };
  const api = (await rt.runPromise(makeRoomPrivateStorage(config)))!;
  close.push(async () => api.close());
  const doc = new Y.Doc({ gc: false });
  seedPageDoc(doc, [{ type: "p", children: [{ text: "私有夹具" }] }]);
  doc.getText("ops").insert(0, "ABC");
  doc.getMap("raw").set("value", Uint8Array.of(255, 0, 9));
  close.push(async () => doc.destroy());
  async function save(revision: number) {
    const rich = JSON.stringify(readPageDoc(doc));
    await rt.runPromise(
      sql.withTransaction(
        Effect.gen(function* () {
          if (revision === 1)
            yield* sql`INSERT INTO main.pages_documents(page_id,scope_key,root_page_id,title,revision,created_at,updated_at)
        VALUES(${pageId},${scopeKey},${pageId},'fixture',1,'fixture','fixture')`;
          else
            yield* sql`UPDATE main.pages_documents SET revision=${revision} WHERE page_id=${pageId}`;
          yield* sql`INSERT INTO main.pages_versions(page_id,revision,page_json,content,rich_content,operation,author,created_at)
        VALUES(${pageId},${revision},'{}','fixture',${rich},'update','local-user','fixture')`;
          yield* commitRoomCheckpoint(sql, pageId, {
            generation: room.documentGeneration,
            revision,
            throughSequence: 0,
            key: rich,
            state: Y.encodeStateAsUpdate(doc),
          });
        }),
      ),
    );
  }
  await save(1);
  const publishLease = await api.publisher.acquireRoom(room),
    deviceLease = await api.installer.acquireRoom(room);
  return {
    base,
    rt,
    sql,
    api,
    owner,
    device,
    signal,
    doc,
    config,
    save,
    publishLease,
    deviceLease,
    publish: () => api.publisher.publish(publishLease),
    pin: (a: RecoveryAnchor) => {
      anchor = a;
      device.approvedDigest = a.bundleDigest;
    },
    disable: () => {
      issue = false;
    },
    expiry: (ms: number) => {
      ttl = ms;
    },
    checks: () => assertions,
  };
}
describe("private owner and device recovery stores in a formally configured local profile", () => {
  it("disables absent configuration and requires positive independent enrollment, current subject and bounded deadline", async () => {
    const x = await setup();
    expect(await x.rt.runPromise(makeRoomPrivateStorage())).toBeNull();
    await expect(x.publish()).rejects.toMatchObject({ code: "revoked" });
    const count = () =>
      x.rt.runPromise(x.sql<{ n: number }>`SELECT count(*) AS n FROM main.pages_room_owner_slots`);
    expect(await count()).toMatchObject([{ n: 0 }]);
    x.owner.mayEnroll = false;
    await expect(x.api.applyOwnerControl(room, null)).rejects.toMatchObject({
      code: "authority-required",
    });
    x.owner.mayEnroll = true;
    for (const ms of [-1, 60_000]) {
      x.expiry(ms);
      await expect(x.api.applyOwnerControl(room, null)).rejects.toMatchObject({
        code: "authority-required",
      });
    }
    x.expiry(15_000);
    await expect(
      x.api.applyOwnerControl({ ...room, tenantRef: "other" }, null),
    ).rejects.toMatchObject({ code: "authority-required" });
    x.owner.target.profileRef = "wrong-profile";
    await expect(x.api.applyOwnerControl(room, null)).rejects.toMatchObject({
      code: "authority-required",
    });
    x.disable();
    await expect(x.api.applyDeviceControl(room, null)).rejects.toMatchObject({
      code: "authority-required",
    });
    expect(await count()).toMatchObject([{ n: 0 }]);
  });
  it("commits owner blob/head/outbox, recovers unacknowledged bytes after restart, and checks exact ACK fence", async () => {
    const x = await setup();
    await x.api.applyOwnerControl(room, null);
    const a = await x.publish(),
      pending = await x.api.pendingDelivery(room);
    expect(pending).toEqual({ fence: 1, digest: a.anchor.bundleDigest, bundle: a.bundle });
    expect(Object.keys(pending!).sort()).toEqual(["bundle", "digest", "fence"]);
    expect((await x.publish()).kind).toBe("reused");
    await x.rt.dispose();
    const reopened = profile(x.base);
    const api = (await reopened.runPromise(makeRoomPrivateStorage(x.config)))!;
    close.push(async () => api.close());
    expect(await api.pendingDelivery(room)).toEqual(pending);
    expect(await api.acknowledgeDelivery(room, 2, a.anchor.bundleDigest)).toBe(false);
    expect(await api.acknowledgeDelivery(room, 1, a.anchor.bundleDigest)).toBe(true);
    expect(await api.pendingDelivery(room)).toBeNull();
    const sql = await reopened.runPromise(Effect.service(SqlClient.SqlClient));
    expect(
      await reopened.runPromise(sql`SELECT confirmed_digest FROM main.pages_room_owner_slots`),
    ).toMatchObject([{ confirmed_digest: null }]);
  });
  it("rolls back a partial owner outbox write, requires independent confirmation before another cut, and blocks unconfirmed ownership transfer", async () => {
    const x = await setup();
    await x.api.applyOwnerControl(room, null);
    await x.rt.runPromise(
      x.sql`CREATE TRIGGER explode_outbox BEFORE INSERT ON main.pages_room_owner_outbox BEGIN SELECT RAISE(ABORT,'test'); END`,
    );
    await expect(x.publish()).rejects.toMatchObject({ code: "commit-unknown" });
    expect(
      await x.rt.runPromise(x.sql`SELECT count(*) n FROM main.pages_room_owner_publications`),
    ).toMatchObject([{ n: 0 }]);
    await x.rt.runPromise(x.sql`DROP TRIGGER explode_outbox`);
    const a = await x.publish();
    x.doc.getText("ops").delete(1, 1);
    await x.save(2);
    await expect(x.publish()).rejects.toMatchObject({ code: "owner-required" });
    x.owner.target.senderRef = "new-owner";
    x.owner.target.fence = 2;
    x.owner.authorityVersion = 2;
    await expect(x.api.applyOwnerControl(room, 1)).rejects.toMatchObject({
      code: "authority-required",
    });
    x.owner.confirmedDigest = a.anchor.bundleDigest;
    await x.api.applyOwnerControl(room, 1);
    await expect(x.api.applyOwnerControl(room, 1)).rejects.toMatchObject({ code: "conflict" });
    const b = await x.publish();
    expect(b.anchor.checkpointVersion).toBe(2);
    expect(await x.api.acknowledgeDelivery(room, 1, a.anchor.bundleDigest)).toBe(false);
  });
  it("pins old ciphertext for a device floor, retains durable deletes and binary, and collects only on another independent confirmation CAS", async () => {
    const x = await setup();
    await x.api.applyOwnerControl(room, null);
    const a = await x.publish();
    x.pin(a.anchor);
    await x.api.applyDeviceControl(room, null);
    const install = async (b: typeof a) =>
      x.api.installer.install(await x.api.installer.prepare(x.deviceLease, b.bundle));
    const first = await install(a);
    expect(first.kind).toBe("installed");
    x.owner.confirmedDigest = a.anchor.bundleDigest;
    x.owner.authorityVersion = 2;
    await x.api.applyOwnerControl(room, 1);
    x.doc.getText("ops").delete(1, 1);
    x.doc.getMap("raw").set("value", Uint8Array.of(255, 0, 52));
    await x.save(2);
    const b = await x.publish();
    x.owner.confirmedDigest = b.anchor.bundleDigest;
    x.owner.authorityVersion = 3;
    await x.api.applyOwnerControl(room, 2);
    const retained = () =>
      x.rt.runPromise(
        x.sql<{
          bundle_digest: string;
        }>`SELECT bundle_digest FROM main.pages_room_owner_publications ORDER BY source_revision`,
      );
    expect((await retained()).map((r) => r.bundle_digest)).toEqual([
      a.anchor.bundleDigest,
      b.anchor.bundleDigest,
    ]);
    x.pin(b.anchor);
    x.device.authorityVersion = 2;
    await expect(x.api.applyDeviceControl(room, 1)).rejects.toMatchObject({
      code: "authority-required",
    });
    x.device.accepted = { version: 1, floor: first.floor };
    await x.api.applyDeviceControl(room, 1);
    const second = await install(b);
    expect(second.kind).toBe("installed");
    expect(
      await x.rt.runPromise(x.sql`SELECT install_version FROM main.pages_room_device_slots`),
    ).toMatchObject([{ install_version: 2 }]);
    expect((await retained()).length).toBe(2);
    x.owner.authorityVersion = 4;
    await x.api.applyOwnerControl(room, 3);
    expect((await retained()).map((r) => r.bundle_digest)).toEqual([b.anchor.bundleDigest]);
    const [row] = await x.rt.runPromise(
      x.sql<{
        state: Uint8Array;
        floor_json: string;
      }>`SELECT state,floor_json FROM main.pages_room_device_installs`,
    );
    expect(JSON.parse(row!.floor_json)).toEqual(second.floor);
    const doc = new Y.Doc({ gc: false });
    try {
      Y.applyUpdate(doc, row!.state);
      expect(doc.getText("ops").toString()).toBe("AC");
      expect(doc.getMap("raw").get("value")).toEqual(Uint8Array.of(255, 0, 52));
    } finally {
      doc.destroy();
    }
    x.device.accepted = { version: 2, floor: second.floor };
    await x.rt.dispose();
    const reopened = profile(x.base),
      api = (await reopened.runPromise(makeRoomPrivateStorage(x.config)))!;
    close.push(async () => api.close());
    const lease = await api.installer.acquireRoom(room);
    expect((await api.installer.install(await api.installer.prepare(lease, b.bundle))).kind).toBe(
      "reused",
    );
  });
  it("rolls back the device state and version together and demands repair when a previously installed row has vanished", async () => {
    const x = await setup();
    await x.api.applyOwnerControl(room, null);
    const a = await x.publish();
    x.pin(a.anchor);
    await x.api.applyDeviceControl(room, null);
    const prepare = () => x.api.installer.prepare(x.deviceLease, a.bundle);
    await x.rt.runPromise(
      x.sql`CREATE TRIGGER explode_version BEFORE UPDATE OF install_version ON main.pages_room_device_slots BEGIN SELECT RAISE(ABORT,'test'); END`,
    );
    const ticket = await prepare();
    await expect(x.api.installer.install(ticket)).rejects.toMatchObject({ code: "commit-unknown" });
    await expect(x.api.installer.install(ticket)).rejects.toMatchObject({
      code: "invalid-capability",
    });
    expect(
      await x.rt.runPromise(x.sql`SELECT count(*) n FROM main.pages_room_device_installs`),
    ).toMatchObject([{ n: 0 }]);
    await x.rt.runPromise(x.sql`DROP TRIGGER explode_version`);
    const installed = await x.api.installer.install(await prepare());
    x.device.accepted = { version: 1, floor: installed.floor };
    await x.rt.runPromise(x.sql`DELETE FROM main.pages_room_device_installs`);
    await expect(prepare()).rejects.toMatchObject({ code: "owner-required" });
    await expect(x.api.applyDeviceControl(room, 1)).rejects.toMatchObject({
      code: "authority-required",
    });
  });
  it("rejects fresh registrations on a rolled-back profile when independent device or owner pins already exist", async () => {
    const x = await setup();
    x.owner.confirmedDigest = "b".repeat(64);
    await expect(x.api.applyOwnerControl(room, null)).rejects.toMatchObject({
      code: "authority-required",
    });
    x.owner.confirmedDigest = null;
    await x.api.applyOwnerControl(room, null);
    const a = await x.publish();
    x.pin(a.anchor);
    x.device.accepted = {
      version: 1,
      floor: {
        room,
        checkpointId: a.anchor.checkpointId,
        checkpointVersion: 1,
        checkpointDigest: a.anchor.checkpointDigest,
        commitIndex: a.anchor.tailEndCommitIndex,
        commitDigest: a.anchor.tailHeadDigest,
        bundleDigest: a.anchor.bundleDigest,
      },
    };
    await expect(x.api.applyDeviceControl(room, null)).rejects.toMatchObject({
      code: "authority-required",
    });
    x.signal.abort();
    await expect(x.api.pendingDelivery(room)).rejects.toMatchObject({ code: "authority-required" });
  });
  it("serializes two publishers and two independently verified installation tickets against the same head and floor", async () => {
    const x = await setup();
    await x.api.applyOwnerControl(room, null);
    const other = (await x.rt.runPromise(makeRoomPrivateStorage(x.config)))!;
    close.push(async () => other.close());
    const ownerLease = await other.publisher.acquireRoom(room);
    const outcomes = await Promise.allSettled([x.publish(), other.publisher.publish(ownerLease)]);
    const successes = outcomes.filter((r) => r.status === "fulfilled");
    expect(successes.length).toBeGreaterThan(0);
    expect(successes.filter((r) => r.value.kind === "published").length).toBe(1);
    for (const failure of outcomes.filter((r) => r.status === "rejected"))
      expect(failure.reason).toMatchObject({ code: "conflict" });
    const a = successes[0]!.value;
    expect(
      await x.rt.runPromise(x.sql`SELECT count(*) n FROM main.pages_room_owner_publications`),
    ).toMatchObject([{ n: 1 }]);
    x.pin(a.anchor);
    await x.api.applyDeviceControl(room, null);
    const otherDevice = await other.installer.acquireRoom(room);
    const [t1, t2] = await Promise.all([
      x.api.installer.prepare(x.deviceLease, a.bundle),
      other.installer.prepare(otherDevice, a.bundle),
    ]);
    const installed = await Promise.allSettled([
      x.api.installer.install(t1),
      other.installer.install(t2),
    ]);
    expect(installed.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(installed.find((r) => r.status === "rejected")?.reason).toMatchObject({
      code: "conflict",
    });
    expect(
      await x.rt.runPromise(x.sql`SELECT install_version FROM main.pages_room_device_slots`),
    ).toMatchObject([{ install_version: 1 }]);
  });
  it("fences revoked owners without resetting their known head or accepting a late old ACK", async () => {
    const x = await setup();
    await x.api.applyOwnerControl(room, null);
    const a = await x.publish();
    x.owner.active = false;
    x.owner.authorityVersion = 2;
    x.owner.target.fence = 2;
    await x.api.applyOwnerControl(room, 1);
    await expect(x.publish()).rejects.toMatchObject({ code: "owner-required" });
    expect(await x.api.acknowledgeDelivery(room, 1, a.anchor.bundleDigest)).toBe(false);
    x.owner.active = true;
    x.owner.authorityVersion = 3;
    await expect(x.api.applyOwnerControl(room, 2)).rejects.toMatchObject({
      code: "authority-required",
    });
    x.owner.target.fence = 3;
    x.owner.confirmedDigest = a.anchor.bundleDigest;
    await x.api.applyOwnerControl(room, 2);
    expect((await x.publish()).kind).toBe("reused");
    expect(await x.api.acknowledgeDelivery(room, 1, a.anchor.bundleDigest)).toBe(false);
    expect(await x.api.acknowledgeDelivery(room, 3, a.anchor.bundleDigest)).toBe(true);
  });
  it("rejects a physically restored pre-enrollment database with the same public environment ID and independent later pins", async () => {
    const x = await setup(),
      rolled = await mkdtemp(join(root, "rolled-"));
    await mkdir(join(rolled, "userdata"));
    // Capture this exact live profile before enrollment through its own SQLite
    // connection. No raw file handle reads or copies a live DB/WAL/SHM.
    await x.rt.runPromise(
      x.sql.unsafe("VACUUM main INTO ?", [join(rolled, "userdata/state.sqlite")]),
    );
    await copyFile(
      join(x.base, "userdata/environment-id"),
      join(rolled, "userdata/environment-id"),
    );
    await x.api.applyOwnerControl(room, null);
    const a = await x.publish();
    x.pin(a.anchor);
    await x.api.applyDeviceControl(room, null);
    const first = await x.api.installer.install(
      await x.api.installer.prepare(x.deviceLease, a.bundle),
    );
    x.owner.authorityVersion = 2;
    x.owner.confirmedDigest = a.anchor.bundleDigest;
    await x.api.applyOwnerControl(room, 1);
    x.device.accepted = { version: 1, floor: first.floor };
    const past = profile(rolled),
      api = (await past.runPromise(makeRoomPrivateStorage(x.config)))!;
    close.push(async () => api.close());
    expect(api.profileRef).toBe(x.api.profileRef);
    await expect(api.applyOwnerControl(room, null)).rejects.toMatchObject({
      code: "authority-required",
    });
    await expect(api.applyDeviceControl(room, null)).rejects.toMatchObject({
      code: "authority-required",
    });
    const oldSql = await past.runPromise(Effect.service(SqlClient.SqlClient));
    expect(
      await past.runPromise(
        oldSql`SELECT revision FROM main.pages_documents WHERE page_id=${pageId}`,
      ),
    ).toMatchObject([{ revision: 1 }]);
    expect(
      await past.runPromise(oldSql`SELECT count(*) n FROM main.pages_room_owner_slots`),
    ).toMatchObject([{ n: 0 }]);
    expect(
      await past.runPromise(oldSql`SELECT count(*) n FROM main.pages_room_device_slots`),
    ).toMatchObject([{ n: 0 }]);
  });
  it("refuses another publication at the retained ciphertext budget without pruning old records", async () => {
    const x = await setup();
    await x.api.applyOwnerControl(room, null);
    const a = await x.publish();
    x.owner.confirmedDigest = a.anchor.bundleDigest;
    x.owner.authorityVersion = 2;
    await x.api.applyOwnerControl(room, 1);
    await x.rt
      .runPromise(x.sql`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<31)
      INSERT INTO main.pages_room_owner_publications SELECT profile_ref,tenant_ref,room_id,document_generation,key_epoch,printf('%064x',n.i),
      prior_head_digest,source_revision,source_sequence,source_digest,previous_commit_digest,receipt_salt,
      json_set(anchor_json,'$.bundleDigest',printf('%064x',n.i)),frame_json,ciphertext FROM main.pages_room_owner_publications,n WHERE bundle_digest=${a.anchor.bundleDigest}`);
    x.doc.getText("ops").insert(3, "D");
    await x.save(2);
    await expect(x.publish()).rejects.toMatchObject({ code: "over-budget" });
    expect(
      await x.rt.runPromise(x.sql`SELECT count(*) n FROM main.pages_room_owner_publications`),
    ).toMatchObject([{ n: 32 }]);
    expect(
      await x.rt.runPromise(x.sql`SELECT head_digest FROM main.pages_room_owner_slots`),
    ).toMatchObject([{ head_digest: a.anchor.bundleDigest }]);
  });
  it("refuses to redeliver corrupted private ciphertext even when its record still has the original digest", async () => {
    const x = await setup();
    await x.api.applyOwnerControl(room, null);
    await x.publish();
    // Fault injection into an isolated copied database only. The normal schema disallows UPDATE.
    await x.rt.runPromise(x.sql`DROP TRIGGER main.pages_room_publication_immutable`);
    await x.rt.runPromise(
      x.sql`UPDATE main.pages_room_owner_publications SET ciphertext=zeroblob(length(ciphertext))`,
    );
    await expect(x.api.pendingDelivery(room)).rejects.toMatchObject({ code: "authority-required" });
  });
  it("checks the profile connection policy on every operation, including delivery and close", async () => {
    const x = await setup();
    await x.api.applyOwnerControl(room, null);
    await x.publish();
    await x.rt.runPromise(x.sql`PRAGMA foreign_keys=OFF`);
    await expect(x.api.pendingDelivery(room)).rejects.toMatchObject({
      code: "storage-unavailable",
    });
    await x.rt.runPromise(x.sql`PRAGMA foreign_keys=ON`);
    expect(await x.api.pendingDelivery(room)).not.toBeNull();
    x.api.close();
    await expect(x.api.applyOwnerControl(room, 1)).rejects.toMatchObject({
      code: "authority-required",
    });
  });
});
