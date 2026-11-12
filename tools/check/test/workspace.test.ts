import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readWorkspace } from "../lib/workspace.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repoWith(workspaces: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "check-workspace-"));
  roots.push(root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ workspaces: { packages: workspaces } }),
  );
  for (const [dir, name] of [
    ["apps/web", "@moss/web"],
    ["apps/mobile", "@moss/mobile"],
    ["packages/shared", "@moss/shared"],
    ["scripts", "@moss/scripts"],
  ] as const) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "package.json"), JSON.stringify({ name }));
  }
  return root;
}

const dirs = (root: string) => readWorkspace(root).map((pkg) => pkg.dir);

describe("workspace patterns", () => {
  it("honours a !path exclusion, before or after the pattern it narrows", () => {
    expect(dirs(repoWith(["apps/*", "!apps/mobile", "packages/*", "scripts"]))).toEqual([
      "apps/web",
      "packages/shared",
      "scripts",
    ]);
    expect(dirs(repoWith(["!apps/mobile/", "apps/*"]))).toEqual(["apps/web"]);
  });

  it("excludes every folder a !glob matches, and nothing without one", () => {
    expect(dirs(repoWith(["apps/*", "packages/*", "!apps/*"]))).toEqual(["packages/shared"]);
    expect(dirs(repoWith(["apps/*"]))).toEqual(["apps/mobile", "apps/web"]);
  });
});
