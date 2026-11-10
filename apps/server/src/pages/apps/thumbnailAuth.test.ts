// FILE: thumbnailAuth.test.ts
// Purpose: A thumbnail write retains the app's owner-only HTTP boundary.
// Layer: Server route tests

import { AuthSessionId } from "@moss/contracts";
import { Effect, Layer, type ServiceMap } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { expect, it, vi } from "vitest";

import { ServerAuth } from "../../auth/Services/ServerAuth";
import { ServerConfig } from "../../config";
import { pageAppsApiRouteLayer } from "./httpRoute";
import { PageAppsService } from "./PageAppsService";

it("forbids paired viewers and app hosts from setting thumbnails", async () => {
  const mutate = vi.fn(() => Effect.succeed({ app: {} }));
  const services = Layer.mergeAll(
    Layer.succeed(ServerConfig, {
      host: "127.0.0.1",
      authToken: "fixture-startup-token",
    } as ServiceMap.Service.Shape<typeof ServerConfig>),
    Layer.mock(ServerAuth)({
      authenticateHttpRequest: (request) =>
        Effect.succeed({
          sessionId: AuthSessionId.makeUnsafe("fixture"),
          subject: "fixture",
          method: "bearer-session-token",
          role: request.headers.authorization === "Bearer owner-fixture" ? "owner" : "client",
          credentialSource: "bearer",
        }),
    }),
    Layer.succeed(PageAppsService, { mutate } as unknown as ServiceMap.Service.Shape<
      typeof PageAppsService
    >),
  );
  const server = HttpRouter.toWebHandler(
    pageAppsApiRouteLayer.pipe(HttpRouter.provideRequest(services)),
    { disableLogger: true },
  );
  const request = (host: string, token: string) =>
    server.handler(
      new Request(`http://${host}/api/page-apps/mutate`, {
        method: "POST",
        headers: { host, authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          op: "set-thumbnail",
          requestId: "fixture",
          appId: "app",
          expectedRevision: 1,
          thumbnail: null,
        }),
      }),
    );
  try {
    expect((await request("localhost", "viewer-fixture")).status).toBe(403);
    expect((await request("app.moss-app.localhost", "owner-fixture")).status).toBe(404);
    expect(mutate).not.toHaveBeenCalled();
    expect((await request("localhost", "owner-fixture")).status).toBe(200);
    expect(mutate).toHaveBeenCalledOnce();
  } finally {
    await server.dispose();
  }
});
