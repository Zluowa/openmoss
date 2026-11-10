// FILE: requestOutcome.ts
// Purpose: Tells a request the server refused from one whose outcome is unknown because
//          the connection went (timeout, reconnect) while it was in flight: the server may
//          have applied it, so callers must reconcile instead of treating it as refused.
// Layer: Web RPC helper
// Exports: isRequestOutcomeUnknown

/**
 * wsTransport's WsTransportRequestInterruptedError for a timeout or reconnect. A cancel is
 * the caller's own, and "not sent" means the deadline passed before a connection existed.
 */
export function isRequestOutcomeUnknown(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "WsTransportRequestInterruptedError" &&
    "code" in error &&
    error.code !== "WS_REQUEST_ABORTED" &&
    error.code !== "WS_REQUEST_NOT_SENT"
  );
}
