import { createHash } from "node:crypto";
import * as FS from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { THEME_IMAGE_MAX_BYTES } from "@moss/shared/themeCss";
import { afterEach, describe, expect, it } from "vitest";

import {
  THEME_IMAGE_UNUSED_RETENTION_MS,
  ThemeImageError,
  publishedThemeImageIds,
  resolveThemeImagePath,
  sniffThemeImage,
  storeThemeImageBytes,
  storeThemeImageFile,
  sweepThemeImages,
} from "./themeImages";

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await FS.rm(dir, { recursive: true, force: true });
});
async function tempDir(): Promise<string> {
  const dir = await FS.mkdtemp(path.join(os.tmpdir(), "moss-theme-images-"));
  tempDirs.push(dir);
  return dir;
}

/** A PNG header with an IHDR chunk: enough for the type and size check. */
function pngHeader(width: number, height: number, padding = 0): Uint8Array {
  const bytes = new Uint8Array(33 + padding);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("sniffThemeImage", () => {
  it("reads the type and natural size from the content", () => {
    expect(sniffThemeImage(pngHeader(1024, 1536))).toEqual({
      extension: "png",
      width: 1024,
      height: 1536,
    });
    const gif = new Uint8Array([...Buffer.from("GIF89a"), 0x40, 0x01, 0xf0, 0x00, 0, 0]);
    expect(sniffThemeImage(gif)).toEqual({ extension: "gif", width: 320, height: 240 });
    // JPEG: SOI, an APP0 segment, then SOF0 with height 600 and width 800.
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58,
      0x03, 0x20, 0x03,
    ]);
    expect(sniffThemeImage(jpeg)).toEqual({ extension: "jpg", width: 800, height: 600 });
    const webp = new Uint8Array(30);
    webp.set(Buffer.from("RIFF"), 0);
    webp.set(Buffer.from("WEBPVP8X"), 8);
    webp.set([0xff, 0x03, 0x00, 0xff, 0x05, 0x00], 24); // 1024 x 1536, minus one each
    expect(sniffThemeImage(webp)).toEqual({ extension: "webp", width: 1024, height: 1536 });
    const avif = new Uint8Array([0, 0, 0, 0x1c, ...Buffer.from("ftypavif")]);
    expect(sniffThemeImage(avif)).toEqual({ extension: "avif", width: null, height: null });
  });

  it("refuses SVG, HTML and anything else, whatever the file is called", () => {
    for (const text of [
      '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
      '<?xml version="1.0"?><svg/>',
      "<html><body>hi</body></html>",
      "RIFF0000WAVEfmt ",
      "",
    ]) {
      expect(sniffThemeImage(new Uint8Array(Buffer.from(text)))).toBeNull();
    }
  });
});

describe("storeThemeImageBytes / storeThemeImageFile", () => {
  it("stores under the content hash and the real type, once", async () => {
    const dir = await tempDir();
    const bytes = pngHeader(1024, 1536, 100);
    const first = await storeThemeImageBytes(dir, bytes);
    expect(first.id).toBe(`${sha(bytes)}.png`);
    expect(first.reference).toBe(`moss-theme-image:${sha(bytes)}.png`);
    expect(first).toMatchObject({ width: 1024, height: 1536, bytes: bytes.length });
    const again = await storeThemeImageBytes(dir, bytes);
    expect(again.id).toBe(first.id);
    expect((await FS.readdir(dir)).toSorted()).toEqual([first.id]);
    expect(new Uint8Array(await FS.readFile(path.join(dir, first.id)))).toEqual(bytes);
  });

  it("names a file by what it is, not by its extension", async () => {
    const dir = await tempDir();
    const source = path.join(await tempDir(), "photo.jpg");
    await FS.writeFile(source, pngHeader(10, 20));
    const stored = await storeThemeImageFile(dir, source);
    expect(stored.id.endsWith(".png")).toBe(true);
  });

  it("refuses an SVG, a relative path, a missing file and a file over 10 MB", async () => {
    const dir = await tempDir();
    const sources = await tempDir();
    const svg = path.join(sources, "girl.png");
    await FS.writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await expect(storeThemeImageFile(dir, svg)).rejects.toThrow(/SVG is not accepted/);
    await expect(storeThemeImageFile(dir, "pictures/girl.png")).rejects.toThrow(
      /not an absolute path/,
    );
    await expect(storeThemeImageFile(dir, path.join(sources, "none.png"))).rejects.toThrow(
      /not a file Moss can read/,
    );
    const large = path.join(sources, "large.png");
    await FS.writeFile(large, pngHeader(10, 10, THEME_IMAGE_MAX_BYTES));
    await expect(storeThemeImageFile(dir, large)).rejects.toThrow(/at most 10 MB/);
    await expect(
      storeThemeImageBytes(dir, pngHeader(10, 10, THEME_IMAGE_MAX_BYTES)),
    ).rejects.toBeInstanceOf(ThemeImageError);
    expect(await FS.readdir(dir).catch(() => [])).toEqual([]);
  });
});

