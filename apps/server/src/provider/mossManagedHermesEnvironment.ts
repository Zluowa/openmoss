import path from "node:path";
import { chmod, readdir, realpath } from "node:fs/promises";
import type { ProviderInstanceConfig } from "@synara/contracts";
import {
  getMossManagedModelDefinition,
  mossLaneEngineLineup,
  type MossAccessLane,
} from "@synara/shared/mossRealmCatalog";
import {
  buildMossManagedRelayProviderInstance,
  ensureMossManagedHome,
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

export const MOSS_MANAGED_HERMES_PROVIDER_INSTANCE_ID = "hermes_moss";
export const MOSS_MANAGED_HERMES_CONFIG_ENV_KEY = "MOSS_HERMES_CONFIG_CONTENT";
export const MOSS_MANAGED_HERMES_CREDENTIAL_ENV_KEY = MOSS_MANAGED_RELAY_CREDENTIAL_ENV_KEY;

const MANAGED_HERMES_HOME_LABEL = "Managed Hermes home";

export const managedHermesConfigDirectory = (homePath: string): string =>
  path.join(homePath, "managed-config");

export function managedHermesHomeAncestors(
  homePath: string,
  pathApi: Pick<typeof path, "parse" | "sep" | "join" | "isAbsolute" | "resolve"> = path,
): string[] {
  return managedHomeAncestors(homePath, MANAGED_HERMES_HOME_LABEL, pathApi);
}

/** Prepare private configuration without following existing filesystem links. */
export async function prepareMossManagedHermesHome(
  homePath: string,
  config: ReturnType<typeof buildMossManagedHermesConfig>,
): Promise<void> {
  const managedDirectory = managedHermesConfigDirectory(homePath);
  await ensureMossManagedHome(managedDirectory, MANAGED_HERMES_HOME_LABEL);
  if ((await realpath(homePath)) !== homePath)
    throw new Error("Managed Hermes home is not canonical.");
  await chmod(homePath, 0o700);
  if ((await readdir(managedDirectory)).length)
    throw new Error("Managed Hermes machine configuration directory must be empty.");
  await writeMossManagedFile({
    directory: homePath,
    fileName: "config.yaml",
    content: JSON.stringify(config.configuration),
    label: "Managed Hermes configuration",
  });
}

export function mossManagedHermesModels(realm: MossAccessLane): string[] {
  return [...mossLaneEngineLineup(realm, "opencode")];
}

/** No credentials or executable config values are included in this catalog. */
export function buildMossManagedHermesConfig(gatewayBaseUrl: string, realm: MossAccessLane) {
  const models = mossManagedHermesModels(realm);
  const modelMetadata = Object.fromEntries(
    models.map((model) => {
      const definition = getMossManagedModelDefinition(model);
      if (!definition)
        throw new Error("Managed Hermes model metadata is missing from its realm catalog.");
      return [model, { context_length: definition.contextWindow }];
    }),
  );
  const provider = {
    base_url: normalizeMossManagedOpenCodeGatewayBaseUrl(gatewayBaseUrl),
    api_mode: "chat_completions",
    key_env: "MOSS_ACCESS_TOKEN",
    model: models[0]!,
    discover_models: false,
    models: modelMetadata,
  };
  return {
    realm,
    gatewayBaseUrl: normalizeMossManagedOpenCodeGatewayBaseUrl(gatewayBaseUrl),
    configuration: {
      model: { default: models[0]!, provider: "custom:moss" },
      custom_providers: [
        {
          name: "moss",
          ...provider,
        },
        // Hermes ACP saves the billing class "custom" instead of "custom:moss".
        // A named alias survives Hermes' config migration and restores the same
        // endpoint and environment credential after the child process restarts.
        { name: "custom", ...provider },
      ],
      telemetry: { enabled: false },
      auto_update: false,
    },
  };
}

const MOSS_MANAGED_HERMES_RELAY: MossManagedRelayDefinition<
  "hermes",
  ReturnType<typeof buildMossManagedHermesConfig>
> = {
  driver: "hermes",
  instanceId: MOSS_MANAGED_HERMES_PROVIDER_INSTANCE_ID,
  label: "Managed Hermes",
  configEnvKey: MOSS_MANAGED_HERMES_CONFIG_ENV_KEY,
  credentialEnvKey: MOSS_MANAGED_HERMES_CREDENTIAL_ENV_KEY,
  buildCatalog: ({ gatewayBaseUrl, realm }) => buildMossManagedHermesConfig(gatewayBaseUrl, realm),
  models: (catalog) => mossManagedHermesModels(catalog.realm),
};

export function readMossManagedHermesConfig(
  environment: Readonly<Record<string, string>> | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ReturnType<typeof buildMossManagedHermesConfig> | undefined {
  return readMossManagedRelayCatalog(MOSS_MANAGED_HERMES_RELAY, environment, env);
}

export function buildMossManagedHermesProviderInstance(input: MossManagedRelayBuildInput) {
  const instance = buildMossManagedRelayProviderInstance(
    MOSS_MANAGED_HERMES_RELAY,
    buildMossManagedHermesConfig(input.gatewayBaseUrl, input.realm),
    input,
  );
  if (
    !input.runtimeGeneration.trim() ||
    !path.isAbsolute(input.homePath) ||
    path.resolve(input.homePath) === path.parse(input.homePath).root
  ) {
    throw new Error("Managed Hermes requires an isolated agent directory and runtime generation.");
  }
  return instance;
}

export function isVerifiedMossManagedHermesProviderInstance(
  input: MossManagedRelayVerifyInput,
): boolean {
  return isVerifiedMossManagedRelayProviderInstance(
    MOSS_MANAGED_HERMES_RELAY,
    buildMossManagedHermesProviderInstance,
    input,
  );
}

/** Secret references/redaction metadata are storage details, not runtime identity. */
export function matchesMossManagedHermesProviderInstance(
  actual: ProviderInstanceConfig | undefined,
  expected: ProviderInstanceConfig | undefined,
): boolean {
  return matchesMossManagedRelayProviderInstance(actual, expected);
}
