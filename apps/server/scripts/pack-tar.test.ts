import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  createPackTarCommandPlan,
  createPackTarStreamCommandPlan,
  writePackTarGz,
} from "./pack-tar.ts";

describe("createPackTarCommandPlan", () => {
  it("uses POSIX path semantics for POSIX staging and output directories", () => {
    const outDir = "/var/tmp/moss-105-out";
    const stagedPackageDir = "/tmp/moss-cli-publish-123";

    const plan = createPackTarCommandPlan({
      stagedPackageDir,
      outDir,
      tarballName: "moss-server-1.0.5.tar.gz",
    });

    expect(plan.args).toEqual([
      "-czf",
      "moss-server-1.0.5.tar.gz",
      "-C",
      "../../../tmp/moss-cli-publish-123",
      "dist",
      "package.json",
      "npm-shrinkwrap.json",
    ]);
  });

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

  it("streams tar to stdout and writes a valid gzip archive readable by system tar", async () => {
    const plan = createPackTarStreamCommandPlan({
      stagedPackageDir: "/tmp/moss-cli-publish-123",
      outDir: "/var/tmp/moss-105-out",
      patchedRuntimeDirectory: "patched",
    });
    expect(plan.args).toEqual([
      "-cf",
      "-",
      "-C",
      "../../../tmp/moss-cli-publish-123",
      "dist",
      "package.json",
      "npm-shrinkwrap.json",
      "patched",
    ]);

    const root = mkdtempSync(path.join(tmpdir(), "moss-pack-tar-test-"));
    try {
      const stage = path.join(root, "stage");
      const outDir = path.join(root, "out");
      mkdirSync(path.join(stage, "dist/client"), { recursive: true });
      mkdirSync(outDir, { recursive: true });
      const longDir = path.join(
        stage,
        "dist",
        "client",
        "very-long-nested-segment-one-1234567890",
        "very-long-nested-segment-two-1234567890",
        "very-long-nested-segment-three-1234567890",
      );
      mkdirSync(longDir, { recursive: true });
      writeFileSync(path.join(longDir, "payload.txt"), "long-path-ok\n");
      writeFileSync(path.join(stage, "dist/index.mjs"), "console.log('ok');\n");
      writeFileSync(path.join(stage, "dist/client/index.html"), "<html></html>\n");
      writeFileSync(path.join(stage, "package.json"), '{"name":"@moss/cli"}\n');
      writeFileSync(path.join(stage, "npm-shrinkwrap.json"), '{"lockfileVersion":3}\n');

      const archivePath = await writePackTarGz({
        stagedPackageDir: stage,
        outDir,
        tarballName: "moss-server-test.tar.gz",
      });
      const listed = spawnSync("tar", ["-tzf", archivePath], { encoding: "utf8" });
      expect(listed.status).toBe(0);
      const entries = listed.stdout
        .split(/\r?\n/u)
        .map((line) => line.replace(/^\.\//u, "").replace(/\/$/u, ""))
        .filter(Boolean);
      expect(entries).toContain("dist/index.mjs");
      expect(entries).toContain("dist/client/index.html");
      expect(entries).toContain(
        "dist/client/very-long-nested-segment-one-1234567890/very-long-nested-segment-two-1234567890/very-long-nested-segment-three-1234567890/payload.txt",
      );
      expect(entries).toContain("package.json");
      expect(entries).toContain("npm-shrinkwrap.json");

      const extractedDir = path.join(root, "extracted");
      mkdirSync(extractedDir, { recursive: true });
      const extracted = spawnSync("tar", ["-xzf", archivePath, "-C", extractedDir], {
        encoding: "utf8",
      });
      expect(extracted.status).toBe(0);
      const { readFileSync } = await import("node:fs");
      expect(readFileSync(path.join(extractedDir, "dist/index.mjs"), "utf8")).toBe(
        "console.log('ok');\n",
      );
      expect(
        readFileSync(
          path.join(
            extractedDir,
            "dist/client/very-long-nested-segment-one-1234567890/very-long-nested-segment-two-1234567890/very-long-nested-segment-three-1234567890/payload.txt",
          ),
          "utf8",
        ),
      ).toBe("long-path-ok\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
