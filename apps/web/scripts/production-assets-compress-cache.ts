// A content-addressed cache for the .gz and .br sidecars the production build writes (vite.config.ts
// precompress plugin). Off unless MOSS_WEB_PRECOMPRESS_CACHE names a folder; the desktop fast refresh
// sets it so a rebuild compresses only the files whose bytes changed. Brotli at quality 11 over the
// ~1,100 compressible files took 50 s of the build on 2026-11-17, while most hashed chunks are
// unchanged between two test builds.
//
// The key is the source's SHA-256 plus the codec, its parameters and the zlib and brotli library
// versions, so a hit returns exactly the bytes the codec would produce again.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const PRECOMPRESS_CACHE_ENV = "MOSS_WEB_PRECOMPRESS_CACHE";

const ENTRY_NAME = /^[0-9a-f]{64}-[0-9a-f]{16}\.(?:gz|br)$/u;

export interface CompressCacheStats {
  hits: number;
  misses: number;
}

export interface CompressCache {
  readonly dir: string;
  readonly stats: CompressCacheStats;
  /** Returns the cached bytes for this source and codec, or compresses and stores them. */
  compress(
    kind: "gz" | "br",
    source: Buffer,
    params: string,
    run: () => Promise<Buffer>,
  ): Promise<Buffer>;
  /** Deletes entries this build did not use, so the folder holds one build's sidecars. */
  prune(): Promise<number>;
}

export function createCompressCache(
  dir: string,
  versions: Readonly<Record<string, string | undefined>> = process.versions,
): CompressCache {
  const used = new Set<string>();
  const stats: CompressCacheStats = { hits: 0, misses: 0 };
  const library = `zlib=${versions.zlib ?? "?"};brotli=${versions.brotli ?? "?"}`;
  let sequence = 0;
  let ready: Promise<unknown> | undefined;
  return {
    dir,
    stats,
    async compress(kind, source, params, run) {
      ready ??= fs.mkdir(dir, { recursive: true });
      await ready;
      const content = createHash("sha256").update(source).digest("hex");
      const codec = createHash("sha256")
        .update(`${kind}\0${params}\0${library}`)
        .digest("hex")
        .slice(0, 16);
      const name = `${content}-${codec}.${kind}`;
      used.add(name);
      const file = path.join(dir, name);
      try {
        const cached = await fs.readFile(file);
        stats.hits += 1;
        return cached;
      } catch {
        // Not cached yet (or unreadable): compress and store.
      }
      const bytes = await run();
      stats.misses += 1;
      sequence += 1;
      const temp = `${file}.${process.pid}.${sequence}.tmp`;
      try {
        await fs.writeFile(temp, bytes);
        await fs.rename(temp, file);
      } catch {
        // The cache only saves time: a failed write never fails the build.
        await fs.rm(temp, { force: true });
      }
      return bytes;
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

export function compressCacheFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): CompressCache | undefined {
  const dir = env[PRECOMPRESS_CACHE_ENV]?.trim();
  return dir ? createCompressCache(path.resolve(dir)) : undefined;
}
