// FILE: policy.ts
// Purpose: Pure admission and security decisions for an isolated MCP App guest.

import {
  MCP_APP_SANDBOX_CONTENT_PATH,
  MCP_APP_SANDBOX_SCHEME,
  type McpAppResourceCsp,
  type McpAppSandboxDescriptor,
} from "@synara/contracts";

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
    return (
      parsed.protocol === `${MCP_APP_SANDBOX_SCHEME}:` &&
      `${parsed.protocol}//${parsed.host}` === descriptor.origin &&
      parsed.hostname === descriptor.sandboxId &&
      parsed.pathname === "/ui" &&
      parsed.searchParams.get("generation") === String(descriptor.generation) &&
      parsed.searchParams.has("init") === false &&
      parsed.hash === `#init=${encodeURIComponent(descriptor.initId)}` &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.port === ""
    );
  } catch {
    return false;
  }
}

/** Build the only same-origin subframe URL Moss may install for an App. */
export function mcpAppSandboxContentUrl(
  descriptor: Pick<McpAppSandboxDescriptor, "generation" | "initId" | "origin">,
): string {
  return `${descriptor.origin}${MCP_APP_SANDBOX_CONTENT_PATH}?generation=${encodeURIComponent(String(descriptor.generation))}&init=${encodeURIComponent(descriptor.initId)}`;
}

/**
 * The fixed inner route is a second authority, not a general custom-scheme
 * allowance. Keep this check string-exact so duplicate, reordered, or
 * differently encoded query fields cannot alias the current document.
 */
export function isExactMcpAppSandboxContentUrl(
  url: unknown,
  descriptor: Pick<McpAppSandboxDescriptor, "generation" | "initId" | "origin" | "sandboxId">,
): boolean {
  const expected = mcpAppSandboxContentUrl(descriptor);
  if (typeof url !== "string" || url !== expected) return false;
  try {
    const parsed = new URL(url);
    const keys = [...parsed.searchParams.keys()];
    return (
      parsed.protocol === `${MCP_APP_SANDBOX_SCHEME}:` &&
      `${parsed.protocol}//${parsed.host}` === descriptor.origin &&
      parsed.hostname === descriptor.sandboxId &&
      parsed.pathname === MCP_APP_SANDBOX_CONTENT_PATH &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.port === "" &&
      parsed.hash === "" &&
      keys.length === 2 &&
      keys[0] === "generation" &&
      keys[1] === "init" &&
      parsed.searchParams.getAll("generation").length === 1 &&
      parsed.searchParams.getAll("init").length === 1 &&
      parsed.searchParams.get("generation") === String(descriptor.generation) &&
      parsed.searchParams.get("init") === descriptor.initId
    );
  } catch {
    return false;
  }
}

function domainMatches(url: URL, source: string): boolean {
  if (source === "blob:" || source === "data:") return url.protocol === source.slice(0, -1) + ":";
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

export type McpAppCspDirective = "base-uri" | "connect-src" | "frame-src" | "resource";

export function isAllowedMcpAppNetworkUrl(
  value: unknown,
  directive: McpAppCspDirective,
  csp: McpAppResourceCsp,
  sandboxOrigin: string,
): boolean {
  if (typeof value !== "string") return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  // The dedicated shell is admitted separately as the main frame. A guest
  // subframe must never navigate back to the privileged shell origin.
  if (url.origin === sandboxOrigin && url.protocol === `${MCP_APP_SANDBOX_SCHEME}:`) return false;
  const sources =
    directive === "base-uri"
      ? csp.baseUriDomains
      : directive === "connect-src"
        ? [...new Set([...csp.connectDomains, ...csp.resourceDomains])]
        : directive === "frame-src"
          ? csp.frameDomains
          : csp.resourceDomains;
  return sources.some((source) => domainMatches(url, source));
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
