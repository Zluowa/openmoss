// The default service must restore this app's connectors on Stable, without a gate override.
import { Effect, Exit, Scope } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import {
  MOSS_DESKTOP_BUNDLE_ID_ENV,
  MOSS_PRODUCTION_BUNDLE_ID,
} from "@moss/shared/desktopIdentity";

import {
  AgentGatewayCredentials,
  type AgentGatewayCredentialsShape,
} from "../../agentGateway/Services/AgentGatewayCredentials";
import { ServerSecretStore } from "../../auth/Services/ServerSecretStore";
import { MossAppsRuntime } from "../../mossApps/runtime";
import { MossEnterpriseKeyAccount } from "../../account/Services/MossEnterpriseKeyAccount";
import { MossPhoneAccountService } from "../../account/Services/MossPhoneAccountService";
import { MossCloudAccountService } from "../../account/Services/MossCloudAccountService";

afterEach(() => vi.unstubAllEnvs());

it("does not borrow a phone login when the active enterprise gateway is unconfigured", async () => {
  const { makeMcpConnectors } = await import("./McpConnectors");
  const phoneRead = vi.fn(() => Effect.die("must not borrow a cached login"));
  const service = await Effect.runPromise(
    makeMcpConnectors({ enabled: false }).pipe(
      Effect.provideService(ServerSecretStore, {
        get: () => Effect.succeed(null),
        set: () => Effect.void,
        remove: () => Effect.void,
        getOrCreateRandom: () => Effect.die("unused"),
      }),
      Effect.provideService(AgentGatewayCredentials, {
        mcpEndpointUrl: "http://127.0.0.1:53851/mcp",
        setConnectorServers: () => {},
      } as unknown as AgentGatewayCredentialsShape),
      Effect.provideService(MossEnterpriseKeyAccount, {
        getState: () => Effect.succeed({ active: true, authenticated: true, configured: false }),
        getActiveAuthorityCredential: () => Effect.succeed(null),
      } as never),
      Effect.provideService(MossPhoneAccountService, {
        getSession: phoneRead,
        getAuthorityCredential: phoneRead,
      } as never),
      Effect.provideService(MossCloudAccountService, {
        getState: phoneRead,
        getAuthorityCredential: phoneRead,
      } as never),
    ),
  );
  expect(await Effect.runPromise(service.mossApps.status())).toEqual({
    availability: "login-account-required",
    agentAccess: false,
  });
  expect(phoneRead).not.toHaveBeenCalled();
});

it("owns Apps startup cancellation and disposal in the existing server scope", async () => {
  const { makeMcpConnectors } = await import("./McpConnectors");
  const scope = await Effect.runPromise(Scope.make("sequential"));
  let observed: AbortSignal | undefined;
  const init = vi.spyOn(MossAppsRuntime.prototype, "init").mockImplementation(
    (signal) =>
      new Promise((resolve) => {
        observed = signal;
        signal?.addEventListener("abort", () => resolve(), { once: true });
      }),
  );
  const dispose = vi.spyOn(MossAppsRuntime.prototype, "dispose");
  try {
    await Effect.runPromise(
      Scope.provide(
        makeMcpConnectors({ enabled: false }).pipe(
          Effect.provideService(ServerSecretStore, {
            get: () => Effect.succeed(null),
            set: () => Effect.void,
            remove: () => Effect.void,
            getOrCreateRandom: () => Effect.die("unused"),
          }),
          Effect.provideService(AgentGatewayCredentials, {
            mcpEndpointUrl: "http://127.0.0.1:53851/mcp",
            setConnectorServers: () => {},
          } as unknown as AgentGatewayCredentialsShape),
        ),
        scope,
      ),
    );
    await vi.waitFor(() => expect(init).toHaveBeenCalledOnce());
    await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
    expect(observed?.aborted).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
    init.mockRestore();
    dispose.mockRestore();
  }
});

it("restores and publishes saved connectors on the Stable server by default", async () => {
  vi.stubEnv(MOSS_DESKTOP_BUNDLE_ID_ENV, MOSS_PRODUCTION_BUNDLE_ID);
  const { makeMcpConnectors } = await import("./McpConnectors");
  const connector = {
    connectorId: "saved-connector",
    presetId: null,
    name: "Saved service",
    url: "https://mcp.example.com/mcp",
    serverName: "saved_service_connector",
    authKind: "none",
    status: "connected",
    createdAt: "2026-10-25T12:00:00Z",
    updatedAt: "2026-10-25T12:00:00Z",
    oauth: null,
  };
  const stored = new TextEncoder().encode(JSON.stringify({ version: 1, connectors: [connector] }));
  const setConnectorServers = vi.fn();
  const service = await Effect.runPromise(
    makeMcpConnectors().pipe(
      Effect.provideService(ServerSecretStore, {
        get: () => Effect.succeed(stored),
        set: () => Effect.die("Unexpected write during restore"),
        remove: () => Effect.die("Unexpected removal during restore"),
        getOrCreateRandom: () => Effect.die("Unexpected secret creation during restore"),
      }),
      Effect.provideService(AgentGatewayCredentials, {
        mcpEndpointUrl: "http://127.0.0.1:3773/mcp",
        setConnectorServers,
      } as unknown as AgentGatewayCredentialsShape),
    ),
  );
  expect(service.enabled).toBe(true);
  expect(await Effect.runPromise(service.list())).toMatchObject([
    { connectorId: "saved-connector", status: "connected" },
  ]);
  expect(setConnectorServers).toHaveBeenCalledWith([
    { connectorId: "saved-connector", name: "saved_service_connector" },
  ]);
  expect(await Effect.runPromise(service.setup())).toEqual({
    redirectUrl: "http://127.0.0.1:3773/oauth/mcp/callback",
  });
});
