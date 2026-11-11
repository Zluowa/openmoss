// A static import graph of the repository, for choosing the tests a change can affect.
// It resolves what `vitest related` resolves for this repository (relative paths, `~/` in the
// web app, workspace package exports, dynamic imports, vi.mock) without transforming any
// module, so it takes about a second where `vitest related` spends a minute or more.
import { posix } from "node:path";

export interface SourceFile {
  /** Repository-relative, forward slashes. */
  readonly path: string;
  /** The file's text, or just its lines that can hold an import. */
  readonly text: string;
}

export interface Resolver {
  /** Bare specifier prefixes (`@moss/shared/`) and exact names (`@moss/contracts`) to files. */
  readonly packageExports: ReadonlyMap<string, string>;
  /** `~/` style aliases: [package folder, alias prefix, target folder]. */
  readonly aliases: ReadonlyArray<readonly [string, string, string]>;
}

const STATEMENT_START = /^\s*(?:import|export)\b/;
const TYPE_ONLY_START = /^\s*(?:import|export)\s+type\s/;
const FROM = /\bfrom\s*["']([^"']+)["']/;
const ALWAYS =
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)|^\s*import\s+["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']\s*\)|\bvi\.(?:mock|doMock|importActual)\s*(?:<[^>]*>)?\(\s*["']([^"']+)["']/g;

const EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];

export function isTestFile(path: string): boolean {
  return /\.(?:test|spec|browser)\.[cm]?[jt]sx?$/.test(path);
}

/**
 * The modules a file loads at run time, read line by line so that it works on a whole file and
 * on just the lines `git grep` returned. A `from "x"` belongs to the last `import`/`export` line
 * before it; `import type` and `export type` statements are erased at run time and skipped.
 */
export function specifiersOf(text: string): string[] {
  const specifiers: string[] = [];
  let typeOnly = false;
  for (const line of text.split("\n")) {
    if (STATEMENT_START.test(line)) typeOnly = TYPE_ONLY_START.test(line);
    const from = FROM.exec(line);
    if (from) {
      if (!typeOnly) specifiers.push(from[1]!);
      typeOnly = false;
    }
    for (const match of line.matchAll(ALWAYS)) specifiers.push(match.slice(1).find(Boolean)!);
  }
  return specifiers;
}

export function resolveSpecifier(
  from: string,
  specifier: string,
  files: ReadonlySet<string>,
  resolver: Resolver,
): string | undefined {
  const tryPath = (base: string): string | undefined => {
    const normal = posix.normalize(base);
    const candidates = [
      ...EXTENSIONS.map((extension) => normal + extension),
      ...EXTENSIONS.slice(1).map((extension) => `${normal}/index${extension}`),
      normal.replace(/\.js$/, ".ts"),
      normal.replace(/\.js$/, ".tsx"),
      normal.replace(/\.mjs$/, ".mts"),
    ];
    return candidates.find((candidate) => files.has(candidate));
  };
  const clean = specifier.replace(/[?#].*$/, "");
  if (clean.startsWith(".")) return tryPath(posix.join(posix.dirname(from), clean));
  for (const [dir, prefix, target] of resolver.aliases) {
    if (from.startsWith(`${dir}/`) && clean.startsWith(prefix)) {
      return tryPath(`${target}/${clean.slice(prefix.length)}`);
    }
  }
  const exact = resolver.packageExports.get(clean);
  if (exact) return tryPath(exact) ?? exact;
  for (const [key, target] of resolver.packageExports) {
    if (key.endsWith("/*") && clean.startsWith(key.slice(0, -1))) {
      return tryPath(target.replace("*", clean.slice(key.length - 1)));
    }
  }
  return undefined;
}

/** Every resolved import as [importer, imported file]. */
export function importsOf(
  sources: readonly SourceFile[],
  resolver: Resolver,
  allFiles: ReadonlySet<string>,
): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const source of sources) {
    for (const specifier of specifiersOf(source.text)) {
      const target = resolveSpecifier(source.path, specifier, allFiles, resolver);
      if (target && target !== source.path) pairs.push([source.path, target]);
    }
  }
  return pairs;
}

/** Reverse edges: file -> files that import it. */
export function reverseGraph(
  imports: Iterable<readonly [string, string]>,
): Map<string, Set<string>> {
  const importers = new Map<string, Set<string>>();
  for (const [importer, target] of imports) {
    let set = importers.get(target);
    if (!set) importers.set(target, (set = new Set()));
    set.add(importer);
  }
  return importers;
}

/** The changed files and every file that imports one of them, directly or not. */
export function reach(
  changed: readonly string[],
  importers: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> {
  const seen = new Set<string>();
  const queue = [...changed];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const importer of importers.get(file) ?? []) queue.push(importer);
  }
  return seen;
}

/**
 * The test files among `reached` (tests that import a changed file, or are one), plus
 * `mentioning`: tests that name a changed non-code file by path because they read it.
 */
export function affectedTests(
  reached: ReadonlySet<string>,
  mentioning: readonly string[] = [],
): string[] {
  return [
    ...new Set([...[...reached].filter(isTestFile), ...mentioning.filter(isTestFile)]),
  ].toSorted();
}

/**
 * Strings a test would use to name a changed non-code file: its repository path, and its path
 * inside its package when that still has a folder in it (`fixtures/a.json`).
 */
export function mentionNeedles(
  changed: readonly string[],
  packageDirOf: (path: string) => string | undefined,
): string[] {
  const needles = new Set<string>();
  for (const path of changed) {
    // A root file name ("package.json") appears in too many tests to mean anything.
    if (/\.[cm]?[jt]sx?$/.test(path) || !path.includes("/")) continue;
    needles.add(path);
    const dir = packageDirOf(path);
    const inside = dir ? path.slice(dir.length + 1) : "";
    if (inside.includes("/")) needles.add(inside);
  }
  return [...needles];
}
