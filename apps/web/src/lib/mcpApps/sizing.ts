// FILE: sizing.ts
// Purpose: Inline widget height rules (SPEC §5): ceil, clamp to 5 000 px, ignore empty reports
//          while a remembered height holds, and remember heights per widget on this device.
// Layer: Web MCP App host presentation
// Exports: resolveMcpAppReportedHeight, readRememberedMcpAppHeight, rememberMcpAppHeight,
//          MCP_APP_WIDGET_HEIGHTS_STORAGE_KEY

import {
  MCP_APP_EMPTY_HEIGHT_THRESHOLD,
  MCP_APP_INLINE_MAX_HEIGHT,
  MCP_APP_REMEMBERED_HEIGHTS_MAX,
} from "./constants";

export const MCP_APP_WIDGET_HEIGHTS_STORAGE_KEY = "mcp-app-widget-heights";

/**
 * The height to show after a `size-changed` report, or null to keep the current one.
 * `restoring` is true while the row still holds a remembered height and the widget has not yet
 * reported a real one.
 */
export function resolveMcpAppReportedHeight(
  reported: number | undefined,
  restoring: boolean,
): number | null {
  if (reported === undefined || !Number.isFinite(reported) || reported < 0) return null;
  const height = Math.min(Math.ceil(reported), MCP_APP_INLINE_MAX_HEIGHT);
  if (restoring && height <= MCP_APP_EMPTY_HEIGHT_THRESHOLD) return null;
  return height;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readAll(): Record<string, number> {
  try {
    const raw = storage()?.getItem(MCP_APP_WIDGET_HEIGHTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

export function mcpAppHeightKey(threadId: string, callId: string): string {
  return `${threadId}:${callId}`;
}

export function readRememberedMcpAppHeight(key: string): number | null {
  const value = readAll()[key];
  return value !== undefined && value > MCP_APP_EMPTY_HEIGHT_THRESHOLD
    ? Math.min(value, MCP_APP_INLINE_MAX_HEIGHT)
    : null;
}

export function rememberMcpAppHeight(key: string, height: number): void {
  if (!Number.isFinite(height) || height <= MCP_APP_EMPTY_HEIGHT_THRESHOLD) return;
  const all = readAll();
  delete all[key];
  all[key] = Math.min(Math.ceil(height), MCP_APP_INLINE_MAX_HEIGHT);
  const keys = Object.keys(all);
  for (const stale of keys.slice(0, Math.max(0, keys.length - MCP_APP_REMEMBERED_HEIGHTS_MAX))) {
    delete all[stale];
  }
  try {
    storage()?.setItem(MCP_APP_WIDGET_HEIGHTS_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // A full or blocked store only costs the reserved row height next time.
  }
}
