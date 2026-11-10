import { createRequire } from "node:module";
import * as Y from "yjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoomEnvelopeAuthority, type RoomKeyProvider } from "./roomEnvelope";
import {
  createRoomRecoveryAuthority,
  type RecoveryAnchorProvider,
  type RecoveryAdmission,
  type VerifiedRecoveryCandidate,
} from "./roomRecoveryBundle";
import {
  RECOVERY_FORMAT,
  RoomRecoveryError,
  bundleDigestInput,
  encodeRecoveryPayload,
  entryDigestInput,
  frameDigestInput,
  stateDigestInput,
  type RecoveryAnchor,
  type RecoveryBundle,
  type RecoveryFloor,
  type RecoveryPayloadContext,
  type RecoveryTailEntry,
} from "./roomRecoveryProtocol";

const room = {
  tenantRef: "fixture-tenant",
  roomId: "fixture-room",
  documentGeneration: "g1",
  keyEpoch: 1,
};
const prefix = "0".repeat(64);
const cleanups: Array<() => void> = [];
function doc() {
  const d = new Y.Doc({ gc: false });
  cleanups.push(() => d.destroy());
  return d;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function hash(bytes: Uint8Array<ArrayBuffer>) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
function fixtureKeys(seed = 7) {
  const key = crypto.subtle.importKey("raw", new Uint8Array(32).fill(seed), "HKDF", false, [
    "deriveKey",
  ]);
  const signal = new AbortController();
  const release = vi.fn();
  const request: RoomKeyProvider["request"] = () => ({
    key,
    revoked: signal.signal,
    assertCurrent() {
      if (signal.signal.aborted) throw new Error("private fixture key state");
    },
    release,
  });
  return { request, release, revoke: () => signal.abort() };
}
function fixtureAnchors(anchor: RecoveryAnchor | null, floor: RecoveryFloor | null = null) {
  let generation = 0;
  const signals = new Set<AbortController>();
  const release = vi.fn();
  const capture = vi.fn<RecoveryAnchorProvider["capture"]>(() => {
    if (!anchor) return null;
    const current = generation,
      revoked = new AbortController();
    signals.add(revoked);
    return {
      anchor,
      floor,
      revoked: revoked.signal,
      assertCurrent() {
        if (generation !== current) throw new Error("private fixture anchor state");
      },
      release() {
        signals.delete(revoked);
        release();
      },
    };
  });
  return {
    capture,
    release,
    refresh() {
      /* same subject/token refresh */
    },
    revoke(notify = true) {
      generation++;
      if (notify) for (const signal of signals) signal.abort();
    },
    advance(next: RecoveryAnchor, nextFloor: RecoveryFloor) {
      generation++;
      for (const signal of signals) signal.abort();
      anchor = next;
      floor = nextFloor;
    },
  };
}
function history() {
  const owner = doc();
  owner.getText("body").insert(0, "ABC");
  const checkpoint = Y.encodeStateAsUpdate(owner),
    vector = Y.encodeStateVector(owner);
  const a = doc(),
    b = doc();
  Y.applyUpdate(a, checkpoint);
  Y.applyUpdate(b, checkpoint);
  a.getText("body").delete(1, 1); // Delete-only: the state vector is unchanged.
  b.getText("body").insert(3, "-peer");
  const tail = [Y.encodeStateAsUpdate(a, vector), Y.encodeStateAsUpdate(b, vector)];
  for (const update of tail) Y.applyUpdate(owner, update);
  return {
    checkpoint,
    vector,
    tail,
    final: Y.encodeStateAsUpdate(owner),
    body: owner.getText("body").toString(),
  };
}
async function anchorFor(bundle: RecoveryBundle, final: Uint8Array) {
  const checkpointDigest = await hash(frameDigestInput(bundle.checkpoint));
  const digests: string[] = [];
  for (const entry of bundle.tail)
    digests.push(
      await hash(entryDigestInput(bundle, entry, await hash(frameDigestInput(entry.frame)))),
    );
  return {
    format: RECOVERY_FORMAT,
    room: bundle.room,
    checkpointId: bundle.checkpointId,
    checkpointVersion: bundle.checkpointVersion,
    coveredCommitIndex: bundle.coveredCommitIndex,
    coveredCommitDigest: bundle.coveredCommitDigest,
    checkpointDigest,
    tailEndCommitIndex: bundle.coveredCommitIndex + bundle.tail.length,
    tailHeadDigest: digests.at(-1) ?? bundle.coveredCommitDigest,
    bundleDigest: await hash(bundleDigestInput(bundle, checkpointDigest, digests)),
    finalStateDigest: await hash(stateDigestInput(final)),
  } satisfies RecoveryAnchor;
}
async function sealed(
  options: {
    data?: ReturnType<typeof history>;
    checkpointPayload?: (
      context: RecoveryPayloadContext,
      update: Uint8Array,
      vector: Uint8Array,
    ) => Uint8Array;
    tailPayload?: (context: RecoveryPayloadContext, update: Uint8Array) => Uint8Array;
  } = {},
) {
  const data = options.data ?? history();
  const sender = createRoomEnvelopeAuthority(fixtureKeys());
  cleanups.push(() => sender.close());
  const lease = await sender.acquireRoom(room);
  const cpWriter = await sender.createWriter(lease, "fixture-owner", "checkpoint");
  const tailWriter = await sender.createWriter(lease, "fixture-owner", "owner-log");
  const checkpointId = "checkpoint-7",
    checkpointVersion = 7,
    coveredCommitIndex = 10;
  const common = { checkpointId, checkpointVersion };
  const cpContext = {
    ...common,
    kind: "checkpoint" as const,
    commitIndex: coveredCommitIndex,
    previousDigest: prefix,
  };
  const checkpoint = await cpWriter.seal(
    "checkpoint",
    (options.checkpointPayload ?? encodeRecoveryPayload)(cpContext, data.checkpoint, data.vector),
  );
  const tail: RecoveryTailEntry[] = [];
  const bundle: RecoveryBundle = {
    format: RECOVERY_FORMAT,
    room,
    ...common,
    coveredCommitIndex,
    coveredCommitDigest: prefix,
    checkpoint,
    tail,
  };
  let previousDigest = prefix;
  for (const [i, update] of data.tail.entries()) {
    const commitIndex = coveredCommitIndex + i + 1;
    const context = { ...common, kind: "committed-update" as const, commitIndex, previousDigest };
    const frame = await tailWriter.seal(
      "committed-update",
      (options.tailPayload ?? encodeRecoveryPayload)(context, update),
    );
    const entry = { commitIndex, previousDigest, frame };
    tail.push(entry);
    previousDigest = await hash(
      entryDigestInput(bundle, entry, await hash(frameDigestInput(frame))),
    );
  }
  return { bundle, anchor: await anchorFor(bundle, data.final), data };
}
async function local(anchor: RecoveryAnchor | null, floor: RecoveryFloor | null = null, seed = 7) {
  const keys = fixtureKeys(seed),
    anchors = fixtureAnchors(anchor, floor);
  const authority = createRoomRecoveryAuthority(keys, anchors);
  cleanups.push(() => authority.close());
  const lease = await authority.acquireRoom(room);
  return {
    keys,
    anchors,
    authority,
    lease,
    open() {
      return authority.openVerifier(authority.admit(lease));
    },
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) close();
});

