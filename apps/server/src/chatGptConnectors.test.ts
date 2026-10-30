// FILE: chatGptConnectors.test.ts
// Purpose: Pins the authenticated ChatGPT connector HTTP bridge and Codex tool normalization.
// Layer: Server utility tests

import { describe, expect, it, vi } from "vitest";

import {
  createChatGptConnectorClient,
  type ConnectorFetch,
  normalizeConnectorTools,
} from "./chatGptConnectors.ts";

const jwt = (accountId: string) => {
  const encoded = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  ).toString("base64url");
  return `header.${encoded}.signature`;
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const CONNECTOR_CALLBACK_URL = "moss-connectors://connector/oauth_callback";
const FULL_REDIRECT_URL =
  "https://chatgpt.com/backend-api/aip/connectors/links/oauth/callback?code=secret&state=state";

describe("ChatGPT connector bridge", () => {
  it("normalizes, filters, badges, and sorts connector tools exactly like Codex Desktop", () => {
    expect(
      normalizeConnectorTools([
        {
          name: "write_issue",
          description: "Write an issue",
          is_enabled: true,
          disabled_reason: null,
          is_read_only: false,
          visibility: "workspace/admin",
          is_open_world: true,
          is_destructive: true,
        },
        {
          name: "hidden_tool",
          description: "Hidden",
          is_enabled: false,
          disabled_reason: "user_disabled",
          is_read_only: false,
          visibility: null,
          is_open_world: false,
          is_destructive: false,
        },
        {
          name: "admin_disabled",
          description: null,
          is_enabled: false,
          disabled_reason: "disabled_by_admin",
          is_read_only: true,
          visibility: "private",
          is_open_world: false,
          is_destructive: false,
        },
      ]),
    ).toEqual([
      {
        accessBadges: ["READ"],
        description: null,
        disabledReason: "disabled_by_admin",
        name: "admin_disabled",
        visibility: "PRIVATE",
      },
      {
        accessBadges: ["WORKSPACE ADMIN WRITE", "OPEN WORLD", "DESTRUCTIVE"],
        description: "Write an issue",
        disabledReason: null,
        name: "write_issue",
        visibility: "WORKSPACE ADMIN",
      },
    ]);
  });

  it("scopes exact tool requests to the ChatGPT account without persisting the token", async () => {
    const token = jwt("acct-123");
    const fetchImpl = vi.fn<ConnectorFetch>(async () =>
      jsonResponse({
        id: "connector/github",
        name: "GitHub",
        supported_auth: [{ type: "OAUTH" }],
        link_params_schema: null,
        status: "ACTIVE",
        actions: [],
      }),
    );
    const resolveAuth = vi.fn(async () => ({ token }));
    const client = createChatGptConnectorClient({ resolveAuth, fetchImpl });

    await expect(client.readTools("connector/github")).resolves.toEqual({ tools: [] });

    expect(resolveAuth).toHaveBeenCalledTimes(1);
    const [url, request] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://chatgpt.com/backend-api/aip/connectors/connector%2Fgithub?include_logo=false&include_actions=true",
    );
    expect(request?.headers).toMatchObject({
      Authorization: `Bearer ${token}`,
      "ChatGPT-Account-Id": "acct-123",
      "OAI-Product-Sku": "CODEX",
      originator: "Codex Desktop",
    });
    expect(JSON.stringify(client)).not.toContain(token);
  });

  it("refreshes once for 401/403 and never retries a second auth failure", async () => {
    const fetchImpl = vi
      .fn<ConnectorFetch>()
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({}, 403));
    const resolveAuth = vi
      .fn()
      .mockResolvedValueOnce({ token: jwt("stale") })
      .mockResolvedValueOnce({ token: jwt("fresh") });
    const client = createChatGptConnectorClient({ resolveAuth, fetchImpl });

    await expect(client.readConnector("connector_x")).rejects.toThrow(
      "ChatGPT connector request failed with status 403.",
    );
    expect(resolveAuth.mock.calls).toEqual([[false], [true]]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails closed on malformed tool payloads and never reflects a bearer token in errors", async () => {
    const token = jwt("account-secret");
    const fetchImpl = vi.fn<ConnectorFetch>(async () =>
      jsonResponse({ id: "connector_x", actions: "wrong" }),
    );
    const client = createChatGptConnectorClient({
      resolveAuth: async () => ({ token }),
      fetchImpl,
    });

    const error = await client.readTools("connector_x").catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("invalid connector response");
    expect(String(error)).not.toContain(token);
  });

  it("uses exact no-auth, OAuth, reauth, TOS, and callback requests", async () => {
    const fetchImpl = vi.fn<ConnectorFetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/tos")) {
        return jsonResponse({
          blurbs: [{ title: "Permissions", description: "Read repositories" }],
          personalization_default: "NO_PERSONALIZATION",
          personalization_toggle_blurb: null,
        });
      }
      if (url.endsWith("/links/noauth")) return jsonResponse({});
      if (url.endsWith("/links/oauth")) {
        return jsonResponse({ redirect_url: "https://github.com/login/oauth/authorize" });
      }
      if (url.endsWith("/links/oauth/reauth")) {
        return jsonResponse({ redirect_url: "https://github.com/login/oauth/authorize?reauth=1" });
      }
      if (url.endsWith("/links/oauth/callback")) {
        return jsonResponse({ link: { connector_id: "connector_x", name: "GitHub" } });
      }
      throw new Error(`unexpected ${url} ${String(init?.method)}`);
    });
    const client = createChatGptConnectorClient({
      resolveAuth: async () => ({ token: jwt("acct") }),
      fetchImpl,
    });

    await expect(client.readTerms("connector_x")).resolves.toEqual({
      blurbs: [{ title: "Permissions", description: "Read repositories" }],
      personalizationDefault: "NO_PERSONALIZATION",
      personalizationToggleBlurb: null,
    });
    await expect(
      client.connectNoAuth({ connectorId: "connector_x", name: "GitHub" }),
    ).resolves.toBe(undefined);
    await expect(
      client.startOAuth({
        connectorId: "connector_x",
        name: "GitHub",
        callbackUrl: CONNECTOR_CALLBACK_URL,
        postAuthUrl: "https://chatgpt.com/gpts/editor#settings/Connectors",
      }),
    ).resolves.toBe("https://github.com/login/oauth/authorize");
    await expect(
      client.reauthenticate({
        callbackUrl: CONNECTOR_CALLBACK_URL,
        linkId: "link_x",
        postAuthUrl: "https://chatgpt.com/gpts/editor#settings/Connectors",
        requestedScopes: ["repo:read"],
      }),
    ).resolves.toBe("https://github.com/login/oauth/authorize?reauth=1");
    await expect(client.completeOAuth(FULL_REDIRECT_URL)).resolves.toEqual({
      appId: "connector_x",
      appName: "GitHub",
    });

    const requests = fetchImpl.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: init?.method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    }));
    expect(requests).toEqual([
      {
        url: "https://chatgpt.com/backend-api/aip/connectors/connector_x/tos",
        method: "GET",
        body: null,
      },
      {
        url: "https://chatgpt.com/backend-api/aip/connectors/links/noauth",
        method: "POST",
        body: { connector_id: "connector_x", name: "GitHub", action_names: [] },
      },
      {
        url: "https://chatgpt.com/backend-api/aip/connectors/links/oauth",
        method: "POST",
        body: {
          connector_id: "connector_x",
          name: "GitHub",
          action_names: null,
          callback_url: CONNECTOR_CALLBACK_URL,
          post_auth_url: "https://chatgpt.com/gpts/editor#settings/Connectors",
        },
      },
      {
        url: "https://chatgpt.com/backend-api/aip/connectors/links/oauth/reauth",
        method: "POST",
        body: {
          callback_url: CONNECTOR_CALLBACK_URL,
          link_id: "link_x",
          post_auth_url: "https://chatgpt.com/gpts/editor#settings/Connectors",
          requested_scopes: ["repo:read"],
        },
      },
      {
        url: "https://chatgpt.com/backend-api/aip/connectors/links/oauth/callback",
        method: "POST",
        body: {
          full_redirect_url: FULL_REDIRECT_URL,
        },
      },
    ]);
  });

  it("rejects unsafe base, callback, post-auth, redirect, and traversal-like connector values", async () => {
    expect(() =>
      createChatGptConnectorClient({
        baseUrl: "http://attacker.example/backend-api",
        resolveAuth: async () => ({ token: "token" }),
      }),
    ).toThrow(/unsafe ChatGPT connector base URL/i);

    const fetchImpl = vi.fn<ConnectorFetch>(async () =>
      jsonResponse({ redirect_url: "javascript:alert(document.domain)" }),
    );
    const client = createChatGptConnectorClient({
      resolveAuth: async () => ({ token: jwt("acct") }),
      fetchImpl,
    });
    await expect(
      client.startOAuth({
        connectorId: "connector_x",
        name: "GitHub",
        callbackUrl: "file:///tmp/callback",
        postAuthUrl: "https://chatgpt.com/gpts/editor",
      }),
    ).rejects.toThrow(/unsafe connector callback URL/i);
    for (const callbackUrl of [
      "moss://connector/oauth_callback",
      "MOSS-CONNECTORS://connector/oauth_callback",
      "moss-connectors://other/oauth_callback",
      "moss-connectors://connector/oauth/callback",
      "moss-connectors://connector/oauth_callback/",
      "moss-connectors://user@connector/oauth_callback",
      "moss-connectors://connector:443/oauth_callback",
      "moss-connectors://connector/oauth_callback?state=not-allowed",
      "moss-connectors://connector/oauth_callback#not-allowed",
      "https://connector/oauth_callback",
    ]) {
      await expect(
        client.startOAuth({
          connectorId: "connector_x",
          name: "GitHub",
          callbackUrl,
          postAuthUrl: "https://chatgpt.com/gpts/editor",
        }),
        callbackUrl,
      ).rejects.toThrow(/unsafe connector callback URL/i);
    }
    await expect(
      client.startOAuth({
        connectorId: "connector_x",
        name: "GitHub",
        callbackUrl: CONNECTOR_CALLBACK_URL,
        postAuthUrl: "javascript:alert(1)",
      }),
    ).rejects.toThrow(/unsafe connector post-auth URL/i);
    await expect(
      client.startOAuth({
        connectorId: "connector_x",
        name: "GitHub",
        callbackUrl: CONNECTOR_CALLBACK_URL,
        postAuthUrl: "https://chatgpt.com/gpts/editor",
      }),
    ).rejects.toThrow(/unsafe connector OAuth redirect URL/i);
    await expect(client.readConnector("../token")).rejects.toThrow(/invalid connector id/i);
  });

  it.each([
    "http://localhost/oauth/callback?code=code&state=state",
    "http://127.0.0.1/oauth/callback?code=code&state=state",
    "http://[::1]/oauth/callback?code=code&state=state",
  ])("rejects non-HTTPS OAuth completion redirect %s before transport", async (fullRedirectUrl) => {
    const fetchImpl = vi.fn<ConnectorFetch>(async () =>
      jsonResponse({ link: { connector_id: "connector_x", name: "GitHub" } }),
    );
    const client = createChatGptConnectorClient({
      resolveAuth: async () => ({ token: jwt("acct") }),
      fetchImpl,
    });

    await expect(client.completeOAuth(fullRedirectUrl)).rejects.toThrow(
      /unsafe connector callback URL/i,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("aborts connector requests at the configured timeout", async () => {
    const fetchImpl = vi.fn<ConnectorFetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const client = createChatGptConnectorClient({
      resolveAuth: async () => ({ token: jwt("acct") }),
      fetchImpl,
      timeoutMs: 5,
    });

    await expect(client.readConnector("connector_x")).rejects.toThrow(
      "ChatGPT connector request timed out.",
    );
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});
