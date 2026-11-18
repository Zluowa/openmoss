// Which dependency changes a fast refresh can carry, decided from the root bun.lock.
//
// The installed app's production node_modules come from scripts/desktop-stage-lock (the registry
// dependencies of apps/server and apps/desktop, plus every patched package). A fast refresh keeps
// them as installed. A changed package is therefore safe exactly when nothing the packaged server or
// desktop loads at runtime can reach it: then it only exists in bundles the refresh rebuilds (the
// web client, which Vite bundles whole) or in build tooling. Anything reachable from the runtime
// dependencies of apps/server or apps/desktop needs the full installer, because the refreshed code
// would run against the old installed copy.
//
// Reachability is by package name over the lockfile graph (dependencies, optional and peer
// dependencies), which over-approximates: one reachable version makes every version of that name
// packaged. When a lockfile cannot be read, everything is treated as packaged.

export interface DependencyDecision {
  readonly name: string;
  readonly packaged: boolean;
  /** Why: the runtime root it is reachable from, or the workspaces that use it. */
  readonly reason: string;
}

type LockEntry = unknown[];

export interface BunLock {
  readonly workspaces: Record<string, Record<string, unknown>>;
  readonly packages: Record<string, LockEntry>;
}

/** The workspaces whose `dependencies` the installer packages (desktop-stage-lock.ts). */
export const PACKAGED_WORKSPACES = ["apps/server", "apps/desktop"] as const;

const DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"] as const;

/** bun.lock is JSON with trailing commas. */
export function parseBunLock(text: string): BunLock {
  const json = JSON.parse(text.replace(/,(\s*[}\]])/gu, "$1")) as Partial<BunLock>;
  if (!json.workspaces || !json.packages) throw new Error("not a bun.lock");
  return { workspaces: json.workspaces, packages: json.packages };
}

/** "react", "@scope/name", "parent/child" or "parent/@scope/child" -> the package's own name. */
export function leafName(key: string): string {
  const parts = key.split("/");
  const last = parts.at(-1)!;
  const scope = parts.at(-2);
  return scope?.startsWith("@") ? `${scope}/${last}` : last;
}

function namesOf(record: unknown): string[] {
  return record && typeof record === "object" ? Object.keys(record) : [];
}

function entryDependencies(entry: LockEntry): string[] {
  const meta = entry.find(
    (item, index) => index > 0 && item !== null && typeof item === "object" && !Array.isArray(item),
  ) as Record<string, unknown> | undefined;
  return meta ? DEPENDENCY_FIELDS.flatMap((field) => namesOf(meta[field])) : [];
}

/** Package names reachable from `roots` through the lockfile, workspace packages followed by name. */
export function reachableNames(lock: BunLock, roots: Iterable<string>): Set<string> {
  const byName = new Map<string, LockEntry[]>();
  for (const [key, entry] of Object.entries(lock.packages)) {
    const name = leafName(key);
    byName.set(name, [...(byName.get(name) ?? []), entry]);
  }
  const workspaceByName = new Map<string, Record<string, unknown>>();
  for (const workspace of Object.values(lock.workspaces)) {
    if (typeof workspace.name === "string") workspaceByName.set(workspace.name, workspace);
  }
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const workspace = workspaceByName.get(name);
    if (workspace) {
      for (const field of DEPENDENCY_FIELDS) queue.push(...namesOf(workspace[field]));
    }
    for (const entry of byName.get(name) ?? []) queue.push(...entryDependencies(entry));
  }
  return seen;
}

/** What the installed app loads at runtime: reachable from the packaged workspaces' dependencies. */
export function packagedNames(lock: BunLock): Set<string> {
  const roots = PACKAGED_WORKSPACES.flatMap((dir) =>
    DEPENDENCY_FIELDS.flatMap((field) => namesOf(lock.workspaces[dir]?.[field])),
  );
  return reachableNames(lock, roots);
}

/** Package names whose lockfile entries were added, removed or changed. */
export function changedPackageNames(before: BunLock, after: BunLock): string[] {
  const keys = new Set([...Object.keys(before.packages), ...Object.keys(after.packages)]);
  const names = new Set<string>();
  for (const key of keys) {
    if (JSON.stringify(before.packages[key]) !== JSON.stringify(after.packages[key])) {
      names.add(leafName(key));
    }
  }
  return [...names].toSorted();
}

const workspaceReach = new WeakMap<BunLock, Map<string, Set<string>>>();

/** Workspaces (by folder) that reach `name`, dev dependencies included: for the printed reason. */
function usersOf(lock: BunLock, name: string): string[] {
  let reach = workspaceReach.get(lock);
  if (!reach) {
    reach = new Map(
      Object.entries(lock.workspaces).map(([dir, workspace]) => [
        dir || "(root)",
        reachableNames(
          lock,
          [...DEPENDENCY_FIELDS, "devDependencies"].flatMap((field) => namesOf(workspace[field])),
        ),
      ]),
    );
    workspaceReach.set(lock, reach);
  }
  return [...reach].filter(([, names]) => names.has(name)).map(([dir]) => dir);
}

/**
 * One decision per name: packaged when the installed app's runtime can reach it in either lockfile
 * (before or after the change).
 */
export function decideDependencies(
  names: Iterable<string>,
  before: BunLock,
  after: BunLock,
): DependencyDecision[] {
  const packaged = new Set([...packagedNames(before), ...packagedNames(after)]);
  return [...new Set(names)].toSorted().map((name) => {
    if (packaged.has(name)) {
      return {
        name,
        packaged: true,
        reason: "reachable from the runtime dependencies of apps/server or apps/desktop",
      };
    }
    const users = [...new Set([...usersOf(after, name), ...usersOf(before, name)])];
    return {
      name,
      packaged: false,
      reason:
        users.length > 0
          ? `not loaded by the installed app; used by ${users.join(", ")} (bundled or build-only)`
          : "not loaded by the installed app; no workspace uses it",
    };
  });
}

/** The package a patchedDependencies key names: "@scope/name@1.2.3" -> "@scope/name". */
export function patchedPackageName(key: string): string {
  const at = key.lastIndexOf("@");
  return at > 0 ? key.slice(0, at) : key;
}
