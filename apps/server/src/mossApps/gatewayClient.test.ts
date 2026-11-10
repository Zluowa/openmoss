import { afterEach, describe, expect, it, vi } from "vitest";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { outboundHttp } from "@moss/shared/outboundHttp";
import { MossAppsGatewayClient } from "./gatewayClient";
import type { MossLoginCredential } from "../account/mossLoginAuthority";

vi.mock("@moss/shared/outboundHttp", async (original) => ({
  ...(await original<typeof import("@moss/shared/outboundHttp")>()),
  outboundHttp: { request: vi.fn() },
}));
afterEach(() => vi.clearAllMocks());
const credential: MossLoginCredential = {
  realm: "supabase-google",
  accessToken: "fake-moss-login-only",
  gatewayBaseUrl: "https://fake.supabase.co/functions/v1/moss-model-gateway",
  account: { id: "a", realm: "supabase-google" },
};
const signal = () => new AbortController().signal;
const reply = (value: unknown, status = 200) => ({
  status,
  headers: new Headers({ "content-type": "application/json" }),
  body: new TextEncoder().encode(JSON.stringify(value)),
  url: credential.gatewayBaseUrl,
});

describe("Apps gateway desktop transport", () => {
  it("sends only the Moss bearer to the fixed regional endpoint", async () => {
    vi.mocked(outboundHttp.request).mockResolvedValue(reply({ availability: "ready" }));
    const client = new MossAppsGatewayClient(async () => credential);
    expect(await client.status(credential, signal())).toBe("ready");
    const request = vi.mocked(outboundHttp.request).mock.calls[0]![0];
    expect(request.url).toBe(`${credential.gatewayBaseUrl}/v1/apps/status`);
    expect(new Headers(request.headers).get("authorization")).toBe("Bearer fake-moss-login-only");
    expect(new Headers(request.headers).has("x-api-key")).toBe(false);
    expect(request.policy).toMatchObject({
      maxRedirects: 0,
      requirePublicAddress: true,
      allowedOrigins: ["https://fake.supabase.co"],
    });
  });
  it("does not include a desktop-selected owner or return provider diagnostics", async () => {
    vi.mocked(outboundHttp.request).mockResolvedValue(
      reply({ error: { code: "apps_credentials_required", message: "secret-project-key" } }, 400),
    );
    const client = new MossAppsGatewayClient(async () => credential);
    await expect(
      client.connect(
        credential,
        {
          toolkitSlug: "github",
          callbackUrl: "http://127.0.0.1:53851/oauth/moss-apps/callback",
          credentials: { token: "fake-user-token" },
        },
        signal(),
      ),
    ).rejects.toMatchObject({
      code: "apps_credentials_required",
      message: "Enter the details this app asks for.",
    });
    const body = JSON.parse(String(vi.mocked(outboundHttp.request).mock.calls[0]![0].body));
    expect(body).not.toHaveProperty("userId");
    expect(body).not.toHaveProperty("authConfigId");
  });
  it("rejects malformed connection contracts", async () => {
    vi.mocked(outboundHttp.request).mockResolvedValue(
      reply({ connections: [{ connectionId: "bad", accessToken: "secret" }] }),
    );
    const client = new MossAppsGatewayClient(async () => credential);
    await expect(client.listConnections(credential, signal())).rejects.toThrow();
  });
  it.each([404, "network"] as const)(
    "performs one desktop HTTP attempt for %s",
    async (failure) => {
      const mock = vi.mocked(outboundHttp.request);
      if (failure === "network") mock.mockRejectedValue(new Error("network failed"));
      else mock.mockResolvedValue(reply({ error: { code: "apps_session_expired" } }, failure));
      const client = new MossAppsGatewayClient(async () => credential);
      await client.forward(
        credential,
        {
          method: "POST",
          body: {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: {} },
          },
        },
        signal(),
      );
      expect(mock).toHaveBeenCalledTimes(1);
    },
  );
});

describe("installed MCP SDK without an auth provider", () => {
  it.each([404, "network"] as const)("does not replay a tool action after %s", async (failure) => {
    const fetcher = vi.fn(async (_url: string | URL, _init?: RequestInit) => {
      if (failure === "network") throw new TypeError("fake network failure");
      return Response.json({ error: "expired" }, { status: failure });
    });
    const transport = new StreamableHTTPClientTransport(
      new URL("https://gateway.example/v1/apps/mcp"),
      { fetch: fetcher },
    );
    try {
      await expect(
        transport.send({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "COMPOSIO_MULTI_EXECUTE_TOOL",
            arguments: {
              tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: {} }],
              sync_response_to_workbench: false,
            },
          },
        }),
      ).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
      const init = fetcher.mock.calls[0]?.[1];
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body)).method).toBe("tools/call");
    } finally {
      await transport.close();
    }
  });
});
