import { assert, describe, it } from "@effect/vitest";

import {
  MOSS_LEGACY_PRODUCTION_PUBLIC_CONFIG_KEYS,
  MOSS_OPTIONAL_PRODUCTION_PUBLIC_CONFIG_ENV_KEYS,
  MOSS_PRODUCTION_PUBLIC_CONFIG_ENV_KEYS,
  parseLegacyMossProductionPublicConfig,
  parseMossProductionPublicConfig,
  resolveMossProductionPublicConfig,
  serializeMossProductionPublicConfig,
  toMossProductionPublicConfigEnv,
} from "./mossProductionPublicConfig";

const validEnv = {
  MOSS_PRODUCTION_CONFIG_VERSION: "2",
  MOSS_MEMFIRE_PHONE_URL: "https://moss-cn.baseapi.memfiredb.com",
  MOSS_MEMFIRE_PHONE_PUBLISHABLE_KEY: "memfire_publishable_test",
  MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL:
    "https://model-gateway.moss.cn/functions/v1/moss-model-gateway/v1",
  MOSS_MEMFIRE_PHONE_REALTIME_RELAY_URL: "https://realtime.moss.cn",
  MOSS_SUPABASE_GOOGLE_URL: "https://moss-global.supabase.co",
  MOSS_SUPABASE_GOOGLE_PUBLISHABLE_KEY: "sb_publishable_test",
  MOSS_SUPABASE_GOOGLE_AUTH_REDIRECT_URL: "moss://auth/callback",
  MOSS_SUPABASE_GOOGLE_MODEL_GATEWAY_URL:
    "https://moss-global.supabase.co/functions/v1/moss-model-gateway/v1",
  MOSS_SUPABASE_GOOGLE_REALTIME_RELAY_URL: "https://realtime.moss.example",
} as const;

const expectedConfig = {
  version: 2 as const,
  authRealms: {
    "memfire-phone": {
      authority: "memfire-phone" as const,
      region: "cn" as const,
      authUrl: validEnv.MOSS_MEMFIRE_PHONE_URL,
      publishableKey: validEnv.MOSS_MEMFIRE_PHONE_PUBLISHABLE_KEY,
      modelGatewayUrl: validEnv.MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL,
      realtimeRelayUrl: validEnv.MOSS_MEMFIRE_PHONE_REALTIME_RELAY_URL,
    },
    "supabase-google": {
      authority: "supabase-google" as const,
      region: "global" as const,
      authUrl: validEnv.MOSS_SUPABASE_GOOGLE_URL,
      publishableKey: validEnv.MOSS_SUPABASE_GOOGLE_PUBLISHABLE_KEY,
      authRedirectUrl: validEnv.MOSS_SUPABASE_GOOGLE_AUTH_REDIRECT_URL,
      modelGatewayUrl: validEnv.MOSS_SUPABASE_GOOGLE_MODEL_GATEWAY_URL,
      realtimeRelayUrl: validEnv.MOSS_SUPABASE_GOOGLE_REALTIME_RELAY_URL,
    },
  },
};

const legacyV1Config = {
  MOSS_CLOUD_REGION: "global",
  MOSS_SUPABASE_URL: "https://moss-global.supabase.co",
  MOSS_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  MOSS_AUTH_REDIRECT_URL: "moss://auth/callback",
  MOSS_MODEL_GATEWAY_URL: "https://moss-global.supabase.co/functions/v1/moss-model-gateway/v1",
  MOSS_REALTIME_RELAY_URL: "https://realtime.moss.example",
};

