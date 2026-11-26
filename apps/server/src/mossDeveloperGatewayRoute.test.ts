import { describe, expect, it, vi } from "vitest";

import {
  forwardMossDeveloperGatewayRequest,
  MOSS_DEVELOPER_GATEWAY_PREFIX,
} from "./mossDeveloperGatewayRoute";

describe("mossDeveloperGatewayRoute", () => {
  it("requires a valid moss_dk_ developer key before forwarding", async () => {
    const fetcher = vi.fn();
    const res = await forwardMossDeveloperGatewayRequest({
      method: "POST",
      pathname: `${MOSS_DEVELOPER_GATEWAY_PREFIX}/chat/completions`,
      headers: new Headers({ authorization: "Bearer not-a-developer-key" }),
      bodyBytes: new Uint8Array(),
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("invalid_developer_api_key");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("forwards LLM, image, video, speech, and realtime calls to region-matched upstreams", async () => {
    const cnKey = `moss_dk_cn_${"d".repeat(32)}`;
    const glKey = `moss_dk_gl_${"g".repeat(32)}`;
    const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          forwardedTo: String(url),
          method: init?.method,
          regionHeader: new Headers(init?.headers).get("x-moss-cloud-region"),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const chatRes = await forwardMossDeveloperGatewayRequest({
      method: "POST",
      pathname: `${MOSS_DEVELOPER_GATEWAY_PREFIX}/chat/completions`,
      headers: new Headers({
        authorization: `Bearer ${cnKey}`,
        "content-type": "application/json",
      }),
      bodyBytes: new TextEncoder().encode(JSON.stringify({ model: "deepseek-v4-pro" })),
      resolveGatewayRoot: (region) => `https://${region}.gateway.example.test`,
      resolveRealtimeOrigin: (region) => `https://${region}.relay.example.test`,
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(chatRes.status).toBe(200);
    expect(await chatRes.json()).toMatchObject({
      forwardedTo: "https://cn.gateway.example.test/v1/chat/completions",
    });

    const realtimeRes = await forwardMossDeveloperGatewayRequest({
      method: "POST",
      pathname: `${MOSS_DEVELOPER_GATEWAY_PREFIX}/realtime/calls`,
      headers: new Headers({
        authorization: `Bearer ${glKey}`,
        "content-type": "application/json",
      }),
      bodyBytes: new TextEncoder().encode(JSON.stringify({ sessionId: "s-1" })),
      resolveGatewayRoot: (region) => `https://${region}.gateway.example.test`,
      resolveRealtimeOrigin: (region) => `https://${region}.relay.example.test`,
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(realtimeRes.status).toBe(200);
    expect(await realtimeRes.json()).toMatchObject({
      forwardedTo: "https://global.relay.example.test/v1/realtime/calls",
      regionHeader: "global",
    });
  });
});
