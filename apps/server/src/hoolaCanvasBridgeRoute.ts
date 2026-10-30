// FILE: hoolaCanvasBridgeRoute.ts
// Purpose: Loopback-only, scoped HTTP route used by the standalone Hoola Canvas shell.

import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";

import { Cause, Effect, FileSystem } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { MossCloudAccountService } from "./account/Services/MossCloudAccountService";
import { MossEnterpriseKeyAccount } from "./account/Services/MossEnterpriseKeyAccount";
import { MossPhoneAccountService } from "./account/Services/MossPhoneAccountService";
import { MossAccountServiceError } from "./account/mossAccountErrors";
import { ServerConfig } from "./config";
import { HoolaCanvasBridgeBroker, type HoolaCanvasAuthorityCredential } from "./hoolaCanvasBridge";
import {
  HoolaCanvasSegmentsBridgeBroker,
  HoolaCanvasSegmentsBridgeError,
} from "./hoolaCanvasSegmentsBridge";
import { isTrustedMossManagedGatewayUrlForAuthority } from "./provider/mossManagedGatewayTrust";
import { isLoopbackHost } from "./startupAccess";

const BRIDGE_PREFIX = "/hoola-canvas-bridge/api/generation/jobs";
const SEGMENTS_PREFIX = "/hoola-canvas-bridge/api/segments";
const MEDIA_AUTHORIZATION_PATH = "/hoola-canvas-bridge/api/media-generation/authorize";
const BRIDGE_TOKEN_ENV_KEY = "MOSS_HOOLA_CANVAS_BRIDGE_TOKEN";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const brokers = new Map<string, HoolaCanvasBridgeBroker>();
const segmentBrokers = new Map<string, HoolaCanvasSegmentsBridgeBroker>();

function brokerForStateDirectory(stateDirectory: string): HoolaCanvasBridgeBroker {
  const existing = brokers.get(stateDirectory);
  if (existing) return existing;
  const created = new HoolaCanvasBridgeBroker({
    statePath: join(stateDirectory, "hoola-canvas-generation-jobs.json"),
  });
  brokers.set(stateDirectory, created);
  return created;
}

function segmentBrokerForStateDirectory(stateDirectory: string): HoolaCanvasSegmentsBridgeBroker {
  const existing = segmentBrokers.get(stateDirectory);
  if (existing) return existing;
  const created = new HoolaCanvasSegmentsBridgeBroker({
    statePath: join(stateDirectory, "hoola-canvas-segments.json"),
  });
  segmentBrokers.set(stateDirectory, created);
  return created;
}

function json(status: number, body: unknown) {
  return HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function bridgeAuthorized(authorization: string | undefined): boolean {
  const configured = String(process.env[BRIDGE_TOKEN_ENV_KEY] ?? "").trim();
  const match = String(authorization ?? "")
    .trim()
    .match(/^Bearer\s+([^\s]+)$/iu);
  return configured.length >= 32 && match !== null && safeEqual(configured, match[1]!);
}

function isBodyCapacityError(cause: unknown): boolean {
  if (Cause.isExceededCapacityError(cause)) return true;
  if (cause instanceof Error && cause.message === "maxBytes exceeded") return true;
  return false;
}

const readBody = (request: HttpServerRequest.HttpServerRequest) =>
  request.json.pipe(
    Effect.provideService(HttpServerRequest.MaxBodySize, FileSystem.Size(MAX_BODY_BYTES)),
    Effect.mapError((cause) => ({
      status: isBodyCapacityError(cause) ? (413 as const) : (400 as const),
      code: isBodyCapacityError(cause) ? "request_too_large" : "invalid_request",
    })),
  );

const resolveCredential = Effect.gen(function* () {
  // An enterprise key that owns the managed surface pays for Canvas jobs.
  const enterpriseResult = yield* Effect.result(
    (yield* MossEnterpriseKeyAccount).getActiveAuthorityCredential(),
  );
  if (enterpriseResult._tag === "Failure") {
    return yield* Effect.fail(new Error("account_recovery_required"));
  }
  if (enterpriseResult.success) {
    return enterpriseResult.success satisfies HoolaCanvasAuthorityCredential;
  }
  const phone = yield* MossPhoneAccountService;
  const phoneResult = yield* Effect.result(phone.getAuthorityCredential());
  if (phoneResult._tag === "Success") {
    return phoneResult.success satisfies HoolaCanvasAuthorityCredential;
  }
  if (
    !(phoneResult.failure instanceof MossAccountServiceError) ||
    phoneResult.failure.code !== "authentication_required"
  ) {
    return yield* Effect.fail(new Error("account_recovery_required"));
  }
  const cloud = yield* MossCloudAccountService;
  const cloudResult = yield* Effect.result(cloud.getAuthorityCredential());
  if (cloudResult._tag === "Failure") {
    return yield* Effect.fail(new Error("authentication_required"));
  }
  return cloudResult.success satisfies HoolaCanvasAuthorityCredential;
});

function trustedCredential(
  credential: HoolaCanvasAuthorityCredential,
): HoolaCanvasAuthorityCredential {
  if (
    !credential.accessToken.trim() ||
    /[\r\n]/u.test(credential.accessToken) ||
    !isTrustedMossManagedGatewayUrlForAuthority(
      credential.gatewayBaseUrl,
      credential.realm,
      process.env,
    )
  ) {
    throw new Error("account_recovery_required");
  }
  return credential;
}

const tryBridge = <A>(evaluate: () => A) =>
  Effect.try({
    try: evaluate,
    catch: (error) => error,
  });

const tryBridgePromise = <A>(evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (error) => error,
  });

