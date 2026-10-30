import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  MossCloudAccountService,
  type MossCloudAccountServiceShape,
} from "../Services/MossCloudAccountService";
import {
  MossPhoneAccountService,
  type MossPhoneAccountServiceShape,
} from "../Services/MossPhoneAccountService";
import { MossPayService } from "../Services/MossPayService";
import { MossAccountServiceError } from "../mossAccountErrors";
import { MossPayError } from "../mossPayGateway";
import {
  MossPayServiceLive,
  normalizeMossPayQuota,
  normalizeMossPayCatalogPayload,
  parseMossPayOrder,
  paymentMethodsForRealm,
  resolveMossPayAuthorityCredential,
} from "./MossPayService";

describe("independent media wallet payment contracts", () => {
  it("preserves optional membership refund review and rejects nonboolean flags", () => {
    const fallback = { orderType: "plan" as const, itemCode: "basic" };
    const rawOrder = {
      out_trade_no: "MOSSplan1",
      order_type: "plan",
      item_code: "basic",
      status: "fulfilled",
      amount_minor: 4900,
      currency: "CNY",
    };
    expect(
      parseMossPayOrder(rawOrder, fallback, "memfire-phone").refundReviewRequired,
    ).toBeUndefined();
    expect(
      parseMossPayOrder({ ...rawOrder, refund_review_required: true }, fallback, "memfire-phone")
        .refundReviewRequired,
    ).toBe(true);
    for (const value of ["true", 1, null])
      expect(() =>
        parseMossPayOrder(
          { ...rawOrder, refund_review_required: value },
          fallback,
          "memfire-phone",
        ),
      ).toThrow();
  });
  const raw = {
    plans: [],
    point_packages: [{ code: "legacy-must-remain-disabled" }],
    media_topup_packages: [
      {
        code: "global-usd-5",
        display_name: "Media USD 5",
        currency: "USD",
        amount_minor: 500,
        rail: "stripe_checkout",
        available: true,
        credit_nano_cny: "35000000000",
        fx_version: "test-fx-v1",
      },
    ],
    media_wallet: {
      walletKind: "media_cost_v1",
      currency: "CNY",
      pointsPerCny: 100,
      availableNanoCny: "9007199254740993",
      heldNanoCny: "1",
    },
  };
  it("preserves exact balances and region denominations without resurrecting legacy packs", () => {
    const result = normalizeMossPayCatalogPayload(raw, paymentMethodsForRealm("supabase-google"));
    expect(result.pointPackages).toEqual([]);
    expect(result.mediaWallet?.availableNanoCny).toBe("9007199254740993");
    expect(result.mediaTopupPackages?.[0]).toMatchObject({
      amountMinor: 500,
      currency: "USD",
      creditNanoCny: "35000000000",
    });
    expect(() =>
      normalizeMossPayCatalogPayload(raw, paymentMethodsForRealm("memfire-phone")),
    ).toThrow();
    expect(() =>
      normalizeMossPayCatalogPayload(
        {
          ...raw,
          media_wallet: { ...raw.media_wallet, availableNanoCny: Number.MAX_SAFE_INTEGER + 1 },
        },
        paymentMethodsForRealm("supabase-google"),
      ),
    ).toThrow();
  });
  it("preserves media order type when polling and rejects a cross-realm response", () => {
    const order = {
      order_type: "media_topup",
      out_trade_no: "MOSSMD12345678",
      item_code: "global-usd-5",
      amount_minor: 500,
      amount_cny: 0,
      currency: "USD",
      rail: "stripe_checkout",
      status: "pending",
      identity_realm: "supabase-google",
      credit_nano_cny: "35000000000",
      fx_version: "test-fx-v1",
      checkout_url: "https://checkout.stripe.com/c/pay/test",
      code_url: null,
    };
    const fallback = { orderType: "points" as const, itemCode: "" };
    expect(parseMossPayOrder(order, fallback, "supabase-google")).toMatchObject({
      orderType: "media_topup",
      amountMinor: 500,
      currency: "USD",
      amountCny: 0,
      mediaCreditNanoCny: "35000000000",
      identityRealm: "supabase-google",
    });
    expect(() => parseMossPayOrder(order, fallback, "memfire-phone")).toThrow();
  });
});

