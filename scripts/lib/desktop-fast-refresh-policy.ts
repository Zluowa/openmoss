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

const PATH_RULES: ReadonlyArray<{
  readonly test: (path: string) => boolean;
  readonly reason: string;
}> = [
  { test: (p) => p === "bun.lock", reason: "dependency lockfile (packaged node_modules)" },
  {
    test: (p) => p.startsWith("scripts/desktop-stage-lock/"),
    reason: "packaged production dependencies",
  },
  { test: (p) => p.startsWith("patches/"), reason: "dependency patches" },
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

/**
 * Refusals for the changed paths between the installed archive's commit and the new commit.
 * `packageJson` returns the before/after text of a changed package.json.
 */
export function classifyFastRefreshChanges(
  changedPaths: ReadonlyArray<string>,
  packageJson: (path: string) => { before: string | null; after: string | null },
): FastRefreshRefusal[] {
  const refusals: FastRefreshRefusal[] = [];
  for (const raw of changedPaths) {
    const path = raw.replaceAll("\\", "/");
    const rule = PATH_RULES.find((candidate) => candidate.test(path));
    if (rule) {
      refusals.push({ path, reason: rule.reason });
      continue;
    }
    if (path === "package.json" || path.endsWith("/package.json")) {
      const { before, after } = packageJson(path);
      const fields = changedPackageFields(before, after);
      if (fields.length > 0) {
        refusals.push({ path, reason: `package fields changed: ${fields.join(", ")}` });
      }
    }
  }
  return refusals;
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
