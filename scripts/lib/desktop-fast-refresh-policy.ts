// Which source changes a fast refresh of the installed desktop app can carry, and which need the full
// installer. The fast refresh replaces only the app code inside app.asar (desktop main and preloads, the
// server bundle and the web client it serves) and the commit id in the archive's package.json; anything
// that reaches the packaged production dependencies, the bundled runtimes, the canvas bundle, the
// packaged resources or the packaging itself is refused.

/** Archive paths the fast refresh replaces with the fresh build of the same name in the repo. */
export const FAST_REFRESH_REPLACED_DIRECTORIES = {
  "apps/desktop/dist-electron": "apps/desktop/dist-electron",
  "apps/server/dist": "apps/server/dist",
} as const;

export interface FastRefreshRefusal {
  readonly path: string;
  readonly reason: string;
}

import {
  changedPackageNames,
  decideDependencies,
  PACKAGED_WORKSPACES,
  parseBunLock,
  patchedPackageName,
  type BunLock,
  type DependencyDecision,
} from "./desktop-fast-refresh-deps.ts";

export type { DependencyDecision } from "./desktop-fast-refresh-deps.ts";

const STAGE_LOCK_DIRECTORY = "scripts/desktop-stage-lock/";

// bun.lock, scripts/desktop-stage-lock/** and patches/** are decided per package from the lockfile
// (desktop-fast-refresh-deps.ts), not refused as a whole.
const PATH_RULES: ReadonlyArray<{
  readonly test: (path: string) => boolean;
  readonly reason: string;
}> = [
  {
    test: (p) => p.startsWith("apps/desktop/resources/"),
    reason: "packaged desktop resources (icons, installer script, production public config)",
  },
  { test: (p) => p === "scripts/lib/moss-canvas-source-pin.json", reason: "canvas bundle pin" },
  {
    test: (p) =>
      p === "scripts/build-desktop-artifact.ts" ||
      (!/\.test\.[cm]?[jt]s$/u.test(p) &&
        /^scripts\/lib\/(desktop-(artifact|platform-build|stage|signing)|bundled-|windows-native|moss-canvas)/u.test(
          p,
        )),
    reason: "packaging or bundled runtimes (Codex, Claude, Cua, canvas)",
  },
  {
    test: (p) => p.startsWith("apps/desktop/native/") || p.startsWith("apps/desktop/patches/"),
    reason: "desktop native helpers or patches",
  },
  {
    // moss-job-launch.exe ships in resources/, which a fast refresh does not replace.
    test: (p) =>
      p.startsWith("apps/server/native/") ||
      p === "apps/server/scripts/build-windows-job-launcher.mjs",
    reason: "server native helpers (packaged resources, e.g. the Windows job launcher)",
  },
];

/** package.json fields whose change alters what is installed or how the app identifies itself. */
export const FAST_REFRESH_PACKAGE_FIELDS = [
  "version",
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "overrides",
  "resolutions",
  "patchedDependencies",
  "workspaces",
  "catalog",
  "catalogs",
  "main",
] as const;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/** Fields of FAST_REFRESH_PACKAGE_FIELDS that differ between two package.json texts (null = file absent). */
export function changedPackageFields(before: string | null, after: string | null): string[] {
  if (before === null || after === null) return before === after ? [] : ["(file added or removed)"];
  const a = JSON.parse(before) as Record<string, Json>;
  const b = JSON.parse(after) as Record<string, Json>;
  return FAST_REFRESH_PACKAGE_FIELDS.filter((field) => stable(a[field]) !== stable(b[field]));
}

type ReadFile = (path: string) => { before: string | null; after: string | null };

function json(text: string | null): Record<string, unknown> | null {
  return text === null ? null : (JSON.parse(text) as Record<string, unknown>);
}

/** Keys whose values differ between two records (added and removed keys included). */
function changedKeys(before: unknown, after: unknown): string[] {
  const a = (before ?? {}) as Record<string, unknown>;
  const b = (after ?? {}) as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
    (key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]),
  );
}

