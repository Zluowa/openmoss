import { describe, expect, it } from "vitest";
import { getMossManagedModelDefinition } from "@moss/shared/mossRealmCatalog";

import {
  buildMossManagedOpenCodeProviderInstance,
  isVerifiedMossManagedOpenCodeProviderInstance,
} from "./mossManagedOpenCodeEnvironment";

const gatewayBaseUrl = "https://moss-cn-models.inkcomicai.com/functions/v1/moss-model-gateway/v1";
const env = { MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL: gatewayBaseUrl };

function fixture() {
  return buildMossManagedOpenCodeProviderInstance({
    accessToken: "test-managed-token",
    gatewayBaseUrl,
    runtimeGeneration: "test-generation",
    env,
  });
}

describe("managed OpenCode model limits", () => {
  it("uses each model's context window and reserves a bounded completion", () => {
    const instance = fixture();
    const config = JSON.parse(instance.environment![0]!.value!);
    for (const [id, model] of Object.entries(config.provider.moss.models) as Array<
      [string, { limit: { context: number; output: number } }]
    >) {
      const definition = getMossManagedModelDefinition(id)!;
      expect(model.limit.context, id).toBe(definition.contextWindow);
      expect(model.limit.output, id).toBe(Math.min(definition.maxOutputTokens, 32_768));
      expect(model.limit.output, id).toBeLessThan(model.limit.context);
    }
  });

  it("offers only the Moss provider, and still recognizes a config from before that lock", () => {
    const instance = fixture();
    const config = JSON.parse(instance.environment![0]!.value!);
    expect(config.enabled_providers).toEqual(["moss"]);

    delete config.enabled_providers;
    const verify = (value: string) =>
      isVerifiedMossManagedOpenCodeProviderInstance({
        instanceId: "opencode_moss",
        instance: {
          ...instance,
          environment: instance.environment!.map((entry, index) =>
            index === 0 ? { ...entry, value } : entry,
          ),
        },
        env,
      });
    expect(verify(JSON.stringify(config))).toBe(true);
    expect(verify(JSON.stringify({ ...config, enabled_providers: ["moss", "opencode"] }))).toBe(
      false,
    );
  });

  it("names the lane Moss like the other agents and still proves an instance saved as before", () => {
    const instance = fixture();
    expect(instance.displayName).toBe("Moss");
    const verify = (displayName: string) =>
      isVerifiedMossManagedOpenCodeProviderInstance({
        instanceId: "opencode_moss",
        instance: { ...instance, displayName },
        env,
      });
    expect(verify("Moss")).toBe(true);
    expect(verify("Moss DeepSeek & Kimi")).toBe(true);
    expect(verify("My OpenCode")).toBe(false);
  });

  it("recognizes the prior context catalog so reconciliation can replace it", () => {
    const instance = fixture();
    const config = JSON.parse(instance.environment![0]!.value!);
    for (const id of ["deepseek-v4-flash", "glm-5.3", "glm-5.3-flash"]) {
      config.provider.moss.models[id].limit.context = 1_048_576;
    }
    config.provider.moss.models["minimax-m3"].limit.context = 1_000_000;
    const legacy = {
      ...instance,
      environment: instance.environment!.map((entry, index) =>
        index === 0 ? { ...entry, value: JSON.stringify(config) } : entry,
      ),
    };
    expect(
      isVerifiedMossManagedOpenCodeProviderInstance({
        instanceId: "opencode_moss",
        instance: legacy,
        env,
      }),
    ).toBe(true);
    config.provider.moss.models["glm-5.3"].limit.context = 99_999_999;
    legacy.environment[0] = { ...legacy.environment[0]!, value: JSON.stringify(config) };
    expect(
      isVerifiedMossManagedOpenCodeProviderInstance({
        instanceId: "opencode_moss",
        instance: legacy,
        env,
      }),
    ).toBe(false);
  });
});
