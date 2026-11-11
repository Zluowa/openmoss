// FILE: ensure-dev-cua-driver.mjs
// Purpose: A Windows source checkout has no Cua Driver until something stages it (the folder is
//          git-ignored and only packaging provisioned it), so Settings › Computer use stayed red
//          in every dev window. Stage the pinned, checksum-verified upstream build once, before
//          Electron starts; reuse it on later launches.
// Layer: Desktop dev tooling
// Exports: devCuaDriverStatus, ensureDevCuaDriver

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
export const DEV_CUA_DRIVER_DIR = join(scriptsDir, "../resources/cua-driver");
const PROVISION_SCRIPT = join(scriptsDir, "provision-cua-driver.mjs");
const RELEASE_PATH = join(scriptsDir, "../../../packages/shared/src/cuaDriverRelease.json");

/**
 * Whether the staged driver is usable for this release: the executable is
 * there and its provenance names the pinned version. Only Windows stages
 * without a toolchain (macOS and Linux build from source with the pinned Rust),
 * so other platforms are reported as `unsupported` and left alone.
 */
export function devCuaDriverStatus({
  platform = process.platform,
  driverDir = DEV_CUA_DRIVER_DIR,
  releaseVersion = JSON.parse(readFileSync(RELEASE_PATH, "utf8")).version,
  exists = existsSync,
  readText = (path) => readFileSync(path, "utf8"),
} = {}) {
  if (platform !== "win32") return "unsupported";
  if (!exists(join(driverDir, "cua-driver.exe"))) return "missing";
  try {
    const provenance = JSON.parse(readText(join(driverDir, "provenance.json")));
    return provenance?.version === releaseVersion ? "ready" : "stale";
  } catch {
    return "stale";
  }
}

/**
 * Stage the driver when it is missing or from another release. Never fails
 * the dev launch: without network the window still opens, and Settings then
 * says the computer control part is missing instead of a generic error.
 * `MOSS_SKIP_CUA_DRIVER_PROVISION=1` opts out.
 */
export function ensureDevCuaDriver({
  env = process.env,
  run = (command, args) =>
    spawnSync(command, args, { stdio: "inherit", windowsHide: true, timeout: 5 * 60_000 }),
  log = (message) => console.log(message),
  status = devCuaDriverStatus,
} = {}) {
  if (env.MOSS_SKIP_CUA_DRIVER_PROVISION === "1") return "skipped";
  const before = status();
  if (before === "unsupported" || before === "ready") return before;
  log(`[desktop] Computer use: staging the pinned Cua Driver (${before})…`);
  const result = run(process.execPath, [PROVISION_SCRIPT]);
  if (result.status === 0 && status() === "ready") return "staged";
  log(
    "[desktop] Computer use: the Cua Driver could not be staged (network?). The window still opens; " +
      "Settings › Computer use will say the part is missing. Relaunch to try again.",
  );
  return "failed";
}
