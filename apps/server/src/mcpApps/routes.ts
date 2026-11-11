// FILE: routes.ts
// Purpose: Authenticated HTTP endpoints a widget host calls (PLAN §2.2): the full tool result,
//   widget JSON-RPC, model context and resource downloads. Same auth, trusted-origin CORS and
//   body-cap rules as the resource read route; every body is schema-decoded.
// Layer: Server HTTP routes (Effect)
// Exports: mcpAppsRouteLayer

import {
  McpAppModelContextInput,
  McpAppResourceDownloadInput,
  McpAppRpcInput,
  McpAppToolResultInput,
} from "@moss/contracts";
import {
  MCP_APP_MODEL_CONTEXT_ROUTE_PATH,
  MCP_APP_RESOURCE_DOWNLOAD_ROUTE_PATH,
  MCP_APP_RPC_ROUTE_PATH,
  MCP_APP_TOOL_RESULT_ROUTE_PATH,
} from "@moss/shared/mcpAppResource";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { authErrorResponse } from "../auth/effectHttp";
import { AuthError } from "../auth/Services/ServerAuth";
import { ServerConfig } from "../config";
import {
  isLegacyTokenAuthorized,
  mcpAppResourceEffectRouteLayer,
  readJsonBody,
  requireAuthenticatedMutationRequest,
  responseHeaders,
  safeRouteErrorMessage,
  trustedMutationCorsHeaders,
} from "../mcpAppResourceRoute";
import {
  downloadMcpAppResource,
  McpAppRequestError,
  readMcpAppToolResult,
  runMcpAppRpc,
  updateMcpAppModelContext,
} from "./operations";

const SMALL_BODY_MAX_BYTES = 16 * 1024;
/** A widget message is at most 512 KB (desktop cap); arguments ride inside it. */
const RPC_BODY_MAX_BYTES = 640 * 1024;
/** Model context allows 917 504 bytes per view plus the envelope. */
const MODEL_CONTEXT_BODY_MAX_BYTES = 1024 * 1024;

function makeMcpAppJsonRoute<A, I, E, R>(input: {
  readonly path: HttpRouter.PathInput;
  readonly schema: Schema.Codec<A, I, never, never>;
  readonly maxBodyBytes: number;
  readonly invalidMessage: string;
  readonly handle: (payload: A) => Effect.Effect<unknown, E, R>;
}) {
  return HttpRouter.add(
    "*",
    input.path,
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
      const rawPayload = yield* readJsonBody(request, input.maxBodyBytes);
      const payload = yield* Schema.decodeUnknownEffect(input.schema)(rawPayload).pipe(
        Effect.mapError(() => ({ status: 400 as const, message: input.invalidMessage })),
      );
      const result = yield* input.handle(payload);
      return HttpServerResponse.jsonUnsafe(result, {
        status: 200,
        headers: responseHeaders(corsHeaders),
      });
    }).pipe(
      Effect.catch((error: unknown) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const url = HttpServerRequest.toURL(request);
          const config = yield* ServerConfig;
          const corsHeaders = url
            ? (trustedMutationCorsHeaders({ request, url, config }) ?? {})
            : {};
          if (error instanceof AuthError) {
            return HttpServerResponse.setHeaders(
              authErrorResponse(error),
              responseHeaders(corsHeaders),
            );
          }
          if (error instanceof McpAppRequestError) {
            return HttpServerResponse.jsonUnsafe(
              { error: error.message },
              { status: error.status, headers: responseHeaders(corsHeaders) },
            );
          }
          const status =
            typeof error === "object" && error !== null && "status" in error
              ? (error as { readonly status?: unknown }).status
              : undefined;
          if (status === 400 || status === 413) {
            return HttpServerResponse.jsonUnsafe(
              { error: safeRouteErrorMessage(error) },
              { status, headers: responseHeaders(corsHeaders) },
            );
          }
          return HttpServerResponse.jsonUnsafe(
            { error: "The interactive connector request failed." },
            { status: 502, headers: responseHeaders(corsHeaders) },
          );
        }),
      ),
    ),
  );
}

export const mcpAppToolResultRouteLayer = makeMcpAppJsonRoute({
  path: MCP_APP_TOOL_RESULT_ROUTE_PATH,
  schema: McpAppToolResultInput,
  maxBodyBytes: SMALL_BODY_MAX_BYTES,
  invalidMessage: "Invalid tool result request.",
  handle: readMcpAppToolResult,
});

export const mcpAppRpcRouteLayer = makeMcpAppJsonRoute({
  path: MCP_APP_RPC_ROUTE_PATH,
  schema: McpAppRpcInput,
  maxBodyBytes: RPC_BODY_MAX_BYTES,
  invalidMessage: "Invalid widget request.",
  handle: runMcpAppRpc,
});

export const mcpAppModelContextRouteLayer = makeMcpAppJsonRoute({
  path: MCP_APP_MODEL_CONTEXT_ROUTE_PATH,
  schema: McpAppModelContextInput,
  maxBodyBytes: MODEL_CONTEXT_BODY_MAX_BYTES,
  invalidMessage: "Invalid model context request.",
  handle: updateMcpAppModelContext,
});

export const mcpAppResourceDownloadRouteLayer = makeMcpAppJsonRoute({
  path: MCP_APP_RESOURCE_DOWNLOAD_ROUTE_PATH,
  schema: McpAppResourceDownloadInput,
  maxBodyBytes: SMALL_BODY_MAX_BYTES,
  invalidMessage: "Invalid download request.",
  handle: downloadMcpAppResource,
});

/** Every interactive-connector endpoint; mounted once in `makeEffectHttpRouteLayer`. */
export const mcpAppsRouteLayer = Layer.mergeAll(
  mcpAppResourceEffectRouteLayer,
  mcpAppToolResultRouteLayer,
  mcpAppRpcRouteLayer,
  mcpAppModelContextRouteLayer,
  mcpAppResourceDownloadRouteLayer,
);
