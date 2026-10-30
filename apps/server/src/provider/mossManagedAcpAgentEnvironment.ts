// FILE: mossManagedAcpAgentEnvironment.ts
// Purpose: Moss-managed mode for the generic ACP agent drivers (kimi_moss, minimax_moss,
//          zcode_moss): realm catalogs, persisted relay instances, private homes with each CLI's
//          generated provider config, and the managed child environment.
// Layer: Provider managed environments

import path from "node:path";
import type { ProviderInstanceConfig, ProviderListModelsResult } from "@synara/contracts";
import {
  getMossManagedModelDefinition,
  mossLaneEngineLineup,
  type MossAccessLane,
  type MossManagedModelDefinition,
} from "@synara/shared/mossRealmCatalog";

import {
  mossManagedChildBaseEnvironment,
  mossManagedChildNoProxy,
} from "../providerChildEnvironment.ts";
import type {
  AcpAgentKind,
  AcpAgentManagedConfig,
  AcpAgentManagedHooks,
  AcpAgentRuntimeSettings,
  AcpAgentSpec,
} from "./acp/AcpAgentSpec.ts";
import {
  buildMossManagedRelayProviderInstance,
  ensureMossManagedHome,
  isCanonicalIsolatedHome,
  isVerifiedMossManagedRelayProviderInstance,
  matchesMossManagedRelayProviderInstance,
  MOSS_MANAGED_RELAY_CREDENTIAL_ENV_KEY,
  type MossManagedRelayBuildInput,
  type MossManagedRelayDefinition,
  type MossManagedRelayProviderInstance,
  type MossManagedRelayVerifyInput,
  readMossManagedRelayCatalog,
  writeMossManagedFile,
} from "./mossManagedRelayInstance.ts";
import { normalizeMossManagedOpenCodeGatewayBaseUrl } from "./mossManagedOpenCodeEnvironment.ts";

export const MOSS_MANAGED_ACP_AGENT_CREDENTIAL_ENV_KEY = MOSS_MANAGED_RELAY_CREDENTIAL_ENV_KEY;
/** Provider id each CLI sees; model values are namespaced under it. */
export const MOSS_MANAGED_ACP_AGENT_PROVIDER_ID = "moss";
export const MOSS_MANAGED_ACP_AGENT_CONFIG_ENV_KEYS = {
  kimi: "MOSS_KIMI_CONFIG_CONTENT",
  minimax: "MOSS_MINIMAX_CONFIG_CONTENT",
  zcode: "MOSS_ZCODE_CONFIG_CONTENT",
} as const satisfies Readonly<Record<AcpAgentKind, string>>;
/** Model family each managed driver serves from the lane's chat-completions lineup. */
export const MOSS_MANAGED_ACP_AGENT_MODEL_PREFIXES = {
  kimi: "kimi-",
  minimax: "minimax-",
  zcode: "glm-",
} as const satisfies Readonly<Record<AcpAgentKind, string>>;
// Keep a managed turn within the gateway's bounded streaming budget (see the
// managed OpenCode/Grok output reservation).
const MOSS_MANAGED_ACP_AGENT_OUTPUT_LIMIT = 32_768;
/** Discovery hints the ZCode bridge needs to find the GLM CLI; never secrets. */
const ZCODE_PASSTHROUGH_ENV_KEYS = ["ZCODE_BIN", "ZCODE_NODE", "ZCODE_ACP_RUNTIME"] as const;

export type ManagedAcpAgentSpec = Pick<
  AcpAgentSpec,
  "kind" | "displayName" | "managedInstanceId" | "homeEnvironment" | "environmentDefaults"
>;

interface MossManagedAcpAgentFile {
  /** Relative to the CLI's private data root. */
  readonly relativePath: string;
  readonly content: string;
}

interface MossManagedAcpAgentRecipe {
  /** Maps a Moss model slug to the CLI's ACP `model` config value. */
  readonly modelId: (slug: string) => string;
  /**
   * Generated provider configuration. `accessToken` is only consulted by a
   * CLI that cannot read credentials from the environment (ZCode).
   */
  readonly files: (input: {
    readonly config: AcpAgentManagedConfig;
    readonly models: ReadonlyArray<MossManagedModelDefinition>;
    readonly accessToken: string;
  }) => ReadonlyArray<MossManagedAcpAgentFile>;
  /** Kind-specific child variables beyond the spec defaults and home relocation. */
  readonly environment: (input: {
    readonly config: AcpAgentManagedConfig;
    readonly env: NodeJS.ProcessEnv;
  }) => Readonly<Record<string, string>>;
  /** Whether the child receives the bearer as MOSS_ACCESS_TOKEN (env-ref CLIs only). */
  readonly tokenInEnvironment: boolean;
}

