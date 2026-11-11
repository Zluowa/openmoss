// FILE: policy.ts
// Purpose: Pure admission and security decisions for an isolated MCP App guest.

import {
  MCP_APP_SANDBOX_PATH,
  MCP_APP_SANDBOX_SCHEME,
  type McpAppSandboxDescriptor,
} from "@moss/contracts";

import type { McpAppSandboxEffectivePolicy } from "./csp";
import { isMcpAppSandboxAssetUrl } from "./protocol";

export const MCP_APP_SANDBOX_WEB_PREFERENCES = {
  allowRunningInsecureContent: false,
  contextIsolation: true,
  disableDialogs: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  plugins: false,
  sandbox: true,
  webSecurity: true,
  webviewTag: false,
} as const;

export function hardenedMcpAppWebPreferences(preload: string): Record<string, unknown> {
  return { ...MCP_APP_SANDBOX_WEB_PREFERENCES, preload };
}

export function isMcpAppSandboxPartition(
  partition: unknown,
  sandboxId?: string,
): partition is string {
  if (typeof partition !== "string" || partition.length === 0 || partition.startsWith("persist:")) {
    return false;
  }
  if (partition === "persist:moss-browser" || !partition.startsWith("moss-mcp-")) return false;
  return sandboxId === undefined || partition === `moss-mcp-${sandboxId}`;
}

export function isExactMcpAppSandboxUrl(
  url: unknown,
  descriptor: McpAppSandboxDescriptor,
): boolean {
  if (typeof url !== "string" || url !== descriptor.src) return false;
  try {
    const parsed = new URL(url);
    const keys = [...parsed.searchParams.keys()];
    return (
      parsed.protocol === `${MCP_APP_SANDBOX_SCHEME}:` &&
      `${parsed.protocol}//${parsed.host}` === descriptor.origin &&
      parsed.hostname === descriptor.sandboxId &&
      parsed.pathname === MCP_APP_SANDBOX_PATH &&
      keys.length === 2 &&
      keys[0] === "generation" &&
      keys[1] === "route" &&
      parsed.searchParams.get("generation") === String(descriptor.generation) &&
      /^[0-9a-f]{16}$/u.test(parsed.searchParams.get("route") ?? "") &&
      parsed.hash === `#init=${encodeURIComponent(descriptor.initId)}` &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.port === ""
    );
  } catch {
    return false;
  }
}

function domainMatches(url: URL, source: string): boolean {
  try {
    const allowed = new URL(source);
    if (allowed.protocol !== url.protocol) return false;
    const allowedHost = allowed.hostname.toLowerCase();
    const actualHost = url.hostname.toLowerCase();
    const hostMatch = allowedHost.startsWith("*.")
      ? actualHost.endsWith(allowedHost.slice(1)) && actualHost !== allowedHost.slice(2)
      : actualHost === allowedHost;
    return (
      hostMatch && (allowed.port.length > 0 ? allowed.port === url.port : url.port.length === 0)
    );
  } catch {
    return false;
  }
}

export type McpAppCspDirective = "connect-src" | "frame-src" | "resource";

/**
 * Main-process mirror of the proxy page's CSP for requests that reach the
 * network stack. `data:`/`blob:`/`about:` never get here; the sandbox origin
 * itself is never a widget destination (only its exact asset URLs are).
 */
export function isAllowedMcpAppNetworkUrl(
  value: unknown,
  directive: McpAppCspDirective,
  policy: Pick<McpAppSandboxEffectivePolicy, "connectDomains" | "frameDomains" | "resourceDomains">,
): boolean {
  if (typeof value !== "string") return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === `${MCP_APP_SANDBOX_SCHEME}:`) {
    return directive === "resource" && isMcpAppSandboxAssetUrl(value);
  }
  const sources =
    directive === "connect-src"
      ? policy.connectDomains
      : directive === "frame-src"
        ? policy.frameDomains
        : policy.resourceDomains;
  return sources.some((source) => domainMatches(url, source));
}

/**
 * Sub-frame navigations a widget may make: its own srcdoc, blank/data/blob
 * documents (they inherit the proxy's policy), and the allowed frame sites.
 */
export function isAllowedMcpAppSubframeUrl(
  value: unknown,
  policy: Pick<McpAppSandboxEffectivePolicy, "connectDomains" | "frameDomains" | "resourceDomains">,
): boolean {
  if (typeof value !== "string") return false;
  if (value === "about:blank" || value === "about:srcdoc") return true;
  if (/^(?:data|blob):/iu.test(value)) return true;
  return isAllowedMcpAppNetworkUrl(value, "frame-src", policy);
}

export function normalizeMcpAppUserAgent(userAgent: unknown): string {
  if (typeof userAgent !== "string" || userAgent.length === 0) return "Mozilla/5.0";
  const normalized = userAgent
    .replace(/\s+Electron\/[^\s)]+/giu, "")
    .replace(/\s+Moss\/[^\s)]+/giu, "")
    .replace(/\s{2,}/gu, " ")
    .trim();
  return normalized.length > 512 ? normalized.slice(0, 512) : normalized;
}

export const MCP_APP_DENY_POPUPS = true;
export const MCP_APP_DENY_DOWNLOADS = true;
export const MCP_APP_DENY_PERMISSIONS = true;
