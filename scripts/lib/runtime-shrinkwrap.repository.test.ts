// FILE: runtime-shrinkwrap.repository.test.ts
// Purpose: Guards the real server runtime lock: every bun-patched runtime package ships patched.
// Layer: Release/build script tests (reads this checkout's installed dependencies)

import * as FS from "node:fs";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";
import * as Zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { resolveCatalogDependencies } from "./resolve-catalog.ts";
import { createRuntimeShrinkwrap, parseBunLockPackages } from "./runtime-shrinkwrap.ts";

const repoRoot = Path.resolve(Path.dirname(fileURLToPath(import.meta.url)), "../..");
const readJson = (file: string) => JSON.parse(FS.readFileSync(Path.join(repoRoot, file), "utf8"));
type Entry = { readonly name?: string; readonly version: string; readonly resolved: string };

describe("server runtime lock for this repository", () => {
  const rootPackageJson = readJson("package.json");
  const serverPackageJson = readJson("apps/server/package.json");
  const patchedDependencies: Record<string, string> = rootPackageJson.patchedDependencies ?? {};
  const build = (patches?: Record<string, string>) =>
    createRuntimeShrinkwrap({
      packageDirectory: Path.join(repoRoot, "apps/server"),
      packageJson: {
        name: serverPackageJson.name,
        version: serverPackageJson.version,
        dependencies: resolveCatalogDependencies(
          serverPackageJson.dependencies,
          rootPackageJson.workspaces.catalog,
          "apps/server",
        ) as Record<string, string>,
      },
      bunLock: parseBunLockPackages(FS.readFileSync(Path.join(repoRoot, "bun.lock"), "utf8")),
      ...(patches ? { patchedDependencies: patches, patchRoot: repoRoot } : {}),
    });
  const entries = (lock: ReturnType<typeof build>) =>
    Object.entries(lock.shrinkwrap.packages).filter(([location]) => location) as [string, Entry][];

  it("installs every patched package the runtime uses from its patched copy", () => {
    // Find runtime packages with a bun patch independently, from the unpatched lock:
    // a patch key is `name@version` or `name@<tarball url>`.
    const upstream = entries(build());
    const patchedLocations = upstream
      .filter(([location, entry]) => {
        const name = entry.name ?? location.slice(location.lastIndexOf("node_modules/") + 13);
        return Object.keys(patchedDependencies).some(
          (key) => key === `${name}@${entry.version}` || key === `${name}@${entry.resolved}`,
        );
      })
      .map(([location]) => location);
    // The server runtime does use patched packages today (platform-node-shared, diffs).
    expect(patchedLocations.length).toBeGreaterThan(0);

    // A newly patched runtime package that is not shipped patched fails here,
    // and the pack itself throws when an installed copy lacks its patch.
    const shipped = new Map(entries(build(patchedDependencies)));
    for (const location of patchedLocations)
      expect(shipped.get(location)?.resolved, location).toMatch(/^file:patched\/.+\.tgz$/u);
  });

  it("puts the process-group kill guard into the shipped platform-node-shared copy", () => {
    const file = build(patchedDependencies).files.find((entry) =>
      entry.path.includes("platform-node-shared"),
    );
    expect(file).toBeDefined();
    expect(Zlib.gunzipSync(file!.contents).toString("utf8")).toContain("pid <= 1");
  });
});
