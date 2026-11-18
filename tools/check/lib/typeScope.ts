// Which packages type-check a file. A package's tsconfig.json can take in files outside its folder
// through `include` or `files` (apps/server includes ../../scripts/lib), and through the projects
// it `references`; such a file is part of that package's typecheck although nothing in the package
// imports it. The import graph (graph.ts) cannot see this, so a change to scripts/lib selected only
// @moss/scripts and skipped the server typecheck that then failed on the mirror (#699, run
// 44297606017). The scopes come from the tsconfig files themselves, never from a hand list.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";

import type { WorkspacePackage } from "./workspace.ts";

/** tsconfig is JSON with comments and trailing commas. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i += 1;
      } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const escape = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");

/**
 * A tsconfig `include`/`files` entry, relative to the tsconfig's folder, as a test on
 * repository-relative paths. A folder entry covers everything below it (TypeScript adds `**\/*`);
 * globs keep `**`, `*` and `?`; an entry that leaves the repository matches nothing.
 */
export function entryMatcher(configDir: string, entry: string): RegExp | undefined {
  const full = posix
    .normalize(posix.join(configDir, entry.replace(/\\/g, "/")))
    .replace(/\/+$/, "");
  if (full === ".." || full.startsWith("../")) return undefined;
  const root = full === "." ? "" : full;
  if (!/[*?]/.test(root)) return new RegExp(`^${escape(root)}${root ? "(?:/.*)?" : ".*"}$`);
  let source = "";
  for (let i = 0; i < root.length; i += 1) {
    const c = root[i]!;
    if (c === "*" && root[i + 1] === "*") {
      source += root[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += root[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") source += "[^/]*";
    else if (c === "?") source += "[^/]";
    else source += escape(c);
  }
  return new RegExp(`^${source}$`);
}

interface TsConfig {
  include?: unknown;
  files?: unknown;
  references?: unknown;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** Every file test of one tsconfig and of the projects it references (each read once). */
function scopeOf(repoRoot: string, configPath: string, seen: Set<string>): RegExp[] {
  if (seen.has(configPath) || !existsSync(join(repoRoot, configPath))) return [];
  seen.add(configPath);
  let config: TsConfig;
  try {
    config = parseJsonc(readFileSync(join(repoRoot, configPath), "utf8")) as TsConfig;
  } catch {
    return [];
  }
  const dir = posix.dirname(configPath);
  const include =
    config.include === undefined && config.files === undefined ? ["**/*"] : strings(config.include);
  const matchers = [...include, ...strings(config.files)]
    .map((entry) => entryMatcher(dir, entry))
    .filter((m): m is RegExp => m !== undefined);
  for (const ref of Array.isArray(config.references) ? config.references : []) {
    const refPath = (ref as { path?: unknown })?.path;
    if (typeof refPath !== "string") continue;
    let target = posix.normalize(posix.join(dir, refPath.replace(/\\/g, "/")));
    if (!target.endsWith(".json")) {
      const isDir =
        existsSync(join(repoRoot, target)) && statSync(join(repoRoot, target)).isDirectory();
      target = isDir ? posix.join(target, "tsconfig.json") : target;
    }
    matchers.push(...scopeOf(repoRoot, target, seen));
  }
  return matchers;
}

/**
 * For each package that type-checks with its tsconfig.json (a `typecheck` script, or a tool with a
 * tsconfig.json), the tests for the files that typecheck reads.
 */
export function readTypeScopes(
  repoRoot: string,
  packages: readonly WorkspacePackage[],
): Map<string, RegExp[]> {
  const scopes = new Map<string, RegExp[]>();
  for (const pkg of packages) {
    const config = `${pkg.dir}/tsconfig.json`;
    if (!(pkg.kind === "tool" || pkg.scripts.typecheck) || !existsSync(join(repoRoot, config)))
      continue;
    scopes.set(pkg.name, scopeOf(repoRoot, config, new Set()));
  }
  return scopes;
}

/** The packages whose typecheck reads one of `files`. */
export function typeOwners(
  files: Iterable<string>,
  scopes: ReadonlyMap<string, readonly RegExp[]>,
): Set<string> {
  const owners = new Set<string>();
  const list = [...files];
  for (const [name, matchers] of scopes) {
    if (list.some((file) => matchers.some((m) => m.test(file)))) owners.add(name);
  }
  return owners;
}
