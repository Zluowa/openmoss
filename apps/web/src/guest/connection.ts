// FILE: connection.ts
// Purpose: Keeps the guest stream open: reconnects with backoff, tells an offline owner apart
//          from an ended share, and stops for good on `ended`.
// Layer: Guest page
// Why: Phones drop connections constantly (backgrounding, WeChat, cell handoffs) and Cloudflare
//      closes idle streams, so the page owns reconnection instead of EventSource's blind retry.

import type { GuestShareEndReason, GuestStreamEvent } from "./protocol";
import type { GuestFailure, GuestTransport } from "./transport";

export type GuestConnectionStatus =
  | { readonly kind: "connecting" }
  | { readonly kind: "live" }
  /** The link dropped; retrying. */
  | { readonly kind: "reconnecting"; readonly attempt: number }
  /** The owner's Moss is not connected to the relay; retrying. */
  | { readonly kind: "offline"; readonly attempt: number }
  | { readonly kind: "ended"; readonly reason: GuestShareEndReason }
  /** The session no longer opens the share (or the owner needs an update). Final. */
  | { readonly kind: "lost"; readonly failure: GuestFailure };

export const RECONNECT_MIN_DELAY_MS = 1_000;
export const RECONNECT_MAX_DELAY_MS = 15_000;

/** 1 s doubling to 15 s, with ±25 % jitter so reconnecting guests do not arrive together. */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_MIN_DELAY_MS * 2 ** attempt);
  return Math.round(base * (0.75 + random() * 0.5));
}

export interface GuestConnectionTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface GuestConnectionOptions {
  readonly transport: GuestTransport;
  readonly onEvent: (event: GuestStreamEvent) => void;
  readonly onStatus: (status: GuestConnectionStatus) => void;
  readonly timers?: GuestConnectionTimers;
  readonly random?: () => number;
}

export interface GuestConnection {
  /** Skips the pending backoff, e.g. when the tab comes back or the network returns. */
  retryNow(): void;
  stop(): void;
}

// 410: the relay remembers the share ended (stopped, replaced, or expired).
const isFinalFailure = (failure: GuestFailure): boolean =>
  failure.kind === "http" &&
  (failure.status === 403 || failure.status === 410 || failure.status === 426);

// 404: the relay does not know the share. A relay restart forgets shares until their owners
// register again, which takes seconds, so a few probes wait it out before the page gives up.
const isUnknownShare = (failure: GuestFailure): boolean =>
  failure.kind === "http" && failure.status === 404;
const UNKNOWN_SHARE_PROBE_LIMIT = 6;

const isOwnerOffline = (failure: GuestFailure): boolean =>
  failure.kind === "http" && (failure.reason === "owner_offline" || failure.status === 503);

export function startGuestConnection(options: GuestConnectionOptions): GuestConnection {
  const { transport, onEvent, onStatus } = options;
  const timers: GuestConnectionTimers = options.timers ?? {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const random = options.random ?? Math.random;

  let stopped = false;
  let attempt = 0;
  let closeStream: (() => void) | null = null;
  let timer: unknown = null;
  let probing = false;
  let everConnected = false;
  let unknownShareProbes = 0;

  const clearTimer = () => {
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
  };

  const finish = (status: GuestConnectionStatus) => {
    stopped = true;
    clearTimer();
    closeStream?.();
    closeStream = null;
    onStatus(status);
  };

  const schedule = (status: GuestConnectionStatus) => {
    if (stopped) return;
    onStatus(status);
    clearTimer();
    timer = timers.setTimeout(connect, reconnectDelayMs(attempt, random));
    attempt += 1;
  };

  const probe = async () => {
    if (stopped || probing) return;
    probing = true;
    const result = await transport.probeSession();
    probing = false;
    if (stopped) return;
    if (!result.ok && isUnknownShare(result.failure)) unknownShareProbes += 1;
    else unknownShareProbes = 0;
    if (result.ok) {
      schedule({ kind: "reconnecting", attempt });
    } else if (isFinalFailure(result.failure) || unknownShareProbes >= UNKNOWN_SHARE_PROBE_LIMIT) {
      finish({ kind: "lost", failure: result.failure });
    } else if (isOwnerOffline(result.failure) || isUnknownShare(result.failure)) {
      schedule({ kind: "offline", attempt });
    } else {
      schedule({ kind: "reconnecting", attempt });
    }
  };

  function connect() {
    if (stopped) return;
    clearTimer();
    closeStream?.();
    // Only the first attempt announces itself; a retry keeps the banner it was scheduled
    // with ("owner offline" must not flip to "reconnecting" while the attempt runs).
    if (!everConnected) {
      everConnected = true;
      onStatus({ kind: "connecting" });
    }
    closeStream = transport.openStream({
      onEvent(event) {
        if (stopped) return;
        if (event.type === "thread" && event.item.kind === "snapshot") {
          attempt = 0;
          onStatus({ kind: "live" });
        }
        onEvent(event);
        if (event.type === "ended") finish({ kind: "ended", reason: event.reason });
      },
      onError() {
        if (stopped) return;
        closeStream = null;
        void probe();
      },
    });
  }

  connect();

  return {
    retryNow() {
      if (stopped || timer === null) return;
      attempt = 0;
      connect();
    },
    stop() {
      stopped = true;
      clearTimer();
      closeStream?.();
      closeStream = null;
    },
  };
}
