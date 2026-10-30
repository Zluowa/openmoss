import type { ProviderInstanceConfig } from "@synara/contracts";
import {
  MANAGED_GATEWAY_OPENCODE_DEFAULT_MODEL,
  MANAGED_GATEWAY_OPENCODE_ENABLED_MODELS,
} from "@synara/shared/mossManagedModelCatalog";
import { getMossManagedModelDefinition } from "@synara/shared/mossRealmCatalog";

import { isTrustedMossManagedGatewayUrl } from "./mossManagedGatewayTrust.ts";

export const MOSS_MANAGED_OPENCODE_PROVIDER_INSTANCE_ID = "opencode_moss";
export const MOSS_MANAGED_OPENCODE_CONFIG_ENV_KEY = "OPENCODE_CONFIG_CONTENT";
export const MOSS_MANAGED_OPENCODE_CREDENTIAL_ENV_KEY = "MOSS_ACCESS_TOKEN";
export const MOSS_MANAGED_OPENCODE_DISPLAY_NAME = "Moss DeepSeek & Kimi";
export const MOSS_MANAGED_OPENCODE_LOOPBACK_NO_PROXY = "127.0.0.1,localhost,::1";
// Keep a managed chat turn within the gateway's bounded streaming budget. A
// 128k OpenCode output reservation makes reasoning models spend minutes before
// emitting user-visible text and can exhaust the relay's 120s request window.
const MOSS_MANAGED_OPENCODE_OUTPUT_LIMIT = 32_768;

function requireManagedOpenCodeDefaultModel(): string {
  const model = MANAGED_GATEWAY_OPENCODE_DEFAULT_MODEL;
  if (!model || !MANAGED_GATEWAY_OPENCODE_ENABLED_MODELS.includes(model)) {
    throw new Error("The managed OpenCode default model is not live-passed.");
  }
  return model;
}

export const MOSS_MANAGED_OPENCODE_DEFAULT_MODEL = requireManagedOpenCodeDefaultModel();
export const MOSS_MANAGED_OPENCODE_MODELS = [
  MOSS_MANAGED_OPENCODE_DEFAULT_MODEL,
  ...MANAGED_GATEWAY_OPENCODE_ENABLED_MODELS.filter(
    (model) => model !== MOSS_MANAGED_OPENCODE_DEFAULT_MODEL,
  ),
];

function asConfigRecord(config: ProviderInstanceConfig["config"]): Record<string, unknown> {
  return config && typeof config === "object" && !Array.isArray(config)
    ? (config as Record<string, unknown>)
    : {};
}

function exactStringArray(value: unknown, expected: ReadonlyArray<string>): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

export function normalizeMossManagedOpenCodeGatewayBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) {
    throw new Error("Moss model gateway must use HTTPS (or 127.0.0.1 for local development).");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "Moss model gateway URLs must not contain credentials, query parameters, or fragments.",
    );
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "i-helios.top" || hostname.endsWith(".i-helios.top")) {
    throw new Error("The legacy Helios model relay is no longer supported.");
  }
  const pathname = url.pathname.replace(/\/+$/, "").replace(/(?:\/v1)+$/, "");
  url.pathname = `${pathname}/v1`;
  return url.toString().replace(/\/+$/, "");
}

function isTrustedManagedOpenCodeGateway(
  value: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  try {
    return isTrustedMossManagedGatewayUrl(normalizeMossManagedOpenCodeGatewayBaseUrl(value), env);
  } catch {
    return false;
  }
}

function normalizedManagedOpenCodeGateway(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return normalizeMossManagedOpenCodeGatewayBaseUrl(value);
  } catch {
    return undefined;
  }
}

