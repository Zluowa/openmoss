import { Schema } from "effect";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

// An agent asks the user for a secret through a private chat card. The value
// travels only over `secretRequest.answer` into an owner-only file the agent's
// commands can read; orchestration events, activities, and the transcript only
// ever see the request and its outcome.

/** A pending card: payload is `SecretRequestActivityPayload` without `outcome`. */
export const SECRET_REQUEST_ACTIVITY_KIND = "secret.requested";
/** The same card once settled: payload carries the `outcome`. */
export const SECRET_REQUEST_RESOLVED_ACTIVITY_KIND = "secret.resolved";

/** How long a saved secret's file stays readable before the server deletes it. */
export const SECRET_REQUEST_FILE_TTL_MS = 24 * 60 * 60 * 1000;
export const SECRET_REQUEST_DEFAULT_WAIT_MS = 10 * 60 * 1000;
export const SECRET_REQUEST_MAX_WAIT_MS = 60 * 60 * 1000;
export const SECRET_REQUEST_LABEL_MAX_LENGTH = 200;
export const SECRET_REQUEST_REASON_MAX_LENGTH = 2_000;
export const SECRET_REQUEST_VALUE_MAX_LENGTH = 64 * 1024;

export const SecretRequestId = Schema.String.check(
  Schema.isPattern(/^secret-request:[0-9a-f]{32}$/),
);
export type SecretRequestId = typeof SecretRequestId.Type;

export const SecretRequestOutcome = Schema.Literals([
  "saved",
  "declined",
  "cancelled",
  "timed_out",
]);
export type SecretRequestOutcome = typeof SecretRequestOutcome.Type;

export const SecretRequestActivityPayload = Schema.Struct({
  requestId: SecretRequestId,
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(SECRET_REQUEST_LABEL_MAX_LENGTH)),
  reason: TrimmedNonEmptyString.check(Schema.isMaxLength(SECRET_REQUEST_REASON_MAX_LENGTH)),
  placeholder: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(SECRET_REQUEST_LABEL_MAX_LENGTH)),
  ),
  outcome: Schema.optional(SecretRequestOutcome),
});
export type SecretRequestActivityPayload = typeof SecretRequestActivityPayload.Type;

export const SecretRequestAnswerInput = Schema.Struct({
  threadId: ThreadId,
  requestId: SecretRequestId,
  answer: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("save"),
      secret: TrimmedNonEmptyString.check(Schema.isMaxLength(SECRET_REQUEST_VALUE_MAX_LENGTH)),
    }),
    Schema.Struct({ type: Schema.Literal("decline") }),
  ]),
});
export type SecretRequestAnswerInput = typeof SecretRequestAnswerInput.Type;

/**
 * `WsRpcError.code` values for refused answers. Clients show only these
 * errors' messages: any other failure (a transport or decode error) could echo
 * the typed value back, so it gets generic copy instead.
 */
export const SECRET_REQUEST_ERROR_CODES = {
  notFound: "SECRET_REQUEST_NOT_FOUND",
  alreadyAnswered: "SECRET_REQUEST_ALREADY_ANSWERED",
  ended: "SECRET_REQUEST_ENDED",
  storeFailed: "SECRET_REQUEST_STORE_FAILED",
} as const;
export type SecretRequestErrorCode =
  (typeof SECRET_REQUEST_ERROR_CODES)[keyof typeof SECRET_REQUEST_ERROR_CODES];
