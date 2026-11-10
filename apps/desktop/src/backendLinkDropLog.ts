// FILE: backendLinkDropLog.ts
// Purpose: Turns the renderer's link reports into one desktop-main.log line per drop, so the
//          real rate of drops and their lengths can be measured from a user's log.
// Layer: Desktop backend supervision
// Exports: BackendLinkDropLog

import type { DesktopBackendLinkDropReason, DesktopBackendLinkEvent } from "@moss/contracts";

const DROP_REASONS: ReadonlySet<DesktopBackendLinkDropReason> = new Set([
  "socket-closed",
  "silence-timeout",
  "protocol-error",
  "stream-ended",
]);

// The child's exit and the socket's close race; either can arrive first.
const BACKEND_EXIT_PAIRING_WINDOW_MS = 5_000;

function parseLinkEvent(input: unknown): DesktopBackendLinkEvent | null {
  if (typeof input !== "object" || input === null) return null;
  const { phase, reason } = input as { phase?: unknown; reason?: unknown };
  if (phase === "up") return { phase };
  return phase === "down" && DROP_REASONS.has(reason as DesktopBackendLinkDropReason)
    ? { phase, reason: reason as DesktopBackendLinkDropReason }
    : null;
}

/**
 * Main owns the clock and the single line, so a renderer that reloads mid-drop cannot lose
 * or double the record. Only fixed categories reach the log: reports are validated here and
 * the exit detail is `code=… signal=…`, never process output or a URL.
 */
export class BackendLinkDropLog {
  private drop: {
    readonly reason: DesktopBackendLinkDropReason;
    readonly startedAtMs: number;
  } | null = null;
  private backendExit: { readonly detail: string; readonly atMs: number } | null = null;

  constructor(
    private readonly writeLine: (line: string) => void,
    private readonly nowMs: () => number = () => performance.now(),
  ) {}

  receive(input: unknown): void {
    const event = parseLinkEvent(input);
    if (event === null) return;
    if (event.phase === "up") {
      this.finish("recovered");
    } else if (this.drop === null) {
      this.drop = { reason: event.reason, startedAtMs: this.nowMs() };
    }
  }

  recordBackendExit(detail: string): void {
    this.backendExit = { detail, atMs: this.nowMs() };
  }

  /** A drop that never recovers before quit still gets its line. */
  finish(outcome: "recovered" | "app-quit"): void {
    const drop = this.drop;
    if (drop === null) return;
    this.drop = null;
    const exit = this.backendExit;
    this.backendExit = null;
    const explained =
      exit !== null && exit.atMs >= drop.startedAtMs - BACKEND_EXIT_PAIRING_WINDOW_MS;
    const durationMs = Math.round(this.nowMs() - drop.startedAtMs);
    this.writeLine(
      `backend link drop reason=${drop.reason} backend=${explained ? `exited(${exit.detail})` : "running"} durationMs=${durationMs} outcome=${outcome}`,
    );
  }
}
