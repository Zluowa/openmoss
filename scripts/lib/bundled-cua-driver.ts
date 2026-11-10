// FILE: bundled-cua-driver.ts
// Purpose: Stages and validates the pinned Cua Driver shipped in desktop artifacts.
// Layer: Release/build helper

import { spawnSync } from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";

import release from "../../packages/shared/src/cuaDriverRelease.json" with { type: "json" };

type DesktopBuildPlatform = "linux" | "mac" | "win";

// Outside apps/desktop/resources, which is also copied into app.asar: the driver
// is spawned by path, and an executable inside the archive cannot serve that path.
export const BUNDLED_CUA_DRIVER_DIR = "apps/desktop/cua-driver-runtime";
export const BUNDLED_CUA_DRIVER_RESOURCE_DIR = "cua-driver";
export const BUNDLED_CUA_DRIVER_EXTRA_RESOURCE = {
  from: BUNDLED_CUA_DRIVER_DIR,
  to: BUNDLED_CUA_DRIVER_RESOURCE_DIR,
} as const;
export const CUA_DRIVER_PROVISION_SCRIPT = "apps/desktop/scripts/provision-cua-driver.mjs";
export const CUA_DRIVER_PROVISION_FAILURE_MESSAGE = [
  "Desktop packages must include the Cua Driver, and it could not be provisioned.",
  `Install the pinned Rust ${release.rustVersion} toolchain or set MOSS_CUA_ARTIFACT_DIR to a verified driver directory.`,
].join(" ");

/** The desktop app only hosts the driver on these platforms (`startCuaHost` in main.ts). */
export function requiresBundledCuaDriver(platform: DesktopBuildPlatform): boolean {
  return platform === "mac" || platform === "linux" || platform === "win";
}

export function resolveCuaDriverProvisionPlatform(
  platform: DesktopBuildPlatform,
): "darwin" | "linux" | "win32" {
  if (!requiresBundledCuaDriver(platform)) {
    throw new Error(`Moss does not bundle the Cua Driver for ${platform}.`);
  }
  return platform === "mac" ? "darwin" : platform === "win" ? "win32" : "linux";
}

export interface CuaDriverCodesignResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

export type CuaDriverCodesignRunner = (args: readonly string[]) => CuaDriverCodesignResult;

export interface PackagedCuaDriverReceipt {
  readonly driverPath: string;
  readonly version: string;
  readonly nativeRevision: number;
  /** macOS only; Linux has no code signature to report. */
  readonly signingIdentifier: string | null;
}

interface PackagedCuaDriverProvenance {
  readonly version?: unknown;
  readonly source?: unknown;
  readonly nativeRevision?: unknown;
  readonly patched?: unknown;
  readonly patchSha256?: unknown;
  readonly platform?: unknown;
  readonly binarySha256?: unknown;
  readonly sidecarSha256?: unknown;
}

const runCodesign: CuaDriverCodesignRunner = (args) =>
  spawnSync("/usr/bin/codesign", args, {
    encoding: "utf8",
    timeout: 30_000,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" },
  });

