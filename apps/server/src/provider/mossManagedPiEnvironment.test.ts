import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { ProviderInstanceConfig } from "@synara/contracts";
import {
  buildMossManagedPiProviderInstance,
  isVerifiedMossManagedPiProviderInstance,
  matchesMossManagedPiProviderInstance,
  readMossManagedPiConfig,
} from "./mossManagedPiEnvironment";
import { createPiModelRuntime, clearPiManagedRuntimeCredentials } from "./Layers/PiAdapter";

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

  it("keeps simultaneous SDK credentials isolated and never persists a token", async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), "moss-pi-runtime-"));
    vi.stubEnv("MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL", gatewayBaseUrl);
    const previous = process.env.MOSS_ACCESS_TOKEN;
    try {
      const first = await createPiModelRuntime(
        agentDir,
        { ModelRuntime },
        undefined,
        environment(fixture("token-one")),
      );
      const second = await createPiModelRuntime(
        agentDir,
        { ModelRuntime },
        undefined,
        environment(fixture("token-two")),
      );
      expect(await first.getAuth("moss")).toMatchObject({ auth: { apiKey: "token-one" } });
      expect(await second.getAuth("moss")).toMatchObject({ auth: { apiKey: "token-two" } });
      expect(
        first.getAvailableSnapshot().filter((model) => model.provider === "moss"),
      ).toHaveLength(7);
      await clearPiManagedRuntimeCredentials(first);
      expect(first.hasConfiguredAuth("moss")).toBe(false);
      expect(await second.getAuth("moss")).toMatchObject({ auth: { apiKey: "token-two" } });
      await clearPiManagedRuntimeCredentials(second);
      expect(process.env.MOSS_ACCESS_TOKEN).toBe(previous);
      expect(existsSync(path.join(agentDir, "models.json"))).toBe(false);
      if (existsSync(path.join(agentDir, "auth.json"))) {
        expect(readFileSync(path.join(agentDir, "auth.json"), "utf8")).not.toContain("token-");
      }
    } finally {
      vi.unstubAllEnvs();
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
