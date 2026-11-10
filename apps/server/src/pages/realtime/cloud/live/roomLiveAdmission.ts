import { createHash, type KeyObject } from "node:crypto";
import {
  copyRoomBinding,
  copyStreamBinding,
  envelopeRecord,
  roomIdentity,
  streamIdentity,
  type RoomBinding,
  type RoomStreamBinding,
} from "../roomEnvelopeProtocol";
import {
  digest,
  freshNonce,
  importSpki,
  keyRef,
  reject,
  signBytes,
  verified,
} from "../control/roomControlProtocol";

export type LiveRole = "host" | "peer";
export type LiveMode = "edit" | "view";
/** Explicitly captured from a trusted enrollment source. An offer identifies a
 * stream, never who may enroll or which rights a device has. */
export interface LivePairGrant {
  room: RoomBinding;
  localRole: LiveRole;
  localMode: LiveMode;
  peerMode: LiveMode;
  localSigningKey: KeyObject;
  peerPublicKey: string;
  expiresAt: number;
  revoked: AbortSignal;
  assertCurrent(): void;
  release(): void;
}
interface Descriptor {
  role: LiveRole;
  from: string;
  to: string;
  nonce: string;
  awarenessId: number;
  sync: RoomStreamBinding;
  awareness: RoomStreamBinding;
}
export interface LiveStreamOffer {
  descriptor: Descriptor;
  signature: string;
}
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const offerProof = (d: Descriptor) => bytes(["moss-private-room-live-streams", 1, d]);
const offerHash = (d: Descriptor) => hash(offerProof(d));
const pairing = (from: Descriptor, to: Descriptor) =>
  bytes(["moss-private-room-live-channel", 1, offerHash(from), offerHash(to)]);
export function frameProof(
  from: Descriptor,
  to: Descriptor,
  stream: RoomStreamBinding,
  kind: string,
  seq: number,
  data: Uint8Array,
) {
  return bytes([
    "moss-private-room-live-message",
    1,
    offerHash(from),
    offerHash(to),
    streamIdentity(stream),
    kind,
    seq,
    hash(data),
  ]);
}
export function createLivePair(
  grant: LivePairGrant,
  sync: RoomStreamBinding,
  awareness: RoomStreamBinding,
  awarenessId: number,
) {
  const room = copyRoomBinding(grant.room),
    local = grant.localSigningKey,
    peer = importSpki(grant.peerPublicKey);
  const self = keyRef(local),
    other = keyRef(peer),
    role = grant.localRole;
  if (
    local.type !== "private" ||
    self === other ||
    !["host", "peer"].includes(role) ||
    !["edit", "view"].includes(grant.localMode) ||
    !["edit", "view"].includes(grant.peerMode) ||
    (role === "host" && grant.localMode !== "edit") ||
    (role === "peer" && grant.peerMode !== "edit")
  )
    return reject();
  const descriptor = (v: unknown, expected: "local" | "peer"): Descriptor => {
    const d = envelopeRecord(v, [
      "role",
      "from",
      "to",
      "nonce",
      "awarenessId",
      "sync",
      "awareness",
    ]);
    const source = expected === "local" ? self : other,
      target = expected === "local" ? other : self;
    const expectedRole = expected === "local" ? role : role === "host" ? "peer" : "host";
    if (
      d.role !== expectedRole ||
      digest(d.from) !== source ||
      digest(d.to) !== target ||
      typeof d.nonce !== "string" ||
      !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(d.nonce) ||
      typeof d.awarenessId !== "number" ||
      !Number.isSafeInteger(d.awarenessId) ||
      d.awarenessId < 0 ||
      d.awarenessId > 0xffff_ffff
    )
      return reject();
    const a = copyStreamBinding(d.sync),
      b = copyStreamBinding(d.awareness);
    if (
      a.senderRef !== source ||
      b.senderRef !== source ||
      roomIdentity(a.room) !== roomIdentity(room) ||
      roomIdentity(b.room) !== roomIdentity(room) ||
      a.lane !== "live-update" ||
      b.lane !== "awareness" ||
      a.streamId === b.streamId
    )
      return reject();
    return Object.freeze({
      role: expectedRole,
      from: source,
      to: target,
      nonce: d.nonce,
      awarenessId: d.awarenessId,
      sync: a,
      awareness: b,
    });
  };
  const localOffer = descriptor(
    { role, from: self, to: other, nonce: freshNonce(), awarenessId, sync, awareness },
    "local",
  );
  const offer = Object.freeze({
    descriptor: localOffer,
    signature: signBytes(local, offerProof(localOffer)),
  });
  function checkOffer(input: unknown) {
    const fields = envelopeRecord(input, ["descriptor", "signature"]),
      d = descriptor(fields.descriptor, "peer");
    if (d.awarenessId === awarenessId || !verified(peer, offerProof(d), fields.signature))
      return reject();
    return d;
  }
  return {
    offer,
    local: localOffer,
    peer,
    sign: (data: Buffer) => signBytes(local, data),
    answer(input: unknown) {
      return signBytes(local, pairing(localOffer, checkOffer(input)));
    },
    admit(input: unknown, reply: string) {
      const d = checkOffer(input);
      if (!verified(peer, pairing(d, localOffer), reply)) return reject();
      return d;
    },
  };
}
