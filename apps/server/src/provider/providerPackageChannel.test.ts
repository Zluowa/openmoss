import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProviderInstanceConfigMap } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  buildMossManagedRelayInstances,
  mapMossManagedRelayInstances,
} from "../account/managedRelayProviders";
import {
  applyProviderPackageChannelEnv,
  CN_NPM_MIRROR_REGISTRY,
  readActiveMossAccessLane,
  resolveProviderPackageChannel,
} from "./providerPackageChannel";

const GATEWAY_URL = "https://gateway.test/functions/v1/moss-model-gateway/v1";
const GATEWAY_ENV = {
  MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL: GATEWAY_URL,
  MOSS_SUPABASE_GOOGLE_MODEL_GATEWAY_URL: GATEWAY_URL,
};

const managedInstance = (realm: string, enabled = true) =>
  ({
    pi_moss: { driver: "pi", enabled, config: { realm } },
  }) as unknown as ProviderInstanceConfigMap;

describe("resolveProviderPackageChannel", () => {
  it("sends the phone and enterprise lanes through the mirror wherever the machine is", () => {
    for (const lane of ["cn", "enterprise"]) {
      expect(
        resolveProviderPackageChannel({
          providerInstances: managedInstance(lane),
          timeZone: "America/Los_Angeles",
        }),
      ).toBe("cn-mirror");
    }
  });

  it("keeps the Google lane on the official sources even from a mainland time zone", () => {
    expect(
      resolveProviderPackageChannel({
        providerInstances: managedInstance("global"),
        timeZone: "Asia/Shanghai",
      }),
    ).toBe("official");
  });

  it("falls back to the time zone once sign-out disables the managed instances", () => {
    const signedOut = managedInstance("cn", false);
    expect(readActiveMossAccessLane(signedOut)).toBeNull();
    expect(
      resolveProviderPackageChannel({ providerInstances: signedOut, timeZone: "Asia/Shanghai" }),
    ).toBe("cn-mirror");
    expect(
      resolveProviderPackageChannel({ providerInstances: signedOut, timeZone: "Europe/Berlin" }),
    ).toBe("official");
  });

  it.each([
    ["cn", "cn-mirror"],
    ["enterprise", "cn-mirror"],
    ["global", "official"],
  ] as const)("reads the %s lane from the instances Moss really persists", (realm, channel) => {
    const providerInstances = buildMossManagedRelayInstances({
      stateDir: join(tmpdir(), "moss-package-channel-test"),
      accessToken: "test-token",
      gatewayBaseUrl: GATEWAY_URL,
      runtimeGeneration: "test",
      realm,
      env: GATEWAY_ENV,
    });
    expect(readActiveMossAccessLane(providerInstances)).toBe(realm);
    expect(resolveProviderPackageChannel({ providerInstances, timeZone: "UTC" })).toBe(channel);

    const signedOut = mapMossManagedRelayInstances(providerInstances, (instance) => ({
      ...instance,
      enabled: false,
    }));
    expect(readActiveMossAccessLane(signedOut)).toBeNull();
  });

  it("ignores a user-made instance that happens to carry a realm", () => {
    const providerInstances = {
      my_pi: { driver: "pi", enabled: true, config: { realm: "cn" } },
    } as unknown as ProviderInstanceConfigMap;
    expect(readActiveMossAccessLane(providerInstances)).toBeNull();
  });
});

describe("applyProviderPackageChannelEnv", () => {
  it("leaves the official channel's environment untouched", () => {
    const env = { PATH: "/bin" };
    expect(applyProviderPackageChannelEnv(env, "official")).toBe(env);
    expect(applyProviderPackageChannelEnv(env, undefined)).toBe(env);
  });

  it("points every package manager at the mirror", () => {
    const env = applyProviderPackageChannelEnv({ PATH: "/bin" }, "cn-mirror");
    expect(env.PATH).toBe("/bin");
    expect(env.npm_config_registry).toBe(CN_NPM_MIRROR_REGISTRY);
    expect(env.BUN_CONFIG_REGISTRY).toBe(CN_NPM_MIRROR_REGISTRY);
    expect(env.npm_config_better_sqlite3_binary_host).toContain("registry.npmmirror.com");
    expect(env.HOMEBREW_BOTTLE_DOMAIN).toContain("mirrors.ustc.edu.cn");
  });
});