function requirePackagedFile(filePath: string, label: string): FS.Stats {
  let stat: FS.Stats;
  try {
    stat = FS.lstatSync(filePath);
  } catch {
    throw new Error(`Packaged Cua Driver is missing its ${label} at ${filePath}.`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
    throw new Error(`Packaged Cua Driver ${label} must be a non-empty regular file: ${filePath}.`);
  }
  return stat;
}

function sha256File(filePath: string): string {
  return Crypto.createHash("sha256").update(FS.readFileSync(filePath)).digest("hex");
}

function verifyPackagedMacSignature(input: {
  readonly driverPath: string;
  readonly signed: boolean;
  readonly runCommand: CuaDriverCodesignRunner;
}): string {
  const run = (args: readonly string[], label: string): string => {
    const result = input.runCommand(args);
    if (result.error || result.status !== 0) {
      throw new Error(
        `Packaged Cua Driver ${label} failed: ${result.error?.message || result.stderr.trim() || `exit ${String(result.status)}`}`,
      );
    }
    return `${result.stdout}\n${result.stderr}`;
  };
  run(["--verify", "--strict", "--verbose=4", input.driverPath], "signature verification");
  const details = run(["--display", "--verbose=4", input.driverPath], "signature probe");
  const identifier = /^Identifier=(.+)$/mu.exec(details)?.[1]?.trim();
  // codesign --force falls back to a file-name identifier unless the signing pass
  // restates it. macOS ties Screen Recording and Accessibility grants to this
  // value, so a silent change would ask every user to grant them again.
  if (identifier !== release.signingIdentifier) {
    throw new Error(
      `Packaged Cua Driver signing identifier is ${identifier ?? "missing"}, expected ${release.signingIdentifier}.`,
    );
  }
  if (/^Signature=adhoc$/imu.test(details) === input.signed) {
    throw new Error(
      input.signed
        ? "A signed macOS package must not carry an ad-hoc Cua Driver signature."
        : "An unsigned macOS package must carry an ad-hoc Cua Driver signature.",
    );
  }
  return identifier;
}

function verifyPackagedLinuxBytes(input: {
  readonly directory: string;
  readonly driverPath: string;
  readonly provenance: PackagedCuaDriverProvenance;
}): void {
  // Nothing re-signs on Linux, so every staged byte must arrive unchanged.
  if (sha256File(input.driverPath) !== input.provenance.binarySha256) {
    throw new Error("Packaged Cua Driver bytes do not match their provenance.");
  }
  const sidecars = Object.entries((input.provenance.sidecarSha256 ?? {}) as object);
  if (sidecars.length === 0) {
    throw new Error("Packaged Cua Driver provenance lists no Linux sidecars.");
  }
  for (const [sidecar, expected] of sidecars) {
    const sidecarPath = Path.join(input.directory, sidecar);
    requirePackagedFile(sidecarPath, `sidecar ${sidecar}`);
    if (sha256File(sidecarPath) !== expected) {
      throw new Error(`Packaged Cua Driver sidecar ${sidecar} does not match its provenance.`);
    }
  }
}

/** Proves the final package holds the driver where the app spawns it. Run after every signing pass. */
export function validatePackagedCuaDriver(input: {
  readonly resourcesDir: string;
  readonly platform: DesktopBuildPlatform;
  readonly signed: boolean;
  readonly runCommand?: CuaDriverCodesignRunner;
}): PackagedCuaDriverReceipt {
  const provisionPlatform = resolveCuaDriverProvisionPlatform(input.platform);
  const directory = Path.join(input.resourcesDir, BUNDLED_CUA_DRIVER_RESOURCE_DIR);
  const driverPath = Path.join(
    directory,
    input.platform === "win" ? "cua-driver.exe" : "cua-driver",
  );
  const driver = requirePackagedFile(driverPath, "executable");
  // Real packages only build on macOS and Linux; Windows reports no execute bits.
  if (process.platform !== "win32" && (driver.mode & 0o100) === 0) {
    throw new Error(`Packaged Cua Driver must stay executable: ${driverPath}.`);
  }
  requirePackagedFile(Path.join(directory, "LICENSE.txt"), "license");
  const provenancePath = Path.join(directory, "provenance.json");
  requirePackagedFile(provenancePath, "provenance");
  const provenance = JSON.parse(
    FS.readFileSync(provenancePath, "utf8"),
  ) as PackagedCuaDriverProvenance;
  const validWindowsUpstream =
    input.platform === "win" &&
    provenance.platform === "win32" &&
    provenance.patched === false &&
    provenance.patchSha256 === null;
  const validPatchedRuntime =
    input.platform !== "win" &&
    provenance.platform === provisionPlatform &&
    provenance.patched === true &&
    provenance.patchSha256 === release.patchSha256;
  if (
    provenance.version !== release.version ||
    provenance.source !== release.source ||
    provenance.nativeRevision !== release.nativeRevision ||
    (!validWindowsUpstream && !validPatchedRuntime)
  ) {
    throw new Error("Packaged Cua Driver provenance does not match the pinned release.");
  }

  if (input.platform === "linux") {
    verifyPackagedLinuxBytes({ directory, driverPath, provenance });
  }
  return {
    driverPath,
    version: release.version,
    nativeRevision: release.nativeRevision,
    signingIdentifier:
      input.platform === "mac"
        ? verifyPackagedMacSignature({
            driverPath,
            signed: input.signed,
            runCommand: input.runCommand ?? runCodesign,
          })
        : null,
  };
}
