import * as decoding from "lib0/decoding";
import {
  ROOM_ENVELOPE_LIMITS,
  copyRoomBinding,
  envelopeRecord,
  envelopeReference,
  preflightRoomFrame,
  frameParameters,
  roomByteLength,
  roomIdentity,
  streamIdentity,
  type RoomBinding,
  type SealedRoomFrame,
} from "./roomEnvelopeProtocol";

/** Pinned reconstruction format. This is an internal bounded subset, not Page's cloud capacity. */
export const RECOVERY_FORMAT = "yjs-13.6.33-gc-false-update-v1" as const;
export const RECOVERY_BUNDLE_BYTES = 4 * 1024 * 1024;
export const RECOVERY_TAIL_LIMIT = 16;
export type RecoveryErrorCode =
  | "invalid-bundle"
  | "over-budget"
  | "anchor-required"
  | "owner-required"
  | "binding-mismatch"
  | "rollback"
  | "fork"
  | "digest-mismatch"
  | "invalid-history"
  | "invalid-yjs"
  | "authentication-failed"
  | "aborted"
  | "revoked"
  | "closed"
  | "busy"
  | "invalid-capability"
  | "hash-failed";
export class RoomRecoveryError extends Error {
  constructor(readonly code: RecoveryErrorCode) {
    super(`Room recovery: ${code}`);
    this.name = "RoomRecoveryError";
  }
}
export function failRecovery(code: RecoveryErrorCode): never {
  throw new RoomRecoveryError(code);
}

export interface RecoveryAnchor {
  readonly format: typeof RECOVERY_FORMAT;
  readonly room: RoomBinding;
  readonly checkpointId: string;
  readonly checkpointVersion: number;
  readonly coveredCommitIndex: number;
  readonly coveredCommitDigest: string;
  readonly checkpointDigest: string;
  readonly tailEndCommitIndex: number;
  readonly tailHeadDigest: string;
  readonly bundleDigest: string;
  readonly finalStateDigest: string;
}
export interface RecoveryFloor {
  readonly room: RoomBinding;
  readonly checkpointId: string;
  readonly checkpointVersion: number;
  readonly checkpointDigest: string;
  readonly commitIndex: number;
  readonly commitDigest: string;
  readonly bundleDigest: string;
}
export interface RecoveryTailEntry {
  readonly commitIndex: number;
  readonly previousDigest: string;
  readonly frame: SealedRoomFrame;
}
export interface RecoveryBundle {
  readonly format: typeof RECOVERY_FORMAT;
  readonly room: RoomBinding;
  readonly checkpointId: string;
  readonly checkpointVersion: number;
  readonly coveredCommitIndex: number;
  readonly coveredCommitDigest: string;
  readonly checkpoint: SealedRoomFrame;
  readonly tail: readonly RecoveryTailEntry[];
}

function integer(input: unknown): number {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < 0 ||
    Object.is(input, -0)
  )
    failRecovery("invalid-bundle");
  return input;
}
function digest(input: unknown): string {
  if (typeof input !== "string" || !/^[0-9a-f]{64}$/u.test(input)) failRecovery("invalid-bundle");
  return input;
}
export function copyRecoveryAnchor(value: unknown): RecoveryAnchor {
  const v = envelopeRecord(value, [
    "format",
    "room",
    "checkpointId",
    "checkpointVersion",
    "coveredCommitIndex",
    "coveredCommitDigest",
    "checkpointDigest",
    "tailEndCommitIndex",
    "tailHeadDigest",
    "bundleDigest",
    "finalStateDigest",
  ]);
  if (v.format !== RECOVERY_FORMAT) failRecovery("invalid-bundle");
  const coveredCommitIndex = integer(v.coveredCommitIndex),
    tailEndCommitIndex = integer(v.tailEndCommitIndex);
  if (
    tailEndCommitIndex < coveredCommitIndex ||
    tailEndCommitIndex - coveredCommitIndex > RECOVERY_TAIL_LIMIT
  )
    failRecovery("invalid-history");
  return Object.freeze({
    format: RECOVERY_FORMAT,
    room: copyRoomBinding(v.room),
    checkpointId: envelopeReference(v.checkpointId),
    checkpointVersion: integer(v.checkpointVersion),
    coveredCommitIndex,
    coveredCommitDigest: digest(v.coveredCommitDigest),
    checkpointDigest: digest(v.checkpointDigest),
    tailEndCommitIndex,
    tailHeadDigest: digest(v.tailHeadDigest),
    bundleDigest: digest(v.bundleDigest),
    finalStateDigest: digest(v.finalStateDigest),
  });
}
export function copyRecoveryFloor(value: unknown): RecoveryFloor | null {
  if (value === null) return null;
  const v = envelopeRecord(value, [
    "room",
    "checkpointId",
    "checkpointVersion",
    "checkpointDigest",
    "commitIndex",
    "commitDigest",
    "bundleDigest",
  ]);
  return Object.freeze({
    room: copyRoomBinding(v.room),
    checkpointId: envelopeReference(v.checkpointId),
    checkpointVersion: integer(v.checkpointVersion),
    checkpointDigest: digest(v.checkpointDigest),
    commitIndex: integer(v.commitIndex),
    commitDigest: digest(v.commitDigest),
    bundleDigest: digest(v.bundleDigest),
  });
}
export function checkRecoveryFloor(anchor: RecoveryAnchor, floor: RecoveryFloor | null): void {
  // A new device may have no local floor, but must still have a trusted *current*
  // anchor. A relay's claimed version/time/digest is never an anchor.
  if (!floor) return;
  if (roomIdentity(anchor.room) !== roomIdentity(floor.room)) failRecovery("binding-mismatch");
  if (
    anchor.checkpointVersion < floor.checkpointVersion ||
    anchor.tailEndCommitIndex < floor.commitIndex
  )
    failRecovery("rollback");
  if (anchor.checkpointVersion === floor.checkpointVersion) {
    if (
      anchor.checkpointId !== floor.checkpointId ||
      anchor.checkpointDigest !== floor.checkpointDigest ||
      anchor.coveredCommitIndex > floor.commitIndex
    )
      failRecovery("fork");
    if (
      anchor.tailEndCommitIndex === floor.commitIndex &&
      anchor.bundleDigest !== floor.bundleDigest
    )
      failRecovery("fork");
  } else if (anchor.coveredCommitIndex < floor.commitIndex) failRecovery("rollback");
  if (
    anchor.coveredCommitIndex === floor.commitIndex &&
    anchor.coveredCommitDigest !== floor.commitDigest
  )
    failRecovery("fork");
}

