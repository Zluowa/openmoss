// FILE: errorMessages.ts
// Purpose: Normalizes nested Error-like values into readable messages.
// Layer: Shared utility
// Exports: collectErrorMessages, describeErrorMessage, sanitizeUserFacingErrorMessage, invariant markers

// Stable phrase embedded in the server's "thread is not archived" orchestration
// invariant message. Shared so the server (which builds the message) and the
// client (which detects an Undo that raced another restore) reference one source
// of truth and cannot silently drift apart when the wording is edited.
export const THREAD_NOT_ARCHIVED_INVARIANT_MARKER = "is not archived for command";

// A duplicate approval can race the authoritative interaction update back to
// the browser. The server still rejects the duplicate, while the client treats
// this marker as an instruction to refresh the already-settled request.
export const APPROVAL_ALREADY_ANSWERED_INVARIANT_MARKER = "was already answered.";

// Keep readable provider failures in the transcript; full causes belong in logs.
export function sanitizeUserFacingErrorMessage(message: string, fallback: string): string {
  const firstLine = message.trim().split("\n")[0]?.trim() ?? "";
  const withoutInlineStack = firstLine
    .replace(/\s+at file:\/\/.*$/s, "")
    .replace(/\s+at (?:async )?\S+ \((?:file:\/\/|\/|[A-Za-z]:\\).*:\d+(?::\d+)?\)$/s, "")
    .trim();
  return withoutInlineStack.length > 0 ? withoutInlineStack : fallback;
}

export function collectErrorMessages(
  error: unknown,
  messages: string[] = [],
  seen = new Set<unknown>(),
): string[] {
  if (!error || seen.has(error)) return messages;
  seen.add(error);

  if (typeof error === "string") {
    const message = error.trim();
    if (message.length > 0) messages.push(message);
    return messages;
  }

  if (error instanceof Error) {
    const message = error.message.trim();
    if (message.length > 0) messages.push(message);
    collectErrorMessages((error as { cause?: unknown }).cause, messages, seen);
    return messages;
  }

  if (typeof error === "object") {
    const value = error as { message?: unknown; cause?: unknown };
    if (typeof value.message === "string") {
      const message = value.message.trim();
      if (message.length > 0) messages.push(message);
    }
    collectErrorMessages(value.cause, messages, seen);
  }

  return messages;
}

export function describeErrorMessage(error: unknown, fallbackMessage: string): string {
  const messages = collectErrorMessages(error);
  const uniqueMessages = messages.filter(
    (message, index) => messages.findIndex((candidate) => candidate === message) === index,
  );
  if (uniqueMessages.length === 0) return fallbackMessage;
  return uniqueMessages.join(": ");
}

/**
 * Returns true when an error represents the normal WebSocket close handshake.
 * Effect wraps socket failures in several nested tagged errors, so inspect the
 * complete cause chain as well as serialized RPC fields.
 */
export function isCleanSocketCloseError(error: unknown): boolean {
  const seen = new Set<unknown>();
  const visit = (value: unknown): boolean => {
    if (!value || seen.has(value)) return false;
    seen.add(value);

    if (typeof value === "string") {
      return /^SocketCloseError:\s*1000$/u.test(value.trim());
    }

    if (typeof value !== "object") return false;
    const candidate = value as {
      _tag?: unknown;
      name?: unknown;
      message?: unknown;
      code?: unknown;
      closeCode?: unknown;
      wasClean?: unknown;
      reason?: unknown;
      cause?: unknown;
    };
    const tag = typeof candidate._tag === "string" ? candidate._tag : "";
    const name = typeof candidate.name === "string" ? candidate.name : "";
    const message = typeof candidate.message === "string" ? candidate.message.trim() : "";
    const hasCleanMessage = /^SocketCloseError:\s*1000$/u.test(message);
    const isSocketClose =
      tag === "SocketCloseError" || name === "SocketCloseError" || hasCleanMessage;
    const code = candidate.code ?? candidate.closeCode;
    const hasCleanCode = code === 1000 || code === "1000" || message === "1000";
    if (hasCleanMessage || (isSocketClose && (hasCleanCode || candidate.wasClean === true))) {
      return true;
    }
    if (candidate.wasClean === true && hasCleanCode) return true;

    return visit(candidate.reason) || visit(candidate.cause);
  };

  return visit(error);
}
