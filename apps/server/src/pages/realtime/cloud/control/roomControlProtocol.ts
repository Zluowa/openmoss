import {
  createHash,
  createPublicKey,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import {
  copyRoomBinding,
  envelopeRecord,
  envelopeReference,
  roomIdentity,
  type RoomBinding,
} from "../roomEnvelopeProtocol";
import {
  copyRecoveryAnchor,
  copyRecoveryFloor,
  type RecoveryAnchor,
  type RecoveryFloor,
} from "../roomRecoveryProtocol";

export const CONTROL_PROOF_TTL = 5_000;
export const CONTROL_LEASE_TTL = 4_000;
export const CONTROL_WIRE_BYTES = 16_384;
export const MAX_CONTROL_DEVICES = 32;
export type ControlRealm = "memfire-phone" | "supabase-google";
export const reject = (): never => {
  throw new Error("Room control unavailable");
};
export const freshNonce = () => randomBytes(32).toString("base64url");
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8");
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
export function tenantRef(realm: ControlRealm, accountId: string): string {
  if (
    !["memfire-phone", "supabase-google"].includes(realm) ||
    typeof accountId !== "string" ||
    !accountId ||
    Buffer.byteLength(accountId) > 256
  )
    return reject();
  return hash(bytes(["moss-page-room-tenant", 1, realm, accountId]));
}
export function wire(value: unknown): string {
  const data = JSON.stringify(value);
  if (typeof data !== "string" || Buffer.byteLength(data) > CONTROL_WIRE_BYTES) return reject();
  return data;
}
export function parseWire(value: unknown): unknown {
  if (
    typeof value !== "string" ||
    value.length > CONTROL_WIRE_BYTES ||
    Buffer.byteLength(value) > CONTROL_WIRE_BYTES
  )
    return reject();
  return JSON.parse(value);
}
export function publicSpki(key: KeyObject): string {
  const pub = key.type === "private" ? createPublicKey(key) : key;
  if (pub.type !== "public" || pub.asymmetricKeyType !== "ed25519") return reject();
  return pub.export({ type: "spki", format: "der" }).toString("base64url");
}
export function importSpki(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{59}$/u.test(value)) return reject();
  const key = createPublicKey({
    key: Buffer.from(value, "base64url"),
    type: "spki",
    format: "der",
  });
  if (publicSpki(key) !== value) return reject();
  return key;
}
export function keyRef(key: KeyObject): string {
  return hash(bytes(["moss-room-ed25519-device", 1, publicSpki(key)]));
}
export function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) return reject();
  return value;
}
export const maybeDigest = (v: unknown) => (v === null ? null : digest(v));
export function count(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    Object.is(value, -0)
  )
    return reject();
  return value;
}
function nonce(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(value))
    return reject();
  return value;
}
export type Operation =
  | { kind: "read" }
  | { kind: "live-peer"; deviceRef: string }
  | { kind: "grant-live"; deviceRef: string; mode: "edit" | "view" | "none"; expected: number }
  | { kind: "fetch"; digest: string }
  | {
      kind: "publish";
      expected: string | null;
      previousCommit: string | null;
      anchor: RecoveryAnchor;
    }
  | { kind: "accept"; expected: number; digest: string }
  | { kind: "enroll"; publicKey: string; profileRef: string; expected: number }
  | { kind: "revoke"; deviceRef: string; expected: number };
export interface Request {
  readonly room: RoomBinding;
  readonly keyRef: string;
  readonly nonce: string;
  readonly operation: Operation;
}
function operation(v: unknown): Operation {
  const kind =
    v && typeof v === "object" ? Object.getOwnPropertyDescriptor(v, "kind")?.value : null;
  switch (kind) {
    case "read":
      envelopeRecord(v, ["kind"]);
      return { kind };
    case "live-peer": {
      const r = envelopeRecord(v, ["kind", "deviceRef"]);
      return { kind, deviceRef: digest(r.deviceRef) };
    }
    case "grant-live": {
      const r = envelopeRecord(v, ["kind", "deviceRef", "mode", "expected"]);
      if (r.mode !== "edit" && r.mode !== "view" && r.mode !== "none") return reject();
      return { kind, deviceRef: digest(r.deviceRef), mode: r.mode, expected: count(r.expected) };
    }
    case "fetch": {
      const r = envelopeRecord(v, ["kind", "digest"]);
      return { kind, digest: digest(r.digest) };
    }
    case "publish": {
      const r = envelopeRecord(v, ["kind", "expected", "previousCommit", "anchor"]);
      return {
        kind,
        expected: maybeDigest(r.expected),
        previousCommit: maybeDigest(r.previousCommit),
        anchor: copyRecoveryAnchor(r.anchor),
      };
    }
    case "accept": {
      const r = envelopeRecord(v, ["kind", "expected", "digest"]);
      return { kind, expected: count(r.expected), digest: digest(r.digest) };
    }
    case "enroll": {
      const r = envelopeRecord(v, ["kind", "publicKey", "profileRef", "expected"]);
      return {
        kind,
        publicKey: publicSpki(importSpki(r.publicKey)),
        profileRef: envelopeReference(r.profileRef),
        expected: count(r.expected),
      };
    }
    case "revoke": {
      const r = envelopeRecord(v, ["kind", "deviceRef", "expected"]);
      return { kind, deviceRef: digest(r.deviceRef), expected: count(r.expected) };
    }
    default:
      return reject();
  }
}
export function copyRequest(value: unknown): Request {
  const v = envelopeRecord(value, ["room", "keyRef", "nonce", "operation"]);
  return {
    room: copyRoomBinding(v.room),
    keyRef: digest(v.keyRef),
    nonce: nonce(v.nonce),
    operation: operation(v.operation),
  };
}
export function requestDigest(r: Request): string {
  return hash(bytes(["moss-room-control-intent", 1, copyRequest(r)]));
}
export function proofBytes(authority: string, request: Request, challenge: string): Buffer {
  return bytes([
    "moss-room-control-device-proof",
    1,
    digest(authority),
    requestDigest(request),
    nonce(challenge),
  ]);
}
export const signBytes = (key: KeyObject, input: Buffer) =>
  sign(null, input, key).toString("base64url");
