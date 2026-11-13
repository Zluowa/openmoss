// FILE: release-workspace-manifests.ts
// Purpose: Single source for workspace importers copied into release verification/staging roots.
// Layer: Release/build helper

import { globSync, readFileSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

const REQUIRED_RELEASE_MANIFESTS = [
  "package.json",
  "apps/server/package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "apps/marketing/package.json",
  "packages/contracts/package.json",
  "packages/shared/package.json",
  "scripts/package.json",
] as const;

/** Materialize the same workspace graph Bun resolves, including non-shipping dev dependencies. */
export function releaseWorkspaceManifestPaths(repoRoot: string): string[] {
  const root = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
    workspaces: { packages: string[] } | string[];
  };
  const packages = Array.isArray(root.workspaces) ? root.workspaces : root.workspaces.packages;
  const manifests = new Set(["package.json"]);
  for (const entry of globSync(
    packages.map((pattern) => `${pattern}/package.json`),
    { cwd: repoRoot },
  )) {
    const relativePath = entry.split(sep).join("/");
    if (isAbsolute(entry) || relativePath.split("/").includes("..")) {
      throw new Error(`Release workspace must be inside the repository: ${entry}`);
    }
    manifests.add(relativePath);
  }
  for (const required of REQUIRED_RELEASE_MANIFESTS) {
    if (!manifests.has(required))
      throw new Error(`Missing required release workspace manifest: ${required}`);
  }
  return [...manifests].sort();
}

export const RELEASE_LOCKFILE_PATH = "bun.lock";
export const RELEASE_PATCHES_PATH = "patches";
