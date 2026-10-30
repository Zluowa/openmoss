import { assert, describe, it } from "@effect/vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDirectoryAlias } from "../fixtures/filesystem-links.ts";

import {
  createStagedLinuxNodePtyRebuildArgs,
  ELECTRON_HEADERS_URL,
  ELECTRON_REBUILD_VERSION,
  resolveElectronRebuildCli,
} from "./staged-linux-node-pty.ts";
import { STAGED_NODE_PTY_VERSION } from "./staged-windows-node-pty.ts";

interface Fixture {
  readonly repoRoot: string;
  readonly stageAppDir: string;
}

function writePackage(packageRoot: string, manifest: Record<string, unknown>): void {
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify(manifest));
}

function withFixture(run: (fixture: Fixture) => void): void {
  const root = mkdtempSync(path.join(tmpdir(), "moss-linux-node-pty-"));
  const repoRoot = path.join(root, "repo");
  const stageAppDir = path.join(root, "stage");
  writePackage(repoRoot, { name: "fixture-repo" });
  writePackage(stageAppDir, {
    name: "moss-desktop",
    devDependencies: { electron: "43.1.1" },
  });
  writePackage(path.join(stageAppDir, "node_modules", "node-pty"), {
    name: "node-pty",
    version: STAGED_NODE_PTY_VERSION,
  });
  const rebuildRoot = path.join(repoRoot, "node_modules", "@electron", "rebuild");
  writePackage(rebuildRoot, {
    name: "@electron/rebuild",
    version: ELECTRON_REBUILD_VERSION,
  });
  mkdirSync(path.join(rebuildRoot, "lib"), { recursive: true });
  writeFileSync(path.join(rebuildRoot, "lib", "cli.js"), "#!/usr/bin/env node\n");

  try {
    run({ repoRoot, stageAppDir });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

describe("staged Linux node-pty rebuild", () => {
  it("targets only node-pty with the staged Electron version and a source build", () => {
    withFixture(({ repoRoot, stageAppDir }) => {
      assert.equal(
        resolveElectronRebuildCli(repoRoot),
        path.join(realpathSync(repoRoot), "node_modules", "@electron", "rebuild", "lib", "cli.js"),
      );
      assert.deepStrictEqual(
        createStagedLinuxNodePtyRebuildArgs({
          arch: "x64",
          electronVersion: "43.1.1",
          stageAppDir,
        }),
        [
          "--version",
          "43.1.1",
          "--arch",
          "x64",
          "--platform",
          "linux",
          "--dist-url",
          ELECTRON_HEADERS_URL,
          "--module-dir",
          realpathSync(stageAppDir),
          "--only",
          "node-pty",
          "--force",
          "--build-from-source",
          "--disable-pre-gyp-copy",
          "--sequential",
        ],
      );
    });
  });

  it("fails closed for unexpected tool, Electron, or node-pty versions", () => {
    withFixture(({ repoRoot, stageAppDir }) => {
      writePackage(path.join(repoRoot, "node_modules", "@electron", "rebuild"), {
        name: "@electron/rebuild",
        version: "4.1.0",
      });
      assert.throws(
        () => resolveElectronRebuildCli(repoRoot),
        /Expected @electron\/rebuild 4\.2\.0/,
      );

      assert.throws(
        () =>
          createStagedLinuxNodePtyRebuildArgs({
            arch: "x64",
            electronVersion: "42.0.0",
            stageAppDir,
          }),
        /does not match rebuild target 42\.0\.0/,
      );

      writePackage(path.join(stageAppDir, "node_modules", "node-pty"), {
        name: "node-pty",
        version: "1.0.0",
      });
      assert.throws(
        () =>
          createStagedLinuxNodePtyRebuildArgs({
            arch: "x64",
            electronVersion: "43.1.1",
            stageAppDir,
          }),
        /Expected staged node-pty 1\.1\.0/,
      );
    });
  });

  it("rejects a staged node-pty symlink that escapes the isolated stage", () => {
    withFixture(({ stageAppDir }) => {
      const linkedPackageRoot = path.join(stageAppDir, "node_modules", "node-pty");
      const externalPackageRoot = path.join(path.dirname(stageAppDir), "external-node-pty");
      rmSync(linkedPackageRoot, { recursive: true });
      writePackage(externalPackageRoot, {
        name: "node-pty",
        version: STAGED_NODE_PTY_VERSION,
      });
      createDirectoryAlias(externalPackageRoot, linkedPackageRoot);

      assert.throws(
        () =>
          createStagedLinuxNodePtyRebuildArgs({
            arch: "x64",
            electronVersion: "43.1.1",
            stageAppDir,
          }),
        /resolves outside the isolated stage directory/,
      );
    });
  });
});