describe("normalizeMossPayQuota", () => {
  it("derives an exact provider window duration from valid period bounds", () => {
    const quota = normalizeMossPayQuota(
      {
        plan_code: "starter",
        period_start: "2026-08-10T08:00:00+08:00",
        period_end: "2026-08-17T08:00:00+08:00",
        window_id: "provider-window-2026-08-10",
        window_source: "provider-weekly",
        token_limit: 100_000,
        tokens_used: 12_345,
        request_limit: 500,
        requests_used: 42,
        credit_balance: 8,
      },
      null,
    );

    expect(quota).toMatchObject({
      periodStart: "2026-08-10T00:00:00.000Z",
      periodEnd: "2026-08-17T00:00:00.000Z",
      windowId: "provider-window-2026-08-10",
      windowSource: "provider-weekly",
      windowDurationSeconds: 604_800,
      tokenLimit: 100_000,
      tokensUsed: 12_345,
      requestLimit: 500,
      requestsUsed: 42,
    });
  });

  it("prefers provider duration metadata and accepts a nested provider window", () => {
    const quota = normalizeMossPayQuota(
      {
        quota_window: {
          period_start: "2026-08-01T00:00:00.000Z",
          period_end: "2026-09-01T00:00:00.000Z",
          source_window_id: "provider-window-2026-08",
          source_role: "monthly",
          duration_seconds: 2_678_400,
        },
      },
      null,
    );

    expect(quota).toMatchObject({
      windowSource: "monthly",
      windowId: "provider-window-2026-08",
      windowDurationSeconds: 2_678_400,
      periodStart: "2026-08-01T00:00:00.000Z",
      periodEnd: "2026-09-01T00:00:00.000Z",
    });
  });

  it("fails closed on malformed dates, counters, sources, and realtime values", () => {
    const quota = normalizeMossPayQuota(
      {
        period_start: "not-a-date",
        period_end: "also-not-a-date",
        window_source: { raw: "must not escape" },
        window_duration_seconds: -1,
        token_limit: "NaN",
        tokens_used: -100,
        request_limit: Number.POSITIVE_INFINITY,
        requests_used: "oops",
        credit_balance: -4,
      },
      {
        configured: true,
        planLimitNanoUsd: "not-a-number",
        planUsedNanoUsd: -1,
        sessionsUsed: Number.POSITIVE_INFINITY,
      },
    );

    expect(quota).toMatchObject({
      periodStart: null,
      periodEnd: null,
      windowId: null,
      windowSource: null,
      windowDurationSeconds: null,
      tokenLimit: null,
      tokensUsed: 0,
      requestLimit: null,
      requestsUsed: 0,
      creditBalance: 0,
      realtimeConfigured: true,
      realtimeCostLimitNanoUsd: null,
      realtimeCostUsedNanoUsd: 0,
      realtimeSessionsUsed: 0,
    });
  });

  it("accepts an explicit unlimited policy only with null metered bounds", () => {
    expect(
      normalizeMossPayQuota(
        {
          quota_policy_mode: "unlimited",
          request_limit: null,
          token_limit: null,
        },
        null,
      ),
    ).toMatchObject({ quotaPolicyMode: "unlimited", requestLimit: null, tokenLimit: null });
    expect(
      normalizeMossPayQuota(
        {
          quota_policy_mode: "unlimited",
          request_limit: 50,
          token_limit: null,
        },
        null,
      ).quotaPolicyMode,
    ).toBe("unavailable");
  });

  it("preserves a lifetime cost balance with no duration or reset", () => {
    const quota = normalizeMossPayQuota(
      {
        plan_code: "basic",
        quota_policy_mode: "metered",
        request_limit: null,
        token_limit: null,
        credit_usage_snapshot: {
          billing_model: "cost_budget_v1",
          usage_limits: [
            {
              key: "lifetime",
              duration_seconds: null,
              limit: 420,
              used: 84,
              resets_at: null,
            },
          ],
        },
      },
      null,
    );

    expect(quota).toMatchObject({
      billingModel: "cost_budget_v1",
      quotaPolicyMode: "metered",
      requestLimit: null,
      tokenLimit: null,
      usageLimits: [
        { key: "lifetime", durationSeconds: null, resetsAt: null, limit: 420, used: 84 },
      ],
    });
  });

  it("does not downgrade an explicit unlimited realtime allowance to unconfigured", () => {
    const quota = normalizeMossPayQuota(
      {
        plan_code: "starter-trial",
        quota_policy_mode: "unlimited",
        request_limit: null,
        token_limit: null,
      },
      {
        configured: false,
        model_allowlist: ["gpt-realtime-2.1"],
        plan_limit_nano_usd: null,
        session_limit: null,
      },
    );

    expect(quota).toMatchObject({
      quotaPolicyMode: "unlimited",
      realtimeConfigured: true,
      realtimeModelAllowlist: ["gpt-realtime-2.1"],
      realtimeCostLimitNanoUsd: null,
      realtimeSessionLimit: null,
    });
  });

  it("does not retain upstream error detail in normalized account-service failures", async () => {
    const { sanitizeMossPayError } = await import("./MossPayService");
    const normalized = sanitizeMossPayError(
      new MossPayError({
        code: "gateway_error",
        message: "postgres relation secret_schema.internal_quota does not exist",
        cause: new Error("raw database diagnostic"),
      }),
    );

    expect(normalized.message).toBe("The Moss payment request failed.");
    expect(normalized).not.toHaveProperty("cause");
  });
});

const phoneCredential = {
  realm: "memfire-phone" as const,
  issuer: "https://moss-test.memfiredb.com/auth/v1",
  accessToken: "phone-token",
  gatewayBaseUrl: "https://cn-gateway.example.test/functions/v1/moss-model-gateway/v1",
  realtimeRelayUrl: "https://cn-realtime.example.test",
};

const cloudCredential = {
  realm: "supabase-google" as const,
  issuer: "https://moss-test.supabase.co/auth/v1",
  accessToken: "cloud-token",
  gatewayBaseUrl: "https://global-gateway.example.test/functions/v1/moss-model-gateway/v1",
  realtimeRelayUrl: "https://global-realtime.example.test",
};

type TestFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

