import {
  GUEST_ACCESS_ERROR_MESSAGES,
  GUEST_SHARE_OWNER_ERROR_MESSAGES,
  type GuestAccessErrorReason,
  type GuestShareOwnerErrorCode,
} from "@synara/contracts";
import { Data } from "effect";

/** An owner call failed; `code` is what the client localizes by. */
export class GuestShareOwnerError extends Data.TaggedError("GuestShareOwnerError")<{
  readonly code: GuestShareOwnerErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export function guestShareOwnerError(
  code: GuestShareOwnerErrorCode,
  cause?: unknown,
): GuestShareOwnerError {
  return new GuestShareOwnerError({
    code,
    message: GUEST_SHARE_OWNER_ERROR_MESSAGES[code],
    ...(cause === undefined ? {} : { cause }),
  });
}

/** What a guest is told. The message comes from `reason`, never from a cause. */
export class GuestShareAccessError extends Data.TaggedError("GuestShareAccessError")<{
  readonly reason: GuestAccessErrorReason;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return GUEST_ACCESS_ERROR_MESSAGES[this.reason];
  }
}

export function guestAccessError(
  reason: GuestAccessErrorReason,
  cause?: unknown,
): GuestShareAccessError {
  return new GuestShareAccessError({ reason, ...(cause === undefined ? {} : { cause }) });
}