describe("resolveThemeImagePath", () => {
  it("finds only a stored id of the fixed shape", async () => {
    const dir = await tempDir();
    const stored = await storeThemeImageBytes(dir, pngHeader(4, 4));
    expect((await resolveThemeImagePath(dir, stored.id))?.path).toBe(path.join(dir, stored.id));
    await FS.writeFile(path.join(path.dirname(dir), "outside.png"), "x");
    for (const id of [
      "../outside.png",
      stored.id.toUpperCase(),
      stored.id.replace(".png", ".svg"),
      `${stored.id}/`,
      `a/${stored.id}`,
      stored.id.slice(1),
      `${"0".repeat(64)}.png`,
    ]) {
      expect(await resolveThemeImagePath(dir, id)).toBeNull();
    }
  });
});

describe("sweepThemeImages", () => {
  it("removes old pictures no theme refers to, and keeps the rest", async () => {
    const dir = await tempDir();
    const kept = await storeThemeImageBytes(dir, pngHeader(1, 1));
    const recent = await storeThemeImageBytes(dir, pngHeader(2, 2));
    const old = await storeThemeImageBytes(dir, pngHeader(3, 3));
    const oldKept = await storeThemeImageBytes(dir, pngHeader(4, 4));
    const longAgo = new Date(Date.now() - THEME_IMAGE_UNUSED_RETENTION_MS - 60_000);
    for (const id of [old.id, oldKept.id]) await FS.utimes(path.join(dir, id), longAgo, longAgo);
    await FS.writeFile(path.join(dir, `.${old.id}.left.tmp`), "x");
    await FS.utimes(path.join(dir, `.${old.id}.left.tmp`), longAgo, longAgo);
    await FS.writeFile(path.join(dir, "notes.txt"), "x");
    await FS.utimes(path.join(dir, "notes.txt"), longAgo, longAgo);

    const removed = await sweepThemeImages(dir, new Set([oldKept.id, kept.id]));
    expect(removed).toEqual([old.id]);
    expect((await FS.readdir(dir)).toSorted()).toEqual(
      [kept.id, recent.id, oldKept.id, "notes.txt"].toSorted(),
    );
  });

  it("reads the references of both packs of a published theme", () => {
    const a = `${"a".repeat(64)}.png`;
    const b = `${"b".repeat(64)}.webp`;
    expect(
      publishedThemeImageIds({
        revision: "r",
        publishedAt: "2026-11-17T00:00:00.000Z",
        light: { css: `x { background: url(moss-theme-image:${a}) }` },
        dark: { css: `x { background: url("moss-theme-image:${b}"), url(moss-theme-image:${a}) }` },
      }),
    ).toEqual([a, b]);
    expect(publishedThemeImageIds(null)).toEqual([]);
  });
});