const quote = JSON.stringify;

function managedModelDefinitions(
  config: AcpAgentManagedConfig,
): ReadonlyArray<MossManagedModelDefinition> {
  return config.models.map((slug) => {
    const definition = getMossManagedModelDefinition(slug);
    if (!definition) throw new Error(`Managed model metadata is missing for ${slug}.`);
    return definition;
  });
}

const outputLimit = (definition: MossManagedModelDefinition): number =>
  Math.min(definition.maxOutputTokens, MOSS_MANAGED_ACP_AGENT_OUTPUT_LIMIT);

// ── Kimi Code: config.toml with an `openai` provider whose key is read from
// MOSS_ACCESS_TOKEN on every request (`api_key_env`); never on disk. ──

export const mossManagedKimiModelId = (slug: string): string =>
  `${MOSS_MANAGED_ACP_AGENT_PROVIDER_ID}/${slug}`;

export function buildMossManagedKimiConfigToml(
  gatewayBaseUrl: string,
  models: ReadonlyArray<MossManagedModelDefinition>,
): string {
  const [first] = models;
  if (!first) throw new Error("Managed Kimi Code has no models in this realm.");
  return [
    `default_model = ${quote(mossManagedKimiModelId(first.id))}`,
    "telemetry = false",
    "",
    `[providers.${MOSS_MANAGED_ACP_AGENT_PROVIDER_ID}]`,
    'type = "openai"',
    `base_url = ${quote(gatewayBaseUrl)}`,
    `api_key_env = ${quote(MOSS_MANAGED_ACP_AGENT_CREDENTIAL_ENV_KEY)}`,
    ...models.flatMap((definition) => [
      "",
      `[models.${quote(mossManagedKimiModelId(definition.id))}]`,
      `provider = ${quote(MOSS_MANAGED_ACP_AGENT_PROVIDER_ID)}`,
      `model = ${quote(definition.id)}`,
      `display_name = ${quote(definition.displayName)}`,
      `max_context_size = ${definition.contextWindow}`,
      `max_output_size = ${outputLimit(definition)}`,
      `capabilities = ${quote([
        ...(definition.reasoning ? ["thinking"] : []),
        ...(definition.inputModalities.includes("image") ? ["image_in"] : []),
        "tool_use",
      ])}`,
      ...(definition.reasoning
        ? [
            `support_efforts = ${quote(definition.reasoning.levels)}`,
            `default_effort = ${quote(definition.reasoning.default)}`,
          ]
        : []),
    ]),
    "",
  ].join("\n");
}

// ── MiniMax Code: config.yaml (JSON is valid YAML) with a custom provider on
// the OpenAI Chat Completions protocol; `${MOSS_ACCESS_TOKEN}` is a whole-value
// environment reference the CLI resolves at request time. ──

export const mossManagedMinimaxModelId = (slug: string): string =>
  [
    "m",
    encodeURIComponent(`custom_provider:${MOSS_MANAGED_ACP_AGENT_PROVIDER_ID}`),
    encodeURIComponent(slug),
    "u",
  ].join(":");

export function buildMossManagedMinimaxConfig(
  gatewayBaseUrl: string,
  models: ReadonlyArray<MossManagedModelDefinition>,
) {
  const [first] = models;
  if (!first) throw new Error("Managed MiniMax Code has no models in this realm.");
  return {
    defaultModel: `custom_provider:${MOSS_MANAGED_ACP_AGENT_PROVIDER_ID}/${first.id}`,
    custom_provider: {
      [MOSS_MANAGED_ACP_AGENT_PROVIDER_ID]: {
        name: "Moss",
        kind: "custom",
        enabled: true,
        // The CLI defaults to anthropic-messages; the gateway lineup is chat completions.
        api: "openai-completions",
        options: {
          authMode: "api-key",
          baseURL: gatewayBaseUrl,
          apiKey: `\${${MOSS_MANAGED_ACP_AGENT_CREDENTIAL_ENV_KEY}}`,
        },
        models: Object.fromEntries(
          models.map((definition) => [
            definition.id,
            {
              name: definition.displayName,
              limit: { context: definition.contextWindow, output: outputLimit(definition) },
              tool_call: true,
              reasoning: definition.reasoning !== null,
            },
          ]),
        ),
      },
    },
  };
}