export function verified(key: KeyObject, input: Buffer, signature: unknown): boolean {
  if (typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/u.test(signature)) return false;
  const decoded = Buffer.from(signature, "base64url");
  return (
    decoded.length === 64 &&
    decoded.toString("base64url") === signature &&
    verify(null, input, key, decoded)
  );
}
export interface ControlView {
  owner: boolean;
  profileRef: string;
  scopeKey: string;
  pageId: string;
  fence: number;
  revision: number;
  head: RecoveryAnchor | null;
  pending?: RecoveryAnchor | null;
  accepted: { version: number; floor: RecoveryFloor } | null;
}
export interface Receipt {
  view: ControlView;
  signature: string;
}
export function copyView(v: unknown, room: RoomBinding): ControlView {
  const hasPin = typeof v === "object" && v !== null && Object.hasOwn(v, "pending");
  const d = envelopeRecord(v, [
    "owner",
    "profileRef",
    "scopeKey",
    "pageId",
    "fence",
    "revision",
    "head",
    "accepted",
    ...(hasPin ? ["pending"] : []),
  ]);
  const pending = hasPin && d.pending !== null ? copyRecoveryAnchor(d.pending) : null;
  if (pending && roomIdentity(pending.room) !== roomIdentity(room)) return reject();
  if (
    typeof d.owner !== "boolean" ||
    typeof d.scopeKey !== "string" ||
    !/^(?:local-default|project-space:[A-Za-z0-9_-]{1,128})$/u.test(d.scopeKey) ||
    !count(d.fence) ||
    !count(d.revision)
  )
    return reject();
  const head = d.head === null ? null : copyRecoveryAnchor(d.head);
  let accepted: ControlView["accepted"] = null;
  if (d.accepted !== null) {
    const a = envelopeRecord(d.accepted, ["version", "floor"]),
      floor = copyRecoveryFloor(a.floor),
      version = count(a.version);
    if (!floor || !version || !head || roomIdentity(floor.room) !== roomIdentity(room))
      return reject();
    accepted = Object.freeze({ floor, version });
  }
  if (head && roomIdentity(head.room) !== roomIdentity(room)) return reject();
  return Object.freeze({
    owner: d.owner,
    profileRef: envelopeReference(d.profileRef),
    scopeKey: d.scopeKey,
    pageId: envelopeReference(d.pageId),
    fence: count(d.fence),
    revision: count(d.revision),
    head,
    accepted,
    ...(hasPin ? { pending } : {}),
  });
}
export function receiptBytes(
  authority: string,
  r: Request,
  challenge: string,
  view: ControlView,
): Buffer {
  return bytes([
    "moss-room-control-receipt",
    1,
    digest(authority),
    requestDigest(r),
    nonce(challenge),
    CONTROL_LEASE_TTL,
    copyView(view, r.room),
  ]);
}
export function floorAt(a: RecoveryAnchor): RecoveryFloor {
  return {
    room: a.room,
    checkpointId: a.checkpointId,
    checkpointVersion: a.checkpointVersion,
    checkpointDigest: a.checkpointDigest,
    commitIndex: a.tailEndCommitIndex,
    commitDigest: a.tailHeadDigest,
    bundleDigest: a.bundleDigest,
  };
}

export interface LivePeerApproval {
  key: string;
  deviceRef: string;
  owner: boolean;
  localMode: "edit" | "view";
  peerMode: "edit" | "view";
  fence: number;
}
export function copyLivePeer(value: unknown): LivePeerApproval {
  const v = envelopeRecord(value, ["key", "deviceRef", "owner", "localMode", "peerMode", "fence"]),
    key = importSpki(v.key);
  if (
    keyRef(key) !== v.deviceRef ||
    typeof v.owner !== "boolean" ||
    !count(v.fence) ||
    (v.localMode !== "edit" && v.localMode !== "view") ||
    (v.peerMode !== "edit" && v.peerMode !== "view")
  )
    return reject();
  return Object.freeze({
    key: publicSpki(key),
    deviceRef: digest(v.deviceRef),
    owner: v.owner,
    localMode: v.localMode,
    peerMode: v.peerMode,
    fence: count(v.fence),
  });
}
export function livePeerReceipt(
  authority: string,
  r: Request,
  challenge: string,
  view: ControlView,
  peer: LivePeerApproval,
): Buffer {
  return bytes([
    "moss-room-live-enrollment",
    1,
    digest(authority),
    requestDigest(r),
    nonce(challenge),
    copyView(view, r.room),
    copyLivePeer(peer),
  ]);
}
