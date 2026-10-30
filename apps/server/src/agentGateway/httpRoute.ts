/**
 * HTTP route for the Moss agent gateway MCP endpoint.
 *
 * Registers `POST /mcp` (streamable-HTTP MCP, stateless JSON responses) plus
 * spec-mandated method handling for GET/DELETE. Authentication is a
 * per-session bearer token minted by AgentGatewayCredentials and injected into
 * provider sessions; the global server auth stack is deliberately not used
 * here because provider child processes have no session cookies.
 *
 * @module agentGateway/httpRoute
 */
import { Effect, Exit, Layer, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { AGENT_GATEWAY_MCP_PATH } from "./Layers/AgentGatewayCredentials";
import { AgentGateway } from "./Services/AgentGateway";
import { AgentGatewayCredentials } from "./Services/AgentGatewayCredentials";
import { extractBearerToken } from "./bearerToken.ts";
import {
  classifyAgentGatewayMcpMethod,
  fingerprintAgentGatewaySession,
  observeAgentGatewayMcpBoundary,
} from "./mcpObservability.ts";

export const AGENT_GATEWAY_MCP_MAX_BODY_BYTES = 1024 * 1024;
export const AGENT_GATEWAY_STDIO_BOOTSTRAP_PATH = `${AGENT_GATEWAY_MCP_PATH}/bootstrap`;

const BODY_TOO_LARGE = Symbol("AgentGatewayMcpBodyTooLarge");

function observeRouteBoundary(input: {
  readonly phase: "request" | "response";
  readonly stage: "auth" | "body" | "response";
  readonly httpStatus: number | null;
  readonly outcome: "pending" | "accepted" | "rejected" | "failed";
  readonly reasonCode: Parameters<typeof observeAgentGatewayMcpBoundary>[0]["reasonCode"];
  readonly methodClass: Parameters<typeof observeAgentGatewayMcpBoundary>[0]["methodClass"];
  readonly sessionFingerprint?: string;
  readonly durationMs?: number;
}) {
  return observeAgentGatewayMcpBoundary(input);
}

export type McpBodyReadResult =
  | { readonly kind: "ok"; readonly body: unknown }
  | { readonly kind: "invalid" }
  | { readonly kind: "too-large" };

export function readMcpJsonBody(
  request: HttpServerRequest.HttpServerRequest,
  maxBytes = AGENT_GATEWAY_MCP_MAX_BODY_BYTES,
): Effect.Effect<McpBodyReadResult> {
  const declaredLength = Number.parseInt(request.headers["content-length"] ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return Effect.succeed({ kind: "too-large" });
  }

  return request.stream.pipe(
    Stream.runFoldEffect(
      () => ({ chunks: [] as Buffer[], totalBytes: 0 }),
      (state, chunk) => {
        const totalBytes = state.totalBytes + chunk.byteLength;
        if (totalBytes > maxBytes) {
          return Effect.fail(BODY_TOO_LARGE);
        }
        state.chunks.push(Buffer.from(chunk));
        return Effect.succeed({ chunks: state.chunks, totalBytes });
      },
    ),
    Effect.flatMap(({ chunks, totalBytes }) =>
      Effect.try({
        try: () => ({
          kind: "ok" as const,
          body: JSON.parse(Buffer.concat(chunks, totalBytes).toString("utf8")) as unknown,
        }),
        catch: () => new Error("Invalid JSON body."),
      }),
    ),
    Effect.catch((error) =>
      Effect.succeed<McpBodyReadResult>(
        error === BODY_TOO_LARGE ? { kind: "too-large" } : { kind: "invalid" },
      ),
    ),
  );
}

function unauthorizedResponse() {
  return HttpServerResponse.jsonUnsafe(
    {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32600,
        message:
          "caller_session_inactive: Missing, revoked, or invalid provider-session credential.",
      },
    },
    { status: 401 },
  );
}

