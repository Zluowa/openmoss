// Where the backend finds moss-job-launch.exe (apps/server/native/moss-job-launch): the
// Windows launcher that runs auxiliary Codex processes inside a kill-on-close Job Object.
// Packaged builds carry it in resources/moss-job-launch (a full installer; a fast refresh of
// app.asar does not add or change it). A development run uses the local build. When the file
// is missing the backend refuses those processes on Windows, as it did before the launcher.
import * as Path from "node:path";

const WINDOWS_JOB_LAUNCHER_FILE = "moss-job-launch.exe";
export const WINDOWS_JOB_LAUNCHER_RESOURCE_DIR = "moss-job-launch";
export const MOSS_WINDOWS_JOB_LAUNCHER_PATH_ENV = "MOSS_WINDOWS_JOB_LAUNCHER_PATH";

interface WindowsJobLauncherPathInput {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly desktopMainDirname: string;
}

export function resolveWindowsJobLauncherPath(input: WindowsJobLauncherPathInput): string {
  return input.isPackaged
    ? Path.join(input.resourcesPath, WINDOWS_JOB_LAUNCHER_RESOURCE_DIR, WINDOWS_JOB_LAUNCHER_FILE)
    : Path.resolve(
        input.desktopMainDirname,
        "..",
        "..",
        "server",
        "native",
        "moss-job-launch",
        "build",
        WINDOWS_JOB_LAUNCHER_FILE,
      );
}

/** The backend environment with the launcher's path on Windows, and never an inherited one. */
export function windowsJobLauncherBackendEnv(
  input: WindowsJobLauncherPathInput & {
    readonly inheritedEnv: NodeJS.ProcessEnv;
    readonly platform: NodeJS.Platform;
  },
): NodeJS.ProcessEnv {
  const env = { ...input.inheritedEnv };
  delete env[MOSS_WINDOWS_JOB_LAUNCHER_PATH_ENV];
  if (input.platform !== "win32") return env;
  env[MOSS_WINDOWS_JOB_LAUNCHER_PATH_ENV] = resolveWindowsJobLauncherPath(input);
  return env;
}
