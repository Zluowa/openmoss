import { describe, expect, it } from "vitest";

import { createPackTarCommandPlan } from "./pack-tar.ts";

describe("createPackTarCommandPlan", () => {
  it("uses a relative archive name from the output directory", () => {
    const outDir = "C:\\DevTemp\\moss-105-out";
    const stagedPackageDir = "C:\\Users\\runner\\AppData\\Local\\Temp\\moss-cli-publish-123";
    const tarballName = "moss-server-1.0.5.tar.gz";

    const plan = createPackTarCommandPlan({
      stagedPackageDir,
      outDir,
      tarballName,
      patchedRuntimeDirectory: "patched",
    });

    expect(plan.cwd).toBe(outDir);
    expect(plan.args).toEqual([
      "-czf",
      tarballName,
      "-C",
      "..\\..\\Users\\runner\\AppData\\Local\\Temp\\moss-cli-publish-123",
      "dist",
      "package.json",
      "npm-shrinkwrap.json",
      "patched",
    ]);
  });

  it("forces local path handling when staging and output use different volumes", () => {
    const plan = createPackTarCommandPlan({
      stagedPackageDir: "C:\\Users\\runner\\AppData\\Local\\Temp\\moss-cli-publish-123",
      outDir: "D:\\DevTemp\\moss-105-out",
      tarballName: "moss-server-1.0.5.tar.gz",
    });

    expect(plan.args).toEqual([
      "--force-local",
      "-czf",
      "moss-server-1.0.5.tar.gz",
      "-C",
      "C:\\Users\\runner\\AppData\\Local\\Temp\\moss-cli-publish-123",
      "dist",
      "package.json",
      "npm-shrinkwrap.json",
    ]);
  });
});
