import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  generateMossUpdateManifestKeyPair,
  verifyMossUpdateManifest,
} from "@moss/shared/mossUpdateMirror";
import { afterEach, describe, expect, it } from "vitest";

import {
  isChannelManifestFileName,
  isUpdateManifestFileName,
  signUpdateManifestsInDirectory,
  writeUpdateMirrorKeyPair,
} from "./sign-update-mirror-manifests.ts";

const directories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "moss-update-mirror-sign-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("signUpdateManifestsInDirectory", () => {
  it("signs every manifest so the app can verify it", () => {
    const { manifestPublicKey, privateKey } = generateMossUpdateManifestKeyPair();
    const directory = tempDirectory();
    writeFileSync(join(directory, "moss.yml"), "version: 2.0.0\n");
    writeFileSync(join(directory, "moss-mac.yml"), "version: 2.0.0\npath: Moss.zip\n");
    writeFileSync(join(directory, "builder-debug.yml"), "x: 1\n");
    writeFileSync(join(directory, "Moss-2.0.0-x64.exe"), "installer");

    const signed = signUpdateManifestsInDirectory({ directory, privateKey });

    expect(signed).toEqual(["moss-mac.yml", "moss.yml"]);
    for (const channelFile of signed) {
      expect(
        verifyMossUpdateManifest({
          channelFile,
          manifest: readFileSync(join(directory, channelFile), "utf8"),
          signature: readFileSync(join(directory, `${channelFile}.sig`), "utf8"),
          manifestPublicKey,
        }),
      ).toBe(true);
    }
  });

  it("signs runtime-pins.json like a channel manifest, its file name bound into the signature", () => {
    const { manifestPublicKey, privateKey } = generateMossUpdateManifestKeyPair();
    const directory = tempDirectory();
    const pins = '{"runtimes":[]}\n';
    writeFileSync(join(directory, "latest.yml"), "version: 2.0.0\n");
    writeFileSync(join(directory, "runtime-pins.json"), pins);
    writeFileSync(join(directory, "runtime-archives.json"), "{}\n");

    expect(signUpdateManifestsInDirectory({ directory, privateKey })).toEqual([
      "latest.yml",
      "runtime-pins.json",
    ]);
    const signature = readFileSync(join(directory, "runtime-pins.json.sig"), "utf8");
    expect(
      verifyMossUpdateManifest({
        channelFile: "runtime-pins.json",
        manifest: pins,
        signature,
        manifestPublicKey,
      }),
    ).toBe(true);
    // The same bytes under another name do not verify.
    expect(
      verifyMossUpdateManifest({
        channelFile: "latest.yml",
        manifest: pins,
        signature,
        manifestPublicKey,
      }),
    ).toBe(false);
  });

  it("tells channel manifests from the other signed files", () => {
    expect(isUpdateManifestFileName("runtime-pins.json")).toBe(true);
    expect(isChannelManifestFileName("runtime-pins.json")).toBe(false);
    expect(isUpdateManifestFileName("latest.yml")).toBe(true);
    expect(isChannelManifestFileName("latest.yml")).toBe(true);
    for (const name of ["builder-debug.yml", "runtime-archives.json", "x-runtime-pins.json"]) {
      expect(isUpdateManifestFileName(name)).toBe(false);
    }
  });

  it("fails when there is nothing to sign", () => {
    const { privateKey } = generateMossUpdateManifestKeyPair();
    expect(() =>
      signUpdateManifestsInDirectory({ directory: tempDirectory(), privateKey }),
    ).toThrow("No update manifests");
    // Runtime pins alone are not a release an app can update from.
    const pinsOnly = tempDirectory();
    writeFileSync(join(pinsOnly, "runtime-pins.json"), "{}\n");
    expect(() => signUpdateManifestsInDirectory({ directory: pinsOnly, privateKey })).toThrow(
      "No update manifests",
    );
  });
});

describe("writeUpdateMirrorKeyPair", () => {
  it("writes a working key once and refuses to replace it", () => {
    const keyPath = join(tempDirectory(), "signing-key");

    const { manifestPublicKey } = writeUpdateMirrorKeyPair(keyPath);
    const directory = tempDirectory();
    writeFileSync(join(directory, "moss.yml"), "version: 2.0.0\n");
    signUpdateManifestsInDirectory({
      directory,
      privateKey: readFileSync(keyPath, "utf8").trim(),
    });

    expect(
      verifyMossUpdateManifest({
        channelFile: "moss.yml",
        manifest: "version: 2.0.0\n",
        signature: readFileSync(join(directory, "moss.yml.sig"), "utf8"),
        manifestPublicKey,
      }),
    ).toBe(true);
    expect(() => writeUpdateMirrorKeyPair(keyPath)).toThrow("Refusing to overwrite");
  });
});
