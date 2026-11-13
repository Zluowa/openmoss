import { readFileSync } from "node:fs";

import {
  parseMossProductionPublicConfig,
  toMossProductionPublicConfigEnv,
} from "@moss/shared/mossProductionPublicConfig";
import { describe, expect, it } from "vitest";

import {
  isTrustedMossManagedGatewayUrl,
  isTrustedMossManagedGatewayUrlForAuthority,
  mossManagedGatewayEntriesForAuthority,
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

  it("trusts exactly the listed CN fallback entries, and only for the CN lanes", () => {
    const fallback = "https://fallback.moss.example.cn/functions/v1/moss-model-gateway/v1";
    const globalGateway = "https://models.moss.example/functions/v1/moss-model-gateway/v1";
    const env = {
      MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL: DOMESTIC_GATEWAY,
      MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_FALLBACK_URLS: fallback,
      MOSS_SUPABASE_GOOGLE_MODEL_GATEWAY_URL: globalGateway,
    };

    expect(mossManagedGatewayEntriesForAuthority("memfire-phone", env)).toEqual([
      DOMESTIC_GATEWAY,
      fallback,
    ]);
    expect(mossManagedGatewayEntriesForAuthority("moss-enterprise-key", env)).toEqual([
      DOMESTIC_GATEWAY,
      fallback,
    ]);
    expect(mossManagedGatewayEntriesForAuthority("supabase-google", env)).toEqual([globalGateway]);
    for (const authority of ["memfire-phone", "moss-enterprise-key"] as const) {
      expect(isTrustedMossManagedGatewayUrlForAuthority(fallback, authority, env)).toBe(true);
    }
    expect(isTrustedMossManagedGatewayUrlForAuthority(fallback, "supabase-google", env)).toBe(
      false,
    );
    // Nothing near the listed entry: no sibling host, parent domain, other path or scheme.
    for (const candidate of [
      "https://other.moss.example.cn/functions/v1/moss-model-gateway/v1",
      "https://moss.example.cn/functions/v1/moss-model-gateway/v1",
      "https://fallback.moss.example.cn/functions/v1/moss-pay",
      "http://fallback.moss.example.cn/functions/v1/moss-model-gateway/v1",
      "https://fallback.moss.example.cn:8443/functions/v1/moss-model-gateway/v1",
    ]) {
      expect(isTrustedMossManagedGatewayUrl(candidate, env)).toBe(false);
    }
  });

  it("trusts no fallback without a configured primary, and never a loopback fallback", () => {
    const fallback = "https://fallback.moss.example.cn/functions/v1/moss-model-gateway/v1";
    expect(
      isTrustedMossManagedGatewayUrl(fallback, {
        MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_FALLBACK_URLS: fallback,
      }),
    ).toBe(false);
    expect(
      isTrustedMossManagedGatewayUrl(LOOPBACK_GATEWAY, {
        MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL: DOMESTIC_GATEWAY,
        MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_FALLBACK_URLS: LOOPBACK_GATEWAY,
      }),
    ).toBe(false);
  });
});

describe("the shipped release's CN gateway entries", () => {
  const shippedEnv = toMossProductionPublicConfigEnv(
    parseMossProductionPublicConfig(
      readFileSync(
        new URL("../../../desktop/resources/moss-production-public-config.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const NEW = "https://api.mossbotai.com/functions/v1/moss-model-gateway/v1";
  const TUNNEL = "https://moss-cn-models.inkcomicai.com/functions/v1/moss-model-gateway/v1";
  const DIRECT = "https://moss-models.comiction.cn/functions/v1/moss-model-gateway/v1";

  it("lists the mossbotai.com entry first and both old entries after it, for phone and key lanes", () => {
    for (const authority of ["memfire-phone", "moss-enterprise-key"] as const) {
      expect(mossManagedGatewayEntriesForAuthority(authority, shippedEnv)).toEqual([
        NEW,
        TUNNEL,
        DIRECT,
      ]);
      for (const entry of [NEW, TUNNEL, DIRECT]) {
        expect(isTrustedMossManagedGatewayUrlForAuthority(entry, authority, shippedEnv)).toBe(true);
        // Lanes provisioned before keep their base URL without the /v1 suffix (Claude).
        expect(
          isTrustedMossManagedGatewayUrlForAuthority(
            entry.replace(/\/v1$/u, ""),
            authority,
            shippedEnv,
          ),
        ).toBe(true);
      }
    }
    for (const entry of [NEW, TUNNEL, DIRECT]) {
      expect(isTrustedMossManagedGatewayUrlForAuthority(entry, "supabase-google", shippedEnv)).toBe(
        false,
      );
    }
  });

  it("trusts nothing that only looks like a listed entry", () => {
    for (const candidate of [
      "https://api.mossbotai.com.evil.example/functions/v1/moss-model-gateway/v1",
      "https://evil-mossbotai.com/functions/v1/moss-model-gateway/v1",
      "https://mossbotai.com/functions/v1/moss-model-gateway/v1",
      "https://share.mossbotai.com/functions/v1/moss-model-gateway/v1",
      "https://pay.mossbotai.com/functions/v1/moss-model-gateway/v1",
      "http://api.mossbotai.com/functions/v1/moss-model-gateway/v1",
      "https://api.mossbotai.com:8443/functions/v1/moss-model-gateway/v1",
      "https://api.mossbotai.com/functions/v1/moss-pay",
      "https://api.mossbotai.com/functions/v1/other-gateway/v1",
      "https://api.mossbotai.com/v1",
      "https://user@api.mossbotai.com/functions/v1/moss-model-gateway/v1",
      "https://api.mossbotai.com/functions/v1/moss-model-gateway/v1?next=evil",
    ]) {
      expect(isTrustedMossManagedGatewayUrl(candidate, shippedEnv)).toBe(false);
      for (const authority of ["memfire-phone", "moss-enterprise-key"] as const) {
        expect(isTrustedMossManagedGatewayUrlForAuthority(candidate, authority, shippedEnv)).toBe(
          false,
        );
      }
    }
  });
});
