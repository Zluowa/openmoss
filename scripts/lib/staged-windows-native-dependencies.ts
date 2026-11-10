// FILE: staged-windows-native-dependencies.ts
// Purpose: Retains only the reviewed win32-x64 native dependency payloads in the desktop stage.
// Layer: Release/build script support

import * as FS from "node:fs";
import * as Path from "node:path";

import { pruneStagedWindowsNodePty } from "./staged-windows-node-pty.ts";

export const STAGED_WINDOWS_NATIVE_PACKAGE_VERSIONS = {
  "@msgpackr-extract/msgpackr-extract-win32-x64": "3.0.4",
  "msgpackr-extract": "3.0.4",
  "rookie-cookies-win32-x64-msvc": "0.6.0",
} as const;

export const WINDOWS_TARGET_NATIVE_DEPENDENCY_FILES = [
  "node_modules/@msgpackr-extract/msgpackr-extract-win32-x64/node.abi115.node",
  "node_modules/@msgpackr-extract/msgpackr-extract-win32-x64/node.napi.node",
  "node_modules/rookie-cookies-win32-x64-msvc/rookie_cookies.win32-x64-msvc.node",
] as const;

export interface PrunedStagedWindowsNativeDependencies {
  readonly removedPaths: ReadonlyArray<string>;
  readonly retainedNativeFiles: ReadonlyArray<string>;
}

function pathExists(filePath: string): boolean {
  try {
    FS.lstatSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isWithin(parent: string, child: string): boolean {
  const relative = Path.relative(parent, child);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${Path.sep}`) &&
    !Path.isAbsolute(relative)
  );
}

function assertRegularFile(filePath: string, label: string): void {
  let stat: FS.Stats;
  try {
    stat = FS.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Staged Windows native dependency is missing ${label}.`);
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Staged Windows native dependency ${label} must be a regular file.`);
  }
}

function resolveReviewedPackageRoot(
  stageAppDir: string,
  packageName: keyof typeof STAGED_WINDOWS_NATIVE_PACKAGE_VERSIONS,
): string {
  const linkedRoot = Path.join(stageAppDir, "node_modules", ...packageName.split("/"));
  if (!pathExists(linkedRoot)) {
    throw new Error(`Staged Windows native package is missing: ${packageName}.`);
  }
  const stageRoot = FS.realpathSync(stageAppDir);
  const packageRoot = FS.realpathSync(linkedRoot);
  if (!isWithin(stageRoot, packageRoot)) {
    throw new Error(
      `Staged Windows native package resolves outside the isolated stage: ${packageName}.`,
    );
  }
  const manifestPath = Path.join(packageRoot, "package.json");
  assertRegularFile(manifestPath, `${packageName}/package.json`);
  const manifest = JSON.parse(FS.readFileSync(manifestPath, "utf8")) as {
    name?: unknown;
    version?: unknown;
  };
  const expectedVersion = STAGED_WINDOWS_NATIVE_PACKAGE_VERSIONS[packageName];
  if (manifest.name !== packageName || manifest.version !== expectedVersion) {
    throw new Error(
      `Expected staged ${packageName}@${expectedVersion}, got ${String(manifest.name)}@${String(manifest.version)}.`,
    );
  }
  return packageRoot;
}

export function pruneStagedWindowsNativeDependencies(input: {
  readonly stageAppDir: string;
  readonly arch: "arm64" | "x64";
}): PrunedStagedWindowsNativeDependencies {
  if (input.arch !== "x64") {
    throw new Error(
      `Reviewed Windows native dependency inventory currently supports x64 only, got ${input.arch}.`,
    );
  }

  const removedPaths = [
    ...pruneStagedWindowsNodePty({ stageAppDir: input.stageAppDir, arch: input.arch }).removedPaths,
  ];

  // Betterwright's cookie bridge needs this native runtime dependency. Validate its
  // exact locked version before packing.
  resolveReviewedPackageRoot(input.stageAppDir, "rookie-cookies-win32-x64-msvc");

  const msgpackrTargetRoot = resolveReviewedPackageRoot(
    input.stageAppDir,
    "@msgpackr-extract/msgpackr-extract-win32-x64",
  );
  for (const file of ["node.abi115.node", "node.napi.node"]) {
    assertRegularFile(
      Path.join(msgpackrTargetRoot, file),
      `@msgpackr-extract/msgpackr-extract-win32-x64/${file}`,
    );
  }

  const msgpackrRoot = resolveReviewedPackageRoot(input.stageAppDir, "msgpackr-extract");
  const hostBuildDirectory = Path.join(msgpackrRoot, "build");
  if (pathExists(hostBuildDirectory)) {
    FS.rmSync(hostBuildDirectory, { force: true, recursive: true });
    removedPaths.push(hostBuildDirectory);
  }

  const retainedNativeFiles = WINDOWS_TARGET_NATIVE_DEPENDENCY_FILES.map((relativePath) =>
    Path.join(input.stageAppDir, ...relativePath.split("/")),
  );
  for (const [index, filePath] of retainedNativeFiles.entries()) {
    assertRegularFile(filePath, WINDOWS_TARGET_NATIVE_DEPENDENCY_FILES[index] ?? filePath);
  }

  return { removedPaths, retainedNativeFiles };
}
