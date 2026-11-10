import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  ROOM_ENVELOPE_LIMITS,
  copyBytes,
  envelopeRecord,
  roomIdentity,
} from "../roomEnvelopeProtocol";
import {
  bundleDigestInput,
  checkBundleShape,
  copyRecoveryAnchor,
  copyRecoveryBundle,
  frameDigestInput,
  type RecoveryAnchor,
  type RecoveryBundle,
  type RecoveryFloor,
} from "../roomRecoveryProtocol";
import { parseWire, reject, wire } from "./roomControlProtocol";

export const CHECKPOINT_CIPHER_BYTES = ROOM_ENVELOPE_LIMITS.frameBytes + 16;
export const CHECKPOINT_META_BYTES = 16_384;
export const CHECKPOINT_PACKET_BYTES = 4 + CHECKPOINT_META_BYTES + CHECKPOINT_CIPHER_BYTES;
export interface CipherPacket {
  meta: unknown;
  ciphertext: Uint8Array<ArrayBuffer>;
}
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function sealedPacket(value: unknown): CipherPacket {
  const b = copyRecoveryBundle(value);
  if (b.tail.length) return reject();
  const { ciphertext, ...frame } = b.checkpoint;
  return { meta: { ...b, checkpoint: frame }, ciphertext };
}
export function bundleFromPacket(meta: unknown, ciphertext: Uint8Array): RecoveryBundle {
  const b = envelopeRecord(meta, [
    "format",
    "room",
    "checkpointId",
    "checkpointVersion",
    "coveredCommitIndex",
    "coveredCommitDigest",
    "checkpoint",
    "tail",
  ]);
  const frame = envelopeRecord(b.checkpoint, ["v", "suite", "stream", "seq", "kind"]);
  if (!Array.isArray(b.tail) || b.tail.length) return reject();
  return copyRecoveryBundle({ ...b, checkpoint: { ...frame, ciphertext } });
}
export function verifiedBundle(b: RecoveryBundle, anchor: RecoveryAnchor, ownerRef: string) {
  checkBundleShape(b, anchor);
  if (
    b.tail.length ||
    b.checkpoint.stream.senderRef !== ownerRef ||
    roomIdentity(b.room) !== roomIdentity(anchor.room)
  )
    return reject();
  const frame = sha(frameDigestInput(b.checkpoint));
  if (
    frame !== anchor.checkpointDigest ||
    sha(bundleDigestInput(b, frame, [])) !== anchor.bundleDigest
  )
    return reject();
}
export function verifyFetched(
  bundle: RecoveryBundle,
  room: RecoveryBundle["room"],
  digest: string,
  pin: RecoveryAnchor | RecoveryFloor,
) {
  if (
    bundle.tail.length ||
    roomIdentity(bundle.room) !== roomIdentity(room) ||
    roomIdentity(pin.room) !== roomIdentity(room) ||
    bundle.checkpointId !== pin.checkpointId ||
    bundle.checkpointVersion !== pin.checkpointVersion ||
    digest !== pin.bundleDigest
  )
    return reject();
  const frame = sha(frameDigestInput(bundle.checkpoint));
  if (frame !== pin.checkpointDigest || sha(bundleDigestInput(bundle, frame, [])) !== digest)
    return reject();
  if ("coveredCommitIndex" in pin) checkBundleShape(bundle, pin);
  else if (
    bundle.coveredCommitIndex !== pin.commitIndex ||
    bundle.coveredCommitDigest !== pin.commitDigest
  )
    return reject();
}
export function encodePacket(meta: unknown, ciphertext: Uint8Array): Buffer {
  const header = Buffer.from(wire(meta), "utf8"),
    copy = copyBytes(ciphertext, CHECKPOINT_CIPHER_BYTES, 16);
  const result = Buffer.allocUnsafe(4 + header.length + copy.length);
  result.writeUInt32BE(header.length);
  header.copy(result, 4);
  result.set(copy, 4 + header.length);
  return result;
}
export function decodePacket(bytes: Buffer): CipherPacket {
  if (bytes.length < 22 || bytes.length > CHECKPOINT_PACKET_BYTES) return reject();
  const size = bytes.readUInt32BE(0);
  if (
    size < 2 ||
    size > CHECKPOINT_META_BYTES ||
    bytes.length - size - 4 < 16 ||
    bytes.length - size - 4 > CHECKPOINT_CIPHER_BYTES
  )
    return reject();
  const meta = parseWire(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(4, 4 + size)),
  );
  return { meta, ciphertext: new Uint8Array(bytes.subarray(4 + size)) };
}
export function createCipherTable(db: DatabaseSync) {
  db.exec(`CREATE TABLE proto_ciphertext(
    digest TEXT PRIMARY KEY CHECK(typeof(digest)='text' AND length(digest)=64 AND digest NOT GLOB '*[^0-9a-f]*'),
    anchor_json TEXT NOT NULL CHECK(typeof(anchor_json)='text' AND length(CAST(anchor_json AS BLOB)) BETWEEN 2 AND 4096),
    bundle_meta TEXT NOT NULL CHECK(typeof(bundle_meta)='text' AND length(CAST(bundle_meta AS BLOB)) BETWEEN 2 AND 4096),
    ciphertext BLOB NOT NULL CHECK(typeof(ciphertext)='blob' AND length(ciphertext) BETWEEN 16 AND ${CHECKPOINT_CIPHER_BYTES}));
    CREATE TABLE proto_cipher_device_pin(device_ref TEXT PRIMARY KEY REFERENCES proto_control_device(device_ref),digest TEXT NOT NULL REFERENCES proto_ciphertext(digest) ON DELETE RESTRICT);
    CREATE INDEX proto_cipher_pin_digest ON proto_cipher_device_pin(digest);
    CREATE TRIGGER proto_cipher_no_rewrite BEFORE UPDATE ON proto_ciphertext BEGIN SELECT RAISE(ABORT,'immutable checkpoint'); END;
    CREATE TRIGGER proto_cipher_pinned BEFORE DELETE ON proto_ciphertext WHEN
      EXISTS(SELECT 1 FROM proto_control_room WHERE json_extract(head_json,'$.bundleDigest')=OLD.digest)
      OR EXISTS(SELECT 1 FROM proto_control_device WHERE json_extract(floor_json,'$.bundleDigest')=OLD.digest)
      BEGIN SELECT RAISE(ABORT,'checkpoint pinned'); END;`);
}
export function readCipher(db: DatabaseSync, digest: string, ownerRef: string) {
  const row = db
    .prepare(`SELECT CASE WHEN typeof(anchor_json)='text' AND length(CAST(anchor_json AS BLOB))<=4096 THEN anchor_json END AS anchor,
    CASE WHEN typeof(bundle_meta)='text' AND length(CAST(bundle_meta AS BLOB))<=4096 THEN bundle_meta END AS meta,
    CASE WHEN typeof(ciphertext)='blob' AND length(ciphertext) BETWEEN 16 AND ${CHECKPOINT_CIPHER_BYTES} THEN ciphertext END AS cipher
    FROM proto_ciphertext WHERE digest=?`)
    .get(digest);
  if (
    !row ||
    typeof row.anchor !== "string" ||
    typeof row.meta !== "string" ||
    !(row.cipher instanceof Uint8Array)
  )
    return reject();
  const anchor = copyRecoveryAnchor(parseWire(row.anchor)),
    bundle = bundleFromPacket(parseWire(row.meta), row.cipher);
  if (anchor.bundleDigest !== digest) return reject();
  verifiedBundle(bundle, anchor, ownerRef);
  return bundle;
}
export function saveCipher(
  db: DatabaseSync,
  bundle: RecoveryBundle,
  anchor: RecoveryAnchor,
  ownerRef: string,
) {
  verifiedBundle(bundle, anchor, ownerRef);
  const exists = db
    .prepare("SELECT 1 FROM proto_ciphertext WHERE digest=?")
    .get(anchor.bundleDigest);
  if (exists) {
    readCipher(db, anchor.bundleDigest, ownerRef);
    return;
  }
  // One head, two pins (accepted and in-flight) per member, and one candidate in this transaction.
  if (Number(db.prepare("SELECT count(*) n FROM proto_ciphertext").get()?.n) >= 66) return reject();
  const packet = sealedPacket(bundle);
  db.prepare("INSERT INTO proto_ciphertext VALUES(?,?,?,?)").run(
    anchor.bundleDigest,
    wire(anchor),
    wire(packet.meta),
    packet.ciphertext,
  );
}
export function collectCipher(db: DatabaseSync) {
  db.exec(`DELETE FROM proto_ciphertext WHERE NOT EXISTS(SELECT 1 FROM proto_control_room
    WHERE json_extract(head_json,'$.bundleDigest')=proto_ciphertext.digest)
    AND NOT EXISTS(SELECT 1 FROM proto_control_device WHERE json_extract(floor_json,'$.bundleDigest')=proto_ciphertext.digest)
    AND NOT EXISTS(SELECT 1 FROM proto_cipher_device_pin WHERE digest=proto_ciphertext.digest)`);
}
