// FILE: resultStore.ts
// Purpose: Runtime stores for interactive connectors, on disk under the server state dir (never in
//   the event journal), bounded per entry and LRU-evicted in total:
//   - calls keyed (threadId, callId): the widget binding, the call's input and its full
//     `CallToolResult` (SPEC §3), so a widget re-created after a restart gets what it got live;
//   - the last widget resource read successfully, keyed (provider, threadId, server, uri), and
//     the last tool list of each CLI-own server, keyed (provider, threadId, server), both served
//     when the provider session that would answer is not running (e.g. after a restart).
// Layer: Server MCP Apps runtime (async fs, promise-based)
// Exports: McpAppResultStore, McpAppCallRecord, McpAppResourceCache, MCP_APP_*_STORE_*

import type { CodexMcpAppDescriptor, McpAppResourceReadyResult } from "@moss/contracts";

import { BoundedJsonDiskStore, diskStoreKey } from "./diskStore.ts";

export const MCP_APP_RESULT_STORE_MAX_RECORD_BYTES = 2 * 1024 * 1024;
export const MCP_APP_RESULT_STORE_MAX_TOTAL_BYTES = 500 * 1024 * 1024;
export const MCP_APP_RESOURCE_CACHE_MAX_TOTAL_BYTES = 200 * 1024 * 1024;

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
  /** Why the call failed (`state: "failed"`), as the provider reported it. */
  readonly error?: string;
  readonly updatedAt: number;
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
  private readonly store: BoundedJsonDiskStore<McpAppCallRecord>;

  constructor(
    directory: string,
    private readonly options: {
      readonly maxRecordBytes?: number;
      readonly maxTotalBytes?: number;
      readonly now?: () => number;
      readonly logWarning?: (message: string, fields?: Record<string, unknown>) => void;
    } = {},
  ) {
    this.store = new BoundedJsonDiskStore(directory, {
      maxTotalBytes: options.maxTotalBytes ?? MCP_APP_RESULT_STORE_MAX_TOTAL_BYTES,
      hotEntries: 256,
      isValue: isRecordShape,
      ...(options.now ? { now: options.now } : {}),
      onWriteError: (error) =>
        options.logWarning?.("Could not save an interactive connector result.", {
          error: error instanceof Error ? error.message : String(error),
        }),
    });
  }

  /** Memory first, then disk. Never throws: an unreadable record reads as absent. */
  async get(threadId: string, callId: string): Promise<McpAppCallRecord | undefined> {
    const record = await this.store.get(diskStoreKey(threadId, callId));
    return record?.threadId === threadId && record.callId === callId ? record : undefined;
  }

  /** Synchronous view of a record written or read in this process, for the event hot path. */
  peek(threadId: string, callId: string): McpAppCallRecord | undefined {
    return this.store.peek(diskStoreKey(threadId, callId));
  }

  /** Records (or replaces) one call. The disk write is serialized and runs in the background. */
  put(record: McpAppCallRecord): Promise<void> {
    let stored = record;
    let body = JSON.stringify(stored);
    const maxRecordBytes = this.options.maxRecordBytes ?? MCP_APP_RESULT_STORE_MAX_RECORD_BYTES;
    if (Buffer.byteLength(body, "utf8") > maxRecordBytes) {
      const { result: _omitted, ...rest } = record;
      stored = { ...rest, resultOmitted: "too_large" };
      body = JSON.stringify(stored);
    }
    return this.store.put(diskStoreKey(record.threadId, record.callId), stored, body);
  }

  /** Waits for queued writes (server shutdown). */
  flush(): Promise<void> {
    return this.store.flush();
  }
}

export interface McpAppResourceCacheKey {
  readonly provider: string;
  readonly threadId: string;
  readonly server: string;
  readonly resourceUri: string;
}

export type McpAppToolListCacheKey = Omit<McpAppResourceCacheKey, "resourceUri">;

interface CachedResource extends McpAppResourceCacheKey {
  readonly result: McpAppResourceReadyResult;
  readonly savedAt: number;
}

