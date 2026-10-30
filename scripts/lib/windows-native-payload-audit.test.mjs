import { assert, describe, it } from "@effect/vitest";
import { createPackage, listPackage } from "@electron/asar";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createRejectedFileAlias } from "../fixtures/filesystem-links.ts";

import windowsNativePayloadAfterPack from "../windows-native-payload-after-pack.mjs";
import windowsNativePayloadAfterSign from "../windows-native-payload-after-sign.mjs";
import {
  WINDOWS_LATE_SIGNING_TARGET_PATHS,
  WINDOWS_UNPACKED_SIGNING_TARGET_PATHS,
} from "../windows-esigner-sign.mjs";
import {
  auditWindowsNativePayloads,
  resolveWindowsNativePayloadHookContext,
} from "./windows-native-payload-audit.mjs";

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function signingContents(pathname) {
  return `unsigned-signing-target:${pathname}`;
}

function createManifest(preservedPath, preservedContents) {
  return {
    schemaVersion: 2,
    windows: {
      x64: {
        signingTargets: WINDOWS_UNPACKED_SIGNING_TARGET_PATHS.map((pathname) => ({
          path: pathname,
          sha256: sha256(signingContents(pathname)),
          source: "fixture-electron@40.6.0",
        })),
        lateSigningTargets: WINDOWS_LATE_SIGNING_TARGET_PATHS.map((pathname) => ({
          path: pathname,
          sha256: sha256(`late-signing-target:${pathname}`),
          source: "fixture-nsis@3.0.4.1",
        })),
        preservedPayloads: [
          {
            path: preservedPath,
            sha256: sha256(preservedContents),
            source: "fixture-vendor@1.0.0",
          },
        ],
      },
    },
  };
}

function writeRelative(root, pathname, contents) {
  const absolutePath = path.join(root, ...pathname.split("/"));
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
  return absolutePath;
}

function portableExecutableBytes() {
  const contents = Buffer.alloc(132);
  contents.write("MZ", 0, "ascii");
  contents.writeUInt32LE(128, 0x3c);
  contents.write("PE\0\0", 128, "binary");
  return contents;
}

function withFixture(run) {
  const root = mkdtempSync(path.join(tmpdir(), "moss-native-audit-"));
  const appOutDir = path.join(root, "win-unpacked");
  const preservedPathname = "resources/vendor.exe";
  const preservedContents = "reviewed-preserved-bytes";
  mkdirSync(appOutDir, { recursive: true });
  for (const pathname of WINDOWS_UNPACKED_SIGNING_TARGET_PATHS) {
    writeRelative(appOutDir, pathname, signingContents(pathname));
  }
  const preservedPath = writeRelative(appOutDir, preservedPathname, preservedContents);
  const cleanup = () => rmSync(root, { force: true, recursive: true });
  try {
    const result = run({
      appOutDir,
      manifest: createManifest(preservedPathname, preservedContents),
      preservedPath,
      preservedPathname,
      root,
    });
    if (result && typeof result.then === "function") {
      return result.finally(cleanup);
    }
    cleanup();
    return result;
  } catch (error) {
    cleanup();
    throw error;
  }
}

function audit(fixture, phase = "before-sign") {
  return auditWindowsNativePayloads({
    appOutDir: fixture.appOutDir,
    arch: "x64",
    manifest: fixture.manifest,
    phase,
  });
}

async function rejectionMessage(promise) {
  try {
    await promise;
  } catch (error) {
    return String(error?.message ?? error);
  }
  assert.fail("Expected promise to reject.");
}