describe("mossProductionPublicConfig v2", () => {
  it("requires both fixed authorities in the same production configuration", () => {
    assert.deepStrictEqual(resolveMossProductionPublicConfig(validEnv), expectedConfig);
    assert.deepStrictEqual(toMossProductionPublicConfigEnv(expectedConfig), {
      ...validEnv,
      MOSS_MEMFIRE_PHONE_PAY_BASE_URL: "",
      MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_FALLBACK_URLS: "",
      MOSS_MEMFIRE_PHONE_PAY_FALLBACK_BASE_URLS: "",
      MOSS_MEMFIRE_PHONE_REALTIME_RELAY_FALLBACK_URLS: "",
      MOSS_SUPABASE_GOOGLE_REALTIME_RELAY_FALLBACK_URLS: "",
    });
  });

  it("carries optional map keys, empty or set, and never echoes a bad one", () => {
    const withMaps = resolveMossProductionPublicConfig({
      ...validEnv,
      MOSS_PUBLIC_MAPS_GOOGLE_API_KEY: "AIzaTestKey_1",
      MOSS_PUBLIC_MAPS_AMAP_KEY: "",
    });
    assert.deepStrictEqual(withMaps.maps, {
      googleApiKey: "AIzaTestKey_1",
      amapKey: "",
      amapSecurityCode: "",
    });
    const parsed = parseMossProductionPublicConfig(serializeMossProductionPublicConfig(withMaps));
    assert.deepStrictEqual(parsed.maps, withMaps.maps);
    assert.equal(
      toMossProductionPublicConfigEnv(parsed).MOSS_PUBLIC_MAPS_GOOGLE_API_KEY,
      "AIzaTestKey_1",
    );
    // The shipped resource lists the section with empty keys until Moss has them.
    const empty = parseMossProductionPublicConfig(
      JSON.stringify({
        ...expectedConfig,
        maps: { googleApiKey: "", amapKey: "", amapSecurityCode: "" },
      }),
    );
    assert.deepStrictEqual(empty.maps, { googleApiKey: "", amapKey: "", amapSecurityCode: "" });
    assert.throws(
      () =>
        parseMossProductionPublicConfig(
          JSON.stringify({ ...expectedConfig, maps: { mapboxToken: "x" } }),
        ),
      /unsupported setting mapboxToken/,
    );
    let message = "";
    try {
      resolveMossProductionPublicConfig({
        ...validEnv,
        MOSS_PUBLIC_MAPS_AMAP_KEY: "bad key<script>",
      });
    } catch (error) {
      message = String(error);
    }
    assert.include(message, "MOSS_PUBLIC_MAPS_AMAP_KEY");
    assert.notInclude(message, "bad key");
  });

  it("fails strict production when the version or either realm is incomplete", () => {
    for (const key of MOSS_PRODUCTION_PUBLIC_CONFIG_ENV_KEYS) {
      if ((MOSS_OPTIONAL_PRODUCTION_PUBLIC_CONFIG_ENV_KEYS as ReadonlyArray<string>).includes(key))
        continue;
      assert.throws(
        () => resolveMossProductionPublicConfig({ ...validEnv, [key]: "" }),
        new RegExp(key),
      );
    }
    assert.throws(
      () => resolveMossProductionPublicConfig({ ...validEnv, MOSS_PRODUCTION_CONFIG_VERSION: "1" }),
      /MOSS_PRODUCTION_CONFIG_VERSION must be exactly 2/,
    );
  });

  it("round-trips an explicit phone payment endpoint without deriving it from the model gateway", () => {
    const paymentUrl = "https://payments.moss.example/functions/v1/moss-pay";
    const config = resolveMossProductionPublicConfig({
      ...validEnv,
      MOSS_MEMFIRE_PHONE_PAY_BASE_URL: `${paymentUrl}/`,
    });
    assert.equal(config.authRealms["memfire-phone"].payBaseUrl, paymentUrl);
    const serialized = serializeMossProductionPublicConfig(config);
    const parsed = parseMossProductionPublicConfig(serialized);
    assert.deepStrictEqual(parsed, config);
    assert.equal(
      toMossProductionPublicConfigEnv(parsed).MOSS_MEMFIRE_PHONE_PAY_BASE_URL,
      paymentUrl,
    );
    assert.deepStrictEqual(
      parsed.authRealms["supabase-google"],
      expectedConfig.authRealms["supabase-google"],
    );

    for (const value of [undefined, "", "   "]) {
      const disabled = resolveMossProductionPublicConfig({
        ...validEnv,
        MOSS_MEMFIRE_PHONE_PAY_BASE_URL: value,
      });
      assert.deepStrictEqual(disabled, expectedConfig);
      assert.ok(!serializeMossProductionPublicConfig(disabled).includes("payBaseUrl"));
      assert.equal(toMossProductionPublicConfigEnv(disabled).MOSS_MEMFIRE_PHONE_PAY_BASE_URL, "");
    }
  });

  it("carries ordered CN fallback entries for models and payments, and reads older manifests", () => {
    const paymentUrl = "https://moss-pay.moss.cn/functions/v1/moss-pay";
    const modelFallback = "https://tunnel.moss.example/functions/v1/moss-model-gateway/v1";
    const payFallback = "https://tunnel.moss.example/functions/v1/moss-pay";
    const config = resolveMossProductionPublicConfig({
      ...validEnv,
      MOSS_MEMFIRE_PHONE_PAY_BASE_URL: paymentUrl,
      MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_FALLBACK_URLS: ` ${modelFallback} `,
      MOSS_MEMFIRE_PHONE_PAY_FALLBACK_BASE_URLS: `${payFallback}/`,
    });
    const phone = config.authRealms["memfire-phone"];
    assert.equal(phone.modelGatewayUrl, validEnv.MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL);
    assert.deepStrictEqual(phone.modelGatewayFallbackUrls, [modelFallback]);
    assert.deepStrictEqual(phone.payFallbackBaseUrls, [payFallback]);
    const parsed = parseMossProductionPublicConfig(serializeMossProductionPublicConfig(config));
    assert.deepStrictEqual(parsed, config);
    const env = toMossProductionPublicConfigEnv(parsed);
    assert.equal(env.MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_FALLBACK_URLS, modelFallback);
    assert.equal(env.MOSS_MEMFIRE_PHONE_PAY_FALLBACK_BASE_URLS, payFallback);
    // A manifest from before fallbacks existed still loads, with the old key as the only entry.
    const older = parseMossProductionPublicConfig(JSON.stringify(expectedConfig));
    assert.equal(older.authRealms["memfire-phone"].modelGatewayFallbackUrls, undefined);
    assert.equal(
      older.authRealms["memfire-phone"].modelGatewayUrl,
      validEnv.MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL,
    );
  });

  it("refuses fallback entries that break the primary's rules, repeat, or stand alone", () => {
    const paymentUrl = "https://moss-pay.moss.cn/functions/v1/moss-pay";
    for (const [key, value, extra] of [
      [
        "MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_FALLBACK_URLS",
        "http://tunnel.moss.example/functions/v1/moss-model-gateway/v1",
        {},
      ],
      [
        "MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_FALLBACK_URLS",
        "https://tunnel.moss.example/functions/v1/moss-pay",
        {},
      ],
      [
        "MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_FALLBACK_URLS",
        "https://moss-cn.baseapi.memfiredb.com/functions/v1/moss-model-gateway/v1",
        {},
      ],
      [
        "MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_FALLBACK_URLS",
        validEnv.MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL,
        {},
      ],
      [
        "MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_FALLBACK_URLS",
        "https://a.moss.example/functions/v1/moss-model-gateway/v1,https://b.moss.example/functions/v1/moss-model-gateway/v1,https://c.moss.example/functions/v1/moss-model-gateway/v1,https://d.moss.example/functions/v1/moss-model-gateway/v1",
        {},
      ],
      [
        "MOSS_MEMFIRE_PHONE_PAY_FALLBACK_BASE_URLS",
        "https://tunnel.moss.example/functions/v1/moss-pay",
        {},
      ],
      [
        "MOSS_MEMFIRE_PHONE_PAY_FALLBACK_BASE_URLS",
        "https://tunnel.moss.example/functions/v1/moss-model-gateway/v1",
        { MOSS_MEMFIRE_PHONE_PAY_BASE_URL: paymentUrl },
      ],
      [
        "MOSS_MEMFIRE_PHONE_PAY_FALLBACK_BASE_URLS",
        paymentUrl,
        { MOSS_MEMFIRE_PHONE_PAY_BASE_URL: paymentUrl },
      ],
    ] as const) {
      assert.throws(
        () => resolveMossProductionPublicConfig({ ...validEnv, ...extra, [key]: value }),
        new RegExp(key),
      );
    }
    for (const value of ["one-url", [1], ["a b"], [""]]) {
      const document = structuredClone(expectedConfig);
      Object.assign(document.authRealms["memfire-phone"], { modelGatewayFallbackUrls: value });
      assert.throws(
        () => parseMossProductionPublicConfig(JSON.stringify(document)),
        /modelGatewayFallbackUrls must be a list of URLs/,
      );
    }
  });

  it("carries ordered realtime relay fallback entries for both realms, and reads older manifests", () => {
    const cnFallback = "https://realtime-old.moss.cn";
    const globalFallback = "https://realtime-old.moss.example";
    const config = resolveMossProductionPublicConfig({
      ...validEnv,
      MOSS_MEMFIRE_PHONE_REALTIME_RELAY_FALLBACK_URLS: ` ${cnFallback}/ `,
      MOSS_SUPABASE_GOOGLE_REALTIME_RELAY_FALLBACK_URLS: globalFallback,
    });
    assert.deepStrictEqual(config.authRealms["memfire-phone"].realtimeRelayFallbackUrls, [
      cnFallback,
    ]);
    assert.deepStrictEqual(config.authRealms["supabase-google"].realtimeRelayFallbackUrls, [
      globalFallback,
    ]);
    const parsed = parseMossProductionPublicConfig(serializeMossProductionPublicConfig(config));
    assert.deepStrictEqual(parsed, config);
    const env = toMossProductionPublicConfigEnv(parsed);
    assert.equal(env.MOSS_MEMFIRE_PHONE_REALTIME_RELAY_FALLBACK_URLS, cnFallback);
    assert.equal(env.MOSS_SUPABASE_GOOGLE_REALTIME_RELAY_FALLBACK_URLS, globalFallback);
    // A release with the single relay URL only (1.0.3 and earlier) loads exactly as before.
    const older = parseMossProductionPublicConfig(JSON.stringify(expectedConfig));
    assert.equal(older.authRealms["memfire-phone"].realtimeRelayFallbackUrls, undefined);
    assert.equal(older.authRealms["supabase-google"].realtimeRelayFallbackUrls, undefined);
    assert.ok(
      MOSS_OPTIONAL_PRODUCTION_PUBLIC_CONFIG_ENV_KEYS.includes(
        "MOSS_SUPABASE_GOOGLE_REALTIME_RELAY_FALLBACK_URLS",
      ),
    );
  });

  it("refuses realtime fallback entries that break the relay rules, repeat, cross realms, or stand alone", () => {
    for (const [key, value, extra] of [
      ["MOSS_MEMFIRE_PHONE_REALTIME_RELAY_FALLBACK_URLS", "http://realtime-old.moss.cn", {}],
      ["MOSS_MEMFIRE_PHONE_REALTIME_RELAY_FALLBACK_URLS", "https://realtime-old.moss.cn/v1", {}],
      ["MOSS_MEMFIRE_PHONE_REALTIME_RELAY_FALLBACK_URLS", "https://realtime-old.moss.cn:8443", {}],
      [
        "MOSS_MEMFIRE_PHONE_REALTIME_RELAY_FALLBACK_URLS",
        "https://moss-cn.baseapi.memfiredb.com",
        {},
      ],
      [
        "MOSS_MEMFIRE_PHONE_REALTIME_RELAY_FALLBACK_URLS",
        validEnv.MOSS_MEMFIRE_PHONE_REALTIME_RELAY_URL,
        {},
      ],
      [
        "MOSS_MEMFIRE_PHONE_REALTIME_RELAY_FALLBACK_URLS",
        "https://a.moss.cn,https://b.moss.cn,https://c.moss.cn,https://d.moss.cn",
        {},
      ],
      [
        "MOSS_SUPABASE_GOOGLE_REALTIME_RELAY_FALLBACK_URLS",
        "https://realtime-old.moss.example",
        { MOSS_SUPABASE_GOOGLE_REALTIME_RELAY_URL: undefined },
      ],
    ] as const) {
      assert.throws(
        () => resolveMossProductionPublicConfig({ ...validEnv, ...extra, [key]: value }),
        new RegExp(key.replace(/_FALLBACK_URLS$/u, "")),
      );
    }
    // One entry serving both realms would send one realm's bearer to the other's relay.
    assert.throws(
      () =>
        resolveMossProductionPublicConfig({
          ...validEnv,
          MOSS_MEMFIRE_PHONE_REALTIME_RELAY_FALLBACK_URLS:
            validEnv.MOSS_SUPABASE_GOOGLE_REALTIME_RELAY_URL,
        }),
      /distinct relay origins/,
    );
    const document = structuredClone(expectedConfig);
    Object.assign(document.authRealms["supabase-google"], { realtimeRelayFallbackUrls: "one-url" });
    assert.throws(
      () => parseMossProductionPublicConfig(JSON.stringify(document)),
      /supabase-google\.realtimeRelayFallbackUrls must be a list of URLs/,
    );
  });

  it("rejects unsafe or malformed payment routes in both environment and release JSON", () => {
    for (const value of [
      "http://payments.moss.example/functions/v1/moss-pay",
      "https://127.0.0.1/functions/v1/moss-pay",
      "https://user:password@payments.moss.example/functions/v1/moss-pay",
      "https://payments.moss.example:8443/functions/v1/moss-pay",
      "https://payments.moss.example:443/functions/v1/moss-pay",
      "https://PAYMENTS.moss.example/functions/v1/moss-pay",
      "https://payments.moss.example/functions/v1/other/../moss-pay",
      "https://payments.moss.example/functions/v1/moss-pay?target=other",
      "https://payments.moss.example/functions/v1/moss-pay#other",
      "https://payments.moss.example/functions/v1/moss-model-gateway/v1",
      "https://moss-cn.baseapi.memfiredb.com/functions/v1/moss-pay",
      "https://moss-global.supabase.co/functions/v1/moss-pay",
      "https://api.openai.com/functions/v1/moss-pay",
    ]) {
      assert.throws(
        () =>
          resolveMossProductionPublicConfig({
            ...validEnv,
            MOSS_MEMFIRE_PHONE_PAY_BASE_URL: value,
          }),
        /MOSS_MEMFIRE_PHONE_PAY_BASE_URL/,
      );
      const document = structuredClone(expectedConfig);
      Object.assign(document.authRealms["memfire-phone"], { payBaseUrl: value });
      assert.throws(() => parseMossProductionPublicConfig(JSON.stringify(document)));
    }
    for (const value of [null, 123, {}, []]) {
      const document = structuredClone(expectedConfig);
      Object.assign(document.authRealms["memfire-phone"], { payBaseUrl: value });
      assert.throws(
        () => parseMossProductionPublicConfig(JSON.stringify(document)),
        /payBaseUrl must be a string/,
      );
    }
  });

  it("pins phone Auth to a canonical MemFire Cloud project origin", () => {
    assert.equal(
      resolveMossProductionPublicConfig({
        ...validEnv,
        MOSS_MEMFIRE_PHONE_URL: "https://moss-cn.baseapi.memfiredb.com/",
      }).authRealms["memfire-phone"].authUrl,
      "https://moss-cn.baseapi.memfiredb.com",
    );

    for (const value of [
      "https://moss-global.supabase.co",
      "https://baseapi.memfiredb.com",
      "https://nested.moss-cn.baseapi.memfiredb.com",
      "https://moss-cn.baseapi.memfiredb.com.evil.example",
      "https://moss-cn.baseapi.memfiredb.com:8443",
      "https://moss-cn.baseapi.memfiredb.com/auth/v1",
      "https://MOSS-CN.baseapi.memfiredb.com",
      "https://moss-cn.baseapi.memfiredb.com./",
      "https://user:password@moss-cn.baseapi.memfiredb.com",
      "http://moss-cn.baseapi.memfiredb.com",
    ]) {
      assert.throws(() =>
        resolveMossProductionPublicConfig({ ...validEnv, MOSS_MEMFIRE_PHONE_URL: value }),
      );
    }
  });

  it("pins Google Auth to a canonical Supabase project origin and exact callback", () => {
    assert.equal(
      resolveMossProductionPublicConfig({
        ...validEnv,
        MOSS_SUPABASE_GOOGLE_URL: "https://moss-global.supabase.co/",
      }).authRealms["supabase-google"].authUrl,
      "https://moss-global.supabase.co",
    );

    for (const value of [
      "https://moss-cn.baseapi.memfiredb.com",
      "https://supabase.co",
      "https://nested.moss-global.supabase.co",
      "https://moss-global.supabase.co.evil.example",
      "https://moss-global.supabase.co/rest/v1",
      "https://MOSS-GLOBAL.supabase.co",
      "https://moss-global.supabase.co./",
      "http://moss-global.supabase.co",
    ]) {
      assert.throws(() =>
        resolveMossProductionPublicConfig({ ...validEnv, MOSS_SUPABASE_GOOGLE_URL: value }),
      );
    }

    for (const value of [
      "moss://auth/callback/",
      "moss://auth/other",
      "other://auth/callback",
      "https://auth.moss.example/callback",
    ]) {
      assert.throws(() =>
        resolveMossProductionPublicConfig({
          ...validEnv,
          MOSS_SUPABASE_GOOGLE_AUTH_REDIRECT_URL: value,
        }),
      );
    }
  });

  it("validates exact gateway paths and prevents cross-authority routing", () => {
    for (const value of [
      "https://moss-cn.baseapi.memfiredb.com/functions/v1/moss-model-gateway/v1",
      "https://moss-global.supabase.co/functions/v1/moss-model-gateway/v1",
      "https://i-helios.top/functions/v1/moss-model-gateway/v1",
      "https://model-gateway.moss.cn/functions/v1/moss-model-gateway/other",
      "https://model-gateway.moss.cn/functions/v1/moss-model-gateway/v1/extra",
      "https://model-gateway.moss.cn/functions/v1/temporary/%2e%2e/moss-model-gateway/v1",
      "https://MODEL-GATEWAY.moss.cn/functions/v1/moss-model-gateway/v1",
      "https://model-gateway.moss.cn:443/functions/v1/moss-model-gateway/v1",
      "https://model-gateway.moss.cn/functions/v1/moss-model-gateway/v1?",
    ]) {
      assert.throws(() =>
        resolveMossProductionPublicConfig({
          ...validEnv,
          MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL: value,
        }),
      );
    }

    assert.equal(
      resolveMossProductionPublicConfig({
        ...validEnv,
        MOSS_SUPABASE_GOOGLE_MODEL_GATEWAY_URL:
          "https://moss-global.supabase.co/functions/v1/moss-model-gateway",
      }).authRealms["supabase-google"].modelGatewayUrl,
      "https://moss-global.supabase.co/functions/v1/moss-model-gateway",
    );
    for (const value of [
      "https://other.supabase.co/functions/v1/moss-model-gateway/v1",
      "https://model-gateway.moss.example/functions/v1/moss-model-gateway/v1",
      "https://moss-global.supabase.co/functions/v1/other/v1",
    ]) {
      assert.throws(() =>
        resolveMossProductionPublicConfig({
          ...validEnv,
          MOSS_SUPABASE_GOOGLE_MODEL_GATEWAY_URL: value,
        }),
      );
    }
  });

  it("requires canonical distinct Moss relay origins", () => {
    for (const key of [
      "MOSS_MEMFIRE_PHONE_REALTIME_RELAY_URL",
      "MOSS_SUPABASE_GOOGLE_REALTIME_RELAY_URL",
    ] as const) {
      for (const value of [
        "http://realtime.moss.example",
        "https://localhost",
        "https://127.0.0.1",
        "https://api.openai.com",
        "https://moss-global.supabase.co",
        "https://moss-cn.baseapi.memfiredb.com",
        "https://realtime.moss.example/v1",
        "https://REALTIME.moss.example",
        "https://realtime.moss.example:443",
      ]) {
        assert.throws(() => resolveMossProductionPublicConfig({ ...validEnv, [key]: value }));
      }
    }

    assert.throws(
      () =>
        resolveMossProductionPublicConfig({
          ...validEnv,
          MOSS_SUPABASE_GOOGLE_REALTIME_RELAY_URL: validEnv.MOSS_MEMFIRE_PHONE_REALTIME_RELAY_URL,
        }),
      /distinct relay origins/,
    );
  });

  it("serializes a versioned allowlisted JSON document with no upstream secrets", () => {
    const serialized = serializeMossProductionPublicConfig(expectedConfig);
    assert.deepStrictEqual(JSON.parse(serialized), expectedConfig);
    assert.deepStrictEqual(parseMossProductionPublicConfig(serialized), expectedConfig);
    for (const forbidden of [
      "MOSS_MODEL_GATEWAY_API_KEY",
      "MOSS_APIMART_API_KEY",
      "SERVICE_ROLE",
      "must-not-ship",
    ]) {
      assert.ok(!serialized.includes(forbidden));
    }

    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    parsed.MOSS_APIMART_API_KEY = "must-not-ship";
    assert.throws(() => parseMossProductionPublicConfig(JSON.stringify(parsed)), /unsupported/);
  });

  it("rejects v1 in the strict parser while retaining an explicit migration-only parser", () => {
    assert.throws(
      () => parseMossProductionPublicConfig(JSON.stringify(legacyV1Config)),
      /version 2/,
    );
    assert.deepStrictEqual(
      parseLegacyMossProductionPublicConfig(JSON.stringify(legacyV1Config)),
      legacyV1Config,
    );
    assert.deepStrictEqual(Object.keys(legacyV1Config), [
      ...MOSS_LEGACY_PRODUCTION_PUBLIC_CONFIG_KEYS,
    ]);
  });

  it("rejects unknown nested fields and realm substitutions", () => {
    for (const config of [
      { ...expectedConfig, extra: "unsupported" },
      {
        ...expectedConfig,
        authRealms: {
          ...expectedConfig.authRealms,
          "memfire-phone": { ...expectedConfig.authRealms["memfire-phone"], extra: "bad" },
        },
      },
      {
        ...expectedConfig,
        authRealms: {
          ...expectedConfig.authRealms,
          "memfire-phone": {
            ...expectedConfig.authRealms["memfire-phone"],
            authority: "supabase-google",
          },
        },
      },
      {
        ...expectedConfig,
        authRealms: {
          ...expectedConfig.authRealms,
          "supabase-google": {
            ...expectedConfig.authRealms["supabase-google"],
            region: "cn",
          },
        },
      },
    ]) {
      assert.throws(() => parseMossProductionPublicConfig(JSON.stringify(config)));
    }
  });
});
