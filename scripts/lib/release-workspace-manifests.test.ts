// FILE: release-workspace-manifests.test.ts
// Purpose: The release roots take the workspace Bun resolves: a `!path` pattern in the root
//          `workspaces` keeps a folder out, so the phone app (`apps/mobile`, its own npm
//          install, no bun.lock importer) never reaches the desktop production root.
// Layer: Release/build helper tests
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { releaseWorkspaceManifestPaths } from "./release-workspace-manifests";

const REQUIRED = [
  "apps/server",
  "apps/desktop",
  "apps/web",
  "apps/marketing",
  "packages/contracts",
  "packages/shared",
  "scripts",
];

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repoWith(workspaces: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "release-workspace-"));
  roots.push(root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ workspaces: { packages: workspaces } }),
  );
  for (const dir of [...REQUIRED, "apps/mobile"]) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "package.json"), JSON.stringify({ name: dir }));
  }
  return root;
}

describe("release workspace manifests", () => {
  it("leaves out the phone app the root workspaces exclude, before or after the glob", () => {
    for (const workspaces of [
      ["apps/*", "!apps/mobile", "packages/*", "scripts"],
      ["!apps/mobile/", "apps/*", "packages/*", "scripts"],
    ]) {
      const manifests = releaseWorkspaceManifestPaths(repoWith(workspaces));
      expect(manifests).not.toContain("apps/mobile/package.json");
      expect(manifests).toContain("apps/desktop/package.json");
    }
  });

  it("keeps a folder no pattern excludes", () => {
    expect(releaseWorkspaceManifestPaths(repoWith(["apps/*", "packages/*", "scripts"]))).toContain(
      "apps/mobile/package.json",
    );
  });

  it("still refuses to drop a manifest every release needs", () => {
    expect(() =>
      releaseWorkspaceManifestPaths(repoWith(["apps/*", "!apps/desktop", "packages/*", "scripts"])),
    ).toThrow("Missing required release workspace manifest: apps/desktop/package.json");
  });

  // The cases above prove the rule from a fixture, everywhere. This one checks the real
  // checkout, and only where the phone app is present: the public mirror does not carry
  // `apps/mobile`, so there is nothing for it to look at there.
  const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const hasPhoneApp = existsSync(join(repoRoot, "apps/mobile/package.json"));
  it.skipIf(!hasPhoneApp)("keeps this repository's phone app out of the release roots", () => {
    expect(releaseWorkspaceManifestPaths(repoRoot)).not.toContain("apps/mobile/package.json");
  });
});
