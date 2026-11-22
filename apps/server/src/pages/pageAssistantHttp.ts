// FILE: pageAssistantHttp.ts
// Purpose: Mounts item-bound default assistant thread endpoints (`GET/PUT /api/moss/pages/:pageId/assistant-thread`)
//          and Space live update SSE stream (`GET /api/moss/pages/events`) without adding contract schema churn.
// Layer: Server HTTP routes. Uses zero sync FS calls and preserves project-space scope authorization.

import { PageId, SpaceId } from "@moss/contracts";
import { Effect, FileSystem, Layer, Queue, Schema, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { AuthError, ServerAuth } from "../auth/Services/ServerAuth";
import { authErrorResponse, makeEffectAuthRequest } from "../auth/effectHttp";
import { ServerConfig } from "../config";
import { isLocalOnlyAccess, isLoopbackStartupBearer, requestPeer } from "../startupAccess";
import {
  isTrustedAppOrigin,
  normalizeCorsOrigin,
  shouldRejectAuthMutationOrigin,
} from "../trustedOrigins";
import { getPageAssistantThread, setPageAssistantThread } from "./Layers/PagesService";
import { PagesServiceError } from "./Services/PagesService";
import { subscribePageUpdates } from "./pageEvents";

export const MOSS_PAGE_ASSISTANT_THREAD_ROUTE_PATH = "/api/moss/pages/:pageId/assistant-thread";
export const MOSS_PAGE_EVENTS_ROUTE_PATH = "/api/moss/pages/events";

const SetAssistantThreadBody = Schema.Struct({
  scopeSpaceId: Schema.optional(Schema.NullOr(SpaceId)),
  threadId: Schema.NullOr(Schema.String),
  ifUnset: Schema.optional(Schema.Boolean),
});

function corsHeadersFor(input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly url: URL;
  readonly config: {
    readonly allowPublicAccess?: boolean;
    readonly devUrl?: URL | undefined;
    readonly publicBaseUrl?: URL | undefined;
  };
  readonly methods: string;
}): Record<string, string> | null {
  const origin = normalizeCorsOrigin(input.request.headers.origin);
  if (!origin) return {};
  if (
    !isTrustedAppOrigin({ origin, requestOrigin: input.url.origin, config: input.config as never })
  ) {
    return null;
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": input.methods,
    "Access-Control-Allow-Headers": "authorization, content-type",
    Vary: "Origin",
  };
}

const authorizeHttpCall = (
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
  isMutation: boolean,
) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const peer = requestPeer(request);
    const loopbackBearer = isLoopbackStartupBearer({
      ...config,
      authorization: request.headers.authorization,
      peer,
    });
    if (loopbackBearer) return;
    if (
      !isMutation &&
      isLocalOnlyAccess(config, peer) &&
      (!config.authToken || url.searchParams.get("token") === config.authToken)
    ) {
      return;
    }
    const serverAuth = yield* ServerAuth;
    const session = yield* serverAuth.authenticateHttpRequest(makeEffectAuthRequest(request));
    if (
      isMutation &&
      shouldRejectAuthMutationOrigin({
        rawOrigin: request.headers.origin,
        requestOrigin: url.origin,
        config,
        credentialSource: session.credentialSource,
      })
    ) {
      return yield* Effect.fail({
        status: 403 as const,
        message: "Trusted request origin required.",
      });
    }
  });

function parseScopeParam(raw: string | null): SpaceId | null {
  if (!raw || raw.trim() === "" || raw === "personal" || raw === "null") return null;
  return Schema.decodeUnknownSync(SpaceId)(raw.trim());
}

function mapRouteError(error: unknown, headers: Record<string, string> = {}) {
  if (error instanceof AuthError) return authErrorResponse(error, headers);
  if (error instanceof PagesServiceError) {
    const status =
      error.code === "not-found"
        ? 404
        : error.code === "forbidden"
          ? 403
          : error.code === "conflict"
            ? 409
            : 400;
    return HttpServerResponse.jsonUnsafe(
      { error: error.message, code: error.code },
      { status, headers },
    );
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as { status: unknown }).status === "number"
  ) {
    const status = (error as { status: number }).status;
    const message =
      "message" in error && typeof (error as { message: unknown }).message === "string"
        ? (error as { message: string }).message
        : "Request failed.";
    return HttpServerResponse.jsonUnsafe({ error: message }, { status, headers });
  }
  return HttpServerResponse.jsonUnsafe(
    { error: "Page assistant request failed." },
    { status: 500, headers },
  );
}

