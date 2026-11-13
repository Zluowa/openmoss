// FILE: codexErrorClassification.ts
// Purpose: Centralizes Codex runtime error classification shared across manager and adapter layers.
// Exports: startup failure evidence and helpers for non-fatal Codex error messages

/** Startup failed before a turn could be sent, and process cleanup completed. */
export class CodexSessionStartError extends Error {
  override readonly name = "CodexSessionStartError";
}

const NON_FATAL_CODEX_ERROR_SNIPPETS = [
  "write_stdin failed: stdin is closed for this session",
] as const;

export function isNonFatalCodexErrorMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return NON_FATAL_CODEX_ERROR_SNIPPETS.some((snippet) => normalized.includes(snippet));
}

/**
 * Codex 0.163 permits forward-compatible error variants in app-server
 * notifications. Keep an unknown variant visible to the user instead of
 * assuming every error is the legacy `{ message: string }` shape.
 */
export function codexErrorMessage(value: unknown): string | undefined {
  if (typeof value === "string") {
    const message = value.trim();
    return message || undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

  const record = value as Record<string, unknown>;
  for (const key of ["message", "detail", "reason", "kind", "type"] as const) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }

  // Error variants are tagged objects in the generated app-server protocol.
  // The tag is still useful when a newer CLI introduces a variant Moss has not
  // seen yet, but deliberately avoid serializing its potentially sensitive body.
  const info = record.codexErrorInfo ?? record.codex_error_info;
  const tagged =
    info && typeof info === "object" && !Array.isArray(info)
      ? (info as Record<string, unknown>)
      : record;
  const tag = Object.keys(tagged).find((key) => key.trim());
  return tag ? `Codex error: ${tag}` : undefined;
}

/**
 * Gateway responses like 524/502 are hard failures, not retryable soft
 * warnings. The runtime should settle the turn immediately instead of waiting
 * for another retry cycle.
 */
export function isNonRetryableCodexGatewayErrorMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  return (
    /\b(?:524|502)\b/u.test(normalized) ||
    normalized.includes("gateway timeout") ||
    normalized.includes("bad gateway")
  );
}

// The managed Codex runtime surfaces gateway rejections as a raw retry/stream
// failure (e.g. "exceeded retry limit, last status: 429") with the actionable
// detail — quota exhausted vs. transient throttling, and any retry-after hint —
// buried in the body. Surface that detail so a hard account-quota stop reads as
// "top up / wait for reset" instead of a generic provider crash.
const RETRY_AFTER_SECONDS_PATTERN = /retry-after["']?\s*[:=]\s*"?(\d{2,7})/i;

function formatRetryAfterSeconds(totalSeconds: number): string | undefined {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return undefined;
  const totalMinutes = Math.round(totalSeconds / 60);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${Math.max(minutes, 1)}m`;
}

export function humanizeCodexRuntimeErrorMessage(message: string): string | undefined {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return undefined;

  if (normalized.includes("service_cost_budget_exhausted"))
    return "Your Moss package usage allowance is exhausted.";

  const isQuota =
    normalized.includes("request_quota_exhausted") ||
    normalized.includes("token_quota_exhausted") ||
    normalized.includes("quota for this period is exhausted") ||
    normalized.includes("insufficient_quota") ||
    normalized.includes("exceeded your current quota");
  const is429 = normalized.includes("429") || normalized.includes("too many requests");
  if (!isQuota && !is429) return undefined;

  const retryAfterMatch = RETRY_AFTER_SECONDS_PATTERN.exec(message);
  const retryAfterSeconds = retryAfterMatch ? Number(retryAfterMatch[1]) : undefined;
  const retryHint =
    retryAfterSeconds !== undefined ? formatRetryAfterSeconds(retryAfterSeconds) : undefined;

  if (isQuota) {
    return retryHint
      ? `Moss account quota is exhausted for this period. Top up your plan, or try again in about ${retryHint}.`
      : "Moss account quota is exhausted for this period. Top up your plan or wait for the quota to reset.";
  }
  return retryHint
    ? `The Moss model gateway is rate limiting requests right now. Try again in about ${retryHint}.`
    : "The Moss model gateway is rate limiting requests right now. Try again in a moment.";
}
