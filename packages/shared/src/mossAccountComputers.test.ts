// FILE: mossAccountComputers.test.ts
// Purpose: The account's computer list and the phone's sign-in proof, as stored in user metadata.
// Layer: Shared pure logic tests
// Exports: none
import { describe, expect, it } from "vitest";

import {
  MOSS_COMPUTERS_MAX,
  MOSS_COMPUTERS_METADATA_KEY,
  MOSS_COMPUTER_REFRESH_MS,
  MOSS_COMPUTER_STALE_MS,
  MOSS_PHONE_LOGIN_PROOF_CLEARED,
  MOSS_PHONE_LOGIN_TTL_MS,
  mossAccountComputersRemoval,
  mossAccountComputersUpdate,
  mossPhoneLoginProof,
  normalizeMossComputerOrigin,
  readMossAccountComputers,
  readMossPhoneLoginProof,
  type MossAccountComputerSelf,
} from "./mossAccountComputers";

const NOW = Date.UTC(2026, 10, 11, 8, 0, 0);
const self: MossAccountComputerSelf = {
  id: "mac-1",
  name: "Studio Mac",
  platform: "darwin",
  origins: ["http://192.168.1.20:3773", "http://100.80.1.2:3773"],
  version: "1.0.5",
};

const apply = (metadata: Record<string, unknown>, update: Readonly<Record<string, unknown>>) => ({
  ...metadata,
  ...update,
});

describe("moss account computers", () => {
  it("lists a computer, then leaves a fresh identical entry alone", () => {
    const update = mossAccountComputersUpdate({ display_name: "Ada" }, self, NOW);
    expect(update).not.toBeNull();
    const metadata = apply({ display_name: "Ada" }, update!);

    expect(readMossAccountComputers(metadata, NOW)).toEqual([{ ...self, updatedAt: NOW }]);
    expect(mossAccountComputersUpdate(metadata, self, NOW + 60_000)).toBeNull();
    // Only its own key is written, so everything else in the metadata survives the merge.
    expect(Object.keys(update!)).toEqual([MOSS_COMPUTERS_METADATA_KEY]);
  });

  it("rewrites the entry when an address changes or the entry grows old", () => {
    const metadata = apply({}, mossAccountComputersUpdate({}, self, NOW)!);
    const moved = { ...self, origins: ["http://10.0.0.7:3773"] };

    const changed = mossAccountComputersUpdate(metadata, moved, NOW + 1_000);
    expect(readMossAccountComputers(apply(metadata, changed!), NOW + 1_000)[0]?.origins).toEqual([
      "http://10.0.0.7:3773",
    ]);
    expect(
      mossAccountComputersUpdate(metadata, self, NOW + MOSS_COMPUTER_REFRESH_MS + 1_000),
    ).not.toBeNull();
  });

  it("forgets stale and malformed entries and keeps the list short", () => {
    let metadata: Record<string, unknown> = {
      [MOSS_COMPUTERS_METADATA_KEY]: [
        {
          i: "old",
          n: "Old PC",
          p: "win32",
          o: [],
          v: "1",
          t: (NOW - MOSS_COMPUTER_STALE_MS) / 1000 - 5,
        },
        "garbage",
        { i: "no-name", t: NOW / 1000 },
      ],
    };
    expect(readMossAccountComputers(metadata, NOW)).toEqual([]);

    for (let index = 0; index < MOSS_COMPUTERS_MAX + 2; index += 1) {
      metadata = apply(
        metadata,
        mossAccountComputersUpdate(metadata, { ...self, id: `pc-${index}` }, NOW + index * 1_000)!,
      );
    }
    const listed = readMossAccountComputers(metadata, NOW + 60_000);
    expect(listed.map((computer) => computer.id)).toEqual(["pc-5", "pc-4", "pc-3", "pc-2"]);
  });

  it("accepts only plain http(s) origins and caps how many are kept", () => {
    expect(normalizeMossComputerOrigin("https://moss.example.com/path?x=1")).toBe(
      "https://moss.example.com",
    );
    expect(normalizeMossComputerOrigin("javascript:alert(1)")).toBeNull();
    expect(normalizeMossComputerOrigin("http://user:pw@host:1")).toBeNull();
    const update = mossAccountComputersUpdate(
      {},
      {
        ...self,
        origins: [
          "ftp://x",
          "http://a:1",
          "http://a:1",
          "http://b:1",
          "http://c:1",
          "http://d:1",
          "http://e:1",
        ],
      },
      NOW,
    );
    expect(readMossAccountComputers(apply({}, update!), NOW)[0]?.origins).toEqual([
      "http://a:1",
      "http://b:1",
      "http://c:1",
      "http://d:1",
    ]);
  });

  it("removes one computer and clears the key with the last one", () => {
    let metadata = apply({}, mossAccountComputersUpdate({}, self, NOW)!);
    metadata = apply(metadata, mossAccountComputersUpdate(metadata, { ...self, id: "pc-2" }, NOW)!);

    expect(mossAccountComputersRemoval(metadata, "nobody", NOW)).toBeNull();
    metadata = apply(metadata, mossAccountComputersRemoval(metadata, "mac-1", NOW)!);
    expect(readMossAccountComputers(metadata, NOW).map((computer) => computer.id)).toEqual([
      "pc-2",
    ]);
    expect(mossAccountComputersRemoval(metadata, "pc-2", NOW)).toEqual({
      [MOSS_COMPUTERS_METADATA_KEY]: null,
    });
  });
});

describe("moss phone login proof", () => {
  const phonePublicKey = "A".repeat(43);

  it("reads back a fresh code with its public key and ignores an old or cleared one", () => {
    const metadata = apply({}, mossPhoneLoginProof({ code: "code-123", phonePublicKey }, NOW));
    expect(readMossPhoneLoginProof(metadata, NOW + 30_000)).toEqual({
      code: "code-123",
      phonePublicKey,
    });
    expect(readMossPhoneLoginProof(metadata, NOW + MOSS_PHONE_LOGIN_TTL_MS + 120_000)).toBeNull();
    expect(
      readMossPhoneLoginProof(apply(metadata, MOSS_PHONE_LOGIN_PROOF_CLEARED), NOW),
    ).toBeNull();
    expect(readMossPhoneLoginProof({}, NOW)).toBeNull();
  });

  it("refuses a proof without a well-formed public key", () => {
    for (const k of [undefined, "", "short", `${phonePublicKey}=`, "!".repeat(43)]) {
      const metadata = { moss_phone_login: { c: "code-123", k, t: NOW / 1000 } };
      expect(readMossPhoneLoginProof(metadata, NOW)).toBeNull();
    }
  });
});

describe("moss account computers lifetime", () => {
  it("forgets an entry a computer could not remove after seven days", () => {
    const metadata = apply({}, mossAccountComputersUpdate({}, self, NOW)!);
    expect(MOSS_COMPUTER_STALE_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(readMossAccountComputers(metadata, NOW + MOSS_COMPUTER_STALE_MS - 1_000)).toHaveLength(
      1,
    );
    expect(readMossAccountComputers(metadata, NOW + MOSS_COMPUTER_STALE_MS + 1_000)).toEqual([]);
  });
});