/**
 * Refusals for the changed paths between the installed archive's commit and the new commit.
 * `read` returns the before/after text of a changed file. Dependency changes are decided per
 * package from the root bun.lock; each decision is appended to `decisions` (for printing).
 */
export function classifyFastRefreshChanges(
  changedPaths: ReadonlyArray<string>,
  read: ReadFile,
  decisions: DependencyDecision[] = [],
): FastRefreshRefusal[] {
  const refusals: FastRefreshRefusal[] = [];
  let locks: { before: BunLock; after: BunLock } | null | undefined;
  const rootLocks = () => {
    if (locks !== undefined) return locks;
    const { before, after } = read("bun.lock");
    try {
      locks =
        before !== null && after !== null
          ? { before: parseBunLock(before), after: parseBunLock(after) }
          : null;
    } catch {
      locks = null;
    }
    return locks;
  };
  /** Refuses `path` when any of `names` is packaged (or the lockfile cannot be read). */
  const decide = (path: string, names: string[]) => {
    if (names.length === 0) return;
    const lock = rootLocks();
    if (!lock) {
      refusals.push({ path, reason: "could not read bun.lock to decide which packages changed" });
      return;
    }
    const decided = decideDependencies(names, lock.before, lock.after);
    for (const decision of decided) {
      if (!decisions.some((d) => d.name === decision.name)) decisions.push(decision);
    }
    const packaged = decided.filter((decision) => decision.packaged).map((d) => d.name);
    if (packaged.length > 0) {
      refusals.push({
        path,
        reason: `packaged dependencies changed (the installed app loads them): ${packaged.join(", ")}`,
      });
    }
  };
  const patchOwner = (patch: string, packageJsonPath: string, base: string): string | null => {
    const { before, after } = read(packageJsonPath);
    for (const text of [after, before]) {
      const patched = (json(text)?.patchedDependencies ?? {}) as Record<string, string>;
      for (const [key, file] of Object.entries(patched)) {
        if (`${base}${file}`.replaceAll("\\", "/") === patch) return patchedPackageName(key);
      }
    }
    return null;
  };

  for (const raw of changedPaths) {
    const path = raw.replaceAll("\\", "/");
    const rule = PATH_RULES.find((candidate) => candidate.test(path));
    if (rule) {
      refusals.push({ path, reason: rule.reason });
      continue;
    }
    if (path === "bun.lock") {
      const lock = rootLocks();
      if (!lock) refusals.push({ path, reason: "could not read bun.lock" });
      else decide(path, changedPackageNames(lock.before, lock.after));
      continue;
    }
    if (path.startsWith(STAGE_LOCK_DIRECTORY)) {
      // The packaged dependency set itself: allowed only when every package it changes is one the
      // installed app never loads (for example a web-only package added because it is patched).
      const rest = path.slice(STAGE_LOCK_DIRECTORY.length);
      const { before, after } = read(path);
      try {
        if (rest === "bun.lock") {
          decide(
            path,
            before !== null && after !== null
              ? changedPackageNames(parseBunLock(before), parseBunLock(after))
              : ["(stage lockfile added or removed)"],
          );
        } else if (rest === "package.json") {
          const a = json(before);
          const b = json(after);
          const other = changedKeys(a, b).filter(
            (key) => !["dependencies", "patchedDependencies"].includes(key),
          );
          if (other.length > 0) {
            refusals.push({ path, reason: `packaged stage fields changed: ${other.join(", ")}` });
          } else {
            decide(path, [
              ...changedKeys(a?.dependencies, b?.dependencies),
              ...changedKeys(a?.patchedDependencies, b?.patchedDependencies).map(
                patchedPackageName,
              ),
            ]);
          }
        } else {
          const owner = patchOwner(
            path,
            `${STAGE_LOCK_DIRECTORY}package.json`,
            STAGE_LOCK_DIRECTORY,
          );
          if (owner) decide(path, [owner]);
          else refusals.push({ path, reason: "packaged stage file for no known package" });
        }
      } catch {
        refusals.push({ path, reason: "could not read the packaged stage files" });
      }
      continue;
    }
    if (path.startsWith("patches/")) {
      const owner = patchOwner(path, "package.json", "");
      if (owner) decide(path, [owner]);
      else
        refusals.push({ path, reason: "dependency patch for no package in patchedDependencies" });
      continue;
    }
    if (path === "package.json" || path.endsWith("/package.json")) {
      const { before, after } = read(path);
      const fields = changedPackageFields(before, after);
      if (fields.length === 0) continue;
      const dir = path === "package.json" ? "" : path.slice(0, -"/package.json".length);
      if (dir === "") {
        // Root: only patchedDependencies is decided per package; the rest (overrides, catalog,
        // workspaces, version) reshapes resolution for every workspace.
        const other = fields.filter((field) => field !== "patchedDependencies");
        if (other.length > 0) {
          refusals.push({ path, reason: `package fields changed: ${fields.join(", ")}` });
        } else {
          decide(
            path,
            changedKeys(json(before)?.patchedDependencies, json(after)?.patchedDependencies).map(
              patchedPackageName,
            ),
          );
        }
      } else if ((PACKAGED_WORKSPACES as readonly string[]).includes(dir)) {
        refusals.push({ path, reason: `package fields changed: ${fields.join(", ")}` });
      }
      // Other workspaces are bundled or build-only; what their changes install is decided above
      // from bun.lock.
    }
  }
  return refusals;
}

