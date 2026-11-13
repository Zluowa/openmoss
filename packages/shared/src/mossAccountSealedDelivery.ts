// FILE: mossAccountSealedDelivery.ts
// Purpose: Seals the session a computer hands a phone after an account sign-in, so only the
//   phone that started the attempt can read it, and derives the check code both screens show.
// Layer: Shared runtime (server side; `node:crypto` only, no other dependency)
// Exports: MOSS_ACCOUNT_SEALED_INFO, MossAccountSealedEnvelope, decodeMossPhonePublicKey,
//   isUsableMossPhonePublicKey, newMossAccountCheckNonce, mossAccountCheckCode,
//   sealMossAccountSession, openMossAccountSession, x25519PublicKeyOf
// Why: the phone may reach the computer over plain HTTP, through an address another device
//   can take over. The phone's public key travels only through the account service (HTTPS,
//   the phone's own account session), so a device that relays the computer's address sees
//   nothing it can decrypt. The check code also folds in a nonce the computer draws only
//   after it has read the phone's key from the account, so a key chosen in advance (to make
//   another phone's code appear) matches only by chance, one time in 10,000.
//
// Wire format, version 3. Every value is base64url without padding unless said otherwise.
// The phone implements the same steps with @noble/curves (x25519), @noble/hashes (sha256,
// hkdf) and @noble/ciphers (gcm); the vectors in the unit test are the contract. Versions 1
// and 2 never shipped; their labels differ, so an older peer fails closed.
//
//   Phone, per attempt:
//     phoneKeyPair = fresh X25519 key pair.
//     It writes `moss_phone_login: { c: challengeCode, k: b64url(phonePublic), t: seconds }`
//     into its own account's user metadata (see mossAccountComputers.ts).
//
//   Check code (both sides; 4 decimal digits):
//     nonce     = 16 random bytes the computer draws in /request, after reading phonePublic
//                 from the account; /request returns it as `checkNonce` (b64url).
//     digest    = SHA-256( utf8("moss account check v3:") || utf8(challengeCode) || 0x00
//                          || phonePublic (32 raw bytes) || nonce (16 raw bytes) )
//     checkCode = (big-endian uint32 of digest[0..4]) mod 10000, left-padded with "0" to 4.
//   The phone shows its code only once /request has returned the nonce.
//
//   Sealing (computer):
//     ephemeral = fresh X25519 key pair.
//     shared    = X25519(ephemeral.private, phonePublic); an all-zero result is refused.
//     key       = HKDF-SHA-256(ikm = shared, salt = ephemeralPublic || phonePublic,
//                              info = utf8("moss account sign-in v3"), length = 32)
//     nonce     = 12 random bytes, fresh for every envelope.
//     aad       = utf8("moss account sign-in v3:" + requestId)
//     sealed    = AES-256-GCM(key, nonce, aad, plaintext)              (ciphertext || 16-byte tag)
//     envelope  = { v: 3, epk: b64url(ephemeralPublic), n: b64url(nonce), ct: b64url(sealed) }
//
//   Opening (phone): shared = X25519(phone.private, epk); same key, nonce and aad; decrypt.
//   The plaintext is the UTF-8 JSON of the bearer session the computer issued
//   (`AuthBearerBootstrapResult`: authenticated, role, sessionMethod, expiresAt, sessionToken).
//
// Everything here is stable `node:crypto` (X25519 key objects, hkdfSync, createCipheriv with
// aes-256-gcm), available alike in Node, in Electron's Node (BoringSSL) and in bun.
import * as Crypto from "node:crypto";

export const MOSS_ACCOUNT_SEALED_VERSION = 3 as const;
export const MOSS_ACCOUNT_SEALED_INFO = "moss account sign-in v3";
const CHECK_CODE_LABEL = "moss account check v3:";
/** Bytes of the computer's check-code nonce. */
export const MOSS_ACCOUNT_CHECK_NONCE_BYTES = 16;