function isCompatibleManagedOpenCodeConfig(actual: string, expected: string): boolean {
  type ModelConfig = { limit?: { context: number; output: number } };
  const legacyContextLimits: Readonly<Record<string, number>> = {
    "deepseek-v4-flash": 1_048_576,
    "glm-5.3": 1_048_576,
    "glm-5.3-flash": 1_048_576,
    "minimax-m3": 1_000_000,
  };
  try {
    const current = JSON.parse(actual) as Record<string, any>;
    const target = JSON.parse(expected) as Record<string, any>;
    const currentModels = current.provider?.moss?.models as Record<string, ModelConfig> | undefined;
    const targetModels = target.provider?.moss?.models as Record<string, ModelConfig> | undefined;
    if (!currentModels || !targetModels) return false;
    for (const [model, targetDefinition] of Object.entries(targetModels) as Array<
      [string, ModelConfig]
    >) {
      const currentDefinition = currentModels[model];
      if (!currentDefinition || !targetDefinition) return false;
      // A prior build persisted the vendor output limit before the managed
      // 32K cap was introduced. Treat that single bounded migration as
      // compatible so startup can rewrite it; all other config fields remain
      // exact and continue through the normal verifier.
      if (!currentDefinition.limit || !targetDefinition.limit) return false;
      if (currentDefinition.limit.context !== targetDefinition.limit.context) {
        if (currentDefinition.limit.context !== legacyContextLimits[model]) return false;
        currentDefinition.limit.context = targetDefinition.limit.context;
      }
      currentDefinition.limit.output = targetDefinition.limit.output;
    }
    return JSON.stringify(current) === expected;
  } catch {
    return false;
  }
}

