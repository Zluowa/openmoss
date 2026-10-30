import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  canonicalizeCodexHomeIdentityPath,
  uniqueCodexLifecycleHomeIdentityPaths,
} from "./codexHomeIdentity.ts";

let root: string;

function directoryIsCaseSensitive(directory: string): boolean {
  const exactProbe = path.join(directory, "CaseSensitivityProbe");
  const variantProbe = path.join(directory, "casesensitivityprobe");
  mkdirSync(exactProbe);
  try {
    mkdirSync(variantProbe);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "moss-codex-home-identity-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("Codex home filesystem identity", () => {
  it("canonicalizes a missing suffix through the nearest real symlink ancestor", () => {
    const realHome = path.join(root, "real-home");
    const linkedHome = path.join(root, "linked-home");
    const runtimeHome = path.join(root, "runtime");
    mkdirSync(realHome, { recursive: true });
    writeFileSync(path.join(realHome, ".identity-case-probe"), "probe", "utf8");
    symlinkSync(realHome, linkedHome, process.platform === "win32" ? "junction" : "dir");

    const realMissingHome = path.join(realHome, "missing", "account-home");
    const linkedMissingHome = path.join(linkedHome, "missing", "account-home");
    const expectedIdentity = canonicalizeCodexHomeIdentityPath(realMissingHome);

    expect(canonicalizeCodexHomeIdentityPath(linkedMissingHome)).toBe(expectedIdentity);
    expect(canonicalizeCodexHomeIdentityPath(realMissingHome)).toBe(expectedIdentity);

    const environment = { MOSS_HOME: runtimeHome };
    const linkedSourceIdentities = uniqueCodexLifecycleHomeIdentityPaths({
      homePath: linkedMissingHome,
      accountId: "managed-account",
      environment,
    });
    const realSourceIdentities = uniqueCodexLifecycleHomeIdentityPaths({
      homePath: realMissingHome,
      accountId: "managed-account",
      environment,
    });
    const linkedShadowIdentities = uniqueCodexLifecycleHomeIdentityPaths({
      shadowHomePath: linkedMissingHome,
      accountId: "managed-account",
      environment,
    });
    const realShadowIdentities = uniqueCodexLifecycleHomeIdentityPaths({
      shadowHomePath: realMissingHome,
      accountId: "managed-account",
      environment,
    });

    // Lifecycle locks, teardown matching, and generation tombstones all use
    // this shared identity set. Textual source and pure-shadow aliases must
    // therefore overlap on the same canonical missing account home.
    expect(linkedSourceIdentities).toContain(expectedIdentity);
    expect(realSourceIdentities).toContain(expectedIdentity);
    expect(linkedShadowIdentities).toContain(expectedIdentity);
    expect(realShadowIdentities).toContain(expectedIdentity);
  });

  it("canonicalizes a new managed overlay account under an empty accounts directory", () => {
    const accountsHome = path.join(root, ".moss", "codex-home-overlay", "accounts");
    const accountHome = path.join(accountsHome, "moss-b7566344dd59");
    mkdirSync(accountsHome, { recursive: true });

    expect(readdirSync(accountsHome)).toEqual([]);
    const identityBeforeCreation = canonicalizeCodexHomeIdentityPath(accountHome);

    // The case probe is temporary and must not become account data.
    expect(readdirSync(accountsHome)).toEqual([]);
    mkdirSync(accountHome);
    expect(canonicalizeCodexHomeIdentityPath(accountHome)).toBe(identityBeforeCreation);
  });

  it("keeps safe missing-leaf ASCII case aliases on the same lifecycle identity", () => {
    const realHome = path.join(root, "case-home");
    const runtimeHome = path.join(root, "runtime");
    mkdirSync(realHome, { recursive: true });
    const caseSensitive = directoryIsCaseSensitive(realHome);
    const exactHome = path.join(realHome, "FutureHome");
    const aliasHome = path.join(realHome, "futurehome");

    const exactIdentityBeforeCreation = canonicalizeCodexHomeIdentityPath(exactHome);
    const aliasIdentityBeforeCreation = canonicalizeCodexHomeIdentityPath(aliasHome);

    if (caseSensitive) {
      expect(aliasIdentityBeforeCreation).not.toBe(exactIdentityBeforeCreation);
    } else {
      expect(aliasIdentityBeforeCreation).toBe(exactIdentityBeforeCreation);
    }

    mkdirSync(exactHome);

    expect(canonicalizeCodexHomeIdentityPath(exactHome)).toBe(exactIdentityBeforeCreation);
    const environment = { MOSS_HOME: runtimeHome };
    if (caseSensitive) {
      mkdirSync(aliasHome);
      expect(canonicalizeCodexHomeIdentityPath(aliasHome)).toBe(aliasIdentityBeforeCreation);
      expect(canonicalizeCodexHomeIdentityPath(aliasHome)).not.toBe(exactIdentityBeforeCreation);
      expect(
        uniqueCodexLifecycleHomeIdentityPaths({
          homePath: exactHome,
          accountId: "managed-account",
          environment,
        }),
      ).toContain(exactIdentityBeforeCreation);
      expect(
        uniqueCodexLifecycleHomeIdentityPaths({
          shadowHomePath: aliasHome,
          accountId: "managed-account",
          environment,
        }),
      ).toContain(aliasIdentityBeforeCreation);
    } else {
      expect(canonicalizeCodexHomeIdentityPath(aliasHome)).toBe(exactIdentityBeforeCreation);

      expect(
        uniqueCodexLifecycleHomeIdentityPaths({
          homePath: exactHome,
          accountId: "managed-account",
          environment,
        }),
      ).toContain(exactIdentityBeforeCreation);
      expect(
        uniqueCodexLifecycleHomeIdentityPaths({
          shadowHomePath: aliasHome,
          accountId: "managed-account",
          environment,
        }),
      ).toContain(exactIdentityBeforeCreation);
    }
  });

  it("fails closed for missing-leaf NFC and NFD spellings", () => {
    const realHome = path.join(root, "unicode-home");
    const runtimeHome = path.join(root, "runtime");
    mkdirSync(realHome, { recursive: true });
    const nfcHome = path.join(realHome, "Caf\u00e9Home");
    const nfdHome = path.join(realHome, "Cafe\u0301Home");

    const environment = { MOSS_HOME: runtimeHome };
    for (const unsafeHome of [nfcHome, nfdHome]) {
      expect(() => canonicalizeCodexHomeIdentityPath(unsafeHome)).toThrow(/only ASCII/);
      expect(() =>
        uniqueCodexLifecycleHomeIdentityPaths({
          homePath: unsafeHome,
          accountId: "managed-account",
          environment,
        }),
      ).toThrow(/only ASCII/);
      expect(() =>
        uniqueCodexLifecycleHomeIdentityPaths({
          shadowHomePath: unsafeHome,
          accountId: "managed-account",
          environment,
        }),
      ).toThrow(/only ASCII/);
    }

    // Unicode is rejected only while unresolved. Once the filesystem owns the
    // spelling, realpath is authoritative for aliases of that existing object.
    mkdirSync(nfcHome);
    expect(() => canonicalizeCodexHomeIdentityPath(nfcHome)).not.toThrow();
  });

  it("rejects a missing sharp-s spelling instead of colliding it with safe ASCII SS", () => {
    const realHome = path.join(root, "sharp-s-home");
    const runtimeHome = path.join(root, "runtime");
    mkdirSync(realHome, { recursive: true });
    writeFileSync(path.join(realHome, ".identity-case-probe"), "probe", "utf8");
    const asciiHome = path.join(realHome, "STRASSE");
    const sharpSHome = path.join(realHome, "stra\u00dfe");
    const asciiIdentity = canonicalizeCodexHomeIdentityPath(asciiHome);
    const environment = { MOSS_HOME: runtimeHome };

    expect(() => canonicalizeCodexHomeIdentityPath(sharpSHome)).toThrow(/only ASCII/);
    expect(() =>
      uniqueCodexLifecycleHomeIdentityPaths({
        homePath: sharpSHome,
        accountId: "managed-account",
        environment,
      }),
    ).toThrow(/only ASCII/);
    expect(
      uniqueCodexLifecycleHomeIdentityPaths({
        homePath: asciiHome,
        accountId: "release-account_01",
        environment,
      }),
    ).toContain(asciiIdentity);
  });

  it("preserves distinct existing NFC and NFD filesystem objects", () => {
    const realHome = path.join(root, "existing-unicode-home");
    mkdirSync(realHome, { recursive: true });
    const nfcHome = path.join(realHome, "caf\u00e9");
    const nfdHome = path.join(realHome, "cafe\u0301");
    mkdirSync(nfcHome);

    let normalizationSensitive = true;
    try {
      mkdirSync(nfdHome);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        normalizationSensitive = false;
      } else {
        throw error;
      }
    }

    const nfcIdentity = canonicalizeCodexHomeIdentityPath(nfcHome);
    const nfdIdentity = canonicalizeCodexHomeIdentityPath(nfdHome);
    if (normalizationSensitive) {
      expect(nfdIdentity).not.toBe(nfcIdentity);
    } else {
      expect(nfdIdentity).toBe(nfcIdentity);
    }
  });

  it("uses a removable probe for an empty ancestor but still refuses to probe the root", () => {
    const emptyAncestor = path.join(root, "empty-ancestor");
    mkdirSync(emptyAncestor);
    const rootPath = path.parse(root).root;
    const rootOnlyMissingHome = path.join(
      rootPath,
      `MossCodexRootProbe-${process.pid}-${Date.now()}`,
    );

    expect(() =>
      canonicalizeCodexHomeIdentityPath(path.join(emptyAncestor, "FutureHome")),
    ).not.toThrow();
    expect(readdirSync(emptyAncestor)).toEqual([]);
    expect(() => canonicalizeCodexHomeIdentityPath(rootOnlyMissingHome)).toThrow(
      /Cannot safely determine filesystem case sensitivity/,
    );
  });

  it("rejects a missing suffix whose nearest existing ancestor is not a directory", () => {
    const filePath = path.join(root, "not-a-directory");
    writeFileSync(filePath, "file", "utf8");

    expect(() => canonicalizeCodexHomeIdentityPath(path.join(filePath, "missing-home"))).toThrow();
  });

  it.runIf(process.platform !== "win32")(
    "rejects a broken symlink instead of assigning it a textual identity",
    () => {
      const brokenLink = path.join(root, "broken-home");
      symlinkSync(path.join(root, "missing-target"), brokenLink, "dir");

      expect(() =>
        canonicalizeCodexHomeIdentityPath(path.join(brokenLink, "missing-home")),
      ).toThrow();
    },
  );
});
