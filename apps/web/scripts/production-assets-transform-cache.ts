// A content-addressed cache for the React Compiler's Babel transform in production web builds
// (vite.config.ts reactCompilerPlugin). Off unless MOSS_WEB_TRANSFORM_CACHE names a folder; the
// desktop fast refresh sets it, so a rebuild compiles only the modules whose source changed.
// Measured 2026-11-17: the same build took 292 s with the compiler and 63 s without it, so the Babel
// pass over ~9,200 modules is most of every web build, while a test change touches a few modules.
//
// The key is the module id and source, the module type and environment, and a fingerprint of the
// transform itself: the resolved store paths of Babel, the compiler and the plugins (they carry the
// versions), the content of vite.config.ts (the Babel options live there) and NODE_ENV/BABEL_ENV.
// A hit returns the code and source map Babel returned for exactly those inputs.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const TRANSFORM_CACHE_ENV = "MOSS_WEB_TRANSFORM_CACHE";

const ENTRY_NAME = /^[0-9a-f]{64}\.json$/u;

export interface TransformResult {
  code?: string | undefined;
  map?: unknown;
}

export interface TransformCacheStats {
  hits: number;
  misses: number;
}

export interface TransformCache {
  readonly dir: string;
  readonly stats: TransformCacheStats;
  /** Returns the cached result for these inputs, or runs the transform and stores its result. */
  transform(
    key: { id: string; code: string; moduleType: string; environment: string },
    run: () => Promise<TransformResult | null | undefined>,
  ): Promise<TransformResult | null | undefined>;
  /** Deletes entries this build did not use, so the folder holds one build's results. */
  prune(): Promise<number>;
}

export function createTransformCache(dir: string, fingerprint: string): TransformCache {
  const used = new Set<string>();
  const stats: TransformCacheStats = { hits: 0, misses: 0 };
  let sequence = 0;
  let ready: Promise<unknown> | undefined;
  return {
    dir,
    stats,
    async transform(key, run) {
      ready ??= fs.mkdir(dir, { recursive: true });
      await ready;
      const name = `${createHash("sha256")
        .update(fingerprint)
        .update("\0")
        .update(key.id)
        .update("\0")
        .update(key.moduleType)
        .update("\0")
        .update(key.environment)
        .update("\0")
        .update(key.code)
        .digest("hex")}.json`;
      used.add(name);
      const file = path.join(dir, name);
      try {
        const cached = JSON.parse(await fs.readFile(file, "utf8")) as {
          result: TransformResult | null;
        };
        stats.hits += 1;
        return cached.result;
      } catch {
        // Not cached yet (or unreadable): transform and store.
      }
      const result = await run();
      stats.misses += 1;
      sequence += 1;
      const temp = `${file}.${process.pid}.${sequence}.tmp`;
      try {
        await fs.writeFile(temp, JSON.stringify({ result: result ?? null }));
        await fs.rename(temp, file);
      } catch {
        // The cache only saves time: a failed write never fails the build.
        await fs.rm(temp, { force: true });
      }
      return result;
    },
    async prune() {
      let removed = 0;
      for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
        if (!ENTRY_NAME.test(name) || used.has(name)) continue;
        await fs.rm(path.join(dir, name), { force: true });
        removed += 1;
      }
      return removed;
    },
  };
}

/** What makes two runs of the transform the same: tool locations (with versions) and config. */
export function transformFingerprint(parts: ReadonlyArray<string>): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

export function transformCacheDirFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const dir = env[TRANSFORM_CACHE_ENV]?.trim();
  return dir ? path.resolve(dir) : undefined;
}
