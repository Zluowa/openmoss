// FILE: realtimeVoiceMediaRequestPolicy.ts
// Purpose: Applies the narrow Electron compatibility policy for ticketed CN Realtime media.
// Layer: Desktop main-process request policy

import { normalizePermissionOrigin } from "./mediaPermissions";

const REALTIME_MEDIA_PATH = "/v1/realtime/media";
const REALTIME_MEDIA_PROTOCOL = "moss-realtime-pcm16-v1";
const REALTIME_MEDIA_TICKET_PATTERN = /^moss-ticket\.[A-Za-z0-9_-]{43}$/u;
const PACKAGED_RENDERER_ORIGINS = new Set(["moss://app", "moss-canary://app"]);

export interface RealtimeVoiceMediaRequestDetails {
  readonly method: string;
  readonly resourceType: string;
  readonly url: string;
  readonly requestHeaders: Record<string, string>;
}

export type RealtimeVoiceMediaRequestPolicy = (
  details: RealtimeVoiceMediaRequestDetails,
) => Record<string, string>;

function resolveRealtimeMediaUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.pathname !== "/" ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0 ||
      parsed.port.length > 0 ||
      (value !== parsed.origin && value !== `${parsed.origin}/`)
    ) {
      return null;
    }

    const mediaUrl = new URL(REALTIME_MEDIA_PATH, parsed.origin);
    mediaUrl.protocol = "wss:";
    return mediaUrl.href;
  } catch {
    return null;
  }
}

function resolveTrustedRendererOrigin(value: unknown): string | null {
  const origin = normalizePermissionOrigin(value);
  if (origin === null) {
    return null;
  }
  if (PACKAGED_RENDERER_ORIGINS.has(origin)) {
    return origin;
  }

  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:") {
      return null;
    }
    return parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]"
      ? origin
      : null;
  } catch {
    return null;
  }
}

function readSingleHeader(headers: Readonly<Record<string, string>>, name: string): string | null {
  const lowerName = name.toLowerCase();
  const matches = Object.entries(headers).filter(
    ([headerName]) => headerName.toLowerCase() === lowerName,
  );
  return matches.length === 1 ? (matches[0]?.[1] ?? null) : null;
}

function hasHeader(headers: Readonly<Record<string, string>>, name: string): boolean {
  const lowerName = name.toLowerCase();
  return Object.keys(headers).some((headerName) => headerName.toLowerCase() === lowerName);
}

function isExactTrustedOrigin(value: string, trustedOrigin: string): boolean {
  if (normalizePermissionOrigin(value) !== trustedOrigin) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      (parsed.pathname === "" || parsed.pathname === "/") &&
      parsed.search.length === 0 &&
      parsed.hash.length === 0
    );
  } catch {
    return false;
  }
}

function hasExactTicketedMediaProtocols(value: string): boolean {
  const protocols = value.split(",").map((protocol) => protocol.trim());
  return (
    protocols.length === 2 &&
    protocols[0] === REALTIME_MEDIA_PROTOCOL &&
    REALTIME_MEDIA_TICKET_PATTERN.test(protocols[1] ?? "")
  );
}

function removeHeaderCaseInsensitive(
  headers: Readonly<Record<string, string>>,
  name: string,
): Record<string, string> {
  const lowerName = name.toLowerCase();
  return Object.fromEntries(
    Object.entries(headers).filter(([headerName]) => headerName.toLowerCase() !== lowerName),
  );
}

/**
 * Old CN relay deployments reject Chromium's loopback/custom-scheme Origin before they consume
 * the one-time media ticket. Electron may omit that header only for the exact Moss renderer,
 * relay URL, and media path. The subprotocol pair and ticket shape are checked whenever Electron
 * exposes that header here; Chromium and the relay still validate them on the wire either way.
 */
export function createRealtimeVoiceMediaRequestPolicy(input: {
  readonly realtimeRelayUrl: unknown;
  readonly trustedRendererUrl: unknown;
}): RealtimeVoiceMediaRequestPolicy | null {
  const expectedMediaUrl = resolveRealtimeMediaUrl(input.realtimeRelayUrl);
  const trustedRendererOrigin = resolveTrustedRendererOrigin(input.trustedRendererUrl);
  if (expectedMediaUrl === null || trustedRendererOrigin === null) {
    return null;
  }

  return (details) => {
    const origin = readSingleHeader(details.requestHeaders, "origin");
    const protocols = readSingleHeader(details.requestHeaders, "sec-websocket-protocol");
    // Electron 43 omits Sec-WebSocket-Protocol from onBeforeSendHeaders even though Chromium
    // sends it on the wire. When it is visible, keep validating the exact pair. When it is not,
    // the exact trusted renderer/relay/path boundary below is still fail-closed and the relay
    // atomically consumes the 256-bit one-time ticket before opening media.
    const protocolsAreValid =
      protocols === null
        ? !hasHeader(details.requestHeaders, "sec-websocket-protocol")
        : hasExactTicketedMediaProtocols(protocols);
    if (
      details.method !== "GET" ||
      details.resourceType !== "webSocket" ||
      details.url !== expectedMediaUrl ||
      origin === null ||
      !isExactTrustedOrigin(origin, trustedRendererOrigin) ||
      !protocolsAreValid
    ) {
      return details.requestHeaders;
    }

    return removeHeaderCaseInsensitive(details.requestHeaders, "origin");
  };
}
