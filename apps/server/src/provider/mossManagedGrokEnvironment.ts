import path from "node:path";
import type { ProviderInstanceConfig } from "@synara/contracts";
import {
  getMossManagedModelDefinition,
  mossLaneEngineLineup,
  type MossAccessLane,
} from "@synara/shared/mossRealmCatalog";
import {
  buildMossManagedRelayProviderInstance,
  ensureMossManagedHome,
  isCanonicalIsolatedHome,
  isVerifiedMossManagedRelayProviderInstance,
  managedHomeAncestors,
  matchesMossManagedRelayProviderInstance,
  MOSS_MANAGED_RELAY_CREDENTIAL_ENV_KEY,
  type MossManagedRelayBuildInput,
  type MossManagedRelayDefinition,
  type MossManagedRelayVerifyInput,
  readMossManagedRelayCatalog,
  writeMossManagedFile,
} from "./mossManagedRelayInstance";
import { normalizeMossManagedOpenCodeGatewayBaseUrl } from "./mossManagedOpenCodeEnvironment";

export const MOSS_MANAGED_GROK_PROVIDER_INSTANCE_ID = "grok_moss";
export const MOSS_MANAGED_GROK_CREDENTIAL_ENV_KEY = MOSS_MANAGED_RELAY_CREDENTIAL_ENV_KEY;
export const MOSS_MANAGED_GROK_CONFIG_ENV_KEY = "MOSS_GROK_CONFIG_CONTENT";

const MANAGED_GROK_HOME_LABEL = "Managed Grok home";

export function mossManagedGrokModels(realm: MossAccessLane): string[] {
  return mossLaneEngineLineup(realm, "opencode").map((id) => `moss/${id}`);
}

export function buildMossManagedGrokConfigToml(
  gatewayBaseUrl: string,
  realm: MossAccessLane,
): string {
  const models = mossManagedGrokModels(realm);
  const quote = JSON.stringify;
  return [
    "[cli]",
    "auto_update = false",
    "[features]",
    "telemetry = false",
    "campaigns = false",
    "[models]",
    `default = ${quote(models[0])}`,
    // Grok's title call otherwise uses its compiled native model even for BYOK sessions.
    `session_summary = ${quote(models[0])}`,
    `allowed_models = ${quote(models)}`,
    ...models.flatMap((slug) => {
      const id = slug.slice("moss/".length);
      const definition = getMossManagedModelDefinition(id)!;
      return [
        "",
        `[model.${quote(slug)}]`,
        `model = ${quote(id)}`,
        `name = ${quote(definition.displayName)}`,
        `base_url = ${quote(normalizeMossManagedOpenCodeGatewayBaseUrl(gatewayBaseUrl))}`,
        `env_key = ${quote(MOSS_MANAGED_GROK_CREDENTIAL_ENV_KEY)}`,
        'api_backend = "chat_completions"',
        `context_window = ${definition.contextWindow}`,
        `max_completion_tokens = ${Math.min(definition.maxOutputTokens, 32768)}`,
      ];
    }),
    "",
  ].join("\n");
}

function buildConfig(gatewayBaseUrl: string, realm: MossAccessLane, homePath: string) {
  if (!isCanonicalIsolatedHome(homePath))
    throw new Error("Managed Grok requires a canonical absolute isolated home.");
  return {
    realm,
    gatewayBaseUrl: normalizeMossManagedOpenCodeGatewayBaseUrl(gatewayBaseUrl),
    homePath,
    models: mossManagedGrokModels(realm),
  };
}

const MOSS_MANAGED_GROK_RELAY: MossManagedRelayDefinition<
  "grok",
  ReturnType<typeof buildConfig>
> = {
  driver: "grok",
  instanceId: MOSS_MANAGED_GROK_PROVIDER_INSTANCE_ID,
  label: "Managed Grok",
  configEnvKey: MOSS_MANAGED_GROK_CONFIG_ENV_KEY,
  credentialEnvKey: MOSS_MANAGED_GROK_CREDENTIAL_ENV_KEY,
  buildCatalog: ({ gatewayBaseUrl, realm, parsed }) => {
    if (typeof parsed.homePath !== "string")
      throw new Error("Managed Grok requires a trusted Moss gateway and realm.");
    return buildConfig(gatewayBaseUrl, realm, parsed.homePath);
  },
  models: (catalog) => catalog.models,
  leadingEnvironment: (catalog) => [{ name: "GROK_HOME", value: catalog.homePath }],
  validateEnvironment: (catalog, environment) =>
    environment.GROK_HOME === catalog.homePath
      ? undefined
      : "Managed Grok configuration or credential does not match its realm catalog.",
};

export function readMossManagedGrokConfig(
  environment: Readonly<Record<string, string>> | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ReturnType<typeof buildConfig> | undefined {
  return readMossManagedRelayCatalog(MOSS_MANAGED_GROK_RELAY, environment, env);
}

export function buildMossManagedGrokProviderInstance(input: MossManagedRelayBuildInput) {
  const instance = buildMossManagedRelayProviderInstance(
    MOSS_MANAGED_GROK_RELAY,
    buildConfig(input.gatewayBaseUrl, input.realm, input.homePath),
    input,
  );
  if (!input.runtimeGeneration.trim())
    throw new Error("Managed Grok requires a runtime generation.");
  return instance;
}

export function isVerifiedMossManagedGrokProviderInstance(
  input: MossManagedRelayVerifyInput,
): boolean {
  return isVerifiedMossManagedRelayProviderInstance(
    MOSS_MANAGED_GROK_RELAY,
    buildMossManagedGrokProviderInstance,
    input,
  );
}

export function matchesMossManagedGrokProviderInstance(
  actual: ProviderInstanceConfig | undefined,
  expected: ProviderInstanceConfig | undefined,
): boolean {
  return matchesMossManagedRelayProviderInstance(actual, expected);
}

export function managedGrokHomeAncestors(
  homePath: string,
  pathApi: Pick<typeof path, "parse" | "sep" | "join" | "isAbsolute" | "resolve"> = path,
): string[] {
  return managedHomeAncestors(homePath, MANAGED_GROK_HOME_LABEL, pathApi);
}

/** Create only a secret-free config in the account-owned isolated home. */
export async function prepareMossManagedGrokHome(
  config: ReturnType<typeof buildConfig>,
): Promise<void> {
  buildConfig(config.gatewayBaseUrl, config.realm, config.homePath);
  await ensureMossManagedHome(config.homePath, MANAGED_GROK_HOME_LABEL);
  await writeMossManagedFile({
    directory: config.homePath,
    fileName: "config.toml",
    content: buildMossManagedGrokConfigToml(config.gatewayBaseUrl, config.realm),
    label: "Managed Grok config",
  });
}
