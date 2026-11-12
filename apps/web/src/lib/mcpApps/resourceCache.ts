// FILE: resourceCache.ts
// Purpose: Read each widget resource once per page lifetime (Claude caches per server + uri):
//          concurrent mounts share one request, settled HTML is kept for remounts (StrictMode,
//          a folding turn, a virtualised row coming back). Failures are not kept.
// Layer: Web MCP App host data
// Exports: readMcpAppResourceOnce, resetMcpAppResourceCacheForTests

import type { McpAppResourceRead } from "./contracts";

const MAX_ENTRIES = 16;
const settled = new Map<string, McpAppResourceRead>();
const inFlight = new Map<string, Promise<McpAppResourceRead>>();

export function mcpAppResourceCacheKey(parts: {
  readonly threadId: string;
  readonly serverKey: string;
  readonly resourceUri: string;
}): string {
  return `${parts.threadId}\u0000${parts.serverKey}\u0000${parts.resourceUri}`;
}

/**
 * `read` runs without a signal: one caller going away must not cancel the read another mount
 * is waiting for. Callers drop a stale answer themselves.
 */
export function readMcpAppResourceOnce(
  key: string,
  read: () => Promise<McpAppResourceRead>,
): Promise<McpAppResourceRead> {
  const hit = settled.get(key);
  if (hit) {
    settled.delete(key);
    settled.set(key, hit);
    return Promise.resolve(hit);
  }
  const pending = inFlight.get(key);
  if (pending) return pending;
  const request = read()
    .then((result) => {
      if (result.state === "ready") {
        settled.set(key, result);
        while (settled.size > MAX_ENTRIES) {
          const oldest = settled.keys().next().value;
          if (oldest === undefined) break;
          settled.delete(oldest);
        }
      }
      return result;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, request);
  return request;
}

export function resetMcpAppResourceCacheForTests(): void {
  settled.clear();
  inFlight.clear();
}
