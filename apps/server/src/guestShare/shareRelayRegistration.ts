/**
 * Registers and deletes shares on the Moss share relay (`POST /v1/shares`,
 * `DELETE /v1/shares/<id>`). Registration carries the owner's account bearer and the host key
 * hash; deletion proves the host key.
 */
import {
  SHARE_RELAY_HOST_KEY_HEADER,
  SHARE_RELAY_PATHS,
  ShareRelayRegisterResponse,
  type GuestShareId,
  type ShareRelayRegisterRequest,
} from "@synara/contracts";
import { Effect, Schema } from "effect";

import { guestShareOwnerError, type GuestShareOwnerError } from "./Errors.ts";

const REGISTER_TIMEOUT_MS = 15_000;
const DELETE_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

/** The subset of `fetch` the relay calls use, so a test can hand in a plain function. */
export type ShareRelayFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const decodeRegisterResponse = Schema.decodeUnknownOption(ShareRelayRegisterResponse);

const boundedJson = (response: Response): Effect.Effect<unknown, GuestShareOwnerError> =>
  Effect.tryPromise({
    try: async () => {
      const text = await response.text();
      if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error("response too large");
      return JSON.parse(text) as unknown;
    },
    catch: (cause) => guestShareOwnerError("guest_share.relay_unavailable", cause),
  });

const relayStatusError = (response: Response): GuestShareOwnerError =>
  response.status === 429
    ? guestShareOwnerError("guest_share.rate_limited")
    : response.status === 401 || response.status === 403
      ? guestShareOwnerError("guest_share.account_required")
      : guestShareOwnerError(
          "guest_share.relay_unavailable",
          new Error(`Share relay answered ${response.status}.`),
        );

export function registerShareWithRelay(input: {
  readonly fetch: ShareRelayFetch;
  readonly origin: string;
  readonly bearer: string;
  readonly request: ShareRelayRegisterRequest;
}): Effect.Effect<ShareRelayRegisterResponse, GuestShareOwnerError> {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        input.fetch(`${input.origin}${SHARE_RELAY_PATHS.register}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${input.bearer}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(input.request),
          signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
        }),
      catch: (cause) => guestShareOwnerError("guest_share.relay_unavailable", cause),
    });
    if (!response.ok) return yield* relayStatusError(response);
    const body = decodeRegisterResponse(yield* boundedJson(response));
    if (body._tag === "None" || body.value.shareId !== input.request.shareId) {
      return yield* guestShareOwnerError(
        "guest_share.relay_unavailable",
        new Error("Share relay returned an unexpected registration."),
      );
    }
    return body.value;
  });
}

/** Best effort: a missing registration (404) is already the wanted state. */
export function deleteShareFromRelay(input: {
  readonly fetch: ShareRelayFetch;
  readonly origin: string;
  readonly shareId: GuestShareId;
  readonly hostKey: string;
}): Effect.Effect<boolean> {
  return Effect.tryPromise({
    try: async () => {
      const response = await input.fetch(
        `${input.origin}${SHARE_RELAY_PATHS.share(input.shareId)}`,
        {
          method: "DELETE",
          headers: { [SHARE_RELAY_HOST_KEY_HEADER]: input.hostKey },
          signal: AbortSignal.timeout(DELETE_TIMEOUT_MS),
        },
      );
      await response.body?.cancel().catch(() => undefined);
      return response.ok || response.status === 404;
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Could not delete a guest share from the relay.", {
        shareId: input.shareId,
        cause: String(cause),
      }).pipe(Effect.as(false)),
    ),
  );
}
