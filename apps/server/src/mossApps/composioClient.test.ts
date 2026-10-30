import { describe, expect, it } from "vitest";

import {
  ComposioClient,
  ComposioRequestError,
  mapComposioConnection,
  mapComposioCredentialForm,
  mapComposioToolkit,
} from "./composioClient.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("mapComposioToolkit", () => {
  it("narrows a catalog item to the Moss shape", () => {
    expect(
      mapComposioToolkit({
        slug: "GitHub",
        name: "GitHub",
        no_auth: false,
        composio_managed_auth_schemes: ["OAUTH2"],
        meta: {
          description: "Code hosting",
          logo: "https://logos.composio.dev/api/github",
          tools_count: 812,
          categories: [{ id: "dev", name: "developer tools" }, { name: "developer tools" }],
        },
      }),
    ).toEqual({
      slug: "github",
      name: "GitHub",
      description: "Code hosting",
      logoUrl: "https://logos.composio.dev/api/github",
      categories: ["developer tools"],
      toolsCount: 812,
      signIn: "managed",
    });
  });

  it("drops items without a usable slug and non-https logos", () => {
    expect(mapComposioToolkit({ slug: "../x", name: "X" })).toBeNull();
    expect(mapComposioToolkit({ slug: "composio_search", name: "Search" })).toBeNull();
    expect(
      mapComposioToolkit({ slug: "plain", name: "Plain", meta: { logo: "http://x" } }),
    ).toMatchObject({ logoUrl: null, signIn: "setup" });
  });

  it("keeps apps whose slug starts with a digit, which the catalog prefixes with an underscore", () => {
    expect(mapComposioToolkit({ slug: "_1password", name: "1password" })).toMatchObject({
      slug: "_1password",
      name: "1password",
    });
    expect(mapComposioToolkit({ slug: "_", name: "Underscore" })).toBeNull();
    expect(mapComposioToolkit({ slug: "__x", name: "Double" })).toBeNull();
  });

  it("tells how each app signs in", () => {
    const signIn = (raw: Record<string, unknown>) =>
      mapComposioToolkit({ slug: "app", name: "App", ...raw })?.signIn;
    expect(signIn({ no_auth: true })).toBe("none");
    expect(signIn({ composio_managed_auth_schemes: ["OAUTH2"], auth_schemes: ["OAUTH2"] })).toBe(
      "managed",
    );
    expect(signIn({ auth_schemes: ["OAUTH2", "API_KEY"] })).toBe("credentials");
    expect(signIn({ auth_schemes: ["bearer_token"] })).toBe("credentials");
    expect(signIn({ auth_schemes: ["OAUTH2", "S2S_OAUTH2"] })).toBe("setup");
  });
});

describe("mapComposioCredentialForm", () => {
  it("offers the fields a person fills in, without deprecated ones", () => {
    expect(
      mapComposioCredentialForm({
        auth_guide_url: "https://example.com/keys",
        auth_config_details: [
          { mode: "OAUTH2", fields: { connected_account_initiation: { required: [] } } },
          {
            mode: "API_KEY",
            fields: {
              connected_account_initiation: {
                required: [
                  {
                    name: "subdomain",
                    displayName: "Your Subdomain",
                    description: "Before .atlassian.net",
                    required: true,
                    is_secret: false,
                  },
                ],
                optional: [
                  {
                    name: "basic_encoded",
                    displayName: "Base Encode (Deprecated)",
                    description: "Deprecated — leave this blank.",
                    is_secret: true,
                  },
                  {
                    name: "generic_api_key",
                    displayName: "API Token",
                    description: "From your Composio account settings",
                    is_secret: true,
                  },
                  { name: "hidden", displayName: "Hidden", user_visible: false },
                  { name: "../bad", displayName: "Bad" },
                ],
              },
            },
          },
        ],
      }),
    ).toEqual({
      scheme: "API_KEY",
      fields: [
        {
          name: "subdomain",
          label: "Your Subdomain",
          description: "Before .atlassian.net",
          required: true,
          secret: false,
        },
        {
          name: "generic_api_key",
          label: "API Token",
          description: "From your Moss account settings",
          required: false,
          secret: true,
        },
      ],
      helpUrl: "https://example.com/keys",
    });
  });

  it("has no form for an app without a key, token or login scheme", () => {
    expect(
      mapComposioCredentialForm({
        auth_config_details: [
          { mode: "OAUTH2", fields: { connected_account_initiation: { required: [] } } },
        ],
      }),
    ).toBeNull();
  });

  it("presents catalog copy under the Moss name", () => {
    expect(
      mapComposioToolkit({
        slug: "browser_tool",
        name: "Browser Tool",
        no_auth: true,
        meta: { description: "Composio Browser Tool enables AI Agents to automate the web." },
      }),
    ).toMatchObject({
      name: "Browser Tool",
      description: "Moss Browser Tool enables AI Agents to automate the web.",
    });
  });
});

