import { assert, describe, it } from "@effect/vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createRejectedFileAlias } from "../fixtures/filesystem-links.ts";

import {
  pruneStagedWindowsNodePty,
  STAGED_NODE_PTY_VERSION,
  WINDOWS_NODE_PTY_NATIVE_FILES,
} from "./staged-windows-node-pty.ts";

interface NodePtyFixture {
  readonly packageRoot: string;
  readonly stageAppDir: string;
}

function withNodePtyFixture(run: (fixture: NodePtyFixture) => void): void {
  const stageAppDir = mkdtempSync(path.join(tmpdir(), "moss-node-pty-stage-"));
  const packageRoot = path.join(stageAppDir, "node_modules", "node-pty");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "node-pty", version: STAGED_NODE_PTY_VERSION }),
  );
  for (const arch of ["x64", "arm64"]) {
    for (const relativePath of WINDOWS_NODE_PTY_NATIVE_FILES) {
      const filePath = path.join(packageRoot, "prebuilds", `win32-${arch}`, relativePath);
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, `${arch}:${relativePath}`);
    }
  }
  mkdirSync(path.join(packageRoot, "prebuilds", "darwin-arm64"), { recursive: true });
  writeFileSync(path.join(packageRoot, "prebuilds", "darwin-arm64", "pty.node"), "darwin");
  mkdirSync(path.join(packageRoot, "build", "Release"), { recursive: true });
  writeFileSync(path.join(packageRoot, "build", "Release", "unreviewed.node"), "build");
  mkdirSync(path.join(packageRoot, "third_party"), { recursive: true });
  writeFileSync(path.join(packageRoot, "third_party", "unreviewed.dll"), "third-party");
  writeFileSync(path.join(packageRoot, "prebuilds", "win32-x64", "conpty.pdb"), "symbols");

  try {
    run({ packageRoot, stageAppDir });
  } finally {
    rmSync(stageAppDir, { force: true, recursive: true });
  }
}

describe("pruneStagedWindowsNodePty", () => {
  it("retains only the reviewed target prebuilds and removes build inputs with native payloads", () => {
    withNodePtyFixture(({ packageRoot, stageAppDir }) => {
      const result = pruneStagedWindowsNodePty({ stageAppDir, arch: "x64" });

      assert.deepStrictEqual(
        result.removedPaths
          .map((entry) => path.relative(result.packageRoot, entry).split(path.sep).join("/"))
          .sort(),
        [
          "build",
          "prebuilds/darwin-arm64",
          "prebuilds/win32-arm64",
          "prebuilds/win32-x64/conpty.pdb",
          "third_party",
        ],
      );
      for (const relativePath of WINDOWS_NODE_PTY_NATIVE_FILES) {
        assert.equal(
          readFileSync(path.join(result.targetPrebuildDirectory, relativePath), "utf8"),
          `x64:${relativePath}`,
        );
      }
    });
  });

  it("fails closed when a required target payload is missing", () => {
    withNodePtyFixture(({ packageRoot, stageAppDir }) => {
      rmSync(path.join(packageRoot, "prebuilds", "win32-x64", "pty.node"));
      assert.throws(
        () => pruneStagedWindowsNodePty({ stageAppDir, arch: "x64" }),
        /missing pty\.node/,
      );
    });
  });

  it("rejects required directories and symlinks instead of following them", () => {
    withNodePtyFixture(({ packageRoot, stageAppDir }) => {
      const requiredPath = path.join(packageRoot, "prebuilds", "win32-x64", "pty.node");
      rmSync(requiredPath);
      mkdirSync(requiredPath);
      assert.throws(
        () => pruneStagedWindowsNodePty({ stageAppDir, arch: "x64" }),
        /must be a regular file/,
      );
    });

    withNodePtyFixture(({ packageRoot, stageAppDir }) => {
      const requiredPath = path.join(packageRoot, "prebuilds", "win32-x64", "pty.node");
      rmSync(requiredPath);
      createRejectedFileAlias(path.join(packageRoot, "package.json"), requiredPath);
      assert.throws(
        () => pruneStagedWindowsNodePty({ stageAppDir, arch: "x64" }),
        /must be a regular file/,
      );
    });
  });
});
