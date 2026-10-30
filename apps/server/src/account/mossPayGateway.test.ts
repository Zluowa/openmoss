import { afterEach, describe, expect, it, vi } from "vitest";
import { mossPayFetch, resolveMossPayBaseUrl } from "./mossPayGateway";

const modelGatewayUrl = "https://models.example.test/functions/v1/moss-model-gateway/v1";
const paymentBase = "https://wechat.example.test/functions/v1/moss-pay";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("credential-realm payment routing", () => {
  it.each([
    "https://moss-cn-models.inkcomicai.com/functions/v1/moss-model-gateway/v1",
    "https://relocated-models.example.test/functions/v1/moss-model-gateway/v1",
    "https://models-via-another-proxy.example.test/custom-model-route",
  ])("keeps the explicit phone payment endpoint after a model endpoint move: %s", (gateway) => {
    expect(
      resolveMossPayBaseUrl(
        { realm: "memfire-phone", modelGatewayUrl: gateway },
        { MOSS_MEMFIRE_PHONE_PAY_BASE_URL: `${paymentBase}/` },
      ),
    ).toBe(paymentBase);
  });

  it.each([
    undefined,
    "",
    "   ",
    "not a URL",
    "http://remote.example.test/pay",
    "https://user:secret@example.test/pay",
    "https://example.test/pay?token=secret",
    "https://example.test/pay#fragment",
  ])("fails closed for absent or invalid domestic payment config: %s", (value) => {
    expect(() =>
      resolveMossPayBaseUrl(
        { realm: "memfire-phone", modelGatewayUrl },
        { MOSS_MEMFIRE_PHONE_PAY_BASE_URL: value },
      ),
    ).toThrow(
      expect.objectContaining({
        code: "not_configured",
        realm: "memfire-phone",
        message: "微信支付暂不可用，请稍后重试。",
      }),
    );
  });

  it("allows an explicitly configured loopback payment origin", () => {
    expect(
      resolveMossPayBaseUrl(
        { realm: "memfire-phone", modelGatewayUrl },
        { MOSS_MEMFIRE_PHONE_PAY_BASE_URL: "http://127.0.0.1:18090/functions/v1/moss-pay" },
      ),
    ).toBe("http://127.0.0.1:18090/functions/v1/moss-pay");
  });

  it("never lets domestic configuration override a Google credential route", async () => {
    vi.stubEnv("MOSS_MEMFIRE_PHONE_PAY_BASE_URL", paymentBase);
    const fetchMock = vi.fn(async () => Response.json({ plans: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await mossPayFetch({
      realm: "supabase-google",
      modelGatewayUrl,
      accessToken: "google-fixture-token",
      method: "GET",
      path: "/catalog",
    });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "https://models.example.test/functions/v1/moss-pay/catalog",
      expect.objectContaining({
        headers: { Accept: "application/json", Authorization: "Bearer google-fixture-token" },
        redirect: "error",
      }),
    );
  });

  it("does not infer a realm from a hostname or send a phone token without payment config", async () => {
    vi.stubEnv("MOSS_MEMFIRE_PHONE_PAY_BASE_URL", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      mossPayFetch({
        realm: "memfire-phone",
        modelGatewayUrl,
        accessToken: "phone-fixture-token",
        method: "POST",
        path: "/orders",
      }),
    ).rejects.toMatchObject({ code: "not_configured", realm: "memfire-phone" });
    await expect(
      mossPayFetch({
        modelGatewayUrl,
        accessToken: "phone-fixture-token",
        method: "POST",
        path: "/orders",
      } as Parameters<typeof mossPayFetch>[0]),
    ).rejects.toMatchObject({ code: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pins a phone token to its explicit payment endpoint and rejects redirect following", async () => {
    vi.stubEnv("MOSS_MEMFIRE_PHONE_PAY_BASE_URL", paymentBase);
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      throw new TypeError("unexpected redirect");
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      mossPayFetch({
        realm: "memfire-phone",
        modelGatewayUrl,
        accessToken: "phone-fixture-token",
        method: "POST",
        path: "/orders",
        body: { order_type: "media_topup" },
      }),
    ).rejects.toMatchObject({ code: "gateway_unavailable" });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `${paymentBase}/orders`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer phone-fixture-token" }),
        redirect: "error",
      }),
    );
  });

  it("returns a bounded retry-expired error without creating a replacement checkout", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ error: "media_checkout_retry_expired" }, { status: 409 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      mossPayFetch({
        realm: "supabase-google",
        modelGatewayUrl,
        accessToken: "fixture-token",
        method: "POST",
        path: "/orders",
        body: { order_type: "media_topup" },
      }),
    ).rejects.toMatchObject({ code: "checkout_retry_expired" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
