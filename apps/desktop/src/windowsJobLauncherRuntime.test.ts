import * as Path from "node:path";

import { describe, expect, it } from "vitest";

import {
  MOSS_WINDOWS_JOB_LAUNCHER_PATH_ENV,
  resolveWindowsJobLauncherPath,
  windowsJobLauncherBackendEnv,
} from "./windowsJobLauncherRuntime";

describe("windowsJobLauncherBackendEnv", () => {
  const base = {
    resourcesPath: Path.join("C:", "Moss", "resources"),
    desktopMainDirname: Path.join("D:", "repo", "apps", "desktop", "dist-electron"),
  };

  it("points a packaged Windows backend at resources/moss-job-launch", () => {
    const env = windowsJobLauncherBackendEnv({
      ...base,
      isPackaged: true,
      platform: "win32",
      inheritedEnv: { KEEP: "1" },
    });
    expect(env[MOSS_WINDOWS_JOB_LAUNCHER_PATH_ENV]).toBe(
      Path.join(base.resourcesPath, "moss-job-launch", "moss-job-launch.exe"),
    );
    expect(env.KEEP).toBe("1");
  });

  it("points a development run at the local build", () => {
    expect(resolveWindowsJobLauncherPath({ ...base, isPackaged: false })).toBe(
      Path.join(
        "D:",
        "repo",
        "apps",
        "server",
        "native",
        "moss-job-launch",
        "build",
        "moss-job-launch.exe",
      ),
    );
  });

  it("never passes an inherited path, and sets none off Windows", () => {
    const env = windowsJobLauncherBackendEnv({
      ...base,
      isPackaged: true,
      platform: "darwin",
      inheritedEnv: { [MOSS_WINDOWS_JOB_LAUNCHER_PATH_ENV]: "C:\\elsewhere\\x.exe" },
    });
    expect(env[MOSS_WINDOWS_JOB_LAUNCHER_PATH_ENV]).toBeUndefined();
  });
});