export interface MossAccountSealedEnvelope {
  readonly v: typeof MOSS_ACCOUNT_SEALED_VERSION;
  /** The computer's ephemeral X25519 public key. */
  readonly epk: string;
  /** The 12-byte AES-GCM nonce. */
  readonly n: string;
  /** Ciphertext followed by the 16-byte tag. */
  readonly ct: string;
}

export class MossAccountSealError extends Error {
  override readonly name = "MossAccountSealError";
}

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/u;
// DER prefixes that wrap a raw X25519 key as SPKI (public) or PKCS#8 (private).
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const CIPHER = "aes-256-gcm";

const encoder = new TextEncoder();

const toBase64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

function fromBase64Url(value: string, expectedBytes?: number): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) return null;
  const bytes = new Uint8Array(Buffer.from(value, "base64url"));
  if (toBase64Url(bytes) !== value) return null;
  if (expectedBytes !== undefined && bytes.length !== expectedBytes) return null;
  return bytes;
}

/** The phone's X25519 public key from the proof, or null when it is not 32 base64url bytes. */
export function decodeMossPhonePublicKey(value: string): Uint8Array | null {
  return BASE64URL_32.test(value) ? fromBase64Url(value, KEY_BYTES) : null;
}

function publicKeyObject(raw: Uint8Array): Crypto.KeyObject {
  return Crypto.createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

function privateKeyObject(raw: Uint8Array): Crypto.KeyObject {
  return Crypto.createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, raw]),
    format: "der",
    type: "pkcs8",
  });
}

function rawPublicKey(key: Crypto.KeyObject): Uint8Array {
  const der = key.export({ format: "der", type: "spki" });
  return new Uint8Array(der.subarray(der.length - KEY_BYTES));
}

/** The X25519 public key of a raw private key (tests and reference use). */
export function x25519PublicKeyOf(privateKey: Uint8Array): Uint8Array {
  return rawPublicKey(Crypto.createPublicKey(privateKeyObject(privateKey)));
}

function sharedSecret(privateKey: Crypto.KeyObject, publicKey: Uint8Array): Uint8Array {
  let shared: Uint8Array;
  try {
    shared = new Uint8Array(
      Crypto.diffieHellman({ privateKey, publicKey: publicKeyObject(publicKey) }),
    );
  } catch {
    // OpenSSL and BoringSSL both refuse low-order points that give an all-zero secret.
    throw new MossAccountSealError("The phone's key cannot be used.");
  }
  if (shared.every((byte) => byte === 0)) {
    throw new MossAccountSealError("The phone's key cannot be used.");
  }
  return shared;
}

function deriveKey(
  shared: Uint8Array,
  ephemeralPublic: Uint8Array,
  phonePublic: Uint8Array,
): Uint8Array {
  return new Uint8Array(
    Crypto.hkdfSync(
      "sha256",
      shared,
      Buffer.concat([ephemeralPublic, phonePublic]),
      encoder.encode(MOSS_ACCOUNT_SEALED_INFO),
      KEY_BYTES,
    ),
  );
}

const additionalData = (requestId: string) =>
  encoder.encode(`${MOSS_ACCOUNT_SEALED_INFO}:${requestId}`);

/** False for a key no session can be sealed to (a low-order point gives no shared secret). */
export function isUsableMossPhonePublicKey(phonePublicKey: Uint8Array): boolean {
  if (phonePublicKey.length !== KEY_BYTES) return false;
  try {
    sharedSecret(Crypto.generateKeyPairSync("x25519").privateKey, phonePublicKey);
    return true;
  } catch {
    return false;
  }
}

/** A fresh check-code nonce, drawn after the phone's key is fixed. */
export function newMossAccountCheckNonce(): Uint8Array {
  return new Uint8Array(Crypto.randomBytes(MOSS_ACCOUNT_CHECK_NONCE_BYTES));
}

