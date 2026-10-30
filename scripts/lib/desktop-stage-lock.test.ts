import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

import desktopPackageJson from "../../apps/desktop/package.json" with { type: "json" };
import serverPackageJson from "../../apps/server/package.json" with { type: "json" };
import rootPackageJson from "../../package.json" with { type: "json" };
import committedStagePackageJson from "../desktop-stage-lock/package.json" with { type: "json" };

import { DESKTOP_STAGE_DEPENDENCY_OVERRIDES } from "./desktop-stage-dependency-overrides.ts";
import {
  assertDesktopStageInstallPackageMatches,
  createDesktopStageInstallPackageJson,
  DESKTOP_STAGE_LOCK_DIRECTORY,
} from "./desktop-stage-lock.ts";

function readLockedPackageVersion(
  lockfile: string,
  lockKey: string,
  packageName = lockKey,
): string {
  const escapedKey = lockKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = lockfile.match(
    new RegExp(`^\\s*"${escapedKey}": \\["${escapedName}@([^"\\s]+)"`, "m"),
  );
  assert.ok(match?.[1], `Expected ${lockKey} in bun.lock`);
  return match[1];
}

describe("desktop stage lock", () => {
  it("matches the current server, desktop, catalog, and override dependency inputs", () => {
    const expected = createDesktopStageInstallPackageJson({
      rootPackageJson,
      serverPackageJson,
      desktopPackageJson,
    });

    assert.doesNotThrow(() =>
      assertDesktopStageInstallPackageMatches(committedStagePackageJson, expected),
    );
    assert.deepStrictEqual(committedStagePackageJson.dependencies, expected.dependencies);
    assert.deepStrictEqual(committedStagePackageJson.devDependencies, expected.devDependencies);
    assert.deepStrictEqual(committedStagePackageJson.overrides, expected.overrides);
    assert.deepStrictEqual(
      committedStagePackageJson.patchedDependencies,
      expected.patchedDependencies,
    );
  });

  it("keeps the runtime patch byte-identical inside the self-contained stage lock", () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const patchPath = "patches/@effect%2Fplatform-node-shared@8881a9b.patch";

    assert.equal(
      readFileSync(resolve(repoRoot, DESKTOP_STAGE_LOCK_DIRECTORY, patchPath), "utf8"),
      readFileSync(resolve(repoRoot, patchPath), "utf8"),
    );
  });

  it("commits the dedicated frozen lockfile next to its dependency manifest", () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    assert.equal(existsSync(resolve(repoRoot, DESKTOP_STAGE_LOCK_DIRECTORY, "bun.lock")), true);
  });

  it("locks every dedicated stage override to the reviewed root-workspace resolution", () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const rootLock = readFileSync(resolve(repoRoot, "bun.lock"), "utf8");
    const stageLock = readFileSync(
      resolve(repoRoot, DESKTOP_STAGE_LOCK_DIRECTORY, "bun.lock"),
      "utf8",
    );

    for (const [packageName, overrideVersion] of Object.entries(
      DESKTOP_STAGE_DEPENDENCY_OVERRIDES,
    )) {
      const rootVersion = readLockedPackageVersion(rootLock, packageName);
      assert.equal(readLockedPackageVersion(stageLock, packageName), rootVersion);
      assert.equal(overrideVersion, rootVersion);
    }
  });

  it("keeps each exact diff consumer satisfiable without a flattening override", () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const stageLock = readFileSync(
      resolve(repoRoot, DESKTOP_STAGE_LOCK_DIRECTORY, "bun.lock"),
      "utf8",
    );

    assert.equal("diff" in DESKTOP_STAGE_DEPENDENCY_OVERRIDES, false);
    assert.equal(readLockedPackageVersion(stageLock, "diff"), "8.0.4");
    assert.equal(readLockedPackageVersion(stageLock, "@pierre/diffs/diff", "diff"), "9.0.0");
  });

  it("keeps the staged Pierre release compatible with the production manifest", () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const rootLock = readFileSync(resolve(repoRoot, "bun.lock"), "utf8");
    const stageLock = readFileSync(
      resolve(repoRoot, DESKTOP_STAGE_LOCK_DIRECTORY, "bun.lock"),
      "utf8",
    );

    const rootPierreVersion = readLockedPackageVersion(rootLock, "@pierre/diffs");
    assert.equal(rootPierreVersion, "1.3.5");
    assert.equal(readLockedPackageVersion(stageLock, "@pierre/diffs"), rootPierreVersion);
    assert.equal(DESKTOP_STAGE_DEPENDENCY_OVERRIDES["@pierre/diffs"], rootPierreVersion);
    assert.equal(DESKTOP_STAGE_DEPENDENCY_OVERRIDES["@pierre/theme"], "2.0.0");
  });

  it("fails closed when the reviewed manifest drifts", () => {
    const expected = createDesktopStageInstallPackageJson({
      rootPackageJson,
      serverPackageJson,
      desktopPackageJson,
    });
    const stale = {
      ...committedStagePackageJson,
      dependencies: { ...committedStagePackageJson.dependencies, ws: "0.0.0-stale" },
    };

    assert.throws(
      () => assertDesktopStageInstallPackageMatches(stale, expected),
      /package\.json is stale/,
    );
  });
});
