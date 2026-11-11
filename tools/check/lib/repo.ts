// Reading the repository: git, the changed files, sources for the import graph.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

import type { Resolver, SourceFile } from "./graph.ts";
import type { ChangedFile } from "./plan.ts";
import type { WorkspacePackage } from "./workspace.ts";

export function git(repoRoot: string, args: readonly string[]): string {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

export function repoRootOf(cwd: string): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error("bun run check must run inside a git checkout");
  return result.stdout.trim();
}

/** Committed, staged, unstaged and untracked changes against the merge base with `base`. */
export function changedFiles(
  repoRoot: string,
  base: string,
): { mergeBase: string; files: ChangedFile[] } {
  const mergeBase = git(repoRoot, ["merge-base", "HEAD", base]).trim();
  const paths = new Set(
    [
      ...git(repoRoot, ["diff", "--name-only", "--no-renames", "-z", mergeBase]).split("\0"),
      ...git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0"),
    ].filter(Boolean),
  );
  return {
    mergeBase,
    files: [...paths]
      .toSorted()
      .map((path) => ({ path, exists: existsSync(join(repoRoot, path)) })),
  };
}

const SOURCE_GLOBS = ["*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.jsx", "*.mjs", "*.cjs"];
const EXCLUDED = [":!**/node_modules/**", ":!.moss/**"];
// Lines that can hold an import, for `git grep` (POSIX ERE). graph.ts parses the specifiers.
const IMPORT_LINE = [
  "\\bfrom[[:space:]]*[\"']",
  "\\bimport[[:space:]]*\\(",
  "^[[:space:]]*import[[:space:]]+[\"']",
  "\\brequire[[:space:]]*\\(",
  "\\bvi\\.(mock|doMock|importActual)",
  "^[[:space:]]*(import|export)[[:space:]]",
].join("|");

function workingTreeChanges(repoRoot: string): { modified: string[]; deleted: Set<string> } {
  const modified = [
    ...git(repoRoot, ["diff", "--name-only", "--no-renames", "-z"]).split("\0"),
    ...git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0"),
  ].filter(Boolean);
  const deleted = new Set(
    git(repoRoot, ["ls-files", "--deleted", "-z"]).split("\0").filter(Boolean),
  );
  return { modified, deleted };
}

/**
 * Every file name (for resolving imports) and the import lines of every source file. Tracked
 * files are read from git's index with `git grep --cached`, which takes about a second even
 * when the checkout is cold; files changed in the working tree are read from disk.
 */
export function readSources(repoRoot: string): { all: Set<string>; sources: SourceFile[] } {
  const { modified, deleted } = workingTreeChanges(repoRoot);
  // Deleted files stay in `all` so the files that still import them are found.
  const all = new Set(
    [...git(repoRoot, ["ls-files", "-z"]).split("\0"), ...modified].filter(
      (path) => path && !path.includes("node_modules/"),
    ),
  );
  const lines = new Map<string, string[]>();
  const grep = spawnSync(
    "git",
    ["grep", "--cached", "-I", "-z", "-n", "-E", IMPORT_LINE, "--", ...SOURCE_GLOBS, ...EXCLUDED],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
  );
  if (grep.status !== 0 && grep.status !== 1)
    throw new Error(`git grep failed: ${grep.stderr.trim()}`);
  for (const row of grep.stdout.split("\n")) {
    const [path, , text] = row.split("\0");
    if (!path || text === undefined) continue;
    let list = lines.get(path);
    if (!list) lines.set(path, (list = []));
    list.push(text);
  }
  const isSource = (path: string) => /\.[cm]?[jt]sx?$/.test(path) && !path.startsWith(".moss/");
  for (const path of modified) {
    lines.delete(path);
    if (!isSource(path) || deleted.has(path) || path.includes("node_modules/")) continue;
    try {
      lines.set(path, [readFileSync(join(repoRoot, path), "utf8")]);
    } catch {
      // Removed since git listed it.
    }
  }
  for (const path of deleted) lines.delete(path);
  return { all, sources: [...lines].map(([path, list]) => ({ path, text: list.join("\n") })) };
}

/** Test files whose text contains any of the needles (paths of changed files). */
export function testsMentioning(repoRoot: string, needles: readonly string[]): string[] {
  if (needles.length === 0) return [];
  const globs = ["*.test.*", "*.spec.*", "*.browser.*"];
  const args = needles.flatMap((needle) => ["-e", needle]);
  const found = new Set<string>();
  const indexed = spawnSync(
    "git",
    ["grep", "--cached", "-l", "-z", "-F", ...args, "--", ...globs, ...EXCLUDED],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  for (const path of indexed.stdout.split("\0")) if (path) found.add(path);
  const { modified, deleted } = workingTreeChanges(repoRoot);
  for (const path of modified) {
    if (!/\.(test|spec|browser)\./.test(path)) continue;
    found.delete(path);
    try {
      const text = readFileSync(join(repoRoot, path), "utf8");
      if (needles.some((needle) => text.includes(needle))) found.add(path);
    } catch {
      // Removed since git listed it.
    }
  }
  return [...found].filter((path) => !deleted.has(path)).toSorted();
}

function readJsonWithComments(file: string): Record<string, unknown> | undefined {
  try {
    const text = readFileSync(file, "utf8");
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return JSON.parse(text.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1")) as Record<
        string,
        unknown
      >;
    }
  } catch {
    return undefined;
  }
}

function exportTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const conditions = value as Record<string, unknown>;
    for (const key of ["import", "default", "types", "require"]) {
      const target = exportTarget(conditions[key]);
      if (target) return target;
    }
  }
  return undefined;
}

export function buildResolver(repoRoot: string, packages: readonly WorkspacePackage[]): Resolver {
  const packageExports = new Map<string, string>();
  const aliases: Array<[string, string, string]> = [];
  for (const pkg of packages) {
    if (pkg.kind !== "package") continue;
    const manifest = readJsonWithComments(join(repoRoot, pkg.dir, "package.json")) ?? {};
    const exports = manifest.exports;
    const entries =
      typeof exports === "string" ||
      (exports &&
        typeof exports === "object" &&
        !Object.keys(exports).some((key) => key.startsWith(".")))
        ? { ".": exports }
        : ((exports ?? {}) as Record<string, unknown>);
    for (const [key, value] of Object.entries(entries)) {
      const target = exportTarget(value);
      if (!target) continue;
      const name = key === "." ? pkg.name : `${pkg.name}/${key.slice(2)}`;
      packageExports.set(name, posix.normalize(`${pkg.dir}/${target}`));
    }
    const paths = (
      readJsonWithComments(join(repoRoot, pkg.dir, "tsconfig.json"))?.compilerOptions as
        | { paths?: Record<string, string[]> }
        | undefined
    )?.paths;
    for (const [key, targets] of Object.entries(paths ?? {})) {
      if (!key.endsWith("/*") || !targets[0]?.endsWith("/*")) continue;
      aliases.push([
        pkg.dir,
        key.slice(0, -1),
        posix.normalize(`${pkg.dir}/${targets[0].slice(0, -2)}`),
      ]);
    }
  }
  return { packageExports, aliases };
}
