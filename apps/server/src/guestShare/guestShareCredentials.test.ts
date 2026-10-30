import { GuestShareId, ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  guestInviteCredential,
  parseGuestInviteCredential,
  relayHostKey,
  relayHostKeyHash,
  signGuestSession,
  verifyGuestSession,
} from "./guestShareCredentials.ts";

const KEY = Uint8Array.from({ length: 32 }, (_, index) => index);
const OTHER_KEY = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const SHARE_ID = GuestShareId.makeUnsafe("AAAAAAAAAAAAAAAAAAAAAA");
const THREAD_ID = ThreadId.makeUnsafe("thread-1");

describe("invite credential", () => {
  it("is the share id plus a short signature and verifies under the same key", () => {
    const credential = guestInviteCredential(KEY, SHARE_ID);
    const [shareId, signature, extra] = credential.split(".");
    expect(shareId).toBe(SHARE_ID);
    expect(signature).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(extra).toBeUndefined();
    expect(parseGuestInviteCredential(KEY, credential)).toBe(SHARE_ID);
  });

  it("rejects a forged, foreign, or malformed credential", () => {
    const credential = guestInviteCredential(KEY, SHARE_ID);
    expect(parseGuestInviteCredential(OTHER_KEY, credential)).toBeNull();
    expect(parseGuestInviteCredential(KEY, `${SHARE_ID}.AAAAAAAAAAAAAAAAAAAAAA`)).toBeNull();
    expect(parseGuestInviteCredential(KEY, `${credential}.extra`)).toBeNull();
    expect(parseGuestInviteCredential(KEY, "not-a-share-id.sig")).toBeNull();
    expect(parseGuestInviteCredential(KEY, "")).toBeNull();
  });
});

describe("relay host key", () => {
  it("derives a stable key per share and a 43-character base64url hash", () => {
    const hostKey = relayHostKey(KEY, SHARE_ID);
    expect(relayHostKey(KEY, SHARE_ID)).toBe(hostKey);
    expect(relayHostKey(OTHER_KEY, SHARE_ID)).not.toBe(hostKey);
    expect(relayHostKeyHash(hostKey)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("session token", () => {
  it("round-trips signed claims and rejects tampering", () => {
    const claims = { kind: "session", threadId: THREAD_ID, shareId: SHARE_ID } as const;
    const token = signGuestSession(KEY, claims);
    expect(verifyGuestSession(KEY, token)).toEqual(claims);
    expect(verifyGuestSession(OTHER_KEY, token)).toBeNull();
    const [payload, signature] = token.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ ...claims, threadId: "thread-2" })).toString(
      "base64url",
    );
    expect(verifyGuestSession(KEY, `${forgedPayload}.${signature}`)).toBeNull();
    expect(verifyGuestSession(KEY, `${payload}`)).toBeNull();
    expect(verifyGuestSession(KEY, "")).toBeNull();
  });
});
