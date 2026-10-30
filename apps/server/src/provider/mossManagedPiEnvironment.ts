import type { ProviderInstanceConfig } from "@synara/contracts";
import {
  getMossManagedModelDefinition,
  isMossAccessLane,
  MOSS_ACCESS_LANE_SPECS,
  mossLaneEngineLineup,
  type MossAccessLane,
} from "@synara/shared/mossRealmCatalog";
import { isTrustedMossManagedGatewayUrlForAuthority } from "./mossManagedGatewayTrust";
import { normalizeMossManagedOpenCodeGatewayBaseUrl } from "./mossManagedOpenCodeEnvironment";

export const MOSS_MANAGED_PI_PROVIDER_INSTANCE_ID = "pi_moss";
export const MOSS_MANAGED_PI_CONFIG_ENV_KEY = "MOSS_PI_CONFIG_CONTENT";
export const MOSS_MANAGED_PI_CREDENTIAL_ENV_KEY = "MOSS_ACCESS_TOKEN";

export function mossManagedPiModels(realm: MossAccessLane): string[] {
  return mossLaneEngineLineup(realm, "opencode").map((id) => `moss/${id}`);
}

/** No credentials or executable config values are included in this catalog. */
export function buildMossManagedPiConfig(gatewayBaseUrl: string, realm: MossAccessLane) {
  return {
    realm,
    provider: {
      baseUrl: normalizeMossManagedOpenCodeGatewayBaseUrl(gatewayBaseUrl),
      api: "openai-completions" as const,
      authHeader: true,
      compat: { supportsDeveloperRole: false },
      models: mossManagedPiModels(realm).map((slug) => {
        const id = slug.slice("moss/".length);
        const definition = getMossManagedModelDefinition(id)!;
        return {
          id,
          name: definition.displayName,
          reasoning: false,
          input: ["text"] as Array<"text" | "image">,
          contextWindow: definition.contextWindow,
          maxTokens: Math.min(definition.maxOutputTokens, 32_768),
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        };
      }),
    },
  };
}

export function readMossManagedPiConfig(
  environment: Readonly<Record<string, string>> | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ReturnType<typeof buildMossManagedPiConfig> | undefined {
  const raw = environment?.[MOSS_MANAGED_PI_CONFIG_ENV_KEY];
  if (raw === undefined) return undefined;
  const parsed = JSON.parse(raw);
  if (
    !isMossAccessLane(parsed.realm) ||
    typeof parsed.provider?.baseUrl !== "string" ||
    !isTrustedMossManagedGatewayUrlForAuthority(
      parsed.provider.baseUrl,
      MOSS_ACCESS_LANE_SPECS[parsed.realm as MossAccessLane].authority,
      env,
    )
  ) {
    throw new Error("Managed Pi requires a trusted Moss gateway and realm.");
  }
  const expected = buildMossManagedPiConfig(parsed.provider.baseUrl, parsed.realm);
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) {
    throw new Error("Managed Pi model configuration does not match its realm catalog.");
  }
  if (!environment?.[MOSS_MANAGED_PI_CREDENTIAL_ENV_KEY]?.trim()) {
    throw new Error("Managed Pi requires a Moss access token.");
  }
  return expected;
}

