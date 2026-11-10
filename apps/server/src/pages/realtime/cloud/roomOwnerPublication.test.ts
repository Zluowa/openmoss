import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import * as Y from "yjs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { appendRoomUpdate, commitRoomCheckpoint } from "../pageRoomPublication";
import { applyPlateValue, readPageDoc, seedPageDoc } from "../pageYjsContent";
import { readPageRoomCommittedCut } from "./pageRoomCommittedCut";
import { type RoomKeyProvider } from "./roomEnvelope";
import { roomIdentity } from "./roomEnvelopeProtocol";
import { createRoomRecoveryAuthority } from "./roomRecoveryBundle";
import { type RecoveryAnchor, type RecoveryFloor } from "./roomRecoveryProtocol";
import {
  createRoomOwnerPublisher,
  RoomOwnerPublicationError,
  type OwnerPublicationStore,
  type RoomOwnerProvider,
} from "./roomOwnerPublication";
import {
  makePublicationFixtureStore,
  openPublicationFixture,
  seedPublicationFixture,
  type PublicationFixture,
} from "./testing/ownerPublicationSqliteFixture";

const room = {
  tenantRef: "fixture-tenant",
  roomId: "fixture-room",
  documentGeneration: "fixture-generation",
  keyEpoch: 1,
};
const target = {
  room,
  pageId: "fixture-page",
  scopeKey: "local-default",
  profileRef: "fixture-profile",
  senderRef: "fixture-owner",
  fence: 1,
};
const roomKey = roomIdentity(room),
  cap = 256 * 1024;
const cleanups: Array<() => void | Promise<void>> = [];
let root: string, template: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "moss-c1c-owner-fixture-"));
  template = join(root, "fixture-163-template.sqlite");
  await seedPublicationFixture(template);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});
