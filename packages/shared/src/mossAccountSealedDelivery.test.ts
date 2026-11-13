// FILE: mossAccountSealedDelivery.test.ts
// Purpose: The sealed delivery wire format, fixed by vectors the phone app re-runs with @noble.
// Layer: Shared runtime tests
// Exports: none (the phone app copies MOSS_ACCOUNT_SEALED_VECTORS into its own test)
import { createHash, randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  decodeMossPhonePublicKey,
  mossAccountCheckCode,
  openMossAccountSession,
  sealMossAccountSession,
  x25519PublicKeyOf,
} from "./mossAccountSealedDelivery";

const hex = (value: string) => new Uint8Array(Buffer.from(value, "hex"));
const utf8 = (value: string) => new TextEncoder().encode(value);
const text = (value: Uint8Array) => new TextDecoder().decode(value);

/**
 * Inputs and expected outputs of one sealing. The values were produced by this module and
 * re-derived independently with @noble/curves, @noble/hashes and @noble/ciphers (gcm). The phone
 * app's test must reproduce `phonePublicKey`, `checkCode`, `envelope` and `plaintext`.
 */
const MOSS_ACCOUNT_SEALED_VECTORS = {
  phonePrivateKeyHex: "a8abababababababababababababababababababababababababababababab6b",
  ephemeralPrivateKeyHex: "c8cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd4d",
  nonceHex: "000102030405060708090a0b",
  requestId: "req-0001",
  challengeCode: "Q2hhbGxlbmdlLWNvZGUtZm9yLXRlc3QtdmVjdG9ycw",
  checkNonceHex: "f0e1d2c3b4a5968778695a4b3c2d1e0f",
  plaintext: '{"sessionToken":"fake-session-token"}',
  phonePublicKey: "43EthRoOXXm4McXjSrIrQaGYFx3iCbi4-sojoRxiSFk",
  checkCode: "0476",
  envelope: {
    v: 3,
    epk: "tb6oI9nJ_1dgkcVLfFlsCuKWiE8OFQKQ6IRV1_umEm8",
    n: "AAECAwQFBgcICQoL",
    ct: "NgQEYBs9dAZXkH3o2EdHKGz9TmSvvAYrQ1wml6o401MLMhYU2sORQrndzsv7PnnAkfkAAUE",
  },
} as const;

const vectors = MOSS_ACCOUNT_SEALED_VECTORS;
const phonePrivateKey = hex(vectors.phonePrivateKeyHex);
const phonePublicKey = x25519PublicKeyOf(phonePrivateKey);
const checkNonce = hex(vectors.checkNonceHex);