/** Snapshot all caller-owned bytes before the first await. Count conservative
 * canonical header allowances as well as ciphertext, before its allocation. */
export function copyRecoveryBundle(value: unknown): RecoveryBundle {
  const v = envelopeRecord(value, [
    "format",
    "room",
    "checkpointId",
    "checkpointVersion",
    "coveredCommitIndex",
    "coveredCommitDigest",
    "checkpoint",
    "tail",
  ]);
  if (
    v.format !== RECOVERY_FORMAT ||
    !Array.isArray(v.tail) ||
    Object.getPrototypeOf(v.tail) !== Array.prototype
  )
    failRecovery("invalid-bundle");
  if (v.tail.length > RECOVERY_TAIL_LIMIT) failRecovery("over-budget");
  if (Reflect.ownKeys(v.tail).length !== v.tail.length + 1) failRecovery("invalid-bundle");
  let remaining = RECOVERY_BUNDLE_BYTES - 1024 - 256 * v.tail.length;
  const frame = (input: unknown) => {
    const inspected = preflightRoomFrame(input, ROOM_ENVELOPE_LIMITS);
    remaining -= 1024 + inspected.ciphertextBytes;
    if (remaining < 0) failRecovery("over-budget");
    return inspected;
  };
  const checkpoint = frame(v.checkpoint);
  const tail: Array<{
    commitIndex: number;
    previousDigest: string;
    frame: ReturnType<typeof preflightRoomFrame>;
  }> = [];
  for (let i = 0; i < v.tail.length; i++) {
    const property = Object.getOwnPropertyDescriptor(v.tail, String(i));
    if (!property || !("value" in property)) failRecovery("invalid-bundle");
    const entry = envelopeRecord(property.value, ["commitIndex", "previousDigest", "frame"]);
    tail.push({
      commitIndex: integer(entry.commitIndex),
      previousDigest: digest(entry.previousDigest),
      frame: frame(entry.frame),
    });
  }
  // No earlier frame is copied if a later one makes the total exceed its cap.
  return Object.freeze({
    format: RECOVERY_FORMAT,
    room: copyRoomBinding(v.room),
    checkpointId: envelopeReference(v.checkpointId),
    checkpointVersion: integer(v.checkpointVersion),
    coveredCommitIndex: integer(v.coveredCommitIndex),
    coveredCommitDigest: digest(v.coveredCommitDigest),
    checkpoint: checkpoint.copy(),
    tail: Object.freeze(
      tail.map((entry) => Object.freeze({ ...entry, frame: entry.frame.copy() })),
    ),
  });
}
export function checkBundleShape(bundle: RecoveryBundle, anchor: RecoveryAnchor): void {
  const room = roomIdentity(anchor.room);
  if (
    roomIdentity(bundle.room) !== room ||
    bundle.checkpointId !== anchor.checkpointId ||
    bundle.checkpointVersion !== anchor.checkpointVersion ||
    bundle.coveredCommitIndex !== anchor.coveredCommitIndex ||
    bundle.coveredCommitDigest !== anchor.coveredCommitDigest
  )
    failRecovery("binding-mismatch");
  const cp = bundle.checkpoint;
  if (
    roomIdentity(cp.stream.room) !== room ||
    cp.seq !== 0 ||
    cp.stream.lane !== "checkpoint" ||
    cp.kind !== "checkpoint"
  )
    failRecovery("invalid-history");
  if (bundle.tail.length !== anchor.tailEndCommitIndex - anchor.coveredCommitIndex)
    failRecovery("invalid-history");
  const tailStream = bundle.tail[0]?.frame.stream;
  for (const [i, entry] of bundle.tail.entries()) {
    const f = entry.frame;
    if (
      entry.commitIndex !== anchor.coveredCommitIndex + i + 1 ||
      f.seq !== i ||
      f.stream.lane !== "owner-log" ||
      f.kind !== "committed-update" ||
      f.stream.senderRef !== cp.stream.senderRef ||
      f.stream.streamId === cp.stream.streamId ||
      roomIdentity(f.stream.room) !== room ||
      !tailStream ||
      streamIdentity(f.stream) !== streamIdentity(tailStream)
    )
      failRecovery("invalid-history");
  }
}

