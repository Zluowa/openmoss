import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRoomEnvelopeAuthority,
  type RoomKeyProvider,
  type RoomKeyLease,
} from "./roomEnvelope";
import {
  RoomEnvelopeError,
  frameParameters,
  type RoomBinding,
  type RoomEnvelopeLimits,
  type SealedRoomFrame,
} from "./roomEnvelopeProtocol";

const room: RoomBinding = {
  tenantRef: "fixture-tenant",
  roomId: "fixture-room",
  documentGeneration: "g1",
  keyEpoch: 1,
};
const bytes = new TextEncoder().encode("local fixture payload");
const cleanups: Array<() => void> = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixtureKey(seed = 7) {
  // Public fixture bytes only. Never imported by production code.
  return crypto.subtle.importKey("raw", new Uint8Array(32).fill(seed), "HKDF", false, [
    "deriveKey",
  ]);
}
function fixtureProvider(key = fixtureKey()) {
  let epoch = 0;
  const signals = new Set<AbortController>();
  const releases = vi.fn();
  const request = vi.fn<RoomKeyProvider["request"]>(() => {
    const captured = epoch;
    const revoked = new AbortController();
    signals.add(revoked);
    return {
      key,
      revoked: revoked.signal,
      assertCurrent() {
        if (captured !== epoch) throw new Error("fixture generation changed");
      },
      release() {
        signals.delete(revoked);
        releases();
      },
    };
  });
  return {
    request,
    releases,
    refresh() {
      /* Same authenticated subject/generation, just a token refresh. */
    },
    revoke(notify = true) {
      epoch++;
      if (notify) for (const signal of signals) signal.abort();
    },
  };
}
function fixtureAuthority(provider = fixtureProvider(), limits: Partial<RoomEnvelopeLimits> = {}) {
  const authority = createRoomEnvelopeAuthority(provider, limits);
  cleanups.push(() => authority.close());
  return { authority, provider };
}
async function pair(limits: Partial<RoomEnvelopeLimits> = {}) {
  const sender = fixtureAuthority(undefined, limits);
  const recipient = fixtureAuthority(undefined, limits);
  const lease = await sender.authority.acquireRoom(room);
  const receiverLease = await recipient.authority.acquireRoom(room);
  const writer = await sender.authority.createWriter(lease, "device-a", "live-update");
  const receiver = await recipient.authority.createReceiver(receiverLease, writer.stream);
  return { ...sender, recipient, lease, receiverLease, writer, receiver };
}
function changed(frame: SealedRoomFrame, transform: (copy: SealedRoomFrame) => SealedRoomFrame) {
  return transform({
    ...frame,
    stream: { ...frame.stream, room: { ...frame.stream.room } },
    ciphertext: new Uint8Array(frame.ciphertext),
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0)) close();
});