describe("resolveMossPayAuthorityCredential", () => {
  it("uses the authenticated phone identity without consulting a different cloud account", async () => {
    const cloudAuthority = vi.fn(() => Effect.succeed(cloudCredential));
    const credential = await resolveMossPayAuthorityCredential({
      phoneAccount: {
        getAuthorityCredential: () => Effect.succeed(phoneCredential),
      },
      cloudAccount: { getAuthorityCredential: cloudAuthority },
    }).pipe(Effect.runPromise);

    expect(credential).toEqual(phoneCredential);
    expect(credential.gatewayBaseUrl).not.toBe(cloudCredential.gatewayBaseUrl);
    expect(cloudAuthority).not.toHaveBeenCalled();
  });

  it("falls back to cloud only when there is definitively no authenticated phone session", async () => {
    const credential = await resolveMossPayAuthorityCredential({
      phoneAccount: {
        getAuthorityCredential: () =>
          Effect.fail(
            new MossAccountServiceError({
              code: "authentication_required",
              message: "signed out",
            }),
          ),
      },
      cloudAccount: { getAuthorityCredential: () => Effect.succeed(cloudCredential) },
    }).pipe(Effect.runPromise);

    expect(credential).toEqual(cloudCredential);
    expect(credential.gatewayBaseUrl).not.toBe(phoneCredential.gatewayBaseUrl);
  });

  it.each([
    "authentication_service_unavailable",
    "session_expired",
    "persistence_failed",
    "invalid_authentication_response",
  ] as const)("never substitutes cloud credentials after a phone %s failure", async (code) => {
    const privateFailure = new MossAccountServiceError({
      code,
      message: "private auth endpoint detail",
    });
    const cloudAuthority = vi.fn(() => Effect.succeed(cloudCredential));
    const failure = await resolveMossPayAuthorityCredential({
      phoneAccount: {
        getAuthorityCredential: () => Effect.fail(privateFailure),
      },
      cloudAccount: { getAuthorityCredential: cloudAuthority },
    }).pipe(Effect.flip, Effect.runPromise);

    expect(failure).toBe(privateFailure);
    expect(cloudAuthority).not.toHaveBeenCalled();
  });

  it("fails closed when the phone service returns a credential for the wrong realm", async () => {
    const cloudAuthority = vi.fn(() => Effect.succeed(cloudCredential));
    const failure = await resolveMossPayAuthorityCredential({
      phoneAccount: {
        getAuthorityCredential: () =>
          Effect.succeed(cloudCredential as unknown as typeof phoneCredential),
      },
      cloudAccount: { getAuthorityCredential: cloudAuthority },
    }).pipe(Effect.flip, Effect.runPromise);

    expect(failure).toMatchObject({ code: "invalid_authentication_response" });
    expect(cloudAuthority).not.toHaveBeenCalled();
  });

  it("fails closed when the Google service returns a credential for the wrong realm", async () => {
    const cloudAuthority = vi.fn(() =>
      Effect.succeed(phoneCredential as unknown as typeof cloudCredential),
    );
    const failure = await resolveMossPayAuthorityCredential({
      phoneAccount: {
        getAuthorityCredential: () =>
          Effect.fail(
            new MossAccountServiceError({
              code: "authentication_required",
              message: "signed out",
            }),
          ),
      },
      cloudAccount: { getAuthorityCredential: cloudAuthority },
    }).pipe(Effect.flip, Effect.runPromise);

    expect(failure).toMatchObject({ code: "provider_error" });
    expect(cloudAuthority).toHaveBeenCalledOnce();
  });
});

function makeMossPayLayer(input: {
  readonly phoneAuthority: MossPhoneAccountServiceShape["getAuthorityCredential"];
  readonly cloudAuthority: MossCloudAccountServiceShape["getAuthorityCredential"];
}) {
  const dependencies = Layer.merge(
    Layer.succeed(MossPhoneAccountService, {
      getAuthorityCredential: input.phoneAuthority,
    } as MossPhoneAccountServiceShape),
    Layer.succeed(MossCloudAccountService, {
      getAuthorityCredential: input.cloudAuthority,
    } as MossCloudAccountServiceShape),
  );
  return MossPayServiceLive.pipe(Layer.provide(dependencies));
}

function quotaRestResponse(
  href: string,
  input: {
    readonly walletBalance?: unknown;
    readonly entitlementHeaders?: Readonly<Record<string, string>>;
  } = {},
): Response {
  if (href === "https://moss-test.memfiredb.com/rest/v1/rpc/moss_get_credit_usage_snapshot") {
    return new Response(JSON.stringify({ code: "PGRST202", message: "function not found" }), {
      status: 404,
    });
  }
  if (href.startsWith("https://moss-test.memfiredb.com/rest/v1/account_entitlements?")) {
    return new Response(
      JSON.stringify([
        {
          id: "entitlement-1",
          plan_code: "starter",
          realtime_model_allowlist: ["gpt-realtime"],
        },
      ]),
      {
        status: 200,
        ...(input.entitlementHeaders === undefined ? {} : { headers: input.entitlementHeaders }),
      },
    );
  }
  if (href.startsWith("https://moss-test.memfiredb.com/rest/v1/account_quotas?")) {
    return new Response(
      JSON.stringify([
        {
          id: "quota-1",
          entitlement_id: "entitlement-1",
          period_start: "2026-08-10T00:00:00.000Z",
          period_end: "2026-08-17T00:00:00.000Z",
          request_limit: 500,
          requests_used: 42,
          token_limit: 100_000,
          input_tokens_used: 10_000,
          output_tokens_used: 2_345,
          realtime_cost_limit_nano_usd: 500_000_000,
          realtime_cost_used_nano_usd: 100_000_000,
          realtime_cost_reserved_nano_usd: 20_000_000,
          realtime_session_limit: 20,
          realtime_sessions_used: 3,
        },
      ]),
      { status: 200 },
    );
  }
  if (href.startsWith("https://moss-test.memfiredb.com/rest/v1/credit_wallets?")) {
    return new Response(JSON.stringify([{ balance: input.walletBalance ?? 8 }]), { status: 200 });
  }
  return new Response(null, { status: 404 });
}

