import { assert, describe, it } from "@effect/vitest";

import {
  MOSS_LEGACY_PRODUCTION_PUBLIC_CONFIG_KEYS,
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
    });
  });

  it("fails strict production when the version or either realm is incomplete", () => {
    for (const key of MOSS_PRODUCTION_PUBLIC_CONFIG_ENV_KEYS) {
      if (key === "MOSS_MEMFIRE_PHONE_PAY_BASE_URL") continue;
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