describe("room envelope key capability and lifecycle", () => {
  it("refuses copied, forged and foreign authority leases before crypto", async () => {
    const { authority } = fixtureAuthority();
    const lease = await authority.acquireRoom(room);
    const other = fixtureAuthority();
    const derive = vi.spyOn(crypto.subtle, "deriveKey");
    for (const forged of [{ ...lease }, { binding: room, close() {} }, null, 4]) {
      await expect(
        authority.createWriter(forged as RoomKeyLease, "device-a", "live-update"),
      ).rejects.toMatchObject({ code: "invalid-lease" });
    }
    await expect(
      other.authority.createWriter(lease, "device-a", "live-update"),
    ).rejects.toMatchObject({ code: "invalid-lease" });
    expect(derive).not.toHaveBeenCalled();
  });

  it("copies room identity before awaiting a key and returns no key getter", async () => {
    const delay = deferred<CryptoKey>();
    const { authority } = fixtureAuthority(fixtureProvider(delay.promise));
    const input = { ...room };
    const pending = authority.acquireRoom(input);
    input.roomId = "changed-room";
    delay.resolve(await fixtureKey());
    const lease = await pending;
    expect(lease.binding.roomId).toBe(room.roomId);
    expect(Object.keys(lease).sort()).toEqual(["binding", "close"]);
    expect(Object.isFrozen(lease.binding)).toBe(true);
  });

  it("rejects missing keys without exposing provider details or generating replacements", async () => {
    const provider = fixtureProvider(Promise.reject(new Error("private fixture diagnostic")));
    const { authority } = fixtureAuthority(provider);
    const random = vi.spyOn(crypto, "getRandomValues");
    await expect(authority.acquireRoom(room)).rejects.toMatchObject({
      code: "key-unavailable",
      message: "Room envelope: key-unavailable",
    });
    expect(random).not.toHaveBeenCalled();
    expect(provider.releases).toHaveBeenCalledTimes(1);
  });

  it("refuses wrong algorithms and exportable keys", async () => {
    const key = crypto.subtle.importKey("raw", new Uint8Array(32), "AES-GCM", true, ["encrypt"]);
    const { authority, provider } = fixtureAuthority(fixtureProvider(key));
    await expect(authority.acquireRoom(room)).rejects.toMatchObject({ code: "key-unavailable" });
    expect(provider.releases).toHaveBeenCalledTimes(1);
  });

  it("redacts provider errors even when they reuse the envelope error class", async () => {
    const privateError = new RoomEnvelopeError("revoked");
    privateError.message = "fixture private provider diagnostic";
    privateError.cause = "fixture private cause";
    const { authority } = fixtureAuthority(fixtureProvider(Promise.reject(privateError)));
    const result = await authority.acquireRoom(room).catch((error: unknown) => error);
    expect(result).toMatchObject({
      code: "key-unavailable",
      message: "Room envelope: key-unavailable",
    });
    expect(result).not.toBe(privateError);
    expect(result).not.toHaveProperty("cause");
  });

  it.each(["key-getter", "revoked-getter", "follow-hook"])(
    "redacts synchronous %s errors and releases only settled acquisition quota",
    async (boundary) => {
      const { authority, provider } = fixtureAuthority(undefined, { pending: 1 });
      const keyGate = deferred<CryptoKey>();
      const release = vi.fn();
      const privateError = new RoomEnvelopeError("binding-mismatch");
      privateError.message = "fixture private synchronous diagnostic";
      privateError.cause = "fixture private synchronous cause";
      const revoked = new AbortController();
      if (boundary === "follow-hook") {
        vi.spyOn(revoked.signal, "addEventListener").mockImplementationOnce(() => {
          throw privateError;
        });
      }
      provider.request.mockReturnValueOnce({
        get key() {
          if (boundary === "key-getter") throw privateError;
          return keyGate.promise;
        },
        get revoked() {
          if (boundary === "revoked-getter") throw privateError;
          return revoked.signal;
        },
        assertCurrent() {},
        release,
      });
      const result = await authority.acquireRoom(room).catch((error: unknown) => error);
      expect(result).toMatchObject({
        code: "key-unavailable",
        message: "Room envelope: key-unavailable",
      });
      expect(result).not.toBe(privateError);
      expect(result).not.toHaveProperty("cause");
      expect(release).toHaveBeenCalledTimes(1);
      if (boundary !== "key-getter") {
        // A key promise was captured before the later provider hook failed.
        await expect(authority.acquireRoom(room)).rejects.toMatchObject({
          code: "budget-exceeded",
        });
        expect(provider.request).toHaveBeenCalledTimes(1);
      }
      keyGate.resolve(await fixtureKey());
      await new Promise<void>((resolve) => setImmediate(resolve));
      (await authority.acquireRoom(room)).close();
      expect(provider.request).toHaveBeenCalledTimes(2);
    },
  );

  it("cancels unresolved acquisition and releases exactly once", async () => {
    const delay = deferred<CryptoKey>();
    const { authority, provider } = fixtureAuthority(fixtureProvider(delay.promise));
    const abort = new AbortController();
    const result = authority.acquireRoom(room, abort.signal);
    const rejected = expect(result).rejects.toMatchObject({ code: "aborted" });
    abort.abort();
    await rejected;
    authority.close();
    delay.resolve(await fixtureKey());
    expect(provider.releases).toHaveBeenCalledTimes(1);
  });

  it("does not revive late A acquisition after A -> B -> A generation changes", async () => {
    const delay = deferred<CryptoKey>();
    const { authority, provider } = fixtureAuthority(fixtureProvider(delay.promise));
    const result = authority.acquireRoom(room);
    const rejected = expect(result).rejects.toMatchObject({ code: "revoked" });
    provider.revoke(false);
    provider.revoke(false);
    delay.resolve(await fixtureKey());
    await rejected;
    expect(provider.releases).toHaveBeenCalledTimes(1);
  });

  it("bounds canceled unresolved key requests until their underlying promises settle", async () => {
    const keyGate = deferred<CryptoKey>();
    const { authority, provider } = fixtureAuthority(fixtureProvider(keyGate.promise), {
      pending: 2,
    });
    for (let i = 0; i < 2; i++) {
      const cancel = new AbortController();
      const pending = authority.acquireRoom(room, cancel.signal);
      const rejected = expect(pending).rejects.toMatchObject({ code: "aborted" });
      cancel.abort();
      await rejected;
    }
    for (let i = 0; i < 5; i++) {
      await expect(authority.acquireRoom(room)).rejects.toMatchObject({ code: "budget-exceeded" });
    }
    expect(provider.request).toHaveBeenCalledTimes(2);
    expect(provider.releases).toHaveBeenCalledTimes(2);
    keyGate.resolve(await fixtureKey());
    await new Promise<void>((resolve) => setImmediate(resolve));
    const fresh = await authority.acquireRoom(room);
    expect(provider.request).toHaveBeenCalledTimes(3);
    fresh.close();
  });

  it("does not retain pending-key quota after synchronous provider failure", async () => {
    const { authority, provider } = fixtureAuthority(undefined, { pending: 1 });
    provider.request.mockImplementationOnce(() => {
      throw new Error("fixture request failure");
    });
    await expect(authority.acquireRoom(room)).rejects.toMatchObject({ code: "key-unavailable" });
    const lease = await authority.acquireRoom(room);
    expect(provider.request).toHaveBeenCalledTimes(2);
    lease.close();
  });

  it("releases malformed and already-revoked grants without leaking errors or quota", async () => {
    const { authority, provider } = fixtureAuthority(undefined, { pending: 1 });
    const release = vi.fn();
    const revoke = new AbortController();
    revoke.abort();
    provider.request.mockReturnValueOnce({
      key: Promise.resolve(await fixtureKey()),
      revoked: revoke.signal,
      assertCurrent() {},
      release,
    });
    await expect(authority.acquireRoom(room)).rejects.toMatchObject({ code: "revoked" });
    expect(release).toHaveBeenCalledTimes(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    provider.request.mockReturnValueOnce({
      get key(): Promise<CryptoKey> {
        throw new Error("fixture malformed grant");
      },
      revoked: new AbortController().signal,
      assertCurrent() {},
      release,
    });
    await expect(authority.acquireRoom(room)).rejects.toMatchObject({ code: "key-unavailable" });
    expect(release).toHaveBeenCalledTimes(2);
    (await authority.acquireRoom(room)).close();
  });

  it("keeps same-subject refresh working but revokes existing writers and prepared frames", async () => {
    const p = await pair();
    p.provider.refresh();
    const frame = await p.writer.seal("sync", bytes);
    const prepared = await p.receiver.prepare(frame);
    p.provider.revoke();
    await expect(p.writer.seal("sync", bytes)).rejects.toMatchObject({ code: "revoked" });
    p.recipient.provider.revoke();
    expect(() => prepared.commit()).toThrowError("revoked");
    expect(() => prepared.payload).toThrowError("revoked");
  });

  it("rechecks silent provider revocation before every operation and commit", async () => {
    const p = await pair();
    const prepared = await p.receiver.prepare(await p.writer.seal("sync", bytes));
    p.recipient.provider.revoke(false);
    expect(() => prepared.commit()).toThrowError("revoked");
    expect(p.recipient.provider.releases).toHaveBeenCalledTimes(1);
  });

  it("does not return a lease if its provider check synchronously revokes it", async () => {
    const { authority, provider } = fixtureAuthority();
    const revoked = new AbortController();
    const release = vi.fn();
    provider.request.mockReturnValueOnce({
      key: fixtureKey(),
      revoked: revoked.signal,
      assertCurrent() {
        revoked.abort();
      },
      release,
    });
    await expect(authority.acquireRoom(room)).rejects.toMatchObject({ code: "revoked" });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["checkpoint", "checkpoint"],
    ["owner-log", "committed-update"],
  ] as const)("does not admit historical %s via an ordinary authority", async (lane, kind) => {
    const { authority } = fixtureAuthority();
    const lease = await authority.acquireRoom(room);
    const writer = await authority.createWriter(lease, "fixture-owner", lane);
    await writer.seal(kind, bytes);
    await expect(authority.createReceiver(lease, writer.stream)).rejects.toMatchObject({
      code: "invalid-admission",
    });
    await expect(
      authority.createReceiver(
        lease,
        writer.stream,
        undefined,
        Object.freeze({ stream: writer.stream }),
      ),
    ).rejects.toMatchObject({ code: "invalid-admission" });
  });

  it("does not return a key derivation after revoke", async () => {
    const { authority, provider } = fixtureAuthority();
    const lease = await authority.acquireRoom(room);
    const gate = deferred<CryptoKey>();
    vi.spyOn(crypto.subtle, "deriveKey").mockReturnValueOnce(gate.promise);
    const pending = authority.createWriter(lease, "device-a", "live-update");
    const rejected = expect(pending).rejects.toMatchObject({ code: "revoked" });
    await Promise.resolve();
    provider.revoke();
    await rejected;
    gate.resolve(
      await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
      ]),
    );
  });

  it("limits active acquisitions and permits a new grant after a close", async () => {
    const { authority, provider } = fixtureAuthority(undefined, { leases: 1 });
    const first = await authority.acquireRoom(room);
    await expect(authority.acquireRoom(room)).rejects.toMatchObject({ code: "budget-exceeded" });
    first.close();
    first.close();
    const next = await authority.acquireRoom(room);
    expect(provider.releases).toHaveBeenCalledTimes(1);
    next.close();
    expect(provider.releases).toHaveBeenCalledTimes(2);
  });
});