const text = new TextEncoder();
const tuple = (fields: readonly unknown[]) => text.encode(JSON.stringify(fields));
function framed(parts: readonly Uint8Array[], maximum: number): Uint8Array<ArrayBuffer> {
  const lengths = parts.map(roomByteLength);
  const total = lengths.reduce((size, length) => size + 4 + length, 0);
  if (total > maximum) failRecovery("over-budget");
  const out = new Uint8Array(total),
    view = new DataView(out.buffer);
  let at = 0;
  for (const [i, part] of parts.entries()) {
    const length = lengths[i]!;
    view.setUint32(at, length, false);
    out.set(part, at + 4); // Typed-array source: copies its real slots.
    at += 4 + length;
  }
  return out;
}
export function frameDigestInput(frame: SealedRoomFrame): Uint8Array<ArrayBuffer> {
  return framed(
    [
      tuple(["moss-room-recovery-frame", 1]),
      frameParameters(frame).additionalData,
      frame.ciphertext,
    ],
    ROOM_ENVELOPE_LIMITS.frameBytes + 2048,
  );
}
export function entryDigestInput(
  bundle: RecoveryBundle,
  entry: RecoveryTailEntry,
  frameDigest: string,
): Uint8Array<ArrayBuffer> {
  return tuple([
    "moss-room-recovery-entry",
    1,
    roomIdentity(bundle.room),
    bundle.checkpointId,
    bundle.checkpointVersion,
    entry.commitIndex,
    entry.previousDigest,
    frameDigest,
  ]);
}
export function bundleDigestInput(
  bundle: RecoveryBundle,
  checkpointDigest: string,
  tailDigests: readonly string[],
): Uint8Array<ArrayBuffer> {
  return tuple([
    "moss-room-recovery-bundle",
    1,
    bundle.format,
    roomIdentity(bundle.room),
    bundle.checkpointId,
    bundle.checkpointVersion,
    bundle.coveredCommitIndex,
    bundle.coveredCommitDigest,
    checkpointDigest,
    bundle.tail.map((entry, i) => [entry.commitIndex, entry.previousDigest, tailDigests[i]]),
  ]);
}
export function stateDigestInput(update: Uint8Array): Uint8Array<ArrayBuffer> {
  if (roomByteLength(update) > RECOVERY_BUNDLE_BYTES) failRecovery("over-budget");
  return framed(
    [tuple(["moss-room-recovery-full-state", 1, RECOVERY_FORMAT]), update],
    RECOVERY_BUNDLE_BYTES + 128,
  );
}

export interface RecoveryPayloadContext {
  readonly kind: "checkpoint" | "committed-update";
  readonly checkpointId: string;
  readonly checkpointVersion: number;
  readonly commitIndex: number;
  readonly previousDigest: string;
}
function payloadHeader(c: RecoveryPayloadContext) {
  return tuple([
    "moss-room-recovery-payload",
    1,
    RECOVERY_FORMAT,
    c.kind,
    c.checkpointId,
    c.checkpointVersion,
    c.commitIndex,
    c.previousDigest,
  ]);
}
export function encodeRecoveryPayload(
  c: RecoveryPayloadContext,
  update: Uint8Array,
  vector?: Uint8Array,
): Uint8Array<ArrayBuffer> {
  if ((c.kind === "checkpoint") !== (vector !== undefined)) failRecovery("invalid-history");
  return framed(
    vector ? [payloadHeader(c), update, vector] : [payloadHeader(c), update],
    ROOM_ENVELOPE_LIMITS.frameBytes,
  );
}
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);
}
export function decodeRecoveryPayload(c: RecoveryPayloadContext, payload: Uint8Array<ArrayBuffer>) {
  const decoder = decoding.createDecoder(payload);
  const read = () => {
    if (decoder.arr.length - decoder.pos < 4) failRecovery("invalid-history");
    const size = decoding.readUint32BigEndian(decoder);
    if (size > decoder.arr.length - decoder.pos) failRecovery("invalid-history");
    return decoding.readUint8Array(decoder, size);
  };
  if (!equalBytes(read(), payloadHeader(c))) failRecovery("invalid-history");
  const update = read(),
    vector = c.kind === "checkpoint" ? read() : null;
  if (decoding.hasContent(decoder)) failRecovery("invalid-history");
  return { update, vector };
}
