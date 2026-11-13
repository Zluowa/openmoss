// FILE: errors.ts
// Purpose: Carry a group-chat failure's stable code and English detail to the client and to
//          member agents, instead of the generic message Effect.tryPromise substitutes.
// Layer: Mossbot rooms boundary
// Exports: toMossbotRoomRpcError, mossbotRoomToolErrorText

import { MOSSBOT_ROOM_ERROR_CODE_PREFIX, WsRpcError } from "@moss/contracts";
import { isMossbotRoomError } from "@moss/shared/mossbotRoom";

// These refuse the same request again; a retry only helps for the others.
const NON_RETRYABLE = new Set([
  "request_conflict",
  "duplicate_member",
  "name_required",
  "not_member",
  "message_conflict",
  "no_active_turn",
  "message_limit",
  "turn_limit",
  "ambiguous_name",
  "room_not_found",
  "attachment_unavailable",
]);

/** A WsRpcError whose code is `mossbot.<code>` for a known room failure. */
export function toMossbotRoomRpcError(cause: unknown): WsRpcError {
  if (isMossbotRoomError(cause)) {
    return new WsRpcError({
      message: cause.message,
      code: `${MOSSBOT_ROOM_ERROR_CODE_PREFIX}${cause.code}`,
      retryable: !NON_RETRYABLE.has(cause.code),
    });
  }
  return new WsRpcError({
    message:
      cause instanceof Error && cause.message.length > 0
        ? cause.message
        : "Mossbot group operation failed",
    code: `${MOSSBOT_ROOM_ERROR_CODE_PREFIX}unavailable`,
    retryable: true,
  });
}

/** What a member agent reads when a room tool refuses: the reason and whether to retry. */
export function mossbotRoomToolErrorText(cause: unknown): string {
  if (isMossbotRoomError(cause)) {
    return `${cause.message} (${cause.code}; ${NON_RETRYABLE.has(cause.code) ? "do not retry this request" : "you may retry later"})`;
  }
  return cause instanceof Error && cause.message.length > 0
    ? cause.message
    : "The group is unavailable right now.";
}