describe("auditWindowsNativePayloads", () => {
  it("accepts the exact schema v2 signing and byte-preserved sets", () => {
    withFixture((fixture) => {
      const result = audit(fixture);

      assert.deepStrictEqual(
        result.signingTargets.map((entry) => entry.path),
        [...WINDOWS_UNPACKED_SIGNING_TARGET_PATHS].sort((left, right) => left.localeCompare(right)),
      );
      assert.deepStrictEqual(
        result.preservedPayloads.map((entry) => entry.path),
        [fixture.preservedPathname],
      );
      assert.equal(result.nativeFiles.length, WINDOWS_UNPACKED_SIGNING_TARGET_PATHS.length + 1);
    });
  });

  it("uses platform-native ASAR lookup paths for nested scoped packages", async () => {
    await withFixture(async (fixture) => {
      const asarSource = path.join(fixture.root, "asar-source");
      const packageDirectory = path.join(
        asarSource,
        "node_modules",
        "@anthropic-ai",
        "claude-agent-sdk",
      );
      mkdirSync(packageDirectory, { recursive: true });
      writeFileSync(
        path.join(packageDirectory, "package.json"),
        JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: "0.0.0-fixture" }),
      );
      mkdirSync(path.join(fixture.appOutDir, "resources"), { recursive: true });
      await createPackage(asarSource, path.join(fixture.appOutDir, "resources", "app.asar"));

      const result = audit(fixture);
      assert.equal(result.nativeFiles.length, WINDOWS_UNPACKED_SIGNING_TARGET_PATHS.length + 1);
    });
  });

  it("pins signing target bytes before signing but permits their signed bytes afterward", () => {
    withFixture((fixture) => {
      writeRelative(fixture.appOutDir, "Moss.exe", "authenticode-mutated-moss");
      assert.throws(() => audit(fixture, "before-sign"), /SHA-256 mismatch for Moss\.exe/);

      const result = audit(fixture, "after-sign");
      assert.equal(result.signingTargets.length, WINDOWS_UNPACKED_SIGNING_TARGET_PATHS.length);
    });

    withFixture((fixture) => {
      writeFileSync(fixture.preservedPath, "mutated-preserved-payload");
      assert.throws(
        () => audit(fixture, "after-sign"),
        /SHA-256 mismatch for resources\/vendor\.exe/,
      );
    });
  });

  it("rejects an unreviewed native payload and reports its hash", () => {
    withFixture((fixture) => {
      const contents = "unexpected-bytes";
      writeRelative(fixture.appOutDir, "resources/unexpected.dll", contents);

      assert.throws(
        () => audit(fixture),
        new RegExp(`resources/unexpected\\.dll:${sha256(contents)}`),
      );
    });
  });

  it("detects a valid PE payload even when its extension is disguised", () => {
    withFixture((fixture) => {
      const contents = portableExecutableBytes();
      writeRelative(fixture.appOutDir, "resources/disguised-payload.bin", contents);

      assert.throws(
        () => audit(fixture),
        new RegExp(`resources/disguised-payload\\.bin:${sha256(contents)}`),
      );
    });
  });

  it("rejects a PE payload hidden inside app.asar", async () => {
    await withFixture(async (fixture) => {
      const asarSource = path.join(fixture.root, "asar-source");
      mkdirSync(asarSource);
      writeFileSync(path.join(asarSource, "hidden.bin"), portableExecutableBytes());
      mkdirSync(path.join(fixture.appOutDir, "resources"), { recursive: true });
      await createPackage(asarSource, path.join(fixture.appOutDir, "resources", "app.asar"));

      assert.throws(() => audit(fixture), /resources\/app\.asar\/hidden\.bin/);
    });
  });

  it("re-reads app.asar when the archive is replaced at the same path", async () => {
    await withFixture(async (fixture) => {
      const resourcesPath = path.join(fixture.appOutDir, "resources");
      const archivePath = path.join(resourcesPath, "app.asar");
      const originalSource = path.join(fixture.root, "original-asar-source");
      const replacementSource = path.join(fixture.root, "replacement-asar-source");
      const replacementArchive = path.join(fixture.root, "replacement.asar");
      mkdirSync(originalSource);
      mkdirSync(replacementSource);
      writeFileSync(path.join(originalSource, "readme.txt"), "reviewed JavaScript payload");
      writeFileSync(
        path.join(replacementSource, "new-hidden-payload.bin"),
        portableExecutableBytes(),
      );
      mkdirSync(resourcesPath, { recursive: true });
      await createPackage(originalSource, archivePath);

      assert.ok(listPackage(archivePath).some((entry) => entry.endsWith("readme.txt")));
      await createPackage(replacementSource, replacementArchive);
      rmSync(archivePath);
      renameSync(replacementArchive, archivePath);

      assert.throws(() => audit(fixture), /resources\/app\.asar\/new-hidden-payload\.bin/);
    });
  });

  it("rejects changed bytes, missing entries, and path-casing drift", () => {
    withFixture((fixture) => {
      writeFileSync(fixture.preservedPath, "changed-preserved-bytes");
      assert.throws(() => audit(fixture), /SHA-256 mismatch for resources\/vendor\.exe/);
    });

    withFixture((fixture) => {
      rmSync(fixture.preservedPath);
      assert.throws(
        () => audit(fixture),
        /Reviewed Windows native payloads are missing:\nresources\/vendor\.exe/,
      );
    });

    withFixture((fixture) => {
      fixture.manifest.windows.x64.preservedPayloads[0].path = "resources/Vendor.exe";
      assert.throws(() => audit(fixture), /path casing changed/);
    });
  });

  it("rejects symbolic links and directories at reviewed payload paths", () => {
    withFixture((fixture) => {
      const target = writeRelative(fixture.appOutDir, "resources/vendor-target.bin", "target");
      rmSync(fixture.preservedPath);
      createRejectedFileAlias(target, fixture.preservedPath);
      assert.throws(() => audit(fixture), /must not be a symbolic link: resources\/vendor\.exe/);
    });

    withFixture((fixture) => {
      rmSync(fixture.preservedPath);
      mkdirSync(fixture.preservedPath);
      assert.throws(() => audit(fixture), /must be a regular file: resources\/vendor\.exe/);
    });

    withFixture((fixture) => {
      createRejectedFileAlias(
        fixture.preservedPath,
        path.join(fixture.appOutDir, "resources", "unreviewed-link.exe"),
      );
      assert.throws(
        () => audit(fixture),
        /rejects symbolic links: resources\/unreviewed-link\.exe/,
      );
    });
  });

  it("rejects invalid phase and incomplete schema v2 provenance metadata", () => {
    withFixture((fixture) => {
      assert.throws(() => audit(fixture, "signing"), /phase must be before-sign or after-sign/);
    });

    withFixture((fixture) => {
      fixture.manifest.windows.x64.preservedPayloads[0].source = "";
      assert.throws(() => audit(fixture), /no source provenance/);
    });

    withFixture((fixture) => {
      delete fixture.manifest.windows.x64.preservedPayloads[0].sha256;
      assert.throws(() => audit(fixture), /must pin SHA-256 bytes/);
    });

    withFixture((fixture) => {
      delete fixture.manifest.windows.x64.signingTargets[1].sha256;
      assert.throws(() => audit(fixture), /signing target .* must pin pre-signing SHA-256/);
    });

    withFixture((fixture) => {
      fixture.manifest.windows.x64.lateSigningTargets[0].path = "Moss.exe";
      assert.throws(() => audit(fixture), /repeats Moss\.exe/);
    });

    withFixture((fixture) => {
      fixture.manifest.schemaVersion = 1;
      assert.throws(() => audit(fixture), /schemaVersion must be 2/);
    });
  });

  it("keeps the committed x64 schema v2 manifest explicit and uniquely keyed", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../windows-native-payload-manifest.json", import.meta.url), "utf8"),
    );
    const { lateSigningTargets, preservedPayloads, signingTargets } = manifest.windows.x64;
    const entries = [...signingTargets, ...lateSigningTargets, ...preservedPayloads];

    assert.equal(manifest.schemaVersion, 2);
    assert.equal(signingTargets.length, WINDOWS_UNPACKED_SIGNING_TARGET_PATHS.length);
    assert.equal(lateSigningTargets.length, WINDOWS_LATE_SIGNING_TARGET_PATHS.length);
    // Codex 0.163 adds code-mode-host and the 26 voice DLLs to the reviewed preserved payload set.
    assert.equal(preservedPayloads.length, 45);
    assert.deepStrictEqual(
      signingTargets.map((entry) => entry.path).sort(),
      [...WINDOWS_UNPACKED_SIGNING_TARGET_PATHS].sort(),
    );
    assert.deepStrictEqual(
      lateSigningTargets.map((entry) => entry.path).sort(),
      [...WINDOWS_LATE_SIGNING_TARGET_PATHS].sort(),
    );
    assert.equal(new Set(entries.map((entry) => entry.path.toLowerCase())).size, entries.length);
    assert.ok(
      [...lateSigningTargets, ...preservedPayloads].every((entry) =>
        /^[0-9a-f]{64}$/.test(entry.sha256),
      ),
    );
    assert.ok(
      entries.every((entry) => typeof entry.source === "string" && entry.source.length > 0),
    );
  });

  it("keeps reviewed Electron payloads aligned with the desktop dependency version", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../windows-native-payload-manifest.json", import.meta.url), "utf8"),
    );
    const desktopPackage = JSON.parse(
      readFileSync(new URL("../../apps/desktop/package.json", import.meta.url), "utf8"),
    );
    const electronVersion = desktopPackage.dependencies.electron;
    assert.match(electronVersion, /^\d+\.\d+\.\d+$/);

    for (const [arch, payloads] of Object.entries(manifest.windows)) {
      for (const entry of payloads.signingTargets) {
        const suffix = entry.path === "Moss.exe" ? " with generated ASAR integrity" : "";
        assert.equal(entry.source, `electron@${electronVersion} win32-${arch}${suffix}`);
        if (entry.path !== "Moss.exe") assert.match(entry.sha256, /^[0-9a-f]{64}$/);
      }
    }
  });

  it("binds every reviewed Windows Codex native file to the authoritative 0.163.0 payload receipt", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../windows-native-payload-manifest.json", import.meta.url), "utf8"),
    );
    const payloadReceipt = JSON.parse(
      readFileSync(
        new URL("../../third_party/openai-codex/0.163.0/PAYLOADS.json", import.meta.url),
        "utf8",
      ),
    );
    const reviewedArchive = payloadReceipt.archives.find((archive) => archive.id === "win32-x64");
    assert.ok(reviewedArchive, "Expected authoritative win32-x64 Codex payload receipt");

    const expected = reviewedArchive.files
      // Every extension the audit tracks, so a Codex bump cannot ship an unreviewed DLL.
      .filter(
        (entry) => entry.path.startsWith("vendor/") && /\.(?:dll|exe|node|pdb)$/.test(entry.path),
      )
      .map((entry) => ({
        path: entry.path.replace(/^vendor\//, "resources/codex-runtime/"),
        sha256: entry.sha256,
        source: `@openai/codex@${reviewedArchive.npmVersion}`,
      }))
      .sort((left, right) => left.path.localeCompare(right.path));
    const actual = manifest.windows.x64.preservedPayloads
      .filter((entry) => entry.path.startsWith("resources/codex-runtime/"))
      .map(({ path: entryPath, sha256: entrySha256, source }) => ({
        path: entryPath,
        sha256: entrySha256,
        source,
      }))
      .sort((left, right) => left.path.localeCompare(right.path));

    assert.deepStrictEqual(actual, expected);
  });
});