/** The 4-digit code both the phone and the computer show for one attempt. */
export function mossAccountCheckCode(
  challengeCode: string,
  phonePublicKey: Uint8Array,
  checkNonce: Uint8Array,
): string {
  if (phonePublicKey.length !== KEY_BYTES || checkNonce.length !== MOSS_ACCOUNT_CHECK_NONCE_BYTES) {
    throw new MossAccountSealError("Invalid check-code input.");
  }
  const digest = Crypto.createHash("sha256")
    .update(encoder.encode(CHECK_CODE_LABEL))
    .update(encoder.encode(challengeCode))
    .update(new Uint8Array([0]))
    .update(phonePublicKey)
    .update(checkNonce)
    .digest();
  return String(digest.readUInt32BE(0) % 10_000).padStart(4, "0");
}

/**
 * Seals `plaintext` to the phone's public key. `ephemeralPrivateKey` and `nonce` are for the
 * test vectors only; leave them out so each envelope gets fresh randomness.
 */
export async function sealMossAccountSession(input: {
  readonly phonePublicKey: Uint8Array;
  readonly requestId: string;
  readonly plaintext: Uint8Array;
  readonly ephemeralPrivateKey?: Uint8Array;
  readonly nonce?: Uint8Array;
}): Promise<MossAccountSealedEnvelope> {
  if (input.phonePublicKey.length !== KEY_BYTES) {
    throw new MossAccountSealError("The phone's key cannot be used.");
  }
  const ephemeralPrivate = input.ephemeralPrivateKey
    ? privateKeyObject(input.ephemeralPrivateKey)
    : Crypto.generateKeyPairSync("x25519").privateKey;
  const ephemeralPublic = rawPublicKey(Crypto.createPublicKey(ephemeralPrivate));
  const shared = sharedSecret(ephemeralPrivate, input.phonePublicKey);
  const key = deriveKey(shared, ephemeralPublic, input.phonePublicKey);
  const nonce = input.nonce ?? new Uint8Array(Crypto.randomBytes(NONCE_BYTES));
  if (nonce.length !== NONCE_BYTES) throw new MossAccountSealError("Invalid nonce.");
  const cipher = Crypto.createCipheriv(CIPHER, key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(additionalData(input.requestId));
  const sealed = Buffer.concat([
    cipher.update(input.plaintext),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    v: MOSS_ACCOUNT_SEALED_VERSION,
    epk: toBase64Url(ephemeralPublic),
    n: toBase64Url(nonce),
    ct: toBase64Url(new Uint8Array(sealed)),
  };
}

/** Opens an envelope with the phone's private key; throws when it was not sealed to it. */
export async function openMossAccountSession(input: {
  readonly phonePrivateKey: Uint8Array;
  readonly requestId: string;
  readonly envelope: MossAccountSealedEnvelope;
}): Promise<Uint8Array> {
  const { envelope } = input;
  const ephemeralPublic = fromBase64Url(envelope.epk, KEY_BYTES);
  const nonce = fromBase64Url(envelope.n, NONCE_BYTES);
  const sealed = fromBase64Url(envelope.ct);
  if (envelope.v !== MOSS_ACCOUNT_SEALED_VERSION || !ephemeralPublic || !nonce || !sealed) {
    throw new MossAccountSealError("This sign-in reply cannot be read.");
  }
  if (sealed.length < TAG_BYTES)
    throw new MossAccountSealError("This sign-in reply cannot be read.");
  const phonePrivate = privateKeyObject(input.phonePrivateKey);
  const phonePublic = rawPublicKey(Crypto.createPublicKey(phonePrivate));
  const key = deriveKey(sharedSecret(phonePrivate, ephemeralPublic), ephemeralPublic, phonePublic);
  try {
    const decipher = Crypto.createDecipheriv(CIPHER, key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(additionalData(input.requestId));
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    return new Uint8Array(
      Buffer.concat([
        decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)),
        decipher.final(),
      ]),
    );
  } catch {
    throw new MossAccountSealError("This sign-in reply cannot be read.");
  }
}
