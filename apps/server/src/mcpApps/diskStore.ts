// FILE: diskStore.ts
// Purpose: A bounded JSON store on disk for interactive-connector runtime state (full tool
//   results, last-read widget resources): one file per key, writes serialized and atomic, a small
//   in-memory cache of recent entries, LRU eviction above a total size. Never the event journal.
// Layer: Server MCP Apps runtime (async fs, promise-based)
// Exports: BoundedJsonDiskStore, diskStoreKey

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

interface IndexEntry {
  bytes: number;
  touchedAt: number;
}

/** A file-name-safe key for the given parts (NUL-separated, so parts cannot run together). */
export function diskStoreKey(...parts: ReadonlyArray<string>): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 40);
}

export class BoundedJsonDiskStore<T> {
  private readonly hot = new Map<string, T>();
  private index: Map<string, IndexEntry> | null = null;
  private indexLoading: Promise<Map<string, IndexEntry>> | null = null;
  private totalBytes = 0;
  private writes: Promise<void> = Promise.resolve();
  private readonly pendingWrites = new Set<Promise<void>>();

  constructor(
    private readonly directory: string,
    private readonly options: {
      readonly maxTotalBytes: number;
      readonly hotEntries: number;
      /** Rejects a file that is not a `T` (an older layout or a damaged file reads as absent). */
      readonly isValue: (value: unknown) => value is T;
      readonly now?: () => number;
      readonly onWriteError?: (error: unknown) => void;
    },
  ) {}

  private get now(): () => number {
    return this.options.now ?? Date.now;
  }

  /** Memory first, then disk. Never throws. */
  async get(key: string): Promise<T | undefined> {
    const cached = this.hot.get(key);
    if (cached !== undefined) {
      this.touchHot(key, cached);
      return cached;
    }
    try {
      const parsed: unknown = JSON.parse(
        await readFile(path.join(this.directory, `${key}.json`), "utf8"),
      );
      if (!this.options.isValue(parsed)) return undefined;
      this.touchHot(key, parsed);
      return parsed;
    } catch {
      return undefined;
    }
  }

  /** Synchronous view of an entry written or read in this process. */
  peek(key: string): T | undefined {
    return this.hot.get(key);
  }

  /** Stores `value` (serialized as `body`). The write runs serialized in the background. */
  put(key: string, value: T, body: string = JSON.stringify(value)): Promise<void> {
    this.touchHot(key, value);
    const write = this.writes.then(() => this.writeEntry(key, body));
    this.writes = write.catch(() => undefined);
    this.pendingWrites.add(write);
    void write.finally(() => this.pendingWrites.delete(write)).catch(() => undefined);
    return write.catch((error: unknown) => this.options.onWriteError?.(error));
  }

  /** Waits for queued writes (server shutdown). */
  async flush(): Promise<void> {
    await Promise.allSettled(this.pendingWrites);
  }

  private touchHot(key: string, value: T): void {
    this.hot.delete(key);
    this.hot.set(key, value);
    while (this.hot.size > this.options.hotEntries) {
      const oldest = this.hot.keys().next().value;
      if (oldest === undefined) break;
      this.hot.delete(oldest);
    }
  }

  private async writeEntry(key: string, body: string): Promise<void> {
    const index = await this.loadIndex();
    await mkdir(this.directory, { recursive: true });
    const target = path.join(this.directory, `${key}.json`);
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, body, "utf8");
    await rename(temp, target);
    const bytes = Buffer.byteLength(body, "utf8");
    const previous = index.get(key);
    if (previous) this.totalBytes -= previous.bytes;
    index.set(key, { bytes, touchedAt: this.now() });
    this.totalBytes += bytes;
    await this.evict(index, key);
  }

  private async evict(index: Map<string, IndexEntry>, keep: string): Promise<void> {
    if (this.totalBytes <= this.options.maxTotalBytes) return;
    const oldestFirst = [...index.entries()]
      .filter(([key]) => key !== keep)
      .toSorted(([, left], [, right]) => left.touchedAt - right.touchedAt);
    for (const [key, entry] of oldestFirst) {
      if (this.totalBytes <= this.options.maxTotalBytes) break;
      await rm(path.join(this.directory, `${key}.json`), { force: true });
      index.delete(key);
      this.hot.delete(key);
      this.totalBytes -= entry.bytes;
    }
  }

  private loadIndex(): Promise<Map<string, IndexEntry>> {
    if (this.index) return Promise.resolve(this.index);
    this.indexLoading ??= (async () => {
      const index = new Map<string, IndexEntry>();
      let names: string[] = [];
      try {
        names = await readdir(this.directory);
      } catch {
        names = [];
      }
      for (const name of names) {
        if (!name.endsWith(".json")) {
          // A temp file left by a crash mid-write.
          if (name.endsWith(".tmp")) {
            await rm(path.join(this.directory, name), { force: true }).catch(() => undefined);
          }
          continue;
        }
        try {
          const info = await stat(path.join(this.directory, name));
          index.set(name.slice(0, -".json".length), { bytes: info.size, touchedAt: info.mtimeMs });
          this.totalBytes += info.size;
        } catch {
          // Removed meanwhile.
        }
      }
      this.index = index;
      return index;
    })();
    return this.indexLoading;
  }
}