function managedOpenCodeModelDisplayName(slug: string): string {
  const words = slug
    .replace(/^moss\//, "")
    .split("-")
    .filter(Boolean);
  return words
    .map((word, index) => {
      if (index === 0 && word.toLowerCase() === "deepseek") return "DeepSeek";
      if (index === 0 && word.toLowerCase() === "kimi") return "Kimi";
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

export function buildMossManagedOpenCodeConfig(input: {
  readonly gatewayBaseUrl: string;
  readonly credentialEnvKey?: string;
  readonly models?: ReadonlyArray<string>;
}): string {
  const baseURL = normalizeMossManagedOpenCodeGatewayBaseUrl(input.gatewayBaseUrl);
  const credentialEnvKey = input.credentialEnvKey ?? MOSS_MANAGED_OPENCODE_CREDENTIAL_ENV_KEY;
  if (credentialEnvKey !== MOSS_MANAGED_OPENCODE_CREDENTIAL_ENV_KEY) {
    throw new Error("Managed OpenCode must authenticate through the Moss access-token gateway.");
  }
  const allowedModels = new Set(MOSS_MANAGED_OPENCODE_MODELS);
  const models = [...new Set(input.models ?? MOSS_MANAGED_OPENCODE_MODELS)].filter((model) =>
    allowedModels.has(model),
  );
  if (models.length === 0) {
    throw new Error("Managed OpenCode requires at least one live-passed chat model.");
  }
  // Context/output limits let OpenCode compact before the window fills and cap
  // generations at what each vendor accepts.
  const configuredModels = Object.fromEntries(
    models.map((slug) => {
      const id = slug.replace(/^moss\//, "");
      const definition = getMossManagedModelDefinition(id);
      return [
        id,
        {
          name: definition?.displayName ?? managedOpenCodeModelDisplayName(slug),
          ...(definition
            ? {
                limit: {
                  context: definition.contextWindow,
                  output: Math.min(definition.maxOutputTokens, MOSS_MANAGED_OPENCODE_OUTPUT_LIMIT),
                },
                ...(definition.inputModalities.includes("image")
                  ? { modalities: { input: ["text", "image"], output: ["text"] } }
                  : {}),
              }
            : {}),
        },
      ];
    }),
  );
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: models[0] ?? MOSS_MANAGED_OPENCODE_DEFAULT_MODEL,
    provider: {
      moss: {
        npm: "@ai-sdk/openai-compatible",
        name: "Moss",
        options: {
          baseURL,
          apiKey: `{env:${credentialEnvKey}}`,
        },
        models: configuredModels,
      },
    },
  });
}

export function buildMossManagedOpenCodeEnvironment(input: {
  readonly accessToken: string;
  readonly gatewayBaseUrl: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): NonNullable<ProviderInstanceConfig["environment"]> {
  const gatewayBaseUrl = normalizeMossManagedOpenCodeGatewayBaseUrl(input.gatewayBaseUrl);
  if (!input.accessToken.trim()) {
    throw new Error("Managed OpenCode requires a non-empty Moss access token.");
  }
  if (!isTrustedManagedOpenCodeGateway(gatewayBaseUrl, input.env)) {
    throw new Error("Managed OpenCode must authenticate through the trusted Moss Edge gateway.");
  }
  const environment: NonNullable<ProviderInstanceConfig["environment"]> = [
    {
      name: MOSS_MANAGED_OPENCODE_CONFIG_ENV_KEY,
      value: buildMossManagedOpenCodeConfig({ gatewayBaseUrl }),
      sensitive: false,
    },
    {
      name: MOSS_MANAGED_OPENCODE_CREDENTIAL_ENV_KEY,
      value: input.accessToken,
      sensitive: true,
    },
  ];
  if (new URL(gatewayBaseUrl).hostname !== "127.0.0.1") return environment;
  return [
    ...environment,
    {
      name: "NO_PROXY",
      value: MOSS_MANAGED_OPENCODE_LOOPBACK_NO_PROXY,
      sensitive: false,
    },
    {
      name: "no_proxy",
      value: MOSS_MANAGED_OPENCODE_LOOPBACK_NO_PROXY,
      sensitive: false,
    },
  ];
}

export function buildMossManagedOpenCodeProviderInstance(input: {
  readonly accessToken: string;
  readonly gatewayBaseUrl: string;
  readonly runtimeGeneration: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): ProviderInstanceConfig {
  if (!input.runtimeGeneration.trim()) {
    throw new Error("Managed OpenCode requires a runtime generation.");
  }
  const gatewayBaseUrl = normalizeMossManagedOpenCodeGatewayBaseUrl(input.gatewayBaseUrl);
  return {
    driver: "opencode",
    displayName: MOSS_MANAGED_OPENCODE_DISPLAY_NAME,
    enabled: true,
    environment: buildMossManagedOpenCodeEnvironment({
      accessToken: input.accessToken,
      gatewayBaseUrl,
      ...(input.env ? { env: input.env } : {}),
    }),
    config: {
      customModels: [...MOSS_MANAGED_OPENCODE_MODELS],
      modelAllowlist: [...MOSS_MANAGED_OPENCODE_MODELS],
      defaultModel: MOSS_MANAGED_OPENCODE_DEFAULT_MODEL,
      managed: true,
      gatewayBaseUrl,
      credentialEnvKey: MOSS_MANAGED_OPENCODE_CREDENTIAL_ENV_KEY,
      runtimeGeneration: input.runtimeGeneration,
    },
  };
}

/** Single launch/provision verifier for the fixed server-owned OpenCode surface. */
export function isVerifiedMossManagedOpenCodeProviderInstance(input: {
  readonly instanceId: string;
  readonly instance: ProviderInstanceConfig | undefined;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly allowDisabled?: boolean;
}): boolean {
  const instance = input.instance;
  if (!instance) return false;
  const config = asConfigRecord(instance?.config);
  const credentialEntry = instance?.environment?.find(
    (entry) => entry.name === MOSS_MANAGED_OPENCODE_CREDENTIAL_ENV_KEY,
  );
  // Persisted settings intentionally redact the managed bearer and retain a
  // versioned secret reference.  Verify the structural envelope with a
  // sentinel in that case; ServerSettings materializes the reference before
  // launch, while a bare redacted marker without a reference remains invalid.
  const verificationInstance: ProviderInstanceConfig =
    credentialEntry?.valueRedacted === true &&
    typeof credentialEntry.valueSecretRef === "string" &&
    credentialEntry.valueSecretRef.startsWith("provider-secret-v2-")
      ? ({
          ...instance,
          environment: instance.environment?.map((entry) =>
            entry.name === MOSS_MANAGED_OPENCODE_CREDENTIAL_ENV_KEY
              ? { ...entry, value: "moss-redacted-credential-proof", valueRedacted: false }
              : entry,
          ),
        } as ProviderInstanceConfig)
      : instance;
  const gatewayBaseUrl = normalizedManagedOpenCodeGateway(config.gatewayBaseUrl);
  const allowedConfigKeys = new Set([
    "customModels",
    "modelAllowlist",
    "defaultModel",
    "managed",
    "gatewayBaseUrl",
    "credentialEnvKey",
    "runtimeGeneration",
    "managedCleanupState",
  ]);
  if (
    input.instanceId !== MOSS_MANAGED_OPENCODE_PROVIDER_INSTANCE_ID ||
    verificationInstance?.driver !== "opencode" ||
    verificationInstance.displayName !== MOSS_MANAGED_OPENCODE_DISPLAY_NAME ||
    config.managed !== true ||
    config.credentialEnvKey !== MOSS_MANAGED_OPENCODE_CREDENTIAL_ENV_KEY ||
    !gatewayBaseUrl ||
    !isTrustedManagedOpenCodeGateway(gatewayBaseUrl, input.env) ||
    config.defaultModel !== MOSS_MANAGED_OPENCODE_DEFAULT_MODEL ||
    !exactStringArray(config.modelAllowlist, MOSS_MANAGED_OPENCODE_MODELS) ||
    !exactStringArray(config.customModels, MOSS_MANAGED_OPENCODE_MODELS) ||
    typeof config.runtimeGeneration !== "string" ||
    config.runtimeGeneration.trim().length === 0 ||
    Object.keys(config).some((key) => !allowedConfigKeys.has(key)) ||
    config.binaryPath !== undefined ||
    config.serverPassword !== undefined
  ) {
    return false;
  }
  if (instance.enabled === false) {
    return (
      input.allowDisabled === true &&
      (instance.environment?.length ?? 0) === 0 &&
      (config.managedCleanupState === undefined ||
        config.managedCleanupState === "pending-v1" ||
        config.managedCleanupState === "complete-v1")
    );
  }
  if (instance.enabled !== true || config.managedCleanupState !== undefined) return false;

  const expectedConfig = buildMossManagedOpenCodeConfig({ gatewayBaseUrl });
  const environment = verificationInstance.environment ?? [];
  const expectedEnvironmentNames =
    new URL(gatewayBaseUrl).hostname === "127.0.0.1"
      ? [
          MOSS_MANAGED_OPENCODE_CONFIG_ENV_KEY,
          MOSS_MANAGED_OPENCODE_CREDENTIAL_ENV_KEY,
          "NO_PROXY",
          "no_proxy",
        ]
      : [MOSS_MANAGED_OPENCODE_CONFIG_ENV_KEY, MOSS_MANAGED_OPENCODE_CREDENTIAL_ENV_KEY];
  if (
    environment.length !== expectedEnvironmentNames.length ||
    environment.some(
      (entry, index) =>
        entry.name !== expectedEnvironmentNames[index] || entry.valueRedacted === true,
    )
  ) {
    return false;
  }
  const [configEntry, tokenEntry, noProxyEntry, lowercaseNoProxyEntry] = environment;
  return (
    (configEntry?.value === expectedConfig ||
      (typeof configEntry?.value === "string" &&
        isCompatibleManagedOpenCodeConfig(configEntry.value, expectedConfig))) &&
    configEntry.sensitive === false &&
    tokenEntry?.sensitive === true &&
    typeof tokenEntry.value === "string" &&
    tokenEntry.value.trim().length > 0 &&
    (noProxyEntry === undefined ||
      (noProxyEntry.value === MOSS_MANAGED_OPENCODE_LOOPBACK_NO_PROXY &&
        noProxyEntry.sensitive === false)) &&
    (lowercaseNoProxyEntry === undefined ||
      (lowercaseNoProxyEntry.value === MOSS_MANAGED_OPENCODE_LOOPBACK_NO_PROXY &&
        lowercaseNoProxyEntry.sensitive === false))
  );
}
