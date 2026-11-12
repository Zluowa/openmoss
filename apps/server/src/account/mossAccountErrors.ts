import { homedir } from "node:os";

import { Data } from "effect";

export class MossAccountServiceError extends Data.TaggedError("MossAccountServiceError")<{
  readonly code:
    | "invalid_phone_number"
    | "sms_send_failed"
    | "sms_rate_limited"
    | "challenge_not_found"
    | "challenge_expired"
    | "challenge_consumed"
    | "challenge_attempts_exceeded"
    | "invalid_verification_code"
    | "authentication_service_unavailable"
    | "invalid_authentication_response"
    | "session_expired"
    | "authentication_required"
    | "persistence_failed";
  readonly message: string;
  readonly cause?: unknown;
}> {}

const MAX_CAUSE_DEPTH = 6;
const MAX_CAUSE_MESSAGE_LENGTH = 300;
/**
 * Credential shapes only. The shared diagnostics rules also blank any word
 * after a "...session:" label, which here would hide the very issue text a
 * ProviderService error carries ("stopRuntimeSession: The provider ...").
 */
const CAUSE_REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bBearer\s+\S+/gi, "Bearer [redacted]"],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "[redacted]"],
  [/\b(?:sk|rk|moss_sk)[-_][A-Za-z0-9_-]{8,}/g, "[redacted]"],
  [/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]"],
  // Mainland mobile numbers, with or without +86.
  [/(?<!\d)(?:\+?86[\s-]?)?1[3-9]\d{9}(?!\d)/g, "<phone>"],
];

const stringField = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" && value.length > 0 && value.length <= 80 ? value : undefined;
};

const describeOneCause = (cause: unknown): string => {
  if (typeof cause !== "object" || cause === null) {
    return redactCauseText(String(cause));
  }
  const record = cause as Record<string, unknown>;
  const name =
    stringField(record, "_tag") ??
    (cause instanceof Error ? cause.name : undefined) ??
    cause.constructor?.name ??
    "object";
  // `code` is the account error code or a Node errno such as EBUSY; the rest
  // name the ProviderService operation and why it refused.
  const details = ["code", "operation", "reason", "syscall"]
    .map((key) => stringField(record, key))
    .filter((value): value is string => value !== undefined);
  const message = typeof record.message === "string" ? redactCauseText(record.message) : "";
  return `${name}${details.length > 0 ? `[${details.join(", ")}]` : ""}${message ? `: ${message}` : ""}`;
};

const redactCauseText = (text: string): string => {
  // Redact before the final cut so a credential split at the cut cannot leave a
  // fragment; the first bound only limits the work.
  let out = text.slice(0, 8 * MAX_CAUSE_MESSAGE_LENGTH);
  const home = homedir();
  if (home.length > 1) out = out.split(home).join("~");
  for (const [pattern, replacement] of CAUSE_REDACTIONS) out = out.replace(pattern, replacement);
  out = out.replace(/\s+/g, " ").trim();
  return out.length > MAX_CAUSE_MESSAGE_LENGTH ? `${out.slice(0, MAX_CAUSE_MESSAGE_LENGTH)}…` : out;
};

/**
 * The error's cause chain as one log-safe line, outermost first: tag, code,
 * operation and redacted message of each link. Account errors wrap whatever
 * failed underneath, so without this a log names only the outermost wrapper.
 */
export function describeMossErrorCauses(error: unknown): string | undefined {
  const links: string[] = [];
  const seen = new Set<unknown>();
  let current =
    typeof error === "object" && error !== null ? (error as { cause?: unknown }).cause : undefined;
  while (
    current !== undefined &&
    current !== null &&
    links.length < MAX_CAUSE_DEPTH &&
    !seen.has(current)
  ) {
    seen.add(current);
    links.push(describeOneCause(current));
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return links.length > 0 ? links.join(" <- ") : undefined;
}
