// FILE: usageProjectPaths.ts
// Purpose: Puts a session's working directory (from Claude Code's or Codex's own
// session files) under the Moss project whose folder holds it, for Usage →
// Analytics' "This computer" scope. Windows paths compare without case, with
// either separator, with or without a trailing one, and with the `\\?\` long-path
// and Git Bash `/d/...` spellings; the path flavour is a parameter so tests cover
// both on every platform.
// Layer: server usage analytics (pure).

import nodePath from "node:path";

import type { StatsUsageAnalyticsProject } from "@moss/contracts";

export type PathFlavour = "posix" | "win32";

export const hostPathFlavour = (): PathFlavour =>
  process.platform === "win32" ? "win32" : "posix";

/** A folder Moss knows: a real project (id and title) or a chat container (null). */
export interface ProjectRoot {
  readonly path: string;
  readonly project: StatsUsageAnalyticsProject | null;
}

interface NormalizedPath {
  /** The path as written, cleaned up; keeps its case for names. */
  readonly path: string;
  /** What two paths compare by: `path`, lowercased on Windows. */
  readonly key: string;
}

/**
 * An absolute path in one spelling per folder, or null for a relative or empty
 * one. No file system access: session files name folders that may be gone.
 */
export function normalizeDirectory(raw: string, flavour: PathFlavour): NormalizedPath | null {
  let value = raw.trim();
  if (!value) return null;
  if (flavour === "posix") {
    if (!value.startsWith("/")) return null;
    let path = nodePath.posix.normalize(value);
    while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    return { path, key: path };
  }
  value = value.replaceAll("/", "\\");
  // `\\?\C:\x` and `\\?\UNC\server\share` are the long-path spellings of `C:\x`
  // and `\\server\share`.
  if (/^\\\\[?.]\\unc\\/iu.test(value)) value = `\\\\${value.slice(8)}`;
  else if (/^\\\\[?.]\\[a-z]:/iu.test(value)) value = value.slice(4);
  // Git Bash and MSYS write `C:\x` as `/c/x`.
  const msys = /^\\([a-z])(?=\\|$)/iu.exec(value);
  if (msys) value = `${msys[1]}:${value.slice(2) || "\\"}`;
  const isDrive = /^[a-z]:\\/iu.test(value) || /^[a-z]:$/iu.test(value);
  const isUnc = /^\\\\[^\\]+\\[^\\]+/u.test(value);
  if (!isDrive && !isUnc) return null;
  let path = nodePath.win32.normalize(isDrive && value.length === 2 ? `${value}\\` : value);
  // Keep the root's own separator (`C:\`, `\\server\share\`), drop any other trailing one.
  const rootLength = nodePath.win32.parse(path).root.length;
  while (path.length > rootLength && path.endsWith("\\")) path = path.slice(0, -1);
  if (isDrive) path = `${path[0]!.toUpperCase()}${path.slice(1)}`;
  return { path, key: path.toLowerCase() };
}

function separatorOf(flavour: PathFlavour): string {
  return flavour === "win32" ? "\\" : "/";
}

function isInside(key: string, rootKey: string, flavour: PathFlavour): boolean {
  if (key === rootKey) return true;
  const separator = separatorOf(flavour);
  const prefix = rootKey.endsWith(separator) ? rootKey : `${rootKey}${separator}`;
  return key.startsWith(prefix);
}

/** A Claude Code worktree (`<repo>/.claude/worktrees/<name>`) counts as its repo. */
function repoDirectory(path: string, flavour: PathFlavour): string {
  const marker =
    flavour === "win32" ? /\\\.claude\\worktrees(?:\\|$)/iu : /\/\.claude\/worktrees(?:\/|$)/u;
  const match = marker.exec(path);
  return match && match.index > 0 ? path.slice(0, match.index) : path;
}

/**
 * Maps session directories to projects. The deepest Moss folder that holds the
 * directory wins; a chat container only claims its own folder, since one can sit
 * at the home folder. Otherwise the directory's own folder name is the project, so
 * clones and worktrees of one repo count as one.
 */
export function makeDirectoryProjectResolver(
  roots: ReadonlyArray<ProjectRoot>,
  flavour: PathFlavour,
): (cwd: string) => StatsUsageAnalyticsProject | null {
  const known = roots.flatMap((root) => {
    const normalized = normalizeDirectory(root.path, flavour);
    return normalized ? [{ key: normalized.key, project: root.project }] : [];
  });
  return (cwd) => {
    const directory = normalizeDirectory(cwd, flavour);
    if (!directory) return null;
    let best: (typeof known)[number] | null = null;
    for (const root of known) {
      const inside =
        root.project === null
          ? directory.key === root.key
          : isInside(directory.key, root.key, flavour);
      if (inside && (!best || root.key.length > best.key.length)) best = root;
    }
    if (best) return best.project;
    const pathApi = flavour === "win32" ? nodePath.win32 : nodePath.posix;
    const name = pathApi.basename(repoDirectory(directory.path, flavour));
    if (!name) return null;
    return {
      projectId: `folder:${flavour === "win32" ? name.toLowerCase() : name}`,
      title: name,
    };
  };
}
