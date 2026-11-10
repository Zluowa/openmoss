import { copyOrdinaryByteView, ordinaryByteViewLength } from "../ordinaryByteView.ts";

// Internal prototype only. No wire route, account/key distribution or recovery protocol.
export const ROOM_ENVELOPE_SUITE = "A256GCM-HKDF-SHA256" as const;
export const ROOM_ENVELOPE_LIMITS = Object.freeze({
  frameBytes: 256 * 1024,
  streamFrames: 2 ** 20,
  streamBytes: 1024 ** 3,
  pending: 32,
  replayWindow: 1024,
  forwardGap: 1024,
  streams: 4096,
  leases: 128,
});
export type RoomEnvelopeLimits = { readonly [K in keyof typeof ROOM_ENVELOPE_LIMITS]: number };
export type RoomEnvelopeErrorCode =
  | "invalid-frame"
  | "binding-mismatch"
  | "invalid-lease"
  | "invalid-admission"
  | "key-unavailable"
  | "revoked"
  | "aborted"
  | "closed"
  | "budget-exceeded"
  | "crypto-failed"
  | "entropy-failed"
  | "stream-reused"
  | "replayed"
  | "sequence-outside-window"
  | "prepared-spent";

/** Deliberately excludes provider/native error messages, payloads and key material. */
export class RoomEnvelopeError extends Error {
  constructor(readonly code: RoomEnvelopeErrorCode) {
    super(`Room envelope: ${code}`);
    this.name = "RoomEnvelopeError";
  }
}
export function rejectEnvelope(code: RoomEnvelopeErrorCode): never {
  throw new RoomEnvelopeError(code);
}

export interface RoomBinding {
  readonly tenantRef: string;
  readonly roomId: string;
  readonly documentGeneration: string;
  readonly keyEpoch: number;
}
export type RoomLane = "live-update" | "awareness" | "checkpoint" | "owner-log";
export type RoomFrameKind = "sync" | "control" | "awareness" | "checkpoint" | "committed-update";
export interface RoomStreamBinding {
  readonly room: RoomBinding;
  readonly senderRef: string;
  readonly streamId: string;
  readonly lane: RoomLane;
}
export interface SealedRoomFrame {
  readonly v: 1;
  readonly suite: typeof ROOM_ENVELOPE_SUITE;
  readonly stream: RoomStreamBinding;
  readonly seq: number;
  readonly kind: RoomFrameKind;
  /** Includes the final 16-byte GCM tag. No caller-selectable nonce. */
  readonly ciphertext: Uint8Array<ArrayBuffer>;
}

// Accept data records, not getters/prototypes. This is not a sandbox against JS
// code already executing in the process (for example a hostile Proxy).
export function envelopeRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object") rejectEnvelope("invalid-frame");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) rejectEnvelope("invalid-frame");
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    rejectEnvelope("invalid-frame");
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) rejectEnvelope("invalid-frame");
    result[key] = descriptor.value;
  }
  return result;
}
export function envelopeReference(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    rejectEnvelope("invalid-frame");
  }
  return value;
}
export function copyRoomBinding(value: unknown): RoomBinding {
  const item = envelopeRecord(value, ["tenantRef", "roomId", "documentGeneration", "keyEpoch"]);
  if (
    typeof item.keyEpoch !== "number" ||
    !Number.isSafeInteger(item.keyEpoch) ||
    item.keyEpoch < 0 ||
    Object.is(item.keyEpoch, -0)
  ) {
    rejectEnvelope("invalid-frame");
  }
  return Object.freeze({
    tenantRef: envelopeReference(item.tenantRef),
    roomId: envelopeReference(item.roomId),
    documentGeneration: envelopeReference(item.documentGeneration),
    keyEpoch: item.keyEpoch,
  });
}
export function encodeStreamId(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}
export function copyStreamBinding(value: unknown): RoomStreamBinding {
  const item = envelopeRecord(value, ["room", "senderRef", "streamId", "lane"]);
  // Exactly 32 bytes; the last base64url character has two zero padding bits.
  if (
    typeof item.streamId !== "string" ||
    !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(item.streamId)
  ) {
    rejectEnvelope("invalid-frame");
  }
  if (!["live-update", "awareness", "checkpoint", "owner-log"].includes(item.lane as string))
    rejectEnvelope("invalid-frame");
  return Object.freeze({
    room: copyRoomBinding(item.room),
    senderRef: envelopeReference(item.senderRef),
    streamId: item.streamId,
    lane: item.lane as RoomLane,
  });
}
export function assertKind(lane: RoomLane, kind: unknown): asserts kind is RoomFrameKind {
  const valid =
    lane === "live-update"
      ? kind === "sync" || kind === "control"
      : lane === "awareness"
        ? kind === "awareness"
        : lane === "checkpoint"
          ? kind === "checkpoint"
          : kind === "committed-update";
  if (!valid) {
    rejectEnvelope("invalid-frame");
  }
}
export function roomByteLength(value: unknown): number {
  return ordinaryByteViewLength(value) ?? rejectEnvelope("invalid-frame");
}
function checkedByteLength(value: unknown, maximum: number, minimum: number): number {
  const length = roomByteLength(value);
  if (length < minimum || length > maximum) rejectEnvelope("invalid-frame");
  return length;
}
export function copyBytes(value: unknown, maximum: number, minimum = 0): Uint8Array<ArrayBuffer> {
  return copyOrdinaryByteView(value, maximum, minimum) ?? rejectEnvelope("invalid-frame");
}
/** Synchronous preflight. Borrows the validated view only until copy(); callers
 * must finish all copies before any await. No ciphertext bytes allocated here. */
