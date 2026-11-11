// FILE: mcpAppResourceRoute.mount.test.ts
// Purpose: Regression guard for the 2026-10-02 wiring loss. Builds the production
// `makeEffectHttpRouteLayer` (the exact route set `effectServer.ts` serves) and checks that
// every MCP App endpoint answers through it, instead of mounting the route layer by hand as
// the unit route tests do.
import http from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, type McpAppResourceReadInput } from "@moss/contracts";
import {
  MCP_APP_MODEL_CONTEXT_ROUTE_PATH,
  MCP_APP_RESOURCE_DOWNLOAD_ROUTE_PATH,
  MCP_APP_RESOURCE_READ_ROUTE_PATH,
  MCP_APP_RPC_ROUTE_PATH,
  MCP_APP_TOOL_RESULT_ROUTE_PATH,
} from "@moss/shared/mcpAppResource";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect, Exit, Layer, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { describe, expect, it } from "vitest";

import { ServerAuth, type ServerAuthShape } from "./auth/Services/ServerAuth";
import { ServerConfig, type ServerConfigShape } from "./config";
import { makeEffectHttpRouteLayer } from "./http";
import { makeMcpAppServiceState } from "./mcpApps/Layers/McpAppService";
import { McpAppService } from "./mcpApps/Services/McpAppService";
import { ProviderService, type ProviderServiceShape } from "./provider/Services/ProviderService";
import { makeServerReadiness } from "./server/readiness";
import { makeServerShutdownController } from "./serverShutdown";
import { DESKTOP_APP_CORS_ORIGINS } from "./trustedOrigins";

const startupToken = "mount-startup-token";
const desktopOrigin = [...DESKTOP_APP_CORS_ORIGINS][0]!;

async function withProductionRoutes(
  providerService: ProviderServiceShape,
  run: (origin: string) => Promise<void>,
  options: { readonly withMcpApps?: boolean } = {},
): Promise<void> {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "moss-mount-"));
  const scope = await Effect.runPromise(Scope.make("sequential"));
  let nodeServer: http.Server | null = null;
  const config = {
    host: "127.0.0.1",
    publicUrl: undefined,
    authToken: startupToken,
  } as ServerConfigShape;
  const services = await Effect.runPromise(
    Layer.buildWithScope(
      Layer.mergeAll(
        Layer.succeed(ServerConfig, config),
        // The legacy loopback token authorizes these requests; auth is never consulted.
        Layer.succeed(ServerAuth, {} as ServerAuthShape),
        Layer.succeed(ProviderService, providerService),
        ...(options.withMcpApps
          ? [
              Layer.succeed(
                McpAppService,
                makeMcpAppServiceState({ resultsDirectory: path.join(stateDir, "results") }),
              ),
            ]
          : []),
        NodeServices.layer,
      ),
      scope,
    ),
  );
  try {
    await Effect.runPromise(
      Scope.provide(
        Effect.gen(function* () {
          const readiness = yield* makeServerReadiness;
          const shutdownController = yield* makeServerShutdownController();
          const httpServer = yield* NodeHttpServer.make(
            () => {
              nodeServer = http.createServer();
              return nodeServer;
            },
            { port: 0, host: "127.0.0.1" },
          );
          const routes = makeEffectHttpRouteLayer(readiness, shutdownController);
          yield* httpServer.serve(
            yield* HttpRouter.toHttpEffect(routes as unknown as Layer.Layer<never>),
          );
        }).pipe(Effect.provideServices(services)),
        scope,
      ),
    );
    const address = (nodeServer as http.Server | null)?.address();
    if (!address || typeof address !== "object") throw new Error("Expected route server address");
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    rmSync(stateDir, { recursive: true, force: true });
  }
}

describe("production HTTP route set", () => {
  it("mounts the MCP App resource read route and reaches ProviderService", async () => {
    const calls: McpAppResourceReadInput[] = [];
    const provider = {
      readMcpAppResource: (input: McpAppResourceReadInput) =>
        Effect.sync(() => {
          calls.push(input);
          return { state: "no_content" as const, resourceUri: input.resourceUri };
        }),
    } as unknown as ProviderServiceShape;
    const input = {
      threadId: ThreadId.makeUnsafe("thread-mount"),
      callId: "call-mount",
      server: "codex_apps",
      resourceUri: "ui://widget/mount",
      source: "resultMeta" as const,
    };
    await withProductionRoutes(provider, async (origin) => {
      const response = await fetch(
        `${origin}${MCP_APP_RESOURCE_READ_ROUTE_PATH}?token=${startupToken}`,
        {
          method: "POST",
          headers: { Origin: desktopOrigin, "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      expect(await response.json()).toEqual({
        state: "no_content",
        resourceUri: input.resourceUri,
      });
      expect(calls).toHaveLength(1);
    });
  });

  it("mounts every interactive-connector endpoint", async () => {
    const thread = { threadId: "thread-mount", callId: "call-mount" };
    const cases: ReadonlyArray<readonly [string, unknown, number, unknown]> = [
      [MCP_APP_TOOL_RESULT_ROUTE_PATH, thread, 200, { status: "missing" }],
      [
        MCP_APP_RPC_ROUTE_PATH,
        { ...thread, server: "fixture", method: "tools/list" },
        404,
        { error: "Moss does not know this widget's tool call." },
      ],
      [
        MCP_APP_MODEL_CONTEXT_ROUTE_PATH,
        { ...thread, toolName: "fixture_show_widget", content: [] },
        200,
        { error: { message: "This app's tool call is not known to the host." } },
      ],
      [
        MCP_APP_RESOURCE_DOWNLOAD_ROUTE_PATH,
        { threadId: "thread-mount", server: "fixture", uri: "fixture://files/report.txt" },
        403,
        { error: "A widget can only download from the server that rendered it." },
      ],
    ];
    await withProductionRoutes(
      {} as ProviderServiceShape,
      async (origin) => {
        for (const [route, body, status, answer] of cases) {
          const response = await fetch(`${origin}${route}?token=${startupToken}`, {
            method: "POST",
            headers: { Origin: desktopOrigin, "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          expect([route, response.status]).toEqual([route, status]);
          expect(await response.json()).toEqual(answer);
        }
      },
      { withMcpApps: true },
    );
  });
});
