// FILE: voiceTranscriptionErrorPresentation.ts
// Purpose: Turn a failed voice-note transcription into one plain sentence for the toast.
// Layer: Chat composer presentation helper
// Exports: describeVoiceTranscriptionFailure, resolveVoiceUiLocale
// Depends on: the shared stable voice failure codes.

import { resolveSafeVoiceTranscriptionFailure } from "@moss/shared/voiceTranscriptionFailure";

/** Codes whose fix is signing in again (to Moss or to the personal provider). */
const SIGN_IN_FAILURE_CODES: ReadonlySet<string> = new Set([
  "VOICE_ACCOUNT_AUTHENTICATION_REQUIRED",
  "MOSS_VOICE_LOGIN_REQUIRED",
  "VOICE_CHATGPT_LOGIN_EXPIRED",
]);

export interface VoiceTranscriptionFailurePresentation {
  /** Stable server code, or null when the failure carried none. */
  readonly code: string | null;
  /** Localized guidance for a known code; null means "use the generic copy". */
  readonly message: string | null;
  /** Signing in again fixes it, so the toast offers a status refresh. */
  readonly needsSignIn: boolean;
}

function readFailureCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" && code.trim() ? code.trim() : null;
}

/** The app's UI language: the explicit option first, then the document's declared locale. */
export function resolveVoiceUiLocale(locale: string | undefined): string {
  if (locale && /^zh(?:-|$)/iu.test(locale)) return locale;
  if (typeof document !== "undefined") {
    const declared = document.documentElement.dataset.mossLocale;
    if (declared) return declared;
    if (document.documentElement.lang) return document.documentElement.lang;
  }
  return locale ?? "en";
}

/**
 * Server failures carry a stable code; only that code decides the wording. Provider text such as
 * "Provider adapter request failed (codex) for voice/transcribe" is never shown to a person.
 */
export function describeVoiceTranscriptionFailure(
  error: unknown,
  locale: string,
): VoiceTranscriptionFailurePresentation {
  const code = readFailureCode(error);
  if (!code) return { code: null, message: null, needsSignIn: false };
  const safe = resolveSafeVoiceTranscriptionFailure({ code, locale });
  return {
    code,
    message: safe?.message ?? null,
    needsSignIn: SIGN_IN_FAILURE_CODES.has(code),
  };
}
