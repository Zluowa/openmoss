// FILE: bun-lock.ts
// Purpose: Rewrites the bun.lock entries of exactly pinned registry packages from npm metadata.
// Layer: Release/build helper (agent runtime bumps)

/** The npm registry version document fields bun records in bun.lock. */
export interface NpmVersionDocument {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly peerDependenciesMeta?: Record<string, { readonly optional?: boolean }>;
  readonly bin?: string | Record<string, string>;
  readonly os?: string | readonly string[];
  readonly cpu?: string | readonly string[];
  readonly libc?: string | readonly string[];
  readonly dist: { readonly integrity: string; readonly tarball: string };
}

const json = (value: string) => JSON.stringify(value);

function inlineRecord(record: Record<string, string>): string {
  const keys = Object.keys(record).toSorted();
  if (keys.length === 0) return "{}";
  return `{ ${keys.map((key) => `${json(key)}: ${json(record[key]!)}`).join(", ")} }`;
}

function inlineList(values: readonly string[]): string {
  return `[${values.map(json).join(", ")}]`;
}

function oneOrMany(value: string | readonly string[]): string {
  if (typeof value === "string") return json(value);
  return value.length === 1 ? json(value[0]!) : inlineList(value);
}

/** The metadata object bun writes as the third element of a registry package entry. */
export function bunLockPackageMetadata(document: NpmVersionDocument): string {
  const parts: string[] = [];
  if (document.dependencies && Object.keys(document.dependencies).length > 0) {
    parts.push(`"dependencies": ${inlineRecord(document.dependencies)}`);
  }
  if (document.optionalDependencies && Object.keys(document.optionalDependencies).length > 0) {
    parts.push(`"optionalDependencies": ${inlineRecord(document.optionalDependencies)}`);
  }
  if (document.peerDependencies && Object.keys(document.peerDependencies).length > 0) {
    parts.push(`"peerDependencies": ${inlineRecord(document.peerDependencies)}`);
    const optionalPeers = Object.entries(document.peerDependenciesMeta ?? {})
      .filter(([, meta]) => meta.optional === true)
      .map(([name]) => name)
      .toSorted();
    if (optionalPeers.length > 0) parts.push(`"optionalPeers": ${inlineList(optionalPeers)}`);
  }
  if (document.bin !== undefined) {
    const bin =
      typeof document.bin === "string"
        ? { [document.name.split("/").at(-1)!]: document.bin }
        : document.bin;
    if (Object.keys(bin).length > 0) parts.push(`"bin": ${inlineRecord(bin)}`);
  }
  for (const field of ["os", "cpu", "libc"] as const) {
    const value = document[field];
    if (value !== undefined && (typeof value === "string" || value.length > 0)) {
      parts.push(`${json(field)}: ${oneOrMany(value)}`);
    }
  }
  return parts.length === 0 ? "{}" : `{ ${parts.join(", ")} }`;
}

/** One `"key": [...]` line of the bun.lock `packages` map (without leading indentation). */
export function bunLockPackageEntry(key: string, document: NpmVersionDocument): string {
  return `${json(key)}: [${json(`${document.name}@${document.version}`)}, "", ${bunLockPackageMetadata(document)}, ${json(document.dist.integrity)}],`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Returns the current package line for `key`, or null when bun.lock has none. */
export function findBunLockPackageEntry(lockText: string, key: string): string | null {
  const match = new RegExp(`^ {4}${escapeRegExp(json(key))}: \\[.*\\],$`, "mu").exec(lockText);
  return match ? match[0].slice(4) : null;
}

/** Replaces the package line for `key`; the key must already exist. */
export function replaceBunLockPackageEntry(lockText: string, key: string, entry: string): string {
  const current = findBunLockPackageEntry(lockText, key);
  if (current === null) throw new Error(`bun.lock has no package entry for ${key}.`);
  return lockText.replace(`    ${current}`, () => `    ${entry}`);
}

/**
 * Rewrites `"name": "<from>"` dependency specs inside the `workspaces` section (and nothing in
 * `packages`). Returns the text and how many specs changed.
 */
export function replaceBunLockWorkspaceSpec(
  lockText: string,
  name: string,
  from: string,
  to: string,
): { readonly text: string; readonly count: number } {
  const packagesStart = lockText.indexOf('\n  "packages": {');
  if (packagesStart === -1) throw new Error("bun.lock has no packages section.");
  const head = lockText.slice(0, packagesStart);
  const pattern = new RegExp(
    `(\\n {8}${escapeRegExp(json(name))}: )${escapeRegExp(json(from))}(,?)`,
    "gu",
  );
  let count = 0;
  const replaced = head.replace(pattern, (_match, prefix: string, comma: string) => {
    count += 1;
    return `${prefix}${json(to)}${comma}`;
  });
  return { text: replaced + lockText.slice(packagesStart), count };
}
