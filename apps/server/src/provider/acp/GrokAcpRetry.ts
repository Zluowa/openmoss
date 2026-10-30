/**
 * Grok 1.0.x `_x.ai/session_notification` retry_state → live working label.
 *
 * Current Mac CLI (`grok 1.0.62`) keeps the official `session/update` stream
 * for assistant text. While it cannot reach `cli-chat-proxy.grok.com` it emits
 * `_x.ai/session_notification` with
 * `{ sessionUpdate: "retry_state", type: "retrying", max_retries: 15 }` and
 * stays silent. Moss must surface that as
 * "Retrying: connection timed out (n/15)" instead of a stuck Thinking label.
 *
 * @module GrokAcpRetry
 */

export interface GrokRetryState {
  readonly attempt?: number;
  readonly maxAttempts?: number;
  readonly reason: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && /^\d+$/u.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return undefined;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRetryStateKind(kind: string | undefined): boolean {
  return kind === "retry_state" || kind === "retry-state" || kind === "retryState";
}

/**
 * Grok 1.0.62 sends `sessionUpdate: "retry_state"` and `type: "retrying"` on
 * the same object. Prefer sessionUpdate, and treat any of these fields as a
 * hit so `type: "retrying"` cannot hide the frame.
 */
function recordHasRetryState(record: Record<string, unknown>): boolean {
  for (const key of ["sessionUpdate", "type", "kind", "notification"] as const) {
    const value = record[key];
    if (typeof value === "string" && isRetryStateKind(value.trim())) return true;
  }
  return false;
}

function collectRetryCandidates(params: unknown): Record<string, unknown>[] {
  if (!isRecord(params)) return [];
  const candidates = [params];
  for (const key of ["update", "notification", "data", "retry_state", "retryState"]) {
    const nested = params[key];
    if (isRecord(nested)) candidates.push(nested);
  }
  return candidates;
}

export function humanizeGrokRetryReason(errorText: string | undefined): string {
  if (!errorText) return "connection timed out";
  const lower = errorText.toLowerCase();
  if (
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("etimedout") ||
    lower.includes("tcp connect error")
  ) {
    return "connection timed out";
  }
  if (lower.includes("econnrefused") || lower.includes("connection refused")) {
    return "connection refused";
  }
  return "connection failed";
}

export function parseGrokRetryState(params: unknown): GrokRetryState | undefined {
  const candidates = collectRetryCandidates(params);
  const matched = candidates.find(recordHasRetryState);
  if (!matched) return undefined;

  const errorText =
    readString(matched.error) ??
    readString(matched.message) ??
    readString(matched.reason) ??
    readString(matched.last_error) ??
    readString(matched.cause);

  const attempt = readNumber(
    matched.attempt ?? matched.retry_attempt ?? matched.current_attempt ?? matched.n,
  );
  const maxAttempts = readNumber(
    matched.max_retries ??
      matched.maxRetries ??
      matched.max_attempts ??
      matched.maxAttempts ??
      matched.retry_limit ??
      matched.total,
  );

  return {
    reason: humanizeGrokRetryReason(errorText),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
  };
}

export function formatGrokRetryWorkingLabel(retry: GrokRetryState): `Retrying: ${string}` {
  if (retry.attempt !== undefined && retry.maxAttempts !== undefined && retry.maxAttempts > 0) {
    return `Retrying: ${retry.reason} (${retry.attempt}/${retry.maxAttempts})`;
  }
  return `Retrying: ${retry.reason}`;
}
