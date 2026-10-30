import { assert, describe, it } from "@effect/vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createRejectedFileAlias } from "../fixtures/filesystem-links.ts";

import {
  pruneStagedWindowsNativeDependencies,
  STAGED_WINDOWS_NATIVE_PACKAGE_VERSIONS,
  WINDOWS_TARGET_NATIVE_DEPENDENCY_FILES,
} from "./staged-windows-native-dependencies.ts";
import {
  STAGED_NODE_PTY_VERSION,
  WINDOWS_NODE_PTY_NATIVE_FILES,
} from "./staged-windows-node-pty.ts";

interface WindowsNativeFixture {
  readonly msgpackrHostBuild: string;
  readonly piTuiOther: string;
  readonly stageAppDir: string;
}

function writePackage(root: string, name: string, version: string): string {
  const packageRoot = path.join(root, "node_modules", ...name.split("/"));
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name, version }));
  return packageRoot;
}

function withFixture(run: (fixture: WindowsNativeFixture) => void): void {
  const stageAppDir = mkdtempSync(path.join(tmpdir(), "moss-windows-native-stage-"));
  const nodePtyRoot = writePackage(stageAppDir, "node-pty", STAGED_NODE_PTY_VERSION);
  for (const arch of ["x64", "arm64"]) {
    for (const relativePath of WINDOWS_NODE_PTY_NATIVE_FILES) {
      const filePath = path.join(nodePtyRoot, "prebuilds", `win32-${arch}`, relativePath);
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, `${arch}:${relativePath}`);
    }
  }

  for (const [name, version] of Object.entries(STAGED_WINDOWS_NATIVE_PACKAGE_VERSIONS)) {
    writePackage(stageAppDir, name, version);
  }
  for (const relativePath of WINDOWS_TARGET_NATIVE_DEPENDENCY_FILES) {
    const filePath = path.join(stageAppDir, ...relativePath.split("/"));
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `reviewed:${relativePath}`);
  }
  const msgpackrHostBuild = path.join(
    stageAppDir,
    "node_modules/msgpackr-extract/build/Release/extract.node",
  );
  mkdirSync(path.dirname(msgpackrHostBuild), { recursive: true });
  writeFileSync(msgpackrHostBuild, "host-native");
  const piTuiOther = path.join(
    stageAppDir,
    "node_modules/@earendil-works/pi-tui/native/darwin/prebuilds/darwin-arm64/darwin-platform.node",
  );
  mkdirSync(path.dirname(piTuiOther), { recursive: true });
  writeFileSync(piTuiOther, "wrong-platform");

  try {
    run({ msgpackrHostBuild, piTuiOther, stageAppDir });
  } finally {
    rmSync(stageAppDir, { force: true, recursive: true });
  }
}

describe("pruneStagedWindowsNativeDependencies", () => {
  it("reviews the native dependency versions actually installed by the frozen stage lock", () => {
    const lockfile = readFileSync(
      new URL("../desktop-stage-lock/bun.lock", import.meta.url),
      "utf8",
    );
    for (const [packageName, version] of Object.entries(STAGED_WINDOWS_NATIVE_PACKAGE_VERSIONS)) {
      const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = lockfile.match(
        new RegExp(`^\\s*"${escapedName}": \\["${escapedName}@([^"\\s]+)"`, "m"),
      );
      assert.equal(match?.[1], version, `Review native payloads when ${packageName} changes`);
    }

    const manifest = JSON.parse(
      readFileSync(new URL("../windows-native-payload-manifest.json", import.meta.url), "utf8"),
    ) as {
      windows: { x64: { preservedPayloads: Array<{ path: string; source: string }> } };
    };
    const dependencyEntries = manifest.windows.x64.preservedPayloads.filter(
      (entry) =>
        entry.path.startsWith("resources/app.asar.unpacked/node_modules/") &&
        !entry.path.startsWith("resources/app.asar.unpacked/node_modules/node-pty/"),
    );
    assert.deepStrictEqual(
      dependencyEntries.map((entry) => entry.path).toSorted(),
      WINDOWS_TARGET_NATIVE_DEPENDENCY_FILES.map(
        (file) => `resources/app.asar.unpacked/${file}`,
      ).toSorted(),
    );
    for (const entry of dependencyEntries) {
      const reviewedPackage = Object.entries(STAGED_WINDOWS_NATIVE_PACKAGE_VERSIONS).find(
        ([name]) => entry.path.startsWith(`resources/app.asar.unpacked/node_modules/${name}/`),
      );
      assert.ok(reviewedPackage, `Expected a reviewed package for ${entry.path}`);
      assert.equal(entry.source, `${reviewedPackage[0]}@${reviewedPackage[1]}`);
    }
  });

  it("removes host and cross-platform binaries while retaining the reviewed x64 set", () => {
    withFixture(({ msgpackrHostBuild, piTuiOther, stageAppDir }) => {
      const result = pruneStagedWindowsNativeDependencies({ stageAppDir, arch: "x64" });
      assert.equal(
        result.retainedNativeFiles.length,
        WINDOWS_TARGET_NATIVE_DEPENDENCY_FILES.length,
      );
      assert.equal(result.removedPaths.length > 0, true);
      assert.equal(existsSync(msgpackrHostBuild), false);
      assert.equal(existsSync(piTuiOther), false);
      for (const filePath of result.retainedNativeFiles) {
        assert.doesNotThrow(() => assertRegularFixture(filePath));
      }
    });
  });

  it("fails closed for unreviewed architectures and non-regular target payloads", () => {
    withFixture(({ stageAppDir }) => {
      assert.throws(
        () => pruneStagedWindowsNativeDependencies({ stageAppDir, arch: "arm64" }),
        /supports x64 only/,
      );
    });
    withFixture(({ stageAppDir }) => {
      const target = path.join(
        stageAppDir,
        "node_modules/@earendil-works/pi-tui/native/win32/prebuilds/win32-x64/win32-platform.node",
      );
      rmSync(target);
      createRejectedFileAlias(
        path.join(stageAppDir, "node_modules/@earendil-works/pi-tui/package.json"),
        target,
      );
      assert.throws(
        () => pruneStagedWindowsNativeDependencies({ stageAppDir, arch: "x64" }),
        /must be a regular file/,
      );
    });
  });

  it("fails closed when the Pi version or required platform helper drifts", () => {
    withFixture(({ stageAppDir }) => {
      writePackage(stageAppDir, "@earendil-works/pi-tui", "0.85.1");
      assert.throws(
        () => pruneStagedWindowsNativeDependencies({ stageAppDir, arch: "x64" }),
        /Expected staged @earendil-works\/pi-tui@0\.87\.1/,
      );
    });
    withFixture(({ stageAppDir }) => {
      rmSync(path.join(stageAppDir, WINDOWS_TARGET_NATIVE_DEPENDENCY_FILES[0]));
      assert.throws(
        () => pruneStagedWindowsNativeDependencies({ stageAppDir, arch: "x64" }),
        /missing .*win32-platform\.node/,
      );
    });
  });
});

function assertRegularFixture(filePath: string): void {
  const stat = statSync(filePath);
  assert.equal(stat.isFile() && stat.size > 0, true);
}
