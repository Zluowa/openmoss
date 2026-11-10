// FILE: transportLink.ts
// Purpose: Single answer to "what does this renderer's socket connect to?", plus the
//          outage timings that follow from it, so callers never guess from a URL.
// Layer: Web transport policy
// Exports: readDesktopBackendWsUrl, resolveTransportLink, transportNoticeHoldMs,
//          transportReconnectMaxDelayMs, reportDesktopBackendLink

import type { DesktopBackendLinkEvent } from "@moss/contracts";

import type { ComposerTransportNoticeKind } from "./composerTransportStatus";

/**
 * "desktop-backend": the desktop main process spawned and supervises this backend, so a
 * drop is a restart it is already handling. "network": anything else, where a real
 * network can drop and nobody else is watching.
 */
export type TransportLink = "desktop-backend" | "network";

/**
 * The bridge exists only under the desktop preload, and main answers it solely from the
 * endpoint it reserved for the child it spawned. The transport takes its URL from here
 * first, so this is the same fact that decides where the socket connects. A future
 * desktop mode that connects anywhere else must stop answering through this bridge.
 */
export function readDesktopBackendWsUrl(): string | null {
  if (typeof window === "undefined") return null;
  const url = window.desktopBridge?.getWsUrl?.();
  return typeof url === "string" && url.length > 0 ? url : null;
}

/** An explicit URL always wins in the transport, so it is never the supervised backend. */
export function resolveTransportLink(explicitUrl: string | null = null): TransportLink {
  return explicitUrl === null && readDesktopBackendWsUrl() !== null ? "desktop-backend" : "network";
}

/** A real restart took about 3 s on the Windows package, from child exit to socket open. */
const DESKTOP_BACKEND_NOTICE_HOLD_MS = 10_000;
const NETWORK_NOTICE_HOLD_MS = 1_500;

/**
 * How long the composer stays quiet about a notice. Only automatic recovery earns the
 * longer hold: an incompatible or disposed transport will not recover by waiting.
 */
export function transportNoticeHoldMs(
  notice: ComposerTransportNoticeKind,
  link: TransportLink = resolveTransportLink(),
): number {
  const recovering = notice === "connecting" || notice === "reconnecting";
  return recovering && link === "desktop-backend"
    ? DESKTOP_BACKEND_NOTICE_HOLD_MS
    : NETWORK_NOTICE_HOLD_MS;
}

/** A refused loopback connect costs nothing, so retry often enough to meet the restart. */
const DESKTOP_BACKEND_RECONNECT_MAX_DELAY_MS = 500;
const NETWORK_RECONNECT_MAX_DELAY_MS = 5_000;

export function transportReconnectMaxDelayMs(link: TransportLink = resolveTransportLink()): number {
  return link === "desktop-backend"
    ? DESKTOP_BACKEND_RECONNECT_MAX_DELAY_MS
    : NETWORK_RECONNECT_MAX_DELAY_MS;
}

/** Diagnostics only: a failed report must never disturb the transport. */
export function reportDesktopBackendLink(event: DesktopBackendLinkEvent): void {
  try {
    window.desktopBridge?.reportBackendLink?.(event);
  } catch {
    // Best effort.
  }
}
