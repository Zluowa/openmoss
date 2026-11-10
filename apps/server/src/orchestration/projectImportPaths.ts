import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { normalizeWorkspaceRootForComparison } from "@moss/shared/threadWorkspace";
import { parseManagedWorktreeWorkspaceRoot } from "../workspace/managedWorktree";

export function projectImportKey(...parts: ReadonlyArray<string>): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

// Codex on Windows can store extended-length paths (`\\?\E:\work`). Resolve their ordinary
// drive/UNC equivalents so a missing child's parent remains a valid root. A drive root
// matters most: Node turns `\\?\E:\` and `\\?\E:` into `E:` (that drive's current folder),
// whose stat fails with EISDIR, so both become `E:\`.
export function normalizeWindowsImportPath(value: string): string {
  if (!/^[\\/]{2}[?.][\\/]/u.test(value)) return value;
  const rest = value.slice(4);
  if (/^UNC[\\/]/iu.test(rest)) return `\\\\${rest.slice(4).replaceAll("/", "\\")}`;
  const drive = /^([a-z]:)(?:[\\/](.*))?$/isu.exec(rest);
  return drive ? `${drive[1]}\\${(drive[2] ?? "").replaceAll("/", "\\")}` : value;
}

/** The path every filesystem call in the import uses for a folder an agent recorded. */
function importFsPath(value: string): string {
  return process.platform === "win32" ? normalizeWindowsImportPath(value) : value;
}

export async function canonicalImportPath(value: string): Promise<string> {
  const absolute = path.resolve(importFsPath(value));
  try {
    const physical = await realpath(absolute);
    return process.platform === "win32" ? normalizeWindowsImportPath(physical) : physical;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(absolute);
    return parent === absolute
      ? absolute
      : path.join(await canonicalImportPath(parent), path.basename(absolute));
  }
}

export function importPathIdentity(value: string): string {
  return normalizeWorkspaceRootForComparison(value, { platform: process.platform });
}

// A folder Moss can't use is as good as missing: its conversations import as history.
const UNUSABLE_FOLDER_CODES = new Set(["ENOENT", "ENOTDIR", "EACCES", "EPERM"]);

export async function importDirectoryExists(value: string): Promise<boolean> {
  try {
    return (await stat(importFsPath(value))).isDirectory();
  } catch (error) {
    if (UNUSABLE_FOLDER_CODES.has((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

// Agents' own test and scratch runs (connection checks, throwaway prompts) live here.
const TEMP_FOLDER_PATTERNS = [
  /[\\/]AppData[\\/]Local[\\/]Temp(?:[\\/]|$)/iu,
  /^[\\/](?:private[\\/])?tmp(?:[\\/]|$)/u,
  /^[\\/](?:private[\\/])?var[\\/]folders[\\/][^\\/]+[\\/][^\\/]+[\\/]T(?:[\\/]|$)/u,
];

/** Whether a project folder sits in a temp directory: offered, but not selected by default. */
export function isTemporaryImportRoot(root: string, tempDirs: ReadonlyArray<string> = []): boolean {
  if (TEMP_FOLDER_PATTERNS.some((pattern) => pattern.test(root))) return true;
  const identity = importPathIdentity(root);
  return tempDirs.some((dir) => {
    const temp = importPathIdentity(dir).replace(/\/$/u, "");
    return temp.length > 1 && (identity === temp || identity.startsWith(`${temp}/`));
  });
}

// Read Git's local pointer only; discovery never runs hooks, fetches, or changes a checkout.
export async function findImportGitWorkspace(
  cwd: string,
): Promise<{ root: string; worktree: string | null } | null> {
  let current = importFsPath(cwd);
  while (true) {
    const gitPath = path.join(current, ".git");
    try {
      const info = await stat(gitPath);
      if (info.isDirectory()) return { root: current, worktree: null };
      if (info.isFile()) {
        const pointer = info.size <= 8192 ? await readFile(gitPath, "utf8") : "";
        const root = parseManagedWorktreeWorkspaceRoot({
          gitPointerFileContents: pointer,
          path,
          worktreePath: current,
        });
        if (root) return { root: await canonicalImportPath(root), worktree: current };
        return { root: current, worktree: null };
      }
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        (error as NodeJS.ErrnoException).code !== "ENOTDIR"
      )
        throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