describe("paymentMethodsForRealm", () => {
  it("pins mainland phone accounts to 提市微信支付 and Google accounts to Stripe", () => {
    expect(paymentMethodsForRealm("memfire-phone")).toEqual([
      { id: "wechat_pay", displayName: "提市微信支付", kind: "qr" },
    ]);
    expect(paymentMethodsForRealm("supabase-google")).toEqual([
      { id: "stripe_checkout", displayName: "Stripe", kind: "hosted" },
    ]);
  });
});

describe("MossPayServiceLive authority routing", () => {
  it.each(["catalog", "create", "get"] as const)(
    "reports an unconfigured domestic payment endpoint before %s can send a token or fall back to public pricing",
    async (operation) => {
      const fetchMock = vi.fn<TestFetch>();
      const cloudAuthority = vi.fn(() => Effect.succeed(cloudCredential));
      vi.stubEnv("MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL", phoneCredential.gatewayBaseUrl);
      vi.stubEnv("MOSS_MEMFIRE_PHONE_PAY_BASE_URL", "");
      vi.stubEnv("MOSS_MEMFIRE_PHONE_URL", "https://moss-test.memfiredb.com");
      vi.stubEnv("MOSS_MEMFIRE_PHONE_PUBLISHABLE_KEY", "fixture-public-key");
      vi.stubGlobal("fetch", fetchMock);
      try {
        const failure = await Effect.gen(function* () {
          const service = yield* MossPayService;
          if (operation === "catalog") return yield* service.getCatalog();
          if (operation === "create")
            return yield* service.createOrder({
              orderType: "media_topup",
              itemCode: "cn-cny-10",
              idempotencyKey: "intent-key-123",
            });
          return yield* service.getOrder({ outTradeNo: "MOSSMD12345678" });
        }).pipe(
          Effect.provide(
            makeMossPayLayer({
              phoneAuthority: () => Effect.succeed(phoneCredential),
              cloudAuthority,
            }),
          ),
          Effect.flip,
          Effect.runPromise,
        );
        expect(failure).toMatchObject({
          code: "not_configured",
          realm: "memfire-phone",
          message: "微信支付暂不可用，请稍后重试。",
        });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(cloudAuthority).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
      }
    },
  );

  it("polls the existing domestic order through the independent payment origin", async () => {
    const fetchMock = vi.fn<TestFetch>(async () =>
      Response.json({
        out_trade_no: "MOSSMD12345678",
        order_type: "media_topup",
        item_code: "cn-cny-10",
        identity_realm: "memfire-phone",
        rail: "wechat_pay",
        amount_minor: 1000,
        amount_cny: 1000,
        currency: "CNY",
        status: "fulfilled",
        credit_nano_cny: "10000000000",
        fx_version: "CNY-1-v1",
        code_url: null,
        checkout_url: null,
      }),
    );
    vi.stubEnv("MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL", phoneCredential.gatewayBaseUrl);
    vi.stubEnv(
      "MOSS_MEMFIRE_PHONE_PAY_BASE_URL",
      "https://wechat.example.test/functions/v1/moss-pay",
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const order = await Effect.gen(function* () {
        return yield* (yield* MossPayService).getOrder({ outTradeNo: "MOSSMD12345678" });
      }).pipe(
        Effect.provide(
          makeMossPayLayer({
            phoneAuthority: () => Effect.succeed(phoneCredential),
            cloudAuthority: () => Effect.succeed(cloudCredential),
          }),
        ),
        Effect.runPromise,
      );
      expect(order).toMatchObject({
        status: "fulfilled",
        orderType: "media_topup",
        mediaCreditNanoCny: "10000000000",
      });
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
        "https://wechat.example.test/functions/v1/moss-pay/orders/MOSSMD12345678",
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({ Authorization: "Bearer phone-token" }),
          redirect: "error",
        }),
      );
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("keeps a validated Google account on its own Stripe route when domestic payment is configured", async () => {
    const fetchMock = vi.fn<TestFetch>(async () =>
      Response.json({ plans: [], point_packages: [] }),
    );
    vi.stubEnv("MOSS_SUPABASE_GOOGLE_MODEL_GATEWAY_URL", cloudCredential.gatewayBaseUrl);
    vi.stubEnv(
      "MOSS_MEMFIRE_PHONE_PAY_BASE_URL",
      "https://wechat.example.test/functions/v1/moss-pay",
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const catalog = await Effect.gen(function* () {
        return yield* (yield* MossPayService).getCatalog();
      }).pipe(
        Effect.provide(
          makeMossPayLayer({
            phoneAuthority: () =>
              Effect.fail(
                new MossAccountServiceError({
                  code: "authentication_required",
                  message: "signed out",
                }),
              ),
            cloudAuthority: () => Effect.succeed(cloudCredential),
          }),
        ),
        Effect.runPromise,
      );
      expect(catalog.paymentMethods).toEqual([
        { id: "stripe_checkout", displayName: "Stripe", kind: "hosted" },
      ]);
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
        "https://global-gateway.example.test/functions/v1/moss-pay/catalog",
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer cloud-token" }),
        }),
      );
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("reads the authenticated media wallet even when public plan pricing is configured", async () => {
    const mediaWallet = {
      walletKind: "media_cost_v1",
      currency: "CNY",
      pointsPerCny: 100,
      availableNanoCny: "9007199254740993",
      heldNanoCny: "500000000",
    };
    const fetchMock = vi.fn<TestFetch>(async (url) => {
      expect(String(url)).toBe("https://wechat.example.test/functions/v1/moss-pay/catalog");
      return Response.json({
        plans: [],
        point_packages: [],
        media_topup_packages: [],
        media_wallet: mediaWallet,
      });
    });
    vi.stubEnv("MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL", phoneCredential.gatewayBaseUrl);
    vi.stubEnv(
      "MOSS_MEMFIRE_PHONE_PAY_BASE_URL",
      "https://wechat.example.test/functions/v1/moss-pay",
    );
    vi.stubEnv("MOSS_MEMFIRE_PHONE_URL", "https://moss-test.memfiredb.com");
    vi.stubEnv("MOSS_MEMFIRE_PHONE_PUBLISHABLE_KEY", "fixture-public-key");
    vi.stubGlobal("fetch", fetchMock);
    try {
      const catalog = await Effect.gen(function* () {
        return yield* (yield* MossPayService).getCatalog();
      }).pipe(
        Effect.provide(
          makeMossPayLayer({
            phoneAuthority: () => Effect.succeed(phoneCredential),
            cloudAuthority: () => Effect.succeed(cloudCredential),
          }),
        ),
        Effect.runPromise,
      );
      expect(catalog.mediaWallet).toEqual(mediaWallet);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
        headers: expect.objectContaining({ Authorization: "Bearer phone-token" }),
      });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("forwards the stable media checkout retry key and preserves the returned quote", async () => {
    const fetchMock = vi.fn<TestFetch>(async (url, init) => {
      expect(String(url)).toBe("https://wechat.example.test/functions/v1/moss-pay/orders");
      expect(JSON.parse(String(init?.body))).toEqual({
        order_type: "media_topup",
        item_code: "cn-cny-10",
        idempotency_key: "retry-key-123",
      });
      return Response.json({
        out_trade_no: "MOSSMD12345678",
        order_type: "media_topup",
        item_code: "cn-cny-10",
        identity_realm: "memfire-phone",
        rail: "wechat_pay",
        amount_minor: 1000,
        amount_cny: 1000,
        currency: "CNY",
        credit_nano_cny: "10000000000",
        fx_version: "CNY-1-v1",
        status: "pending",
        code_url: "weixin://wxpay/test",
        checkout_url: null,
      });
    });
    vi.stubEnv("MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL", phoneCredential.gatewayBaseUrl);
    vi.stubEnv(
      "MOSS_MEMFIRE_PHONE_PAY_BASE_URL",
      "https://wechat.example.test/functions/v1/moss-pay",
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const order = await Effect.gen(function* () {
        return yield* (yield* MossPayService).createOrder({
          orderType: "media_topup",
          itemCode: "cn-cny-10",
          idempotencyKey: "retry-key-123",
        });
      }).pipe(
        Effect.provide(
          makeMossPayLayer({
            phoneAuthority: () => Effect.succeed(phoneCredential),
            cloudAuthority: () => Effect.succeed(cloudCredential),
          }),
        ),
        Effect.runPromise,
      );
      expect(order).toMatchObject({
        orderType: "media_topup",
        mediaCreditNanoCny: "10000000000",
        fxVersion: "CNY-1-v1",
        amountMinor: 1000,
      });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it.each([
    phoneCredential.gatewayBaseUrl,
    "https://relocated-cn-models.example.test/functions/v1/moss-model-gateway/v1",
  ])(
    "sends a phone token only to its separate payment endpoint when its model route is %s",
    async (gatewayBaseUrl) => {
      const cloudAuthority = vi.fn(() => Effect.succeed(cloudCredential));
      const fetchMock = vi.fn<TestFetch>(
        async () =>
          new Response(JSON.stringify({ plans: [], point_packages: [] }), { status: 200 }),
      );
      vi.stubEnv("MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL", gatewayBaseUrl);
      vi.stubEnv(
        "MOSS_MEMFIRE_PHONE_PAY_BASE_URL",
        "https://wechat.example.test/functions/v1/moss-pay",
      );
      vi.stubEnv("MOSS_SUPABASE_GOOGLE_MODEL_GATEWAY_URL", cloudCredential.gatewayBaseUrl);
      vi.stubGlobal("fetch", fetchMock);

      try {
        const catalog = await Effect.gen(function* () {
          const service = yield* MossPayService;
          return yield* service.getCatalog();
        }).pipe(
          Effect.provide(
            makeMossPayLayer({
              phoneAuthority: () => Effect.succeed({ ...phoneCredential, gatewayBaseUrl }),
              cloudAuthority,
            }),
          ),
          Effect.runPromise,
        );

        expect(catalog).toEqual({
          plans: [],
          pointPackages: [],
          paymentMethods: [{ id: "wechat_pay", displayName: "提市微信支付", kind: "qr" }],
        });
        expect(cloudAuthority).not.toHaveBeenCalled();
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(fetchMock.mock.calls[0]?.[0]).toBe(
          "https://wechat.example.test/functions/v1/moss-pay/catalog",
        );
        expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
          headers: expect.objectContaining({ Authorization: "Bearer phone-token" }),
        });
      } finally {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
      }
    },
  );

  it("drops free plans and every legacy point SKU until top-ups are cost-backed", async () => {
    const fetchMock = vi.fn<TestFetch>(
      async () =>
        new Response(
          JSON.stringify({
            plans: [
              { code: "free", display_name: "免费试用", monthly_price_cny: 0 },
              { code: "plus", display_name: "Plus", monthly_price_cny: 9900 },
            ],
            point_packages: [
              { code: "p0", display_name: "zero", price_cny: 0, points: 0 },
              { code: "p10", display_name: "加油包 ¥10", price_cny: 1000, points: 100 },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubEnv("MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL", phoneCredential.gatewayBaseUrl);
    vi.stubEnv(
      "MOSS_MEMFIRE_PHONE_PAY_BASE_URL",
      "https://wechat.example.test/functions/v1/moss-pay",
    );
    vi.stubEnv("MOSS_SUPABASE_GOOGLE_MODEL_GATEWAY_URL", cloudCredential.gatewayBaseUrl);
    vi.stubGlobal("fetch", fetchMock);

    try {
      const catalog = await Effect.gen(function* () {
        const service = yield* MossPayService;
        return yield* service.getCatalog();
      }).pipe(
        Effect.provide(
          makeMossPayLayer({
            phoneAuthority: () => Effect.succeed(phoneCredential),
            cloudAuthority: () => Effect.succeed(cloudCredential),
          }),
        ),
        Effect.runPromise,
      );

      expect(catalog.plans.map((plan) => plan.code)).toEqual(["plus"]);
      expect(catalog.pointPackages).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("keeps authoritative plan pricing visible when account restore or checkout is unavailable", async () => {
    const fetchMock = vi.fn<TestFetch>(async (url) => {
      const href = String(url);
      if (href.startsWith("https://moss-test.memfiredb.com/rest/v1/moss_plans?")) {
        return new Response(
          JSON.stringify([
            {
              code: "basic",
              display_name: "Basic",
              monthly_price_cny: 4900,
              monthly_token_limit: 5_000_000,
              monthly_request_limit: 2_000,
              model_allowlist: ["gpt-5.6-terra"],
              realtime_model_allowlist: [],
              monthly_realtime_cost_limit_nano_usd: 0,
              monthly_realtime_session_limit: 2_000,
              billing_model: "weighted_credits_v1",
              monthly_credit_limit_micros: 87_000_000,
              five_hour_credit_limit_micros: 12_000_000,
              weekly_credit_limit_micros: 24_000_000,
              standard_task_estimate: 30,
              sort_order: 1,
            },
          ]),
          { status: 200 },
        );
      }
      if (href.startsWith("https://moss-test.memfiredb.com/rest/v1/moss_point_packages?")) {
        return new Response("[]", { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubEnv("MOSS_MEMFIRE_PHONE_URL", "https://moss-test.memfiredb.com");
    vi.stubEnv("MOSS_MEMFIRE_PHONE_PUBLISHABLE_KEY", "test-publishable-key");
    vi.stubEnv("MOSS_SUPABASE_GOOGLE_URL", "");
    vi.stubEnv("MOSS_SUPABASE_GOOGLE_PUBLISHABLE_KEY", "");
    vi.stubGlobal("fetch", fetchMock);

    try {
      const catalog = await Effect.gen(function* () {
        const service = yield* MossPayService;
        return yield* service.getCatalog();
      }).pipe(
        Effect.provide(
          makeMossPayLayer({
            phoneAuthority: () =>
              Effect.fail(
                new MossAccountServiceError({
                  code: "authentication_service_unavailable",
                  message: "restore timed out",
                }),
              ),
            cloudAuthority: () => Effect.succeed(cloudCredential),
          }),
        ),
        Effect.runPromise,
      );

      expect(catalog.paymentMethods).toEqual([]);
      expect(catalog.plans).toEqual([
        expect.objectContaining({
          code: "basic",
          monthlyPriceCny: 4_900,
          monthlyCreditLimit: 87,
          fiveHourCreditLimit: 12,
          weeklyCreditLimit: 24,
          standardTaskEstimate: 30,
        }),
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("ignores the retired single gateway and fails before forwarding a token", async () => {
    const fetchMock = vi.fn<TestFetch>();
    vi.stubEnv("MOSS_MODEL_GATEWAY_URL", phoneCredential.gatewayBaseUrl);
    vi.stubEnv("MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL", "");
    vi.stubEnv("MOSS_SUPABASE_GOOGLE_MODEL_GATEWAY_URL", "");
    vi.stubGlobal("fetch", fetchMock);

    try {
      const failure = await Effect.gen(function* () {
        const service = yield* MossPayService;
        return yield* service.getCatalog();
      }).pipe(
        Effect.provide(
          makeMossPayLayer({
            phoneAuthority: () => Effect.succeed(phoneCredential),
            cloudAuthority: () => Effect.succeed(cloudCredential),
          }),
        ),
        Effect.flip,
        Effect.runPromise,
      );

      expect(failure).toMatchObject({ code: "not_configured" });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("reads realtime quota from the credential-bound realm instead of legacy global routing", async () => {
    const fetchMock = vi.fn<TestFetch>(async (url) => {
      const href = String(url);
      if (href === "https://cn-realtime.example.test/v1/realtime/quota") {
        return new Response(JSON.stringify({ cloudRegion: "cn", configured: true }), {
          status: 200,
        });
      }
      if (href === "https://moss-test.memfiredb.com/rest/v1/rpc/moss_get_credit_usage_snapshot") {
        return new Response(JSON.stringify({ code: "PGRST202", message: "function not found" }), {
          status: 404,
        });
      }
      if (href.startsWith("https://moss-test.memfiredb.com/rest/v1/account_entitlements?")) {
        return new Response(
          JSON.stringify([
            {
              id: "entitlement-1",
              plan_code: "starter",
              realtime_model_allowlist: ["gpt-realtime"],
            },
          ]),
          { status: 200 },
        );
      }
      if (href.startsWith("https://moss-test.memfiredb.com/rest/v1/account_quotas?")) {
        return new Response(
          JSON.stringify([
            {
              id: "quota-1",
              entitlement_id: "entitlement-1",
              period_start: "2026-08-10T00:00:00.000Z",
              period_end: "2026-08-17T00:00:00.000Z",
              request_limit: 500,
              requests_used: 42,
              token_limit: 100_000,
              input_tokens_used: 10_000,
              output_tokens_used: 2_345,
              realtime_cost_limit_nano_usd: 500_000_000,
              realtime_cost_used_nano_usd: 100_000_000,
              realtime_cost_reserved_nano_usd: 20_000_000,
              realtime_session_limit: 20,
              realtime_sessions_used: 3,
            },
          ]),
          { status: 200 },
        );
      }
      if (href.startsWith("https://moss-test.memfiredb.com/rest/v1/credit_wallets?")) {
        return new Response(JSON.stringify([{ balance: 8 }]), { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubEnv("MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL", phoneCredential.gatewayBaseUrl);
    vi.stubEnv("MOSS_MEMFIRE_PHONE_REALTIME_RELAY_URL", phoneCredential.realtimeRelayUrl);
    vi.stubEnv("MOSS_MEMFIRE_PHONE_URL", "https://moss-test.memfiredb.com");
    vi.stubEnv("MOSS_MEMFIRE_PHONE_PUBLISHABLE_KEY", "test-publishable-key");
    vi.stubEnv("MOSS_REALTIME_RELAY_URL", "https://legacy-realtime.example.test");
    vi.stubEnv("MOSS_CLOUD_REGION", "global");
    vi.stubGlobal("fetch", fetchMock);

    try {
      const quota = await Effect.gen(function* () {
        const service = yield* MossPayService;
        return yield* service.getQuota();
      }).pipe(
        Effect.provide(
          makeMossPayLayer({
            phoneAuthority: () => Effect.succeed(phoneCredential),
            cloudAuthority: () => Effect.succeed(cloudCredential),
          }),
        ),
        Effect.runPromise,
      );

      expect(quota).toMatchObject({
        planCode: "starter",
        tokenLimit: 100_000,
        tokensUsed: 12_345,
        requestLimit: 500,
        requestsUsed: 42,
        creditBalance: 8,
        realtimeConfigured: true,
      });
      const realtimeCall = fetchMock.mock.calls.find(
        ([url]) => String(url) === "https://cn-realtime.example.test/v1/realtime/quota",
      );
      expect(realtimeCall?.[1]).toMatchObject({
        headers: expect.objectContaining({
          authorization: "Bearer phone-token",
          "x-moss-cloud-region": "cn",
        }),
      });
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("legacy-realtime"))).toBe(
        false,
      );
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("moss-pay/quota"))).toBe(
        false,
      );
      for (const [url, init] of fetchMock.mock.calls.filter(([url]) =>
        String(url).includes("/rest/v1/"),
      )) {
        expect(String(url)).toContain("https://moss-test.memfiredb.com/rest/v1/");
        expect(init?.headers).toMatchObject({
          apikey: "test-publishable-key",
          authorization: "Bearer phone-token",
        });
      }
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("rejects an authority URL mismatch before sending the account token", async () => {
    const fetchMock = vi.fn<TestFetch>();
    vi.stubEnv("MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL", phoneCredential.gatewayBaseUrl);
    vi.stubEnv("MOSS_MEMFIRE_PHONE_URL", "https://different.memfiredb.com");
    vi.stubEnv("MOSS_MEMFIRE_PHONE_PUBLISHABLE_KEY", "test-publishable-key");
    vi.stubGlobal("fetch", fetchMock);

    try {
      const failure = await Effect.gen(function* () {
        const service = yield* MossPayService;
        return yield* service.getQuota();
      }).pipe(
        Effect.provide(
          makeMossPayLayer({
            phoneAuthority: () => Effect.succeed(phoneCredential),
            cloudAuthority: () => Effect.succeed(cloudCredential),
          }),
        ),
        Effect.flip,
        Effect.runPromise,
      );

      expect(failure).toMatchObject({ code: "not_configured" });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("rejects malformed authority quota counters instead of displaying a false zero", async () => {
    const fetchMock = vi.fn<TestFetch>(async (url) =>
      quotaRestResponse(String(url), { walletBalance: "not-a-counter" }),
    );
    vi.stubEnv("MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL", phoneCredential.gatewayBaseUrl);
    vi.stubEnv("MOSS_MEMFIRE_PHONE_URL", "https://moss-test.memfiredb.com");
    vi.stubEnv("MOSS_MEMFIRE_PHONE_PUBLISHABLE_KEY", "test-publishable-key");
    vi.stubGlobal("fetch", fetchMock);

    try {
      const failure = await Effect.gen(function* () {
        const service = yield* MossPayService;
        return yield* service.getQuota();
      }).pipe(
        Effect.provide(
          makeMossPayLayer({
            phoneAuthority: () => Effect.succeed(phoneCredential),
            cloudAuthority: () => Effect.succeed(cloudCredential),
          }),
        ),
        Effect.flip,
        Effect.runPromise,
      );

      expect(failure).toMatchObject({ code: "invalid_response" });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("falls back to the released quota shape only for an exact missing-column response", async () => {
    const fetchMock = vi.fn<TestFetch>(async (url) => {
      const href = String(url);
      if (
        href.startsWith("https://moss-test.memfiredb.com/rest/v1/account_quotas?") &&
        href.includes("quota_policy_mode")
      ) {
        return new Response(
          JSON.stringify({
            code: "42703",
            message: "column account_quotas.quota_policy_mode does not exist",
          }),
          { status: 400 },
        );
      }
      return quotaRestResponse(href);
    });
    vi.stubEnv("MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL", phoneCredential.gatewayBaseUrl);
    vi.stubEnv("MOSS_MEMFIRE_PHONE_URL", "https://moss-test.memfiredb.com");
    vi.stubEnv("MOSS_MEMFIRE_PHONE_PUBLISHABLE_KEY", "test-publishable-key");
    vi.stubGlobal("fetch", fetchMock);

    try {
      const quota = await Effect.gen(function* () {
        const service = yield* MossPayService;
        return yield* service.getQuota();
      }).pipe(
        Effect.provide(
          makeMossPayLayer({
            phoneAuthority: () => Effect.succeed(phoneCredential),
            cloudAuthority: () => Effect.succeed(cloudCredential),
          }),
        ),
        Effect.runPromise,
      );
      expect(quota.quotaPolicyMode).toBe("metered");
      expect(
        fetchMock.mock.calls.filter(([url]) =>
          String(url).startsWith("https://moss-test.memfiredb.com/rest/v1/account_quotas?"),
        ),
      ).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it.each([
    { label: "401", status: 401, expectedCode: "unauthorized" },
    { label: "5xx", status: 503, expectedCode: "gateway_error" },
    { label: "transport unavailable", status: null, expectedCode: "gateway_unavailable" },
  ] as const)(
    "preserves the fallback $label failure classification",
    async ({ status, expectedCode }) => {
      let quotaRequestCount = 0;
      const fetchMock = vi.fn<TestFetch>(async (url) => {
        const href = String(url);
        if (href.startsWith("https://moss-test.memfiredb.com/rest/v1/account_quotas?")) {
          quotaRequestCount += 1;
          if (quotaRequestCount === 1) {
            return new Response(
              JSON.stringify({
                code: "42703",
                message: "column account_quotas.quota_policy_mode does not exist",
              }),
              { status: 400 },
            );
          }
          if (status === null) throw new TypeError("network unavailable");
          return new Response(JSON.stringify({ code: "fallback_failure" }), { status });
        }
        return quotaRestResponse(href);
      });
      vi.stubEnv("MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL", phoneCredential.gatewayBaseUrl);
      vi.stubEnv("MOSS_MEMFIRE_PHONE_URL", "https://moss-test.memfiredb.com");
      vi.stubEnv("MOSS_MEMFIRE_PHONE_PUBLISHABLE_KEY", "test-publishable-key");
      vi.stubGlobal("fetch", fetchMock);

      try {
        const failure = await Effect.gen(function* () {
          const service = yield* MossPayService;
          return yield* service.getQuota();
        }).pipe(
          Effect.provide(
            makeMossPayLayer({
              phoneAuthority: () => Effect.succeed(phoneCredential),
              cloudAuthority: () => Effect.succeed(cloudCredential),
            }),
          ),
          Effect.flip,
          Effect.runPromise,
        );
        expect(failure).toMatchObject({ code: expectedCode });
        expect(quotaRequestCount).toBe(2);
      } finally {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
      }
    },
  );

  it("does not treat unrelated quota failures as an old-schema signal", async () => {
    const fetchMock = vi.fn<TestFetch>(async (url) => {
      const href = String(url);
      if (href.startsWith("https://moss-test.memfiredb.com/rest/v1/account_quotas?")) {
        return new Response(JSON.stringify({ code: "PGRST000", message: "gateway unavailable" }), {
          status: 503,
        });
      }
      return quotaRestResponse(href);
    });
    vi.stubEnv("MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL", phoneCredential.gatewayBaseUrl);
    vi.stubEnv("MOSS_MEMFIRE_PHONE_URL", "https://moss-test.memfiredb.com");
    vi.stubEnv("MOSS_MEMFIRE_PHONE_PUBLISHABLE_KEY", "test-publishable-key");
    vi.stubGlobal("fetch", fetchMock);

    try {
      const failure = await Effect.gen(function* () {
        const service = yield* MossPayService;
        return yield* service.getQuota();
      }).pipe(
        Effect.provide(
          makeMossPayLayer({
            phoneAuthority: () => Effect.succeed(phoneCredential),
            cloudAuthority: () => Effect.succeed(cloudCredential),
          }),
        ),
        Effect.flip,
        Effect.runPromise,
      );
      expect(failure).toMatchObject({ code: "gateway_error" });
      expect(
        fetchMock.mock.calls.filter(([url]) =>
          String(url).startsWith("https://moss-test.memfiredb.com/rest/v1/account_quotas?"),
        ),
      ).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("rejects an oversized authority response before buffering it", async () => {
    const fetchMock = vi.fn<TestFetch>(async (url) =>
      quotaRestResponse(String(url), {
        entitlementHeaders: { "content-length": String(65 * 1_024) },
      }),
    );
    vi.stubEnv("MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL", phoneCredential.gatewayBaseUrl);
    vi.stubEnv("MOSS_MEMFIRE_PHONE_URL", "https://moss-test.memfiredb.com");
    vi.stubEnv("MOSS_MEMFIRE_PHONE_PUBLISHABLE_KEY", "test-publishable-key");
    vi.stubGlobal("fetch", fetchMock);

    try {
      const failure = await Effect.gen(function* () {
        const service = yield* MossPayService;
        return yield* service.getQuota();
      }).pipe(
        Effect.provide(
          makeMossPayLayer({
            phoneAuthority: () => Effect.succeed(phoneCredential),
            cloudAuthority: () => Effect.succeed(cloudCredential),
          }),
        ),
        Effect.flip,
        Effect.runPromise,
      );

      expect(failure).toMatchObject({ code: "invalid_response" });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});
