import { Schema } from "effect";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";
import { GuestShareId } from "./guestShare";

/**
 * Moss share relay protocol. The relay is a dumb, per-share pipe between guest browsers and the
 * owner's Moss server:
 *
 * 1. The owner's server registers a share with its Moss account bearer (`POST /v1/shares`),
 *    committing to `sha256(hostKey)`. The account makes every share attributable to a signed-in
 *    (in CN, phone-verified) Moss user, so the relay is not an anonymous tunnel.
 * 2. It then holds one WebSocket per share (`GET /v1/shares/<id>/host`), proving the host key in
 *    its first frame. A newer host connection replaces an older one.
 * 3. Guest requests to `/v1/shares/<id>/guest/<route>` are multiplexed over that socket. The relay
 *    serves the static guest page itself and never forwards anything else, so a host can only
 *    answer guest routes, and the relay enforces each route's response type.
 *
 * The relay stores no thread content. It keeps only the share id, the host key hash, the owning
 * account id, and the expiry.
 */

export const SHARE_RELAY_PROTOCOL_VERSION = 1;

export const SHARE_RELAY_PATHS = {
  health: "/healthz",
  register: "/v1/shares",
  share: (shareId: string) => `/v1/shares/${shareId}`,
  host: (shareId: string) => `/v1/shares/${shareId}/host`,
} as const;

/** Header that proves the host key on `DELETE /v1/shares/<id>`. */
export const SHARE_RELAY_HOST_KEY_HEADER = "x-moss-share-host-key";

// ── Limits ──────────────────────────────────────────────────────────

/** Largest guest request body the relay forwards (a 10 MB message plus multipart overhead). */
export const SHARE_RELAY_MAX_REQUEST_BODY_BYTES = 11 * 1024 * 1024;
/** Largest non-streaming response body the relay forwards. */
export const SHARE_RELAY_MAX_RESPONSE_BODY_BYTES = 26 * 1024 * 1024;
export const SHARE_RELAY_CHUNK_BYTES = 64 * 1024;
export const SHARE_RELAY_MAX_INFLIGHT_PER_SHARE = 32;
export const SHARE_RELAY_PING_INTERVAL_MS = 25_000;
/** A host socket with no frame for this long is treated as dead. */
export const SHARE_RELAY_HOST_IDLE_TIMEOUT_MS = 75_000;
export const SHARE_RELAY_HELLO_TIMEOUT_MS = 10_000;
/** How long a guest request waits for the host's response head. */
export const SHARE_RELAY_RESPONSE_HEAD_TIMEOUT_MS = 30_000;
export const SHARE_RELAY_MAX_ACTIVE_SHARES_PER_ACCOUNT = 10;

/** Request headers the relay forwards to the host; everything else is dropped. */
export const SHARE_RELAY_FORWARDED_REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "content-length",
  "content-type",
  "cookie",
  "last-event-id",
] as const;

// ── Registration ────────────────────────────────────────────────────

/** base64url (no padding) SHA-256 of the host key. */
export const ShareRelayHostKeyHash = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/));

export const ShareRelayRegisterRequest = Schema.Struct({
  shareId: GuestShareId,
  hostKeyHash: ShareRelayHostKeyHash,
  expiresAt: IsoDateTime,
  protocolVersion: NonNegativeInt,
});
export type ShareRelayRegisterRequest = typeof ShareRelayRegisterRequest.Type;

export const ShareRelayRegisterResponse = Schema.Struct({
  shareId: GuestShareId,
  expiresAt: IsoDateTime,
  /** The guest page URL without the invite fragment. */
  pageUrl: TrimmedNonEmptyString,
});
export type ShareRelayRegisterResponse = typeof ShareRelayRegisterResponse.Type;

export const ShareRelayErrorCode = Schema.Literals([
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "invalid_request",
  "disabled",
  "unsupported_protocol",
]);
export type ShareRelayErrorCode = typeof ShareRelayErrorCode.Type;

export const ShareRelayErrorBody = Schema.Struct({
  error: ShareRelayErrorCode,
  message: Schema.String,
});
export type ShareRelayErrorBody = typeof ShareRelayErrorBody.Type;

// ── Host socket frames ──────────────────────────────────────────────
// Text frames are JSON. Body bytes travel in binary frames:
//   byte 0      kind (SHARE_RELAY_BINARY_KIND)
//   bytes 1..4  request id, uint32 big-endian
//   bytes 5..   payload (at most SHARE_RELAY_CHUNK_BYTES)

export const SHARE_RELAY_BINARY_KIND = {
  requestBody: 1,
  responseBody: 2,
} as const;
export const SHARE_RELAY_BINARY_HEADER_BYTES = 5;

const RequestIdField = NonNegativeInt;
const HeaderRecord = Schema.Record(Schema.String, Schema.String);

/** Host → relay. `hello` must be the first frame. */
export const ShareRelayHostFrame = Schema.Union([
  Schema.Struct({
    t: Schema.Literal("hello"),
    shareId: GuestShareId,
    hostKey: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
    protocolVersion: NonNegativeInt,
  }),
  Schema.Struct({
    t: Schema.Literal("res"),
    id: RequestIdField,
    status: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
    headers: HeaderRecord,
  }),
  Schema.Struct({ t: Schema.Literal("res-end"), id: RequestIdField }),
  /** The host gave up on a response after its head was sent; the relay aborts the body. */
  Schema.Struct({ t: Schema.Literal("res-error"), id: RequestIdField }),
  Schema.Struct({ t: Schema.Literal("pong") }),
]);
export type ShareRelayHostFrame = typeof ShareRelayHostFrame.Type;

/** Relay → host. */
export const ShareRelayRelayFrame = Schema.Union([
  Schema.Struct({ t: Schema.Literal("hello-ok"), expiresAt: IsoDateTime }),
  Schema.Struct({
    t: Schema.Literal("req"),
    id: RequestIdField,
    method: Schema.Literals(["GET", "POST", "HEAD"]),
    /** One of `GUEST_ROUTE_NAMES`. */
    route: TrimmedNonEmptyString,
    /** The raw query string without `?`, possibly empty. */
    query: Schema.String,
    headers: HeaderRecord,
    /** Body chunks follow, then `req-end`; without a body `req-end` is not sent. */
    hasBody: Schema.Boolean,
  }),
  Schema.Struct({ t: Schema.Literal("req-end"), id: RequestIdField }),
  /** The guest went away; the host stops producing the response. */
  Schema.Struct({ t: Schema.Literal("cancel"), id: RequestIdField }),
  Schema.Struct({ t: Schema.Literal("ping") }),
]);
export type ShareRelayRelayFrame = typeof ShareRelayRelayFrame.Type;

/** WebSocket close codes the relay uses on host sockets. */
export const SHARE_RELAY_CLOSE_CODES = {
  /** The relay process is restarting, not the share ending: reconnect (the next process may
      answer 4404, and then the host registers again). */
  restarting: 1012,
  /** First frame missing, late, or malformed. */
  badHello: 4400,
  /** Host key does not match the registered hash. */
  badHostKey: 4401,
  /** The relay does not know this share (e.g. after a restart): register again, then reconnect. */
  unknownShare: 4404,
  /** A newer host connection took over this share. */
  replaced: 4409,
  /** The share was deleted or expired: do not reconnect. */
  ended: 4410,
  /** The host speaks an unsupported protocol version. */
  unsupportedProtocol: 4426,
} as const;
