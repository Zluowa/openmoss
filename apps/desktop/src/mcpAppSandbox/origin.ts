// FILE: origin.ts
// Purpose: Decide which sandbox origin (label) a widget gets.
// Layer: Electron main-process support (pure).
//
// Default: one origin per thread x server, like the Code tab of the reference
// host (`sha256(session + "\0" + server)[:32]`). Stable-origin variant: one
// origin per connector URL, only for resources that declare `_meta.ui.domain`
// on a Moss connector whose URL is known. Local/CLI servers never get it.

import * as Crypto from "node:crypto";

export type McpAppSandboxVariant = "isolated" | "stable";

export interface McpAppSandboxOrigin {
  readonly label: string;
  readonly variant: McpAppSandboxVariant;
}

const LABEL_LENGTH = 32;

function sha256Label(value: string): string {
  return Crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, LABEL_LENGTH);
}

/** `sha256(threadId + "\0" + serverKey).hex[:32]`. */
export function mcpAppSandboxThreadLabel(threadId: string, serverKey: string): string {
  return sha256Label(`${threadId}\u0000${serverKey}`);
}

const CONNECTOR_URL_PATTERN = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(?:#.*)?$/isu;

/**
 * Connector URL normalisation: lower-case scheme and host, drop the default
 * port (80/443), drop the fragment, and drop a lone `/` path (also before
 * `?`). Everything else (user info, path, query) is kept byte for byte.
 * Returns null for anything that is not an absolute http(s) URL.
 */
export function normalizeMcpAppConnectorUrl(url: string): string | null {
  const match = CONNECTOR_URL_PATTERN.exec(url);
  if (!match) return null;
  const scheme = (match[1] ?? "").toLowerCase();
  if (scheme !== "http" && scheme !== "https") return null;
  const authority = match[2] ?? "";
  const at = authority.lastIndexOf("@");
  const userInfo = at >= 0 ? authority.slice(0, at + 1) : "";
  let hostPort = at >= 0 ? authority.slice(at + 1) : authority;
  let port = "";
  const portMatch = /:(\d*)$/u.exec(hostPort);
  // An IPv6 literal ends with "]" and keeps its inner colons.
  if (portMatch && !hostPort.endsWith("]")) {
    port = portMatch[1] ?? "";
    hostPort = hostPort.slice(0, portMatch.index);
  }
  const host = hostPort.toLowerCase();
  if (host.length === 0) return null;
  const defaultPort = scheme === "https" ? "443" : "80";
  const portPart = port === "" || port === defaultPort ? "" : `:${port}`;
  const rawPath = match[3] ?? "";
  const path = rawPath === "/" ? "" : rawPath;
  const query = match[4] ?? "";
  return `${scheme}://${userInfo}${host}${portPart}${path}${query}`;
}

/** `sha256(normalised connector URL).hex[:32]`, or null when the URL is unusable. */
export function mcpAppSandboxConnectorLabel(connectorUrl: string): string | null {
  const normalized = normalizeMcpAppConnectorUrl(connectorUrl);
  return normalized === null ? null : sha256Label(normalized);
}

/**
 * A hostname made only of decimal digits would be parsed as an IPv4 number by
 * the URL parser (standard schemes), so it cannot be a host. The chance for a
 * 32-hex label is about 3e-7; such a label fails closed.
 */
export function isUsableMcpAppSandboxLabel(label: string): boolean {
  return /^[0-9a-f]{32}$/u.test(label) && !/^[0-9]+$/u.test(label);
}

export function resolveMcpAppSandboxOrigin(input: {
  readonly threadId: string;
  readonly server: string;
  readonly serverKey?: string | undefined;
  readonly stableOrigin?: boolean | undefined;
  readonly connectorUrl?: string | undefined;
}): McpAppSandboxOrigin {
  if (input.stableOrigin === true && input.connectorUrl) {
    const label = mcpAppSandboxConnectorLabel(input.connectorUrl);
    if (label !== null) return { label, variant: "stable" };
  }
  return {
    label: mcpAppSandboxThreadLabel(input.threadId, input.serverKey ?? input.server),
    variant: "isolated",
  };
}
