import { describe, expect, it } from "vitest";
import type { ProviderInstanceConfig } from "@moss/contracts";
import {
  buildMossManagedPiConfig,
  buildMossManagedPiProviderInstance,
  isVerifiedMossManagedPiProviderInstance,
  matchesMossManagedPiProviderInstance,
  readMossManagedPiConfig,
} from "./mossManagedPiEnvironment";

const gatewayBaseUrl = "https://moss-cn-models.inkcomicai.com/functions/v1/moss-model-gateway/v1";
const globalGateway = "https://global.example.test/functions/v1/moss-model-gateway/v1";
const env = {
  MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL: gatewayBaseUrl,
  MOSS_SUPABASE_GOOGLE_MODEL_GATEWAY_URL: globalGateway,
};
const fixture = (accessToken = "test-token") =>
  buildMossManagedPiProviderInstance({
    accessToken,
    gatewayBaseUrl,
    runtimeGeneration: "test-generation",
    realm: "cn",
    agentDir: "/state/provider-homes/pi/cn",
    env,
  });
const verify = (instance: ProviderInstanceConfig, allowDisabled = false) =>
  isVerifiedMossManagedPiProviderInstance({ instanceId: "pi_moss", instance, env, allowDisabled });
const environment = (instance: ReturnType<typeof fixture>) =>
  Object.fromEntries(instance.environment!.map((entry) => [entry.name, entry.value!]));

describe("managed Pi instance", () => {
  it("uses only the realm's chat models and separates the secret from its catalog", () => {
    const instance = fixture();
    expect(verify(instance)).toBe(true);
    const config = readMossManagedPiConfig(environment(instance), env)!;
    expect(config.provider.models).toHaveLength(7);
    expect(JSON.stringify(config)).not.toContain("test-token");
    expect(config.provider.models.some((model) => model.id.startsWith("gpt-"))).toBe(false);
    expect(instance.environment?.[1]?.sensitive).toBe(true);
  });

  it("rejects cross-realm gateways and arbitrary provider config", () => {
    expect(() =>
      buildMossManagedPiProviderInstance({
        accessToken: "test",
        gatewayBaseUrl: globalGateway,
        runtimeGeneration: "generation",
        realm: "cn",
        agentDir: "/pi/cn",
        env,
      }),
    ).toThrow();
    const instance = fixture();
    const values = environment(instance);
    const config = JSON.parse(values.MOSS_PI_CONFIG_CONTENT!);
    config.provider.apiKey = "!untrusted-command";
    expect(() =>
      readMossManagedPiConfig({ ...values, MOSS_PI_CONFIG_CONTENT: JSON.stringify(config) }, env),
    ).toThrow();
    expect(verify({ ...instance, config: { ...instance.config, binaryPath: "/untrusted" } })).toBe(
      false,
    );
  });

  it("recognizes encrypted secret references but refuses unfenced disabled instances", () => {
    const instance = fixture();
    expect(
      verify({
        ...instance,
        environment: instance.environment!.map((entry) =>
          entry.sensitive
            ? {
                ...entry,
                value: "",
                valueRedacted: true,
                valueSecretRef: "provider-secret-v2-test",
              }
            : entry,
        ),
      }),
    ).toBe(true);
    expect(verify({ ...instance, enabled: false }, true)).toBe(false);
    expect(
      verify(
        {
          ...instance,
          enabled: false,
          environment: [],
          config: { ...instance.config, managedCleanupState: "pending-v1" },
        },
        true,
      ),
    ).toBe(true);
  });

  it("compares credential values without treating storage metadata as a generation change", () => {
    const instance = fixture();
    const stored = {
      ...instance,
      environment: instance.environment!.map((entry) => ({ ...entry, valueRedacted: false })),
    };
    expect(matchesMossManagedPiProviderInstance(stored, instance)).toBe(true);
    expect(matchesMossManagedPiProviderInstance(fixture("rotated-token"), instance)).toBe(false);
  });
});

describe("Moss models in Pi see images when the Moss catalog says they can", () => {
  it("takes image input from the catalog", () => {
    const catalog = buildMossManagedPiConfig(gatewayBaseUrl, "cn");
    const inputOf = (id: string) => catalog.provider.models.find((model) => model.id === id)?.input;
    expect(inputOf("glm-5.3-flash")).toEqual(["text", "image"]);
    expect(inputOf("deepseek-v4-flash")).toEqual(["text"]);
  });

  it("still reads a catalog stored before image input came from the catalog", () => {
    const current = buildMossManagedPiConfig(gatewayBaseUrl, "cn");
    const stored = {
      ...current,
      provider: {
        ...current.provider,
        models: current.provider.models.map((model) => ({ ...model, input: ["text"] })),
      },
    };
    const read = readMossManagedPiConfig(
      { MOSS_PI_CONFIG_CONTENT: JSON.stringify(stored), MOSS_ACCESS_TOKEN: "fake-token" },
      env,
    );
    expect(read?.provider.models.find((model) => model.id === "glm-5.3-flash")?.input).toEqual([
      "text",
      "image",
    ]);
    expect(() =>
      readMossManagedPiConfig(
        {
          MOSS_PI_CONFIG_CONTENT: JSON.stringify({
            ...stored,
            provider: { ...stored.provider, models: stored.provider.models.slice(1) },
          }),
          MOSS_ACCESS_TOKEN: "fake-token",
        },
        env,
      ),
    ).toThrow(/does not match/);
  });
});
