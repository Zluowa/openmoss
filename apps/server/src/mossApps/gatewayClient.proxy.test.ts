import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { MossAppsGatewayClient } from "./gatewayClient";
import type { MossLoginCredential } from "../account/mossLoginAuthority";
import { forwardMcpConnectorRequest } from "../mcpConnectors/proxy";

async function startCaptureProxy() {
  const connectTargets: string[] = [];
  const server = http.createServer((_req, res) => {
    res.writeHead(405).end();
  });
  server.on("connect", (req, socket) => {
    connectTargets.push(req.url ?? "");
    // Immediately close after capturing the CONNECT tunnel request so no real
    // external network traffic is required for this routing regression test.
    socket.write("HTTP/1.1 502 Proxy Capture Stop\r\n\r\n");
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP proxy address");
  }
  return {
    proxyUrl: `http://127.0.0.1:${address.port}`,
    connectTargets,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("Moss Apps real outboundHttp proxy routing", () => {
  const prevEnv = {
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    https_proxy: process.env.https_proxy,
    HTTP_PROXY: process.env.HTTP_PROXY,
    http_proxy: process.env.http_proxy,
    NO_PROXY: process.env.NO_PROXY,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("routes both CN and Global Apps requests and MCP forwards through HTTPS_PROXY instead of failing direct DNS lookup", async () => {
    const proxy = await startCaptureProxy();
    delete process.env.https_proxy;
    delete process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;
    delete process.env.ALL_PROXY;
    delete process.env.all_proxy;
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
    process.env.HTTPS_PROXY = proxy.proxyUrl;

    try {
      const cnCred: MossLoginCredential = {
        realm: "memfire-phone",
        accessToken: "fake-token",
        gatewayBaseUrl: "https://moss-cn-models.inkcomicai.com/functions/v1/moss-model-gateway/v1",
        account: { id: "cn-1", realm: "memfire-phone" },
      };
      const globalCred: MossLoginCredential = {
        realm: "supabase-google",
        accessToken: "fake-token",
        gatewayBaseUrl: "https://api.mossbotai.com/functions/v1/moss-model-gateway/v1",
        account: { id: "gl-1", realm: "supabase-google" },
      };
      const client = new MossAppsGatewayClient(async () => cnCred);

      await expect(client.status(cnCred, new AbortController().signal)).rejects.toThrow();
      await expect(client.status(globalCred, new AbortController().signal)).rejects.toThrow();
      const mcpResult = await forwardMcpConnectorRequest(
        {
          url: "https://moss-cn-models.inkcomicai.com/functions/v1/moss-model-gateway/v1/apps/mcp",
          method: "POST",
          body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
        },
        "Moss Apps",
      );

      expect(mcpResult.status).toBe(502);
      expect(proxy.connectTargets).toEqual([
        "moss-cn-models.inkcomicai.com:443",
        "api.mossbotai.com:443",
        "moss-cn-models.inkcomicai.com:443",
      ]);
    } finally {
      await proxy.close();
    }
  });

  it("allows 198.18.0.0/15 Clash fake-ip addresses via proxy while still rejecting loopback, private, and link-local addresses", async () => {
    const proxy = await startCaptureProxy();
    delete process.env.https_proxy;
    delete process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;
    delete process.env.ALL_PROXY;
    delete process.env.all_proxy;
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
    process.env.HTTPS_PROXY = proxy.proxyUrl;

    try {
      for (const fakeIpOrigin of ["https://198.18.0.10", "https://198.19.255.254"]) {
        const fakeIpCred: MossLoginCredential = {
          realm: "memfire-phone",
          accessToken: "fake-token",
          gatewayBaseUrl: `${fakeIpOrigin}/functions/v1/moss-model-gateway/v1`,
          account: { id: "cn-fake-ip", realm: "memfire-phone" },
        };
        const client = new MossAppsGatewayClient(async () => fakeIpCred);
        // Stops at the capture proxy's 502 CONNECT response rather than throwing OutboundPolicyError("private-address").
        await expect(client.status(fakeIpCred, new AbortController().signal)).rejects.toMatchObject(
          {
            name: "MossAppsFailure",
            code: "apps_unavailable",
          },
        );
        const mcpRes = await forwardMcpConnectorRequest(
          {
            url: `${fakeIpOrigin}/functions/v1/moss-model-gateway/v1/apps/mcp`,
            method: "POST",
            body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
          },
          "Moss Apps",
        );
        expect(mcpRes.status).toBe(502);
      }

      const targetsBeforeBlocked = proxy.connectTargets.length;
      expect(targetsBeforeBlocked).toBe(4);

      const blockedOrigins = [
        "https://127.0.0.1",
        "https://10.0.0.1",
        "https://169.254.169.254",
        "https://192.168.1.1",
        "https://172.16.0.1",
        "https://[::1]",
        "https://[fc00::1]",
        "https://[fe80::1]",
      ];
      for (const blockedOrigin of blockedOrigins) {
        const blockedCred: MossLoginCredential = {
          realm: "memfire-phone",
          accessToken: "fake-token",
          gatewayBaseUrl: `${blockedOrigin}/functions/v1/moss-model-gateway/v1`,
          account: { id: "cn-blocked", realm: "memfire-phone" },
        };
        const client = new MossAppsGatewayClient(async () => blockedCred);
        await expect(
          client.status(blockedCred, new AbortController().signal),
        ).rejects.toMatchObject({
          name: "OutboundPolicyError",
          code: "private-address",
        });
        const mcpBlocked = await forwardMcpConnectorRequest(
          {
            url: `${blockedOrigin}/functions/v1/moss-model-gateway/v1/apps/mcp`,
            method: "POST",
            body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
          },
          "Moss Apps",
        );
        expect(mcpBlocked.status).toBe(200);
        expect(mcpBlocked.body).toEqual({
          kind: "json",
          value: {
            jsonrpc: "2.0",
            id: 1,
            error: {
              code: -32001,
              message: "Moss could not reach Moss Apps.",
            },
          },
        });
      }
      // Blocked addresses must fail admission BEFORE opening any CONNECT tunnel to the proxy.
      expect(proxy.connectTargets.length).toBe(targetsBeforeBlocked);

      // Without a proxy as well, blocked addresses still fail admission with private-address.
      delete process.env.HTTPS_PROXY;
      for (const blockedOrigin of blockedOrigins) {
        const blockedCred: MossLoginCredential = {
          realm: "memfire-phone",
          accessToken: "fake-token",
          gatewayBaseUrl: `${blockedOrigin}/functions/v1/moss-model-gateway/v1`,
          account: { id: "cn-blocked-direct", realm: "memfire-phone" },
        };
        const client = new MossAppsGatewayClient(async () => blockedCred);
        await expect(
          client.status(blockedCred, new AbortController().signal),
        ).rejects.toMatchObject({
          name: "OutboundPolicyError",
          code: "private-address",
        });
      }
    } finally {
      await proxy.close();
    }
  });
});
