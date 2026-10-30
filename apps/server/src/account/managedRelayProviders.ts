import path from "node:path";
import type { ProviderInstanceConfig, ProviderInstanceConfigMap } from "@synara/contracts";
import { isMossAccessLane, type MossAccessLane } from "@synara/shared/mossRealmCatalog";
import {
  buildMossManagedGrokProviderInstance,
  isVerifiedMossManagedGrokProviderInstance,
  matchesMossManagedGrokProviderInstance,
} from "../provider/mossManagedGrokEnvironment";
import {
  buildMossManagedHermesProviderInstance,
  isVerifiedMossManagedHermesProviderInstance,
  matchesMossManagedHermesProviderInstance,
} from "../provider/mossManagedHermesEnvironment";
import {
  KIMI_ACP_AGENT_SPEC,
  MINIMAX_ACP_AGENT_SPEC,
  ZCODE_ACP_AGENT_SPEC,
} from "../provider/acp/AcpAgentSpec";
import { mossManagedAcpAgentRelay } from "../provider/mossManagedAcpAgentEnvironment";

/**
 * Shared lifecycle registry for the CLI relays with isolated homes. Hermes,
 * Grok, Kimi Code and MiniMax Code keep their homes secret-free (the bearer
 * only reaches them through MOSS_ACCESS_TOKEN); ZCode's backend cannot read
 * environment references, so its private home holds the key in 0600 files.
 */
export const MOSS_MANAGED_RELAY_PROVIDERS = [
  {
    driver: "grok",
    instanceId: "grok_moss",
    build: buildMossManagedGrokProviderInstance,
    verify: isVerifiedMossManagedGrokProviderInstance,
    matches: matchesMossManagedGrokProviderInstance,
  },
  {
    driver: "hermes",
    instanceId: "hermes_moss",
    build: buildMossManagedHermesProviderInstance,
    verify: isVerifiedMossManagedHermesProviderInstance,
    matches: matchesMossManagedHermesProviderInstance,
  },
  mossManagedAcpAgentRelay(KIMI_ACP_AGENT_SPEC),
  mossManagedAcpAgentRelay(MINIMAX_ACP_AGENT_SPEC),
  mossManagedAcpAgentRelay(ZCODE_ACP_AGENT_SPEC),
] as const;

export type MossManagedRelayDriver = (typeof MOSS_MANAGED_RELAY_PROVIDERS)[number]["driver"];

export const isMossManagedRelayInstanceId = (instanceId: string | undefined): boolean =>
  MOSS_MANAGED_RELAY_PROVIDERS.some((entry) => entry.instanceId === instanceId);

function isConfigRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function buildMossManagedRelayInstances(input: {
  readonly stateDir: string;
  readonly accessToken: string;
  readonly gatewayBaseUrl: string;
  readonly runtimeGeneration: string;
  /** Access lane; persisted under the historical `realm` key. */
  readonly realm: MossAccessLane;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): ProviderInstanceConfigMap {
  return Object.fromEntries(
    MOSS_MANAGED_RELAY_PROVIDERS.map((entry) => [
      entry.instanceId,
      entry.build({
        ...input,
        homePath: path.join(input.stateDir, "provider-homes", entry.driver, input.realm),
      }),
    ]),
  );
}

export function inspectMossManagedRelayInstances(
  instances: ProviderInstanceConfigMap,
  stateDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): { readonly owned: ProviderInstanceConfigMap; readonly hasCollision: boolean } {
  const owned: Record<string, ProviderInstanceConfig> = {};
  let hasCollision = false;
  for (const entry of MOSS_MANAGED_RELAY_PROVIDERS) {
    const instance = instances[entry.instanceId];
    if (!instance) continue;
    const config = instance.config;
    const homeMatches =
      isConfigRecord(config) &&
      isMossAccessLane(config.realm) &&
      config.homePath === path.join(stateDir, "provider-homes", entry.driver, config.realm);
    if (
      homeMatches &&
      entry.verify({ instanceId: entry.instanceId, instance, allowDisabled: true, env })
    ) {
      owned[entry.instanceId] = instance;
    } else hasCollision = true;
  }
  return { owned, hasCollision };
}

export function matchesMossManagedRelayInstances(
  actual: ProviderInstanceConfigMap,
  expected: ProviderInstanceConfigMap,
): boolean {
  return MOSS_MANAGED_RELAY_PROVIDERS.every((entry) =>
    entry.matches(actual[entry.instanceId], expected[entry.instanceId]),
  );
}

export function mapMossManagedRelayInstances(
  instances: ProviderInstanceConfigMap,
  transform: (instance: ProviderInstanceConfig) => ProviderInstanceConfig,
): ProviderInstanceConfigMap {
  return Object.fromEntries(
    Object.entries(instances)
      .filter(([instanceId]) => isMossManagedRelayInstanceId(instanceId))
      .map(([instanceId, instance]) => [instanceId, transform(instance)]),
  );
}
