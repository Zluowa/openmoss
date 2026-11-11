import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { linkDependencies } from "../lib/linkDeps.ts";
import { samePath } from "../lib/paths.ts";
import { cleanup, linkType, tempDir } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) cleanup(d);
});

function pkg(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), "{}");
}

describe("linkDependencies (port of mkwt.mjs)", () => {
  it("gives the worktree its own empty cache folders; a cache write never reaches the source", () => {
    const base = tempDir("link");
    dirs.push(base);
    const source = path.join(base, "source");
    const wt = path.join(base, "wt");
    for (const root of [source, wt]) {
      pkg(root);
      pkg(path.join(root, "scripts"));
    }
    for (const nm of [
      path.join(source, "node_modules"),
      path.join(source, "scripts", "node_modules"),
    ]) {
      for (const cache of [".cache", ".vite", ".vite-temp"]) {
        fs.mkdirSync(path.join(nm, cache, "deps"), { recursive: true });
        fs.writeFileSync(path.join(nm, cache, "deps", "_metadata.json"), "source");
      }
    }
    const report = linkDependencies(source, wt);
    expect(report.ownCaches.toSorted()).toEqual(
      [
        "./node_modules/.cache",
        "./node_modules/.vite",
        "./node_modules/.vite-temp",
        "scripts/node_modules/.cache",
        "scripts/node_modules/.vite",
        "scripts/node_modules/.vite-temp",
      ].toSorted(),
    );
    for (const rel of report.ownCaches) {
      const own = path.join(wt, rel);
      expect(fs.lstatSync(own).isSymbolicLink()).toBe(false);
      expect(fs.readdirSync(own)).toEqual([]);
      expect(samePath(fs.realpathSync(own), path.join(source, rel))).toBe(false);
      fs.mkdirSync(path.join(own, "deps"));
      fs.writeFileSync(path.join(own, "deps", "_metadata.json"), "worktree");
      fs.writeFileSync(path.join(own, "new-entry.txt"), "worktree");
      expect(fs.readFileSync(path.join(source, rel, "deps", "_metadata.json"), "utf8")).toBe(
        "source",
      );
      expect(fs.existsSync(path.join(source, rel, "new-entry.txt"))).toBe(false);
    }
  });

  it("links store packages, remaps @moss/* into the worktree, copies files, skips dangling links", () => {
    const base = tempDir("link");
    dirs.push(base);
    const source = path.join(base, "source");
    const wt = path.join(base, "wt");
    const store = path.join(source, "node_modules", ".bun", "lodash@4", "node_modules", "lodash");
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(path.join(store, "index.js"), "module.exports = 1");
    for (const root of [source, wt]) {
      pkg(root);
      pkg(path.join(root, "packages", "shared"));
      pkg(path.join(root, "apps", "web"));
    }
    const nm = path.join(source, "apps", "web", "node_modules");
    fs.mkdirSync(path.join(nm, "@moss"), { recursive: true });
    fs.mkdirSync(path.join(nm, "@types"), { recursive: true });
    fs.symlinkSync(store, path.join(nm, "lodash"), linkType);
    fs.symlinkSync(
      path.join(source, "packages", "shared"),
      path.join(nm, "@moss", "shared"),
      linkType,
    );
    fs.symlinkSync(store, path.join(nm, "@types", "lodash"), linkType);
    const gone = path.join(base, "gone");
    fs.mkdirSync(gone);
    fs.symlinkSync(gone, path.join(nm, "@types", "dangling"), linkType);
    fs.rmdirSync(gone);
    fs.writeFileSync(path.join(nm, ".modules.yaml"), "x: 1");
    fs.mkdirSync(path.join(source, "node_modules", ".bin"), { recursive: true });

    const report = linkDependencies(source, wt);

    const wnm = path.join(wt, "apps", "web", "node_modules");
    expect(samePath(fs.realpathSync(path.join(wnm, "lodash")), store)).toBe(true);
    expect(
      samePath(
        fs.realpathSync(path.join(wnm, "@moss", "shared")),
        path.join(wt, "packages", "shared"),
      ),
    ).toBe(true);
    expect(fs.lstatSync(path.join(wnm, "@types")).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(wnm, "@types", "lodash", "index.js"))).toBe(true);
    expect(fs.existsSync(path.join(wnm, "@types", "dangling"))).toBe(false);
    expect(fs.readFileSync(path.join(wnm, ".modules.yaml"), "utf8")).toBe("x: 1");
    expect(report.copied).toBe(1);
    expect(report.warnings.join("\n")).toMatch(
      /dangling link skipped: apps\/web\/node_modules\/@types\/dangling/,
    );

    // Running again leaves existing node_modules alone.
    const again = linkDependencies(source, wt);
    expect(again.linked).toBe(0);
    expect(again.skippedPackages).toContain("apps/web");
  });
});
