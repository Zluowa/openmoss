import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import release from "../../packages/shared/src/cuaDriverRelease.json" with { type: "json" };
import {
  BUNDLED_CUA_DRIVER_DIR,
  BUNDLED_CUA_DRIVER_EXTRA_RESOURCE,
  CUA_DRIVER_PROVISION_FAILURE_MESSAGE,
  type CuaDriverCodesignRunner,
  requiresBundledCuaDriver,
  resolveCuaDriverProvisionPlatform,
  validatePackagedCuaDriver,
} from "./bundled-cua-driver.ts";
import {
  BUNDLED_RUNTIME_ASAR_EXCLUSIONS,
  createDesktopPlatformBuildConfig,
} from "./desktop-platform-build-config.ts";

const repoRoot = Path.resolve(import.meta.dirname, "../..");
const readRepoFile = (relativePath: string) =>
  FS.readFileSync(Path.join(repoRoot, relativePath), "utf8");
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) FS.rmSync(root, { recursive: true, force: true });
});

function makeResources(input: {
  readonly platform: "darwin" | "linux" | "win32";
  readonly provenance?: Record<string, unknown>;
}) {
  const resourcesDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "moss-cua-driver-"));
  roots.push(resourcesDir);
  const directory = Path.join(resourcesDir, "cua-driver");
  FS.mkdirSync(directory);
  const driver = "driver-bytes";
  const sidecar = "sidecar-bytes";
  FS.writeFileSync(
    Path.join(directory, input.platform === "win32" ? "cua-driver.exe" : "cua-driver"),
    driver,
    { mode: 0o755 },
  );
  FS.writeFileSync(Path.join(directory, "LICENSE.txt"), "license");
  if (input.platform === "linux")
    FS.writeFileSync(Path.join(directory, "cua-cursor-theme"), sidecar);
  FS.writeFileSync(
    Path.join(directory, "provenance.json"),
    JSON.stringify({
      version: release.version,
      source: release.source,
      nativeRevision: release.nativeRevision,
      platform: input.platform,
      patched: input.platform !== "win32",
      patchSha256: input.platform === "win32" ? null : release.patchSha256,
      binarySha256: sha256(driver),
      ...(input.platform === "linux"
        ? { sidecarSha256: { "cua-cursor-theme": sha256(sidecar) } }
        : {}),
      ...input.provenance,
    }),
  );
  return { resourcesDir, directory };
}

function codesignReporting(details: string): CuaDriverCodesignRunner {
  return () => ({ status: 0, stdout: "", stderr: details });
}

const adHocIdentity = `Identifier=${release.signingIdentifier}\nSignature=adhoc\n`;