const postRouteLayer = HttpRouter.add(
  "POST",
  AGENT_GATEWAY_MCP_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const gateway = yield* AgentGateway;
    const credentials = yield* AgentGatewayCredentials;
    const requestStartedAt = Date.now();
    const token = extractBearerToken(request.headers.authorization);
    const sessionFingerprint = fingerprintAgentGatewaySession(token);
    yield* observeRouteBoundary({
      phase: "request",
      stage: "auth",
      httpStatus: null,
      outcome: "pending",
      reasonCode: "request-started",
      methodClass: "other",
      ...(sessionFingerprint ? { sessionFingerprint } : {}),
    });
    if (!token || credentials.verifySession(token) === null) {
      yield* observeRouteBoundary({
        phase: "response",
        stage: "auth",
        httpStatus: 401,
        outcome: "rejected",
        reasonCode: "invalid-credential",
        methodClass: "other",
        ...(sessionFingerprint ? { sessionFingerprint } : {}),
        durationMs: Date.now() - requestStartedAt,
      });
      return unauthorizedResponse();
    }

    yield* observeRouteBoundary({
      phase: "request",
      stage: "body",
      httpStatus: null,
      outcome: "pending",
      reasonCode: "request-started",
      methodClass: "other",
      ...(sessionFingerprint ? { sessionFingerprint } : {}),
    });
    const bodyResult = yield* readMcpJsonBody(request);
    if (bodyResult.kind === "too-large") {
      yield* observeRouteBoundary({
        phase: "response",
        stage: "body",
        httpStatus: 413,
        outcome: "rejected",
        reasonCode: "payload-too-large",
        methodClass: "other",
        ...(sessionFingerprint ? { sessionFingerprint } : {}),
        durationMs: Date.now() - requestStartedAt,
      });
      return HttpServerResponse.jsonUnsafe(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Request body exceeds the 1 MiB limit." },
        },
        { status: 413 },
      );
    }
    if (bodyResult.kind === "invalid") {
      yield* observeRouteBoundary({
        phase: "response",
        stage: "body",
        httpStatus: 400,
        outcome: "rejected",
        reasonCode: "invalid-jsonrpc",
        methodClass: "other",
        ...(sessionFingerprint ? { sessionFingerprint } : {}),
        durationMs: Date.now() - requestStartedAt,
      });
      return HttpServerResponse.jsonUnsafe(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON body." } },
        { status: 400 },
      );
    }
    const methodClass = classifyAgentGatewayMcpMethod(
      bodyResult.body !== null &&
        typeof bodyResult.body === "object" &&
        !Array.isArray(bodyResult.body)
        ? (bodyResult.body as Record<string, unknown>).method
        : Array.isArray(bodyResult.body) && bodyResult.body.length > 0
          ? ((bodyResult.body[0] as Record<string, unknown> | null)?.method ?? undefined)
          : undefined,
    );
    yield* observeRouteBoundary({
      phase: "response",
      stage: "body",
      httpStatus: null,
      outcome: "accepted",
      reasonCode: "accepted",
      methodClass,
      ...(sessionFingerprint ? { sessionFingerprint } : {}),
      durationMs: Date.now() - requestStartedAt,
    });
    const resultExit = yield* Effect.exit(
      gateway.handleMcpPost({
        authorizationHeader: request.headers.authorization,
        body: bodyResult.body,
      }),
    );
    if (Exit.isFailure(resultExit)) {
      yield* observeRouteBoundary({
        phase: "response",
        stage: "response",
        httpStatus: 500,
        outcome: "failed",
        reasonCode: "route-response-failure",
        methodClass,
        ...(sessionFingerprint ? { sessionFingerprint } : {}),
        durationMs: Date.now() - requestStartedAt,
      });
      return HttpServerResponse.jsonUnsafe(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: "Moss MCP request could not be handled." },
        },
        { status: 500 },
      );
    }
    const result = resultExit.value;
    if (result.body === undefined) {
      return HttpServerResponse.empty({ status: result.status });
    }
    return HttpServerResponse.jsonUnsafe(result.body, { status: result.status });
  }),
);

const stdioBootstrapRouteLayer = HttpRouter.add(
  "POST",
  AGENT_GATEWAY_STDIO_BOOTSTRAP_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const credentials = yield* AgentGatewayCredentials;
    const bootstrapToken = extractBearerToken(request.headers.authorization);
    const bearerToken = bootstrapToken
      ? credentials.exchangeStdioBootstrapToken(bootstrapToken)
      : null;
    if (bearerToken === null) return unauthorizedResponse();
    return HttpServerResponse.jsonUnsafe(
      { bearerToken },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
          Pragma: "no-cache",
        },
      },
    );
  }),
);

// The streamable-HTTP transport allows servers to reject GET (no
// server-initiated stream) with 405; DELETE is session teardown, and this
// server is stateless, so both are explicit non-endpoints.
const getRouteLayer = HttpRouter.add(
  "GET",
  AGENT_GATEWAY_MCP_PATH,
  Effect.succeed(
    HttpServerResponse.text("Method Not Allowed", {
      status: 405,
      headers: { Allow: "POST" },
    }),
  ),
);

const deleteRouteLayer = HttpRouter.add(
  "DELETE",
  AGENT_GATEWAY_MCP_PATH,
  Effect.succeed(HttpServerResponse.empty({ status: 405 })),
);

export const agentGatewayRouteLayer = Layer.mergeAll(
  postRouteLayer,
  stdioBootstrapRouteLayer,
  getRouteLayer,
  deleteRouteLayer,
);
