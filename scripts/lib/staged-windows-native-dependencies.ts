// FILE: staged-windows-native-dependencies.ts
// Purpose: Retains only the reviewed win32-x64 native dependency payloads in the desktop stage.
// Layer: Release/build script support

import * as FS from "node:fs";
import * as Path from "node:path";

import { pruneStagedWindowsNodePty } from "./staged-windows-node-pty.ts";

export const STAGED_WINDOWS_NATIVE_PACKAGE_VERSIONS = {
  // Pi 0.87.1 folds clipboard access into its platform helper; there is no
  // separate @mariozechner/clipboard native package in the frozen stage lock.
  "@earendil-works/pi-tui": "0.87.1",
  "@esbuild/win32-x64": "0.28.2",
  "@msgpackr-extract/msgpackr-extract-win32-x64": "3.0.4",
  "msgpackr-extract": "3.0.4",
  "rookie-cookies-win32-x64-msvc": "0.6.0",
} as const;

export const WINDOWS_TARGET_NATIVE_DEPENDENCY_FILES = [
  "node_modules/@earendil-works/pi-tui/native/win32/prebuilds/win32-x64/win32-platform.node",
  "node_modules/@esbuild/win32-x64/esbuild.exe",
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

function assertRegularDirectory(directoryPath: string, label: string): void {
  let stat: FS.Stats;
  try {
    stat = FS.lstatSync(directoryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Staged Windows native dependency is missing ${label}.`);
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Staged Windows native dependency ${label} must be a regular directory.`);
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

function prunePiTui(stageAppDir: string, removedPaths: string[]): void {
  const packageRoot = resolveReviewedPackageRoot(stageAppDir, "@earendil-works/pi-tui");
  const nativeRoot = Path.join(packageRoot, "native");
  const win32Root = Path.join(nativeRoot, "win32");
  const prebuildsRoot = Path.join(win32Root, "prebuilds");
  const targetDirectory = Path.join(prebuildsRoot, "win32-x64");
  for (const [directoryPath, label] of [
    [nativeRoot, "@earendil-works/pi-tui/native"],
    [win32Root, "@earendil-works/pi-tui/native/win32"],
    [prebuildsRoot, "@earendil-works/pi-tui/native/win32/prebuilds"],
    [targetDirectory, "@earendil-works/pi-tui/native/win32/prebuilds/win32-x64"],
  ] as const) {
    assertRegularDirectory(directoryPath, label);
  }
  assertRegularFile(
    Path.join(targetDirectory, "win32-platform.node"),
    "@earendil-works/pi-tui/native/win32/prebuilds/win32-x64/win32-platform.node",
  );

  for (const [directory, retainedEntry] of [
    [nativeRoot, "win32"],
    [win32Root, "prebuilds"],
    [prebuildsRoot, "win32-x64"],
    [targetDirectory, "win32-platform.node"],
  ] as const) {
    for (const entry of FS.readdirSync(directory)) {
      if (entry === retainedEntry) continue;
      const candidate = Path.join(directory, entry);
      FS.rmSync(candidate, { force: true, recursive: true });
      removedPaths.push(candidate);
    }
  }
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

  // Pi's extension loader and Betterwright's cookie bridge need these native
  // runtime dependencies. Validate their exact locked versions before packing.
  resolveReviewedPackageRoot(input.stageAppDir, "@esbuild/win32-x64");
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

  prunePiTui(input.stageAppDir, removedPaths);

  const retainedNativeFiles = WINDOWS_TARGET_NATIVE_DEPENDENCY_FILES.map((relativePath) =>
    Path.join(input.stageAppDir, ...relativePath.split("/")),
  );
  for (const [index, filePath] of retainedNativeFiles.entries()) {
    assertRegularFile(filePath, WINDOWS_TARGET_NATIVE_DEPENDENCY_FILES[index] ?? filePath);
  }

  return { removedPaths, retainedNativeFiles };
}
