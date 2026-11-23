import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createTransformCache,
  normalizeTransformCachePath,
  transformCacheDirFromEnv,
  transformFingerprint,
} from "./production-assets-transform-cache";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});
const fresh = () => (dir = mkdtempSync(join(tmpdir(), "moss-transform-cache-")));
const key = (code: string, id = "/app/src/a.tsx") => ({
  id,
  code,
  moduleType: "tsx",
  environment: "client",
});
const compiled = (code: string) => async () => ({
  code: `compiled(${code})`,
  map: { version: 3, mappings: "AAAA" },
});

describe("production asset transform cache", () => {
  it("returns the stored result for the same inputs without running the transform", async () => {
    const folder = fresh();
    const first = createTransformCache(folder, "f1");
    const result = await first.transform(key("a"), compiled("a"));
    expect(first.stats).toEqual({ hits: 0, misses: 1 });

    const second = createTransformCache(folder, "f1");
    let ran = false;
    const reused = await second.transform(key("a"), async () => {
      ran = true;
      return { code: "must not be used" };
    });
    expect(ran).toBe(false);
    expect(reused).toEqual(result);
    expect(second.stats).toEqual({ hits: 1, misses: 0 });
  });

  it("misses when the source, id, fingerprint or environment changes", async () => {
    const folder = fresh();
    await createTransformCache(folder, "f1").transform(key("a"), compiled("a"));
    const misses = async (fingerprint: string, k: ReturnType<typeof key>) => {
      const cache = createTransformCache(folder, fingerprint);
      await cache.transform(k, compiled(k.code));
      return cache.stats.misses;
    };
    expect(await misses("f1", key("b"))).toBe(1);
    expect(await misses("f1", key("a", "/app/src/other.tsx"))).toBe(1);
    expect(await misses("f2", key("a"))).toBe(1);
    expect(await misses("f1", { ...key("a"), environment: "ssr" })).toBe(1);
  });

  it("remembers that a module was left alone, and prunes unused entries only", async () => {
    const folder = fresh();
    const first = createTransformCache(folder, "f1");
    await first.transform(key("skip"), async () => undefined);
    await first.transform(key("old"), compiled("old"));
    writeFileSync(join(folder, "notes.txt"), "not an entry");
    const second = createTransformCache(folder, "f1");
    expect(await second.transform(key("skip"), compiled("x"))).toBeNull();
    expect(second.stats.hits).toBe(1);
    expect(await second.prune()).toBe(1);
    expect(readdirSync(folder)).toHaveLength(2);
  });

  it("fingerprints in order and is off unless the environment names a folder", () => {
    expect(transformFingerprint(["a", "b"])).not.toBe(transformFingerprint(["b", "a"]));
    expect(transformCacheDirFromEnv({})).toBeUndefined();
    expect(transformCacheDirFromEnv({ MOSS_WEB_TRANSFORM_CACHE: " " })).toBeUndefined();
    expect(transformCacheDirFromEnv({ MOSS_WEB_TRANSFORM_CACHE: "x" })).toMatch(/x$/u);
  });

  it("normalizes worktree paths and bun store paths identically across checkouts", () => {
    const winRootA = "D:\\DevTemp\\moss-release-1014\\repo";
    const winRootB = "D:\\DevTemp\\moss-release-1015\\repo";
    expect(
      normalizeTransformCachePath(
        "d:/DevTemp/moss-release-1014/repo/apps/web/src/App.tsx?v=1",
        winRootA,
      ),
    ).toBe("<workspace>/apps/web/src/App.tsx?v=1");
    expect(
      normalizeTransformCachePath(
        "D:\\DevTemp\\moss-release-1015\\repo\\apps\\web\\src\\App.tsx?v=1",
        winRootB,
      ),
    ).toBe("<workspace>/apps/web/src/App.tsx?v=1");

    const storePathA =
      "D:\\ceshi\\main\\node_modules\\.bun\\@babel+core@7.29.0+abc123\\node_modules\\@babel\\core\\lib\\index.js";
    const storePathB =
      "D:\\DevTemp\\moss-release-1015\\repo\\node_modules\\.bun\\@babel+core@7.29.0+abc123\\node_modules\\@babel\\core\\lib\\index.js";
    const storePathNewVersion =
      "D:\\DevTemp\\moss-release-1015\\repo\\node_modules\\.bun\\@babel+core@7.30.0+def456\\node_modules\\@babel\\core\\lib\\index.js";
    expect(normalizeTransformCachePath(storePathA, winRootA)).toBe(
      normalizeTransformCachePath(storePathB, winRootB),
    );
    expect(normalizeTransformCachePath(storePathA, winRootA)).not.toBe(
      normalizeTransformCachePath(storePathNewVersion, winRootB),
    );

    expect(normalizeTransformCachePath("\0virtual:module", "/repo")).toBe("\0virtual:module");
    expect(normalizeTransformCachePath("/external/lib.ts", "/repo")).toBe("/external/lib.ts");
  });
});