describe("bundled Cua Driver packaging", () => {
  it("is required exactly where the desktop app hosts the driver", () => {
    expect(requiresBundledCuaDriver("mac")).toBe(true);
    expect(requiresBundledCuaDriver("linux")).toBe(true);
    expect(requiresBundledCuaDriver("win")).toBe(true);
    expect(resolveCuaDriverProvisionPlatform("mac")).toBe("darwin");
    expect(resolveCuaDriverProvisionPlatform("linux")).toBe("linux");
    expect(resolveCuaDriverProvisionPlatform("win")).toBe("win32");
    const main = readRepoFile("apps/desktop/src/main.ts");
    expect(main).toContain("if (cuaDriverHost) return;");
  });

  it("ships at the path the app spawns and stays out of app.asar", () => {
    expect(BUNDLED_CUA_DRIVER_EXTRA_RESOURCE).toEqual({
      from: BUNDLED_CUA_DRIVER_DIR,
      to: "cua-driver",
    });
    expect(BUNDLED_RUNTIME_ASAR_EXCLUSIONS).toContain(`!${BUNDLED_CUA_DRIVER_DIR}/**`);
    expect(readRepoFile("apps/desktop/src/main.ts")).toContain(
      'Path.join(process.resourcesPath, "cua-driver", "cua-driver.exe")',
    );
    expect(readRepoFile("apps/desktop/src/linuxCuaDriverHost.ts")).toContain(
      'join(options.resourcesPath, "cua-driver", "cua-driver")',
    );
  });

  it("keeps the prebuilt universal driver out of the architecture merge", () => {
    const config = createDesktopPlatformBuildConfig({
      hostPlatform: "darwin",
      platform: "mac",
      target: "zip",
      signed: false,
    });
    expect(config.mac?.x64ArchFiles).toBe(
      "Contents/{Helpers/moss-appsnap-helper,Resources/cua-driver/cua-driver}",
    );
  });

  it("names the remedies when the driver cannot be provisioned", () => {
    expect(CUA_DRIVER_PROVISION_FAILURE_MESSAGE).toContain(release.rustVersion);
    expect(CUA_DRIVER_PROVISION_FAILURE_MESSAGE).toContain("MOSS_CUA_ARTIFACT_DIR");
  });

  it("stages the driver first, without signing keys, and validates after signing", () => {
    const source = readRepoFile("scripts/build-desktop-artifact.ts");
    const stage = source.indexOf("yield* stageBundledCuaDriver(stageAppDir");
    const build = source.indexOf("bun run build:desktop --force");
    const resourcesCopy = source.indexOf("yield* fs.copy(distDirs.desktopResources");
    const sourceCopyRemoval = source.indexOf(
      "yield* fs.remove(path.join(stageResourcesDir, BUNDLED_CUA_DRIVER_RESOURCE_DIR)",
    );
    const builder = source.indexOf("electronBuilderCliPath,", sourceCopyRemoval);
    const adHocSign = source.indexOf("createMacBuildOnlySignCommand({", builder);
    const validation = source.indexOf("validatePackagedCuaDriver({", adHocSign);
    const zip = source.indexOf("finalizeMacUpdateZip({", validation);
    expect(stage).toBeGreaterThan(0);
    expect(build).toBeGreaterThan(stage);
    expect(sourceCopyRemoval).toBeGreaterThan(resourcesCopy);
    expect(adHocSign).toBeGreaterThan(builder);
    expect(validation).toBeGreaterThan(adHocSign);
    expect(zip).toBeGreaterThan(validation);
    expect(source).toMatch(
      /A source build runs third-party build scripts[^\n]*\n\s+env: createNonSigningSubprocessEnvironment\(process\.env\)/u,
    );
  });

  it("uses the release manifest as the only copy of the signing identifier", () => {
    expect(release.signingIdentifier).toBe("com.moss.desktop.cua.driver");
    const provision = readRepoFile("apps/desktop/scripts/provision-cua-driver.mjs");
    expect(provision).toContain("release.signingIdentifier");
    expect(provision).not.toContain(release.signingIdentifier);
    expect(readRepoFile("scripts/mac-canonical-filesystem-helper-sign.mjs")).not.toContain(
      release.signingIdentifier,
    );
  });
});

