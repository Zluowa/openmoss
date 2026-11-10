// FILE: third-party-notices.test.ts
// Purpose: The packaged app ships only THIRD_PARTY_NOTICES.md, so every vendored upstream
//          NOTICE and the licenses of ported Mossbot code must appear in it verbatim.
// Layer: Release compliance test

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const notices = readFileSync(join(repoRoot, "THIRD_PARTY_NOTICES.md"), "utf8");
const normalize = (text: string) => text.replace(/\r\n/g, "\n").trim();

describe("THIRD_PARTY_NOTICES.md", () => {
  it("reproduces every vendored UPSTREAM-NOTICE in full", () => {
    const thirdParty = join(repoRoot, "third_party");
    const upstream = readdirSync(thirdParty)
      .map((name) => join(thirdParty, name, "UPSTREAM-NOTICE"))
      .filter((file) => existsSync(file));
    expect(upstream.length).toBeGreaterThan(0);
    for (const file of upstream) {
      expect(notices.includes(normalize(readFileSync(file, "utf8"))), file).toBe(true);
    }
  });

  it("carries the licenses of the Mossbot ports", () => {
    for (const license of ["third_party/openmaus/LICENSE", "third_party/threebot/LICENSE"]) {
      expect(
        notices.includes(normalize(readFileSync(join(repoRoot, license), "utf8"))),
        license,
      ).toBe(true);
    }
  });
});
