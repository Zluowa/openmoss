// FILE: mac-update-zip.test.ts
// Purpose: Locks down macOS update zip validation and latest-mac.yml patching.
// Layer: Release/build tests
// Depends on: scripts/lib/mac-update-zip.ts.

import { assert, describe, it } from "@effect/vitest";

import {
  assertMacUpdateManifestZipMetadata,
  buildMacUpdateZipSymlinkEntries,
  isZipInfoSymlink,
  resolveMacUpdateManifestFileNames,
  resolveSingleMacUpdateZipFileName,
  resolveSingleTopLevelMacAppBundle,
  updateMacUpdateManifestZipEntry,
  validateMacUpdateManifestZipMetadata,
} from "./lib/mac-update-zip.ts";
import { mergeMacUpdateManifests, parseMacUpdateManifest } from "./lib/mac-update-manifest.ts";

describe("mac-update-zip", () => {
  it("detects symlink entries from unzip verbose metadata", () => {
    assert.equal(
      isZipInfoSymlink(
        `  Unix file attributes (120755 octal):            lrwxr-xr-x
  MS-DOS file attributes (00 hex):                none
`,
      ),
      true,
    );
    assert.equal(
      isZipInfoSymlink(
        `  Unix file attributes (100755 octal):            -rwxr-xr-x
  MS-DOS file attributes (00 hex):                none
`,
      ),
      false,
    );
  });

  it("builds Electron framework symlink paths for the top-level app bundle", () => {
    assert.deepStrictEqual(buildMacUpdateZipSymlinkEntries("Moss.app"), [
      "Moss.app/Contents/Frameworks/Electron Framework.framework/Electron Framework",
      "Moss.app/Contents/Frameworks/Electron Framework.framework/Helpers",
      "Moss.app/Contents/Frameworks/Electron Framework.framework/Libraries",
      "Moss.app/Contents/Frameworks/Electron Framework.framework/Resources",
      "Moss.app/Contents/Frameworks/Electron Framework.framework/Versions/Current",
    ]);
  });

  it("resolves exactly one top-level .app from update zip entries", () => {
    assert.equal(
      resolveSingleTopLevelMacAppBundle([
        "__MACOSX/Moss.app/Contents/Info.plist",
        "Moss.app/Contents/Info.plist",
        "Moss.app/Contents/MacOS/Moss",
      ]),
      "Moss.app",
    );

    assert.throws(
      () =>
        resolveSingleTopLevelMacAppBundle([
          "Moss.app/Contents/Info.plist",
          "Other.app/Contents/Info.plist",
        ]),
      /Expected one top-level \.app bundle/,
    );
  });

  it("resolves exactly one macOS update zip artifact", () => {
    assert.equal(
      resolveSingleMacUpdateZipFileName([
        "Moss-0.1.5-arm64.dmg",
        "Moss-0.1.5-arm64.zip",
        "latest-mac.yml",
      ]),
      "Moss-0.1.5-arm64.zip",
    );

    assert.throws(
      () => resolveSingleMacUpdateZipFileName(["Moss-0.1.5-arm64.zip", "Moss-0.1.5-x64.zip"]),
      /Expected one macOS update zip artifact/,
    );
  });

  it("requires at least one macOS update manifest", () => {
    assert.deepStrictEqual(
      resolveMacUpdateManifestFileNames([
        "Moss-0.1.5-arm64.dmg",
        "Moss-0.1.5-arm64.zip",
        "latest-mac.yml",
      ]),
      ["latest-mac.yml"],
    );

    assert.throws(
      () => resolveMacUpdateManifestFileNames(["Moss-0.1.5-arm64.dmg"]),
      /Expected at least one macOS update manifest/,
    );

    assert.deepStrictEqual(
      resolveMacUpdateManifestFileNames(["Moss-0.1.5-arm64.dmg"], { required: false }),
      [],
    );
  });

  it("allows a missing manifest only for an explicitly scripted-update artifact", () => {
    const artifacts = ["Moss-Cua-0.8.4-arm64.zip"];
    assert.deepStrictEqual(resolveMacUpdateManifestFileNames(artifacts, { required: false }), []);
    assert.throws(() => resolveMacUpdateManifestFileNames(artifacts, { required: true }));
    assert.throws(() => resolveMacUpdateManifestFileNames(artifacts));
  });

  it("still returns present manifests for validation when a feed is optional", () => {
    assert.deepStrictEqual(
      resolveMacUpdateManifestFileNames(["Moss-Cua-0.8.4-arm64.zip", "latest-mac.yml"], {
        required: false,
      }),
      ["latest-mac.yml"],
    );
  });

  it.each([false, true])(
    "updates zip metadata and preserves dmg fields (blockmaps: %s)",
    (withBlockmaps) => {
      const manifest = `version: 0.1.4
files:
  - url: Moss-0.1.4-arm64.zip
    sha512: oldzip
    size: 100
${withBlockmaps ? "    blockMapSize: 50\n" : ""}  - url: Moss-0.1.4-arm64.dmg
    sha512: olddmg
    size: 200
${withBlockmaps ? "    blockMapSize: 75\n" : ""}path: 'Moss-0.1.4-arm64.zip'
sha512: oldzip
releaseDate: '2026-06-07T12:00:00.000Z'
`;

      const updated = updateMacUpdateManifestZipEntry(manifest, "Moss-0.1.4-arm64.zip", {
        sha512: "newzip",
        size: 12345,
      });

      assert.equal(
        updated,
        `version: 0.1.4
files:
  - url: Moss-0.1.4-arm64.zip
    sha512: newzip
    size: 12345
  - url: Moss-0.1.4-arm64.dmg
    sha512: olddmg
    size: 200
${withBlockmaps ? "    blockMapSize: 75\n" : ""}path: 'Moss-0.1.4-arm64.zip'
sha512: newzip
releaseDate: '2026-06-07T12:00:00.000Z'
`,
      );
    },
  );

  it("publishes the bundle's Darwin minimum once and keeps it through the arch merge", () => {
    const manifestFor = (arch: string) => `version: 0.1.4
files:
  - url: Moss-0.1.4-${arch}.zip
    sha512: oldzip
    size: 100
path: 'Moss-0.1.4-${arch}.zip'
sha512: oldzip
releaseDate: '2026-06-07T12:00:00.000Z'
`;
    const gate = { sha512: "newzip", size: 12345, minimumSystemVersion: "22.0.0" };
    const arm64 = updateMacUpdateManifestZipEntry(
      manifestFor("arm64"),
      "Moss-0.1.4-arm64.zip",
      gate,
    );
    // A retained stage finalized twice replaces its gate instead of adding another.
    const refinalized = updateMacUpdateManifestZipEntry(arm64, "Moss-0.1.4-arm64.zip", gate);
    assert.equal(refinalized.match(/^minimumSystemVersion:/gm)?.length, 1);
    const x64 = updateMacUpdateManifestZipEntry(manifestFor("x64"), "Moss-0.1.4-x64.zip", gate);

    const merged = mergeMacUpdateManifests(
      parseMacUpdateManifest(refinalized, "arm64.yml"),
      parseMacUpdateManifest(x64, "x64.yml"),
    );
    assert.equal(merged.extras.minimumSystemVersion, "22.0.0");
  });

  it("rejects manifests missing the target zip entry", () => {
    assert.throws(
      () =>
        updateMacUpdateManifestZipEntry(
          `version: 0.1.4
files:
  - url: Moss-0.1.4-arm64.dmg
    sha512: olddmg
    size: 200
releaseDate: '2026-06-07T12:00:00.000Z'
`,
          "Moss-0.1.4-arm64.zip",
          {
            sha512: "newzip",
            size: 12345,
          },
        ),
      /Could not update Moss-0.1.4-arm64.zip entry/,
    );
  });

  it("validates manifest metadata after zip repack", () => {
    const manifest = `version: 0.1.5
files:
  - url: Moss-0.1.5-arm64.zip
    sha512: newzip
    size: 12345
path: Moss-0.1.5-arm64.zip
sha512: newzip
releaseDate: '2026-06-07T12:00:00.000Z'
`;
    const metadata = { sha512: "newzip", size: 12345 };

    assert.deepStrictEqual(
      validateMacUpdateManifestZipMetadata(manifest, "Moss-0.1.5-arm64.zip", metadata),
      {
        manifestHasZipPath: true,
        manifestHasZipSha: true,
        manifestHasZipSize: true,
      },
    );
    assert.deepStrictEqual(
      assertMacUpdateManifestZipMetadata(manifest, "Moss-0.1.5-arm64.zip", metadata),

      {
        manifestHasZipPath: true,
        manifestHasZipSha: true,
        manifestHasZipSize: true,
      },
    );
  });
});
