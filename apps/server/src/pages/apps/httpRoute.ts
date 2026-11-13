// FILE: httpRoute.ts
// Purpose: HTTP surface of 应用页.
//   /api/page-apps/<op>   JSON for the Moss shell (owner session); `watch`
//                         answers as Server-Sent Events.
//   /__moss_app/frame     the page's HTML on its own `*.moss-app.localhost`
//                         origin, behind a frame token and a strict CSP.
//   /__moss_app/isolated  the same on an opaque origin (non-loopback servers).
// Layer: Server pages/apps

import { timingSafeEqual } from "node:crypto";

import {
  PAGE_APP_CONTENT_PATH,
  PAGE_APP_FALLBACK_CONTENT_PATH,
  PAGE_APP_FRAME_TOKEN_TTL_MS,
  PageAppId,
  PageAppsOpenFrameInput,
  type PageAppViewer,
} from "@moss/contracts";
import {
  buildPageAppFrameRuntime,
  injectPageAppFrameRuntime,
} from "@moss/shared/pageAppFrameRuntime";
import { Effect, FileSystem, Layer, Schema, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { authErrorResponse, makeEffectAuthRequest } from "../../auth/effectHttp";
import { ServerAuth } from "../../auth/Services/ServerAuth";
import { ServerConfig } from "../../config";
import { isLocalOnlyAccess, requestPeer } from "../../startupAccess";
import { readInlineVisualizationLibrary } from "../../inlineVisualizationAccess";
import {
  isTrustedAppOrigin,
  normalizeCorsOrigin,
  shouldRejectAuthMutationOrigin,
  shouldRejectUntrustedRequestOrigin,
} from "../../trustedOrigins";
import {
  isPageAppHost,
  pageAppErrorHtml,
  pageAppFrameHeaders,
  pageAppFrameLocation,
  pageAppIdFromHost,
} from "./frameServing";
import { PAGE_APP_EXTENSION_HTTP_STATUS, pageAppAssetsRouteLayer } from "./extensions/assetRoute";
import { LOCAL_OWNER_VIEWER, PageAppsService, type PageAppsServiceError } from "./PageAppsService";
import { preparePageAppLibraries } from "./localLibraries";

const API_PREFIX = "/api/page-apps/";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const LOCAL_PRINCIPAL = { kind: "local-user" } as const;

const STATUS: Record<string, number> = {
  invalid_argument: 400,
  not_found: 404,
  conflict: 409,
  not_declared: 403,
  not_granted: 403,
  unavailable: 503,
  resource_exhausted: 429,
  quota_exceeded: 409,
  revoked: 410,
  authentication_required: 401,
  upstream_error: 502,
  cancelled: 499,
  storage: 500,
  ...PAGE_APP_EXTENSION_HTTP_STATUS,
};

const errorBody = (error: PageAppsServiceError) => ({
  error: {
    code: error.code,
    message: error.message,
    ...(error.currentRevision === undefined ? {} : { currentRevision: error.currentRevision }),
  },
});

export const pageAppsApiRouteLayer = HttpRouter.add(
  "*",
  `${API_PREFIX}*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const config = yield* ServerConfig;
    if (!url)
      return HttpServerResponse.jsonUnsafe(
        { error: { code: "invalid_argument" } },
        { status: 400 },
      );
    // Pages run on these hosts; they never reach the API, even same-origin.
    if (isPageAppHost(request.headers.host))
      return HttpServerResponse.text("Not Found", { status: 404 });
    const origin = normalizeCorsOrigin(request.headers.origin);
    const trustedOrigin =
      origin && isTrustedAppOrigin({ origin, requestOrigin: url.origin, config });
    const headers: Record<string, string> = {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(trustedOrigin
        ? {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Credentials": "true",
            Vary: "Origin",
          }
        : {}),
    };
    const json = (status: number, body: unknown) =>
      HttpServerResponse.jsonUnsafe(body, { status, headers });
    if (request.method === "OPTIONS")
      return trustedOrigin
        ? HttpServerResponse.empty({
            status: 204,
            headers: {
              ...headers,
              "Access-Control-Allow-Methods": "POST, OPTIONS",
              "Access-Control-Allow-Headers": "authorization, content-type",
            },
          })
        : json(403, { error: { code: "trusted_origin_required" } });
    if (request.method !== "POST") return json(405, { error: { code: "invalid_argument" } });

    const auth = yield* ServerAuth;
    const startupBearer = request.headers.authorization?.startsWith("Bearer ")
      ? request.headers.authorization.slice("Bearer ".length)
      : null;
    const supplied = Buffer.from(url.searchParams.get("token") ?? startupBearer ?? "");
    const configured = Buffer.from(config.authToken ?? "");
    // Same rule as Moss's other local routes: a loopback server without a
    // token, or the desktop's startup token, is the owner.
    const desktopTokenAuthorized =
      isLocalOnlyAccess(config, requestPeer(request)) &&
      (configured.length === 0 ||
        (supplied.length === configured.length && timingSafeEqual(supplied, configured)));
    const authenticated = desktopTokenAuthorized
      ? null
      : yield* Effect.result(auth.authenticateHttpRequest(makeEffectAuthRequest(request)));
    if (authenticated !== null && authenticated._tag === "Failure")
      return authErrorResponse(authenticated.failure, headers);
    const session = authenticated === null ? null : authenticated.success;
    if (
      shouldRejectUntrustedRequestOrigin({
        rawOrigin: request.headers.origin,
        requestOrigin: url.origin,
        config,
      }) ||
      shouldRejectAuthMutationOrigin({
        rawOrigin: request.headers.origin,
        requestOrigin: url.origin,
        config,
        credentialSource: session?.credentialSource ?? "bearer",
      })
    )
      return json(403, { error: { code: "trusted_origin_required" } });
    // Paired clients see pages read-only; the owner of this Moss holds every level.
    const viewer: PageAppViewer =
      session === null || session.role === "owner"
        ? LOCAL_OWNER_VIEWER
        : { id: `client:${session.sessionId}`, name: "访客", level: "view", isOwner: false };

    const body: unknown = yield* request.json.pipe(
      Effect.provideService(HttpServerRequest.MaxBodySize, FileSystem.Size(MAX_BODY_BYTES)),
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (body === undefined)
      return json(400, { error: { code: "invalid_argument", message: "Body must be JSON." } });
    const service = yield* PageAppsService;
    const op = url.pathname.slice(API_PREFIX.length);
    const respond = <A>(effect: Effect.Effect<A, PageAppsServiceError>) =>
      effect.pipe(
        Effect.map((value) => json(200, value)),
        Effect.catch((error) => Effect.succeed(json(STATUS[error.code] ?? 500, errorBody(error)))),
      );
    const ownerOnly = viewer.isOwner
      ? null
      : json(403, { error: { code: "not_granted", message: "Only the owner may change 应用页." } });
    switch (op) {
      case "list":
        return yield* respond(service.list(body as never, LOCAL_PRINCIPAL));
      case "read":
        return yield* respond(service.read(body as never, LOCAL_PRINCIPAL));
      case "versions":
        return yield* respond(service.versions(body as never, LOCAL_PRINCIPAL));
      case "mutate":
        return ownerOnly ?? (yield* respond(service.mutate(body as never, LOCAL_PRINCIPAL)));
      case "consent":
        return yield* respond(service.consent(body as never, viewer));
      case "call":
        return yield* respond(service.call(body as never, LOCAL_PRINCIPAL, viewer));
      case "open-frame": {
        const decoded = Schema.decodeUnknownExit(PageAppsOpenFrameInput)(body);
        if (decoded._tag === "Failure")
          return json(400, {
            error: { code: "invalid_argument", message: "Malformed open-frame." },
          });
        const input = decoded.value;
        return yield* respond(
          Effect.gen(function* () {
            const read = yield* service.read(
              { appId: input.appId, ...(input.revision ? { revision: input.revision } : {}) },
              LOCAL_PRINCIPAL,
            );
            const consent = yield* service.consent({ op: "get", appId: input.appId }, viewer);
            const expiresAt = Date.now() + PAGE_APP_FRAME_TOKEN_TTL_MS;
            const token = service.mintFrameToken({
              appId: read.app.id,
              revision: read.revision,
              parentOrigin: input.parentOrigin,
              mode: input.mode,
              expiresAt,
            });
            const location = pageAppFrameLocation({ serverUrl: url, appId: read.app.id, token });
            const libraries = yield* Effect.promise(() =>
              preparePageAppLibraries(read.html, config.staticDir, readInlineVisualizationLibrary),
            );
            return {
              app: read.app,
              revision: read.revision,
              capabilities: read.capabilities,
              ...location,
              expiresAt: new Date(expiresAt).toISOString(),
              viewer,
              offlineReady: libraries.offlineReady,
              consent: consent.consent,
            };
          }),
        );
      }
      case "watch": {
        const encoder = new TextEncoder();
        const events = service.watch(body as never, LOCAL_PRINCIPAL, viewer).pipe(
          Stream.map((event) => encoder.encode(`data: ${JSON.stringify(event.value)}\n\n`)),
          Stream.catch((error: PageAppsServiceError) =>
            Stream.succeed(
              encoder.encode(`event: error\ndata: ${JSON.stringify(errorBody(error).error)}\n\n`),
            ),
          ),
          Stream.concat(Stream.succeed(encoder.encode("event: end\ndata: {}\n\n"))),
        );
        return HttpServerResponse.stream(events, {
          status: 200,
          contentType: "text/event-stream; charset=utf-8",
          headers: { ...headers, "X-Accel-Buffering": "no" },
        });
      }
      default:
        return json(404, { error: { code: "not_found", message: "Unknown 应用页 operation." } });
    }
  }),
);

const frameHandler = (opaque: boolean) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const html = (status: number, body: string, parentOrigin = "null") =>
      HttpServerResponse.text(body, {
        status,
        contentType: "text/html; charset=utf-8",
        headers: pageAppFrameHeaders({ parentOrigin, opaque: true }),
      });
    if (!url) return html(400, pageAppErrorHtml("无法打开这个应用页。"));
    const service = yield* PageAppsService;
    const payload = service.verifyFrameToken(url.searchParams.get("t") ?? "");
    if (!payload) return html(403, pageAppErrorHtml("这个应用页链接已失效，请重新打开。"));
    const hostAppId = pageAppIdFromHost(request.headers.host);
    // Own-origin pages must arrive on their own host; the opaque route on any other.
    if (opaque ? hostAppId !== null : hostAppId !== payload.appId.toLowerCase())
      return html(403, pageAppErrorHtml("这个应用页链接已失效，请重新打开。"));
    const content = yield* Effect.result(
      service.frameContent(PageAppId.makeUnsafe(payload.appId), payload.revision),
    );
    if (content._tag === "Failure")
      return html(404, pageAppErrorHtml("这个应用页不存在或已移到回收站。"));
    const runtime = buildPageAppFrameRuntime({ parentOrigin: payload.parentOrigin });
    const config = yield* ServerConfig;
    const libraries = yield* Effect.promise(() =>
      preparePageAppLibraries(
        content.success.html,
        config.staticDir,
        readInlineVisualizationLibrary,
      ),
    );
    return HttpServerResponse.text(injectPageAppFrameRuntime(libraries.html, runtime), {
      status: 200,
      contentType: "text/html; charset=utf-8",
      headers: pageAppFrameHeaders({ parentOrigin: payload.parentOrigin, opaque }),
    });
  });

export const pageAppsRouteLayer = Layer.mergeAll(
  pageAppsApiRouteLayer,
  HttpRouter.add("GET", PAGE_APP_CONTENT_PATH, frameHandler(false)),
  HttpRouter.add("GET", PAGE_APP_FALLBACK_CONTENT_PATH, frameHandler(true)),
  pageAppAssetsRouteLayer,
);
