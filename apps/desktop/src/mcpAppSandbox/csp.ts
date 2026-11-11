// FILE: csp.ts
// Purpose: Turn a resource's `_meta.ui.csp` into the sandbox's effective network
// policy and the response headers of the Moss proxy page.
// Layer: Electron main-process support (pure).
//
// Directive mapping follows the reference host's proxy: resourceDomains feed
// script/style/img/font/media/worker-src, connectDomains feed connect-src,
// frameDomains (after the site rules) feed frame-src, baseUriDomains are ignored
// (`base-uri 'self'`), and the sandbox's own asset origin is always a resource
// source. The same effective lists drive the main-process webRequest check.

import {
  MCP_APP_SANDBOX_ASSET_ORIGIN,
  type McpAppResourceCsp,
  type McpAppSandboxPermissionKey,
  type McpAppSandboxPermissions,
} from "@moss/contracts";

import { filterMcpAppFrameSites } from "./frameSites";

const MAX_DOMAIN_ENTRIES = 32;
const MAX_DOMAIN_CHARS = 2_000;
const MAX_HEADER_CHARS = 64_000;

export interface McpAppSandboxEffectivePolicy {
  readonly resourceDomains: readonly string[];
  readonly connectDomains: readonly string[];
  /** Frame sites that passed the site rules. */
  readonly frameDomains: readonly string[];
  readonly refusedFrameDomains: readonly string[];
  /** Declared permissions that may be granted (none once any frame site is allowed). */
  readonly permissions: McpAppSandboxPermissions;
  readonly withholdDevicePermissions: boolean;
}

export interface McpAppSandboxCspHeaders {
  readonly "Cache-Control": "no-store";
  readonly "Content-Security-Policy": string;
  readonly "Cross-Origin-Opener-Policy": "same-origin";
  readonly "Permissions-Policy": string;
  readonly "X-Content-Type-Options": "nosniff";
}

export interface McpAppSandboxCspResult {
  readonly headers: McpAppSandboxCspHeaders;
  readonly csp: string;
}

function validDomain(value: unknown, allowWebSocket: boolean): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_DOMAIN_CHARS) {
    return false;
  }
  if (value !== value.trim() || /[\p{Cc}\s;,"']/u.test(value)) return false;
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
  for (const entry of value) {
    if (!validDomain(entry, allowWebSocket)) return null;
    if (!result.includes(entry)) result.push(entry);
  }
  return result;
}

const DEVICE_PERMISSION_KEYS: readonly McpAppSandboxPermissionKey[] = [
  "camera",
  "microphone",
  "geolocation",
  "clipboardWrite",
];

/**
 * Revalidate the declared lists (fail closed on any malformed entry) and apply
 * the frame-site rules. Any allowed frame site withholds every device
 * permission, like the reference host.
 */
export function buildMcpAppSandboxPolicy(
  csp: McpAppResourceCsp,
  declaredPermissions: McpAppSandboxPermissions = {},
): McpAppSandboxEffectivePolicy | null {
  const resourceDomains = normalizedList(csp.resourceDomains, false);
  const connectDomains = normalizedList(csp.connectDomains, true);
  const declaredFrames = normalizedList(csp.frameDomains, false);
  // baseUriDomains are validated for shape but never used (`base-uri 'self'`).
  const baseUriDomains = normalizedList(csp.baseUriDomains, false);
  if (!resourceDomains || !connectDomains || !declaredFrames || !baseUriDomains) return null;
  const frames = filterMcpAppFrameSites(declaredFrames);
  const withholdDevicePermissions = frames.accepted.length > 0;
  const permissions: Partial<Record<McpAppSandboxPermissionKey, boolean>> = {};
  if (!withholdDevicePermissions) {
    for (const key of DEVICE_PERMISSION_KEYS) {
      if (declaredPermissions[key] === true) permissions[key] = true;
    }
  }
  return {
    resourceDomains,
    connectDomains,
    frameDomains: frames.accepted,
    refusedFrameDomains: frames.refused,
    permissions,
    withholdDevicePermissions,
  };
}

const PERMISSION_POLICY_FEATURES: ReadonlyArray<readonly [McpAppSandboxPermissionKey, string]> = [
  ["camera", "camera"],
  ["microphone", "microphone"],
  ["geolocation", "geolocation"],
  ["clipboardWrite", "clipboard-write"],
];

/** Feature list for the inner frame's `allow` attribute (`"camera *; geolocation *"`). */
export function mcpAppSandboxAllowList(permissions: McpAppSandboxPermissions): string {
  return PERMISSION_POLICY_FEATURES.filter(([key]) => permissions[key] === true)
    .map(([, feature]) => `${feature} *`)
    .join("; ");
}

function permissionsPolicyHeader(policy: McpAppSandboxEffectivePolicy): string {
  const entries = PERMISSION_POLICY_FEATURES.map(
    ([key, feature]) => `${feature}=${policy.permissions[key] === true ? "*" : "()"}`,
  );
  entries.push("usb=()", "clipboard-read=()", "display-capture=()");
  if (policy.withholdDevicePermissions) entries.push("fullscreen=()", "picture-in-picture=()");
  return entries.join(", ");
}

/**
 * Response headers of the proxy page. The isolated widget (srcdoc) and the
 * stable one (document.write into about:blank) inherit this policy.
 */
export function buildMcpAppSandboxCsp(
  policy: McpAppSandboxEffectivePolicy,
): McpAppSandboxCspResult | null {
  const resources = [...policy.resourceDomains, MCP_APP_SANDBOX_ASSET_ORIGIN];
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: ${resources.join(" ")}`,
    `style-src 'self' 'unsafe-inline' ${resources.join(" ")}`,
    `img-src 'self' data: blob: ${resources.join(" ")}`,
    `font-src 'self' data: ${resources.join(" ")}`,
    `media-src 'self' blob: data: ${resources.join(" ")}`,
    `worker-src 'self' blob: ${resources.join(" ")}`,
    ["connect-src 'self' blob: data:", ...policy.connectDomains].join(" "),
    ["frame-src blob: data:", ...policy.frameDomains].join(" "),
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  const csp = directives.join("; ");
  if (csp.length > MAX_HEADER_CHARS || /[\r\n]/u.test(csp)) return null;
  return {
    csp,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": csp,
      "Cross-Origin-Opener-Policy": "same-origin",
      "Permissions-Policy": permissionsPolicyHeader(policy),
      "X-Content-Type-Options": "nosniff",
    },
  };
}