// ── ZCode: the backend reads `v2/provider_config.json` (3.12+) and the bridge
// builds its model dropdown and credential check from the legacy
// `v2/config.json`; neither expands environment references, so the key is
// written in plaintext into a 0600 file in the Moss-private home. ──

export const mossManagedZcodeModelId = (slug: string): string =>
  `${MOSS_MANAGED_ACP_AGENT_PROVIDER_ID}\\${slug}`;

export function buildMossManagedZcodeProviderConfig(input: {
  readonly gatewayBaseUrl: string;
  readonly models: ReadonlyArray<MossManagedModelDefinition>;
  readonly accessToken: string;
}) {
  const [first] = input.models;
  if (!first) throw new Error("Managed ZCode has no models in this realm.");
  return {
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: MOSS_MANAGED_ACP_AGENT_PROVIDER_ID,
            providerName: "Moss",
            enabled: true,
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey: input.accessToken },
              api: { type: "openai-chat-completions", baseUrl: input.gatewayBaseUrl },
              personalModelIds: input.models.map((definition) => definition.id),
            },
          },
        ],
      },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      defaultModelSelection: { providerId: MOSS_MANAGED_ACP_AGENT_PROVIDER_ID, modelId: first.id },
    },
  };
}

export function buildMossManagedZcodeLegacyConfig(input: {
  readonly gatewayBaseUrl: string;
  readonly models: ReadonlyArray<MossManagedModelDefinition>;
  readonly accessToken: string;
}) {
  return {
    provider: {
      [MOSS_MANAGED_ACP_AGENT_PROVIDER_ID]: {
        name: "Moss",
        // Any non-anthropic kind maps to openai-chat-completions in the bridge.
        kind: "openai-compatible",
        enabled: true,
        source: "custom",
        options: { baseURL: input.gatewayBaseUrl, apiKey: input.accessToken },
        models: Object.fromEntries(
          input.models.map((definition) => [
            definition.id,
            {
              name: definition.displayName,
              limit: { context: definition.contextWindow, output: outputLimit(definition) },
              ...(definition.reasoning
                ? {
                    reasoning: {
                      enabled: true,
                      variants: [...definition.reasoning.levels],
                      defaultVariant: definition.reasoning.default,
                    },
                  }
                : {}),
            },
          ]),
        ),
      },
    },
  };
}

const jsonFile = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const MOSS_MANAGED_ACP_AGENT_RECIPES: Readonly<Record<AcpAgentKind, MossManagedAcpAgentRecipe>> = {
  kimi: {
    modelId: mossManagedKimiModelId,
    tokenInEnvironment: true,
    files: ({ config, models }) => [
      {
        relativePath: "config.toml",
        content: buildMossManagedKimiConfigToml(config.gatewayBaseUrl, models),
      },
    ],
    environment: () => ({
      KIMI_DISABLE_TELEMETRY: "1",
      KIMI_CODE_NO_AUTO_UPDATE: "1",
      // config.toml `max_output_size` only reaches `anthropic` providers; this
      // global override caps the `openai` gateway provider's completions too.
      KIMI_MODEL_MAX_COMPLETION_TOKENS: String(MOSS_MANAGED_ACP_AGENT_OUTPUT_LIMIT),
    }),
  },
  minimax: {
    modelId: mossManagedMinimaxModelId,
    tokenInEnvironment: true,
    files: ({ config, models }) => [
      {
        relativePath: "config.yaml",
        content: jsonFile(buildMossManagedMinimaxConfig(config.gatewayBaseUrl, models)),
      },
    ],
    environment: () => ({}),
  },
  zcode: {
    modelId: mossManagedZcodeModelId,
    tokenInEnvironment: false,
    files: ({ config, models, accessToken }) => {
      const input = { gatewayBaseUrl: config.gatewayBaseUrl, models, accessToken };
      return [
        {
          relativePath: path.join("v2", "provider_config.json"),
          content: jsonFile(buildMossManagedZcodeProviderConfig(input)),
        },
        {
          relativePath: path.join("v2", "config.json"),
          content: jsonFile(buildMossManagedZcodeLegacyConfig(input)),
        },
      ];
    },
    environment: ({ config, env }) => ({
      // Pin provider and model together: the bridge switches every new session
      // to the pair and fails loudly if the backend refuses it.
      ZCODE_PROVIDER: MOSS_MANAGED_ACP_AGENT_PROVIDER_ID,
      ZCODE_MODEL: config.models[0]!,
      // No XDG_CONFIG_HOME override: it would reach every shell tool (git, gh)
      // the agent runs. A user config that sets yolo is corrected by the
      // explicit session/set_mode Moss sends before each turn.
      ...Object.fromEntries(
        ZCODE_PASSTHROUGH_ENV_KEYS.flatMap((key) => {
          const value = env[key]?.trim();
          return value ? [[key, value]] : [];
        }),
      ),
    }),
  },
};

