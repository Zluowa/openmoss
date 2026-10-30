// FILE: mcpAppResourceRoute.ts
// Purpose: Authenticated HTTP transport for on-demand MCP App resource reads.
// HTML is returned only for the active request and is never persisted here.

import { McpAppResourceReadInput, McpAppResourceReadResult } from "@synara/contracts";
import { MCP_APP_RESOURCE_READ_ROUTE_PATH } from "@synara/shared/mcpAppResource";
import { Cause, Effect, FileSystem, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { authErrorResponse, makeEffectAuthRequest } from "./auth/effectHttp";
import { AuthError, ServerAuth } from "./auth/Services/ServerAuth";
import { ServerConfig, type ServerConfigShape } from "./config";
import {
  ProviderAdapterRequestError,
  ProviderUnsupportedError,
  ProviderValidationError,
  ProviderSessionNotFoundError,
} from "./provider/Errors";
import { ProviderService } from "./provider/Services/ProviderService";
import { isLoopbackHost } from "./startupAccess";
import {
  isTrustedAppOrigin,
  normalizeCorsOrigin,
  shouldRejectAuthMutationOrigin,
} from "./trustedOrigins";

const MCP_APP_RESOURCE_JSON_BODY_MAX_BYTES = 16 * 1024;
const MCP_APP_RESOURCE_ERROR_MAX_CHARS = 500;
const MCP_APP_RESOURCE_RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

function isLegacyTokenAuthorized(input: {
  readonly config: ServerConfigShape;
  readonly url: URL;
}): boolean {
  if (!isLoopbackHost(input.config.host) || input.config.publicUrl) return false;
  const legacyToken = input.url.searchParams.get("token");
  return !input.config.authToken || legacyToken === input.config.authToken;
}

function trustedMutationCorsHeaders(input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly url: URL;
  readonly config: ServerConfigShape;
}): Record<string, string> | null {
  const rawOrigin = input.request.headers.origin;
  if (rawOrigin === undefined) return {};
  const origin = normalizeCorsOrigin(rawOrigin);
  if (!origin) return null;
  if (!isTrustedAppOrigin({ origin, requestOrigin: input.url.origin, config: input.config })) {
    return null;
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

const requireAuthenticatedMutationRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (!url) return yield* Effect.fail({ message: "Bad Request", status: 400 as const });
  const config = yield* ServerConfig;
  const serverAuth = yield* ServerAuth;
  const session = yield* serverAuth.authenticateHttpRequest(makeEffectAuthRequest(request));
  if (
    shouldRejectAuthMutationOrigin({
      rawOrigin: request.headers.origin,
      requestOrigin: url.origin,
      config,
      credentialSource: session.credentialSource,
    })
  ) {
    return yield* Effect.fail(
      new AuthError({
        message: "Trusted request origin required.",
        status: 403 as const,
      }),
    );
  }
  return session;
});

function isBodyCapacityError(cause: unknown): boolean {
  if (Cause.isExceededCapacityError(cause)) return true;
  if (cause instanceof Error && cause.message === "maxBytes exceeded") return true;
  if (!cause || typeof cause !== "object") return false;
  const record = cause as { readonly reason?: unknown; readonly cause?: unknown };
  return (
    (record.cause !== undefined && record.cause !== cause && isBodyCapacityError(record.cause)) ||
    (record.reason !== undefined && isBodyCapacityError(record.reason))
  );
}

const readJsonBody = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<
  unknown,
  { readonly status: 400 | 413; readonly message: string; readonly cause?: unknown }
> => {
  const declaredLength = Number(request.headers["content-length"] ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MCP_APP_RESOURCE_JSON_BODY_MAX_BYTES) {
    return Effect.fail({ status: 413 as const, message: "Request body too large." });
  }
  return request.json.pipe(
    Effect.provideService(
      HttpServerRequest.MaxBodySize,
      FileSystem.Size(MCP_APP_RESOURCE_JSON_BODY_MAX_BYTES),
    ),
    Effect.mapError((cause) =>
      isBodyCapacityError(cause)
        ? { status: 413 as const, message: "Request body too large.", cause }
        : { status: 400 as const, message: "Invalid MCP App resource request.", cause },
    ),
  );
};

function responseHeaders(corsHeaders: Record<string, string>): Record<string, string> {
  return { ...MCP_APP_RESOURCE_RESPONSE_HEADERS, ...corsHeaders };
}

