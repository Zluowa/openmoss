// FILE: resultStore.ts
// Purpose: Runtime store of MCP App calls keyed (threadId, callId): the widget binding, the call's
//   input and its full `CallToolResult`. Lives on disk under the server state dir (never in the
//   event journal), bounded per record and LRU-evicted in total (SPEC §3), so a widget re-created
//   after a restart gets the same input and result it got live.
// Layer: Server MCP Apps runtime (async fs, promise-based)
// Exports: McpAppResultStore, McpAppCallRecord, MCP_APP_RESULT_STORE_*

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CodexMcpAppDescriptor } from "@moss/contracts";

export const MCP_APP_RESULT_STORE_MAX_RECORD_BYTES = 2 * 1024 * 1024;
export const MCP_APP_RESULT_STORE_MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const HOT_CACHE_ENTRIES = 256;

export type McpAppCallState = "pending" | "ready" | "failed";

export interface McpAppCallRecord {
  readonly threadId: string;
  readonly callId: string;
  readonly binding: CodexMcpAppDescriptor;
  readonly state: McpAppCallState;
  readonly input?: Record<string, unknown>;
  /** Full result; absent while pending, after a failure, or when it exceeded the record cap. */
  readonly result?: Record<string, unknown>;
  readonly resultOmitted?: "too_large";
  readonly updatedAt: number;
}

interface IndexEntry {
  bytes: number;
  touchedAt: number;
}

function recordKey(threadId: string, callId: string): string {
  return createHash("sha256").update(`${threadId}\0${callId}`).digest("hex").slice(0, 40);
}

function isRecordShape(value: unknown): value is McpAppCallRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.threadId === "string" &&
    typeof record.callId === "string" &&
    typeof record.binding === "object" &&
    record.binding !== null &&
    (record.state === "pending" || record.state === "ready" || record.state === "failed")
  );
}

export class McpAppResultStore {
  private readonly hot = new Map<string, McpAppCallRecord>();
  private index: Map<string, IndexEntry> | null = null;
  private indexLoading: Promise<Map<string, IndexEntry>> | null = null;
  private totalBytes = 0;
  private writes: Promise<void> = Promise.resolve();
  private readonly pendingWrites = new Set<Promise<void>>();

  constructor(
    private readonly directory: string,
    private readonly options: {
      readonly maxRecordBytes?: number;
      readonly maxTotalBytes?: number;
      readonly now?: () => number;
      readonly logWarning?: (message: string, fields?: Record<string, unknown>) => void;
    } = {},
  ) {}

  private get now(): () => number {
    return this.options.now ?? Date.now;
  }

  /** Memory first, then disk. Never throws: an unreadable record reads as absent. */
  async get(threadId: string, callId: string): Promise<McpAppCallRecord | undefined> {
    const key = recordKey(threadId, callId);
    const cached = this.hot.get(key);
    if (cached) {
      this.touchHot(key, cached);
      return cached;
    }
    try {
      const raw = await readFile(path.join(this.directory, `${key}.json`), "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!isRecordShape(parsed) || parsed.threadId !== threadId || parsed.callId !== callId) {
        return undefined;
      }
      this.touchHot(key, parsed);
      return parsed;
    } catch {
      return undefined;
    }
  }

  /** Synchronous view of a record written or read in this process, for the event hot path. */
  peek(threadId: string, callId: string): McpAppCallRecord | undefined {
    return this.hot.get(recordKey(threadId, callId));
  }

  /** Records (or replaces) one call. The disk write is serialized and runs in the background. */
  put(record: McpAppCallRecord): Promise<void> {
    const key = recordKey(record.threadId, record.callId);
    let stored = record;
    let body = JSON.stringify(stored);
    const maxRecordBytes = this.options.maxRecordBytes ?? MCP_APP_RESULT_STORE_MAX_RECORD_BYTES;
    if (Buffer.byteLength(body, "utf8") > maxRecordBytes) {
      const { result: _omitted, ...rest } = record;
      stored = { ...rest, resultOmitted: "too_large" };
      body = JSON.stringify(stored);
    }
    this.touchHot(key, stored);
    const write = this.writes.then(() => this.writeRecord(key, body));
    this.writes = write.catch(() => undefined);
    this.pendingWrites.add(write);
    void write.finally(() => this.pendingWrites.delete(write)).catch(() => undefined);
    return write.catch((error: unknown) => {
      this.options.logWarning?.("Could not save an interactive connector result.", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /** Waits for queued writes (server shutdown). */
  async flush(): Promise<void> {
    await Promise.allSettled(this.pendingWrites);
  }

  private touchHot(key: string, record: McpAppCallRecord): void {
    this.hot.delete(key);
    this.hot.set(key, record);
    while (this.hot.size > HOT_CACHE_ENTRIES) {
      const oldest = this.hot.keys().next().value;
      if (oldest === undefined) break;
      this.hot.delete(oldest);
    }
  }

  private async writeRecord(key: string, body: string): Promise<void> {
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
    const maxTotalBytes = this.options.maxTotalBytes ?? MCP_APP_RESULT_STORE_MAX_TOTAL_BYTES;
    if (this.totalBytes <= maxTotalBytes) return;
    const oldestFirst = [...index.entries()]
      .filter(([key]) => key !== keep)
      .toSorted(([, left], [, right]) => left.touchedAt - right.touchedAt);
    for (const [key, entry] of oldestFirst) {
      if (this.totalBytes <= maxTotalBytes) break;
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
          index.set(name.slice(0, -".json".length), {
            bytes: info.size,
            touchedAt: info.mtimeMs,
          });
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
