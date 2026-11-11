import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertRemovable,
  countLinks,
  removeTreeSafe,
  UnsafeTargetError,
} from "../lib/safeRemove.ts";
import { cleanup, linkType, sentinel, tempDir } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) cleanup(d);
});

function setup() {
  const base = tempDir("rm");
  dirs.push(base);
  const root = path.join(base, "root");
  const outside = sentinel(path.join(base, "outside-sentinel"));
  const primary = path.join(base, "primary");
  fs.mkdirSync(root);
  fs.mkdirSync(primary);
  fs.writeFileSync(path.join(primary, "precious.txt"), "primary checkout");
  const guard = { roots: [root], protectedPaths: [primary] };
  return { base, root, outside, primary, guard };
}

/** A worktree-like tree: files, a .git file, node_modules full of junctions to the sentinel. */
function makeTree(at: string, linkTarget: string) {
  fs.mkdirSync(path.join(at, "src", "deep"), { recursive: true });
  fs.writeFileSync(path.join(at, ".git"), "gitdir: elsewhere\n");
  fs.writeFileSync(path.join(at, "src", "a.ts"), "export {}\n");
  fs.writeFileSync(path.join(at, "src", "deep", "b.ts"), "export {}\n");
  const nm = path.join(at, "node_modules");
  fs.mkdirSync(path.join(nm, "@scope"), { recursive: true });
  fs.symlinkSync(linkTarget, path.join(nm, "pkg"), linkType);
  fs.symlinkSync(linkTarget, path.join(nm, "@scope", "child"), linkType);
  fs.symlinkSync(linkTarget, path.join(at, "src", "deep", "linked-dir"), linkType);
  const ro = path.join(at, "src", "readonly.txt");
  fs.writeFileSync(ro, "ro");
  fs.chmodSync(ro, 0o444);
}

describe("removeTreeSafe", () => {
  it("removes a tree full of junctions and never follows one (sentinel survives)", () => {
    const { root, outside, guard } = setup();
    const target = path.join(root, "wt1");
    makeTree(target, outside.dir);
    expect(countLinks(target)).toBe(3);
    const report = removeTreeSafe(target, guard);
    expect(report.errors).toEqual([]);
    expect(report.links).toBe(3);
    expect(fs.existsSync(target)).toBe(false);
    expect(outside.alive()).toBe(true);
  });

  it("removes a junction that points at the primary checkout as a link only", () => {
    const { root, primary, guard } = setup();
    const target = path.join(root, "wt2");
    makeTree(target, primary);
    removeTreeSafe(target, guard);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readFileSync(path.join(primary, "precious.txt"), "utf8")).toBe("primary checkout");
  });

  it("removes a dangling junction", () => {
    const { base, root, guard } = setup();
    const target = path.join(root, "wt3");
    fs.mkdirSync(target);
    const gone = path.join(base, "gone");
    fs.mkdirSync(gone);
    fs.symlinkSync(gone, path.join(target, "dangling"), linkType);
    fs.rmdirSync(gone);
    const report = removeTreeSafe(target, guard);
    expect(report.errors).toEqual([]);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("keeps the sentinel when the link is to a single file, where the OS allows file symlinks", () => {
    const { base, root, guard } = setup();
    const file = path.join(base, "sentinel-file.txt");
    fs.writeFileSync(file, "survive");
    const target = path.join(root, "wt4");
    fs.mkdirSync(target);
    try {
      fs.symlinkSync(file, path.join(target, "file-link"), "file");
    } catch {
      return; // unprivileged Windows cannot create file symlinks; nothing to test
    }
    removeTreeSafe(target, guard);
    expect(fs.readFileSync(file, "utf8")).toBe("survive");
  });
});

describe("assertRemovable refuses", () => {
  const refuses = (fn: () => void, pattern: RegExp) => {
    expect(fn).toThrow(UnsafeTargetError);
    expect(fn).toThrow(pattern);
  };

  it("anything outside the configured roots", () => {
    const { base, guard, outside } = setup();
    const elsewhere = path.join(base, "elsewhere");
    fs.mkdirSync(elsewhere);
    refuses(() => removeTreeSafe(elsewhere, guard), /outside the configured roots/);
    refuses(() => removeTreeSafe(outside.dir, guard), /outside the configured roots/);
    expect(outside.alive()).toBe(true);
  });

  it("the root itself and relative paths", () => {
    const { root, guard } = setup();
    refuses(() => assertRemovable(root, guard), /outside the configured roots/);
    refuses(() => assertRemovable("relative/path", guard), /not an absolute path/);
  });

  it("a target that is itself a junction (to a sentinel), leaving both in place", () => {
    const { root, outside, guard } = setup();
    const link = path.join(root, "looks-like-a-worktree");
    fs.symlinkSync(outside.dir, link, linkType);
    refuses(() => removeTreeSafe(link, guard), /is a link/);
    expect(outside.alive()).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("a target reached through a junction in its parent path", () => {
    const { base, root, guard } = setup();
    const realParent = path.join(base, "real-parent");
    const victim = sentinel(path.join(realParent, "victim"));
    fs.symlinkSync(realParent, path.join(root, "via-link"), linkType);
    refuses(
      () => removeTreeSafe(path.join(root, "via-link", "victim"), guard),
      /reached through a link/,
    );
    expect(victim.alive()).toBe(true);
  });

  it("the primary checkout, anything inside it, and anything containing it", () => {
    const { base, root, primary } = setup();
    const inRoot = path.join(root, "holder");
    const nestedPrimary = path.join(inRoot, "primary-copy");
    fs.mkdirSync(nestedPrimary, { recursive: true });
    const guard = { roots: [root, base], protectedPaths: [primary, nestedPrimary] };
    refuses(() => assertRemovable(primary, guard), /protected path/);
    fs.mkdirSync(path.join(primary, "sub"));
    refuses(() => assertRemovable(path.join(primary, "sub"), guard), /protected path/);
    refuses(() => assertRemovable(inRoot, guard), /contains a protected path/);
    expect(fs.existsSync(path.join(primary, "precious.txt"))).toBe(true);
  });

  it("a main checkout (a .git directory, not a .git file)", () => {
    const { root, guard } = setup();
    const main = path.join(root, "main-checkout");
    fs.mkdirSync(path.join(main, ".git"), { recursive: true });
    refuses(() => removeTreeSafe(main, guard), /\.git directory/);
    expect(fs.existsSync(path.join(main, ".git"))).toBe(true);
  });

  it("a worktree that contains another worktree", () => {
    const { root } = setup();
    const outer = path.join(root, "outer");
    const inner = path.join(outer, "inner");
    fs.mkdirSync(inner, { recursive: true });
    refuses(
      () => removeTreeSafe(outer, { roots: [root], protectedPaths: [], otherWorktrees: [inner] }),
      /contains another worktree/,
    );
    expect(fs.existsSync(inner)).toBe(true);
  });

  it("a missing target", () => {
    const { root, guard } = setup();
    refuses(() => assertRemovable(path.join(root, "nope"), guard), /does not exist/);
  });
});
