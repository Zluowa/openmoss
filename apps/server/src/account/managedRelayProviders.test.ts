import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildMossManagedRelayInstances,
  inspectMossManagedRelayInstances,
  mapMossManagedRelayInstances,
  matchesMossManagedRelayInstances,
} from "./managedRelayProviders";

const gatewayBaseUrl = "https://moss-cn-models.inkcomicai.com/functions/v1/moss-model-gateway/v1";
const env = { MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL: gatewayBaseUrl };
const stateDir = resolve("/moss-test/state");
const build = (accessToken = "initial-token") =>
  buildMossManagedRelayInstances({
    stateDir,
    accessToken,
    gatewayBaseUrl,
    runtimeGeneration: "generation-1",
    realm: "cn",
    env,
  });

describe("managed CLI relay ownership", () => {
  it("provisions distinct CLI homes and never serializes the bearer into configuration", () => {
    const instances = build();
    expect(Object.keys(instances).sort()).toEqual([
      "grok_moss",
      "hermes_moss",
      "kimi_moss",
      "minimax_moss",
      "zcode_moss",
    ]);
    for (const driver of ["grok", "hermes", "kimi", "minimax", "zcode"] as const) {
      expect(instances[`${driver}_moss`]?.config).toMatchObject({
        homePath: join(stateDir, "provider-homes", driver, "cn"),
      });
    }
    expect(instances.kimi_moss?.config).toMatchObject({ modelAllowlist: ["kimi-k3"] });
    expect(instances.minimax_moss?.config).toMatchObject({ modelAllowlist: ["minimax-m3"] });
    expect(instances.zcode_moss?.config).toMatchObject({
      modelAllowlist: ["glm-5.3", "glm-5.3-flash"],
    });
    for (const instance of Object.values(instances)) {
      expect(JSON.stringify(instance.config)).not.toContain("initial-token");
      expect(instance.environment?.filter((entry) => entry.sensitive)).toEqual([
        expect.objectContaining({ name: "MOSS_ACCESS_TOKEN", value: "initial-token" }),
      ]);
    }
    expect(inspectMossManagedRelayInstances(instances, stateDir, env)).toEqual({
      owned: instances,
      hasCollision: false,
    });
  });

  it.each(["grok_moss", "hermes_moss", "kimi_moss", "minimax_moss", "zcode_moss"])(
    "does not adopt a foreign or moved reserved home: %s",
    (id) => {
      const instances = build();
      const instance = instances[id]!;
      const changed = {
        ...instances,
        [id]: {
          ...instance,
          config: { ...(instance.config as object), homePath: "/personal/cli" },
        },
      };
      const result = inspectMossManagedRelayInstances(changed, stateDir, env);
      expect(result.hasCollision).toBe(true);
      expect(result.owned[id]).toBeUndefined();
      expect(Object.keys(result.owned)).toHaveLength(4);
    },
  );

  it("treats rotated credentials and missing relay records as stale", () => {
    expect(matchesMossManagedRelayInstances(build(), build())).toBe(true);
    expect(matchesMossManagedRelayInstances(build(), build("rotated-token"))).toBe(false);
    expect(matchesMossManagedRelayInstances({}, build())).toBe(false);
    expect(matchesMossManagedRelayInstances(build(), {})).toBe(false);
  });

  it("fences only exact managed records and recognizes credential-free cleanup tombstones", () => {
    const instances = build();
    const personal = { ...instances.grok_moss!, displayName: "Personal" };
    const fenced = mapMossManagedRelayInstances(
      { ...instances, grok_personal: personal },
      (instance) => ({
        ...instance,
        enabled: false,
        environment: [],
        config: { ...(instance.config as object), managedCleanupState: "pending-v1" },
      }),
    );
    expect(fenced.grok_personal).toBeUndefined();
    expect(JSON.stringify(fenced)).not.toContain("initial-token");
    expect(inspectMossManagedRelayInstances(fenced, stateDir, env)).toEqual({
      owned: fenced,
      hasCollision: false,
    });
    expect(matchesMossManagedRelayInstances(fenced, build())).toBe(false);
  });
});
