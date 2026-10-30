// FILE: SecretRequestCard.logic.ts
// Purpose: Pure state for the private "Save securely" card an agent opens with
//          moss_request_secret: what the card shows, the answer it sends, and which
//          failures may echo a server message.
// Layer: Chat transcript UI logic
// Exports: secretRequestDisplay, secretRequestAnswerInput, secretRequestServerMessage

import {
  SECRET_REQUEST_ERROR_CODES,
  type SecretRequestActivityPayload,
  type SecretRequestAnswerInput,
  type SecretRequestOutcome,
  type ThreadId,
} from "@synara/contracts";

import type { TranslationKey } from "~/localization";

const OUTCOME_LABEL_KEYS: Record<SecretRequestOutcome, TranslationKey> = {
  saved: "chat.secretRequest.outcome.saved",
  declined: "chat.secretRequest.outcome.declined",
  cancelled: "chat.secretRequest.outcome.cancelled",
  timed_out: "chat.secretRequest.outcome.timedOut",
};

export type SecretRequestDisplay =
  | { readonly kind: "pending" }
  | {
      readonly kind: "settled";
      readonly outcome: SecretRequestOutcome;
      readonly labelKey: TranslationKey;
    };

/**
 * `answered` is this window's own accepted answer, shown until the server's
 * settled card arrives so the form never lingers after a successful save.
 */
export function secretRequestDisplay(
  request: Pick<SecretRequestActivityPayload, "outcome">,
  answered?: SecretRequestOutcome,
): SecretRequestDisplay {
  const outcome = request.outcome ?? answered;
  return outcome === undefined
    ? { kind: "pending" }
    : { kind: "settled", outcome, labelKey: OUTCOME_LABEL_KEYS[outcome] };
}

export function secretRequestAnswerInput(
  threadId: ThreadId,
  request: Pick<SecretRequestActivityPayload, "requestId">,
  answer: { readonly type: "save"; readonly secret: string } | { readonly type: "decline" },
): SecretRequestAnswerInput | null {
  if (answer.type === "decline") {
    return { threadId, requestId: request.requestId, answer: { type: "decline" } };
  }
  const secret = answer.secret.trim();
  if (secret.length === 0) return null;
  return { threadId, requestId: request.requestId, answer: { type: "save", secret } };
}

const USER_FACING_CODES: ReadonlySet<string> = new Set(Object.values(SECRET_REQUEST_ERROR_CODES));

/**
 * The server's own refusal message, or null. Any other failure (a transport or
 * decode error) can quote the typed value back, so the card shows its generic
 * copy instead and the value never reaches the screen.
 */
export function secretRequestServerMessage(error: unknown): string | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    USER_FACING_CODES.has(error.code) &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.trim().length > 0
  ) {
    return error.message;
  }
  return null;
}
