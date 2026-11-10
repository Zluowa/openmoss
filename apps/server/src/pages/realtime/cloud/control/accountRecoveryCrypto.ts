import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  publicEncrypt,
  privateDecrypt,
  createPublicKey,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { copyRecoveryAnchor, type RecoveryAnchor } from "../roomRecoveryProtocol";
import { copyRoomBinding, roomIdentity, type RoomBinding } from "../roomEnvelopeProtocol";
import { type ControlRealm, reject } from "./roomControlProtocol";

export const RECOVERY_BODY_BYTES = 2_000_000;
export const RECOVERY_HTTP_BYTES = 2_800_000;
export const digest = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
export const ref = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
export const hex = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
export const encode = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8");
export const recoveryIdFor = (tenant: string, pageId: string) =>
  digest(encode(["moss-account-page", 1, tenant, pageId]));
export interface RecoveryRegistration {
  realm: ControlRealm;
  tenantRef: string;
  scopeKey: string;
  spaceId: string;
  pageId: string;
  ownerPublicKey: string;
  anchor: RecoveryAnchor;
}
export interface RecoveryManifest {
  v: 1;
  realm: ControlRealm;
  tenantRef: string;
  scope: "local-default";
  spaceId: string;
  pageId: string;
  room: RoomBinding;
  title: string;
  anchor: RecoveryAnchor;
  bodyDigest: string;
  consent: string;
}
export interface SealedBackup {
  manifest: RecoveryManifest;
  cipher: string;
  wrapped: string;
  iv: string;
  signature: string;
}
export function canonicalManifest(raw: RecoveryManifest): RecoveryManifest {
  if (
    !raw ||
    raw.v !== 1 ||
    raw.scope !== "local-default" ||
    !["memfire-phone", "supabase-google"].includes(raw.realm) ||
    !hex(raw.tenantRef) ||
    !ref(raw.spaceId) ||
    !ref(raw.pageId) ||
    typeof raw.title !== "string" ||
    !raw.title.trim() ||
    Buffer.byteLength(raw.title) > 1024 ||
    !hex(raw.bodyDigest) ||
    !hex(raw.consent)
  )
    return reject();
  const room = copyRoomBinding(raw.room),
    anchor = copyRecoveryAnchor(raw.anchor);
  if (
    room.tenantRef !== raw.tenantRef ||
    roomIdentity(room) !== roomIdentity(anchor.room) ||
    anchor.tailEndCommitIndex !== anchor.coveredCommitIndex ||
    anchor.checkpointVersion < 1
  )
    return reject();
  return {
    v: 1,
    realm: raw.realm,
    tenantRef: raw.tenantRef,
    scope: "local-default",
    spaceId: raw.spaceId,
    pageId: raw.pageId,
    room,
    title: raw.title,
    anchor,
    bodyDigest: raw.bodyDigest,
    consent: raw.consent,
  };
}
export const manifestBytes = (m: RecoveryManifest) =>
  encode(["moss-account-page-recovery", 1, canonicalManifest(m)]);
export const claimBytes = (b: Omit<SealedBackup, "signature">) =>
  encode([
    "moss-account-page-owner-opt-in",
    1,
    digest(manifestBytes(b.manifest)),
    digest(binary(b.cipher, RECOVERY_BODY_BYTES + 16)),
    digest(binary(b.wrapped, 512)),
    b.iv,
  ]);
export function binary(value: unknown, max: number) {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > Math.ceil((max * 4) / 3) ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    return reject();
  const copy = Buffer.from(value, "base64url");
  if (copy.length > max || copy.toString("base64url") !== value) return reject();
  return copy;
}
export function publicWrappingKey(pem: string) {
  if (typeof pem !== "string" || pem.length > 2048 || !pem.startsWith("-----BEGIN PUBLIC KEY-----"))
    return reject();
  const k = createPublicKey(pem),
    bits = k.asymmetricKeyDetails?.modulusLength;
  if (k.asymmetricKeyType !== "rsa" || !bits || bits < 2048 || bits > 4096) return reject();
  return k;
}
const rsa = (key: KeyObject, label: Buffer) => ({
  key,
  padding: constants.RSA_PKCS1_OAEP_PADDING,
  oaepHash: "sha256",
  oaepLabel: label,
});
const wrapLabel = (m: RecoveryManifest, kind: "storage" | "delivery") =>
  Buffer.from(digest(encode(["moss-recovery-dek", 1, kind, digest(manifestBytes(m))])), "hex");
export function encryptRecoveryBody(manifest: RecoveryManifest, body: Buffer, wrappingKey: string) {
  if (!body.length || body.length > RECOVERY_BODY_BYTES || digest(body) !== manifest.bodyDigest)
    return reject();
  const key = randomBytes(32),
    iv = randomBytes(12);
  try {
    const aead = createCipheriv("aes-256-gcm", key, iv);
    aead.setAAD(manifestBytes(manifest));
    const cipher = Buffer.concat([aead.update(body), aead.final(), aead.getAuthTag()]);
    return {
      manifest,
      cipher: cipher.toString("base64url"),
      iv: iv.toString("base64url"),
      wrapped: publicEncrypt(
        rsa(publicWrappingKey(wrappingKey), wrapLabel(manifest, "storage")),
        key,
      ).toString("base64url"),
    };
  } finally {
    key.fill(0);
  }
}
/** Trusted independent KMS boundary. A production provider must own the same durable
 * key lifecycle; neither desktop nor the ordinary forwarding relay supplies a private key. */
export interface AccountRecoveryKms {
  readonly publicKey: string;
  rewrap(manifest: RecoveryManifest, wrapped: string, recipient: string): string;
}
export function rsaRecoveryKms(privateKey: KeyObject): AccountRecoveryKms {
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "rsa") return reject();
  const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  publicWrappingKey(publicKey);
  return {
    publicKey,
    rewrap(m, wrapped, recipient) {
      const key = privateDecrypt(rsa(privateKey, wrapLabel(m, "storage")), binary(wrapped, 512));
      try {
        if (key.length !== 32) return reject();
        return publicEncrypt(
          rsa(publicWrappingKey(recipient), wrapLabel(m, "delivery")),
          key,
        ).toString("base64url");
      } finally {
        key.fill(0);
      }
    },
  };
}
export function decryptRecoveryBody(
  m: RecoveryManifest,
  cipher: string,
  iv: string,
  delivery: string,
  device: KeyObject,
) {
  const data = binary(cipher, RECOVERY_BODY_BYTES + 16),
    nonce = binary(iv, 12);
  if (data.length <= 16 || nonce.length !== 12) return reject();
  const key = privateDecrypt(rsa(device, wrapLabel(m, "delivery")), binary(delivery, 512));
  try {
    if (key.length !== 32) return reject();
    const aead = createDecipheriv("aes-256-gcm", key, nonce);
    aead.setAAD(manifestBytes(m));
    aead.setAuthTag(data.subarray(-16));
    const body = Buffer.concat([aead.update(data.subarray(0, -16)), aead.final()]);
    if (digest(body) !== m.bodyDigest) {
      body.fill(0);
      return reject();
    }
    return body;
  } finally {
    key.fill(0);
  }
}
