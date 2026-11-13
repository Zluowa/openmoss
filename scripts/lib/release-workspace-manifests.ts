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

/** Workspace manifests a set of `workspaces` patterns names, forward slashes. */
function manifestsMatching(repoRoot: string, patterns: readonly string[]): string[] {
  if (patterns.length === 0) return [];
  return globSync(
    patterns.map((pattern) => `${pattern.replace(/\/+$/, "")}/package.json`),
    { cwd: repoRoot },
  );
}

/**
 * Materialize the same workspace graph Bun resolves, including non-shipping dev dependencies.
 * A `!path` pattern leaves a folder out, as Bun does, whatever order the patterns come in:
 * `!apps/mobile` keeps the phone app (its own npm install, no bun.lock importer) out of every
 * release root.
 */
export function releaseWorkspaceManifestPaths(repoRoot: string): string[] {
  const root = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
    workspaces: { packages: string[] } | string[];
  };
  const packages = Array.isArray(root.workspaces) ? root.workspaces : root.workspaces.packages;
  const excluded = new Set(
    manifestsMatching(
      repoRoot,
      packages.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1)),
    ).map((entry) => entry.split(sep).join("/")),
  );
  const manifests = new Set(["package.json"]);
  for (const entry of manifestsMatching(
    repoRoot,
    packages.filter((pattern) => !pattern.startsWith("!")),
  )) {
    const relativePath = entry.split(sep).join("/");
    if (isAbsolute(entry) || relativePath.split("/").includes("..")) {
      throw new Error(`Release workspace must be inside the repository: ${entry}`);
    }
    if (!excluded.has(relativePath)) manifests.add(relativePath);
  }
  for (const required of REQUIRED_RELEASE_MANIFESTS) {
    if (!manifests.has(required))
      throw new Error(`Missing required release workspace manifest: ${required}`);
  }
  return [...manifests].sort();
}

export const RELEASE_LOCKFILE_PATH = "bun.lock";
export const RELEASE_PATCHES_PATH = "patches";