describe("account sign-in sealed delivery", () => {
  it("matches the published vectors", async () => {
    expect(Buffer.from(phonePublicKey).toString("base64url")).toBe(vectors.phonePublicKey);
    expect(mossAccountCheckCode(vectors.challengeCode, phonePublicKey, checkNonce)).toBe(
      vectors.checkCode,
    );
    const envelope = await sealMossAccountSession({
      phonePublicKey,
      requestId: vectors.requestId,
      plaintext: utf8(vectors.plaintext),
      ephemeralPrivateKey: hex(vectors.ephemeralPrivateKeyHex),
      nonce: hex(vectors.nonceHex),
    });
    expect(envelope).toEqual(vectors.envelope);
    const opened = await openMossAccountSession({
      phonePrivateKey,
      requestId: vectors.requestId,
      envelope: vectors.envelope,
    });
    expect(text(opened)).toBe(vectors.plaintext);
  });

  it("gives a relaying device nothing it can decrypt", async () => {
    // The relay saw every byte the computer sent and holds a key pair of its own.
    const envelope = await sealMossAccountSession({
      phonePublicKey,
      requestId: "req-relay",
      plaintext: utf8('{"sessionToken":"fake-owner-session"}'),
    });
    const relayPrivateKey = hex("1".repeat(64));
    await expect(
      openMossAccountSession({
        phonePrivateKey: relayPrivateKey,
        requestId: "req-relay",
        envelope,
      }),
    ).rejects.toThrow("cannot be read");
    expect(JSON.stringify(envelope)).not.toContain("fake-owner-session");
    // Only the phone that made the attempt can open it.
    const opened = await openMossAccountSession({
      phonePrivateKey,
      requestId: "req-relay",
      envelope,
    });
    expect(text(opened)).toContain("fake-owner-session");
  });

  it("refuses an envelope of the unshipped versions 1 and 2", async () => {
    for (const v of [1, 2]) {
      await expect(
        openMossAccountSession({
          phonePrivateKey,
          requestId: vectors.requestId,
          envelope: { ...vectors.envelope, v } as unknown as typeof vectors.envelope,
        }),
      ).rejects.toThrow("cannot be read");
    }
  });

  it("refuses an envelope moved to another request or altered on the way", async () => {
    const envelope = await sealMossAccountSession({
      phonePublicKey,
      requestId: "req-a",
      plaintext: utf8("secret"),
    });
    await expect(
      openMossAccountSession({ phonePrivateKey, requestId: "req-b", envelope }),
    ).rejects.toThrow("cannot be read");
    const flipped = envelope.ct.startsWith("A")
      ? `B${envelope.ct.slice(1)}`
      : `A${envelope.ct.slice(1)}`;
    await expect(
      openMossAccountSession({
        phonePrivateKey,
        requestId: "req-a",
        envelope: { ...envelope, ct: flipped },
      }),
    ).rejects.toThrow("cannot be read");
  });

  it("changes the check code when the public key, the challenge or the nonce changes", () => {
    const swapped = x25519PublicKeyOf(hex("2".repeat(64)));
    const code = (challenge: string, key: Uint8Array, nonce: Uint8Array) =>
      mossAccountCheckCode(challenge, key, nonce);
    expect(code(vectors.challengeCode, swapped, checkNonce)).not.toBe(vectors.checkCode);
    expect(code(`${vectors.challengeCode}x`, phonePublicKey, checkNonce)).not.toBe(
      vectors.checkCode,
    );
    // Two requests with the same challenge code and key but different nonces.
    expect(code(vectors.challengeCode, phonePublicKey, new Uint8Array(16))).not.toBe(
      vectors.checkCode,
    );
    expect(code(vectors.challengeCode, phonePublicKey, checkNonce)).toMatch(/^\d{4}$/u);
    expect(() => code(vectors.challengeCode, phonePublicKey, new Uint8Array(8))).toThrow();
  });

  it("makes a key ground in advance match only by chance once the computer's nonce is in", () => {
    // The attack the nonce closes: someone with the account reads the owner's proof, and
    // grinds a key whose code (by the formula without a nonce) equals the owner's.
    const withoutNonce = (challenge: string, key: Uint8Array) =>
      String(
        createHash("sha256").update(challenge).update(key).digest().readUInt32BE(0) % 10_000,
      ).padStart(4, "0");
    const challenge = "fake-challenge-code";
    const ownerCode = withoutNonce(challenge, phonePublicKey);
    let ground: Uint8Array | null = null;
    for (let attempt = 0; attempt < 400_000 && !ground; attempt += 1) {
      const candidate = new Uint8Array(randomBytes(32));
      if (withoutNonce(challenge, candidate) === ownerCode) ground = candidate;
    }
    expect(ground).not.toBeNull();
    // With a nonce drawn after the key is fixed, the ground key shows the owner's code about
    // one time in 10,000 (the expected count over 100,000 nonces is 10).
    const target = mossAccountCheckCode(challenge, phonePublicKey, checkNonce);
    let matches = 0;
    for (let draw = 0; draw < 100_000; draw += 1) {
      if (mossAccountCheckCode(challenge, ground!, new Uint8Array(randomBytes(16))) === target) {
        matches += 1;
      }
    }
    expect(matches).toBeLessThan(40);
  });

  it("refuses a public key that is malformed or of low order", async () => {
    expect(decodeMossPhonePublicKey(vectors.phonePublicKey)).toEqual(phonePublicKey);
    expect(decodeMossPhonePublicKey("short")).toBeNull();
    expect(decodeMossPhonePublicKey(`${vectors.phonePublicKey}=`)).toBeNull();
    await expect(
      sealMossAccountSession({
        phonePublicKey: new Uint8Array(32),
        requestId: "req-zero",
        plaintext: utf8("secret"),
      }),
    ).rejects.toThrow("cannot be used");
  });
});