export const hoolaCanvasBridgeEffectRouteLayer = HttpRouter.add(
  "*",
  "/hoola-canvas-bridge/*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (!url) return json(400, { success: false, code: "invalid_request" });
    const config = yield* ServerConfig;
    if (!isLoopbackHost(config.host) || config.publicUrl || request.headers.origin) {
      return json(403, { success: false, code: "bridge_loopback_only" });
    }
    if (!bridgeAuthorized(request.headers.authorization)) {
      return json(401, { success: false, code: "bridge_auth_required" });
    }
    const broker = brokerForStateDirectory(config.stateDir);
    const segmentBroker = segmentBrokerForStateDirectory(config.stateDir);

    const runMatch = url.pathname.match(
      new RegExp(`^${BRIDGE_PREFIX}/([A-Za-z0-9_-]{1,128})/run$`, "u"),
    );
    const getMatch = url.pathname.match(
      new RegExp(`^${BRIDGE_PREFIX}/([A-Za-z0-9_-]{1,128})$`, "u"),
    );
    const openMatch = url.pathname.match(
      /^\/hoola-canvas-bridge\/api\/generation\/projects\/([A-Za-z0-9_-]{1,256})\/jobs\/open$/u,
    );
    const segmentJobMatch = url.pathname.match(
      /^\/hoola-canvas-bridge\/api\/segments\/jobs\/(seg_[A-Za-z0-9_-]{16,96})$/u,
    );
    const segmentMaskMatch = url.pathname.match(
      /^\/hoola-canvas-bridge\/api\/segments\/masks\/([A-Za-z0-9_-]{1,128})$/u,
    );
    if (request.method === "POST" && url.pathname === MEDIA_AUTHORIZATION_PATH) {
      const raw = yield* readBody(request);
      const resolvedCredential = yield* resolveCredential;
      const credential = yield* tryBridge(() => trustedCredential(resolvedCredential));
      return json(200, yield* tryBridge(() => segmentBroker.authorize(raw, credential)));
    }
    if (request.method === "POST" && url.pathname === SEGMENTS_PREFIX) {
      const raw = yield* readBody(request);
      const resolvedCredential = yield* resolveCredential;
      const credential = yield* tryBridge(() => trustedCredential(resolvedCredential));
      if (
        typeof raw === "object" &&
        raw !== null &&
        "cachedOnly" in raw &&
        raw.cachedOnly === true
      ) {
        return json(200, yield* tryBridge(() => segmentBroker.cacheOnly(raw, credential)));
      }
      const result = yield* tryBridgePromise(() => segmentBroker.create(raw, credential));
      return json(result.status, result.body);
    }
    if (request.method === "GET" && segmentJobMatch) {
      const resolvedCredential = yield* resolveCredential;
      const credential = yield* tryBridge(() => trustedCredential(resolvedCredential));
      return json(
        200,
        yield* tryBridgePromise(() =>
          segmentBroker.status(
            segmentJobMatch[1]!,
            Object.fromEntries(url.searchParams),
            credential,
          ),
        ),
      );
    }
    if (request.method === "GET" && segmentMaskMatch) {
      const resolvedCredential = yield* resolveCredential;
      const credential = yield* tryBridge(() => trustedCredential(resolvedCredential));
      const jobId = String(url.searchParams.get("jobId") ?? "");
      return json(
        200,
        yield* tryBridge(() =>
          segmentBroker.mask(
            segmentMaskMatch[1]!,
            jobId,
            Object.fromEntries(url.searchParams),
            credential,
          ),
        ),
      );
    }
    if (request.method === "POST" && url.pathname === BRIDGE_PREFIX) {
      const raw = yield* readBody(request);
      const created = yield* tryBridge(() => broker.create(raw)).pipe(
        Effect.mapError((error) => ({
          status: 400,
          code:
            error instanceof Error && error.message === "unsupported_model"
              ? "unsupported_model"
              : "invalid_request",
        })),
      );
      return json(201, created);
    }
    if (request.method === "POST" && runMatch) {
      const existing = broker.get(runMatch[1]!);
      if (!existing) return json(404, { success: false, code: "job_not_found" });
      const resolvedCredential = yield* resolveCredential;
      const credential = yield* tryBridge(() => trustedCredential(resolvedCredential));
      return json(200, yield* tryBridgePromise(() => broker.run(runMatch[1]!, credential)));
    }
    if (request.method === "GET" && getMatch) {
      const existing = broker.get(getMatch[1]!);
      return existing ? json(200, existing) : json(404, { success: false, code: "job_not_found" });
    }
    if (request.method === "GET" && openMatch) {
      return json(200, { jobs: broker.open(openMatch[1]!) });
    }
    return json(404, { success: false, code: "route_not_found" });
  }).pipe(
    Effect.catch((error) => {
      const status =
        typeof error === "object" && error !== null && "status" in error
          ? Number((error as { readonly status?: unknown }).status)
          : 502;
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { readonly code?: unknown }).code)
          : error instanceof Error && error.message === "authentication_required"
            ? "authentication_required"
            : "bridge_request_failed";
      const allowedStatus =
        error instanceof HoolaCanvasSegmentsBridgeError &&
        [202, 400, 401, 402, 403, 404, 409, 413, 429, 502, 503, 504].includes(status)
          ? status
          : status === 400 || status === 413
            ? status
            : 502;
      return Effect.succeed(
        json(allowedStatus, {
          success: false,
          code,
        }),
      );
    }),
  ),
);
