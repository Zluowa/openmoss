import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  loadMossProductionPublicConfig,
  mergeMossProductionPublicConfigIntoEnv,
} from "./mossProductionPublicConfig";

const tempDirs = new Set<string>();
const publicConfig = {
  version: 2,
  authRealms: {
    "memfire-phone": {
      authority: "memfire-phone",
      region: "cn",
      authUrl: "https://moss-cn.baseapi.memfiredb.com",
      publishableKey: "memfire_publishable_test",
      modelGatewayUrl: "https://model-gateway.moss.cn/functions/v1/moss-model-gateway/v1",
      realtimeRelayUrl: "https://realtime.moss.cn",
    },
    "supabase-google": {
      authority: "supabase-google",
      region: "global",
      authUrl: "https://moss-global.supabase.co",
      publishableKey: "sb_publishable_test",
      authRedirectUrl: "moss://auth/callback",
      modelGatewayUrl: "https://moss-global.supabase.co/functions/v1/moss-model-gateway/v1",
      realtimeRelayUrl: "https://realtime.moss.example",
    },
  },
};

function writeResource(contents: string): string {
  const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "moss-production-config-test-"));
  tempDirs.add(directory);
  const resourcePath = Path.join(directory, "moss-production-public-config.json");
  FS.writeFileSync(resourcePath, contents);
  return resourcePath;
}

afterEach(() => {
  for (const directory of tempDirs) {
    FS.rmSync(directory, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe("mossProductionPublicConfig", () => {
  it("loads v2 and makes both validated authority projections authoritative", () => {
    const resourcePath = writeResource(JSON.stringify(publicConfig));
    const loaded = loadMossProductionPublicConfig({ isPackaged: true, resourcePath });
    const env = mergeMossProductionPublicConfigIntoEnv(
      {
        MOSS_CLOUD_REGION: "global",
        MOSS_SUPABASE_URL: "https://wrong.example",
        MOSS_MEMFIRE_PHONE_URL: "https://also-wrong.example",
      },
      loaded,
      { isPackaged: true },
    );

    expect(loaded).toEqual(publicConfig);
    expect(env.MOSS_PRODUCTION_CONFIG_VERSION).toBe("2");
    expect(env.MOSS_MEMFIRE_PHONE_URL).toBe(publicConfig.authRealms["memfire-phone"].authUrl);
    expect(env.MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL).toBe(
      publicConfig.authRealms["memfire-phone"].modelGatewayUrl,
    );
    expect(env.MOSS_SUPABASE_GOOGLE_URL).toBe(publicConfig.authRealms["supabase-google"].authUrl);
    expect(env.MOSS_SUPABASE_GOOGLE_AUTH_REDIRECT_URL).toBe("moss://auth/callback");
    expect(env.MOSS_CLOUD_REGION).toBeUndefined();
    expect(env.MOSS_SUPABASE_URL).toBeUndefined();
  });

  it("does not load a release resource in development", () => {
    const resourcePath = writeResource(JSON.stringify(publicConfig));
    expect(loadMossProductionPublicConfig({ isPackaged: false, resourcePath })).toBeNull();
  });

  it("uses only the packaged phone payment endpoint and keeps older releases disabled", () => {
    const paymentUrl = "https://payments.moss.example/functions/v1/moss-pay";
    for (const configured of [true, false]) {
      const document = structuredClone(publicConfig);
      if (configured)
        Object.assign(document.authRealms["memfire-phone"], { payBaseUrl: paymentUrl });
      const resourcePath = writeResource(JSON.stringify(document));
      const loaded = loadMossProductionPublicConfig({ isPackaged: true, resourcePath });
      const env = mergeMossProductionPublicConfigIntoEnv(
        { MOSS_MEMFIRE_PHONE_PAY_BASE_URL: "https://untrusted.example/functions/v1/moss-pay" },
        loaded,
        { isPackaged: true },
      );
      expect(env.MOSS_MEMFIRE_PHONE_PAY_BASE_URL).toBe(configured ? paymentUrl : "");
    }
  });

  it("keeps packaged QA builds compatible when production mode is off", () => {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "moss-production-config-test-"));
    tempDirs.add(directory);
    const missingPath = Path.join(directory, "moss-production-public-config.json");

    expect(
      loadMossProductionPublicConfig({ isPackaged: true, resourcePath: missingPath }),
    ).toBeNull();
    expect(loadMossProductionPublicConfig({ isPackaged: true, resourcePath: null })).toBeNull();

    const packagedEnv = mergeMossProductionPublicConfigIntoEnv(
      {
        MOSS_CLOUD_REGION: "global",
        MOSS_SUPABASE_URL: "https://legacy.supabase.co",
        MOSS_MODEL_GATEWAY_URL: "https://legacy.supabase.co/functions/v1/moss-model-gateway/v1",
        MOSS_MEMFIRE_PHONE_URL: "https://inherited.baseapi.memfiredb.com",
        MOSS_MEMFIRE_PHONE_PAY_BASE_URL: "https://inherited.example/functions/v1/moss-pay",
        MOSS_SUPABASE_GOOGLE_URL: "https://inherited.supabase.co",
        UNRELATED_SETTING: "preserved",
      },
      null,
      { isPackaged: true },
    );
    expect(packagedEnv.MOSS_CLOUD_REGION).toBeUndefined();
    expect(packagedEnv.MOSS_SUPABASE_URL).toBeUndefined();
    expect(packagedEnv.MOSS_MODEL_GATEWAY_URL).toBeUndefined();
    expect(packagedEnv.MOSS_MEMFIRE_PHONE_URL).toBeUndefined();
    expect(packagedEnv.MOSS_MEMFIRE_PHONE_PAY_BASE_URL).toBeUndefined();
    expect(packagedEnv.MOSS_SUPABASE_GOOGLE_URL).toBeUndefined();
    expect(packagedEnv.UNRELATED_SETTING).toBe("preserved");

    const developmentEnv = mergeMossProductionPublicConfigIntoEnv(
      { MOSS_CLOUD_REGION: "cn" },
      null,
      { isPackaged: false },
    );
    expect(developmentEnv.MOSS_CLOUD_REGION).toBe("cn");
  });

  it("rejects v1 and incomplete dual-authority resources in a packaged app", () => {
    const legacyResourcePath = writeResource(
      JSON.stringify({
        MOSS_CLOUD_REGION: "global",
        MOSS_SUPABASE_URL: "https://moss-global.supabase.co",
        MOSS_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
        MOSS_AUTH_REDIRECT_URL: "moss://auth/callback",
        MOSS_MODEL_GATEWAY_URL:
          "https://moss-global.supabase.co/functions/v1/moss-model-gateway/v1",
        MOSS_REALTIME_RELAY_URL: "https://realtime.moss.example",
      }),
    );
    expect(() =>
      loadMossProductionPublicConfig({ isPackaged: true, resourcePath: legacyResourcePath }),
    ).toThrow(/is invalid/);

    const incompleteResourcePath = writeResource(
      JSON.stringify({
        ...publicConfig,
        authRealms: { "memfire-phone": publicConfig.authRealms["memfire-phone"] },
      }),
    );
    expect(() =>
      loadMossProductionPublicConfig({ isPackaged: true, resourcePath: incompleteResourcePath }),
    ).toThrow(/is invalid/);
  });
});