export function mossManagedAcpAgentModels(kind: AcpAgentKind, realm: MossAccessLane): string[] {
  const prefix = MOSS_MANAGED_ACP_AGENT_MODEL_PREFIXES[kind];
  return mossLaneEngineLineup(realm, "opencode").filter((model) => model.startsWith(prefix));
}

export function buildMossManagedAcpAgentConfig(
  spec: ManagedAcpAgentSpec,
  gatewayBaseUrl: string,
  realm: MossAccessLane,
  homePath: string,
): AcpAgentManagedConfig {
  if (!isCanonicalIsolatedHome(homePath))
    throw new Error(`Managed ${spec.displayName} requires a canonical absolute isolated home.`);
  const models = mossManagedAcpAgentModels(spec.kind, realm);
  if (models.length === 0)
    throw new Error(`Managed ${spec.displayName} has no models in this realm.`);
  return {
    realm,
    gatewayBaseUrl: normalizeMossManagedOpenCodeGatewayBaseUrl(gatewayBaseUrl),
    homePath,
    models,
  };
}

function relayDefinition(
  spec: ManagedAcpAgentSpec,
): MossManagedRelayDefinition<AcpAgentKind, AcpAgentManagedConfig> {
  const label = `Managed ${spec.displayName}`;
  return {
    driver: spec.kind,
    instanceId: spec.managedInstanceId,
    label,
    configEnvKey: MOSS_MANAGED_ACP_AGENT_CONFIG_ENV_KEYS[spec.kind],
    credentialEnvKey: MOSS_MANAGED_ACP_AGENT_CREDENTIAL_ENV_KEY,
    buildCatalog: ({ gatewayBaseUrl, realm, parsed }) => {
      if (typeof parsed.homePath !== "string")
        throw new Error(`${label} requires a trusted Moss gateway and realm.`);
      return buildMossManagedAcpAgentConfig(spec, gatewayBaseUrl, realm, parsed.homePath);
    },
    models: (catalog) => catalog.models,
  };
}

/** Decodes the managed catalog variable; undefined for an own-login instance. */
export function readMossManagedAcpAgentCatalog(
  spec: ManagedAcpAgentSpec,
  environment: Readonly<Record<string, string>> | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): AcpAgentManagedConfig | undefined {
  return readMossManagedRelayCatalog(relayDefinition(spec), environment, env);
}

export function buildMossManagedAcpAgentProviderInstance(
  spec: ManagedAcpAgentSpec,
  input: MossManagedRelayBuildInput,
): MossManagedRelayProviderInstance<AcpAgentKind> {
  const instance = buildMossManagedRelayProviderInstance(
    relayDefinition(spec),
    buildMossManagedAcpAgentConfig(spec, input.gatewayBaseUrl, input.realm, input.homePath),
    input,
  );
  if (!input.runtimeGeneration.trim())
    throw new Error(`Managed ${spec.displayName} requires a runtime generation.`);
  return instance;
}

export function isVerifiedMossManagedAcpAgentProviderInstance(
  spec: ManagedAcpAgentSpec,
  input: MossManagedRelayVerifyInput,
): boolean {
  return isVerifiedMossManagedRelayProviderInstance(
    relayDefinition(spec),
    (build) => buildMossManagedAcpAgentProviderInstance(spec, build),
    input,
  );
}

/** Registry entry shape shared with the Hermes/Grok relays. */
export function mossManagedAcpAgentRelay<Spec extends ManagedAcpAgentSpec>(spec: Spec) {
  return {
    driver: spec.kind,
    instanceId: spec.managedInstanceId,
    build: (input: MossManagedRelayBuildInput) =>
      buildMossManagedAcpAgentProviderInstance(spec, input),
    verify: (input: MossManagedRelayVerifyInput) =>
      isVerifiedMossManagedAcpAgentProviderInstance(spec, input),
    matches: (
      actual: ProviderInstanceConfig | undefined,
      expected: ProviderInstanceConfig | undefined,
    ) => matchesMossManagedRelayProviderInstance(actual, expected),
  } as const;
}

