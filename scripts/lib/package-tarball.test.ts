import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import * as Zlib from "node:zlib";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createPackageTarball, PACKAGE_TARBALL_MTIME } from "./package-tarball.ts";

let directory: string;
beforeEach(() => {
  directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "moss-package-tarball-"));
});
afterEach(() => FS.rmSync(directory, { recursive: true, force: true }));

function entries(gzipped: Buffer) {
  const tar = Zlib.gunzipSync(gzipped);
  const result: Array<{ name: string; size: number; mtime: number; body: string }> = [];
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .split("\0")[0]!;
    const size = Number.parseInt(text(124, 12), 8);
    result.push({
      name: [text(345, 155), text(0, 100)].filter(Boolean).join("/"),
      size,
      mtime: Number.parseInt(text(136, 12), 8),
      body: tar.subarray(offset + 512, offset + 512 + size).toString("utf8"),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return result;
}

it("packs installed files under package/, sorted, without bun markers or nested modules", () => {
  const deep = Path.join(directory, "dist", "a".repeat(60), "b".repeat(60));
  FS.mkdirSync(deep, { recursive: true });
  FS.writeFileSync(Path.join(directory, "package.json"), '{"name":"x","version":"1.0.0"}');
  FS.writeFileSync(Path.join(deep, "c".repeat(40) + ".js"), "patched();\n");
  FS.writeFileSync(Path.join(directory, ".bun-tag-123"), "");
  FS.mkdirSync(Path.join(directory, "node_modules", "dep"), { recursive: true });
  FS.writeFileSync(Path.join(directory, "node_modules", "dep", "index.js"), "");

  const packed = entries(createPackageTarball(directory));
  expect(packed.map((entry) => entry.name)).toEqual([
    `package/dist/${"a".repeat(60)}/${"b".repeat(60)}/${"c".repeat(40)}.js`,
    "package/package.json",
  ]);
  expect(packed[0]!.body).toBe("patched();\n");
  expect(packed.every((entry) => entry.mtime === PACKAGE_TARBALL_MTIME)).toBe(true);
});
