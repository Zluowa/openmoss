// FILE: windows-native-job-launcher.ts
// Purpose: Where the Windows package takes moss-job-launch.exe from and puts it, and the
//          byte pin it must match (apps/server/native/moss-job-launch/moss-job-launch.pin.json,
//          also recorded as a preserved payload in windows-native-payload-manifest.json).
// Layer: Release/build support

/** Built into the stage by apps/server/scripts/build-windows-job-launcher.mjs. */
export const WINDOWS_JOB_LAUNCHER_STAGE_PATH =
  "apps/server/native/moss-job-launch/build/moss-job-launch.exe";
/** Under resources/, outside app.asar: the backend starts it by path. */
export const WINDOWS_JOB_LAUNCHER_RESOURCE_PATH = "moss-job-launch/moss-job-launch.exe";
export const WINDOWS_JOB_LAUNCHER_PACKAGED_PATH = `resources/${WINDOWS_JOB_LAUNCHER_RESOURCE_PATH}`;
export const WINDOWS_JOB_LAUNCHER_EXTRA_RESOURCE = {
  from: WINDOWS_JOB_LAUNCHER_STAGE_PATH,
  to: WINDOWS_JOB_LAUNCHER_RESOURCE_PATH,
} as const;
/** Keeps the source, pin and build output out of app.asar. */
export const WINDOWS_JOB_LAUNCHER_ASAR_EXCLUSION = "!apps/server/native/moss-job-launch/**";
export const WINDOWS_JOB_LAUNCHER_BUILD_SCRIPT =
  "apps/server/scripts/build-windows-job-launcher.mjs";
export const WINDOWS_JOB_LAUNCHER_PIN_PATH =
  "apps/server/native/moss-job-launch/moss-job-launch.pin.json";

/** Only x64 Windows packages are built; the launcher is pinned for that target alone. */
export function windowsJobLauncherArchError(arch: string): string | null {
  return arch === "x64"
    ? null
    : `moss-job-launch.exe is pinned for x64 Windows only; a ${arch} package has no reviewed launcher.`;
}
