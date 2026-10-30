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
