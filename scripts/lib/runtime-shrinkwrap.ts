// FILE: runtime-shrinkwrap.ts
// Purpose: Pins a workspace package's production dependency tree, exactly as bun installed it
//          from bun.lock, into an npm-shrinkwrap.json so a remote `npm ci` cannot drift.
// Layer: Release/build script support
// Exports: createRuntimeShrinkwrap, parseBunLockPackages, stripJsonTrailingCommas,
//          verifyInstalledPatch, PATCHED_RUNTIME_DIRECTORY

import { createHash } from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";
import { createPackageTarball } from "./package-tarball.ts";

/** Patched packages travel inside the runtime archive, beside package.json. */
export const PATCHED_RUNTIME_DIRECTORY = "patched";

const NPM_REGISTRY = "https://registry.npmjs.org";

export interface BunLockPackage {
  readonly ident: string;
  readonly name: string;
  readonly resolved: string;
  readonly integrity: string;
  readonly meta: {
    readonly dependencies?: Record<string, string>;
    readonly optionalDependencies?: Record<string, string>;
    readonly os?: string | string[];
    readonly cpu?: string | string[];
    readonly libc?: string | string[];
    readonly bin?: Record<string, string>;
  };
}

export interface ShrinkwrapPackageEntry {
  readonly name?: string;
  readonly version: string;
  readonly resolved: string;
  readonly integrity: string;
  readonly dependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly optional?: true;
  readonly hasInstallScript?: true;
  readonly bin?: Record<string, string>;
  readonly os?: string[];
  readonly cpu?: string[];
  readonly libc?: string[];
}

export interface RuntimeShrinkwrap {
  readonly name: string;
  readonly version: string;
  readonly lockfileVersion: 3;
  readonly requires: true;
  readonly packages: Record<string, unknown>;
}

export interface RuntimeLock {
  readonly shrinkwrap: RuntimeShrinkwrap;
  /** package.json dependencies for the archive: patched direct dependencies use their tarball. */
  readonly dependencies: Record<string, string>;
  /** Patched package tarballs, at paths relative to the archive root. */
  readonly files: ReadonlyArray<{ readonly path: string; readonly contents: Buffer }>;
}

/**
 * bun applies `patchedDependencies` at install time; npm cannot. Confirm the
 * installed copy carries every added line of its patch before it is packed.
 */
export function verifyInstalledPatch(directory: string, patchText: string, label: string): void {
  let file: string | null = null;
  let checked = 0;
  const contents = new Map<string, string>();
  for (const line of patchText.split(/\r?\n/u)) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim().replace(/^b\//u, "");
      file = target === "/dev/null" ? null : target;
      continue;
    }
    if (!file || !line.startsWith("+") || line.slice(1).trim() === "") continue;
    if (!contents.has(file)) {
      const absolute = Path.join(directory, file);
      if (!FS.existsSync(absolute))
        throw new Error(`Installed ${label} is missing patched file ${file}.`);
      contents.set(file, FS.readFileSync(absolute, "utf8"));
    }
    if (!contents.get(file)!.includes(line.slice(1)))
      throw new Error(`Installed ${label} does not carry its patch (${file}).`);
    checked++;
  }
  if (checked === 0) throw new Error(`The patch for ${label} adds no verifiable lines.`);
}

/** bun.lock is JSON with trailing commas. Remove only commas that precede a closer outside strings. */
export function stripJsonTrailingCommas(text: string): string {
  let result = "";
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (inString) {
      result += character;
      if (character === "\\") result += text[++index] ?? "";
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }
    if (character === ",") {
      let next = index + 1;
      while (next < text.length && /\s/u.test(text[next]!)) next++;
      if (text[next] === "}" || text[next] === "]") continue;
    }
    result += character;
  }
  return result;
}

function splitIdent(ident: string): { readonly name: string; readonly spec: string } {
  const separator = ident.indexOf("@", ident.startsWith("@") ? 1 : 0);
  if (separator <= 0) throw new Error(`Unrecognized bun.lock package '${ident}'.`);
  return { name: ident.slice(0, separator), spec: ident.slice(separator + 1) };
}