const assistantThreadEffectHandler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (!url) return HttpServerResponse.text("Bad Request", { status: 400 });

  const config = yield* ServerConfig;
  const corsHeaders = corsHeadersFor({ request, url, config, methods: "GET, PUT, POST, OPTIONS" });
  if (corsHeaders === null) {
    return HttpServerResponse.jsonUnsafe(
      { error: "Trusted request origin required." },
      { status: 403 },
    );
  }
  if (request.method === "OPTIONS") {
    return HttpServerResponse.empty({ status: 204, headers: corsHeaders });
  }
  if (request.method !== "GET" && request.method !== "PUT" && request.method !== "POST") {
    return HttpServerResponse.text("Method Not Allowed", { status: 405, headers: corsHeaders });
  }

  const match = url.pathname.match(/^\/api\/moss\/pages\/([^/]+)\/assistant-thread$/u);
  if (!match?.[1]) {
    return HttpServerResponse.jsonUnsafe(
      { error: "Invalid pageId." },
      { status: 400, headers: corsHeaders },
    );
  }
  let pageId: PageId;
  try {
    pageId = Schema.decodeUnknownSync(PageId)(decodeURIComponent(match[1]));
  } catch {
    return HttpServerResponse.jsonUnsafe(
      { error: "Invalid pageId." },
      { status: 400, headers: corsHeaders },
    );
  }

  const isMutation = request.method !== "GET";
  yield* authorizeHttpCall(request, url, isMutation);
  const sql = yield* SqlClient.SqlClient;

  if (request.method === "GET") {
    let scopeSpaceId: SpaceId | null;
    try {
      scopeSpaceId = parseScopeParam(url.searchParams.get("scopeSpaceId"));
    } catch {
      return HttpServerResponse.jsonUnsafe(
        { error: "Invalid scopeSpaceId." },
        { status: 400, headers: corsHeaders },
      );
    }
    const result = yield* getPageAssistantThread(sql, { scopeSpaceId, pageId });
    return HttpServerResponse.jsonUnsafe(result, { status: 200, headers: corsHeaders });
  }

  const rawBody = yield* request.json.pipe(
    Effect.provideService(HttpServerRequest.MaxBodySize, FileSystem.Size(32 * 1024)),
    Effect.catch(() => Effect.succeed(null)),
  );
  let body: typeof SetAssistantThreadBody.Type;
  try {
    body = Schema.decodeUnknownSync(SetAssistantThreadBody)(rawBody);
  } catch {
    return HttpServerResponse.jsonUnsafe(
      { error: "Malformed assistant-thread body." },
      { status: 400, headers: corsHeaders },
    );
  }

  const scopeSpaceId =
    body.scopeSpaceId !== undefined
      ? body.scopeSpaceId
      : parseScopeParam(url.searchParams.get("scopeSpaceId"));
  const cleanThreadId = body.threadId === null ? null : body.threadId.trim().slice(0, 200) || null;
  if (body.threadId !== null && cleanThreadId === null) {
    return HttpServerResponse.jsonUnsafe(
      { error: "threadId cannot be empty." },
      { status: 400, headers: corsHeaders },
    );
  }

  const updated = yield* setPageAssistantThread(sql, {
    scopeSpaceId,
    pageId,
    threadId: cleanThreadId,
    ...(body.ifUnset !== undefined ? { ifUnset: body.ifUnset } : {}),
  });
  return HttpServerResponse.jsonUnsafe(updated, { status: 200, headers: corsHeaders });
}).pipe(Effect.catch((error) => Effect.succeed(mapRouteError(error))));

const pageEventsEffectHandler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (!url) return HttpServerResponse.text("Bad Request", { status: 400 });

  const config = yield* ServerConfig;
  const corsHeaders = corsHeadersFor({ request, url, config, methods: "GET, OPTIONS" });
  if (corsHeaders === null) {
    return HttpServerResponse.jsonUnsafe(
      { error: "Trusted request origin required." },
      { status: 403 },
    );
  }
  if (request.method === "OPTIONS") {
    return HttpServerResponse.empty({ status: 204, headers: corsHeaders });
  }
  if (request.method !== "GET") {
    return HttpServerResponse.text("Method Not Allowed", { status: 405, headers: corsHeaders });
  }

  yield* authorizeHttpCall(request, url, false);

  let scopeSpaceId: SpaceId | null;
  let filterPageId: string | null = null;
  try {
    scopeSpaceId = parseScopeParam(url.searchParams.get("scopeSpaceId"));
    const rawPageId = url.searchParams.get("pageId")?.trim();
    if (rawPageId) {
      filterPageId = Schema.decodeUnknownSync(PageId)(rawPageId);
    }
  } catch {
    return HttpServerResponse.jsonUnsafe(
      { error: "Invalid filter parameters." },
      { status: 400, headers: corsHeaders },
    );
  }

  const encoder = new TextEncoder();
  const formatEvent = (payload: { readonly type?: string }) =>
    encoder.encode(
      payload.type === "page-updated"
        ? `event: page-updated\ndata: ${JSON.stringify(payload)}\n\n`
        : `data: ${JSON.stringify(payload)}\n\n`,
    );
  const keepaliveBytes = encoder.encode(": keepalive\n\n");

  const stream = Stream.callback<Uint8Array>((queue) =>
    Effect.gen(function* () {
      Queue.offerUnsafe(queue, formatEvent({ type: "ready" }));
      const unsubscribe = subscribePageUpdates((event) => {
        if ((event.scopeSpaceId ?? null) !== (scopeSpaceId ?? null)) return;
        if (filterPageId && event.pageId !== filterPageId) return;
        Queue.offerUnsafe(queue, formatEvent(event));
      });
      const timer = setInterval(() => {
        Queue.offerUnsafe(queue, keepaliveBytes);
      }, 25_000);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          clearInterval(timer);
          unsubscribe();
        }),
      );
    }),
  );

  return HttpServerResponse.stream(stream, {
    status: 200,
    contentType: "text/event-stream; charset=utf-8",
    headers: {
      ...corsHeaders,
      "Cache-Control": "no-cache",
    },
  });
}).pipe(Effect.catch((error) => Effect.succeed(mapRouteError(error))));

export const pageAssistantEffectRouteLayer = Layer.mergeAll(
  HttpRouter.add("*", MOSS_PAGE_ASSISTANT_THREAD_ROUTE_PATH, assistantThreadEffectHandler),
  HttpRouter.add("*", MOSS_PAGE_EVENTS_ROUTE_PATH, pageEventsEffectHandler),
);
