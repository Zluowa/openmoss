// FILE: preferences.ts
// Purpose: Per-device widget preferences: hidden connectors (last 100), tools whose widgets stay
//          closed, links that skip the confirm dialog per connector, and device-permission
//          answers per connector. Stored in Moss's client storage; all reads tolerate damage.
// Layer: Web MCP App host state
// Exports: useMcpAppPreferences, isMcpAppConnectorHidden, setMcpAppConnectorHidden,
//          isMcpAppToolClosed, setMcpAppToolClosed, isMcpAppLinkTrusted, trustMcpAppLink,
//          readMcpAppPermissionDecision, writeMcpAppPermissionDecision, resetMcpAppPreferences

import { useSyncExternalStore } from "react";

import { MCP_APP_CLOSED_TOOLS_MAX, MCP_APP_HIDDEN_CONNECTORS_MAX } from "./constants";
import type { McpAppPermissions } from "./contracts";

export const MCP_APP_PREFERENCES_STORAGE_KEY = "moss:mcp-app-preferences";

interface McpAppPreferences {
  readonly hiddenConnectors: readonly string[];
  readonly closedTools: readonly string[];
  /** serverKey → trusted link hosts (or schemes for mailto/tel/sms). */
  readonly trustedLinks: Readonly<Record<string, readonly string[]>>;
  /** serverKey → granted permission set, or "denied". */
  readonly permissions: Readonly<Record<string, McpAppPermissions | "denied">>;
}

const EMPTY: McpAppPreferences = {
  hiddenConnectors: [],
  closedTools: [],
  trustedLinks: {},
  permissions: {},
};

let cached: McpAppPreferences | null = null;
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function read(): McpAppPreferences {
  if (cached) return cached;
  let parsed: Record<string, unknown> = {};
  try {
    const raw = storage()?.getItem(MCP_APP_PREFERENCES_STORAGE_KEY);
    const value = raw ? (JSON.parse(raw) as unknown) : null;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    parsed = {};
  }
  const trustedLinks: Record<string, string[]> = {};
  if (parsed.trustedLinks && typeof parsed.trustedLinks === "object") {
    for (const [key, value] of Object.entries(parsed.trustedLinks as Record<string, unknown>)) {
      trustedLinks[key] = strings(value);
    }
  }
  const permissions: Record<string, McpAppPermissions | "denied"> = {};
  if (parsed.permissions && typeof parsed.permissions === "object") {
    for (const [key, value] of Object.entries(parsed.permissions as Record<string, unknown>)) {
      if (value === "denied") permissions[key] = "denied";
      else if (value && typeof value === "object") permissions[key] = value as McpAppPermissions;
    }
  }
  cached = {
    hiddenConnectors: strings(parsed.hiddenConnectors),
    closedTools: strings(parsed.closedTools),
    trustedLinks,
    permissions,
  };
  return cached;
}

function write(next: McpAppPreferences): void {
  cached = next;
  try {
    storage()?.setItem(MCP_APP_PREFERENCES_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Preferences stay for this session when storage is unavailable.
  }
  for (const listener of listeners) listener();
}

/** Short, stable hash so raw connector ids are not stored in the hidden list (Claude: base 36). */
export function hashMcpAppKey(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function withRecent(list: readonly string[], entry: string, add: boolean, max: number): string[] {
  const without = list.filter((item) => item !== entry);
  if (!add) return without;
  return [...without, entry].slice(-max);
}

export function isMcpAppConnectorHidden(serverKey: string): boolean {
  return read().hiddenConnectors.includes(hashMcpAppKey(serverKey));
}

export function setMcpAppConnectorHidden(serverKey: string, hidden: boolean): void {
  const current = read();
  write({
    ...current,
    hiddenConnectors: withRecent(
      current.hiddenConnectors,
      hashMcpAppKey(serverKey),
      hidden,
      MCP_APP_HIDDEN_CONNECTORS_MAX,
    ),
  });
}

export function isMcpAppToolClosed(toolName: string): boolean {
  return read().closedTools.includes(toolName);
}

export function setMcpAppToolClosed(toolName: string, closed: boolean): void {
  const current = read();
  write({
    ...current,
    closedTools: withRecent(current.closedTools, toolName, closed, MCP_APP_CLOSED_TOOLS_MAX),
  });
}

export function isMcpAppLinkTrusted(serverKey: string, domain: string): boolean {
  return read().trustedLinks[serverKey]?.includes(domain) ?? false;
}

export function trustMcpAppLink(serverKey: string, domain: string): void {
  const current = read();
  const existing = current.trustedLinks[serverKey] ?? [];
  if (existing.includes(domain)) return;
  write({
    ...current,
    trustedLinks: { ...current.trustedLinks, [serverKey]: [...existing, domain].slice(-100) },
  });
}

export function readMcpAppPermissionDecision(
  serverKey: string,
): McpAppPermissions | "denied" | null {
  return read().permissions[serverKey] ?? null;
}

export function writeMcpAppPermissionDecision(
  serverKey: string,
  decision: McpAppPermissions | "denied",
): void {
  const current = read();
  write({ ...current, permissions: { ...current.permissions, [serverKey]: decision } });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== MCP_APP_PREFERENCES_STORAGE_KEY) return;
    cached = null;
    listener();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

export function useMcpAppPreferences(): McpAppPreferences {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}

export function resetMcpAppPreferencesForTests(): void {
  cached = null;
  try {
    storage()?.removeItem(MCP_APP_PREFERENCES_STORAGE_KEY);
  } catch {
    // ignore
  }
  for (const listener of listeners) listener();
}
