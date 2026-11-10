const PI_INTERRUPTION_MARKERS = [
  "request was aborted",
  "operation was aborted",
  "aborterror",
  "interrupted by user",
  "user aborted",
  // The SDK reports this through auto_retry_end when backoff is aborted.
  "retry cancelled",
  "retry canceled",
] as const;

interface PiTurnFailureClassification {
  readonly state: "failed" | "interrupted";
  readonly stopReason: "error" | "aborted";
}

function isPiInterruptedMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return PI_INTERRUPTION_MARKERS.some((marker) => normalized.includes(marker));
}

export function classifyPiTurnFailure(message: string): PiTurnFailureClassification {
  if (isPiInterruptedMessage(message)) {
    return { state: "interrupted", stopReason: "aborted" };
  }

  return { state: "failed", stopReason: "error" };
}

// Pi's own words when the selected model's provider has no credential in this
// Pi home ("No API key for deepseek/deepseek-flash").
const PI_MISSING_API_KEY_PATTERN = /^No API key for \S+/u;

/**
 * A model whose provider this Pi account has no sign-in for (a chat started
 * where it had one, say): a plain sentence with the way forward, or null for
 * any other failure, which keeps Pi's own message.
 */
export function piMissingModelSignInIssue(
  message: string,
  model: { readonly id: string; readonly name?: string | undefined },
): string | null {
  if (!PI_MISSING_API_KEY_PATTERN.test(message.trim())) return null;
  const name = model.name?.trim() || model.id;
  return `This Pi account has no sign-in for ${name}. Switch to Moss or another model to continue.`;
}
