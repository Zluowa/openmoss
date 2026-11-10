/**
 * Credentials of 资料空间 links, personal (member) links, sites and access requests.
 *
 * Like guest share invites they are truncated HMACs under the guest-share signing key, so
 * nothing secret is stored: rotating a link (a new link id) or removing a member (deleting the
 * row) revokes every credential for it. Each kind has its own prefix in the signed text, so a
 * credential of one kind can never pass as another.
 *
 * - link:   `l.<sig("page-link:" + linkId)>`, in the link fragment.
 * - member: `m.<memberId>.<sig("page-member:" + memberId)>`, in the personal link fragment.
 * - site:   `s.<sig("page-site:" + linkId)>`, in the fragment of a 有链接 site.
 * - publisher host key: `relayHostKey(key, publisherShareId)`, as for thread shares.
 */
import { createHash, randomBytes } from "node:crypto";

import { base64UrlEncode, signPayload, timingSafeEqualBase64Url } from "../../auth/utils.ts";

const SIGNATURE_BYTES = 16;
const MEMBER_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

const sign = (key: Uint8Array, text: string): string =>
  base64UrlEncode(Buffer.from(signPayload(text, key), "base64url").subarray(0, SIGNATURE_BYTES));

/** 16 random bytes, base64url: link ids, site link ids, publisher share ids. */
export const randomShareId = (): string => base64UrlEncode(randomBytes(16));
export const randomMemberId = (): string => base64UrlEncode(randomBytes(12));
export const randomRequestSecret = (): string => base64UrlEncode(randomBytes(24));

export const linkCredential = (key: Uint8Array, linkId: string): string =>
  `l.${sign(key, `page-link:${linkId}`)}`;
export const siteCredential = (key: Uint8Array, linkId: string): string =>
  `s.${sign(key, `page-site:${linkId}`)}`;
export const memberCredential = (key: Uint8Array, memberId: string): string =>
  `m.${memberId}.${sign(key, `page-member:${memberId}`)}`;

export const isLinkCredential = (key: Uint8Array, linkId: string, credential: string): boolean => {
  const [kind, signature, extra] = credential.split(".");
  return (
    kind === "l" &&
    signature !== undefined &&
    extra === undefined &&
    timingSafeEqualBase64Url(signature, sign(key, `page-link:${linkId}`))
  );
};

export const isSiteCredential = (key: Uint8Array, linkId: string, credential: string): boolean => {
  const [kind, signature, extra] = credential.split(".");
  return (
    kind === "s" &&
    signature !== undefined &&
    extra === undefined &&
    timingSafeEqualBase64Url(signature, sign(key, `page-site:${linkId}`))
  );
};

/** The member a personal credential names, or null when it is not one or is forged. */
export const parseMemberCredential = (key: Uint8Array, credential: string): string | null => {
  const [kind, memberId, signature, extra] = credential.split(".");
  if (kind !== "m" || memberId === undefined || signature === undefined || extra !== undefined) {
    return null;
  }
  if (!MEMBER_ID_PATTERN.test(memberId)) return null;
  return timingSafeEqualBase64Url(signature, sign(key, `page-member:${memberId}`))
    ? memberId
    : null;
};

export const hashRequestSecret = (secret: string): string =>
  createHash("sha256").update(`page-access-request:${secret}`).digest("base64url");
