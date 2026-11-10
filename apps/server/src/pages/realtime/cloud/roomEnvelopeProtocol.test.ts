import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import {
  ROOM_ENVELOPE_LIMITS,
  ROOM_ENVELOPE_SUITE,
  copyBytes,
  copyFrame,
  copyRoomBinding,
  copyStreamBinding,
  envelopeLimits,
  frameParameters,
  streamKeyParameters,
} from "./roomEnvelopeProtocol";

const room = {
  tenantRef: "test-tenant",
  roomId: "test-room",
  documentGeneration: "g1",
  keyEpoch: 1,
};
const stream = {
  room,
  senderRef: "test-device",
  streamId: "A".repeat(43),
  lane: "live-update" as const,
};
const frame = {
  v: 1 as const,
  suite: ROOM_ENVELOPE_SUITE,
  stream,
  seq: 0,
  kind: "sync" as const,
  ciphertext: new Uint8Array(16),
};
const parse = (input: unknown) => copyFrame(input, ROOM_ENVELOPE_LIMITS);

describe("internal room envelope schema", () => {
  it("rejects real over-limit slots before allocation without consulting shadowed properties", () => {
    const source = new Uint8Array(1024);
    let reads = 0,
      copies = 0;
    Object.defineProperties(source, {
      byteLength: {
        get() {
          reads++;
          return 1;
        },
      },
      length: {
        get() {
          reads++;
          return 1;
        },
      },
      buffer: {
        get() {
          reads++;
          return new ArrayBuffer(1);
        },
      },
    });
    const original = Uint8Array;
    vi.stubGlobal(
      "Uint8Array",
      new Proxy(original, {
        construct(target, args, newTarget) {
          if (args[0] === source) copies++;
          return Reflect.construct(target, args, newTarget);
        },
      }),
    );
    try {
      expect(() => copyBytes(source, 1)).toThrowError("invalid-frame");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(reads).toBe(0);
    expect(copies).toBe(0);
  });

  it("accepts normal Node Buffer slice boundaries and refuses forged/shared typed-array brands", () => {
    const source = Buffer.from([7, 8, 9, 10]).subarray(1, 3);
    const copy = copyBytes(source, 2);
    source.fill(0);
    expect(copy).toEqual(new Uint8Array([8, 9]));
    const shared = new Uint8Array(new SharedArrayBuffer(16));
    Object.defineProperty(shared, "buffer", { value: new ArrayBuffer(16) });
    const otherKind = Object.setPrototypeOf(new Uint16Array(8), Uint8Array.prototype);
    for (const forged of [
      shared,
      Object.create(Uint8Array.prototype),
      new Proxy(new Uint8Array(16), {}),
      otherKind,
    ]) {
      expect(() => copyBytes(forged, 16)).toThrowError("invalid-frame");
    }
  });

  it("copies bounded bytes and freezes each header level", () => {
    const result = parse(frame);
    expect(result.ciphertext).not.toBe(frame.ciphertext);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.stream)).toBe(true);
    expect(Object.isFrozen(result.stream.room)).toBe(true);
    result.ciphertext[0] = 9;
    expect(frame.ciphertext[0]).toBe(0);
  });

  it.each([
    { ...frame, extra: "rejected" },
    { ...frame, v: 2 },
    { ...frame, suite: "AES-GCM" },
    ...[-1, -0, 1.5, NaN, Infinity, 2 ** 20].map((seq) => ({ ...frame, seq })),
    { ...frame, kind: "checkpoint" },
    { ...frame, kind: "awareness" },
    { ...frame, ciphertext: new Uint8Array(15) },
    { ...frame, ciphertext: new Uint8Array(ROOM_ENVELOPE_LIMITS.frameBytes + 17) },
    { ...frame, ciphertext: new Uint8Array(new SharedArrayBuffer(16)) },
    { ...frame, stream: { ...stream, extra: true } },
    { ...frame, stream: { ...stream, lane: "owner-log" } },
    { ...frame, stream: { ...stream, streamId: "A".repeat(42) + "B" } },
    { ...frame, stream: { ...stream, streamId: "A".repeat(42) + "=" } },
    { ...frame, stream: { ...stream, streamId: "A".repeat(42) } },
    { ...frame, stream: { ...stream, senderRef: "" } },
    { ...frame, stream: { ...stream, room: { ...room, keyEpoch: -0 } } },
    { ...frame, stream: { ...stream, room: { ...room, keyEpoch: 1.5 } } },
    { ...frame, stream: { ...stream, room: { ...room, tenantRef: "tenant\nroom" } } },
    { ...frame, stream: { ...stream, room: { ...room, roomId: "a".repeat(129) } } },
    Object.assign(Object.create({ inherited: true }), frame),
    null,
  ])("rejects malformed frame %# before cryptography", (input) => {
    expect(() => parse(input)).toThrowError("invalid-frame");
  });

  it("rejects getters and symbol fields without invoking the getter", () => {
    let calls = 0;
    const withGetter = {
      ...frame,
      get seq() {
        calls++;
        return 0;
      },
    };
    expect(() => parse(withGetter)).toThrowError("invalid-frame");
    expect(calls).toBe(0);
    expect(() => parse({ ...frame, [Symbol("extra")]: true })).toThrowError("invalid-frame");
  });

  it("fixes the HKDF domain, nonce layout and full AAD tuple", () => {
    const hkdf = streamKeyParameters(stream);
    const gcm = frameParameters({ ...frame, seq: 257 });
    expect(new TextDecoder().decode(hkdf.salt as Uint8Array)).toBe("moss-page-room-hkdf-salt-v1");
    expect(JSON.parse(new TextDecoder().decode(hkdf.info as Uint8Array))).toEqual([
      "moss-page-room-stream-key",
      1,
      ROOM_ENVELOPE_SUITE,
      "test-tenant",
      "test-room",
      "g1",
      1,
      "test-device",
      "A".repeat(43),
      "live-update",
    ]);
    expect([...(gcm.iv as Uint8Array)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1]);
    expect(JSON.parse(new TextDecoder().decode(gcm.additionalData as Uint8Array))).toEqual([
      "moss-page-room-envelope",
      1,
      ROOM_ENVELOPE_SUITE,
      "test-tenant",
      "test-room",
      "g1",
      1,
      "test-device",
      "A".repeat(43),
      "live-update",
      257,
      "sync",
    ]);
    expect(gcm.tagLength).toBe(128);
  });

  it("only accepts lower positive integral resource budgets", () => {
    expect(envelopeLimits({ pending: 1, frameBytes: 32 }).pending).toBe(1);
    for (const value of [0, -1, 0.5, Infinity, 33]) {
      expect(() => envelopeLimits({ pending: value })).toThrowError("invalid-frame");
    }
    expect(() => envelopeLimits({ unexpected: 1 } as never)).toThrowError("invalid-frame");
    expect(() => envelopeLimits({ toString: 1 } as never)).toThrowError("invalid-frame");
    expect(copyRoomBinding(room)).toEqual(room);
    expect(copyStreamBinding(stream)).toEqual(stream);
  });
});
