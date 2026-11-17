import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { classifyFastRefreshChanges } from "./desktop-fast-refresh-policy.ts";
import {
  WINDOWS_JOB_LAUNCHER_PACKAGED_PATH,
  WINDOWS_JOB_LAUNCHER_PIN_PATH,
  windowsJobLauncherArchError,
} from "./windows-native-job-launcher.ts";

const repoRoot = join(import.meta.dirname, "..", "..");
const read = (path: string) => JSON.parse(readFileSync(join(repoRoot, path), "utf8"));

describe("moss-job-launch.exe in the Windows package", () => {
  it("is a preserved payload pinned to the same bytes as its build pin", () => {
    const pin = read(WINDOWS_JOB_LAUNCHER_PIN_PATH);
    const manifest = read("scripts/windows-native-payload-manifest.json");
    const entry = manifest.windows.x64.preservedPayloads.find(
      (candidate: { path: string }) => candidate.path === WINDOWS_JOB_LAUNCHER_PACKAGED_PATH,
    );
    expect(entry).toBeDefined();
    expect(entry.sha256).toBe(pin.sha256);
    expect(entry.source).toContain(`LLVM ${pin.llvm.version}`);
  });

  it("is built for x64 only", () => {
    expect(windowsJobLauncherArchError("x64")).toBeNull();
    expect(windowsJobLauncherArchError("arm64")).toMatch(/x64 Windows only/u);
  });

  it("cannot reach an installed app through a fast refresh", () => {
    for (const path of [
      "apps/server/native/moss-job-launch/moss-job-launch.c",
      "apps/server/native/moss-job-launch/moss-job-launch.pin.json",
      "apps/server/scripts/build-windows-job-launcher.mjs",
    ]) {
      expect(classifyFastRefreshChanges([path], () => ({ before: null, after: null }))).not.toEqual(
        [],
      );
    }
  });
});
