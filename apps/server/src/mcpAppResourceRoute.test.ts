// Integration tests for the authenticated MCP App resource transport.
// These tests exercise the production Effect route through a real HTTP listener
// so auth, origin, body-cap, provider errors, and response headers are covered
// together at the boundary.
import http from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  McpAppResourceReadResult,
  ThreadId,
  type McpAppResourceReadInput,
} from "@synara/contracts";
import { MCP_APP_RESOURCE_READ_ROUTE_PATH } from "@synara/shared/mcpAppResource";
import { DateTime, Effect, Exit, Layer, Schema, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { describe, expect, it } from "vitest";

import { AuthError, ServerAuth, type ServerAuthShape } from "./auth/Services/ServerAuth";
import { ServerConfig, type ServerConfigShape } from "./config";
import { ProviderAdapterRequestError } from "./provider/Errors";
import { ProviderService, type ProviderServiceShape } from "./provider/Services/ProviderService";
import { mcpAppResourceEffectRouteLayer } from "./mcpAppResourceRoute";
import { DESKTOP_APP_CORS_ORIGINS } from "./trustedOrigins";

const DESKTOP_APP_CORS_ORIGIN = [...DESKTOP_APP_CORS_ORIGINS][0]!;

const routePath = MCP_APP_RESOURCE_READ_ROUTE_PATH;
const startupToken = "route-startup-token";

function makeServerConfig(
  overrides: Partial<Pick<ServerConfigShape, "host" | "publicUrl" | "authToken">> = {},
): ServerConfigShape {
  return {
    host: "127.0.0.1",
    publicUrl: undefined,
    authToken: startupToken,
    ...overrides,
  } as ServerConfigShape;
}

function makeServerAuth(): ServerAuthShape {
  const expiresAt = Effect.runSync(DateTime.now);
  const descriptor = {
    policy: "loopback-browser" as const,
    bootstrapMethods: ["one-time-token" as const],
    sessionMethods: ["browser-session-cookie" as const, "bearer-session-token" as const],
    sessionCookieName: "moss_session",
  };
  const session = {
    sessionId: AuthSessionId.makeUnsafe("11111111-1111-4111-8111-111111111111"),
    subject: "owner",
    method: "browser-session-cookie" as const,
    role: "owner" as const,
    expiresAt,
  };

  return {
    getDescriptor: () => Effect.succeed(descriptor),
    getSessionState: () => Effect.succeed({ authenticated: false, auth: descriptor }),
    exchangeBootstrapCredential: () =>
      Effect.succeed({
        response: {
          authenticated: true,
          role: "owner" as const,
          sessionMethod: "browser-session-cookie" as const,
          expiresAt,
        },
        sessionToken: "cookie-token",
      }),
    exchangeBootstrapCredentialForBearerSession: () =>
      Effect.succeed({
        authenticated: true,
        role: "owner" as const,
        sessionMethod: "bearer-session-token" as const,
        expiresAt,
        sessionToken: "bearer-token",
      }),
    issuePairingCredential: () =>
      Effect.succeed({ id: "pairing-id", credential: "PAIRINGTOKEN", expiresAt }),
    listPairingLinks: () => Effect.succeed([]),
    revokePairingLink: () => Effect.succeed(true),
    listClientSessions: () => Effect.succeed([]),
    revokeClientSession: () => Effect.succeed(true),
    revokeOtherClientSessions: () => Effect.succeed(0),
    logoutSession: () => Effect.succeed(true),
    authenticateHttpRequest: (request) => {
      const bearer = request.headers.authorization === "Bearer bearer-token";
      const cookie = request.cookies.moss_session === "cookie-token";
      if (!bearer && !cookie) {
        return Effect.fail(new AuthError({ message: "Authentication required.", status: 401 }));
      }
      return Effect.succeed({
        ...session,
        method: bearer ? ("bearer-session-token" as const) : session.method,
        credentialSource: bearer ? ("bearer" as const) : ("cookie" as const),
      });
    },
    authenticateWebSocketUpgrade: () =>
      Effect.fail(new AuthError({ message: "Not used in MCP App route tests.", status: 401 })),
    issueWebSocketToken: () => Effect.succeed({ token: "ws-token", expiresAt }),
    issueStartupPairingUrl: () => Effect.succeed("http://127.0.0.1:3773/pair#token=PAIRINGTOKEN"),
  } satisfies ServerAuthShape;
}

function makeInput(): McpAppResourceReadInput {
  return {
    threadId: ThreadId.makeUnsafe("thread-mcp-route"),
    callId: "call-mcp-route",
    server: "codex_apps",
    resourceUri: "ui://widget/route",
    source: "appContext",
    connectorId: "connector/route",
  };
}

function makeNoContentProvider(calls: McpAppResourceReadInput[]): ProviderServiceShape {
  return {
    readMcpAppResource: (input: McpAppResourceReadInput) =>
      Effect.sync(() => {
        calls.push(input);
        return {
          state: "no_content" as const,
          resourceUri: input.resourceUri,
        };
      }),
  } as unknown as ProviderServiceShape;
}

function makeReadyProvider(
  calls: McpAppResourceReadInput[],
  html = "<main>safe</main>",
  sizeBytes = Buffer.byteLength(html, "utf8"),
): ProviderServiceShape {
  return {
    readMcpAppResource: (input: McpAppResourceReadInput) =>
      Effect.sync(() => {
        calls.push(input);
        return {
          state: "ready" as const,
          resourceUri: input.resourceUri,
          html,
          sizeBytes,
          mimeType: "text/html" as const,
          csp: {
            baseUriDomains: [],
            connectDomains: [],
            frameDomains: [],
            includeDefaultDomains: true,
            isTrusted: false,
            resourceDomains: [],
          },
          prefersBorder: false,
          isCollapsible: true,
          widgetDomain: null,
          originCallId: input.callId,
        };
      }),
  } as unknown as ProviderServiceShape;
}

async function withRouteServer(
  config: ServerConfigShape,
  providerService: ProviderServiceShape,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const scope = await Effect.runPromise(Scope.make("sequential"));
  let nodeServer: http.Server | null = null;
  const services = await Effect.runPromise(
    Layer.buildWithScope(
      Layer.mergeAll(
        Layer.succeed(ServerConfig, config),
        Layer.succeed(ServerAuth, makeServerAuth()),
        Layer.succeed(ProviderService, providerService),
        NodeServices.layer,
      ),
      scope,
    ),
  );

  try {
    await Effect.runPromise(
      Scope.provide(
        Effect.gen(function* () {
          const httpServer = yield* NodeHttpServer.make(
            () => {
              nodeServer = http.createServer();
              return nodeServer;
            },
            { port: 0, host: "127.0.0.1" },
          );
          yield* httpServer.serve(yield* HttpRouter.toHttpEffect(mcpAppResourceEffectRouteLayer));
        }).pipe(Effect.provideServices(services)),
        scope,
      ),
    );
    const address = (nodeServer as http.Server | null)?.address();
    if (!address || typeof address !== "object") throw new Error("Expected route server address");
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}

function routeHeaders(input: { readonly origin?: string; readonly auth?: "bearer" | "cookie" }) {
  return {
    ...(input.origin === undefined ? {} : { Origin: input.origin }),
    ...(input.auth === "bearer"
      ? { Authorization: "Bearer bearer-token" }
      : input.auth === "cookie"
        ? { Cookie: "moss_session=cookie-token" }
        : {}),
  };
}

describe("mcpAppResourceEffectRouteLayer", () => {
  it("accepts the local startup token and decodes a typed response", async () => {
    const calls: McpAppResourceReadInput[] = [];
    const input = makeInput();
    await withRouteServer(makeServerConfig(), makeReadyProvider(calls), async (origin) => {
      const response = await fetch(`${origin}${routePath}?token=${startupToken}`, {
        method: "POST",
        headers: {
          ...routeHeaders({ origin: DESKTOP_APP_CORS_ORIGIN }),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("access-control-allow-origin")).toBe(DESKTOP_APP_CORS_ORIGIN);
      const result = Schema.decodeUnknownSync(McpAppResourceReadResult)(await response.json());
      expect(result.state).toBe("ready");
      if (result.state === "ready") {
        expect(result.html).toBe("<main>safe</main>");
        expect(result.originCallId).toBe(input.callId);
      }
      expect(calls).toEqual([input]);
    });
  });

  it("requires an authenticated session when the startup token is absent or wrong", async () => {
    const calls: McpAppResourceReadInput[] = [];
    const input = makeInput();
    await withRouteServer(makeServerConfig(), makeNoContentProvider(calls), async (origin) => {
      const missing = await fetch(`${origin}${routePath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      expect(missing.status).toBe(401);

      const wrongToken = await fetch(`${origin}${routePath}?token=wrong-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      expect(wrongToken.status).toBe(401);

      const authenticated = await fetch(`${origin}${routePath}`, {
        method: "POST",
        headers: {
          ...routeHeaders({ origin, auth: "bearer" }),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      });
      expect(authenticated.status).toBe(200);
      const result = Schema.decodeUnknownSync(McpAppResourceReadResult)(await authenticated.json());
      expect(result).toEqual({ state: "no_content", resourceUri: input.resourceUri });
      expect(authenticated.headers.get("cache-control")).toBe("no-store");
      expect(authenticated.headers.get("x-content-type-options")).toBe("nosniff");
      expect(calls).toEqual([input]);

      const cookieWithoutOrigin = await fetch(`${origin}${routePath}`, {
        method: "POST",
        headers: {
          ...routeHeaders({ auth: "cookie" }),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      });
      expect(cookieWithoutOrigin.status).toBe(403);
      expect(calls).toEqual([input]);

      const bearerWithoutOrigin = await fetch(`${origin}${routePath}`, {
        method: "POST",
        headers: {
          ...routeHeaders({ auth: "bearer" }),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      });
      expect(bearerWithoutOrigin.status).toBe(200);
      expect(calls).toEqual([input, input]);
    });
  });

  it("does not let a public or non-loopback startup token bypass session auth", async () => {
    const calls: McpAppResourceReadInput[] = [];
    await withRouteServer(
      makeServerConfig({
        host: "0.0.0.0",
        publicUrl: new URL("https://moss.example.test/"),
      }),
      makeNoContentProvider(calls),
      async (origin) => {
        const bypassAttempt = await fetch(`${origin}${routePath}?token=${startupToken}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(makeInput()),
        });
        expect(bypassAttempt.status).toBe(401);
        expect(calls).toHaveLength(0);
      },
    );
  });

  it("rejects an untrusted mutation origin and serves trusted OPTIONS preflight", async () => {
    const calls: McpAppResourceReadInput[] = [];
    const input = makeInput();
    await withRouteServer(makeServerConfig(), makeNoContentProvider(calls), async (origin) => {
      const rejected = await fetch(`${origin}${routePath}?token=${startupToken}`, {
        method: "POST",
        headers: {
          ...routeHeaders({ origin: "https://evil.example.test" }),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      });
      expect(rejected.status).toBe(403);
      expect(calls).toHaveLength(0);
      expect(rejected.headers.get("access-control-allow-origin")).toBeNull();

      const opaque = await fetch(`${origin}${routePath}?token=${startupToken}`, {
        method: "POST",
        headers: {
          ...routeHeaders({ origin: "null" }),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      });
      expect(opaque.status).toBe(403);
      expect(calls).toHaveLength(0);

      const preflight = await fetch(`${origin}${routePath}`, {
        method: "OPTIONS",
        headers: { Origin: DESKTOP_APP_CORS_ORIGIN },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe(DESKTOP_APP_CORS_ORIGIN);
      expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");
      expect(calls).toHaveLength(0);

      const methodNotAllowed = await fetch(`${origin}${routePath}?token=${startupToken}`, {
        method: "GET",
        headers: { Origin: DESKTOP_APP_CORS_ORIGIN },
      });
      expect(methodNotAllowed.status).toBe(405);
      expect(methodNotAllowed.headers.get("cache-control")).toBe("no-store");
    });
  });

  it("preserves the JSON body cap as 413 and malformed input as 400", async () => {
    const calls: McpAppResourceReadInput[] = [];
    await withRouteServer(makeServerConfig(), makeNoContentProvider(calls), async (origin) => {
      const oversized = await fetch(`${origin}${routePath}?token=${startupToken}`, {
        method: "POST",
        headers: {
          ...routeHeaders({ origin: DESKTOP_APP_CORS_ORIGIN }),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ...makeInput(), padding: "x".repeat(20_000) }),
      });
      expect(oversized.status).toBe(413);
      expect(calls).toHaveLength(0);

      const malformed = await fetch(`${origin}${routePath}?token=${startupToken}`, {
        method: "POST",
        headers: {
          ...routeHeaders({ origin: DESKTOP_APP_CORS_ORIGIN }),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ...makeInput(), resourceUri: "" }),
      });
      expect(malformed.status).toBe(400);
      expect(calls).toHaveLength(0);
    });
  });

  it("redacts provider failures and reports an unavailable capability safely", async () => {
    const input = makeInput();
    const failingProvider = {
      readMcpAppResource: () =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "mcpServer/resource/read",
            detail: "<html>credential-sentinel</html>",
          }),
        ),
    } as unknown as ProviderServiceShape;
    await withRouteServer(makeServerConfig(), failingProvider, async (origin) => {
      const response = await fetch(`${origin}${routePath}?token=${startupToken}`, {
        method: "POST",
        headers: {
          ...routeHeaders({ origin: DESKTOP_APP_CORS_ORIGIN }),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      });
      expect(response.status).toBe(502);
      const body = (await response.json()) as { readonly error?: unknown };
      expect(body.error).toBe("MCP App resource provider read failed.");
      expect(JSON.stringify(body)).not.toContain("credential-sentinel");
      expect(JSON.stringify(body)).not.toContain("<html>");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    });

    await withRouteServer(makeServerConfig(), {} as ProviderServiceShape, async (origin) => {
      const response = await fetch(`${origin}${routePath}?token=${startupToken}`, {
        method: "POST",
        headers: {
          ...routeHeaders({ origin: DESKTOP_APP_CORS_ORIGIN }),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: "MCP App resource reads are unavailable.",
      });
    });
  });

  it("returns a typed too-large state and strips response metadata", async () => {
    const input = makeInput();
    const pollutedProvider = {
      readMcpAppResource: () =>
        Effect.succeed({
          state: "too_large" as const,
          resourceUri: input.resourceUri,
          sizeBytes: 10_000_001,
          rawMeta: "credential-sentinel",
          html: "<html>must-not-cross</html>",
        }),
    } as unknown as ProviderServiceShape;

    await withRouteServer(makeServerConfig(), pollutedProvider, async (origin) => {
      const response = await fetch(`${origin}${routePath}?token=${startupToken}`, {
        method: "POST",
        headers: {
          ...routeHeaders({ origin: DESKTOP_APP_CORS_ORIGIN }),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      });
      expect(response.status).toBe(200);
      const rawBody = JSON.stringify(await response.clone().json());
      expect(rawBody).not.toContain("credential-sentinel");
      expect(rawBody).not.toContain("must-not-cross");
      expect(Schema.decodeUnknownSync(McpAppResourceReadResult)(await response.json())).toEqual({
        state: "too_large",
        resourceUri: input.resourceUri,
        sizeBytes: 10_000_001,
      });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    });

    const malformedProvider = {
      readMcpAppResource: () => Effect.succeed({ state: "ready", resourceUri: input.resourceUri }),
    } as unknown as ProviderServiceShape;
    await withRouteServer(makeServerConfig(), malformedProvider, async (origin) => {
      const response = await fetch(`${origin}${routePath}?token=${startupToken}`, {
        method: "POST",
        headers: {
          ...routeHeaders({ origin: DESKTOP_APP_CORS_ORIGIN }),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      });
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: "MCP App resource request failed." });
    });

    const multibyteHtml = "你好😀";
    await withRouteServer(
      makeServerConfig(),
      makeReadyProvider([], multibyteHtml, 1),
      async (origin) => {
        const response = await fetch(`${origin}${routePath}?token=${startupToken}`, {
          method: "POST",
          headers: {
            ...routeHeaders({ origin: DESKTOP_APP_CORS_ORIGIN }),
            "Content-Type": "application/json",
          },
          body: JSON.stringify(input),
        });
        expect(response.status).toBe(502);
        expect(await response.json()).toEqual({ error: "MCP App resource request failed." });
      },
    );

    const overByteCapHtml = "😀".repeat(2_500_001);
    expect(overByteCapHtml.length).toBeLessThan(10_000_000);
    await withRouteServer(
      makeServerConfig(),
      makeReadyProvider([], overByteCapHtml),
      async (origin) => {
        const response = await fetch(`${origin}${routePath}?token=${startupToken}`, {
          method: "POST",
          headers: {
            ...routeHeaders({ origin: DESKTOP_APP_CORS_ORIGIN }),
            "Content-Type": "application/json",
          },
          body: JSON.stringify(input),
        });
        expect(response.status).toBe(502);
        expect(await response.json()).toEqual({ error: "MCP App resource request failed." });
      },
    );
  });
});
