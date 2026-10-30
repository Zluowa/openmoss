// FILE: staged-linux-node-pty.ts
// Purpose: Validates and configures the one allowed native rebuild in staged Linux artifacts.
// Layer: Release/build script support

import * as FS from "node:fs";
import * as Path from "node:path";

import { STAGED_NODE_PTY_VERSION } from "./staged-windows-node-pty.ts";

export const ELECTRON_REBUILD_VERSION = "4.2.0";
export const ELECTRON_HEADERS_URL = "https://www.electronjs.org/headers";

function isWithin(parent: string, child: string): boolean {
  const relative = Path.relative(parent, child);
  return (
    relative !== "" &&
    !relative.startsWith(`..${Path.sep}`) &&
    relative !== ".." &&
    !Path.isAbsolute(relative)
  );
}

function readManifest(filePath: string): Record<string, unknown> {
  const stat = FS.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${filePath} must be a regular package manifest.`);
  }
  return JSON.parse(FS.readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

export function resolveElectronRebuildCli(repoRoot: string): string {
  const realRepoRoot = FS.realpathSync(repoRoot);
  const linkedPackageRoot = Path.join(repoRoot, "node_modules", "@electron", "rebuild");
  const packageRoot = FS.realpathSync(linkedPackageRoot);
  if (!isWithin(realRepoRoot, packageRoot)) {
    throw new Error("@electron/rebuild resolves outside the repository install.");
  }

  const manifest = readManifest(Path.join(packageRoot, "package.json"));
  if (manifest.name !== "@electron/rebuild" || manifest.version !== ELECTRON_REBUILD_VERSION) {
    throw new Error(
      `Expected @electron/rebuild ${ELECTRON_REBUILD_VERSION}, got ${String(manifest.version)}.`,
    );
  }

  const cliPath = Path.join(packageRoot, "lib", "cli.js");
  const cliStat = FS.lstatSync(cliPath);
  if (cliStat.isSymbolicLink() || !cliStat.isFile()) {
    throw new Error("@electron/rebuild CLI must be a regular file.");
  }
  return cliPath;
}

export function createStagedLinuxNodePtyRebuildArgs(input: {
  readonly arch: "arm64" | "x64";
  readonly electronVersion: string;
  readonly stageAppDir: string;
}): ReadonlyArray<string> {
  const realStageRoot = FS.realpathSync(input.stageAppDir);
  const stageManifest = readManifest(Path.join(realStageRoot, "package.json"));
  const stageElectronVersion = (
    stageManifest.devDependencies as Record<string, unknown> | undefined
  )?.electron;
  if (stageElectronVersion !== input.electronVersion) {
    throw new Error(
      `Staged Electron version ${String(stageElectronVersion)} does not match rebuild target ${input.electronVersion}.`,
    );
  }

  const linkedPackageRoot = Path.join(realStageRoot, "node_modules", "node-pty");
  const packageRoot = FS.realpathSync(linkedPackageRoot);
  if (!isWithin(realStageRoot, packageRoot)) {
    throw new Error("Staged node-pty package resolves outside the isolated stage directory.");
  }
  const manifest = readManifest(Path.join(packageRoot, "package.json"));
  if (manifest.name !== "node-pty" || manifest.version !== STAGED_NODE_PTY_VERSION) {
    throw new Error(
      `Expected staged node-pty ${STAGED_NODE_PTY_VERSION}, got ${String(manifest.version)}.`,
    );
  }

  return [
    "--version",
    input.electronVersion,
    "--arch",
    input.arch,
    "--platform",
    "linux",
    "--dist-url",
    ELECTRON_HEADERS_URL,
    "--module-dir",
    realStageRoot,
    "--only",
    "node-pty",
    "--force",
    "--build-from-source",
    "--disable-pre-gyp-copy",
    "--sequential",
  ];
}
