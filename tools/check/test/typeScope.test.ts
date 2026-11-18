import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { select } from "../lib/plan.ts";
import { entryMatcher, parseJsonc, readTypeScopes, typeOwners } from "../lib/typeScope.ts";
import { readWorkspace } from "../lib/workspace.ts";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

describe("type scopes from the repository's own tsconfig files", () => {
  it("a change under scripts/lib type-checks the server, which includes it (#699)", () => {
    const packages = readWorkspace(repoRoot);
    const scopes = readTypeScopes(repoRoot, packages);
    const owners = typeOwners(["scripts/lib/desktop-feed-release.ts"], scopes);
    expect(owners.has("@moss/cli")).toBe(true);
    expect(owners.has("@moss/scripts")).toBe(true);
    // The import graph alone reaches only @moss/scripts; the selection adds the server's typecheck.
    const selection = select(
      [{ path: "scripts/lib/desktop-feed-release.ts", exists: true }],
      packages,
      {},
      ["scripts/lib/desktop-feed-release.ts"],
      scopes,
    );
    expect(selection.affectedPackages).toEqual(["@moss/scripts"]);
    expect(selection.typePackages).toContain("@moss/cli");
    expect(selection.typePackages).toContain("@moss/scripts");
  });

  it("does not drag in packages whose tsconfig does not cover the file", () => {
    const packages = readWorkspace(repoRoot);
    const owners = typeOwners(["apps/web/src/main.tsx"], readTypeScopes(repoRoot, packages));
    expect(owners.has("@moss/cli")).toBe(false);
    expect(owners.has("@moss/scripts")).toBe(false);
  });
});

describe("entryMatcher", () => {
  it("reads folders, files and globs relative to the tsconfig, and nothing outside the repo", () => {
    const folder = entryMatcher("apps/server", "../../scripts/lib")!;
    expect(folder.test("scripts/lib/a.ts")).toBe(true);
    expect(folder.test("scripts/lib/deep/b.ts")).toBe(true);
    expect(folder.test("scripts/library.ts")).toBe(false);
    const file = entryMatcher("apps/server", "../../scripts/devs/cloudQueue.ts")!;
    expect(file.test("scripts/devs/cloudQueue.ts")).toBe(true);
    expect(file.test("scripts/devs/other.ts")).toBe(false);
    const glob = entryMatcher("apps/web", "src/**/*.ts")!;
    expect(glob.test("apps/web/src/a.ts")).toBe(true);
    expect(glob.test("apps/web/src/x/y/a.ts")).toBe(true);
    expect(glob.test("apps/web/src/a.tsx")).toBe(false);
    expect(entryMatcher("apps/server", "../../../elsewhere")).toBeUndefined();
  });
});

describe("parseJsonc", () => {
  it("reads comments and trailing commas, and keeps // inside strings", () => {
    expect(
      parseJsonc(`{
        // a comment
        "include": ["src", "http://x/y",], /* block */
      }`),
    ).toEqual({ include: ["src", "http://x/y"] });
  });
});