function safeProviderError(error: unknown): {
  readonly status: 400 | 404 | 409 | 502;
  readonly message: string;
} {
  if (error instanceof ProviderAdapterRequestError) {
    return { status: 502, message: "MCP App resource provider read failed." };
  }
  if (error instanceof ProviderSessionNotFoundError) {
    return { status: 404, message: "Provider thread was not found." };
  }
  if (error instanceof ProviderUnsupportedError) {
    return { status: 409, message: "MCP App resource reads are unavailable for this provider." };
  }
  if (error instanceof ProviderValidationError) {
    return { status: 400, message: "MCP App resource request could not be routed." };
  }
  return { status: 502, message: "MCP App resource provider read failed." };
}

function safeRouteErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim().slice(0, MCP_APP_RESOURCE_ERROR_MAX_CHARS);
  }
  return "MCP App resource request failed.";
}

export const mcpAppResourceEffectRouteLayer = HttpRouter.add(
  "*",
  MCP_APP_RESOURCE_READ_ROUTE_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (!url) return HttpServerResponse.text("Bad Request", { status: 400 });

    const config = yield* ServerConfig;
    const corsHeaders = trustedMutationCorsHeaders({ request, url, config });
    if (corsHeaders === null) {
      return HttpServerResponse.jsonUnsafe(
        { error: "Trusted request origin required." },
        { status: 403, headers: responseHeaders({}) },
      );
    }
    if (request.method === "OPTIONS") {
      return HttpServerResponse.empty({ status: 204, headers: responseHeaders(corsHeaders) });
    }
    if (request.method !== "POST") {
      return HttpServerResponse.text("Method Not Allowed", {
        status: 405,
        headers: responseHeaders(corsHeaders),
      });
    }

    if (!isLegacyTokenAuthorized({ config, url })) {
      yield* requireAuthenticatedMutationRequest;
    }
    const rawPayload = yield* readJsonBody(request);
    const payload = yield* Schema.decodeUnknownEffect(McpAppResourceReadInput)(rawPayload).pipe(
      Effect.mapError(() => ({
        status: 400 as const,
        message: "Invalid MCP App resource request.",
      })),
    );
    const providerService = yield* ProviderService;
    if (typeof providerService.readMcpAppResource !== "function") {
      return HttpServerResponse.jsonUnsafe(
        { error: "MCP App resource reads are unavailable." },
        { status: 409, headers: responseHeaders(corsHeaders) },
      );
    }
    const result = yield* providerService.readMcpAppResource(payload);
    const safeResult = yield* Schema.decodeUnknownEffect(McpAppResourceReadResult)(result);
    return HttpServerResponse.jsonUnsafe(safeResult, {
      status: 200,
      headers: responseHeaders(corsHeaders),
    });
  }).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = HttpServerRequest.toURL(request);
        const config = yield* ServerConfig;
        const corsHeaders = url ? (trustedMutationCorsHeaders({ request, url, config }) ?? {}) : {};
        if (error instanceof AuthError) {
          return HttpServerResponse.setHeaders(
            authErrorResponse(error),
            responseHeaders(corsHeaders),
          );
        }
        const providerError = safeProviderError(error);
        const status =
          typeof error === "object" && error !== null && "status" in error
            ? (error as { readonly status?: unknown }).status
            : undefined;
        const resolvedStatus =
          status === 400 || status === 413
            ? status
            : error instanceof ProviderAdapterRequestError ||
                error instanceof ProviderSessionNotFoundError ||
                error instanceof ProviderUnsupportedError ||
                error instanceof ProviderValidationError
              ? providerError.status
              : 502;
        const message =
          status === 400 || status === 413
            ? safeRouteErrorMessage(error)
            : error instanceof ProviderAdapterRequestError ||
                error instanceof ProviderSessionNotFoundError ||
                error instanceof ProviderUnsupportedError ||
                error instanceof ProviderValidationError
              ? providerError.message
              : "MCP App resource request failed.";
        return HttpServerResponse.jsonUnsafe(
          { error: message },
          { status: resolvedStatus, headers: responseHeaders(corsHeaders) },
        );
      }),
    ),
  ),
);

export { MCP_APP_RESOURCE_READ_ROUTE_PATH };