describe("room envelope authenticated encryption", () => {
  it("round trips with independent providers and defensive copies across all boundaries", async () => {
    const p = await pair();
    const input = new Uint8Array(bytes);
    const encrypting = p.writer.seal("sync", input);
    input.fill(0);
    const frame = await encrypting;
    expect(frame.ciphertext).not.toEqual(bytes);
    const decrypting = p.receiver.prepare(frame);
    frame.ciphertext.fill(0);
    const prepared = await decrypting;
    const candidate = prepared.payload;
    expect(candidate).toEqual(bytes);
    candidate.fill(0);
    expect(prepared.payload).toEqual(bytes);
    const committed = prepared.commit();
    expect(committed).toEqual(bytes);
    committed.fill(0);
    expect(() => prepared.commit()).toThrowError("prepared-spent");
    expect(() => prepared.payload).toThrowError("prepared-spent");
  });

  it.each(["tenantRef", "roomId", "documentGeneration", "keyEpoch"] as const)(
    "binds room field %s",
    async (field) => {
      const p = await pair();
      const frame = await p.writer.seal("sync", bytes);
      const alteredRoom = { ...room, [field]: field === "keyEpoch" ? 2 : "other" };
      const lease = await p.recipient.authority.acquireRoom(alteredRoom);
      const alteredStream = { ...frame.stream, room: alteredRoom };
      const receiver = await p.recipient.authority.createReceiver(lease, alteredStream);
      await expect(receiver.prepare({ ...frame, stream: alteredStream })).rejects.toMatchObject({
        code: "crypto-failed",
      });
      await expect(p.receiver.prepare({ ...frame, stream: alteredStream })).rejects.toMatchObject({
        code: "binding-mismatch",
      });
    },
  );

  it.each(["senderRef", "streamId", "lane"] as const)("binds stream field %s", async (field) => {
    const p = await pair();
    const frame = await p.writer.seal("sync", bytes);
    const stream = {
      ...frame.stream,
      [field]:
        field === "lane"
          ? ("awareness" as const)
          : field === "streamId"
            ? "A".repeat(43)
            : "device-b",
    };
    const receiver = await p.recipient.authority.createReceiver(p.receiverLease, stream);
    await expect(
      receiver.prepare({ ...frame, stream, kind: field === "lane" ? "awareness" : "sync" }),
    ).rejects.toMatchObject({ code: "crypto-failed" });
  });

  it.each(["ciphertext", "tag", "seq", "kind"])(
    "rejects altered %s without poisoning the valid frame",
    async (field) => {
      const p = await pair();
      const frame = await p.writer.seal("sync", bytes);
      const invalid = changed(frame, (value) => {
        if (field === "seq") return { ...value, seq: 100 };
        if (field === "kind") return { ...value, kind: "control" };
        const index = field === "tag" ? value.ciphertext.length - 1 : 0;
        value.ciphertext[index] = value.ciphertext[index]! ^ 1;
        return value;
      });
      await expect(p.receiver.prepare(invalid)).rejects.toMatchObject({ code: "crypto-failed" });
      expect((await p.receiver.prepare(frame)).commit()).toEqual(bytes);
    },
  );

  it("rejects a different room key despite matching public IDs", async () => {
    const p = await pair();
    const bad = fixtureAuthority(fixtureProvider(fixtureKey(8)));
    const lease = await bad.authority.acquireRoom(room);
    const receiver = await bad.authority.createReceiver(lease, p.writer.stream);
    await expect(receiver.prepare(await p.writer.seal("sync", bytes))).rejects.toMatchObject({
      code: "crypto-failed",
    });
  });

  it("keeps awareness on a distinct stream/key and rejects live kind substitution", async () => {
    const p = await pair();
    const writer = await p.authority.createWriter(p.lease, "device-a", "awareness");
    const receiver = await p.recipient.authority.createReceiver(p.receiverLease, writer.stream);
    expect((await receiver.prepare(await writer.seal("awareness", bytes))).commit()).toEqual(bytes);
    await expect(writer.seal("sync", bytes)).rejects.toMatchObject({ code: "invalid-frame" });
  });

  it("reserves unique counter nonces for concurrent seals and burns failures", async () => {
    const p = await pair();
    const encrypt = vi.spyOn(crypto.subtle, "encrypt");
    encrypt.mockRejectedValueOnce(new Error("fixture encrypt failure"));
    const frames = await Promise.allSettled(
      Array.from({ length: 10 }, () => p.writer.seal("sync", bytes)),
    );
    expect(frames[0]!.status).toBe("rejected");
    expect(
      frames.slice(1).map((result) => result.status === "fulfilled" && result.value.seq),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const nonces = encrypt.mock.calls.map(([params]) =>
      [...(params as ReturnType<typeof frameParameters>).iv].join(","),
    );
    expect(new Set(nonces).size).toBe(10);
    expect((await p.writer.seal("sync", bytes)).seq).toBe(10);
  });

  it("uses fresh subkeys after reconnect and rejects collisions/entropy failure", async () => {
    const p = await pair();
    const a = await p.writer.seal("sync", bytes);
    p.writer.close();
    const writer = await p.authority.createWriter(p.lease, "device-a", "live-update");
    const b = await writer.seal("sync", bytes);
    expect(a.seq).toBe(b.seq);
    expect(a.stream.streamId).not.toBe(b.stream.streamId);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
    const rng = vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
      (array as Uint8Array).fill(0);
      return array;
    });
    await p.authority.createWriter(p.lease, "device-a", "live-update");
    await expect(
      p.authority.createWriter(p.lease, "device-a", "live-update"),
    ).rejects.toMatchObject({ code: "stream-reused" });
    rng.mockImplementation(() => {
      throw new Error("fixture entropy unavailable");
    });
    await expect(
      p.authority.createWriter(p.lease, "device-a", "live-update"),
    ).rejects.toMatchObject({ code: "entropy-failed" });
  });

  it("enforces frame, stream byte and frame-count budgets without wraparound", async () => {
    const p = await pair({
      streamFrames: 2,
      streamBytes: bytes.length * 2,
      frameBytes: bytes.length,
    });
    await expect(p.writer.seal("sync", new Uint8Array(bytes.length + 1))).rejects.toMatchObject({
      code: "invalid-frame",
    });
    expect((await p.writer.seal("sync", bytes)).seq).toBe(0);
    expect((await p.writer.seal("sync", bytes)).seq).toBe(1);
    await expect(p.writer.seal("sync", new Uint8Array())).rejects.toMatchObject({
      code: "budget-exceeded",
    });
    const byteBounded = await pair({ streamBytes: 1 });
    await byteBounded.writer.seal("sync", new Uint8Array(1));
    await expect(byteBounded.writer.seal("sync", new Uint8Array(1))).rejects.toMatchObject({
      code: "budget-exceeded",
    });
  });

  it("holds native crypto quota after cancellation until native completion, across writers", async () => {
    const p = await pair({ pending: 1 });
    const writer2 = await p.authority.createWriter(p.lease, "device-b", "live-update");
    const gate = deferred<ArrayBuffer>();
    vi.spyOn(crypto.subtle, "encrypt").mockReturnValueOnce(gate.promise);
    const cancel = new AbortController();
    const sealed = p.writer.seal("sync", bytes, cancel.signal);
    const rejected = expect(sealed).rejects.toMatchObject({ code: "aborted" });
    await Promise.resolve();
    cancel.abort();
    await rejected;
    await expect(writer2.seal("sync", bytes)).rejects.toMatchObject({ code: "budget-exceeded" });
    gate.resolve(new ArrayBuffer(16));
    // Native work is adopted by another promise. Drain its settlement handlers,
    // not just one microtask, before expecting the quota to have been released.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect((await p.writer.seal("sync", bytes)).seq).toBe(1);
  });

  it("suppresses encryption completed after revoke and burns failed byte budgets", async () => {
    const p = await pair({ streamBytes: bytes.length });
    const gate = deferred<ArrayBuffer>();
    const encrypt = vi.spyOn(crypto.subtle, "encrypt").mockReturnValueOnce(gate.promise);
    const pending = p.writer.seal("sync", bytes);
    const rejected = expect(pending).rejects.toMatchObject({ code: "revoked" });
    await Promise.resolve();
    p.provider.revoke();
    await rejected;
    gate.resolve(new ArrayBuffer(16));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const other = await pair({ streamBytes: bytes.length });
    encrypt.mockRejectedValueOnce(new Error("fixture failed crypto"));
    await expect(other.writer.seal("sync", bytes)).rejects.toMatchObject({ code: "crypto-failed" });
    await expect(other.writer.seal("sync", new Uint8Array(1))).rejects.toMatchObject({
      code: "budget-exceeded",
    });
  });
});

