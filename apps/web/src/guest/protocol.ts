// FILE: protocol.ts
// Purpose: Decodes what the owner's Moss sends the guest page: stream frames and error bodies.
// Layer: Guest page
// Why: The page renders the thread with the owner's own transcript stack, so the contracts
//      package is already in its bundle; the schemas decode frames exactly as the owner's client
//      would. A frame of a type this page does not know decodes to nothing and is skipped.

import {
  GUEST_ROUTES,
  GuestAccessErrorBody,
  GuestStreamEvent,
  guestApiPath,
  type GuestAccessErrorReason,
} from "@synara/contracts";
import { Option, Schema } from "effect";

export { GUEST_ROUTES, guestApiPath };
export type {
  GuestAccessErrorReason,
  GuestMessageAttachment,
  GuestShareEndReason,
  GuestShareView,
  GuestStreamEvent,
  GuestThreadModel,
  ThreadGuestMessage,
  ThreadGuestMessageStatus,
} from "@synara/contracts";

const decodeStreamEvent = Schema.decodeUnknownOption(GuestStreamEvent);

/** One `data:` payload, or null for malformed JSON and frames this page cannot read. */
export function parseGuestStreamEvent(data: string): GuestStreamEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  return Option.getOrNull(decodeStreamEvent(json));
}

/** What a non-2xx guest response said; an unknown reason keeps the server's message. */
export interface GuestErrorBody {
  readonly reason: GuestAccessErrorReason | null;
  readonly message: string | null;
}

const decodeErrorBody = Schema.decodeUnknownOption(GuestAccessErrorBody);

export function parseGuestErrorBody(json: unknown): GuestErrorBody {
  const body = Option.getOrNull(decodeErrorBody(json));
  if (body !== null) return body;
  const message =
    typeof json === "object" && json !== null && "message" in json
      ? (json as { message?: unknown }).message
      : null;
  return { reason: null, message: typeof message === "string" && message !== "" ? message : null };
}
