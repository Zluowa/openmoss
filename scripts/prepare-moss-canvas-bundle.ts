// FILE: prepare-moss-canvas-bundle.ts
// Purpose: Build and stage the immutable Open Moss Canvas source for desktop artifacts.
// Layer: Release/build entry point
//
// Usage: node scripts/prepare-moss-canvas-bundle.ts [canvasSourceDir] [--reuse-dependencies]

import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";

import { MOSS_CANVAS_BUNDLE_DIR, prepareMossCanvasBundle } from "./lib/bundled-moss-canvas.ts";
import { canvasLockfileSha256, readMossCanvasSourcePin } from "./lib/moss-canvas-source-pin.ts";

const sourceDir = process.argv[2] || process.env.MOSS_CANVAS_SOURCE_DIR || "";
if (!sourceDir) {
  console.error(
    "Usage: prepare-moss-canvas-bundle <canvasSourceDir> (or set MOSS_CANVAS_SOURCE_DIR)",
  );
  process.exit(1);
}

const repoRoot = resolve(import.meta.dirname, "..");
const sourceDirectory = resolve(sourceDir);
const pin = readMossCanvasSourcePin(repoRoot);
function git(...args: string[]) {
  const result = spawnSync("git", args, {
    cwd: sourceDirectory,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error("Could not verify the pinned Canvas checkout");
  return result.stdout.trim();
}
if (
  git("rev-parse", "HEAD") !== pin.commit ||
  git("rev-parse", "HEAD^{tree}") !== pin.tree ||
  git("status", "--porcelain", "--untracked-files=no") ||
  canvasLockfileSha256(sourceDirectory) !== pin.lockfileSha256
)
  throw new Error("Canvas checkout must be clean and match its immutable source pin");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function run(args: string[]) {
  const result = spawnSync(npm, args, {
    cwd: sourceDirectory,
    stdio: "inherit",
    windowsHide: true,
    shell: process.platform === "win32",
    env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: "1" },
  });
  if (result.status !== 0) throw new Error(`Canvas build step failed: npm ${args.join(" ")}`);
}
if (!process.argv.includes("--reuse-dependencies")) run(["ci", "--ignore-scripts"]);
run(["--prefix", "apps/codex-canvas", "run", "typecheck"]);
const tests = spawnSync(
  process.execPath,
  ["--test", "apps/codex-canvas/server/hosted-storage.test.mjs"],
  {
    cwd: sourceDirectory,
    stdio: "inherit",
    windowsHide: true,
  },
);
if (tests.status !== 0) throw new Error("Canvas durable-storage verification failed");
run(["--prefix", "apps/codex-canvas", "run", "build"]);
const validation = prepareMossCanvasBundle({
  sourceDir: sourceDirectory,
  targetDir: join(repoRoot, MOSS_CANVAS_BUNDLE_DIR),
  sourcePin: pin,
});
console.log(
  `[prepare-moss-canvas-bundle] Staged ${validation.fileCount} files (sha256 ${validation.sha256}) into ${MOSS_CANVAS_BUNDLE_DIR}.`,
);
