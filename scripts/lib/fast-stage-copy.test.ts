import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as Path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { copyFileReplacingTarget, copyTreeFast } from "./fast-stage-copy.ts";

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function freshDir(): string {
  root = mkdtempSync(Path.join(tmpdir(), "moss-fast-stage-copy-"));
  return root;
}

describe("fast-stage-copy", () => {
  it("clones nested trees and preserves empty directories", async () => {
    const dir = freshDir();
    const src = Path.join(dir, "src");
    const dst = Path.join(dir, "dst");
    mkdirSync(Path.join(src, "a/b"), { recursive: true });
    mkdirSync(Path.join(src, "empty"), { recursive: true });
    writeFileSync(Path.join(src, "root.txt"), "root-bytes");
    writeFileSync(Path.join(src, "a/b/nested.txt"), "nested-bytes");

    const result = await copyTreeFast(src, dst, { mode: "hardlink" });

    expect(result.files).toBe(2);
    expect(result.hardlinked + result.copied).toBe(2);
    expect(readFileSync(Path.join(dst, "root.txt"), "utf8")).toBe("root-bytes");
    expect(readFileSync(Path.join(dst, "a/b/nested.txt"), "utf8")).toBe("nested-bytes");
    expect(readFileSync(Path.join(src, "root.txt"), "utf8")).toBe("root-bytes");
  });

  it("never mutates the source file when replacing a file inside a hardlinked stage", async () => {
    const dir = freshDir();
    const src = Path.join(dir, "src");
    const dst = Path.join(dir, "dst");
    const overrideSource = Path.join(dir, "override.ico");
    mkdirSync(src, { recursive: true });
    writeFileSync(Path.join(src, "favicon.ico"), "original-icon");
    writeFileSync(overrideSource, "published-icon");

    await copyTreeFast(src, dst, { mode: "hardlink" });
    await copyFileReplacingTarget(overrideSource, Path.join(dst, "favicon.ico"));

    expect(readFileSync(Path.join(dst, "favicon.ico"), "utf8")).toBe("published-icon");
    expect(readFileSync(Path.join(src, "favicon.ico"), "utf8")).toBe("original-icon");
  });

  it("supports copy mode and cleanly overwrites an existing destination tree", async () => {
    const dir = freshDir();
    const src = Path.join(dir, "src");
    const dst = Path.join(dir, "dst");
    mkdirSync(src, { recursive: true });
    mkdirSync(dst, { recursive: true });
    writeFileSync(Path.join(src, "item.txt"), "v2");
    writeFileSync(Path.join(dst, "item.txt"), "v1");

    const result = await copyTreeFast(src, dst, { mode: "copy" });

    expect(result.copied).toBe(1);
    expect(result.hardlinked).toBe(0);
    expect(readFileSync(Path.join(dst, "item.txt"), "utf8")).toBe("v2");
  });

  it("skips entries matched by the skip predicate without touching the source tree", async () => {
    const dir = freshDir();
    const src = Path.join(dir, "src");
    const dst = Path.join(dir, "dst");
    mkdirSync(Path.join(src, "client/assets"), { recursive: true });
    writeFileSync(Path.join(src, "client/index.html"), "<html>");
    writeFileSync(Path.join(src, "client/index.html.gz"), "gz-bytes");
    writeFileSync(Path.join(src, "client/assets/app.js"), "console.log(1)");
    writeFileSync(Path.join(src, "client/assets/app.js.br"), "br-bytes");

    const result = await copyTreeFast(src, dst, {
      mode: "hardlink",
      skip: (rel) => rel.startsWith("client/") && /\.(?:gz|br)$/u.test(rel),
    });

    expect(result.files).toBe(2);
    expect(readFileSync(Path.join(dst, "client/index.html"), "utf8")).toBe("<html>");
    expect(readFileSync(Path.join(dst, "client/assets/app.js"), "utf8")).toBe("console.log(1)");
    expect(() => readFileSync(Path.join(dst, "client/index.html.gz"))).toThrow();
    expect(() => readFileSync(Path.join(dst, "client/assets/app.js.br"))).toThrow();
    expect(readFileSync(Path.join(src, "client/index.html.gz"), "utf8")).toBe("gz-bytes");
  });
});