describe("mapComposioConnection", () => {
  it("maps backend statuses and rejects malformed rows", () => {
    expect(
      mapComposioConnection({
        id: "ca_1",
        toolkit: { slug: "gmail" },
        status: "INITIALIZING",
        created_at: "2026-10-27T20:00:55.776Z",
      }),
    ).toEqual({
      connectionId: "ca_1",
      toolkitSlug: "gmail",
      status: "pending",
      createdAt: "2026-10-27T20:00:55.776Z",
    });
    expect(mapComposioConnection({ id: "ca_2", toolkit: { slug: "gmail" } })).toBeNull();
  });
});

describe("ComposioClient", () => {
  it("connects an app with the user's own key through a credential sign-in config", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const client = new ComposioClient("ak_test", async (url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method: init?.method ?? "GET", body });
      if (url.includes("/auth_configs?")) {
        return jsonResponse(200, {
          items: [{ id: "ac_oauth", auth_scheme: "OAUTH2", status: "ENABLED" }],
        });
      }
      if (url.endsWith("/auth_configs")) {
        return jsonResponse(201, { auth_config: { id: "ac_key" } });
      }
      return jsonResponse(201, { id: "ca_key", status: "ACTIVE" });
    });
    const authConfigId = await client.ensureCredentialAuthConfig("perplexityai", "API_KEY");
    expect(authConfigId).toBe("ac_key");
    expect(calls[1]?.body).toEqual({
      toolkit: { slug: "perplexityai" },
      auth_config: { type: "use_custom_auth", authScheme: "API_KEY", credentials: {} },
    });
    const connection = await client.connectWithCredentials({
      userId: "moss_user",
      toolkitSlug: "perplexityai",
      authConfigId,
      scheme: "API_KEY",
      values: { generic_api_key: "pplx-secret" },
    });
    expect(connection).toMatchObject({ connectionId: "ca_key", status: "active" });
    expect(calls[2]?.body).toEqual({
      auth_config: { id: "ac_key" },
      connection: {
        user_id: "moss_user",
        state: { authScheme: "API_KEY", val: { generic_api_key: "pplx-secret", status: "ACTIVE" } },
      },
    });
  });

  it("keeps an OAuth sign-in on an OAuth config, not a credential one", async () => {
    const client = new ComposioClient("ak_test", async () =>
      jsonResponse(200, {
        items: [
          { id: "ac_key", auth_scheme: "API_KEY", status: "ENABLED" },
          { id: "ac_oauth", auth_scheme: "OAUTH2", status: "ENABLED" },
        ],
      }),
    );
    await expect(client.ensureManagedAuthConfig("jira")).resolves.toBe("ac_oauth");
  });

  it("sends the project key and reads toolkit pages", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = new ComposioClient("ak_test", async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(200, {
        items: [{ slug: "slack", name: "Slack" }],
        next_cursor: "next",
        total_items: 3,
      });
    });
    const page = await client.listToolkits({ search: "sl", limit: 10 });
    expect(page).toMatchObject({ nextCursor: "next", totalItems: 3 });
    expect(page.toolkits.map((toolkit) => toolkit.slug)).toEqual(["slack"]);
    expect(calls[0]?.url).toContain("/api/v3/toolkits?limit=10&sort_by=usage&search=sl");
    const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers["x-api-key"]).toBe("ak_test");
  });

  it("walks every catalog page once, skipping repeated apps", async () => {
    const cursors: Array<string | null> = [];
    const client = new ComposioClient("ak_test", async (url) => {
      const cursor = new URL(url).searchParams.get("cursor");
      cursors.push(cursor);
      return jsonResponse(
        200,
        cursor === null
          ? { items: [{ slug: "gmail", name: "Gmail" }], next_cursor: "p2", total_items: 2 }
          : {
              items: [
                { slug: "gmail", name: "Gmail" },
                { slug: "slack", name: "Slack" },
              ],
              total_items: 2,
            },
      );
    });
    const catalog = await client.listCatalog();
    expect(cursors).toEqual([null, "p2"]);
    expect(catalog.toolkits.map((toolkit) => toolkit.slug)).toEqual(["gmail", "slack"]);
    expect(catalog).toMatchObject({ nextCursor: null, totalItems: 2 });
  });

  it("starts a sign-in that redirects straight to the app, not a hosted page", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    const client = new ComposioClient("ak_test", async (url, init) => {
      requests.push({ path: new URL(url).pathname, body: JSON.parse(String(init?.body)) });
      return jsonResponse(201, {
        id: "ca_new",
        status: "INITIATED",
        redirect_url: "https://backend.composio.dev/api/v3/s/abc",
      });
    });
    const link = await client.startConnection({
      userId: "moss_user",
      toolkitSlug: "github",
      authConfigId: "ac_1",
      callbackUrl: "http://localhost:1/oauth/moss-apps/callback",
    });
    expect(requests).toEqual([
      {
        path: "/api/v3/connected_accounts",
        body: {
          auth_config: { id: "ac_1" },
          connection: {
            user_id: "moss_user",
            callback_url: "http://localhost:1/oauth/moss-apps/callback",
          },
        },
      },
    ]);
    expect(link.redirectUrl).toBe("https://backend.composio.dev/api/v3/s/abc");
    expect(link.connection).toMatchObject({ connectionId: "ca_new", status: "pending" });
  });

  it("returns an active connection without a redirect for apps that need no sign-in", async () => {
    const client = new ComposioClient("ak_test", async () =>
      jsonResponse(201, { id: "ca_open", status: "ACTIVE" }),
    );
    const link = await client.startConnection({
      userId: "moss_user",
      toolkitSlug: "weather",
      authConfigId: "ac_2",
      callbackUrl: "http://localhost:1/cb",
    });
    expect(link).toMatchObject({ redirectUrl: null, connection: { status: "active" } });
  });

  it("reuses an enabled sign-in config before creating a managed one", async () => {
    const methods: string[] = [];
    const client = new ComposioClient("ak_test", async (url, init) => {
      methods.push(`${init?.method} ${new URL(url).pathname}`);
      if (init?.method === "GET") {
        return jsonResponse(200, { items: [{ id: "ac_off", status: "DISABLED" }] });
      }
      return jsonResponse(201, { auth_config: { id: "ac_new" } });
    });
    await expect(client.ensureManagedAuthConfig("github")).resolves.toBe("ac_new");
    expect(methods).toEqual(["GET /api/v3/auth_configs", "POST /api/v3/auth_configs"]);
  });

  it("prefers Moss's own OAuth app over a managed config, whatever the listing order", async () => {
    const client = new ComposioClient("ak_test", async () =>
      jsonResponse(200, {
        items: [
          { id: "ac_managed", auth_scheme: "OAUTH2", is_composio_managed: true, status: "ENABLED" },
          { id: "ac_key", auth_scheme: "API_KEY", is_composio_managed: false, status: "ENABLED" },
          { id: "ac_moss", auth_scheme: "OAUTH2", is_composio_managed: false, status: "ENABLED" },
        ],
      }),
    );
    await expect(client.ensureManagedAuthConfig("github")).resolves.toBe("ac_moss");
  });

  it("surfaces backend error messages with their status", async () => {
    const client = new ComposioClient("ak_bad", async () =>
      jsonResponse(401, { error: { message: "API key is required." } }),
    );
    const failure = await client.listConnections("moss_user").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ComposioRequestError);
    expect(failure).toMatchObject({ status: 401, message: "API key is required." });
  });

  it("only accepts tool-router sessions on the backend origin", async () => {
    const client = new ComposioClient("ak_test", async () =>
      jsonResponse(201, { session_id: "trs_1", mcp: { url: "https://evil.example/mcp" } }),
    );
    await expect(client.createToolRouterSession("moss_user")).rejects.toBeInstanceOf(
      ComposioRequestError,
    );
  });

  it("pins the user's connections and keeps connecting out of the agents' hands", async () => {
    const bodies: unknown[] = [];
    const client = new ComposioClient("ak_test", async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(201, {
        session_id: "trs_1",
        mcp: { url: "https://backend.composio.dev/tool_router/trs_1/mcp" },
      });
    });
    await client.createToolRouterSession("moss_user", { github: ["ca_1"] });
    await client.createToolRouterSession("moss_user");
    expect(bodies).toEqual([
      {
        user_id: "moss_user",
        connected_accounts: { github: ["ca_1"] },
        manage_connections: { enable: false },
      },
      { user_id: "moss_user", manage_connections: { enable: false } },
    ]);
  });
});