/**
 * The CLI's private data root inside the instance home: the single directory
 * the spec relocates the CLI to (ZCode needs the `.zcode` basename).
 */
function managedDataRoot(spec: ManagedAcpAgentSpec, homePath: string): string {
  return Object.values(spec.homeEnvironment(homePath))[0] ?? homePath;
}

export function listMossManagedAcpAgentModels(
  spec: ManagedAcpAgentSpec,
  config: AcpAgentManagedConfig,
): ProviderListModelsResult {
  return {
    models: config.models.map((slug) => ({
      slug,
      name: getMossManagedModelDefinition(slug)?.displayName ?? slug,
    })),
    source: `moss-managed-${spec.kind}`,
    cached: false,
  };
}

function requireAccessToken(spec: ManagedAcpAgentSpec, settings: AcpAgentRuntimeSettings): string {
  const token = settings.environment?.[MOSS_MANAGED_ACP_AGENT_CREDENTIAL_ENV_KEY]?.trim();
  if (!token) throw new Error(`Managed ${spec.displayName} requires a Moss access token.`);
  return token;
}

/** Materializes the private home and the CLI's generated provider config (0700 dirs, 0600 files). */
export async function prepareMossManagedAcpAgentHome(
  spec: ManagedAcpAgentSpec,
  config: AcpAgentManagedConfig,
  settings: AcpAgentRuntimeSettings,
): Promise<void> {
  const accessToken = requireAccessToken(spec, settings);
  const homeLabel = `Managed ${spec.displayName} home`;
  const dataRoot = managedDataRoot(spec, config.homePath);
  await ensureMossManagedHome(config.homePath, homeLabel);
  const files = MOSS_MANAGED_ACP_AGENT_RECIPES[spec.kind].files({
    config,
    models: managedModelDefinitions(config),
    accessToken,
  });
  for (const file of files) {
    const directory = path.join(dataRoot, path.dirname(file.relativePath));
    await ensureMossManagedHome(directory, homeLabel);
    await writeMossManagedFile({
      directory,
      fileName: path.basename(file.relativePath),
      content: file.content,
      label: `Managed ${spec.displayName} configuration`,
    });
  }
}

export function makeMossManagedAcpAgentHooks(spec: ManagedAcpAgentSpec): AcpAgentManagedHooks {
  const recipe = MOSS_MANAGED_ACP_AGENT_RECIPES[spec.kind];
  return {
    readConfig: (settings) => {
      const catalog = readMossManagedAcpAgentCatalog(spec, settings.environment);
      if (!catalog) return undefined;
      // The home flows from the instance config through the start options; a
      // mismatch means the launch path dropped or retargeted it.
      if (settings.homePath !== catalog.homePath)
        throw new Error(`Managed ${spec.displayName} requires its isolated realm home.`);
      return catalog;
    },
    prepareHome: (config, settings) => prepareMossManagedAcpAgentHome(spec, config, settings),
    buildSpawnEnvironment: (config, settings) => {
      const noProxy = mossManagedChildNoProxy();
      return {
        baseEnv: mossManagedChildBaseEnvironment(),
        environment: {
          ...spec.environmentDefaults,
          ...spec.homeEnvironment(config.homePath),
          ...recipe.environment({ config, env: process.env }),
          ...(recipe.tokenInEnvironment
            ? { [MOSS_MANAGED_ACP_AGENT_CREDENTIAL_ENV_KEY]: requireAccessToken(spec, settings) }
            : {}),
          NO_PROXY: noProxy,
          no_proxy: noProxy,
        },
        inheritedMossKeys: recipe.tokenInEnvironment
          ? [MOSS_MANAGED_ACP_AGENT_CREDENTIAL_ENV_KEY]
          : [],
      };
    },
    listModels: (config) => listMossManagedAcpAgentModels(spec, config),
    modelId: (model) => recipe.modelId(model.trim()),
  };
}

export function withMossManagedAcpAgentHooks<Kind extends AcpAgentKind>(
  spec: Omit<AcpAgentSpec<Kind>, "managed">,
): AcpAgentSpec<Kind> {
  return { ...spec, managed: makeMossManagedAcpAgentHooks(spec) };
}