describe("native patches and the desktop host", () => {
  const patchDirectory = "apps/desktop/patches/cua-driver";
  const nativePatch = readRepoFile(`${patchDirectory}/0001-moss-native.patch`);
  const linuxPatch = readRepoFile(`${patchDirectory}/0002-moss-linux-browser.patch`);
  const host = readRepoFile("apps/desktop/src/cuaDriverHost.ts");

  it("match the pinned checksums", () => {
    expect(
      sha256(FS.readFileSync(Path.join(repoRoot, patchDirectory, "0001-moss-native.patch"))),
    ).toBe(release.patchSha256);
    expect(
      sha256(FS.readFileSync(Path.join(repoRoot, patchDirectory, "0002-moss-linux-browser.patch"))),
    ).toBe(release.linuxBrowserPatchSha256);
  });

  // Windows runners check out with core.autocrlf=true. Without `-text` the patches arrive
  // with CRLF line endings, their hashes stop matching the pins, and Windows packaging stops
  // at "Cua native patch checksum mismatch". Replays that checkout through git's own filters.
  it("keep the pinned bytes in a CRLF checkout", () => {
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, {
        cwd: repoRoot,
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024,
      });
      if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${String(result.stderr)}`);
      return result.stdout;
    };
    const lines = (output: Buffer) => String(output).split(/\r?\n/u).filter(Boolean);
    const patches = lines(git("ls-files", "--", "*.patch", "*.diff"));
    expect(patches).toContain(`${patchDirectory}/0001-moss-native.patch`);
    for (const line of lines(git("check-attr", "text", "--", ...patches))) {
      expect(line).toMatch(/: text: unset$/u);
    }
    const crlfCheckout = (file: string) =>
      git(
        "-c",
        "core.autocrlf=true",
        "-c",
        "core.eol=crlf",
        "cat-file",
        "--filters",
        `--path=${file}`,
        String(git("hash-object", "--", file)).trim(),
      );
    expect(sha256(crlfCheckout(`${patchDirectory}/0001-moss-native.patch`))).toBe(
      release.patchSha256,
    );
    expect(sha256(crlfCheckout(`${patchDirectory}/0002-moss-linux-browser.patch`))).toBe(
      release.linuxBrowserPatchSha256,
    );
  });

  // The host retires a driver whose handshake it cannot read, so a rename on one
  // side alone leaves a bundled driver that looks present and can never start.
  it.each([
    ["moss_native_revision", nativePatch],
    ["moss_browser_input_control", linuxPatch],
    ["moss_cua_overlay_init", nativePatch],
    ["moss_cua_focus_restore", nativePatch],
    ["MOSS_CUA_FOREGROUND_OBSERVATION_MS", nativePatch],
    ["MOSS_CUA_BACKGROUND_OBSERVATION_MS", nativePatch],
  ])("agree on %s", (wireName, patch) => {
    expect(host).toContain(wireName);
    expect(patch).toContain(wireName);
  });

  it("carry no name from before the Moss rename", () => {
    expect(nativePatch).not.toMatch(/synara/iu);
    expect(linuxPatch).not.toMatch(/synara/iu);
  });

  it("stamp the native revision the manifest pins", () => {
    const stamped = [
      ...nativePatch.matchAll(
        /^\+\s+metadata\["moss_native_revision"\] = serde_json::json!\((\d+)\);/gmu,
      ),
    ];
    expect(Number(stamped.at(-1)?.[1])).toBe(release.nativeRevision);
  });
});

describe("validatePackagedCuaDriver", () => {
  it("accepts an ad-hoc macOS driver with the Moss identifier", () => {
    const { resourcesDir, directory } = makeResources({ platform: "darwin" });
    const calls: string[][] = [];
    const receipt = validatePackagedCuaDriver({
      resourcesDir,
      platform: "mac",
      signed: false,
      runCommand: (args) => {
        calls.push([...args]);
        return { status: 0, stdout: "", stderr: adHocIdentity };
      },
    });
    const driverPath = Path.join(directory, "cua-driver");
    expect(receipt).toEqual({
      driverPath,
      version: release.version,
      nativeRevision: release.nativeRevision,
      signingIdentifier: release.signingIdentifier,
    });
    expect(calls).toEqual([
      ["--verify", "--strict", "--verbose=4", driverPath],
      ["--display", "--verbose=4", driverPath],
    ]);
  });

  it("does not bind macOS driver bytes to provenance, because signing rewrites them", () => {
    const { resourcesDir } = makeResources({
      platform: "darwin",
      provenance: { binarySha256: "0".repeat(64) },
    });
    expect(
      validatePackagedCuaDriver({
        resourcesDir,
        platform: "mac",
        signed: false,
        runCommand: codesignReporting(adHocIdentity),
      }).signingIdentifier,
    ).toBe(release.signingIdentifier);
  });

  it("rejects the file-name identifier a plain re-signing pass leaves behind", () => {
    const { resourcesDir } = makeResources({ platform: "darwin" });
    expect(() =>
      validatePackagedCuaDriver({
        resourcesDir,
        platform: "mac",
        signed: false,
        runCommand: codesignReporting("Identifier=cua-driver\nSignature=adhoc\n"),
      }),
    ).toThrow(/identifier is cua-driver, expected com\.moss\.desktop\.cua\.driver/u);
  });

  it("rejects a signature of the wrong kind for the package", () => {
    const { resourcesDir } = makeResources({ platform: "darwin" });
    expect(() =>
      validatePackagedCuaDriver({
        resourcesDir,
        platform: "mac",
        signed: true,
        runCommand: codesignReporting(adHocIdentity),
      }),
    ).toThrow(/signed macOS package must not carry an ad-hoc/u);
    expect(() =>
      validatePackagedCuaDriver({
        resourcesDir,
        platform: "mac",
        signed: false,
        runCommand: codesignReporting(
          `Identifier=${release.signingIdentifier}\nAuthority=Developer ID Application\n`,
        ),
      }),
    ).toThrow(/unsigned macOS package must carry an ad-hoc/u);
  });

  it("rejects a driver that fails strict signature verification", () => {
    const { resourcesDir } = makeResources({ platform: "darwin" });
    expect(() =>
      validatePackagedCuaDriver({
        resourcesDir,
        platform: "mac",
        signed: false,
        runCommand: () => ({ status: 1, stdout: "", stderr: "invalid signature" }),
      }),
    ).toThrow(/signature verification failed: invalid signature/u);
  });

  it("rejects a package without the driver", () => {
    const { resourcesDir, directory } = makeResources({ platform: "darwin" });
    FS.rmSync(Path.join(directory, "cua-driver"));
    expect(() =>
      validatePackagedCuaDriver({
        resourcesDir,
        platform: "mac",
        signed: false,
        runCommand: codesignReporting(adHocIdentity),
      }),
    ).toThrow(/missing its executable/u);
  });

  it.runIf(process.platform !== "win32")("rejects a driver that lost its execute bit", () => {
    const { resourcesDir, directory } = makeResources({ platform: "linux" });
    FS.chmodSync(Path.join(directory, "cua-driver"), 0o644);
    expect(() =>
      validatePackagedCuaDriver({ resourcesDir, platform: "linux", signed: false }),
    ).toThrow(/must stay executable/u);
  });

  it.each([
    ["an upstream version", { version: "0.0.0" }],
    ["another source commit", { source: "0".repeat(40) }],
    ["an older native revision", { nativeRevision: release.nativeRevision - 1 }],
    ["another platform", { platform: "darwin" }],
    ["an unpatched build", { patched: false }],
    ["another patch", { patchSha256: "0".repeat(64) }],
  ])("rejects provenance from %s", (_label, provenance) => {
    const { resourcesDir } = makeResources({ platform: "linux", provenance });
    expect(() =>
      validatePackagedCuaDriver({ resourcesDir, platform: "linux", signed: false }),
    ).toThrow(/does not match the pinned release/u);
  });

  it("accepts Linux bytes and sidecars that match provenance, with no signature step", () => {
    const { resourcesDir } = makeResources({ platform: "linux" });
    expect(
      validatePackagedCuaDriver({ resourcesDir, platform: "linux", signed: false })
        .signingIdentifier,
    ).toBeNull();
  });

  it("rejects changed Linux bytes and missing or changed sidecars", () => {
    const changedDriver = makeResources({ platform: "linux" });
    FS.writeFileSync(Path.join(changedDriver.directory, "cua-driver"), "changed");
    expect(() =>
      validatePackagedCuaDriver({
        resourcesDir: changedDriver.resourcesDir,
        platform: "linux",
        signed: false,
      }),
    ).toThrow(/bytes do not match/u);

    const changedSidecar = makeResources({ platform: "linux" });
    FS.writeFileSync(Path.join(changedSidecar.directory, "cua-cursor-theme"), "changed");
    expect(() =>
      validatePackagedCuaDriver({
        resourcesDir: changedSidecar.resourcesDir,
        platform: "linux",
        signed: false,
      }),
    ).toThrow(/sidecar cua-cursor-theme does not match/u);

    const missingSidecar = makeResources({ platform: "linux" });
    FS.rmSync(Path.join(missingSidecar.directory, "cua-cursor-theme"));
    expect(() =>
      validatePackagedCuaDriver({
        resourcesDir: missingSidecar.resourcesDir,
        platform: "linux",
        signed: false,
      }),
    ).toThrow(/missing its sidecar cua-cursor-theme/u);

    const noSidecars = makeResources({ platform: "linux", provenance: { sidecarSha256: {} } });
    expect(() =>
      validatePackagedCuaDriver({
        resourcesDir: noSidecars.resourcesDir,
        platform: "linux",
        signed: false,
      }),
    ).toThrow(/lists no Linux sidecars/u);
  });

  it("accepts the pinned Windows upstream driver", () => {
    const { resourcesDir, directory } = makeResources({ platform: "win32" });
    const receipt = validatePackagedCuaDriver({ resourcesDir, platform: "win", signed: false });
    expect(receipt.driverPath).toBe(Path.join(directory, "cua-driver.exe"));
    expect(receipt.signingIdentifier).toBeNull();
  });

  it("accepts what the real provisioning script stages from a verified Linux artifact", () => {
    const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "moss-cua-provision-"));
    roots.push(root);
    const artifact = Path.join(root, "artifact");
    FS.mkdirSync(Path.join(artifact, "wayland-helper", "winrects@cua"), { recursive: true });
    const elf = Buffer.alloc(64);
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(elf);
    elf.writeUInt16LE(62, 18);
    const sidecars = {
      "cua-cursor-theme": elf,
      "wayland-helper/install.sh": Buffer.from("#!/bin/sh\n"),
      "wayland-helper/README.md": Buffer.from("readme"),
      "wayland-helper/winrects@cua/extension.js": Buffer.from("extension"),
      "wayland-helper/winrects@cua/metadata.json": Buffer.from("{}"),
    };
    for (const [path, bytes] of Object.entries(sidecars)) {
      FS.writeFileSync(Path.join(artifact, path), bytes);
    }
    FS.writeFileSync(Path.join(artifact, "cua-driver"), elf);
    FS.writeFileSync(
      Path.join(artifact, "provenance.json"),
      JSON.stringify({
        version: release.version,
        source: release.source,
        nativeRevision: release.nativeRevision,
        platform: "linux",
        patched: true,
        patchSha256: release.patchSha256,
        linuxBrowserPatchSha256: release.linuxBrowserPatchSha256,
        browserInputControl: release.linuxBrowserInputControl,
        inputScope: "owned-headless-browser",
        sidecarSha256: Object.fromEntries(
          Object.entries(sidecars).map(([path, bytes]) => [path, sha256(bytes)]),
        ),
        rustVersion: release.rustVersion,
        rustcVersion: `rustc ${release.rustVersion} (fixture)`,
        architectures: ["x64"],
        binarySha256: sha256(elf),
      }),
    );
    const resourcesDir = Path.join(root, "resources");
    const provisioned = spawnSync(
      process.execPath,
      [
        Path.join(repoRoot, "apps/desktop/scripts/provision-cua-driver.mjs"),
        "--artifact-dir",
        artifact,
        "--destination",
        Path.join(resourcesDir, "cua-driver"),
        "--platform",
        "linux",
        "--arch",
        "x64",
      ],
      { encoding: "utf8" },
    );
    expect(provisioned.status, provisioned.stderr).toBe(0);
    expect(validatePackagedCuaDriver({ resourcesDir, platform: "linux", signed: false })).toEqual({
      driverPath: Path.join(resourcesDir, "cua-driver", "cua-driver"),
      version: release.version,
      nativeRevision: release.nativeRevision,
      signingIdentifier: null,
    });
  });
});