export function buildMossManagedPiProviderInstance(input: {
  readonly accessToken: string;
  readonly gatewayBaseUrl: string;
  readonly runtimeGeneration: string;
  readonly agentDir: string;
  readonly realm: MossAccessLane;
  readonly env?: Readonly<Record<string, string | undefined>>;
}) {
  const catalog = buildMossManagedPiConfig(input.gatewayBaseUrl, input.realm);
  const environment = [
    { name: MOSS_MANAGED_PI_CONFIG_ENV_KEY, value: JSON.stringify(catalog), sensitive: false },
    { name: MOSS_MANAGED_PI_CREDENTIAL_ENV_KEY, value: input.accessToken, sensitive: true },
  ];
  readMossManagedPiConfig(
    Object.fromEntries(environment.map((entry) => [entry.name, entry.value])),
    input.env,
  );
  if (!input.runtimeGeneration.trim() || !input.agentDir.trim()) {
    throw new Error("Managed Pi requires an isolated agent directory and runtime generation.");
  }
  const models = mossManagedPiModels(input.realm);
  return {
    driver: "pi",
    displayName: "Moss",
    enabled: true,
    environment,
    config: {
      managed: true,
      realm: input.realm,
      agentDir: input.agentDir,
      gatewayBaseUrl: catalog.provider.baseUrl,
      credentialEnvKey: MOSS_MANAGED_PI_CREDENTIAL_ENV_KEY,
      runtimeGeneration: input.runtimeGeneration,
      customModels: models,
      modelAllowlist: models,
      defaultModel: models[0]!,
    },
  } satisfies ProviderInstanceConfig;
}

export function isVerifiedMossManagedPiProviderInstance(input: {
  readonly instanceId: string;
  readonly instance: ProviderInstanceConfig | undefined;
  readonly allowDisabled?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): boolean {
  const instance = input.instance;
  if (!instance || input.instanceId !== MOSS_MANAGED_PI_PROVIDER_INSTANCE_ID) return false;
  const value = instance.config;
  const config =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  if (
    !config ||
    instance.driver !== "pi" ||
    instance.displayName !== "Moss" ||
    config.managed !== true ||
    !isMossAccessLane(config.realm) ||
    typeof config.gatewayBaseUrl !== "string" ||
    typeof config.agentDir !== "string" ||
    typeof config.runtimeGeneration !== "string"
  )
    return false;
  try {
    const expected = buildMossManagedPiProviderInstance({
      accessToken: "structural-proof",
      gatewayBaseUrl: config.gatewayBaseUrl,
      runtimeGeneration: config.runtimeGeneration,
      agentDir: config.agentDir,
      realm: config.realm,
      ...(input.env ? { env: input.env } : {}),
    });
    const { managedCleanupState, ...actualConfig } = config;
    if (JSON.stringify(actualConfig) !== JSON.stringify(expected.config)) return false;
    if (!instance.enabled)
      return (
        input.allowDisabled === true &&
        instance.environment?.length === 0 &&
        (managedCleanupState === undefined ||
          managedCleanupState === "pending-v1" ||
          managedCleanupState === "complete-v1")
      );
    if (managedCleanupState !== undefined || instance.environment?.length !== 2) return false;
    const [catalog, token] = instance.environment;
    return (
      catalog?.name === MOSS_MANAGED_PI_CONFIG_ENV_KEY &&
      catalog.sensitive === false &&
      catalog.value === expected.environment?.[0]?.value &&
      token?.name === MOSS_MANAGED_PI_CREDENTIAL_ENV_KEY &&
      token.sensitive === true &&
      ((typeof token.value === "string" && token.value.trim().length > 0 && !token.valueRedacted) ||
        (token.valueRedacted === true &&
          token.valueSecretRef?.startsWith("provider-secret-v2-") === true))
    );
  } catch {
    return false;
  }
}

/** Secret references/redaction metadata are storage details, not runtime identity. */
export function matchesMossManagedPiProviderInstance(
  actual: ProviderInstanceConfig | undefined,
  expected: ProviderInstanceConfig | undefined,
): boolean {
  if (!expected) return actual === undefined;
  return (
    actual?.enabled === true &&
    actual.driver === expected.driver &&
    actual.displayName === expected.displayName &&
    JSON.stringify(actual.config) === JSON.stringify(expected.config) &&
    actual.environment?.length === expected.environment?.length &&
    expected.environment?.every((entry, index) => {
      const current = actual.environment?.[index];
      return (
        current?.name === entry.name &&
        current.value === entry.value &&
        current.sensitive === entry.sensitive
      );
    }) === true
  );
}
