import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  fetchMossGatewayModelIds,
  mossGatewayModelsUrl,
  parseMossGatewayModelIds,
} from "./mossGatewayModels";

describe("mossGatewayModels", () => {
  it("derives the catalog URL from any accepted gateway base URL shape", () => {
    for (const base of [
      "https://moss.example.cn/functions/v1/moss-model-gateway",
      "https://moss.example.cn/functions/v1/moss-model-gateway/",
      "https://moss.example.cn/functions/v1/moss-model-gateway/v1",
      "https://moss.example.cn/functions/v1/moss-model-gateway/v1/?x=1#y",
    ]) {
      expect(mossGatewayModelsUrl(base)).toBe(
        "https://moss.example.cn/functions/v1/moss-model-gateway/v1/models",
      );
    }
  });

  it("keeps only well-formed unique model ids in gateway order", () => {
    expect(
      parseMossGatewayModelIds({
        object: "list",
        data: [
          { id: "deepseek-v4-pro" },
          { id: " glm-5.3 " },
          { id: "deepseek-v4-pro" },
          { id: 7 },
          "kimi-k3",
          { id: "" },
        ],
      }),
    ).toEqual(["deepseek-v4-pro", "glm-5.3"]);
    expect(parseMossGatewayModelIds({ data: "nope" })).toBeNull();
    expect(parseMossGatewayModelIds(null)).toBeNull();
  });

  it("sends the account token and returns an entitled tagged catalog", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImplementation = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        calls.push({ url: String(input), init });
        return new Response(JSON.stringify({ data: [{ id: "qwen3.8-max" }, { id: "glm-5.3" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    ) as unknown as typeof fetch;

    const ids = await Effect.runPromise(
      fetchMossGatewayModelIds({
        gatewayBaseUrl: "https://moss.example.cn/functions/v1/moss-model-gateway",
        accessToken: "moss-access-token",
        fetch: fetchImplementation,
      }),
    );
    expect(ids).toEqual({ status: "ready", models: ["qwen3.8-max", "glm-5.3"] });
    expect(calls[0]?.url).toBe("https://moss.example.cn/functions/v1/moss-model-gateway/v1/models");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(
      "Bearer moss-access-token",
    );
    expect(new Headers(calls[0]?.init?.headers).get("user-agent")).toBe("Moss");
    expect(calls[0]?.init?.redirect).toBe("error");

    const failing = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    expect(
      await Effect.runPromise(
        fetchMossGatewayModelIds({
          gatewayBaseUrl: "https://moss.example.cn/functions/v1/moss-model-gateway",
          accessToken: "t",
          fetch: failing,
        }),
      ),
    ).toEqual({ status: "transport-degraded", models: [] });
    const throwing = (async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;
    expect(
      await Effect.runPromise(
        fetchMossGatewayModelIds({
          gatewayBaseUrl: "https://moss.example.cn/functions/v1/moss-model-gateway",
          accessToken: "t",
          fetch: throwing,
        }),
      ),
    ).toBeNull();
  });

  it.each([
    [401, "auth-denied"],
    [403, "auth-denied"],
    [402, "no-entitlement"],
    [404, "no-entitlement"],
  ] as const)("distinguishes HTTP %s gateway state", async (status, expected) => {
    const failing = (async () => new Response("nope", { status })) as unknown as typeof fetch;
    await expect(
      Effect.runPromise(
        fetchMossGatewayModelIds({
          gatewayBaseUrl: "https://moss.example.cn/functions/v1/moss-model-gateway",
          accessToken: "t",
          fetch: failing,
        }),
      ),
    ).resolves.toEqual({ status: expected, models: [] });
  });

  it("maps a rate-limited gateway to transport degradation without a usable catalog", async () => {
    const rateLimited = (async () =>
      new Response(JSON.stringify({ error: { code: "rate_limit" } }), {
        status: 429,
        headers: { "retry-after": "1" },
      })) as unknown as typeof fetch;

    await expect(
      Effect.runPromise(
        fetchMossGatewayModelIds({
          gatewayBaseUrl: "https://moss.example.cn/functions/v1/moss-model-gateway",
          accessToken: "moss-access-token",
          fetch: rateLimited,
        }),
      ),
    ).resolves.toEqual({ status: "transport-degraded", models: [] });
  });

  it("treats malformed successful responses as transport degradation", async () => {
    const malformed = (async () =>
      new Response(JSON.stringify({ data: "not-a-list" }), {
        status: 200,
      })) as unknown as typeof fetch;
    await expect(
      Effect.runPromise(
        fetchMossGatewayModelIds({
          gatewayBaseUrl: "https://moss.example.cn/functions/v1/moss-model-gateway",
          accessToken: "t",
          fetch: malformed,
        }),
      ),
    ).resolves.toEqual({ status: "transport-degraded", models: [] });
  });
});
