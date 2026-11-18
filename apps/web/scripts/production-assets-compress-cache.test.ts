import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import { compressCacheFromEnv, createCompressCache } from "./production-assets-compress-cache";

const brotli = promisify(zlib.brotliCompress);
let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const marker = (text: string) => async () => Buffer.from(text);
const fresh = () => (dir = mkdtempSync(join(tmpdir(), "moss-compress-cache-")));

describe("production asset compress cache", () => {
  it("returns the codec's exact bytes, from the cache on a second build", async () => {
    const folder = fresh();
    const source = Buffer.from("export const value = 1;\n".repeat(400));
    const run = () => brotli(source, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
    const expected = await run();

    const first = createCompressCache(folder);
    expect(await first.compress("br", source, "quality=11", run)).toEqual(expected);
    expect(first.stats).toEqual({ hits: 0, misses: 1 });

    const second = createCompressCache(folder);
    let ran = false;
    const reused = await second.compress("br", source, "quality=11", async () => {
      ran = true;
      return Buffer.from("must not be used");
    });
    expect(ran).toBe(false);
    expect(reused).toEqual(expected);
    expect(second.stats).toEqual({ hits: 1, misses: 0 });
  });

  it("keys on the codec, its parameters and the library versions", async () => {
    const folder = fresh();
    const source = Buffer.from("a".repeat(4096));
    const cache = createCompressCache(folder, { zlib: "1", brotli: "1" });
    await cache.compress("br", source, "quality=11", marker("q11"));
    expect(await cache.compress("br", source, "quality=9", marker("q9"))).toEqual(
      Buffer.from("q9"),
    );
    expect(await cache.compress("gz", source, "quality=11", marker("gz"))).toEqual(
      Buffer.from("gz"),
    );
    const newerLibrary = createCompressCache(folder, { zlib: "1", brotli: "2" });
    expect(await newerLibrary.compress("br", source, "quality=11", marker("new"))).toEqual(
      Buffer.from("new"),
    );
  });

  it("prunes the entries a build did not use and leaves other files alone", async () => {
    const folder = fresh();
    const first = createCompressCache(folder);
    await first.compress("gz", Buffer.from("old"), "level=9", async () => Buffer.from("1"));
    await first.compress("gz", Buffer.from("kept"), "level=9", async () => Buffer.from("2"));
    writeFileSync(join(folder, "notes.txt"), "not an entry");
    const second = createCompressCache(folder);
    await second.compress("gz", Buffer.from("kept"), "level=9", async () => Buffer.from("x"));
    expect(await second.prune()).toBe(1);
    expect(readdirSync(folder).toSorted()).toHaveLength(2);
    expect(readdirSync(folder)).toContain("notes.txt");
  });

  it("is off unless the environment names a folder", () => {
    expect(compressCacheFromEnv({})).toBeUndefined();
    expect(compressCacheFromEnv({ MOSS_WEB_PRECOMPRESS_CACHE: "  " })).toBeUndefined();
    expect(compressCacheFromEnv({ MOSS_WEB_PRECOMPRESS_CACHE: fresh() })).toBeDefined();
  });
});