describe("trusted recovery admission and bounded history", () => {
  it("uses length-framed full ciphertext and purpose-separated canonical digest inputs", async () => {
    const f = await sealed(),
      cp = f.bundle.checkpoint;
    const encoded = frameDigestInput(cp),
      parts: Uint8Array[] = [];
    for (let at = 0; at < encoded.length; ) {
      const size = new DataView(encoded.buffer, encoded.byteOffset + at, 4).getUint32(0, false);
      at += 4;
      parts.push(encoded.slice(at, at + size));
      at += size;
    }
    expect(parts).toHaveLength(3);
    expect(JSON.parse(new TextDecoder().decode(parts[0]))).toEqual(["moss-room-recovery-frame", 1]);
    expect(JSON.parse(new TextDecoder().decode(parts[1]))).toEqual([
      "moss-page-room-envelope",
      1,
      "A256GCM-HKDF-SHA256",
      room.tenantRef,
      room.roomId,
      room.documentGeneration,
      room.keyEpoch,
      cp.stream.senderRef,
      cp.stream.streamId,
      "checkpoint",
      0,
      "checkpoint",
    ]);
    expect(parts[2]).toEqual(cp.ciphertext);
    const entry = f.bundle.tail[0]!,
      frameHash = await hash(frameDigestInput(entry.frame));
    expect(
      JSON.parse(new TextDecoder().decode(entryDigestInput(f.bundle, entry, frameHash))),
    ).toEqual([
      "moss-room-recovery-entry",
      1,
      JSON.stringify([room.tenantRef, room.roomId, room.documentGeneration, room.keyEpoch]),
      f.bundle.checkpointId,
      f.bundle.checkpointVersion,
      entry.commitIndex,
      entry.previousDigest,
      frameHash,
    ]);
    const state = stateDigestInput(f.data.final),
      firstLength = new DataView(state.buffer).getUint32(0, false);
    expect(JSON.parse(new TextDecoder().decode(state.subarray(4, 4 + firstLength)))).toEqual([
      "moss-room-recovery-full-state",
      1,
      RECOVERY_FORMAT,
    ]);
  });

  it("pins Yjs version/gc and reconstructs concurrent inserts/deletes with real encryption", async () => {
    const require = createRequire(import.meta.url);
    expect(require("yjs/package.json").version).toBe("13.6.33");
    const f = await sealed(),
      r = await local(f.anchor);
    const verifier = r.open();
    const candidate = await verifier.prepare(f.bundle);
    const staged = candidate.update;
    expect(staged).toEqual(f.data.final);
    staged.fill(0);
    r.anchors.refresh();
    const taken = verifier.take(candidate);
    expect(taken.update).toEqual(f.data.final);
    expect(taken.anchor).toEqual(f.anchor);
    const restored = doc();
    Y.applyUpdate(restored, taken.update);
    expect(restored.gc).toBe(false);
    expect(restored.getText("body").toString()).toBe("AC-peer");
    expect(() => verifier.take(candidate)).toThrowError("invalid-capability");
    expect(() => candidate.update).toThrowError("invalid-capability");
  });

  it("accepts a real checkpoint with an empty tail only at its exact coverage", async () => {
    const data = history();
    data.tail = [];
    data.final = data.checkpoint;
    const f = await sealed({ data }),
      r = await local(f.anchor),
      verifier = r.open();
    expect(verifier.take(await verifier.prepare(f.bundle)).update).toEqual(data.checkpoint);
    const wrong = await local({ ...f.anchor, tailHeadDigest: "f".repeat(64) });
    await expect(wrong.open().prepare(f.bundle)).rejects.toMatchObject({ code: "digest-mismatch" });
  });

  it("preserves Yjs binary values when clearing temporary authenticated payload buffers", async () => {
    const source = doc(),
      binary = new Uint8Array([13, 0, 255, 23]);
    source.getMap("values").set("binary", binary);
    const checkpoint = Y.encodeStateAsUpdate(source);
    const f = await sealed({
      data: {
        checkpoint,
        vector: Y.encodeStateVector(source),
        tail: [],
        final: checkpoint,
        body: "",
      },
    });
    const v = (await local(f.anchor)).open(),
      restored = doc();
    Y.applyUpdate(restored, v.take(await v.prepare(f.bundle)).update);
    expect(restored.getMap("values").get("binary")).toEqual(binary);
  });

  it("requires a current trusted anchor; a missing relay bundle needs its owner", async () => {
    const f = await sealed(),
      missing = await local(null);
    expect(() => missing.open()).toThrowError("anchor-required");
    const r = await local(f.anchor);
    await expect(r.open().prepare(null)).rejects.toMatchObject({ code: "owner-required" });
  });

  it.each(["rollback-version", "rollback-index", "fork", "wrong-room"])(
    "rejects trusted floor conflict %s",
    async (variant) => {
      const f = await sealed();
      const floor: RecoveryFloor = {
        room: variant === "wrong-room" ? { ...room, roomId: "other" } : room,
        checkpointId: f.anchor.checkpointId,
        checkpointDigest: f.anchor.checkpointDigest,
        commitDigest: f.anchor.tailHeadDigest,
        checkpointVersion: f.anchor.checkpointVersion + Number(variant === "rollback-version"),
        commitIndex: f.anchor.tailEndCommitIndex + Number(variant === "rollback-index"),
        bundleDigest: variant === "fork" ? "f".repeat(64) : f.anchor.bundleDigest,
      };
      const r = await local(f.anchor, floor);
      expect(() => r.open()).toThrowError(
        variant === "fork" ? "fork" : variant === "wrong-room" ? "binding-mismatch" : "rollback",
      );
      expect(r.anchors.release).toHaveBeenCalledTimes(1);
    },
  );

  it("accepts tail advancement from the exact seen prefix but rejects a replaced checkpoint or prefix", async () => {
    const f = await sealed(),
      partial = { ...f.bundle, tail: f.bundle.tail.slice(0, 1) };
    const prefixDoc = doc();
    Y.applyUpdate(prefixDoc, f.data.checkpoint);
    Y.applyUpdate(prefixDoc, f.data.tail[0]!);
    const prefixUpdate = Y.encodeStateAsUpdate(prefixDoc),
      earlier = await anchorFor(partial, prefixUpdate);
    const floor: RecoveryFloor = {
      room,
      checkpointId: earlier.checkpointId,
      checkpointVersion: earlier.checkpointVersion,
      checkpointDigest: earlier.checkpointDigest,
      commitIndex: earlier.tailEndCommitIndex,
      commitDigest: earlier.tailHeadDigest,
      bundleDigest: earlier.bundleDigest,
    };
    const r = await local(earlier),
      previous = r.open();
    const derive = vi.spyOn(crypto.subtle, "deriveKey");
    expect(previous.take(await previous.prepare(partial)).update).toEqual(prefixUpdate);
    expect(derive).toHaveBeenCalledTimes(2);
    r.anchors.advance(f.anchor, floor);
    const v = r.open();
    expect(v.take(await v.prepare(f.bundle)).update).toEqual(f.data.final);
    expect(derive).toHaveBeenCalledTimes(2); // same real admissions, no empty-window reopen
    const changed = await local(f.anchor, { ...floor, checkpointDigest: "f".repeat(64) });
    expect(() => changed.open()).toThrowError("fork");
    const fork = (await local(f.anchor, { ...floor, commitDigest: "f".repeat(64) })).open();
    await expect(fork.prepare(f.bundle)).rejects.toMatchObject({ code: "fork" });
  });

  it("requires a newer checkpoint to cover the floor and match its exact digest at the boundary", async () => {
    const f = await sealed();
    const floor: RecoveryFloor = {
      room,
      checkpointId: "previous-checkpoint",
      checkpointVersion: f.anchor.checkpointVersion - 1,
      checkpointDigest: "d".repeat(64),
      commitIndex: f.anchor.coveredCommitIndex,
      commitDigest: f.anchor.coveredCommitDigest,
      bundleDigest: "e".repeat(64),
    };
    const accepted = (await local(f.anchor, floor)).open();
    expect(accepted.take(await accepted.prepare(f.bundle)).update).toEqual(f.data.final);
    const fork = await local(f.anchor, { ...floor, commitDigest: "f".repeat(64) });
    expect(() => fork.open()).toThrowError("fork");
    const behind = await local(f.anchor, { ...floor, commitIndex: floor.commitIndex + 1 });
    expect(() => behind.open()).toThrowError("rollback");
  });

  it("rejects copied and foreign admissions/candidates; allows one verifier and held candidate", async () => {
    const f = await sealed(),
      a = await local(f.anchor),
      b = await local(f.anchor);
    const admission = a.authority.admit(a.lease);
    expect(() => a.authority.openVerifier({ ...admission } as RecoveryAdmission)).toThrowError(
      "invalid-capability",
    );
    expect(() => b.authority.openVerifier(admission)).toThrowError("invalid-capability");
    const verifier = a.authority.openVerifier(admission);
    expect(() => a.authority.openVerifier(admission)).toThrowError("invalid-capability");
    const held = await verifier.prepare(f.bundle);
    expect(() => verifier.take({ update: held.update } as VerifiedRecoveryCandidate)).toThrowError(
      "invalid-capability",
    );
    await expect(verifier.prepare(f.bundle)).rejects.toMatchObject({ code: "busy" });
    verifier.discard(held);
    expect(() => held.update).toThrowError("invalid-capability");
    expect(verifier.take(await verifier.prepare(f.bundle)).update).toEqual(f.data.final);
  });

  it.each([
    "missing-middle",
    "missing-tail",
    "duplicate",
    "reorder",
    "gap",
    "wrong-prev",
    "wrong-coverage",
    "cross-checkpoint",
    "cross-epoch",
    "cross-generation",
  ])("rejects %s before any historical decrypt", async (variant) => {
    const f = await sealed(),
      r = await local(f.anchor),
      v = r.open();
    const raw = structuredClone(f.bundle);
    const tail = [...raw.tail];
    let invalid: RecoveryBundle = { ...raw, tail };
    if (variant === "missing-middle") tail.shift();
    if (variant === "missing-tail") tail.pop();
    if (variant === "duplicate") tail[1] = tail[0]!;
    if (variant === "reorder") tail.reverse();
    if (variant === "gap") tail[1] = { ...tail[1]!, commitIndex: 99 };
    if (variant === "wrong-prev") tail[1] = { ...tail[1]!, previousDigest: prefix };
    if (variant === "wrong-coverage") invalid = { ...invalid, coveredCommitIndex: 8 };
    if (variant === "cross-checkpoint") invalid = { ...invalid, checkpointId: "different" };
    if (variant === "cross-epoch") invalid = { ...invalid, room: { ...room, keyEpoch: 2 } };
    if (variant === "cross-generation")
      invalid = { ...invalid, room: { ...room, documentGeneration: "g2" } };
    const decrypt = vi.spyOn(crypto.subtle, "decrypt");
    await expect(v.prepare(invalid)).rejects.toBeInstanceOf(RoomRecoveryError);
    expect(decrypt).not.toHaveBeenCalled();
    const good = await v.prepare(f.bundle);
    expect(v.take(good).update).toEqual(f.data.final);
  });

  it("rejects altered ciphertext under the old anchor, and bad AEAD even under matching fixture hashes", async () => {
    const f = await sealed();
    const altered = structuredClone(f.bundle);
    altered.checkpoint.ciphertext[0] = altered.checkpoint.ciphertext[0]! ^ 1;
    const r = await local(f.anchor);
    await expect(r.open().prepare(altered)).rejects.toMatchObject({ code: "digest-mismatch" });
    const reanchored = await local(await anchorFor(altered, f.data.final));
    await expect(reanchored.open().prepare(altered)).rejects.toMatchObject({
      code: "authentication-failed",
    });
    const wrongKey = await local(f.anchor, null, 8);
    await expect(wrongKey.open().prepare(f.bundle)).rejects.toMatchObject({
      code: "authentication-failed",
    });
  });

  it("copies all caller buffers before first digest, including later tail ciphertext", async () => {
    const f = await sealed(),
      r = await local(f.anchor),
      v = r.open();
    const input = structuredClone(f.bundle);
    const pending = v.prepare(input);
    input.checkpoint.ciphertext.fill(0);
    for (const entry of input.tail) entry.frame.ciphertext.fill(0);
    expect(v.take(await pending).update).toEqual(f.data.final);
  });

  it.each([
    "unknown-field",
    "tail-getter",
    "sparse",
    "too-many",
    "total-bytes",
    "noncanonical-digest",
  ])("rejects malformed/over-budget %s before native hash", async (variant) => {
    const f = await sealed(),
      r = await local(f.anchor),
      v = r.open();
    let input: unknown = f.bundle;
    let calls = 0;
    if (variant === "unknown-field") input = { ...f.bundle, extra: 1 };
    if (variant === "tail-getter") {
      const tail = [...f.bundle.tail];
      Object.defineProperty(tail, "0", {
        get() {
          calls++;
          return f.bundle.tail[0];
        },
      });
      input = { ...f.bundle, tail };
    }
    if (variant === "sparse") input = { ...f.bundle, tail: new Array(2) };
    if (variant === "too-many") input = { ...f.bundle, tail: Array(17).fill(f.bundle.tail[0]) };
    if (variant === "total-bytes") {
      const entry = f.bundle.tail[0]!;
      input = {
        ...f.bundle,
        tail: Array(16).fill({
          ...entry,
          frame: { ...entry.frame, ciphertext: new Uint8Array(256 * 1024 + 16) },
        }),
      };
    }
    if (variant === "noncanonical-digest")
      input = { ...f.bundle, coveredCommitDigest: "F".repeat(64) };
    const native = vi.spyOn(crypto.subtle, "digest");
    await expect(v.prepare(input as RecoveryBundle)).rejects.toMatchObject({
      code: variant === "too-many" || variant === "total-bytes" ? "over-budget" : "invalid-bundle",
    });
    expect(calls).toBe(0);
    expect(native).not.toHaveBeenCalled();
  });

  it.each(["single", "aggregate"])(
    "rejects %s underreported typed-array bytes before any ciphertext copy or hash",
    async (variant) => {
      const f = await sealed(),
        v = (await local(f.anchor)).open();
      const source = new Uint8Array(256 * 1024 + (variant === "single" ? 17 : 16));
      let propertyReads = 0,
        copies = 0;
      Object.defineProperties(source, {
        byteLength: {
          get() {
            propertyReads++;
            return 1;
          },
        },
        length: {
          get() {
            propertyReads++;
            return 1;
          },
        },
        buffer: {
          get() {
            propertyReads++;
            return new ArrayBuffer(1);
          },
        },
      });
      const entry = f.bundle.tail[0]!;
      const input =
        variant === "single"
          ? { ...f.bundle, checkpoint: { ...f.bundle.checkpoint, ciphertext: source } }
          : {
              ...f.bundle,
              tail: Array(16).fill({ ...entry, frame: { ...entry.frame, ciphertext: source } }),
            };
      const inputs = new Set([
        source,
        f.bundle.checkpoint.ciphertext,
        ...f.bundle.tail.map((e) => e.frame.ciphertext),
      ]);
      vi.stubGlobal(
        "Uint8Array",
        new Proxy(Uint8Array, {
          construct(target, args, newTarget) {
            if (inputs.has(args[0])) copies++;
            return Reflect.construct(target, args, newTarget);
          },
        }),
      );
      const native = vi.spyOn(crypto.subtle, "digest");
      try {
        await expect(v.prepare(input)).rejects.toMatchObject({
          code: variant === "single" ? "invalid-bundle" : "over-budget",
        });
      } finally {
        vi.unstubAllGlobals();
      }
      expect(propertyReads).toBe(0);
      expect(copies).toBe(0);
      expect(native).not.toHaveBeenCalled();
    },
  );

  it("charges the real bytes of owner-side payload and state digest framing", () => {
    const input = new Uint8Array(256 * 1024 + 1);
    Object.defineProperty(input, "byteLength", { value: 1 });
    expect(() =>
      encodeRecoveryPayload(
        {
          kind: "committed-update",
          checkpointId: "cp",
          checkpointVersion: 1,
          commitIndex: 1,
          previousDigest: prefix,
        },
        input,
      ),
    ).toThrowError("over-budget");
    const state = new Uint8Array(4 * 1024 * 1024 + 1);
    Object.defineProperty(state, "byteLength", { value: 1 });
    expect(() => stateDigestInput(state)).toThrowError("over-budget");
  });
});

