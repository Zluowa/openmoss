// FILE: staged-windows-node-pty.ts
// Purpose: Removes non-target native payloads from the staged Windows node-pty package.
// Layer: Release/build script support

import * as FS from "node:fs";
import * as Path from "node:path";

export const STAGED_NODE_PTY_VERSION = "1.1.0";
export const WINDOWS_NODE_PTY_NATIVE_FILES = [
  "conpty.node",
  "conpty/OpenConsole.exe",
  "conpty/conpty.dll",
  "conpty_console_list.node",
  "pty.node",
  "winpty-agent.exe",
  "winpty.dll",
] as const;

export interface PrunedStagedWindowsNodePty {
  readonly packageRoot: string;
  readonly targetPrebuildDirectory: string;
  readonly removedPaths: ReadonlyArray<string>;
}

function pathExists(path: string): boolean {
  try {
    FS.lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function assertRegularFile(filePath: string, label: string): void {
  const stat = FS.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Staged node-pty ${label} must be a regular file.`);
  }
}

function isWithin(parent: string, child: string): boolean {
  const relative = Path.relative(parent, child);
  return (
    relative !== "" &&
    !relative.startsWith(`..${Path.sep}`) &&
    relative !== ".." &&
    !Path.isAbsolute(relative)
  );
}

function pruneTargetPrebuildDirectory(
  targetPrebuildDirectory: string,
  removedPaths: string[],
): void {
  const allowedFiles = new Set<string>(WINDOWS_NODE_PTY_NATIVE_FILES);
  const allowedDirectories = new Set(
    WINDOWS_NODE_PTY_NATIVE_FILES.flatMap((file) => {
      const segments = file.split("/");
      return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join("/"));
    }),
  );

  const visit = (directory: string, relativeDirectory: string) => {
    for (const entry of FS.readdirSync(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = Path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (allowedDirectories.has(relativePath)) {
          visit(absolutePath, relativePath);
        } else {
          FS.rmSync(absolutePath, { recursive: true, force: true });
          removedPaths.push(absolutePath);
        }
        continue;
      }
      if (allowedFiles.has(relativePath)) {
        assertRegularFile(absolutePath, relativePath);
        continue;
      }
      FS.rmSync(absolutePath, { recursive: true, force: true });
      removedPaths.push(absolutePath);
    }
  };

  visit(targetPrebuildDirectory, "");
}

export function pruneStagedWindowsNodePty(input: {
  readonly stageAppDir: string;
  readonly arch: "arm64" | "x64";
}): PrunedStagedWindowsNodePty {
  const linkedPackageRoot = Path.join(input.stageAppDir, "node_modules", "node-pty");
  if (!pathExists(linkedPackageRoot)) {
    throw new Error("Staged node-pty package is missing.");
  }
  const stageRoot = FS.realpathSync(input.stageAppDir);
  const packageRoot = FS.realpathSync(linkedPackageRoot);
  if (!isWithin(stageRoot, packageRoot)) {
    throw new Error("Staged node-pty package resolves outside the isolated stage directory.");
  }
  const manifest = JSON.parse(FS.readFileSync(Path.join(packageRoot, "package.json"), "utf8")) as {
    name?: unknown;
    version?: unknown;
  };
  if (manifest.name !== "node-pty" || manifest.version !== STAGED_NODE_PTY_VERSION) {
    throw new Error(
      `Expected staged node-pty ${STAGED_NODE_PTY_VERSION}, got ${String(manifest.version)}.`,
    );
  }

  const prebuildsRoot = Path.join(packageRoot, "prebuilds");
  const targetFolder = `win32-${input.arch}`;
  const targetPrebuildDirectory = Path.join(prebuildsRoot, targetFolder);
  const targetDirectoryStat = FS.lstatSync(targetPrebuildDirectory);
  if (targetDirectoryStat.isSymbolicLink() || !targetDirectoryStat.isDirectory()) {
    throw new Error(`Staged node-pty ${targetFolder} must be a regular directory.`);
  }
  for (const relativePath of WINDOWS_NODE_PTY_NATIVE_FILES) {
    const requiredPath = Path.join(targetPrebuildDirectory, relativePath);
    if (!pathExists(requiredPath)) {
      throw new Error(`Staged node-pty ${targetFolder} is missing ${relativePath}.`);
    }
    assertRegularFile(requiredPath, `${targetFolder}/${relativePath}`);
  }

  const removedPaths: string[] = [];
  for (const entry of FS.readdirSync(prebuildsRoot)) {
    if (entry === targetFolder) continue;
    const candidate = Path.join(prebuildsRoot, entry);
    FS.rmSync(candidate, { recursive: true, force: true });
    removedPaths.push(candidate);
  }
  for (const relativePath of ["build", "third_party"]) {
    const candidate = Path.join(packageRoot, relativePath);
    if (!pathExists(candidate)) continue;
    FS.rmSync(candidate, { recursive: true, force: true });
    removedPaths.push(candidate);
  }
  pruneTargetPrebuildDirectory(targetPrebuildDirectory, removedPaths);

  const remainingPrebuilds = FS.readdirSync(prebuildsRoot);
  if (remainingPrebuilds.length !== 1 || remainingPrebuilds[0] !== targetFolder) {
    throw new Error(
      `Unexpected staged node-pty prebuild directories: ${remainingPrebuilds.join(", ")}.`,
    );
  }
  for (const relativePath of WINDOWS_NODE_PTY_NATIVE_FILES) {
    assertRegularFile(
      Path.join(targetPrebuildDirectory, relativePath),
      `${targetFolder}/${relativePath}`,
    );
  }

  return { packageRoot, targetPrebuildDirectory, removedPaths };
}
