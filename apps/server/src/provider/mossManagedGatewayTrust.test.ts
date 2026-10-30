import { describe, expect, it } from "vitest";

import {
  isTrustedMossManagedGatewayUrl,
  isTrustedMossManagedGatewayUrlForAuthority,
} from "./mossManagedGatewayTrust";

const LOOPBACK_GATEWAY = "http://127.0.0.1:54321/functions/v1/moss-model-gateway/v1";
const DOMESTIC_GATEWAY = "https://models.moss.example.cn/functions/v1/moss-model-gateway/v1";

describe("isTrustedMossManagedGatewayUrl", () => {
  it("trusts only the deliberate path variants on a configured v2 authority gateway", () => {
    for (const gateway of [
      "https://models.moss.example.cn/functions/v1/moss-model-gateway",
      "https://models.moss.example.cn/functions/v1/moss-model-gateway/",
      DOMESTIC_GATEWAY,
      `${DOMESTIC_GATEWAY}/`,
    ]) {
      expect(
        isTrustedMossManagedGatewayUrl(gateway, {
          MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL:
            "https://models.moss.example.cn/functions/v1/moss-model-gateway/",
        }),
      ).toBe(true);
    }
  });

  it("rejects raw dot segments before URL parsing can normalize them", () => {
    const env = {
      MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL: DOMESTIC_GATEWAY,
    };

    for (const gateway of [
      "https://models.moss.example.cn/functions/%2e/v1/moss-model-gateway/v1",
      "https://models.moss.example.cn/functions/discard/%2E%2E/v1/moss-model-gateway/v1",
      "https://models.moss.example.cn/functions/./v1/moss-model-gateway/v1",
      "https://models.moss.example.cn/functions/discard/../v1/moss-model-gateway/v1",
    ]) {
      expect(isTrustedMossManagedGatewayUrl(gateway, env)).toBe(false);
    }
  });

  it("does not infer gateway trust from auth origins or the retired single gateway key", () => {
    const authGateway = "https://auth.moss.example.cn/functions/v1/moss-model-gateway/v1";

    expect(
      isTrustedMossManagedGatewayUrl(authGateway, {
        MOSS_MEMFIRE_PHONE_URL: "https://auth.moss.example.cn",
      }),
    ).toBe(false);
    expect(
      isTrustedMossManagedGatewayUrl(authGateway, {
        MOSS_MEMFIRE_PHONE_URL: "https://auth.moss.example.cn",
        MOSS_MODEL_GATEWAY_URL: DOMESTIC_GATEWAY,
      }),
    ).toBe(false);
    expect(
      isTrustedMossManagedGatewayUrl(DOMESTIC_GATEWAY, {
        MOSS_MODEL_GATEWAY_URL: DOMESTIC_GATEWAY,
      }),
    ).toBe(false);
  });

  it("does not implicitly trust a loopback relay", () => {
    expect(isTrustedMossManagedGatewayUrl(LOOPBACK_GATEWAY, {})).toBe(false);
  });

  it("trusts a loopback relay only when its exact origin is configured", () => {
    expect(
      isTrustedMossManagedGatewayUrl(LOOPBACK_GATEWAY, {
        MOSS_TRUSTED_MODEL_GATEWAY_ORIGINS: "http://127.0.0.1:54321",
      }),
    ).toBe(true);
    expect(
      isTrustedMossManagedGatewayUrl(LOOPBACK_GATEWAY, {
        MOSS_TRUSTED_MODEL_GATEWAY_ORIGINS: "http://127.0.0.1:54322",
      }),
    ).toBe(false);
    expect(
      isTrustedMossManagedGatewayUrl(LOOPBACK_GATEWAY, {
        MOSS_TRUSTED_MODEL_GATEWAY_ORIGINS: "http://127.0.0.1:54321/not-an-origin",
      }),
    ).toBe(false);
  });

  it("does not use the auth origin or a non-loopback explicit origin as a trust override", () => {
    expect(
      isTrustedMossManagedGatewayUrl(LOOPBACK_GATEWAY, {
        MOSS_SUPABASE_URL: "http://127.0.0.1:54321",
      }),
    ).toBe(false);
    expect(
      isTrustedMossManagedGatewayUrl(DOMESTIC_GATEWAY, {
        MOSS_TRUSTED_MODEL_GATEWAY_ORIGINS: "https://models.moss.example.cn",
      }),
    ).toBe(false);
  });

  it("rejects lookalike paths and URL metadata on a trusted origin", () => {
    const env = {
      MOSS_TRUSTED_MODEL_GATEWAY_ORIGINS: "http://127.0.0.1:54321",
    };

    expect(
      isTrustedMossManagedGatewayUrl(
        "http://127.0.0.1:54321/functions/v1/moss-model-gateway-evil",
        env,
      ),
    ).toBe(false);
    expect(isTrustedMossManagedGatewayUrl(`${LOOPBACK_GATEWAY}?target=evil`, env)).toBe(false);
    expect(isTrustedMossManagedGatewayUrl(`${LOOPBACK_GATEWAY}#fragment`, env)).toBe(false);
    expect(
      isTrustedMossManagedGatewayUrl(
        "http://user@127.0.0.1:54321/functions/v1/moss-model-gateway/v1",
        env,
      ),
    ).toBe(false);
  });

  it("rejects different and malicious origins even when their gateway path is valid", () => {
    const env = {
      MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL: DOMESTIC_GATEWAY,
    };

    expect(
      isTrustedMossManagedGatewayUrl(
        "https://models.moss.example.cn:8443/functions/v1/moss-model-gateway/v1",
        env,
      ),
    ).toBe(false);
    expect(
      isTrustedMossManagedGatewayUrl(
        "https://models.moss.example.cn.attacker.test/functions/v1/moss-model-gateway/v1",
        env,
      ),
    ).toBe(false);
  });

  it("does not trust an invalid configured gateway", () => {
    for (const configuredGateway of [
      "http://models.moss.example.cn/functions/v1/moss-model-gateway/v1",
      "https://user@models.moss.example.cn/functions/v1/moss-model-gateway/v1",
      "https://models.moss.example.cn/functions/v1/moss-model-gateway-evil/v1",
      "https://models.moss.example.cn/functions/%2e/v1/moss-model-gateway/v1",
      "https://models.moss.example.cn/functions/discard/%2E%2E/v1/moss-model-gateway/v1",
      `${DOMESTIC_GATEWAY}?target=evil`,
      `${DOMESTIC_GATEWAY}#fragment`,
    ]) {
      expect(
        isTrustedMossManagedGatewayUrl(DOMESTIC_GATEWAY, {
          MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL: configuredGateway,
        }),
      ).toBe(false);
    }
  });

  it("binds an authority credential to its own regional gateway", () => {
    const globalGateway = "https://models.moss.example/functions/v1/moss-model-gateway/v1";
    const env = {
      MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL: DOMESTIC_GATEWAY,
      MOSS_SUPABASE_GOOGLE_MODEL_GATEWAY_URL: globalGateway,
    };

    expect(isTrustedMossManagedGatewayUrl(DOMESTIC_GATEWAY, env)).toBe(true);
    expect(isTrustedMossManagedGatewayUrl(globalGateway, env)).toBe(true);
    expect(isTrustedMossManagedGatewayUrlForAuthority(DOMESTIC_GATEWAY, "memfire-phone", env)).toBe(
      true,
    );
    expect(isTrustedMossManagedGatewayUrlForAuthority(globalGateway, "supabase-google", env)).toBe(
      true,
    );
    expect(isTrustedMossManagedGatewayUrlForAuthority(globalGateway, "memfire-phone", env)).toBe(
      false,
    );
    expect(
      isTrustedMossManagedGatewayUrlForAuthority(DOMESTIC_GATEWAY, "supabase-google", env),
    ).toBe(false);
  });
});
