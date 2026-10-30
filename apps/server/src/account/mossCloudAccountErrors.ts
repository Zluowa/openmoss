import { Data } from "effect";

export class MossCloudAccountServiceError extends Data.TaggedError("MossCloudAccountServiceError")<{
  readonly code:
    | "not_configured"
    | "invalid_credentials"
    | "email_not_verified"
    | "authentication_required"
    | "session_expired"
    | "account_disabled"
    | "rate_limited"
    | "network_error"
    | "provider_error"
    | "persistence_failed";
  readonly message: string;
  readonly retryAfterSeconds?: number;
  readonly cause?: unknown;
}> {}
