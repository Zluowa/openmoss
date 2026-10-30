/**
 * Guest share credentials are HMACs of the share id under a server key, so nothing secret is
 * stored and replacing or closing a share revokes every credential for it.
 *
 * - invite: `<shareId>.<base64url(trunc16(HMAC(key, "guest-invite:" + shareId)))>`, in the link
 *   fragment. A truncated HMAC keeps links short; 128 bits is still far beyond guessing range.
 * - host key: `base64url(HMAC(key, "relay-host:" + shareId))`, proven to the relay.
 * - session: signed claims `{kind:"session", threadId, shareId}`, in the guest cookie.
 */
import { createHash } from "node:crypto";

import { GuestShareId, ThreadId } from "@synara/contracts";
import { Schema } from "effect";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";

export const GUEST_SHARE_SIGNING_SECRET_NAME = "guest-share-signing-key";
export const GUEST_SHARE_SIGNING_KEY_BYTES = 32;
const INVITE_SIGNATURE_BYTES = 16;

export const GuestSessionClaims = Schema.Struct({
  kind: Schema.Literal("session"),
  threadId: ThreadId,
  shareId: GuestShareId,
});
export type GuestSessionClaims = typeof GuestSessionClaims.Type;

const decodeSessionClaims = Schema.decodeUnknownOption(Schema.fromJsonString(GuestSessionClaims));
const isGuestShareId = Schema.is(GuestShareId);

const splitToken = (token: string) => {
  const [payload, signature, extra] = token.split(".");
  return payload && signature && extra === undefined ? { payload, signature } : null;
};

const inviteSignature = (key: Uint8Array, shareId: string): string =>
  base64UrlEncode(
    Buffer.from(signPayload(`guest-invite:${shareId}`, key), "base64url").subarray(
      0,
      INVITE_SIGNATURE_BYTES,
    ),
  );

export function guestInviteCredential(key: Uint8Array, shareId: GuestShareId): string {
  return `${shareId}.${inviteSignature(key, shareId)}`;
}

/** The share an invite names, or null when the credential is malformed or forged. */
export function parseGuestInviteCredential(
  key: Uint8Array,
  credential: string,
): GuestShareId | null {
  const parts = splitToken(credential);
  if (parts === null || !isGuestShareId(parts.payload)) return null;
  return timingSafeEqualBase64Url(parts.signature, inviteSignature(key, parts.payload))
    ? parts.payload
    : null;
}

export function relayHostKey(key: Uint8Array, shareId: GuestShareId): string {
  return signPayload(`relay-host:${shareId}`, key);
}

/** What the relay stores: base64url (no padding) SHA-256 of the host key. */
export function relayHostKeyHash(hostKey: string): string {
  return createHash("sha256").update(hostKey).digest("base64url");
}

export function signGuestSession(key: Uint8Array, claims: GuestSessionClaims): string {
  const payload = base64UrlEncode(JSON.stringify(claims));
  return `${payload}.${signPayload(payload, key)}`;
}

/** The claims of a session token, or null when it is malformed or forged. */
export function verifyGuestSession(key: Uint8Array, token: string): GuestSessionClaims | null {
  const parts = splitToken(token);
  if (parts === null) return null;
  if (!timingSafeEqualBase64Url(parts.signature, signPayload(parts.payload, key))) return null;
  const claims = decodeSessionClaims(base64UrlDecodeUtf8(parts.payload));
  return claims._tag === "Some" ? claims.value : null;
}