export function preflightRoomFrame(value: unknown, limits: RoomEnvelopeLimits) {
  const item = envelopeRecord(value, ["v", "suite", "stream", "seq", "kind", "ciphertext"]);
  if (
    item.v !== 1 ||
    item.suite !== ROOM_ENVELOPE_SUITE ||
    typeof item.seq !== "number" ||
    !Number.isSafeInteger(item.seq) ||
    item.seq < 0 ||
    Object.is(item.seq, -0) ||
    item.seq >= limits.streamFrames
  ) {
    rejectEnvelope("invalid-frame");
  }
  const stream = copyStreamBinding(item.stream);
  assertKind(stream.lane, item.kind);
  const source = item.ciphertext;
  const ciphertextBytes = checkedByteLength(source, limits.frameBytes + 16, 16);
  const header = Object.freeze({
    v: 1 as const,
    suite: ROOM_ENVELOPE_SUITE,
    stream,
    seq: item.seq,
    kind: item.kind,
  });
  return Object.freeze({
    ciphertextBytes,
    copy: (): SealedRoomFrame =>
      Object.freeze({ ...header, ciphertext: copyBytes(source, ciphertextBytes, ciphertextBytes) }),
  });
}
export function copyFrame(value: unknown, limits: RoomEnvelopeLimits): SealedRoomFrame {
  return preflightRoomFrame(value, limits).copy();
}

function roomTuple(room: RoomBinding) {
  return [room.tenantRef, room.roomId, room.documentGeneration, room.keyEpoch] as const;
}
function streamTuple(stream: RoomStreamBinding) {
  return [...roomTuple(stream.room), stream.senderRef, stream.streamId, stream.lane] as const;
}
export function roomIdentity(room: RoomBinding): string {
  return JSON.stringify(roomTuple(room));
}
export function streamIdentity(stream: RoomStreamBinding): string {
  return JSON.stringify(streamTuple(stream));
}
const encoder = new TextEncoder();
export function streamKeyParameters(stream: RoomStreamBinding) {
  return {
    name: "HKDF",
    hash: "SHA-256",
    salt: encoder.encode("moss-page-room-hkdf-salt-v1"),
    info: encoder.encode(
      JSON.stringify(["moss-page-room-stream-key", 1, ROOM_ENVELOPE_SUITE, ...streamTuple(stream)]),
    ),
  };
}
export function frameParameters(frame: Omit<SealedRoomFrame, "ciphertext">) {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setBigUint64(4, BigInt(frame.seq), false);
  return {
    name: "AES-GCM",
    iv,
    tagLength: 128,
    additionalData: encoder.encode(
      JSON.stringify([
        "moss-page-room-envelope",
        frame.v,
        frame.suite,
        ...streamTuple(frame.stream),
        frame.seq,
        frame.kind,
      ]),
    ),
  };
}
/** Trusted callers may lower prototype budgets, never raise them. */
export function envelopeLimits(overrides: Partial<RoomEnvelopeLimits>): RoomEnvelopeLimits {
  const result: { -readonly [K in keyof RoomEnvelopeLimits]: number } = { ...ROOM_ENVELOPE_LIMITS };
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(result, key)) rejectEnvelope("invalid-frame");
    const name = key as keyof RoomEnvelopeLimits;
    const value = overrides[name];
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      value > result[name]
    ) {
      rejectEnvelope("invalid-frame");
    }
    result[name] = value;
  }
  return Object.freeze(result);
}