function doc() {
  const d = new Y.Doc();
  cleanups.push(() => d.destroy());
  return d;
}
const para = (value: string) => [{ type: "p", children: [{ text: value }] }];
async function connect(file: string) {
  const db = await openPublicationFixture(file);
  cleanups.push(() => db.close());
  return db;
}
async function setup() {
  const file = join(root, `${randomUUID()}.sqlite`);
  await copyFile(template, file);
  const db = await connect(file),
    source = doc();
  seedPageDoc(source, para("A"));
  source.getMap("aux").set("binary", new Uint8Array([9, 0, 255]));
  const rich = JSON.stringify(readPageDoc(source));
  await db.run(
    db.sql.withTransaction(
      Effect.gen(function* () {
        yield* db.sql`INSERT INTO pages_documents(page_id,scope_key,root_page_id,title,revision,created_at,updated_at)
      VALUES(${target.pageId},${target.scopeKey},${target.pageId},'fixture',1,'fixture','fixture')`;
        yield* db.sql`INSERT INTO pages_versions(page_id,revision,page_json,content,rich_content,operation,author,created_at)
      VALUES(${target.pageId},1,'{}','A',${rich},'create','local-user','fixture')`;
        yield* commitRoomCheckpoint(db.sql, target.pageId, {
          generation: room.documentGeneration,
          state: Y.encodeStateAsUpdate(source),
          revision: 1,
          key: rich,
          throughSequence: 0,
        });
        yield* db.sql`INSERT INTO fixture_c1c_grant VALUES(${roomKey},${target.profileRef},${target.scopeKey},${target.pageId},${target.senderRef},1,1,1)`;
      }),
    ),
  );
  return { file, db, source };
}
async function append(db: PublicationFixture, source: Y.Doc, body: string) {
  const before = Y.encodeStateVector(source);
  applyPlateValue(source, para(body), "fixture-local");
  return db.run(
    appendRoomUpdate(
      db.sql,
      target.pageId,
      room.documentGeneration,
      Y.encodeStateAsUpdate(source, before),
      [{ kind: "local-user" }],
    ),
  );
}
async function compact(db: PublicationFixture, source: Y.Doc, revision: number, through: number) {
  const rich = JSON.stringify(readPageDoc(source));
  await db.run(
    db.sql.withTransaction(
      Effect.gen(function* () {
        yield* db.sql`UPDATE pages_documents SET revision=${revision} WHERE page_id=${target.pageId}`;
        yield* db.sql`INSERT INTO pages_versions(page_id,revision,page_json,content,rich_content,operation,author,created_at)
      VALUES(${target.pageId},${revision},'{}','fixture',${rich},'update','local-user','fixture')`;
        yield* commitRoomCheckpoint(db.sql, target.pageId, {
          generation: room.documentGeneration,
          state: Y.encodeStateAsUpdate(source),
          revision,
          key: rich,
          throughSequence: through,
        });
      }),
    ),
  );
}
function fakeKeys() {
  const key = crypto.subtle.importKey("raw", new Uint8Array(32).fill(7), "HKDF", false, [
    "deriveKey",
  ]);
  const revoke = new AbortController();
  const request: RoomKeyProvider["request"] = () => ({
    key,
    revoked: revoke.signal,
    assertCurrent() {
      if (revoke.signal.aborted) throw new Error("private key generation");
    },
    release() {},
  });
  return { request, revoke };
}
async function publisher(
  db: PublicationFixture,
  fence = 1,
  useStore?: (store: OwnerPublicationStore) => OwnerPublicationStore,
) {
  const backing = makePublicationFixtureStore(db),
    keys = fakeKeys(),
    revoked = new AbortController(),
    release = vi.fn();
  const capture = vi.fn<RoomOwnerProvider["capture"]>(() => ({
    target: { ...target, fence },
    revoked: revoked.signal,
    assertCurrent() {
      if (revoked.signal.aborted) throw new Error("private owner generation");
    },
    release,
  }));
  const api = createRoomOwnerPublisher(
    keys,
    { capture },
    useStore ? useStore(backing.store) : backing.store,
  );
  cleanups.push(() => api.close());
  const lease = await api.acquireRoom(room);
  return {
    ...backing,
    api,
    lease,
    capture,
    keys,
    revoked,
    release,
    publish: (signal?: AbortSignal) => api.publish(lease, signal),
  };
}
async function restore(
  result: Awaited<ReturnType<Awaited<ReturnType<typeof publisher>>["publish"]>>,
  floor: RecoveryFloor | null = null,
) {
  const recovery = createRoomRecoveryAuthority(fakeKeys(), {
    capture: () => ({
      anchor: result.anchor,
      floor,
      revoked: new AbortController().signal,
      assertCurrent() {},
      release() {},
    }),
  });
  try {
    const lease = await recovery.acquireRoom(room),
      verifier = recovery.openVerifier(recovery.admit(lease));
    const restored = doc();
    Y.applyUpdate(restored, verifier.take(await verifier.prepare(result.bundle)).update);
    return restored;
  } finally {
    recovery.close();
  }
}
const floorOf = (a: RecoveryAnchor): RecoveryFloor => ({
  room: a.room,
  checkpointId: a.checkpointId,
  checkpointVersion: a.checkpointVersion,
  checkpointDigest: a.checkpointDigest,
  commitIndex: a.tailEndCommitIndex,
  commitDigest: a.tailHeadDigest,
  bundleDigest: a.bundleDigest,
});
const counts = async (db: PublicationFixture) =>
  (
    await db.run(db.sql<{ heads: number; blobs: number; jobs: number }>`SELECT
  (SELECT count(*) FROM fixture_c1c_head) AS heads, (SELECT count(*) FROM fixture_c1c_blob) AS blobs, (SELECT count(*) FROM fixture_c1c_outbox) AS jobs`)
  )[0];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("file SQLite owner checkpoint publication", () => {
  it("publishes only the committed 163 prefix and restores deletes/binary state through the real C1b reader", async () => {
    const { db, source } = await setup(),
      p = await publisher(db);
    const bSeq = await append(db, source, "B");
    const first = await p.publish();
    expect(first.kind).toBe("published");
    expect(first.bundle.tail).toEqual([]);
    expect(first.anchor.coveredCommitIndex).toBe(0);
    expect(readPageDoc(await restore(first))).toEqual(para("A"));
    expect(
      await db.run(
        db.sql`SELECT compacted_through_sequence,next_sequence FROM pages_realtime_docs`,
      ),
    ).toEqual([{ compacted_through_sequence: 0, next_sequence: 2 }]);
    await compact(db, source, 2, bSeq);
    const second = await p.publish();
    expect(second.anchor.checkpointVersion).toBe(2);
    expect(second.anchor.coveredCommitIndex).toBe(1);
    expect(second.bundle.checkpoint.stream.streamId).not.toBe(
      first.bundle.checkpoint.stream.streamId,
    );
    const recovered = await restore(second, floorOf(first.anchor));
    expect(readPageDoc(recovered)).toEqual(para("B"));
    expect(recovered.getMap("aux").get("binary")).toEqual(new Uint8Array([9, 0, 255]));
    expect(await counts(db)).toEqual({ heads: 1, blobs: 2, jobs: 2 });
    expect(Object.keys(second).sort()).toEqual(["anchor", "bundle", "kind"]);
    expect(JSON.stringify(second.bundle)).not.toContain(target.pageId);
    expect(JSON.stringify(second.bundle)).not.toContain("receiptSalt");
    expect(await p.acknowledge(target, first.anchor.bundleDigest)).toBe(false);
    expect(await p.acknowledge(target, second.anchor.bundleDigest)).toBe(true);
  });

  it("confirms exact same source/fence/head without resealing, including after losing the COMMIT reply", async () => {
    const { db, file } = await setup(),
      p = await publisher(db);
    p.hooks.afterCommit = () => {
      throw new Error("private lost-ack fixture detail");
    };
    await expect(p.publish()).rejects.toMatchObject({
      code: "commit-unknown",
      message: "Room owner publication: commit-unknown",
    });
    const snapshot = await p.store.read(target);
    if (snapshot.kind !== "ready" || !snapshot.head) throw new Error("missing fixture head");
    await db.close();
    p.api.close();
    const reopened = await connect(file),
      fresh = await publisher(reopened);
    const encrypt = vi.spyOn(crypto.subtle, "encrypt");
    const retry = await fresh.publish();
    expect(retry.kind).toBe("reused");
    expect(retry.anchor).toEqual(snapshot.head.anchor);
    expect(retry.bundle.checkpoint.ciphertext).toEqual(snapshot.head.bundle.checkpoint.ciphertext);
    expect(encrypt).not.toHaveBeenCalled();
    retry.bundle.checkpoint.ciphertext.fill(0);
    expect((await fresh.publish()).bundle.checkpoint.ciphertext).toEqual(
      snapshot.head.bundle.checkpoint.ciphertext,
    );
    expect(await counts(reopened)).toEqual({ heads: 1, blobs: 1, jobs: 1 });
  });

  it.each(["blob", "head", "outbox"] as const)(
    "rolls back a mid-transaction %s failure and reopens the intact previous head",
    async (stage) => {
      const { db, file, source } = await setup(),
        p = await publisher(db),
        first = await p.publish();
      await compact(db, source, 2, await append(db, source, "B"));
      const table = `fixture_c1c_${stage}`,
        operation = stage === "head" ? "UPDATE" : "INSERT";
      await db.run(
        db.sql.unsafe(
          `CREATE TRIGGER fixture_abort BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'fixture write failure'); END`,
        ),
      );
      await expect(p.publish()).rejects.toMatchObject({ code: "commit-unknown" });
      await db.close();
      const reopened = await connect(file),
        q = await publisher(reopened);
      expect(await counts(reopened)).toEqual({ heads: 1, blobs: 1, jobs: 1 });
      expect(await reopened.run(reopened.sql`SELECT digest FROM fixture_c1c_head`)).toEqual([
        { digest: first.anchor.bundleDigest },
      ]);
      await reopened.run(reopened.sql`DROP TRIGGER fixture_abort`);
      expect((await q.publish()).anchor.checkpointVersion).toBe(2);
    },
  );

  it("serializes independent connections competing for one head and reuses the winner on retry", async () => {
    const { db, file } = await setup(),
      other = await connect(file);
    const a = await publisher(db),
      b = await publisher(other),
      entered = deferred<void>(),
      release = deferred<void>();
    a.hooks.beforeCommit = async () => {
      entered.resolve();
      await release.promise;
    };
    const pending = a.publish();
    const lost = expect(pending).rejects.toMatchObject({ code: "conflict" });
    try {
      await entered.promise;
      const won = await b.publish();
      release.resolve();
      await lost;
      const replay = await a.publish();
      expect(replay.kind).toBe("reused");
      expect(replay.bundle.checkpoint.ciphertext).toEqual(won.bundle.checkpoint.ciphertext);
      expect(await counts(db)).toEqual({ heads: 1, blobs: 1, jobs: 1 });
    } finally {
      release.resolve();
    }
  });

  it.each(["raw-state", "revision", "generation", "scope", "trash", "compacted-key", "through"])(
    "rejects changed %s between preparation and CAS",
    async (variant) => {
      const { db, source } = await setup(),
        p = await publisher(db);
      p.hooks.beforeCommit = async () => {
        if (variant === "raw-state") {
          applyPlateValue(source, para("unrecorded"), "fixture");
          await db.run(
            db.sql`UPDATE pages_realtime_docs SET state=${Y.encodeStateAsUpdate(source)}`,
          );
        }
        if (variant === "revision") await db.run(db.sql`UPDATE pages_documents SET revision=2`);
        if (variant === "generation")
          await db.run(db.sql`UPDATE pages_realtime_docs SET generation='new-g'`);
        if (variant === "scope")
          await db.run(db.sql`UPDATE pages_documents SET scope_key='project-space:other'`);
        if (variant === "trash")
          await db.run(db.sql`UPDATE pages_documents SET trashed_at='fixture'`);
        if (variant === "compacted-key")
          await db.run(
            db.sql`UPDATE pages_realtime_docs SET compacted_key='private-different-body'`,
          );
        if (variant === "through")
          await db.run(
            db.sql`UPDATE pages_realtime_docs SET compacted_through_sequence=1,next_sequence=2`,
          );
      };
      await expect(p.publish()).rejects.toMatchObject({ code: "cut-changed" });
      expect(await counts(db)).toEqual({ heads: 0, blobs: 0, jobs: 0 });
    },
  );

  it("rejects a replaced same-position committed source instead of treating it as an idempotent replay", async () => {
    const { db, source } = await setup(),
      p = await publisher(db),
      initial = await p.publish();
    applyPlateValue(source, para("changed"), "fixture");
    await db.run(db.sql`UPDATE pages_realtime_docs SET state=${Y.encodeStateAsUpdate(source)}`);
    await expect(p.publish()).rejects.toMatchObject({ code: "cut-changed" });
    expect(await db.run(db.sql`SELECT digest FROM fixture_c1c_head`)).toEqual([
      { digest: initial.anchor.bundleDigest },
    ]);
  });

  it("preserves a published head after fence rotation and rejects stale commit/ACK", async () => {
    const { db } = await setup(),
      old = await publisher(db),
      initial = await old.publish();
    old.hooks.beforeCommit = () =>
      db.run(db.sql`UPDATE fixture_c1c_grant SET fence=2`).then(() => undefined);
    await expect(old.publish()).rejects.toMatchObject({ code: "revoked" });
    expect(await old.acknowledge(target, initial.anchor.bundleDigest)).toBe(false);
    const fresh = await publisher(db, 2);
    const current = await fresh.publish();
    expect(current.kind).toBe("reused");
    expect(current.anchor).toEqual(initial.anchor);
    expect(await fresh.acknowledge({ ...target, fence: 2 }, current.anchor.bundleDigest)).toBe(
      true,
    );
    expect(await counts(db)).toEqual({ heads: 1, blobs: 1, jobs: 1 });
  });

  it("does not mint genesis for a known room with a missing head", async () => {
    const { db } = await setup(),
      p = await publisher(db);
    await p.publish();
    await db.run(db.sql`DELETE FROM fixture_c1c_head`);
    await expect(p.publish()).rejects.toMatchObject({ code: "owner-required" });
    expect(await counts(db)).toEqual({ heads: 0, blobs: 1, jobs: 1 });
  });

  it("rejects corrupted stored ciphertext or a mismatched private receipt", async () => {
    const { db } = await setup(),
      p = await publisher(db);
    await p.publish();
    const [row] = await db.run(
      db.sql<{
        ciphertext: Uint8Array;
        private_json: string;
      }>`SELECT ciphertext,private_json FROM fixture_c1c_blob`,
    );
    const changed = new Uint8Array(row!.ciphertext);
    changed[0] = changed[0]! ^ 1;
    await db.run(db.sql`UPDATE fixture_c1c_blob SET ciphertext=${changed}`);
    await expect(p.publish()).rejects.toMatchObject({ code: "invalid-head" });
    const parsed = JSON.parse(row!.private_json);
    parsed.source.rawStateDigest = "0".repeat(64);
    await db.run(
      db.sql`UPDATE fixture_c1c_blob SET ciphertext=${row!.ciphertext},private_json=${JSON.stringify(parsed)}`,
    );
    await expect(p.publish()).rejects.toMatchObject({ code: "invalid-head" });
  });
});