describe("recovery state, cancellation and publication boundaries", () => {
  it("does not accept matching state vectors when a deletion is missing", async () => {
    const data = history(),
      actual = doc(),
      deleted = doc();
    Y.applyUpdate(actual, data.checkpoint);
    Y.applyUpdate(deleted, data.checkpoint);
    Y.applyUpdate(deleted, data.tail[0]!);
    expect(Y.encodeStateVector(actual)).toEqual(Y.encodeStateVector(deleted));
    expect(Y.encodeStateAsUpdate(actual)).not.toEqual(Y.encodeStateAsUpdate(deleted));
    const f = await sealed({ data: { ...data, tail: [], final: Y.encodeStateAsUpdate(deleted) } });
    await expect((await local(f.anchor)).open().prepare(f.bundle)).rejects.toMatchObject({
      code: "digest-mismatch",
    });
  });

  it("rejects a causal tail missing its prerequisite even if Yjs temporarily queues it", async () => {
    const data = history(),
      peer = doc();
    Y.applyUpdate(peer, data.checkpoint);
    peer.getText("body").insert(3, "x");
    const beforeSecond = Y.encodeStateVector(peer);
    peer.getText("body").insert(4, "y");
    const missing = {
      ...data,
      tail: [Y.encodeStateAsUpdate(peer, beforeSecond)],
      final: Y.encodeStateAsUpdate(peer),
    };
    const f = await sealed({ data: missing });
    await expect((await local(f.anchor)).open().prepare(f.bundle)).rejects.toMatchObject({
      code: "digest-mismatch",
    });
  });

  it.each([
    "wrong-vector",
    "malformed-yjs",
    "wrong-inner-metadata",
    "trailing-payload",
    "truncated-length",
  ])("rejects authenticated %s without publishing a candidate", async (variant) => {
    const f = await sealed({
      checkpointPayload(context, update, vector) {
        if (variant === "wrong-vector")
          return encodeRecoveryPayload(context, update, new Uint8Array([0]));
        if (variant === "malformed-yjs")
          return encodeRecoveryPayload(context, new Uint8Array([255]), vector);
        if (variant === "wrong-inner-metadata")
          return encodeRecoveryPayload({ ...context, checkpointId: "other" }, update, vector);
        const good = encodeRecoveryPayload(context, update, vector);
        return variant === "trailing-payload"
          ? new Uint8Array([...good, 1])
          : good.subarray(0, good.length - 1);
      },
    });
    const r = await local(f.anchor),
      v = r.open();
    await expect(v.prepare(f.bundle)).rejects.toMatchObject({
      code:
        variant === "wrong-vector" || variant === "malformed-yjs"
          ? "invalid-yjs"
          : "invalid-history",
    });
    expect(() => v.take({} as VerifiedRecoveryCandidate)).toThrowError("invalid-capability");
  });

  it("retains the single verification/hash slot after abort until native SHA-256 actually settles", async () => {
    const f = await sealed(),
      r = await local(f.anchor),
      v = r.open();
    const done = deferred<ArrayBuffer>();
    const native = vi.spyOn(crypto.subtle, "digest").mockReturnValueOnce(done.promise);
    const cancel = new AbortController();
    const pending = v.prepare(f.bundle, cancel.signal);
    const canceled = expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(native).toHaveBeenCalledTimes(1);
    cancel.abort();
    for (let i = 0; i < 4; i++)
      await expect(v.prepare(f.bundle)).rejects.toMatchObject({ code: "busy" });
    expect(native).toHaveBeenCalledTimes(1);
    done.resolve(new ArrayBuffer(32));
    await canceled;
    expect(v.take(await v.prepare(f.bundle)).update).toEqual(f.data.final);
  });

  it("cannot close/re-admit to bypass an outstanding native hash or revive an old generation", async () => {
    const f = await sealed(),
      r = await local(f.anchor),
      v = r.open();
    const done = deferred<ArrayBuffer>();
    vi.spyOn(crypto.subtle, "digest").mockReturnValueOnce(done.promise);
    const rejected = expect(v.prepare(f.bundle)).rejects.toMatchObject({ code: "revoked" });
    r.anchors.revoke();
    r.anchors.revoke();
    expect(() => r.authority.admit(r.lease)).toThrowError("busy");
    done.resolve(new ArrayBuffer(32));
    await rejected;
    const next = r.open();
    expect(next.take(await next.prepare(f.bundle)).update).toEqual(f.data.final);
  });

  it.each(["key", "anchor", "silent-anchor", "operation-abort"])(
    "cannot take a stale candidate after %s",
    async (variant) => {
      const f = await sealed(),
        r = await local(f.anchor),
        v = r.open(),
        cancel = new AbortController();
      const candidate = await v.prepare(f.bundle, cancel.signal);
      if (variant === "key") r.keys.revoke();
      if (variant === "anchor") r.anchors.revoke();
      if (variant === "silent-anchor") r.anchors.revoke(false);
      if (variant === "operation-abort") cancel.abort();
      expect(() => candidate.update).toThrow();
      expect(() => v.take(candidate)).toThrow();
    },
  );

  it.each(["capture", "anchor-getter", "revoked-getter", "follow-hook", "assert-hook"])(
    "redacts synchronous anchor provider %s errors",
    async (variant) => {
      const f = await sealed(),
        r = await local(f.anchor);
      const privateError = new RoomRecoveryError("fork");
      privateError.message = "fixture private provider message";
      privateError.cause = "fixture private cause";
      const signal = new AbortController(),
        release = vi.fn();
      if (variant === "follow-hook")
        vi.spyOn(signal.signal, "addEventListener").mockImplementationOnce(() => {
          throw privateError;
        });
      r.anchors.capture.mockImplementationOnce(() => {
        if (variant === "capture") throw privateError;
        return {
          get anchor() {
            if (variant === "anchor-getter") throw privateError;
            return f.anchor;
          },
          floor: null,
          get revoked() {
            if (variant === "revoked-getter") throw privateError;
            return signal.signal;
          },
          assertCurrent() {
            if (variant === "assert-hook") throw privateError;
          },
          release,
        };
      });
      let error: unknown;
      try {
        r.open();
      } catch (caught) {
        error = caught;
      }
      const code =
        variant === "follow-hook" || variant === "assert-hook" ? "revoked" : "anchor-required";
      expect(error).toMatchObject({ code, message: `Room recovery: ${code}` });
      expect(error).not.toBe(privateError);
      expect(error).not.toHaveProperty("cause");
      expect(release).toHaveBeenCalledTimes(variant === "capture" ? 0 : 1);
    },
  );

  it("cannot return admission if its current check synchronously revokes the anchor", async () => {
    const f = await sealed(),
      r = await local(f.anchor);
    const controller = new AbortController(),
      release = vi.fn();
    r.anchors.capture.mockReturnValueOnce({
      anchor: f.anchor,
      floor: null,
      revoked: controller.signal,
      assertCurrent() {
        controller.abort();
      },
      release,
    });
    expect(() => r.open()).toThrowError("revoked");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("cannot take a candidate when the anchor check synchronously revokes the key lease", async () => {
    const f = await sealed(),
      r = await local(f.anchor);
    let logout = false;
    r.anchors.capture.mockReturnValueOnce({
      anchor: f.anchor,
      floor: null,
      revoked: new AbortController().signal,
      assertCurrent() {
        if (logout) r.keys.revoke();
      },
      release() {},
    });
    const v = r.open(),
      candidate = await v.prepare(f.bundle);
    logout = true;
    expect(() => v.take(candidate)).toThrowError("revoked");
  });

  it("redacts candidate-doc cleanup failure and releases the verification/candidate slots", async () => {
    const f = await sealed(),
      r = await local(f.anchor),
      v = r.open();
    const original = Y.Doc.prototype.destroy;
    vi.spyOn(Y.Doc.prototype, "destroy").mockImplementationOnce(function (this: Y.Doc) {
      original.call(this);
      throw new Error("private fixture cleanup diagnostic");
    });
    await expect(v.prepare(f.bundle)).rejects.toMatchObject({
      code: "invalid-yjs",
      message: "Room recovery: invalid-yjs",
    });
    expect(v.take(await v.prepare(f.bundle)).update).toEqual(f.data.final);
  });

  it("uses an opaque relay and swaps doc+floor only in a fixture-owned successful CAS", async () => {
    const f = await sealed();
    // These stubs model only the local test, not a production relay or database.
    let stored: RecoveryBundle | null = null;
    const relay = {
      save(value: RecoveryBundle) {
        stored = structuredClone(value);
      },
      load() {
        return structuredClone(stored);
      },
      drop() {
        stored = null;
      },
    };
    relay.save(f.bundle);
    let slot = { update: new Uint8Array([0]), digest: prefix };
    const old = slot;
    const cas = (expected: string, next: typeof slot, failBeforeSwap = false) => {
      if (slot.digest !== expected || failBeforeSwap) return false;
      slot = next;
      return true;
    };
    const r = await local(f.anchor),
      v = r.open();
    const verified = v.take(await v.prepare(relay.load()));
    const next = { update: verified.update, digest: verified.anchor.bundleDigest };
    expect(cas(prefix, next, true)).toBe(false);
    expect(slot).toBe(old);
    expect(cas(prefix, next)).toBe(true);
    expect(slot).toBe(next);
    expect(cas(prefix, old)).toBe(false);
    expect(slot).toBe(next);
    relay.drop();
    await expect(v.prepare(relay.load())).rejects.toMatchObject({ code: "owner-required" });
    expect(slot).toBe(next);
  });
});
