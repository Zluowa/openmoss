// FILE: csp.ts
// Purpose: Revalidate normalized MCP resource domains and build restrictive
// response headers for the Moss-owned sandbox shell.

import type { McpAppResourceCsp } from "@synara/contracts";

const MAX_DOMAIN_ENTRIES = 32;
const MAX_DOMAIN_CHARS = 2_000;
const MAX_HEADER_CHARS = 64_000;

export interface McpAppSandboxCspHeaders {
  readonly "Cache-Control": "no-store";
  readonly "Content-Security-Policy": string;
  readonly "Permissions-Policy": "camera=(), microphone=(), geolocation=(), usb=(), clipboard-read=(), clipboard-write=()";
  readonly "X-Content-Type-Options": "nosniff";
}

export interface McpAppSandboxCspResult {
  readonly headers: McpAppSandboxCspHeaders;
  readonly csp: string;
}

export interface McpAppSandboxCspOptions {
  /** The fixed outer shell cannot be embedded; only the inner route is self-embeddable. */
  readonly frameAncestors?: "'none'" | "'self'";
}

function validDomain(value: unknown, allowWebSocket: boolean): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_DOMAIN_CHARS) {
    return false;
  }
  if (value !== value.trim() || /[\p{Cc}\s;,"']/u.test(value)) return false;
  if (value === "blob:" || value === "data:") return true;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password || parsed.hostname.length === 0) return false;
  if (parsed.protocol !== "https:" && !(allowWebSocket && parsed.protocol === "wss:")) {
    return false;
  }
  if (parsed.hostname.includes("*") && !parsed.hostname.startsWith("*.")) return false;
  return parsed.hostname === parsed.hostname.toLowerCase();
}

function normalizedList(value: readonly string[], allowWebSocket: boolean): string[] | null {
  if (value.length > MAX_DOMAIN_ENTRIES) return null;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!validDomain(entry, allowWebSocket)) return null;
    if (!seen.has(entry)) {
      seen.add(entry);
      result.push(entry);
    }
  }
  return result;
}

function joinSources(sources: readonly string[]): string {
  return sources.length > 0 ? sources.join(" ") : "'none'";
}

/**
 * Build a header without accepting arbitrary directive text. CSP input is
 * metadata, never a caller-provided header string.
 */
export function buildMcpAppSandboxCsp(
  input: McpAppResourceCsp,
  options: McpAppSandboxCspOptions = {},
): McpAppSandboxCspResult | null {
  const baseUriDomains = normalizedList(input.baseUriDomains, false);
  const connectDomains = normalizedList([...input.connectDomains, ...input.resourceDomains], true);
  const frameDomains = normalizedList(input.frameDomains, false);
  const resourceDomains = normalizedList(input.resourceDomains, false);
  if (!baseUriDomains || !connectDomains || !frameDomains || !resourceDomains) return null;

  // B5.4c1 records includeDefaultDomains/isTrusted as provenance metadata.
  // Resource domains participate in connect-src as well as the resource
  // directives, while neither flag may broaden this response allowlist.

  // The served outer document is a fixed Moss-owned shell. Its bootstrap is
  // inline so the shell never needs a second mutable asset or a file path.
  const scriptSources = ["'self'", "'unsafe-inline'", ...resourceDomains];
  const styleSources = ["'self'", "'unsafe-inline'", ...resourceDomains];
  const imageSources = ["'self'", "data:", "blob:", ...resourceDomains];
  const mediaSources = ["'self'", "blob:", ...resourceDomains];
  const frameSources = ["'self'", ...frameDomains];
  const directives = [
    "default-src 'none'",
    `base-uri ${joinSources(baseUriDomains)}`,
    `connect-src ${joinSources(connectDomains)}`,
    `font-src ${joinSources(["'self'", "data:", ...resourceDomains])}`,
    `frame-src ${joinSources(frameSources)}`,
    `img-src ${joinSources(imageSources)}`,
    `media-src ${joinSources(mediaSources)}`,
    `script-src ${joinSources(scriptSources)}`,
    `style-src ${joinSources(styleSources)}`,
    "child-src 'none'",
    "form-action 'none'",
    `frame-ancestors ${options.frameAncestors ?? "'none'"}`,
    "manifest-src 'none'",
    "object-src 'none'",
    `worker-src ${joinSources(["'self'", "blob:", ...resourceDomains])}`,
  ];
  const csp = directives.join("; ");
  if (csp.length > MAX_HEADER_CHARS || /[\r\n]/u.test(csp)) return null;
  return {
    csp,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": csp,
      "Permissions-Policy":
        "camera=(), microphone=(), geolocation=(), usb=(), clipboard-read=(), clipboard-write=()",
      "X-Content-Type-Options": "nosniff",
    },
  };
}
