// FILE: desktop-stage-lock.ts
// Purpose: Derives and validates the dependency-only manifest protected by the desktop stage lockfile.
// Layer: Release/build script support

import { DESKTOP_STAGE_DEPENDENCY_OVERRIDES } from "./desktop-stage-dependency-overrides.ts";
import { resolveCatalogDependencies } from "./resolve-catalog.ts";

export const DESKTOP_STAGE_LOCK_DIRECTORY = "scripts/desktop-stage-lock";

interface RootPackageJsonLike {
  readonly packageManager?: unknown;
  readonly overrides?: Record<string, unknown>;
  readonly patchedDependencies?: Record<string, unknown>;
  readonly workspaces?: {
    readonly catalog?: Record<string, unknown>;
  };
}

interface WorkspacePackageJsonLike {
  readonly dependencies?: Record<string, unknown>;
}

export interface DesktopStageInstallPackageJson {
  readonly name: "moss-desktop-stage-dependencies";
  readonly version: "0.0.0";
  readonly private: true;
  readonly packageManager: string;
  readonly dependencies: Record<string, string>;
  readonly devDependencies: {
    readonly electron: string;
  };
  readonly overrides: Record<string, string>;
  readonly patchedDependencies: Record<string, string>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireStringRecord(
  value: Record<string, unknown>,
  label: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).map(([name, spec]) => [
      name,
      requireString(spec, `${label} dependency '${name}'`),
    ]),
  );
}

function includeRegistryPatchedDependencies(
  dependencies: Record<string, string>,
  patchedDependencies: Record<string, unknown>,
): Record<string, string> {
  const result = { ...dependencies };
  for (const key of Object.keys(patchedDependencies)) {
    const separator = key.lastIndexOf("@");
    if (separator <= 0) continue;
    const name = key.slice(0, separator);
    const version = key.slice(separator + 1);
    if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version)) continue;
    if (!(name in result)) result[name] = version;
  }
  return result;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJsonValue(child)]),
    );
  }
  return value;
}

export function createDesktopStageInstallPackageJson(input: {
  readonly rootPackageJson: RootPackageJsonLike;
  readonly serverPackageJson: WorkspacePackageJsonLike;
  readonly desktopPackageJson: WorkspacePackageJsonLike;
}): DesktopStageInstallPackageJson {
  const catalog = input.rootPackageJson.workspaces?.catalog;
  if (!catalog) {
    throw new Error("Root package.json must define a workspace catalog.");
  }

  const serverDependencies = input.serverPackageJson.dependencies;
  if (!serverDependencies || Object.keys(serverDependencies).length === 0) {
    throw new Error("apps/server/package.json must define production dependencies.");
  }

  const desktopDependencies = input.desktopPackageJson.dependencies;
  if (!desktopDependencies || Object.keys(desktopDependencies).length === 0) {
    throw new Error("apps/desktop/package.json must define runtime dependencies.");
  }
  const electron = requireString(desktopDependencies.electron, "Desktop Electron version");
  const desktopRuntimeDependencies = Object.fromEntries(
    Object.entries(desktopDependencies).filter(([name]) => name !== "electron"),
  );

  const resolvedDependencies = requireStringRecord(
    {
      ...resolveCatalogDependencies(serverDependencies, catalog, "apps/server"),
      ...resolveCatalogDependencies(desktopRuntimeDependencies, catalog, "apps/desktop"),
    },
    "Desktop stage",
  );
  const dependencies = includeRegistryPatchedDependencies(
    resolvedDependencies,
    input.rootPackageJson.patchedDependencies ?? {},
  );
  const overrides = requireStringRecord(
    {
      ...DESKTOP_STAGE_DEPENDENCY_OVERRIDES,
      ...resolveCatalogDependencies(
        input.rootPackageJson.overrides ?? {},
        catalog,
        "root overrides",
      ),
    },
    "Desktop stage override",
  );
  const patchedDependencies = requireStringRecord(
    input.rootPackageJson.patchedDependencies ?? {},
    "Desktop stage patched",
  );

  return {
    name: "moss-desktop-stage-dependencies",
    version: "0.0.0",
    private: true,
    packageManager: requireString(input.rootPackageJson.packageManager, "Root packageManager"),
    dependencies,
    devDependencies: { electron },
    overrides,
    patchedDependencies,
  };
}

export function assertDesktopStageInstallPackageMatches(
  actual: unknown,
  expected: DesktopStageInstallPackageJson,
): void {
  const actualJson = JSON.stringify(sortJsonValue(actual));
  const expectedJson = JSON.stringify(sortJsonValue(expected));
  if (actualJson !== expectedJson) {
    throw new Error(
      `${DESKTOP_STAGE_LOCK_DIRECTORY}/package.json is stale. Refresh its reviewed bun.lock together with dependency changes.`,
    );
  }
}