describe("owner source, capability and budget", () => {
  it("reads only the correct scope/generation/version and keeps oversized SQLite BLOBs out of the cut", async () => {
    const { db } = await setup();
    const locator = {
      pageId: target.pageId,
      scopeKey: target.scopeKey,
      generation: room.documentGeneration,
    };
    expect((await db.run(readPageRoomCommittedCut(db.sql, locator))).kind).toBe("ready");
    expect(
      (
        await db.run(
          readPageRoomCommittedCut(db.sql, { ...locator, scopeKey: "project-space:other" }),
        )
      ).kind,
    ).toBe("cut-not-ready");
    await db.run(db.sql`UPDATE pages_realtime_docs SET state=zeroblob(${cap + 1})`);
    expect(await db.run(readPageRoomCommittedCut(db.sql, locator))).toEqual({
      kind: "over-budget",
    });
    await expect((await publisher(db)).publish()).rejects.toMatchObject({ code: "over-budget" });
    expect(await counts(db)).toEqual({ heads: 0, blobs: 0, jobs: 0 });
  });

  it("charges metadata/vector overhead before sealing a near-limit state", async () => {
    const { db } = await setup(),
      large = doc();
    large.getMap("bin").set("value", new Uint8Array(262038));
    const raw = Y.encodeStateAsUpdate(large);
    expect(raw.byteLength).toBeGreaterThan(cap - 160);
    expect(raw.byteLength).toBeLessThanOrEqual(cap);
    await db.run(db.sql`UPDATE pages_realtime_docs SET state=${raw}`);
    const p = await publisher(db),
      cryptoCall = vi.spyOn(crypto.subtle, "encrypt");
    await expect(p.publish()).rejects.toMatchObject({ code: "over-budget" });
    expect(cryptoCall).not.toHaveBeenCalled();
    expect(await counts(db)).toEqual({ heads: 0, blobs: 0, jobs: 0 });
  });

  it.each(["missing-struct", "missing-delete", "malformed"])(
    "rejects a non-closed %s Yjs source before publication",
    async (variant) => {
      const { db } = await setup(),
        incomplete = doc(),
        text = incomplete.getText("x");
      text.insert(0, "x");
      const before = Y.encodeStateVector(incomplete);
      if (variant === "missing-struct") text.insert(1, "y");
      else text.delete(0, 1);
      const raw =
        variant === "malformed" ? Uint8Array.of(255) : Y.encodeStateAsUpdate(incomplete, before);
      await db.run(db.sql`UPDATE pages_realtime_docs SET state=${raw}`);
      await expect((await publisher(db)).publish()).rejects.toMatchObject({ code: "invalid-cut" });
      expect(await counts(db)).toEqual({ heads: 0, blobs: 0, jobs: 0 });
    },
  );

  it("holds the single publication slot until canceled native hash work settles", async () => {
    const { db } = await setup(),
      p = await publisher(db),
      started = deferred<void>(),
      done = deferred<ArrayBuffer>(),
      signal = new AbortController();
    const hash = vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(() => {
      started.resolve();
      return done.promise;
    });
    const abandoned = expect(p.publish(signal.signal)).rejects.toMatchObject({ code: "aborted" });
    await started.promise;
    signal.abort();
    await expect(p.publish()).rejects.toMatchObject({ code: "busy" });
    expect(hash).toHaveBeenCalledTimes(1);
    done.resolve(new ArrayBuffer(32));
    await abandoned;
    expect(await counts(db)).toEqual({ heads: 0, blobs: 0, jobs: 0 });
    expect((await p.publish()).kind).toBe("published");
  });

  it.each(["provider-throws", "wrong-room", "key-logout"])(
    "keeps %s outside the store and redacts private owner errors",
    async (variant) => {
      const { db } = await setup(),
        p = await publisher(db);
      if (variant === "provider-throws")
        p.capture.mockImplementationOnce(() => {
          const error = new RoomOwnerPublicationError("conflict");
          error.message = "private fixture diagnostic";
          error.cause = "private cause";
          throw error;
        });
      else
        p.capture.mockReturnValueOnce({
          target: { ...target, room: variant === "wrong-room" ? { ...room, keyEpoch: 2 } : room },
          revoked: p.revoked.signal,
          assertCurrent() {
            if (variant === "key-logout") p.keys.revoke.abort();
          },
          release: p.release,
        });
      const result = await p.publish().catch((error: unknown) => error);
      const code = variant === "key-logout" ? "revoked" : "owner-required";
      expect(result).toMatchObject({ code, message: `Room owner publication: ${code}` });
      expect(result).not.toHaveProperty("cause");
      expect(await counts(db)).toEqual({ heads: 0, blobs: 0, jobs: 0 });
    },
  );

  it("rejects foreign/copy leases and a late revoked owner generation", async () => {
    const { db } = await setup(),
      p = await publisher(db),
      other = await publisher(db);
    await expect(p.api.publish({ ...p.lease } as typeof p.lease)).rejects.toMatchObject({
      code: "invalid-lease",
    });
    await expect(p.api.publish(other.lease)).rejects.toMatchObject({ code: "invalid-lease" });
    p.hooks.beforeCommit = async () => {
      p.revoked.abort();
    };
    await expect(p.publish()).rejects.toMatchObject({ code: "revoked" });
    expect(await counts(db)).toEqual({ heads: 0, blobs: 0, jobs: 0 });
  });
});