describe("room envelope replay prepare/commit", () => {
  it("accepts within-window out of order once and rejects old/far-future frames", async () => {
    const p = await pair({ replayWindow: 3, forwardGap: 3 });
    const frames = [];
    for (let i = 0; i < 6; i++) frames.push(await p.writer.seal("sync", new Uint8Array([i])));
    await expect(p.receiver.prepare(frames[3]!)).rejects.toMatchObject({
      code: "sequence-outside-window",
    });
    for (const n of [2, 0, 1])
      expect((await p.receiver.prepare(frames[n]!)).commit()).toEqual(new Uint8Array([n]));
    await expect(p.receiver.prepare(frames[1]!)).rejects.toMatchObject({ code: "replayed" });
    (await p.receiver.prepare(frames[5]!)).commit();
    await expect(p.receiver.prepare(frames[2]!)).rejects.toMatchObject({
      code: "sequence-outside-window",
    });
  });

  it("reserves concurrent duplicates once; abort allows retry and commit prevents it", async () => {
    const p = await pair();
    const frame = await p.writer.seal("sync", bytes);
    const first = p.receiver.prepare(frame);
    await expect(p.receiver.prepare(frame)).rejects.toMatchObject({ code: "replayed" });
    const prepared = await first;
    prepared.abort();
    prepared.abort();
    expect(() => prepared.commit()).toThrowError("prepared-spent");
    (await p.receiver.prepare(frame)).commit();
    await expect(p.receiver.prepare(frame)).rejects.toMatchObject({ code: "replayed" });
  });

  it("does not consume replay for failed candidate validation and never executes application callbacks", async () => {
    const p = await pair();
    const frame = await p.writer.seal("sync", bytes);
    const candidate = await p.receiver.prepare(frame);
    let external = "old";
    try {
      JSON.parse(new TextDecoder().decode(candidate.payload));
    } catch {
      candidate.abort();
    }
    expect(external).toBe("old");
    const retry = await p.receiver.prepare(frame);
    expect(retry.commit()).toEqual(bytes);
    // Publication is external: a failure after replay commit cannot be rolled
    // back by this module, and the caller must resync instead of replaying.
    try {
      external = "partially changed";
      throw new Error("external swap failed");
    } catch {
      /* resync */
    }
    expect(external).toBe("partially changed");
    await expect(p.receiver.prepare(frame)).rejects.toMatchObject({ code: "replayed" });
  });

  it("rechecks window when another prepared commit advances past it", async () => {
    const p = await pair({ replayWindow: 2, forwardGap: 4 });
    const frames = [];
    for (let i = 0; i < 4; i++) frames.push(await p.writer.seal("sync", bytes));
    const early = await p.receiver.prepare(frames[0]!);
    (await p.receiver.prepare(frames[3]!)).commit();
    expect(() => early.commit()).toThrowError("sequence-outside-window");
    expect(() => early.payload).toThrowError("prepared-spent");
  });

  it("does not reopen a closed stream with an empty replay window, even with a fresh lease", async () => {
    const p = await pair();
    const frame = await p.writer.seal("sync", bytes);
    const prepared = await p.receiver.prepare(frame);
    p.receiver.close();
    expect(() => prepared.commit()).toThrowError("closed");
    const freshLease = await p.recipient.authority.acquireRoom(room);
    await expect(
      p.recipient.authority.createReceiver(freshLease, p.writer.stream),
    ).rejects.toMatchObject({ code: "stream-reused" });
    await expect(p.receiver.prepare(frame)).rejects.toMatchObject({ code: "closed" });
  });

  it("rejects cross-room admission and never allocates streams from arbitrary headers", async () => {
    const p = await pair({ streams: 1 });
    const frame = await p.writer.seal("sync", bytes);
    const stream = { ...p.writer.stream, room: { ...room, roomId: "other" } };
    await expect(
      p.recipient.authority.createReceiver(p.receiverLease, stream),
    ).rejects.toMatchObject({ code: "binding-mismatch" });
    await expect(p.receiver.prepare({ ...frame, stream })).rejects.toMatchObject({
      code: "binding-mismatch",
    });
    const fresh = { ...p.writer.stream, senderRef: "other" };
    await expect(
      p.recipient.authority.createReceiver(p.receiverLease, fresh),
    ).rejects.toMatchObject({ code: "budget-exceeded" });
    expect((await p.receiver.prepare(frame)).commit()).toEqual(bytes);
  });

  it("bounds prepared bytes across streams and releases reservation on abort", async () => {
    const p = await pair({ pending: 1 });
    const writer2 = await p.authority.createWriter(p.lease, "device-b", "live-update");
    const receiver2 = await p.recipient.authority.createReceiver(p.receiverLease, writer2.stream);
    const frame = await p.writer.seal("sync", bytes);
    const frame2 = await writer2.seal("sync", bytes);
    const first = await p.receiver.prepare(frame);
    await expect(receiver2.prepare(frame2)).rejects.toMatchObject({ code: "budget-exceeded" });
    first.abort();
    expect((await receiver2.prepare(frame2)).commit()).toEqual(bytes);
  });

  it("does not publish a late decrypt after revoke and holds native quota until completion", async () => {
    const p = await pair({ pending: 1 });
    const frame = await p.writer.seal("sync", bytes);
    const gate = deferred<ArrayBuffer>();
    vi.spyOn(crypto.subtle, "decrypt").mockReturnValueOnce(gate.promise);
    const pending = p.receiver.prepare(frame);
    const rejected = expect(pending).rejects.toMatchObject({ code: "revoked" });
    await Promise.resolve();
    p.recipient.provider.revoke();
    await rejected;
    const late = bytes.slice().buffer;
    gate.resolve(late);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect([...new Uint8Array(late)]).toEqual(Array(bytes.length).fill(0));
  });

  it("keeps decrypt quota after operation cancellation until the original native work settles", async () => {
    const p = await pair({ pending: 1 });
    const frame = await p.writer.seal("sync", bytes);
    const gate = deferred<ArrayBuffer>();
    vi.spyOn(crypto.subtle, "decrypt").mockReturnValueOnce(gate.promise);
    const cancel = new AbortController();
    const pending = p.receiver.prepare(frame, cancel.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: "aborted" });
    await Promise.resolve();
    cancel.abort();
    await rejected;
    await expect(p.receiver.prepare(frame)).rejects.toMatchObject({ code: "budget-exceeded" });
    gate.resolve(bytes.slice().buffer);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect((await p.receiver.prepare(frame)).commit()).toEqual(bytes);
  });

  it("canceling prepared payload makes it unusable and permits an uncommitted retry", async () => {
    const p = await pair();
    const frame = await p.writer.seal("sync", bytes);
    const cancel = new AbortController();
    const prepared = await p.receiver.prepare(frame, cancel.signal);
    cancel.abort();
    expect(() => prepared.commit()).toThrowError("aborted");
    expect((await p.receiver.prepare(frame)).commit()).toEqual(bytes);
  });
});