interface CachedToolList extends McpAppToolListCacheKey {
  readonly kind: "tools";
  readonly tools: ReadonlyArray<Record<string, unknown>>;
  readonly savedAt: number;
}

type CachedEntry = CachedResource | CachedToolList;

function isCachedEntry(value: unknown): value is CachedEntry {
  if (value === null || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.provider !== "string" ||
    typeof entry.threadId !== "string" ||
    typeof entry.server !== "string"
  ) {
    return false;
  }
  if (entry.kind === "tools") return Array.isArray(entry.tools);
  const result = entry.result as Record<string, unknown> | null | undefined;
  return (
    typeof entry.resourceUri === "string" &&
    typeof result === "object" &&
    result !== null &&
    result.state === "ready" &&
    typeof result.html === "string"
  );
}

/**
 * The last successful read of each CLI-own widget resource (HTML + its normalized `_meta.ui`) and
 * the last tool list of each CLI-own server (with `_meta.ui`, widget-only tools included).
 */
export class McpAppResourceCache {
  private readonly store: BoundedJsonDiskStore<CachedEntry>;

  constructor(
    directory: string,
    options: {
      readonly maxTotalBytes?: number;
      readonly now?: () => number;
      readonly logWarning?: (message: string, fields?: Record<string, unknown>) => void;
    } = {},
  ) {
    this.store = new BoundedJsonDiskStore(directory, {
      maxTotalBytes: options.maxTotalBytes ?? MCP_APP_RESOURCE_CACHE_MAX_TOTAL_BYTES,
      // Entries hold whole HTML documents: keep few in memory.
      hotEntries: 16,
      isValue: isCachedEntry,
      ...(options.now ? { now: options.now } : {}),
      onWriteError: (error) =>
        options.logWarning?.("Could not save an interactive connector resource.", {
          error: error instanceof Error ? error.message : String(error),
        }),
    });
    this.now = options.now ?? Date.now;
  }

  private readonly now: () => number;

  private static key(key: McpAppResourceCacheKey): string {
    return diskStoreKey(key.provider, key.threadId, key.server, key.resourceUri);
  }

  async get(key: McpAppResourceCacheKey): Promise<McpAppResourceReadyResult | undefined> {
    const entry = await this.store.get(McpAppResourceCache.key(key));
    if (
      !entry ||
      "kind" in entry ||
      entry.provider !== key.provider ||
      entry.threadId !== key.threadId ||
      entry.server !== key.server ||
      entry.resourceUri !== key.resourceUri
    ) {
      return undefined;
    }
    return entry.result;
  }

  put(key: McpAppResourceCacheKey, result: McpAppResourceReadyResult): Promise<void> {
    return this.store.put(McpAppResourceCache.key(key), { ...key, result, savedAt: this.now() });
  }

  private static toolsKey(key: McpAppToolListCacheKey): string {
    return diskStoreKey("tools", key.provider, key.threadId, key.server);
  }

  async getTools(
    key: McpAppToolListCacheKey,
  ): Promise<ReadonlyArray<Record<string, unknown>> | undefined> {
    const entry = await this.store.get(McpAppResourceCache.toolsKey(key));
    if (
      !entry ||
      !("kind" in entry) ||
      entry.provider !== key.provider ||
      entry.threadId !== key.threadId ||
      entry.server !== key.server
    ) {
      return undefined;
    }
    return entry.tools;
  }

  /** Stores a non-empty tool list; an unchanged list is not written again. */
  putTools(
    key: McpAppToolListCacheKey,
    tools: ReadonlyArray<Record<string, unknown>>,
  ): Promise<void> {
    if (tools.length === 0) return Promise.resolve();
    const storeKey = McpAppResourceCache.toolsKey(key);
    const current = this.store.peek(storeKey);
    if (current && "kind" in current && JSON.stringify(current.tools) === JSON.stringify(tools)) {
      return Promise.resolve();
    }
    return this.store.put(storeKey, { kind: "tools", ...key, tools, savedAt: this.now() });
  }

  flush(): Promise<void> {
    return this.store.flush();
  }
}