function registryTarball(registry: string, name: string, version: string): string {
  const base = (registry || NPM_REGISTRY).replace(/\/+$/u, "");
  return `${base}/${name}/-/${name.slice(name.lastIndexOf("/") + 1)}-${version}.tgz`;
}

/** Index every downloadable package in bun.lock by `name@version` or `name@<tarball url>`. */
export function parseBunLockPackages(lockText: string): ReadonlyMap<string, BunLockPackage> {
  const lock = JSON.parse(stripJsonTrailingCommas(lockText)) as {
    readonly packages?: Record<string, unknown>;
  };
  const result = new Map<string, BunLockPackage>();
  for (const value of Object.values(lock.packages ?? {})) {
    if (!Array.isArray(value) || typeof value[0] !== "string") continue;
    const ident = value[0];
    const { name, spec } = splitIdent(ident);
    let entry: BunLockPackage | null = null;
    if (spec.startsWith("https://") && value.length === 3 && typeof value[2] === "string") {
      entry = { ident, name, resolved: spec, integrity: value[2], meta: value[1] ?? {} };
    } else if (value.length === 4 && typeof value[1] === "string" && typeof value[3] === "string") {
      entry = {
        ident,
        name,
        resolved: registryTarball(value[1], name, spec),
        integrity: value[3],
        meta: value[2] ?? {},
      };
    }
    // Workspace, git and file entries have no registry integrity; they are
    // rejected below if a production dependency ever reaches one.
    if (entry && /^sha(?:256|384|512)-/u.test(entry.integrity)) result.set(ident, entry);
  }
  return result;
}

interface PackageManifest {
  readonly name?: string;
  readonly version?: string;
  readonly dependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly scripts?: Record<string, string>;
  readonly bin?: string | Record<string, string>;
  readonly os?: string | string[];
  readonly cpu?: string | string[];
  readonly libc?: string | string[];
}

interface ResolvedNode {
  readonly key: string;
  readonly directory: string | undefined;
  readonly name: string;
  readonly version: string;
  readonly lock: BunLockPackage;
  readonly hasInstallScript: boolean;
  readonly bin: Record<string, string> | undefined;
  readonly os: string[] | undefined;
  readonly cpu: string[] | undefined;
  readonly libc: string[] | undefined;
  readonly edges: Array<{
    readonly name: string;
    readonly target: string;
    readonly optional: boolean;
  }>;
}

const list = (value: string | string[] | undefined): string[] | undefined =>
  value === undefined ? undefined : Array.isArray(value) ? [...value] : [value];

function readManifest(directory: string): PackageManifest {
  return JSON.parse(
    FS.readFileSync(Path.join(directory, "package.json"), "utf8"),
  ) as PackageManifest;
}

function hasInstallScript(directory: string, manifest: PackageManifest): boolean {
  const scripts = manifest.scripts ?? {};
  if (scripts.preinstall || scripts.install || scripts.postinstall) return true;
  // npm runs `node-gyp rebuild` for a binding.gyp without an install script.
  return FS.existsSync(Path.join(directory, "binding.gyp"));
}

function normalizeBin(
  name: string,
  bin: PackageManifest["bin"],
): Record<string, string> | undefined {
  if (bin === undefined) return undefined;
  if (typeof bin === "string") return { [name.slice(name.lastIndexOf("/") + 1)]: bin };
  return Object.keys(bin).length ? { ...bin } : undefined;
}