describe("resolveWindowsNativePayloadHookContext", () => {
  it("maps electron-builder numeric Windows arches and verifies the configured target", () => {
    assert.deepStrictEqual(
      resolveWindowsNativePayloadHookContext(
        { appOutDir: "C:/Moss/win-unpacked", arch: 1, electronPlatformName: "win32" },
        { MOSS_WINDOWS_TARGET_ARCH: "x64" },
      ),
      { appOutDir: "C:/Moss/win-unpacked", arch: "x64" },
    );
    assert.deepStrictEqual(
      resolveWindowsNativePayloadHookContext(
        { appOutDir: "C:/Moss/win-arm64-unpacked", arch: 3, electronPlatformName: "win32" },
        { MOSS_WINDOWS_TARGET_ARCH: "arm64" },
      ),
      { appOutDir: "C:/Moss/win-arm64-unpacked", arch: "arm64" },
    );
  });

  it("rejects non-Windows contexts, unsupported numeric arches, and target mismatches", () => {
    assert.throws(
      () =>
        resolveWindowsNativePayloadHookContext(
          { appOutDir: "/tmp/mac", arch: 3, electronPlatformName: "darwin" },
          { MOSS_WINDOWS_TARGET_ARCH: "arm64" },
        ),
      /requires electronPlatformName=win32, got darwin/,
    );
    assert.throws(
      () =>
        resolveWindowsNativePayloadHookContext(
          { appOutDir: "C:/Moss", arch: 0, electronPlatformName: "win32" },
          { MOSS_WINDOWS_TARGET_ARCH: "x64" },
        ),
      /unsupported electron-builder arch 0/,
    );
    assert.throws(
      () =>
        resolveWindowsNativePayloadHookContext(
          { appOutDir: "C:/Moss", arch: 1, electronPlatformName: "win32" },
          { MOSS_WINDOWS_TARGET_ARCH: "arm64" },
        ),
      /arch mismatch: electron-builder=x64, MOSS_WINDOWS_TARGET_ARCH=arm64/,
    );
    assert.throws(
      () =>
        resolveWindowsNativePayloadHookContext(
          { appOutDir: "C:/Moss", arch: 1, electronPlatformName: "win32" },
          {},
        ),
      /MOSS_WINDOWS_TARGET_ARCH must be x64 or arm64, got <missing>/,
    );
  });
});