/** Where the built web client sits inside the server bundle (apps/server/scripts/cli.ts copies it). */
export const FAST_REFRESH_WEB_CLIENT_DIRECTORY = "apps/server/dist/client";

// Changes that cannot reach the web bundle. Everything else counts as a web build input, which is
// deliberately broad: apps/web, the workspace packages it compiles from source (packages/*), the
// quarantine plugin its vite.config imports (tools/test-quarantine), and every root-level file.
// The web source mentions apps/server and apps/desktop only in comments (checked 2026-11-17).
const NOT_WEB_INPUT: ReadonlyArray<(path: string) => boolean> = [
  (p) => /^apps\/(?!web\/)[^/]+\//u.test(p),
  (p) => p.startsWith("docs/") || p.startsWith(".github/"),
  (p) => p.startsWith("scripts/"),
  (p) => p.startsWith("tools/") && !p.startsWith("tools/test-quarantine/"),
  (p) => p.endsWith(".md"),
  // Tests are never part of the bundle, wherever they live.
  (p) => /\.(?:test|spec|browser)\.[cm]?[jt]sx?$/u.test(p) && !p.endsWith(".d.ts"),
];

/**
 * The changed paths that can alter the web client; empty means the fast refresh may keep the web
 * client of the installed archive instead of rebuilding it.
 */
export function webBuildInputs(changedPaths: ReadonlyArray<string>): string[] {
  return changedPaths
    .map((raw) => raw.replaceAll("\\", "/"))
    .filter((path) => !NOT_WEB_INPUT.some((test) => test(path)));
}

/** What a fast refresh leaves as it was in the last full installer. Printed with every run. */
export const FAST_REFRESH_NOT_REFRESHED = [
  "installer, uninstaller and upgrade path (NSIS)",
  "update feed (latest.yml, blockmap) and code signing",
  "packaged production node_modules and dependency patches",
  "bundled Codex, Claude and Cua runtimes, canvas bundle, SSH remote runtime (ssh-runtime.tar.gz)",
  "native helpers in resources (the Windows job launcher moss-job-launch.exe)",
  "packaged resources and production public config",
  "Electron and Moss.exe; the version number shown stays the installer's",
  "first run on a clean profile",
] as const;
