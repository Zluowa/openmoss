// FILE: accountSignInRoute.ts
// Purpose: The HTTP side of account sign-in from the owner's phone:
//   POST /api/auth/account/challenge  { realm }                        -> a one-time code
//   POST /api/auth/account/request    { realm, challengeId, deviceName } -> a pending request
//   POST /api/auth/account/status     { requestId }                     -> pending | sealed session
//   While phone access is off, or when the request names this computer by a host name rather
//   than an address (a web page that rebinds a name to it), every path here answers exactly
//   as an unknown route does. Codes, keys and tokens travel only in bodies, never URLs.
// Layer: account (server) HTTP
// Exports: accountSignInResponse, ACCOUNT_SIGN_IN_PATH_PREFIX, isAddressHost
import {
  AuthAccountChallengeInput,
  AuthAccountRequestInput,
  AuthAccountStatusInput,
} from "@moss/contracts";
import { Effect, Option, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { deriveAuthClientMetadata } from "../auth/utils";
import { ServerConfig } from "../config";
import { accountSignInAvailability } from "./Layers/MossAccountPhoneAccess";
import {
  MossAccountPhoneAccess,
  MossAccountPhoneAccessRefused,
  type MossAccountRequestSource,
} from "./Services/MossAccountPhoneAccess";

export const ACCOUNT_SIGN_IN_PATH_PREFIX = "/api/auth/account";

const decodeChallenge = Schema.decodeUnknownEffect(AuthAccountChallengeInput);
const decodeRequest = Schema.decodeUnknownEffect(AuthAccountRequestInput);
const decodeStatus = Schema.decodeUnknownEffect(AuthAccountStatusInput);

const NO_STORE = { "Cache-Control": "no-store" } as const;

const refusalResponse = (refusal: MossAccountPhoneAccessRefused) =>
  HttpServerResponse.jsonUnsafe(
    { error: refusal.message, reason: refusal.reason },
    { status: refusal.status, headers: NO_STORE },
  );

/** Exactly what the auth routes answer for a path they do not know. */
const notFound = () => HttpServerResponse.text("Not Found", { status: 404 });

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/u;

/**
 * Whether a `Host` header names this computer by an address (an IPv4 literal, a bracketed
 * IPv6 literal, or `localhost`, each with or without a port). Phones use the addresses the
 * account lists; a host name means a web page has rebound some name to this computer.
 */
export function isAddressHost(host: string | undefined): boolean {
  if (!host) return false;
  const value = host.trim().toLowerCase();
  const port = /^:\d{1,5}$/u;
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    const address = end === -1 ? "" : value.slice(1, end);
    const rest = value.slice(end + 1);
    return (
      /^[0-9a-f:.]+$/u.test(address) && address.includes(":") && (rest === "" || port.test(rest))
    );
  }
  const colon = value.indexOf(":");
  const name = colon === -1 ? value : value.slice(0, colon);
  if (colon !== -1 && !port.test(value.slice(colon))) return false;
  return name === "localhost" || IPV4.test(name);
}

const invalidPayload = HttpServerResponse.jsonUnsafe(
  { error: "Invalid account sign-in payload." },
  { status: 400, headers: NO_STORE },
);

/**
 * Answers a request under `/api/auth/account`. `readJson` is the auth routes' bounded
 * body reader, so the size limit is the same as for every other auth route.
 */
export const accountSignInResponse = <E>(input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly url: URL;
  readonly readJson: (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<unknown, E>;
}) =>
  Effect.gen(function* () {
    const { request, url } = input;
    const config = yield* ServerConfig;
    if (accountSignInAvailability(config) !== null) return notFound();
    const access = Option.getOrUndefined(yield* Effect.serviceOption(MossAccountPhoneAccess));
    if (!access) return notFound();
    if (!isAddressHost(request.headers.host)) return notFound();
    if (request.method !== "POST") {
      return HttpServerResponse.text("Method Not Allowed", { status: 405, headers: NO_STORE });
    }
    const source: MossAccountRequestSource = {
      address: request.remoteAddress ?? "unknown",
      client: deriveAuthClientMetadata({
        headers: request.headers,
        remoteAddress: request.remoteAddress ?? null,
      }),
    };
    const body = yield* input.readJson(request).pipe(Effect.option);
    if (Option.isNone(body)) return invalidPayload;

    if (url.pathname === `${ACCOUNT_SIGN_IN_PATH_PREFIX}/challenge`) {
      const payload = yield* decodeChallenge(body.value).pipe(Effect.option);
      if (Option.isNone(payload)) return invalidPayload;
      const challenge = yield* access.createChallenge({ realm: payload.value.realm, source });
      return HttpServerResponse.jsonUnsafe(challenge, { headers: NO_STORE });
    }
    if (url.pathname === `${ACCOUNT_SIGN_IN_PATH_PREFIX}/request`) {
      const payload = yield* decodeRequest(body.value).pipe(Effect.option);
      if (Option.isNone(payload)) return invalidPayload;
      const pending = yield* access.requestAccess({
        realm: payload.value.realm,
        challengeId: payload.value.challengeId,
        deviceName: payload.value.deviceName,
        source,
      });
      return HttpServerResponse.jsonUnsafe(pending, { headers: NO_STORE });
    }
    if (url.pathname === `${ACCOUNT_SIGN_IN_PATH_PREFIX}/status`) {
      const payload = yield* decodeStatus(body.value).pipe(Effect.option);
      if (Option.isNone(payload)) return invalidPayload;
      const status = yield* access.requestStatus({ requestId: payload.value.requestId, source });
      return HttpServerResponse.jsonUnsafe(status, { headers: NO_STORE });
    }
    return notFound();
  }).pipe(
    Effect.catchTag("MossAccountPhoneAccessRefused", (refusal) =>
      Effect.succeed(refusalResponse(refusal)),
    ),
  );