describe("Windows native payload electron-builder hooks", () => {
  it("do not silently skip on a non-Windows host", async () => {
    const context = { appOutDir: "/tmp/not-used", arch: 1, electronPlatformName: "darwin" };
    assert.match(
      await rejectionMessage(windowsNativePayloadAfterPack(context)),
      /requires electronPlatformName=win32, got darwin/,
    );
    assert.match(
      await rejectionMessage(windowsNativePayloadAfterSign(context)),
      /requires electronPlatformName=win32, got darwin/,
    );
  });

  it("fails closed when a signed hook is invoked with the disabled Azure provider", async () => {
    const previousSignedBuild = process.env.MOSS_WINDOWS_SIGNED_BUILD;
    const previousProvider = process.env.WINDOWS_SIGNING_PROVIDER;
    const previousTargetArch = process.env.MOSS_WINDOWS_TARGET_ARCH;
    process.env.MOSS_WINDOWS_SIGNED_BUILD = "1";
    process.env.WINDOWS_SIGNING_PROVIDER = "azure";
    process.env.MOSS_WINDOWS_TARGET_ARCH = "x64";
    try {
      assert.match(
        await rejectionMessage(
          windowsNativePayloadAfterSign({
            appOutDir: "/tmp/not-used",
            arch: 1,
            electronPlatformName: "win32",
          }),
        ),
        /Unsupported Windows signing provider 'azure'\. Expected sslcom/,
      );
    } finally {
      if (previousSignedBuild === undefined) delete process.env.MOSS_WINDOWS_SIGNED_BUILD;
      else process.env.MOSS_WINDOWS_SIGNED_BUILD = previousSignedBuild;
      if (previousProvider === undefined) delete process.env.WINDOWS_SIGNING_PROVIDER;
      else process.env.WINDOWS_SIGNING_PROVIDER = previousProvider;
      if (previousTargetArch === undefined) delete process.env.MOSS_WINDOWS_TARGET_ARCH;
      else process.env.MOSS_WINDOWS_TARGET_ARCH = previousTargetArch;
    }
  });
});