/** Node's own lookup from an installed package directory, through bun's isolated store. */
function resolveInstalled(fromDirectory: string, dependency: string): string | null {
  let current = fromDirectory;
  while (true) {
    const candidate = Path.join(current, "node_modules", dependency);
    if (FS.existsSync(Path.join(candidate, "package.json"))) return FS.realpathSync(candidate);
    const parent = Path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function installedIdent(spec: string, manifest: PackageManifest, fallbackName: string): string {
  if (spec.startsWith("https://")) return `${fallbackName}@${spec}`;
  if (!manifest.name || !manifest.version)
    throw new Error(`Installed dependency '${fallbackName}' has no name or version.`);
  return `${manifest.name}@${manifest.version}`;
}

/** An installed copy counts only if bun.lock has it and an exact spec names its release. */
function isLockedInstall(
  directory: string,
  dependency: string,
  spec: string,
  bunLock: ReadonlyMap<string, BunLockPackage>,
): boolean {
  const manifest = readManifest(directory);
  if (!manifest.name || !manifest.version) return false;
  if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(spec) && manifest.version !== spec) return false;
  return bunLock.has(installedIdent(spec, manifest, dependency));
}

const childPath = (parent: string, name: string): string =>
  parent === "" ? `node_modules/${name}` : `${parent}/node_modules/${name}`;

const ancestors = (path: string): string[] => {
  const result = [path];
  let current = path;
  while (current !== "") {
    const index = current.lastIndexOf("/node_modules/");
    current = index < 0 ? "" : current.slice(0, index);
    result.push(current);
  }
  return result;
};

// Edges are pinned to the exact installed release, so bun overrides stay in effect.
// A patched package's `file:` spec is relative to the dependent's own folder.
const pinnedSpec = (
  edgeName: string,
  target: ResolvedNode,
  from: string,
  patched: ReadonlyMap<string, { readonly path: string }>,
): string => {
  const local = patched.get(target.key);
  if (local) return `file:${Path.posix.relative(from, local.path)}`;
  const source = target.lock.ident.slice(target.name.length + 1);
  if (source.startsWith("https://")) return source;
  return edgeName === target.name ? target.version : `npm:${target.name}@${target.version}`;
};

/**
 * Build the shrinkwrap for `packageDirectory` from the tree bun installed there.
 * Versions and dependency edges come from the installed tree (bun.lock's result,
 * including overrides). Download locations and integrity come from bun.lock.
 * Optional platform packages that are not installed on this machine come from
 * bun.lock alone. Anything that cannot be represented exactly throws.
 */
export function createRuntimeShrinkwrap(input: {
  readonly packageDirectory: string;
  readonly packageJson: {
    readonly name: string;
    readonly version: string;
    readonly dependencies: Record<string, string>;
  };
  readonly bunLock: ReadonlyMap<string, BunLockPackage>;
  /** Root package.json `patchedDependencies` (`name@version` or `name@url` to patch path). */
  readonly patchedDependencies?: Readonly<Record<string, string>>;
  /** Directory the patch paths are relative to (the repository root). */
  readonly patchRoot?: string;
}): RuntimeLock {
  const nodes = new Map<string, ResolvedNode>();
  const rootEdges: ResolvedNode["edges"] = [];

  const visitLockOnly = (name: string, spec: string): string => {
    const exact = input.bunLock.get(`${name}@${spec}`);
    const candidates = exact
      ? [exact]
      : [...input.bunLock.values()].filter((entry) => entry.name === name);
    if (candidates.length !== 1)
      throw new Error(
        `Cannot pin uninstalled optional dependency '${name}@${spec}' from bun.lock.`,
      );
    const lock = candidates[0]!;
    const key = `lock:${lock.ident}`;
    if (nodes.has(key)) return key;
    const version = splitIdent(lock.ident).spec;
    const node: ResolvedNode = {
      key,
      directory: undefined,
      name: lock.name,
      version,
      lock,
      hasInstallScript: false,
      bin: lock.meta.bin ? { ...lock.meta.bin } : undefined,
      os: list(lock.meta.os),
      cpu: list(lock.meta.cpu),
      libc: list(lock.meta.libc),
      edges: [],
    };
    nodes.set(key, node);
    for (const [dependency, dependencySpec] of Object.entries(lock.meta.dependencies ?? {}))
      node.edges.push({
        name: dependency,
        target: visitLockOnly(dependency, dependencySpec),
        optional: false,
      });
    for (const [dependency, dependencySpec] of Object.entries(lock.meta.optionalDependencies ?? {}))
      node.edges.push({
        name: dependency,
        target: visitLockOnly(dependency, dependencySpec),
        optional: true,
      });
    return key;
  };

  const visitedDirectories = new Map<string, string>();
  const visitInstalled = (directory: string, name: string, spec: string): string => {
    const already = visitedDirectories.get(directory);
    if (already) return already;
    const manifest = readManifest(directory);
    const ident = installedIdent(spec, manifest, name);
    const lock = input.bunLock.get(ident);
    if (!lock) throw new Error(`Installed dependency '${ident}' has no bun.lock integrity.`);
    // Peer-resolution variants of one tarball share one npm identity; peers are
    // not installed remotely (legacy peer semantics), only regular edges count.
    const key = `pkg:${ident}`;
    visitedDirectories.set(directory, key);
    const existing = nodes.get(key);
    if (existing) {
      const edges = collectEdges(directory, manifest);
      if (JSON.stringify(edges) !== JSON.stringify(existing.edges))
        throw new Error(`Installed variants of '${ident}' resolve different dependencies.`);
      return key;
    }
    const node: ResolvedNode = {
      key,
      directory,
      name: lock.name,
      version: manifest.version!,
      lock,
      hasInstallScript: hasInstallScript(directory, manifest),
      bin: normalizeBin(lock.name, manifest.bin),
      os: list(manifest.os),
      cpu: list(manifest.cpu),
      libc: list(manifest.libc),
      edges: [],
    };
    nodes.set(key, node);
    node.edges.push(...collectEdges(directory, manifest));
    return key;
  };

  const collectEdges = (directory: string, manifest: PackageManifest): ResolvedNode["edges"] => {
    const edges: Array<ResolvedNode["edges"][number]> = [];
    const optional = manifest.optionalDependencies ?? {};
    const all = { ...manifest.dependencies, ...optional };
    for (const [dependency, spec] of Object.entries(all).toSorted(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const isOptional = dependency in optional;
      let installed = resolveInstalled(directory, dependency);
      // bun skips optional packages for other platforms (musl on glibc, other
      // operating systems). Node's upward lookup can then reach an unrelated
      // stray copy elsewhere in node_modules. An optional package that is not the
      // release bun.lock pins is not this dependency: take it from bun.lock.
      if (installed && isOptional && !isLockedInstall(installed, dependency, spec, input.bunLock))
        installed = null;
      if (!installed) {
        if (!isOptional) throw new Error(`Required dependency '${dependency}' is not installed.`);
        edges.push({ name: dependency, target: visitLockOnly(dependency, spec), optional: true });
        continue;
      }
      edges.push({
        name: dependency,
        target: visitInstalled(installed, dependency, spec),
        optional: isOptional,
      });
    }
    return edges;
  };

  const rootDependencies = Object.entries(input.packageJson.dependencies).toSorted(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [dependency, spec] of rootDependencies) {
    const installed = resolveInstalled(input.packageDirectory, dependency);
    if (!installed) throw new Error(`Production dependency '${dependency}' is not installed.`);
    rootEdges.push({
      name: dependency,
      target: visitInstalled(installed, dependency, spec),
      optional: false,
    });
  }

  // Nodes required through at least one non-optional path stay; the rest are optional.
  const required = new Set<string>();
  const markRequired = (key: string) => {
    if (required.has(key)) return;
    required.add(key);
    for (const edge of nodes.get(key)!.edges) if (!edge.optional) markRequired(edge.target);
  };
  for (const edge of rootEdges) markRequired(edge.target);

  // npm layout: hoist to the root when free, otherwise nest under the dependent.
  const placement = new Map<string, string>(); // npm path -> node key
  const queue: Array<{ readonly path: string; readonly edges: ResolvedNode["edges"] }> = [
    { path: "", edges: rootEdges },
  ];
  const visible = (from: string, name: string): string | undefined => {
    for (const ancestor of ancestors(from)) {
      const found = placement.get(childPath(ancestor, name));
      if (found) return found;
    }
    return undefined;
  };
  while (queue.length) {
    const { path, edges } = queue.shift()!;
    for (const edge of edges) {
      const seen = visible(path, edge.name);
      if (seen === edge.target) continue;
      // A free name hoists to the root. A different copy already visible here is
      // shadowed by nesting under this dependent only, so no placed package moves.
      const target = seen === undefined ? "" : path;
      const location = childPath(target, edge.name);
      if (placement.has(location)) throw new Error(`Cannot place '${edge.name}' at ${location}.`);
      placement.set(location, edge.target);
      queue.push({ path: location, edges: nodes.get(edge.target)!.edges });
    }
  }

  // Every edge must resolve, from its real npm location, to the node bun installed.
  for (const [location, key] of placement)
    for (const edge of nodes.get(key)!.edges)
      if (visible(location, edge.name) !== edge.target)
        throw new Error(`'${location}' would not resolve '${edge.name}' to the locked package.`);
  for (const edge of rootEdges)
    if (visible("", edge.name) !== edge.target)
      throw new Error(`The package root would not resolve '${edge.name}' to the locked package.`);

  // Every patched package the runtime installs ships as its patched copy. There
  // is no allowlist: a newly patched runtime dependency is packed automatically,
  // and an installed copy that lacks its patch fails the pack.
  const patched = new Map<string, { readonly path: string; readonly integrity: string }>();
  const files: Array<{ readonly path: string; readonly contents: Buffer }> = [];
  const patchEntries = Object.entries(input.patchedDependencies ?? {}).toSorted(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [ident, patchPath] of patchEntries) {
    const node = nodes.get(`pkg:${ident}`) ?? nodes.get(`lock:${ident}`);
    if (!node) continue;
    if (!node.directory) throw new Error(`Patched runtime dependency '${ident}' is not installed.`);
    if (!input.patchRoot) throw new Error(`Patched runtime dependency '${ident}' needs its patch.`);
    verifyInstalledPatch(
      node.directory,
      FS.readFileSync(Path.join(input.patchRoot, patchPath), "utf8"),
      ident,
    );
    const contents = createPackageTarball(node.directory);
    const fileName = `${node.name.replace(/^@/u, "").replace("/", "-")}-${node.version}.tgz`;
    const path = `${PATCHED_RUNTIME_DIRECTORY}/${fileName}`;
    patched.set(node.key, {
      path,
      integrity: `sha512-${createHash("sha512").update(contents).digest("base64")}`,
    });
    files.push({ path, contents });
  }

  const dependencies = Object.fromEntries(
    Object.entries(input.packageJson.dependencies).map(([name, spec]) => {
      const edge = rootEdges.find((candidate) => candidate.name === name)!;
      const local = patched.get(edge.target);
      return [name, local ? `file:${local.path}` : spec];
    }),
  );
  const packages: Record<string, unknown> = {
    "": {
      name: input.packageJson.name,
      version: input.packageJson.version,
      dependencies,
    },
  };
  for (const location of [...placement.keys()].toSorted()) {
    const node = nodes.get(placement.get(location)!)!;
    const dependencies = Object.fromEntries(
      node.edges
        .filter((edge) => !edge.optional)
        .map((edge) => [
          edge.name,
          pinnedSpec(edge.name, nodes.get(edge.target)!, location, patched),
        ]),
    );
    const optionalDependencies = Object.fromEntries(
      node.edges
        .filter((edge) => edge.optional)
        .map((edge) => [
          edge.name,
          pinnedSpec(edge.name, nodes.get(edge.target)!, location, patched),
        ]),
    );
    const placedName = location.slice(
      location.lastIndexOf("node_modules/") + "node_modules/".length,
    );
    const entry: ShrinkwrapPackageEntry = {
      ...(placedName !== node.name ? { name: node.name } : {}),
      version: node.version,
      resolved: patched.has(node.key) ? `file:${patched.get(node.key)!.path}` : node.lock.resolved,
      integrity: patched.get(node.key)?.integrity ?? node.lock.integrity,
      ...(Object.keys(dependencies).length ? { dependencies } : {}),
      ...(Object.keys(optionalDependencies).length ? { optionalDependencies } : {}),
      ...(required.has(node.key) ? {} : { optional: true as const }),
      ...(node.hasInstallScript ? { hasInstallScript: true as const } : {}),
      ...(node.bin ? { bin: node.bin } : {}),
      ...(node.os ? { os: node.os } : {}),
      ...(node.cpu ? { cpu: node.cpu } : {}),
      ...(node.libc ? { libc: node.libc } : {}),
    };
    packages[location] = entry;
  }
  return {
    shrinkwrap: {
      name: input.packageJson.name,
      version: input.packageJson.version,
      lockfileVersion: 3,
      requires: true,
      packages,
    },
    dependencies,
    files,
  };
}
