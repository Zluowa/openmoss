import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentGatewayConnectorRegistration } from "../agentGateway/Services/AgentGatewayCredentials.ts";
import * as proxy from "../mcpConnectors/proxy.ts";
import { ComposioClient } from "./composioClient.ts";
import { MOSS_APPS_CONNECTOR_ID, MossAppsRuntime } from "./runtime.ts";

vi.mock("../mcpConnectors/proxy.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof proxy>();
  return { ...actual, forwardMcpConnectorRequest: vi.fn() };
});

afterEach(() => {
  vi.clearAllMocks();
});

function fakeClient(overrides: Partial<ComposioClient>): ComposioClient {
  const client = new ComposioClient("ak_test", () => Promise.reject(new Error("no network")));
  return Object.assign(client, overrides);
}

function makeRuntime(client: ComposioClient | null) {
  const published: Array<AgentGatewayConnectorRegistration | null> = [];
  const runtime = new MossAppsRuntime({
    apiKey: client ? "ak_test" : null,
    ...(client ? { client } : {}),
    userId: async () => "moss_user",
    callbackUrl: () => "http://127.0.0.1:1/oauth/moss-apps/callback",
    publish: (registration) => published.push(registration),
    logWarning: () => undefined,
  });
  return { runtime, published };
}

describe("MossAppsRuntime", () => {
  it("stays unconfigured without a project key", async () => {
    const { runtime, published } = makeRuntime(null);
    await runtime.init();
    expect(runtime.status()).toEqual({ availability: "unconfigured", agentAccess: false });
    expect(published).toEqual([null]);
    await expect(runtime.listToolkits({})).rejects.toThrow("not set up");
  });

  it("offers the connector to agents only while an app is active", async () => {
    let status = "ACTIVE";
    const client = fakeClient({
      listConnections: async () => [
        {
          connectionId: "ca_1",
          toolkitSlug: "github",
          status: status === "ACTIVE" ? "active" : "inactive",
          createdAt: "2026-10-27T00:00:00.000Z",
        },
      ],
    });
    const { runtime, published } = makeRuntime(client);
    await runtime.init();
    expect(published).toEqual([{ name: "moss_apps", connectorId: MOSS_APPS_CONNECTOR_ID }]);
    expect(runtime.status().agentAccess).toBe(true);

    status = "INACTIVE";
    await runtime.listConnections({ fresh: true });
    expect(published.at(-1)).toBeNull();
  });

  it("connects an app with only its form's fields and requires the required ones", async () => {
    const connectWithCredentials = vi.fn(async () => ({
      connectionId: "ca_key",
      toolkitSlug: "jira",
      status: "active" as const,
      createdAt: "2026-10-28T00:00:00.000Z",
    }));
    const ensureCredentialAuthConfig = vi.fn(async () => "ac_key");
    const client = fakeClient({
      listConnections: async () => [],
      credentialForm: async () => ({
        scheme: "API_KEY" as const,
        fields: [
          { name: "subdomain", label: "Subdomain", description: "", required: true, secret: false },
          {
            name: "generic_api_key",
            label: "API token",
            description: "",
            required: false,
            secret: true,
          },
        ],
        helpUrl: null,
      }),
      ensureCredentialAuthConfig,
      connectWithCredentials,
    });
    const { runtime } = makeRuntime(client);

    await expect(runtime.connect("jira", { generic_api_key: "tok" })).rejects.toThrow(
      "Enter Subdomain.",
    );
    expect(connectWithCredentials).not.toHaveBeenCalled();

    const result = await runtime.connect("jira", {
      subdomain: " acme ",
      generic_api_key: "tok",
      injected: "ignored",
    });
    expect(result).toMatchObject({ signInUrl: null, connection: { connectionId: "ca_key" } });
    expect(ensureCredentialAuthConfig).toHaveBeenCalledWith("jira", "API_KEY");
    expect(connectWithCredentials).toHaveBeenCalledWith({
      userId: "moss_user",
      toolkitSlug: "jira",
      authConfigId: "ac_key",
      scheme: "API_KEY",
      values: { subdomain: "acme", generic_api_key: "tok" },
    });
  });

  it("sends the app's slug to the closing page and names it from the loaded catalog", async () => {
    const startConnection = vi.fn(async () => ({
      redirectUrl: "https://accounts.example.com/consent",
      connection: {
        connectionId: "ca_new",
        toolkitSlug: "github",
        status: "pending" as const,
        createdAt: "2026-10-28T00:00:00.000Z",
      },
    }));
    const client = fakeClient({
      listConnections: async () => [],
      ensureManagedAuthConfig: async () => "ac_managed",
      startConnection,
      listCatalog: async () => ({
        toolkits: [
          {
            slug: "github",
            name: "GitHub",
            description: "",
            logoUrl: null,
            categories: [],
            toolsCount: 0,
            signIn: "managed" as const,
          },
        ],
        nextCursor: null,
        totalItems: 1,
      }),
    });
    const { runtime } = makeRuntime(client);

    expect(runtime.cachedToolkit("github")).toBeNull();
    await runtime.connect("github");
    expect(startConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        callbackUrl: "http://127.0.0.1:1/oauth/moss-apps/callback?app=github",
      }),
    );
    await runtime.listToolkits({ all: true });
    expect(runtime.cachedToolkit("github")).toMatchObject({ name: "GitHub" });
    expect(runtime.cachedToolkit("gitlab")).toBeNull();
  });

  it("refuses to disconnect a connection that belongs to someone else", async () => {
    const deleteConnection = vi.fn(async () => undefined);
    const client = fakeClient({ listConnections: async () => [], deleteConnection });
    const { runtime } = makeRuntime(client);
    await expect(runtime.disconnect("ca_other")).resolves.toBe(false);
    expect(deleteConnection).not.toHaveBeenCalled();
  });

  it("pins the newest active connection of each app, and re-pins when they change", async () => {
    let connections = [
      {
        connectionId: "ca_old",
        toolkitSlug: "github",
        status: "active" as const,
        createdAt: "2026-10-27T00:00:00.000Z",
      },
      {
        connectionId: "ca_new",
        toolkitSlug: "github",
        status: "active" as const,
        createdAt: "2026-10-28T00:00:00.000Z",
      },
      {
        connectionId: "ca_pending",
        toolkitSlug: "slack",
        status: "pending" as const,
        createdAt: "2026-10-28T00:00:00.000Z",
      },
    ];
    const createToolRouterSession = vi.fn(async () => ({
      sessionId: "trs",
      mcpUrl: "https://backend.composio.dev/s",
    }));
    const client = fakeClient({
      listConnections: async () => connections,
      createToolRouterSession,
    });
    vi.mocked(proxy.forwardMcpConnectorRequest).mockResolvedValue({
      status: 200,
      sessionId: "upstream",
      body: { kind: "json", value: { jsonrpc: "2.0", id: 1, result: {} } },
    });
    const { runtime } = makeRuntime(client);
    const call = { method: "POST" as const, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } };

    await runtime.forward(call);
    await runtime.forward(call);
    expect(createToolRouterSession).toHaveBeenCalledTimes(1);
    expect(createToolRouterSession).toHaveBeenLastCalledWith("moss_user", { github: ["ca_new"] });

    connections = [
      ...connections,
      {
        connectionId: "ca_notion",
        toolkitSlug: "notion",
        status: "active" as const,
        createdAt: "2026-10-28T01:00:00.000Z",
      },
    ];
    await runtime.listConnections({ fresh: true });
    await runtime.forward(call);
    expect(createToolRouterSession).toHaveBeenCalledTimes(2);
    expect(createToolRouterSession).toHaveBeenLastCalledWith("moss_user", {
      github: ["ca_new"],
      notion: ["ca_notion"],
    });
  });

  it("starts a fresh tool-router session when the hosted one expired", async () => {
    let sessions = 0;
    const client = fakeClient({
      createToolRouterSession: async () => {
        sessions += 1;
        return {
          sessionId: `trs_${sessions}`,
          mcpUrl: `https://backend.composio.dev/s${sessions}`,
        };
      },
    });
    const forward = vi.mocked(proxy.forwardMcpConnectorRequest);
    forward
      .mockResolvedValueOnce({ status: 404, sessionId: null, body: { kind: "empty" } })
      .mockResolvedValueOnce({
        status: 200,
        sessionId: "upstream",
        body: { kind: "json", value: { jsonrpc: "2.0", id: 1, result: {} } },
      });
    const { runtime } = makeRuntime(client);
    const result = await runtime.forward({
      method: "POST",
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(result.status).toBe(200);
    expect(sessions).toBe(2);
    expect(forward.mock.calls.map(([request]) => request.url)).toEqual([
      "https://backend.composio.dev/s1",
      "https://backend.composio.dev/s2",
    ]);
    expect(forward.mock.calls[0]?.[0].accessToken).toBe("ak_test");
  });
});
