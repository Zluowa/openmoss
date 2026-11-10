// FILE: frameServing.ts
// Purpose: How an 应用页 is served: its own origin, the response headers and
// the strict Content-Security-Policy around the page's HTML.
// Layer: Server pages/apps

import {
  PAGE_APP_CONTENT_PATH,
  PAGE_APP_FALLBACK_CONTENT_PATH,
  PAGE_APP_HOST_SUFFIX,
} from "@moss/contracts";

import {
  pageAppContentSecurityPolicy,
  PAGE_APP_PERMISSIONS_POLICY,
} from "@moss/shared/pageAppContentPolicy";
export {
  PAGE_APP_LIBRARY_HOSTS,
  pageAppContentSecurityPolicy,
} from "@moss/shared/pageAppContentPolicy";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK.has(hostname.toLowerCase());
}

/** `<appId>.moss-app.localhost` — a DNS label, so ids are lowercase UUIDs. */
export function pageAppHostname(appId: string): string | null {
  const label = appId.toLowerCase();
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)
    ? `${label}.${PAGE_APP_HOST_SUFFIX}`
    : null;
}

/** Recovers the app id from a request Host header, or null for any other host. */
export function pageAppIdFromHost(host: string | undefined): string | null {
  if (!host) return null;
  const hostname = host.replace(/:\d+$/u, "").toLowerCase();
  const suffix = `.${PAGE_APP_HOST_SUFFIX}`;
  if (!hostname.endsWith(suffix)) return null;
  const label = hostname.slice(0, -suffix.length);
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label) ? label : null;
}

export function isPageAppHost(host: string | undefined): boolean {
  if (!host) return false;
  return host.replace(/:\d+$/u, "").toLowerCase().endsWith(`.${PAGE_APP_HOST_SUFFIX}`);
}

/**
 * Where the shell should load a page. On a loopback server the page gets its
 * own `*.localhost` origin (storage works, per page). Anywhere else the
 * response carries a CSP `sandbox` and the page runs on an opaque origin.
 */
export function pageAppFrameLocation(input: {
  readonly serverUrl: URL;
  readonly appId: string;
  readonly token: string;
}): { readonly frameUrl: string; readonly frameOrigin: string; readonly ownOrigin: boolean } {
  const query = `?t=${encodeURIComponent(input.token)}`;
  const hostname = pageAppHostname(input.appId);
  if (
    hostname &&
    isLoopbackHostname(input.serverUrl.hostname) &&
    input.serverUrl.protocol === "http:"
  ) {
    const port = input.serverUrl.port ? `:${input.serverUrl.port}` : "";
    const origin = `http://${hostname}${port}`;
    return {
      frameUrl: `${origin}${PAGE_APP_CONTENT_PATH}${query}`,
      frameOrigin: origin,
      ownOrigin: true,
    };
  }
  return {
    frameUrl: `${input.serverUrl.origin}${PAGE_APP_FALLBACK_CONTENT_PATH}${query}`,
    frameOrigin: "null",
    ownOrigin: false,
  };
}

export function pageAppFrameHeaders(input: {
  readonly parentOrigin: string;
  readonly opaque: boolean;
}): Record<string, string> {
  return {
    "Content-Security-Policy": pageAppContentSecurityPolicy(input),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": PAGE_APP_PERMISSIONS_POLICY,
  };
}

/** Shown in place of the page when its link is stale or wrong. */
export function pageAppErrorHtml(message: string): string {
  const escaped = message.replace(/[&<>"']/gu, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;display:grid;place-items:center;min-height:100vh;font:13px/1.5 system-ui,sans-serif;color:#6b6b6b;background:transparent}
</style></head><body><p>${escaped}</p></body></html>`;
}
