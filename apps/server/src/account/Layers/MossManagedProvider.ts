import {
  MOSS_MANAGED_HOME_OWNERSHIP_MARKER,
  MOSS_MANAGED_HOME_PROVISIONING_STATE,
  buildMossManagedHomeOwnershipMarker,
  verifiedMossManagedCodexReservation,
  type VerifiedMossManagedCodexReservation,
} from "../mossManagedHomeAuthority.ts";
export {
  MOSS_MANAGED_HOME_OWNERSHIP_MARKER,
  MOSS_MANAGED_HOME_PROVISIONING_STATE,
  buildMossManagedHomeOwnershipMarker,
} from "../mossManagedHomeAuthority.ts";
import { writeMossManagedPluginConfig } from "../mossManagedPluginConfig";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import nodePath from "node:path";

import type {
  ProviderInstanceConfig,
  ProviderInstanceConfigMap,
  ServerSettings,
  ServerSettingsPatch,
} from "@synara/contracts";
import {
  DEFAULT_CODEX_ACCOUNT_ID,
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  MODEL_OPTIONS_BY_PROVIDER,
} from "@synara/contracts";
import { codexAccountInstanceId } from "@synara/shared/providerInstances";
import {
  MANAGED_GATEWAY_CLAUDE_DEFAULT_MODEL,
  MANAGED_GATEWAY_CLAUDE_ENABLED_MODELS,
  MANAGED_GATEWAY_CODEX_DEFAULT_MODEL,
  MANAGED_GATEWAY_CODEX_ENABLED_MODELS,
  MOSS_SOURCE_MODEL_IDS,
} from "@synara/shared/mossManagedModelCatalog";
import {
  buildMossCodexModelCatalogEntry,
  getMossManagedModelDefinition,
  type MossAccessLane,
  mossAccessLaneForAuthority,
  mossLaneEngineLineup,
} from "@synara/shared/mossRealmCatalog";
import { Effect, FileSystem, Layer, Path } from "effect";

import { writeFileStringAtomically } from "../../atomicWrite";
import { PRIVATE_DIRECTORY_MODE, supportsPosixPermissions } from "../../privatePathPermissions";
import {
  canonicalizeCodexHomeIdentityPath,
  uniqueCodexLifecycleHomeIdentityPaths,
} from "../../codexHomeIdentity";
import { ServerConfig } from "../../config";
import {
  MOSS_BUNDLED_CLAUDE_PATH_ENV_KEY,
  MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID,
  MOSS_MANAGED_CLAUDE_TOOL_SEARCH_ENV_KEY,
  MOSS_MANAGED_CLAUDE_TOOL_SEARCH_ENV_VALUE,
  isVerifiedMossManagedClaudeProviderInstance,
} from "../../provider/claudeEnvironment";
import { ProviderValidationError } from "../../provider/Errors";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService";
import {
  MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL_ENV_KEY,
  MOSS_SUPABASE_GOOGLE_MODEL_GATEWAY_URL_ENV_KEY,
  MOSS_TRUSTED_MODEL_GATEWAY_ORIGINS_ENV_KEY,
  MOSS_CN_MODEL_GATEWAY_HOST,
  isTrustedMossManagedGatewayUrl,
  isTrustedMossManagedGatewayUrlForAuthority,
  type MossManagedGatewayAuthority,
} from "../../provider/mossManagedGatewayTrust";
import {
  MOSS_MANAGED_OPENCODE_CONFIG_ENV_KEY,
  MOSS_MANAGED_OPENCODE_CREDENTIAL_ENV_KEY,
  MOSS_MANAGED_OPENCODE_DEFAULT_MODEL,
  MOSS_MANAGED_OPENCODE_DISPLAY_NAME,
  MOSS_MANAGED_OPENCODE_MODELS,
  MOSS_MANAGED_OPENCODE_PROVIDER_INSTANCE_ID,
  buildMossManagedOpenCodeConfig,
  buildMossManagedOpenCodeEnvironment,
  buildMossManagedOpenCodeProviderInstance as buildMossManagedOpenCodeInstance,
  isVerifiedMossManagedOpenCodeProviderInstance,
} from "../../provider/mossManagedOpenCodeEnvironment";
import {
  MOSS_MANAGED_PI_PROVIDER_INSTANCE_ID,
  buildMossManagedPiProviderInstance,
  isVerifiedMossManagedPiProviderInstance,
  matchesMossManagedPiProviderInstance,
} from "../../provider/mossManagedPiEnvironment";
import { ServerSettingsService } from "../../serverSettings";
import { MOSS_MANAGED_SELECTION_FALLBACK_CONFIG_KEY } from "../../reservedSettingsBoundary";
import { withMossAccountLifecycleLock } from "../mossAccountLifecycleLock";
import {
  MOSS_MANAGED_RELAY_PROVIDERS,
  type MossManagedRelayDriver,
  buildMossManagedRelayInstances,
  inspectMossManagedRelayInstances,
  isMossManagedRelayInstanceId,
  mapMossManagedRelayInstances,
  matchesMossManagedRelayInstances,
} from "../managedRelayProviders";
import { removeMossCodexAccountOverlay } from "../mossCodexAccountCleanup";
import { MossCloudAccountServiceError } from "../mossCloudAccountErrors";
import {
  MOSS_BUNDLED_PLUGIN_MARKETPLACE_NAME,
  materializeMossBundledPluginMarketplace,
} from "../mossBundledPluginMarketplace";
import {
  MossManagedProvider,
  type MossManagedProviderShape,
} from "../Services/MossManagedProvider";

export const MOSS_MANAGED_CODEX_ACCOUNT_ID = "moss";
export const MOSS_MANAGED_PROVIDER_INSTANCE_ID = codexAccountInstanceId(
  MOSS_MANAGED_CODEX_ACCOUNT_ID,
);
// Codex treats this value as an OpenAI-compatible provider credential. Keep it
// on the provider-credential allowlist instead of the MOSS_* control-plane
// namespace, which is intentionally stripped from provider child processes.
export const MOSS_MANAGED_PROVIDER_ENV_KEY = "OPENAI_API_KEY";
export const MOSS_BUNDLED_CODEX_PATH_ENV_KEY = "MOSS_BUNDLED_CODEX_PATH";
export const MOSS_MANAGED_GATEWAY_API_KEY_ENV_KEY = "MOSS_MODEL_GATEWAY_API_KEY";
export const MOSS_MANAGED_GATEWAY_MODEL_ENV_KEY = "MOSS_MODEL_GATEWAY_MODEL";
export const MOSS_MANAGED_CLAUDE_MODEL_ENV_KEY = "MOSS_MODEL_GATEWAY_CLAUDE_MODEL";

// Recognize the APIMart-era automatic Luna pin for pre-start migration.
// Luna remains explicitly selectable in realms whose current catalog serves it.
const MOSS_MANAGED_QUARANTINED_CODEX_MODEL = "gpt-5.6-luna";

// Historical cleanup only; this is deliberately not a launch-trust alias.
const PREVIOUS_CN_MANAGED_GATEWAY =
  "https://moss-cn-models.inkcomicai.com/functions/v1/moss-model-gateway/v1";
const DIRECT_CN_MANAGED_GATEWAY = `https://${MOSS_CN_MODEL_GATEWAY_HOST}/functions/v1/moss-model-gateway/v1`;

function requireManagedDefaultModel(
  model: string | null,
  enabledModels: ReadonlyArray<string>,
  family: "Codex" | "Claude" | "OpenCode",
): string {
  if (model === null || !enabledModels.includes(model)) {
    throw new Error(`The managed ${family} default model is not live-passed.`);
  }
  return model;
}

export const MOSS_MANAGED_DEFAULT_MODEL = requireManagedDefaultModel(
  MANAGED_GATEWAY_CODEX_DEFAULT_MODEL,
  MANAGED_GATEWAY_CODEX_ENABLED_MODELS,
  "Codex",
);
export const MOSS_MANAGED_CLAUDE_DEFAULT_MODEL = requireManagedDefaultModel(
  MANAGED_GATEWAY_CLAUDE_DEFAULT_MODEL,
  MANAGED_GATEWAY_CLAUDE_ENABLED_MODELS,
  "Claude",
);
/**
 * The visible Moss source is finite, but Codex is Responses-only.
 * Kimi K3 remains visible in the canonical directory for its chat surface and
 * is deliberately excluded from this provider's callable allowlist until a
 * real Responses probe passes.
 */
export const MOSS_MANAGED_SOURCE_MODELS = MOSS_SOURCE_MODEL_IDS;
export const MOSS_MANAGED_CODEX_MODELS = MANAGED_GATEWAY_CODEX_ENABLED_MODELS;
export const MOSS_MANAGED_GPT56_MODELS = MOSS_MANAGED_CODEX_MODELS;
export const MOSS_MANAGED_CLAUDE_MODELS = [
  MOSS_MANAGED_CLAUDE_DEFAULT_MODEL,
  ...MANAGED_GATEWAY_CLAUDE_ENABLED_MODELS.filter(
    (model) => model !== MOSS_MANAGED_CLAUDE_DEFAULT_MODEL,
  ),
];
export { MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID };

/**
 * Normalize the authority-bound moss-model-gateway URL for managed Codex/Claude.
 * Phone stays on the CN gateway; both realms use OpenRouter upstream.
 */
export function resolveManagedModelBaseUrlForAuthority(input: {
  readonly authority: MossManagedGatewayAuthority;
  readonly configuredGatewayUrl: string;
}): string {
  void input.authority;
  return normalizeMossGatewayBaseUrl(input.configuredGatewayUrl);
}

/** Codex models the lane's gateway serves, default first. */
export function mossManagedCodexModelsForLane(lane: MossAccessLane): ReadonlyArray<string> {
  return mossLaneEngineLineup(lane, "codex");
}

/** Claude Code models the lane's gateway serves on Messages, default first. */
export function mossManagedClaudeModelsForLane(lane: MossAccessLane): ReadonlyArray<string> {
  return mossLaneEngineLineup(lane, "claude-code");
}

export const MOSS_MANAGED_CODEX_MODEL_CATALOG_FILE_NAME = "models.json";

/**
 * Codex `models.json` for the managed home. Codex reads each model's effort
 * ladder, context window, input modalities and auto-compaction threshold from
 * this catalog, so vendor models get healthy defaults on every account.
 */
export function buildMossManagedCodexModelCatalog(models: ReadonlyArray<string>): string {
  const entries = models
    .map((model, index) => {
      const definition = getMossManagedModelDefinition(model);
      if (!definition) return null;
      return buildMossCodexModelCatalogEntry(definition, index + 1);
    })
    .filter((entry): entry is Record<string, unknown> => entry !== null);
  return `${JSON.stringify({ models: entries }, null, 2)}\n`;
}

export {
  MOSS_MANAGED_OPENCODE_CONFIG_ENV_KEY,
  MOSS_MANAGED_OPENCODE_DEFAULT_MODEL,
  MOSS_MANAGED_OPENCODE_DISPLAY_NAME,
  MOSS_MANAGED_OPENCODE_MODELS,
  MOSS_MANAGED_OPENCODE_PROVIDER_INSTANCE_ID,
  buildMossManagedOpenCodeConfig,
  buildMossManagedOpenCodeEnvironment,
  buildMossManagedOpenCodeInstance,
  isVerifiedMossManagedOpenCodeProviderInstance,
};
export const MOSS_MANAGED_LOOPBACK_NO_PROXY = "127.0.0.1,localhost,::1";
const MOSS_MANAGED_CLEANUP_STATE_CONFIG_KEY = "managedCleanupState";
const MOSS_MANAGED_CLEANUP_PENDING = "pending-v1";
const MOSS_MANAGED_CLEANUP_COMPLETE = "complete-v1";
const MOSS_MANAGED_SELECTION_FALLBACK_VERSION = 1;
const MOSS_MANAGED_HOME_LEGACY_OWNERSHIP_VALUE = "moss-managed-codex-home-v1\n";

function isAlreadyExistsError(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST";
}

function bindRealDirectory(directoryPath: string, label: string): string {
  const info = lstatSync(directoryPath);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a real, non-symbolic-link directory.`);
  }
  return realpathSync(directoryPath);
}

function assertManagedHomeMarker(markerPath: string, ownershipNonce: string | undefined): void {
  const info = lstatSync(markerPath);
  const expectedValue = ownershipNonce
    ? buildMossManagedHomeOwnershipMarker(ownershipNonce)
    : MOSS_MANAGED_HOME_LEGACY_OWNERSHIP_VALUE;
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    readFileSync(markerPath, "utf8") !== expectedValue
  ) {
    throw new Error("The managed Moss home has no valid ownership marker.");
  }
}

function removeRecoverableIncompleteManagedHome(
  managedHomePath: string,
  ownershipNonce: string,
): boolean {
  const entries = readdirSync(managedHomePath);
  if (entries.length === 0) {
    rmdirSync(managedHomePath);
    return true;
  }
  if (entries.length !== 1) return false;
  const entry = entries[0];
  if (!entry) return false;
  if (
    entry !== MOSS_MANAGED_HOME_OWNERSHIP_MARKER &&
    !/^\.moss-managed-home\.\d+\.\d+\.tmp$/.test(entry)
  ) {
    return false;
  }
  const markerPath = nodePath.join(managedHomePath, entry);
  const info = lstatSync(markerPath);
  if (!info.isFile() || info.isSymbolicLink()) return false;
  const expectedValue = buildMossManagedHomeOwnershipMarker(ownershipNonce);
  const contents = readFileSync(markerPath, "utf8");
  if (contents.length > expectedValue.length || !expectedValue.startsWith(contents)) return false;
  unlinkSync(markerPath);
  // A non-recursive rmdir fails if a concurrent writer added anything after
  // the strict single-entry validation above.
  rmdirSync(managedHomePath);
  return true;
}

type VerifiedMossManagedSurfaces = {
  readonly codexReservation: VerifiedMossManagedCodexReservation | undefined;
  readonly codexInstance: ProviderInstanceConfig | undefined;
  readonly claudeInstance: ProviderInstanceConfig | undefined;
  readonly opencodeInstance: ProviderInstanceConfig | undefined;
  readonly piInstance: ProviderInstanceConfig | undefined;
  readonly relayInstances: ProviderInstanceConfigMap;
  readonly hasCollision: boolean;
  readonly hasLifecycleHomeCollision: boolean;
};

type MossManagedReservationCollisionState = {
  readonly hasReservedSurfaceCollision: boolean;
  readonly hasLifecycleHomeCollision: boolean;
};

export type MossManagedSettingsSelectionPolicy = "select" | "preserve" | "fallback-if-selected";

type MossManagedSelectionFallbackProvenance = {
  readonly version: 1;
  readonly accountFallback?: true;
  readonly textGenerationFallback?: true;
};

export function resolveMossBundledCodexBinaryPath(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  return env[MOSS_BUNDLED_CODEX_PATH_ENV_KEY]?.trim() || undefined;
}

export function resolveMossBundledClaudeBinaryPath(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  return env[MOSS_BUNDLED_CLAUDE_PATH_ENV_KEY]?.trim() || undefined;
}

const asConfigRecord = (
  config: ProviderInstanceConfig["config"],
): Readonly<Record<string, unknown>> => {
  if (typeof config !== "object" || config === null || Array.isArray(config)) return {};
  return config as Readonly<Record<string, unknown>>;
};

type ProtectedCodexEnvironmentKey = "CODEX_HOME" | "MOSS_HOME";

const protectedCodexEnvironmentKey = (name: string): ProtectedCodexEnvironmentKey | undefined => {
  const normalized = name.trim().toUpperCase();
  return normalized === "CODEX_HOME" || normalized === "MOSS_HOME" ? normalized : undefined;
};

function normalizeProtectedCodexEnvironmentKeys(
  entries: Iterable<readonly [string, string | undefined]>,
): {
  readonly environment: Readonly<Record<string, string>>;
  readonly ambiguousKeys: ReadonlySet<ProtectedCodexEnvironmentKey>;
} {
  const environment: Record<string, string> = {};
  const protectedValues = new Map<ProtectedCodexEnvironmentKey, string>();
  const ambiguousKeys = new Set<ProtectedCodexEnvironmentKey>();
  for (const [rawName, value] of entries) {
    if (typeof value !== "string") continue;
    const name = rawName.trim();
    if (!name) continue;
    const protectedKey = protectedCodexEnvironmentKey(name);
    if (!protectedKey) {
      environment[name] = value;
      continue;
    }
    // Windows environment lookup is case-insensitive even though spreading
    // process.env or decoding persisted entries produces a plain object. Apply
    // that protected-key behavior on every platform so aliases cannot bypass
    // provenance or home-identity checks. Conflicting aliases are surfaced to
    // callers, which fail closed instead of guessing which spelling wins.
    const normalizedValue = value.trim();
    const previousValue = protectedValues.get(protectedKey);
    if (previousValue !== undefined && previousValue !== normalizedValue) {
      ambiguousKeys.add(protectedKey);
      continue;
    }
    if (previousValue === undefined) {
      protectedValues.set(protectedKey, normalizedValue);
      environment[protectedKey] = normalizedValue;
    }
  }
  return { environment, ambiguousKeys };
}

const runtimeGenerationFromConfig = (
  config: ProviderInstanceConfig["config"],
): string | undefined => {
  const runtimeGeneration = asConfigRecord(config).runtimeGeneration;
  return typeof runtimeGeneration === "string" && runtimeGeneration.length > 0
    ? runtimeGeneration
    : undefined;
};

const managedCleanupStateFromConfig = (config: ProviderInstanceConfig["config"]): unknown =>
  asConfigRecord(config)[MOSS_MANAGED_CLEANUP_STATE_CONFIG_KEY];

const managedSelectionFallbackFromConfig = (
  config: unknown,
): MossManagedSelectionFallbackProvenance | undefined => {
  const candidate =
    typeof config === "object" && config !== null && !Array.isArray(config)
      ? (config as Readonly<Record<string, unknown>>)[MOSS_MANAGED_SELECTION_FALLBACK_CONFIG_KEY]
      : undefined;
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return undefined;
  }
  const record = candidate as Readonly<Record<string, unknown>>;
  const accountFallback = record.accountFallback === true;
  const textGenerationFallback = record.textGenerationFallback === true;
  if (record.version !== MOSS_MANAGED_SELECTION_FALLBACK_VERSION) return undefined;
  if (!accountFallback && !textGenerationFallback) return undefined;
  if (
    (record.accountFallback !== undefined && !accountFallback) ||
    (record.textGenerationFallback !== undefined && !textGenerationFallback)
  ) {
    return undefined;
  }
  return {
    version: 1,
    ...(accountFallback ? { accountFallback: true } : {}),
    ...(textGenerationFallback ? { textGenerationFallback: true } : {}),
  };
};

const managedSelectionFallbackFromSettings = (
  settings: ServerSettings,
): MossManagedSelectionFallbackProvenance | undefined =>
  managedSelectionFallbackFromConfig(
    settings.providerInstances[MOSS_MANAGED_PROVIDER_INSTANCE_ID]?.config,
  );

const withManagedCleanupState = (
  instance: ProviderInstanceConfig,
  state: typeof MOSS_MANAGED_CLEANUP_PENDING | typeof MOSS_MANAGED_CLEANUP_COMPLETE,
): ProviderInstanceConfig => ({
  ...instance,
  config: {
    ...asConfigRecord(instance.config),
    [MOSS_MANAGED_CLEANUP_STATE_CONFIG_KEY]: state,
  },
});

const storedPreviousSelectedAccountId = (settings: ServerSettings): string | null => {
  const previousSelectedAccountId = asConfigRecord(
    settings.providerInstances[MOSS_MANAGED_PROVIDER_INSTANCE_ID]?.config,
  ).previousSelectedAccountId;
  return typeof previousSelectedAccountId === "string" ? previousSelectedAccountId : null;
};

const isAvailableCodexAccountId = (settings: ServerSettings, accountId: string): boolean =>
  accountId === DEFAULT_CODEX_ACCOUNT_ID ||
  (accountId !== MOSS_MANAGED_CODEX_ACCOUNT_ID &&
    settings.providers.codex.accounts.some((account) => account.id === accountId));

function isVerifiedMossManagedClaudeInstance(
  instance: ProviderInstanceConfig | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (
    isVerifiedMossManagedClaudeProviderInstance({
      instanceId: MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID,
      instance,
      env,
    })
  ) {
    return true;
  }
  // Older builds emitted the same fixed server-owned identity without the
  // current model/generation envelope. Keep recognizing it only as cleanup
  // ownership; ProviderService's strict verifier never permits it to launch.
  const config = asConfigRecord(instance?.config);
  const gatewayBaseUrl = config.gatewayBaseUrl;
  return (
    instance?.driver === "claudeAgent" &&
    instance.displayName === "Moss Claude" &&
    config.managed === true &&
    config.credentialEnvKey === "ANTHROPIC_AUTH_TOKEN" &&
    typeof gatewayBaseUrl === "string" &&
    isMossManagedAccessTokenGateway(gatewayBaseUrl, env)
  );
}

function isCleanupPendingMossManagedPair(input: {
  readonly codexInstance: ProviderInstanceConfig | undefined;
  readonly claudeInstance: ProviderInstanceConfig | undefined;
  readonly codexReservation: VerifiedMossManagedCodexReservation | undefined;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): boolean {
  if (
    !input.codexReservation ||
    input.codexReservation.provisioning ||
    input.codexInstance?.driver !== "codex" ||
    input.codexInstance.displayName !== "Moss" ||
    input.codexInstance.enabled !== false ||
    (input.codexInstance.environment?.length ?? 0) !== 0 ||
    managedCleanupStateFromConfig(input.codexInstance.config) !== MOSS_MANAGED_CLEANUP_PENDING ||
    input.claudeInstance?.driver !== "claudeAgent" ||
    input.claudeInstance.displayName !== "Moss Claude" ||
    input.claudeInstance.enabled !== true
  ) {
    return false;
  }

  const codexConfig = asConfigRecord(input.codexInstance.config);
  const claudeConfig = asConfigRecord(input.claudeInstance.config);
  const runtimeGeneration = codexConfig.runtimeGeneration;
  const codexGateway = codexConfig.gatewayBaseUrl;
  const claudeGateway = claudeConfig.gatewayBaseUrl;
  if (
    codexConfig.managed !== true ||
    codexConfig.credentialEnvKey !== MOSS_MANAGED_PROVIDER_ENV_KEY ||
    claudeConfig.managed !== true ||
    claudeConfig.credentialEnvKey !== "ANTHROPIC_AUTH_TOKEN" ||
    typeof runtimeGeneration !== "string" ||
    !runtimeGeneration.trim() ||
    claudeConfig.runtimeGeneration !== runtimeGeneration ||
    typeof codexGateway !== "string" ||
    typeof claudeGateway !== "string"
  ) {
    return false;
  }

  try {
    if (normalizeMossClaudeGatewayBaseUrl(codexGateway) !== claudeGateway) {
      return false;
    }
    const historicalOrigin = new URL(codexGateway).origin;
    const historicalEnv = {
      ...(input.env ?? process.env),
      [MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL_ENV_KEY]: codexGateway,
      [MOSS_SUPABASE_GOOGLE_MODEL_GATEWAY_URL_ENV_KEY]: codexGateway,
      // A prior local relay is intentionally no longer a configured launch
      // route. Trust its origin only inside this in-memory, cleanup-only
      // structural proof; the resulting instance is never launched.
      [MOSS_TRUSTED_MODEL_GATEWAY_ORIGINS_ENV_KEY]: [
        (input.env ?? process.env)[MOSS_TRUSTED_MODEL_GATEWAY_ORIGINS_ENV_KEY],
        historicalOrigin,
      ]
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .join(" "),
    };
    const tokenEntry = input.claudeInstance.environment?.find(
      (entry) => entry.name === "ANTHROPIC_AUTH_TOKEN",
    );
    // Settings deliberately redact the managed Claude bearer. Replace only the
    // in-memory copy with a non-secret sentinel so the canonical verifier can
    // still validate the complete model/config envelope without ever treating
    // the sentinel as a launch credential or persisting it.
    const verificationInstance: ProviderInstanceConfig =
      tokenEntry?.valueRedacted === true
        ? {
            ...input.claudeInstance,
            ...(input.claudeInstance.environment
              ? {
                  environment: input.claudeInstance.environment.map((entry) =>
                    entry.name === "ANTHROPIC_AUTH_TOKEN"
                      ? { ...entry, value: "moss-redacted-credential-proof", valueRedacted: false }
                      : entry,
                  ),
                }
              : {}),
          }
        : input.claudeInstance;
    const verified = isVerifiedMossManagedClaudeProviderInstance({
      instanceId: MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID,
      instance: verificationInstance,
      env: historicalEnv,
    });
    return verified;
  } catch {
    return false;
  }
}

/**
 * A packaged authority URL can rotate while the previous server-owned managed
 * generation is still persisted. The old URL must never remain launchable,
 * but its exact Claude companion still has to be recognized long enough to
 * fence its credential and retire the generation.
 *
 * Pairing the companion with the verified Codex reservation, exact runtime
 * generation, and exact historical gateway keeps this a cleanup-only proof;
 * a standalone reserved-id Claude record never gains ownership from its own
 * self-asserted `managed` flag.
 */
function isCleanupOwnedMossManagedClaudeInstance(input: {
  readonly instance: ProviderInstanceConfig | undefined;
  readonly codexInstance: ProviderInstanceConfig | undefined;
  readonly codexReservation: VerifiedMossManagedCodexReservation | undefined;
  readonly expectedAccessToken?: string | undefined;
  readonly expectedAccessTokenHash?: string | undefined;
  readonly allowStalePairedCredential?: boolean | undefined;
  readonly expectedGatewayBaseUrl?: string | undefined;
  readonly expectedCredentialEnvKey?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): boolean {
  const env = input.env ?? process.env;
  const credentialMatchesProof = (): boolean => {
    const tokenEntry = input.instance?.environment?.find(
      (entry) => entry.name === "ANTHROPIC_AUTH_TOKEN",
    );
    const token = tokenEntry?.valueRedacted === true ? undefined : tokenEntry?.value;
    const tokenHash =
      typeof token === "string" ? createHash("sha256").update(token).digest("hex") : undefined;
    return (
      (typeof input.expectedAccessToken === "string" &&
        input.expectedAccessToken.length > 0 &&
        token === input.expectedAccessToken) ||
      (typeof input.expectedAccessTokenHash === "string" &&
        /^[a-f0-9]{64}$/u.test(input.expectedAccessTokenHash) &&
        tokenHash === input.expectedAccessTokenHash)
    );
  };
  const hasCredentialProof =
    (typeof input.expectedAccessToken === "string" && input.expectedAccessToken.length > 0) ||
    (typeof input.expectedAccessTokenHash === "string" &&
      /^[a-f0-9]{64}$/u.test(input.expectedAccessTokenHash));
  const canRecoverStalePairedCredential = (): boolean =>
    (() => {
      const pair = isCleanupPendingMossManagedPair({
        codexInstance: input.codexInstance,
        claudeInstance: input.instance,
        codexReservation: input.codexReservation,
        env,
      });
      return (
        input.allowStalePairedCredential === true &&
        typeof input.expectedGatewayBaseUrl === "string" &&
        isMossManagedAccessTokenGateway(input.expectedGatewayBaseUrl, env) &&
        input.expectedCredentialEnvKey === MOSS_MANAGED_PROVIDER_ENV_KEY &&
        pair
      );
    })();
  if (isVerifiedMossManagedClaudeInstance(input.instance, env)) {
    if (input.instance?.enabled === false) return (input.instance.environment?.length ?? 0) === 0;
    if (!hasCredentialProof || credentialMatchesProof()) return true;
    return canRecoverStalePairedCredential();
  }
  if (!input.codexReservation || input.codexReservation.provisioning || !input.codexInstance) {
    return false;
  }

  const codexConfig = asConfigRecord(input.codexInstance.config);
  const claudeConfig = asConfigRecord(input.instance?.config);
  const codexGeneration = codexConfig.runtimeGeneration;
  const claudeGeneration = claudeConfig.runtimeGeneration;
  const codexGateway = codexConfig.gatewayBaseUrl;
  const claudeGateway = claudeConfig.gatewayBaseUrl;
  if (
    typeof codexGeneration !== "string" ||
    !codexGeneration.trim() ||
    claudeGeneration !== codexGeneration ||
    typeof codexGateway !== "string" ||
    typeof claudeGateway !== "string"
  ) {
    return false;
  }

  let historicalGateway: string;
  try {
    historicalGateway = normalizeMossGatewayBaseUrl(codexGateway);
    if (normalizeMossClaudeGatewayBaseUrl(historicalGateway) !== claudeGateway) return false;
  } catch {
    return false;
  }

  const historicalEnv = {
    ...env,
    [MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL_ENV_KEY]: historicalGateway,
    [MOSS_SUPABASE_GOOGLE_MODEL_GATEWAY_URL_ENV_KEY]: historicalGateway,
    // A previous local relay is no longer a launch route. Trust its exact
    // origin only while proving cleanup ownership of the paired historical
    // record; the resulting disabled tombstone is never launched.
    [MOSS_TRUSTED_MODEL_GATEWAY_ORIGINS_ENV_KEY]: [
      env[MOSS_TRUSTED_MODEL_GATEWAY_ORIGINS_ENV_KEY],
      new URL(historicalGateway).origin,
    ]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .join(" "),
  };
  const structurallyVerified = isVerifiedMossManagedClaudeProviderInstance({
    instanceId: MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID,
    instance: input.instance,
    env: historicalEnv,
  });
  if (!structurallyVerified) return canRecoverStalePairedCredential();
  if (input.instance?.enabled === false) return (input.instance.environment?.length ?? 0) === 0;
  return credentialMatchesProof() || canRecoverStalePairedCredential();
}

export function buildMossManagedClaudeInstance(input: {
  readonly accessToken: string;
  readonly gatewayBaseUrl: string;
  readonly runtimeGeneration: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Realm of the account; narrows the Messages lineup to what its gateway serves. */
  readonly realm?: MossAccessLane;
  /**
   * The account's database entitlement as reported by the gateway. The realm
   * lineup is narrowed to it; an empty intersection keeps the realm lineup so
   * an offline provision still yields a usable surface.
   */
  readonly accountModels?: ReadonlyArray<string>;
}): ProviderInstanceConfig {
  if (!input.accessToken.trim()) {
    throw new Error("Managed Claude requires a non-empty Moss access token.");
  }
  if (!input.runtimeGeneration.trim()) {
    throw new Error("Managed Claude requires a runtime generation.");
  }
  if (!isMossManagedAccessTokenGateway(input.gatewayBaseUrl, input.env)) {
    throw new Error("Managed Claude must authenticate through the trusted Moss Edge gateway.");
  }
  const gatewayBaseUrl = normalizeMossClaudeGatewayBaseUrl(input.gatewayBaseUrl);
  const realmClaudeModels = input.realm
    ? mossManagedClaudeModelsForLane(input.realm)
    : MOSS_MANAGED_CLAUDE_MODELS;
  const entitled = new Set(input.accountModels ?? []);
  const entitledClaudeModels = realmClaudeModels.filter((model) => entitled.has(model));
  const claudeModels = entitledClaudeModels.length > 0 ? entitledClaudeModels : realmClaudeModels;
  const claudeDefaultModel = claudeModels[0] ?? MOSS_MANAGED_CLAUDE_DEFAULT_MODEL;
  return {
    driver: "claudeAgent",
    displayName: "Moss Claude",
    enabled: true,
    environment: [
      { name: "ANTHROPIC_BASE_URL", value: gatewayBaseUrl, sensitive: false },
      { name: "ANTHROPIC_AUTH_TOKEN", value: input.accessToken, sensitive: true },
      // The trusted Moss gateway is preflighted for Anthropic's deferred-tool
      // beta. Without this explicit opt-in Claude Code inlines every Moss MCP
      // schema for a custom base URL, consuming roughly half the context and
      // making even tiny child turns vulnerable to the edge read timeout.
      {
        name: MOSS_MANAGED_CLAUDE_TOOL_SEARCH_ENV_KEY,
        value: MOSS_MANAGED_CLAUDE_TOOL_SEARCH_ENV_VALUE,
        sensitive: false,
      },
    ],
    config: {
      customModels: [...claudeModels],
      modelAllowlist: [...claudeModels],
      defaultModel: claudeDefaultModel,
      managed: true,
      gatewayBaseUrl,
      credentialEnvKey: "ANTHROPIC_AUTH_TOKEN",
      runtimeGeneration: input.runtimeGeneration,
    },
  };
}

function isVerifiedMossManagedOpenCodeInstance(
  instance: ProviderInstanceConfig | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return isVerifiedMossManagedOpenCodeProviderInstance({
    instanceId: MOSS_MANAGED_OPENCODE_PROVIDER_INSTANCE_ID,
    instance,
    env,
    allowDisabled: true,
  });
}

// Recovery ownership is deliberately separate from launch validation. Older
// realm handoffs could persist an enabled flag after clearing the credential;
// only the matching, verified Codex cleanup transaction may adopt that record.
function isCleanupOwnedMossManagedOpenCodeInstance(
  settings: ServerSettings,
  managedHomePath: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const instance = settings.providerInstances[MOSS_MANAGED_OPENCODE_PROVIDER_INSTANCE_ID];
  if (isVerifiedMossManagedOpenCodeInstance(instance, env)) return true;
  const reservation = verifiedMossManagedCodexReservation(settings, managedHomePath);
  const codex = settings.providerInstances[MOSS_MANAGED_PROVIDER_INSTANCE_ID];
  const config = asConfigRecord(instance?.config);
  const codexConfig = asConfigRecord(codex?.config);
  if (
    !instance ||
    instance.enabled !== true ||
    (instance.environment?.length ?? 0) !== 0 ||
    !reservation ||
    reservation.provisioning ||
    codex?.enabled !== false ||
    config.managedCleanupState !== MOSS_MANAGED_CLEANUP_PENDING ||
    codexConfig.managedCleanupState !== MOSS_MANAGED_CLEANUP_PENDING ||
    config.runtimeGeneration !== codexConfig.runtimeGeneration ||
    typeof config.gatewayBaseUrl !== "string" ||
    typeof codexConfig.gatewayBaseUrl !== "string"
  )
    return false;
  try {
    return (
      normalizeMossGatewayBaseUrl(config.gatewayBaseUrl) ===
        normalizeMossGatewayBaseUrl(codexConfig.gatewayBaseUrl) &&
      isVerifiedMossManagedOpenCodeInstance({ ...instance, enabled: false }, env)
    );
  } catch {
    return false;
  }
}

function isVerifiedMossManagedPiInstance(
  instance: ProviderInstanceConfig | undefined,
  managedHomePath: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const config = asConfigRecord(instance?.config);
  return (
    config.agentDir ===
      nodePath.join(
        nodePath.dirname(managedHomePath),
        "provider-homes",
        "pi",
        String(config.realm),
      ) &&
    isVerifiedMossManagedPiProviderInstance({
      instanceId: MOSS_MANAGED_PI_PROVIDER_INSTANCE_ID,
      instance,
      env,
      allowDisabled: true,
    })
  );
}

function inspectMossManagedReservationCollisions(
  settings: ServerSettings,
  managedHomePath: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  expectedAccessToken?: string,
  expectedAccessTokenHash?: string,
  allowStalePairedCredential = false,
  expectedGatewayBaseUrl?: string,
  expectedCredentialEnvKey?: string,
  companionCleanupEnv: Readonly<Record<string, string | undefined>> = env,
): MossManagedReservationCollisionState {
  const instance = settings.providerInstances[MOSS_MANAGED_PROVIDER_INSTANCE_ID];
  const account = settings.providers.codex.accounts.find(
    (candidate) => candidate.id === MOSS_MANAGED_CODEX_ACCOUNT_ID,
  );
  const hasVerifiedCodexReservation =
    verifiedMossManagedCodexReservation(settings, managedHomePath) !== undefined;
  const selectsReservedAccount =
    settings.providers.codex.selectedAccountId === MOSS_MANAGED_CODEX_ACCOUNT_ID;
  const selectsReservedInstance =
    settings.textGenerationModelSelection.instanceId === MOSS_MANAGED_PROVIDER_INSTANCE_ID;
  const hasCodexReservation =
    instance !== undefined ||
    account !== undefined ||
    selectsReservedAccount ||
    selectsReservedInstance;
  const claudeInstance = settings.providerInstances[MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID];
  const isManagedClaudeInstance = isCleanupOwnedMossManagedClaudeInstance({
    instance: claudeInstance,
    codexInstance: instance,
    codexReservation: hasVerifiedCodexReservation
      ? verifiedMossManagedCodexReservation(settings, managedHomePath)
      : undefined,
    expectedAccessToken,
    expectedAccessTokenHash,
    allowStalePairedCredential,
    expectedGatewayBaseUrl,
    expectedCredentialEnvKey,
    env,
  });
  const opencodeInstance = settings.providerInstances[MOSS_MANAGED_OPENCODE_PROVIDER_INSTANCE_ID];
  const isManagedOpenCodeInstance = isCleanupOwnedMossManagedOpenCodeInstance(
    settings,
    managedHomePath,
    companionCleanupEnv,
  );
  const piInstance = settings.providerInstances[MOSS_MANAGED_PI_PROVIDER_INSTANCE_ID];
  const hasReservedSurfaceCollision =
    (hasCodexReservation && !hasVerifiedCodexReservation) ||
    (claudeInstance !== undefined && !isManagedClaudeInstance) ||
    (opencodeInstance !== undefined && !isManagedOpenCodeInstance) ||
    (piInstance !== undefined &&
      !isVerifiedMossManagedPiInstance(piInstance, managedHomePath, companionCleanupEnv)) ||
    inspectMossManagedRelayInstances(
      settings.providerInstances,
      nodePath.dirname(managedHomePath),
      companionCleanupEnv,
    ).hasCollision;

  const otherAccounts = settings.providers.codex.accounts.filter(
    (candidate) => candidate.id !== MOSS_MANAGED_CODEX_ACCOUNT_ID,
  );
  const implicitEnvironmentEntries = Object.entries(env);
  const hasImplicitCodexHome = implicitEnvironmentEntries.some(
    ([name, value]) =>
      protectedCodexEnvironmentKey(name) === "CODEX_HOME" &&
      typeof value === "string" &&
      value.trim().length > 0,
  );
  const otherInstances = Object.entries(settings.providerInstances).filter(
    ([instanceId, candidate]) => {
      if (instanceId === MOSS_MANAGED_PROVIDER_INSTANCE_ID) return false;
      const config = asConfigRecord(candidate.config);
      const homePath = typeof config.homePath === "string" ? config.homePath : undefined;
      const shadowHomePath =
        typeof config.shadowHomePath === "string" ? config.shadowHomePath : undefined;
      const hasProtectedCodexEnvironment =
        candidate.driver === "codex" &&
        (candidate.environment ?? []).some(
          (entry) => protectedCodexEnvironmentKey(entry.name) !== undefined,
        );
      return Boolean(homePath?.trim() || shadowHomePath?.trim() || hasProtectedCodexEnvironment);
    },
  );
  if (otherAccounts.length === 0 && otherInstances.length === 0 && !hasImplicitCodexHome) {
    return { hasReservedSurfaceCollision, hasLifecycleHomeCollision: false };
  }

  try {
    const implicitCodexEnvironment = normalizeProtectedCodexEnvironmentKeys(
      implicitEnvironmentEntries,
    );
    if (hasImplicitCodexHome && implicitCodexEnvironment.ambiguousKeys.size > 0) {
      return { hasReservedSurfaceCollision, hasLifecycleHomeCollision: true };
    }
    if (otherAccounts.length === 0 && otherInstances.length === 0) {
      // A process-level CODEX_HOME has no account id, so its lifecycle is the
      // explicit source plus the generic Moss overlay root. Comparing it to
      // the fixed managed source is sufficient here. Expanding the managed
      // account overlay would otherwise fail closed whenever its empty
      // accounts directory has no entry with which to probe filesystem case
      // sensitivity, turning an unrelated ambient CODEX_HOME into a false
      // collision during production startup.
      const managedSourceIdentity = canonicalizeCodexHomeIdentityPath(managedHomePath);
      const implicitIdentities = uniqueCodexLifecycleHomeIdentityPaths({
        environment: implicitCodexEnvironment.environment,
      });
      return {
        hasReservedSurfaceCollision,
        hasLifecycleHomeCollision: implicitIdentities.includes(managedSourceIdentity),
      };
    }
    let hasUnsafeProtectedInstanceEnvironment = false;
    const otherInstanceInputs = otherInstances.map(([, candidate]) => {
      const config = asConfigRecord(candidate.config);
      const homePath = typeof config.homePath === "string" ? config.homePath : undefined;
      const shadowHomePath =
        typeof config.shadowHomePath === "string" ? config.shadowHomePath : undefined;
      const environmentEntries = (candidate.environment ?? []).flatMap((entry) =>
        entry.valueRedacted === true ? [] : ([[entry.name, entry.value]] as const),
      );
      const normalizedEnvironment = normalizeProtectedCodexEnvironmentKeys(environmentEntries);
      const hasUnknownProtectedValue = (candidate.environment ?? []).some(
        (entry) =>
          entry.valueRedacted === true && protectedCodexEnvironmentKey(entry.name) !== undefined,
      );
      if (
        candidate.driver === "codex" &&
        (hasUnknownProtectedValue || normalizedEnvironment.ambiguousKeys.size > 0)
      ) {
        hasUnsafeProtectedInstanceEnvironment = true;
      }
      const accountId = typeof config.accountId === "string" ? config.accountId : undefined;
      return {
        ...(homePath ? { homePath } : {}),
        ...(shadowHomePath ? { shadowHomePath } : {}),
        ...(accountId ? { accountId } : {}),
        ...(candidate.driver === "codex" ? { environment: normalizedEnvironment.environment } : {}),
      };
    });
    if (hasUnsafeProtectedInstanceEnvironment) {
      return { hasReservedSurfaceCollision, hasLifecycleHomeCollision: true };
    }
    const managedIdentities = new Set(
      uniqueCodexLifecycleHomeIdentityPaths({
        homePath: managedHomePath,
        accountId: MOSS_MANAGED_CODEX_ACCOUNT_ID,
      }),
    );
    const overlapsManagedHome = (identities: readonly string[]) =>
      identities.some((identity) => managedIdentities.has(identity));
    const otherAccountUsesManagedHome = otherAccounts.some((candidate) =>
      overlapsManagedHome(
        uniqueCodexLifecycleHomeIdentityPaths({
          homePath: candidate.homePath,
          ...(candidate.shadowHomePath ? { shadowHomePath: candidate.shadowHomePath } : {}),
          accountId: candidate.id,
        }),
      ),
    );
    const otherInstanceUsesManagedHome = otherInstanceInputs.some((candidate) =>
      overlapsManagedHome(uniqueCodexLifecycleHomeIdentityPaths(candidate)),
    );
    const implicitCodexHomeUsesManagedHome =
      hasImplicitCodexHome &&
      overlapsManagedHome(
        uniqueCodexLifecycleHomeIdentityPaths({
          environment: implicitCodexEnvironment.environment,
        }),
      );
    return {
      hasReservedSurfaceCollision,
      hasLifecycleHomeCollision:
        otherAccountUsesManagedHome ||
        otherInstanceUsesManagedHome ||
        implicitCodexHomeUsesManagedHome,
    };
  } catch {
    // Teardown uses these same canonical lifecycle identities. If an alias,
    // permission failure, or filesystem race cannot be reduced safely, treat
    // the foreign surface as colliding rather than risk a home-wide stop.
    return { hasReservedSurfaceCollision, hasLifecycleHomeCollision: true };
  }
}

export function hasMossManagedReservationCollision(
  settings: ServerSettings,
  managedHomePath: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const collisions = inspectMossManagedReservationCollisions(settings, managedHomePath, env);
  return collisions.hasReservedSurfaceCollision || collisions.hasLifecycleHomeCollision;
}

function quoteTomlString(value: string): string {
  return JSON.stringify(value);
}

export function normalizeMossGatewayBaseUrl(value: string): string {
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

export function normalizeMossClaudeGatewayBaseUrl(value: string): string {
  const url = new URL(normalizeMossGatewayBaseUrl(value));
  url.pathname = url.pathname.replace(/\/v1$/, "") || "/";
  return url.toString().replace(/\/+$/, "");
}

export function isMossManagedAccessTokenGateway(
  value: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  try {
    return isTrustedMossManagedGatewayUrl(normalizeMossGatewayBaseUrl(value), env);
  } catch {
    return false;
  }
}

export function resolveMossManagedGatewayCredential(input: {
  readonly authority: MossManagedGatewayAuthority;
  readonly gatewayBaseUrl: string;
  readonly processGatewayApiKey: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): {
  readonly gatewayBaseUrl: string;
  readonly credentialEnvKey: string;
  readonly useProcessGatewayApiKey: boolean;
} {
  const gatewayBaseUrl = resolveManagedModelBaseUrlForAuthority({
    authority: input.authority,
    configuredGatewayUrl: input.gatewayBaseUrl,
  });
  const isAuthorityBoundGateway = isTrustedMossManagedGatewayUrlForAuthority(
    gatewayBaseUrl,
    input.authority,
    input.env ?? process.env,
  );
  if (isAuthorityBoundGateway) {
    return {
      gatewayBaseUrl,
      credentialEnvKey: MOSS_MANAGED_PROVIDER_ENV_KEY,
      useProcessGatewayApiKey: false,
    };
  }

  if (input.processGatewayApiKey?.trim()) {
    return {
      gatewayBaseUrl,
      credentialEnvKey: MOSS_MANAGED_GATEWAY_API_KEY_ENV_KEY,
      useProcessGatewayApiKey: true,
    };
  }

  throw new Error(
    `${MOSS_MANAGED_GATEWAY_API_KEY_ENV_KEY} is required for a direct model relay endpoint.`,
  );
}

export function buildMossManagedProviderEnvironment(input: {
  readonly accessToken: string;
  readonly gatewayBaseUrl: string;
  readonly useProcessGatewayApiKey?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): NonNullable<ProviderInstanceConfig["environment"]> {
  if (
    !input.useProcessGatewayApiKey &&
    !isMossManagedAccessTokenGateway(input.gatewayBaseUrl, input.env)
  ) {
    throw new Error("The Moss access token requires the trusted Moss Edge gateway.");
  }
  const environment: NonNullable<ProviderInstanceConfig["environment"]> =
    input.useProcessGatewayApiKey
      ? []
      : [
          {
            name: MOSS_MANAGED_PROVIDER_ENV_KEY,
            value: input.accessToken,
            sensitive: true,
          },
        ];
  if (new URL(input.gatewayBaseUrl).hostname !== "127.0.0.1") return environment;
  return [
    ...environment,
    { name: "NO_PROXY", value: MOSS_MANAGED_LOOPBACK_NO_PROXY, sensitive: false },
    { name: "no_proxy", value: MOSS_MANAGED_LOOPBACK_NO_PROXY, sensitive: false },
  ];
}

export function buildMossManagedCodexConfig(input: {
  readonly gatewayBaseUrl: string;
  readonly defaultModel: string;
  readonly credentialEnvKey?: string;
  readonly bundledPluginMarketplaceRoot?: string;
  /** Absolute path of the managed `models.json`; omitted only by legacy callers. */
  readonly modelCatalogPath?: string;
}): string {
  const baseUrl = normalizeMossGatewayBaseUrl(input.gatewayBaseUrl);
  const credentialEnvKey = input.credentialEnvKey ?? MOSS_MANAGED_PROVIDER_ENV_KEY;
  return [
    `model = ${quoteTomlString(input.defaultModel)}`,
    'model_provider = "moss"',
    'cli_auth_credentials_store = "file"',
    ...(input.modelCatalogPath
      ? [`model_catalog_json = ${quoteTomlString(input.modelCatalogPath)}`]
      : []),
    "",
    "[shell_environment_policy]",
    "ignore_default_excludes = false",
    "",
    "[features]",
    "shell_snapshot = false",
    // Custom Moss model providers do not use ChatGPT's remote plugin catalog.
    // Keeping the catalog enabled adds an unrelated authenticated request at
    // startup; catalog failures can race the first Responses stream even
    // though local plugins and Moss MCP are healthy.
    "remote_plugin = false",
    // Skills remain loadable/injected as designed. Large CN Responses bodies
    // (skills + Moss MCP dynamic tools) are shaped elsewhere (deferred tools +
    // gateway request sanitization); do not disable skills as a hang workaround.
    ...(input.bundledPluginMarketplaceRoot
      ? [
          "",
          `[marketplaces.${MOSS_BUNDLED_PLUGIN_MARKETPLACE_NAME}]`,
          'source_type = "local"',
          `source = ${quoteTomlString(input.bundledPluginMarketplaceRoot)}`,
        ]
      : []),
    "",
    "[model_providers.moss]",
    'name = "Moss"',
    `base_url = ${quoteTomlString(baseUrl)}`,
    `env_key = ${quoteTomlString(credentialEnvKey)}`,
    'wire_api = "responses"',
    // The hosted gateway owns bounded transport retries and durable accounting.
    // A Codex stream reconnect may rebuild its request from partially accepted
    // history, so retrying inside the child could create a second paid operation.
    "request_max_retries = 0",
    "stream_max_retries = 0",
    // Bound silent upstream stalls so Codex surfaces a stream error instead of
    // waiting for the Cloudflare/edge ~120s cut. Keep this above typical CN
    // DeepSeek TTFT (~15-25s) but under MemFire/CF hang windows.
    "stream_idle_timeout_ms = 60000",
    "requires_openai_auth = false",
    "",
  ].join("\n");
}

function normalizeModels(
  models: ReadonlyArray<string> | undefined,
  fallbackModel: string = MOSS_MANAGED_DEFAULT_MODEL,
): ReadonlyArray<string> {
  const normalized = [...new Set((models ?? [fallbackModel]).map((model) => model.trim()))].filter(
    Boolean,
  );
  return normalized.length > 0 ? normalized : [fallbackModel];
}

function filterAllowedModels(
  models: ReadonlyArray<string> | undefined,
  allowed: ReadonlySet<string>,
): ReadonlyArray<string> {
  return (models ?? [])
    .map((model) => model.trim())
    .filter((model) => model.length > 0 && allowed.has(model));
}

function readConfiguredModelList(value: unknown): ReadonlyArray<string> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((model): model is string => typeof model === "string")
    .map((model) => model.trim())
    .filter((model) => model.length > 0);
}

export function resolveMossManagedModels(input: {
  readonly accountModels: ReadonlyArray<string> | undefined;
  readonly processGatewayModel: string | undefined;
  /** Realm of the signed-in account; without it the cross-realm union applies. */
  readonly realm?: MossAccessLane;
}): ReadonlyArray<string> {
  const processGatewayModel = input.processGatewayModel?.trim();
  // Without a realm the cross-realm union applies, default first.
  const realmModels = input.realm
    ? mossManagedCodexModelsForLane(input.realm)
    : [
        MOSS_MANAGED_DEFAULT_MODEL,
        ...MOSS_MANAGED_CODEX_MODELS.filter((model) => model !== MOSS_MANAGED_DEFAULT_MODEL),
      ];
  const realmDefault = realmModels[0] ?? MOSS_MANAGED_DEFAULT_MODEL;
  const allowed = new Set(realmModels);
  const requestedAccountModels = input.accountModels ?? [];
  const accountModels = filterAllowedModels(requestedAccountModels, allowed);
  const entitledModels = accountModels.length > 0 ? accountModels : realmModels;
  // A persisted selection the realm no longer serves (a Global-only model after
  // switching to a phone account) falls back to the realm default. The
  // APIMart-era Luna pin is always migrated off: Luna stays selectable where
  // the realm serves it, but a stale automatic selection never restores it.
  const quarantinedSelectionRequested =
    processGatewayModel === MOSS_MANAGED_QUARANTINED_CODEX_MODEL;
  const effectiveEntitledModels =
    quarantinedSelectionRequested || !entitledModels.includes(realmDefault)
      ? [realmDefault, ...entitledModels.filter((model) => model !== realmDefault)]
      : entitledModels;
  const selectedModel =
    processGatewayModel &&
    !quarantinedSelectionRequested &&
    effectiveEntitledModels.includes(processGatewayModel)
      ? processGatewayModel
      : realmDefault;
  return normalizeModels([selectedModel, ...effectiveEntitledModels], realmDefault);
}

export function resolveMossManagedClaudeModels(
  processGatewayModel: string | undefined,
  realm?: MossAccessLane,
): ReadonlyArray<string> {
  const model = processGatewayModel?.trim();
  const realmModels = realm ? mossManagedClaudeModelsForLane(realm) : MOSS_MANAGED_CLAUDE_MODELS;
  const realmDefault = realmModels[0] ?? MOSS_MANAGED_CLAUDE_DEFAULT_MODEL;
  const allowed = new Set(realmModels);
  const selectedModel = model && allowed.has(model) ? model : realmDefault;
  return normalizeModels([selectedModel, ...realmModels], realmDefault);
}

const toProviderError = (cause: unknown) =>
  new MossCloudAccountServiceError({
    code: "persistence_failed",
    message: "Failed to configure the managed Moss model provider.",
    cause,
  });

const isCodexLifecycleIdentityResolutionFailure = (cause: unknown): boolean =>
  cause instanceof ProviderValidationError &&
  cause.operation === "ProviderService.stopCodexAccountRuntimes" &&
  cause.issue === "Failed to resolve Codex account lifecycle identities.";

export const stopMossManagedProviderRuntimes = (
  providerService: Pick<
    ProviderServiceShape,
    "fenceProviderInstanceLaunchesAndWait" | "listSessions"
  >,
) =>
  Effect.gen(function* () {
    const fenceProviderInstanceLaunchesAndWait =
      providerService.fenceProviderInstanceLaunchesAndWait;
    if (!fenceProviderInstanceLaunchesAndWait) {
      return yield* Effect.fail(
        new Error(
          "Managed Claude runtime cleanup cannot drain in-flight provider launches; refusing to remove credentials.",
        ),
      );
    }
    // The caller has already persisted the disabled, credential-free
    // tombstone. Fence and drain every launch that resolved the old instance
    // before taking the final live-session snapshot.
    yield* fenceProviderInstanceLaunchesAndWait({
      providerInstanceId: MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID,
    });
    const sessions = yield* providerService.listSessions();
    const hasManagedClaudeRuntime = sessions.some(
      (session) =>
        session.provider === "claudeAgent" &&
        session.providerInstanceId === MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID,
    );
    if (hasManagedClaudeRuntime) {
      return yield* Effect.fail(
        new Error(
          "Managed Claude runtime cleanup has no exact-session stop; stop the active Moss Claude session and retry.",
        ),
      );
    }
  });

const stopMossManagedCompanionRuntimes = (
  providerService: Pick<
    ProviderServiceShape,
    "fenceProviderInstanceLaunchesAndWait" | "listSessions" | "stopRuntimeSession"
  >,
  provider: "opencode" | "pi" | MossManagedRelayDriver,
  providerInstanceId: string,
) =>
  Effect.gen(function* () {
    const fenceProviderInstanceLaunchesAndWait =
      providerService.fenceProviderInstanceLaunchesAndWait;
    if (!fenceProviderInstanceLaunchesAndWait) {
      return yield* Effect.fail(
        new Error(
          "Managed companion cleanup cannot drain in-flight provider launches; refusing to remove credentials.",
        ),
      );
    }
    yield* fenceProviderInstanceLaunchesAndWait({
      providerInstanceId: providerInstanceId,
    });
    const managedSessions = (yield* providerService.listSessions()).filter(
      (session) =>
        session.provider === provider && session.providerInstanceId === providerInstanceId,
    );
    if (managedSessions.length === 0) return;
    if (managedSessions.length > 0 && !providerService.stopRuntimeSession) {
      return yield* Effect.fail(
        new Error(
          "Managed companion runtime cleanup has no exact-session stop; refusing to remove credentials.",
        ),
      );
    }
    if (providerService.stopRuntimeSession) {
      yield* Effect.forEach(
        managedSessions,
        (session) => providerService.stopRuntimeSession!({ threadId: session.threadId }),
        { discard: true },
      );
    }
    const remaining = (yield* providerService.listSessions()).some(
      (session) =>
        session.provider === provider && session.providerInstanceId === providerInstanceId,
    );
    if (remaining) {
      return yield* Effect.fail(
        new Error("Managed companion runtime remained live after its exact-instance stop."),
      );
    }
  }).pipe(Effect.asVoid);

export const stopMossManagedOpenCodeProviderRuntimes = (
  providerService: Parameters<typeof stopMossManagedCompanionRuntimes>[0],
) =>
  stopMossManagedCompanionRuntimes(
    providerService,
    "opencode",
    MOSS_MANAGED_OPENCODE_PROVIDER_INSTANCE_ID,
  );
export const stopMossManagedPiProviderRuntimes = (
  providerService: Parameters<typeof stopMossManagedCompanionRuntimes>[0],
) => stopMossManagedCompanionRuntimes(providerService, "pi", MOSS_MANAGED_PI_PROVIDER_INSTANCE_ID);

export const runMossManagedDisableSteps = (input: {
  readonly disableProviderSettings: () => Effect.Effect<void, MossCloudAccountServiceError>;
  readonly stopRuntimes: () => Effect.Effect<void, MossCloudAccountServiceError>;
  readonly removeAccountOverlay: () => Effect.Effect<void, MossCloudAccountServiceError>;
  readonly durableFenceAlreadyPresent?: boolean;
}) =>
  Effect.gen(function* () {
    const failures: MossCloudAccountServiceError[] = [];
    let settingsDisabled = input.durableFenceAlreadyPresent === true;
    let runtimesStopped = false;
    yield* input.disableProviderSettings().pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          settingsDisabled = true;
        }),
      ),
      Effect.catch((error) =>
        Effect.sync(() => {
          failures.push(error);
        }),
      ),
    );
    if (settingsDisabled) {
      yield* input.stopRuntimes().pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            runtimesStopped = true;
          }),
        ),
        Effect.catch((error) =>
          Effect.sync(() => {
            failures.push(error);
          }),
        ),
      );
    }
    if (settingsDisabled && runtimesStopped) {
      yield* input.removeAccountOverlay().pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            failures.push(error);
          }),
        ),
      );
    }
    const failure = failures[0];
    if (failure) return yield* Effect.fail(failure);
  }).pipe(Effect.asVoid);

export function buildMossManagedSettingsPatch(input: {
  readonly settings: ServerSettings;
  readonly managedHomePath: string;
  readonly instance?: ProviderInstanceConfig | undefined;
  readonly claudeInstance?: ProviderInstanceConfig | undefined;
  readonly enableManagedClaudeInstance?: boolean | undefined;
  readonly opencodeInstance?: ProviderInstanceConfig | undefined;
  readonly piInstance?: ProviderInstanceConfig | undefined;
  /** Only verified, server-owned relay records may be replaced or removed. */
  readonly relayInstances?: ProviderInstanceConfigMap | undefined;
  readonly removeManagedRelayInstanceIds?: ReadonlyArray<string> | undefined;
  readonly removeManagedClaudeInstance?: boolean | undefined;
  /** Remove only the verified, server-owned legacy OpenCode surface. */
  readonly removeManagedOpenCodeInstance?: boolean | undefined;
  readonly removeManagedPiInstance?: boolean | undefined;
  /** Restore only a still-present cleanup fallback marker, then consume it. */
  readonly restoreManagedSelectionFromCleanup?: boolean | undefined;
  readonly selectionPolicy: MossManagedSettingsSelectionPolicy;
}): ServerSettingsPatch {
  const relayInstances =
    input.relayInstances === undefined
      ? undefined
      : mapMossManagedRelayInstances(input.relayInstances, (instance) => instance);
  const removeRelayIds = (input.removeManagedRelayInstanceIds ?? []).filter(
    isMossManagedRelayInstanceId,
  );
  const currentSelectedAccountId = input.settings.providers.codex.selectedAccountId;
  const storedPreviousAccountId = storedPreviousSelectedAccountId(input.settings);
  const managedSelectionFallback = managedSelectionFallbackFromSettings(input.settings);
  const previousSelectedAccountId =
    input.selectionPolicy === "select" &&
    isAvailableCodexAccountId(input.settings, currentSelectedAccountId)
      ? currentSelectedAccountId
      : storedPreviousAccountId;
  const accounts = [
    ...input.settings.providers.codex.accounts.filter(
      (account) => account.id !== MOSS_MANAGED_CODEX_ACCOUNT_ID,
    ),
    {
      id: MOSS_MANAGED_CODEX_ACCOUNT_ID,
      label: "Moss",
      homePath: input.managedHomePath,
      shadowHomePath: "",
    },
  ];
  const configuredManagedDefaultModel = asConfigRecord(input.instance?.config).defaultModel;
  const managedDefaultModel =
    typeof configuredManagedDefaultModel === "string"
      ? (MOSS_MANAGED_CODEX_MODELS.find(
          (model) => model === configuredManagedDefaultModel.trim(),
        ) ?? MOSS_MANAGED_DEFAULT_MODEL)
      : MOSS_MANAGED_DEFAULT_MODEL;
  const currentTextGenerationSelection = input.settings.textGenerationModelSelection;
  const managedCodexSelectionNeedsMigration =
    currentTextGenerationSelection.instanceId === MOSS_MANAGED_PROVIDER_INSTANCE_ID &&
    !MOSS_MANAGED_CODEX_MODELS.includes(currentTextGenerationSelection.model.trim());
  const restoresAccountSelection =
    input.restoreManagedSelectionFromCleanup === true &&
    managedSelectionFallback?.accountFallback === true;
  const restoresTextGenerationSelection =
    input.restoreManagedSelectionFromCleanup === true &&
    managedSelectionFallback?.textGenerationFallback === true;
  const selectedAccountId =
    restoresAccountSelection || input.selectionPolicy === "select"
      ? MOSS_MANAGED_CODEX_ACCOUNT_ID
      : input.selectionPolicy === "fallback-if-selected" &&
          currentSelectedAccountId === MOSS_MANAGED_CODEX_ACCOUNT_ID
        ? previousSelectedAccountId &&
          isAvailableCodexAccountId(input.settings, previousSelectedAccountId)
          ? previousSelectedAccountId
          : DEFAULT_CODEX_ACCOUNT_ID
        : currentSelectedAccountId;
  const textGenerationModelSelection =
    restoresTextGenerationSelection || input.selectionPolicy === "select"
      ? {
          provider: "codex" as const,
          instanceId: MOSS_MANAGED_PROVIDER_INSTANCE_ID,
          model: managedDefaultModel,
        }
      : input.selectionPolicy === "preserve" && managedCodexSelectionNeedsMigration
        ? {
            provider: "codex" as const,
            instanceId: MOSS_MANAGED_PROVIDER_INSTANCE_ID,
            model: MOSS_MANAGED_DEFAULT_MODEL,
          }
        : input.selectionPolicy === "fallback-if-selected" &&
            (input.settings.textGenerationModelSelection.instanceId ===
              MOSS_MANAGED_PROVIDER_INSTANCE_ID ||
              input.settings.textGenerationModelSelection.instanceId ===
                MOSS_MANAGED_OPENCODE_PROVIDER_INSTANCE_ID ||
              input.settings.textGenerationModelSelection.instanceId ===
                MOSS_MANAGED_PI_PROVIDER_INSTANCE_ID ||
              isMossManagedRelayInstanceId(input.settings.textGenerationModelSelection.instanceId))
          ? {
              provider: "codex" as const,
              instanceId: "codex",
              model: DEFAULT_GIT_TEXT_GENERATION_MODEL,
            }
          : undefined;
  const instanceConfig = asConfigRecord(input.instance?.config);
  const { binaryPath: _legacyBundledCodexPath, ...portableInstanceConfig } = instanceConfig;
  const isManagedCodexInstance =
    input.instance?.driver === "codex" && instanceConfig.managed === true;
  const configuredModelList =
    readConfiguredModelList(instanceConfig.modelAllowlist) ??
    readConfiguredModelList(instanceConfig.customModels);
  const normalizedManagedModelList = isManagedCodexInstance
    ? (() => {
        const filtered = filterAllowedModels(
          configuredModelList,
          new Set(MOSS_MANAGED_CODEX_MODELS),
        );
        const entitled = filtered.length > 0 ? filtered : [...MOSS_MANAGED_CODEX_MODELS];
        return [managedDefaultModel, ...entitled.filter((model) => model !== managedDefaultModel)];
      })()
    : undefined;
  const managedInstanceConfig = isManagedCodexInstance
    ? {
        ...portableInstanceConfig,
        customModels: [...(normalizedManagedModelList ?? MOSS_MANAGED_CODEX_MODELS)],
        modelAllowlist: [...(normalizedManagedModelList ?? MOSS_MANAGED_CODEX_MODELS)],
        defaultModel: managedDefaultModel,
      }
    : portableInstanceConfig;
  const {
    [MOSS_MANAGED_SELECTION_FALLBACK_CONFIG_KEY]: _managedSelectionFallback,
    ...managedInstanceConfigWithoutSelectionFallback
  } = managedInstanceConfig;
  const existingSelectionFallback =
    managedSelectionFallbackFromConfig(instanceConfig) ?? managedSelectionFallback;
  const accountFallbackApplied =
    input.selectionPolicy === "fallback-if-selected" &&
    currentSelectedAccountId === MOSS_MANAGED_CODEX_ACCOUNT_ID;
  const textGenerationFallbackApplied =
    input.selectionPolicy === "fallback-if-selected" &&
    (input.settings.textGenerationModelSelection.instanceId === MOSS_MANAGED_PROVIDER_INSTANCE_ID ||
      input.settings.textGenerationModelSelection.instanceId ===
        MOSS_MANAGED_OPENCODE_PROVIDER_INSTANCE_ID ||
      input.settings.textGenerationModelSelection.instanceId ===
        MOSS_MANAGED_PI_PROVIDER_INSTANCE_ID ||
      isMossManagedRelayInstanceId(input.settings.textGenerationModelSelection.instanceId));
  const selectionFallbackToPersist =
    accountFallbackApplied || textGenerationFallbackApplied
      ? {
          version: 1 as const,
          ...(existingSelectionFallback?.accountFallback || accountFallbackApplied
            ? { accountFallback: true as const }
            : {}),
          ...(existingSelectionFallback?.textGenerationFallback || textGenerationFallbackApplied
            ? { textGenerationFallback: true as const }
            : {}),
        }
      : input.selectionPolicy === "select" ||
          (input.restoreManagedSelectionFromCleanup === true &&
            managedSelectionFallback !== undefined)
        ? undefined
        : existingSelectionFallback;
  const {
    [MOSS_MANAGED_SELECTION_FALLBACK_CONFIG_KEY]: _selectionFallback,
    ...portableInstanceConfigWithoutSelectionFallback
  } = portableInstanceConfig;
  const instanceConfigWithSelectionFallback = selectionFallbackToPersist
    ? {
        ...(isManagedCodexInstance
          ? managedInstanceConfigWithoutSelectionFallback
          : portableInstanceConfigWithoutSelectionFallback),
        [MOSS_MANAGED_SELECTION_FALLBACK_CONFIG_KEY]: selectionFallbackToPersist,
      }
    : input.selectionPolicy === "select" ||
        (input.restoreManagedSelectionFromCleanup === true &&
          managedSelectionFallback !== undefined)
      ? isManagedCodexInstance
        ? managedInstanceConfigWithoutSelectionFallback
        : portableInstanceConfigWithoutSelectionFallback
      : isManagedCodexInstance
        ? managedInstanceConfig
        : portableInstanceConfig;
  const instance = input.instance
    ? {
        ...input.instance,
        config: {
          ...instanceConfigWithSelectionFallback,
          ...(previousSelectedAccountId ? { previousSelectedAccountId } : {}),
        },
      }
    : undefined;
  const claudeInstance = input.claudeInstance
    ? input.enableManagedClaudeInstance
      ? input.claudeInstance
      : { ...input.claudeInstance, enabled: false, environment: [] }
    : undefined;
  const providerInstances =
    input.removeManagedClaudeInstance ||
    input.removeManagedOpenCodeInstance ||
    input.removeManagedPiInstance ||
    removeRelayIds.length > 0
      ? (Object.fromEntries(
          Object.entries(input.settings.providerInstances).filter(
            ([instanceId]) =>
              !removeRelayIds.includes(instanceId) &&
              (input.removeManagedClaudeInstance
                ? instanceId !== MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID
                : true) &&
              (input.removeManagedOpenCodeInstance
                ? instanceId !== MOSS_MANAGED_OPENCODE_PROVIDER_INSTANCE_ID
                : true) &&
              (input.removeManagedPiInstance
                ? instanceId !== MOSS_MANAGED_PI_PROVIDER_INSTANCE_ID
                : true),
          ),
        ) as ProviderInstanceConfigMap)
      : input.settings.providerInstances;
  return {
    providers: {
      codex: {
        accounts,
        selectedAccountId,
      },
    },
    ...(instance ||
    input.opencodeInstance ||
    input.piInstance ||
    relayInstances ||
    claudeInstance ||
    input.removeManagedClaudeInstance ||
    input.removeManagedOpenCodeInstance ||
    input.removeManagedPiInstance ||
    removeRelayIds.length > 0
      ? {
          providerInstances: {
            ...providerInstances,
            ...(relayInstances ?? {}),
            ...(instance ? { [MOSS_MANAGED_PROVIDER_INSTANCE_ID]: instance } : {}),
            ...(claudeInstance
              ? { [MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID]: claudeInstance }
              : {}),
            ...(input.opencodeInstance
              ? { [MOSS_MANAGED_OPENCODE_PROVIDER_INSTANCE_ID]: input.opencodeInstance }
              : {}),
            ...(input.piInstance
              ? { [MOSS_MANAGED_PI_PROVIDER_INSTANCE_ID]: input.piInstance }
              : {}),
          } as ProviderInstanceConfigMap,
        }
      : {}),
    ...(textGenerationModelSelection ? { textGenerationModelSelection } : {}),
  };
}

export const MossManagedProviderLive = Layer.effect(
  MossManagedProvider,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig;
    const providerService = yield* ProviderService;
    const settingsService = yield* ServerSettingsService;
    // Account layers reconcile pending logout state while the application
    // layer graph is still being constructed. Ensure those lifecycle calls
    // inspect the durable settings snapshot instead of the service's empty
    // pre-start defaults.
    yield* settingsService.start;
    const canonicalStateDir = yield* Effect.try({
      try: () => bindRealDirectory(config.stateDir, "The Moss state directory"),
      catch: toProviderError,
    });
    const managedHomePath = path.join(config.stateDir, "moss-codex-home");
    const managedConfigPath = path.join(managedHomePath, "config.toml");
    const managedModelCatalogPath = path.join(
      managedHomePath,
      MOSS_MANAGED_CODEX_MODEL_CATALOG_FILE_NAME,
    );
    const codexRuntimeEnv: NodeJS.ProcessEnv = { MOSS_HOME: config.baseDir };

    const writeManagedFileAtomically = (input: {
      readonly filePath: string;
      readonly contents: string;
    }) =>
      writeFileStringAtomically(input).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );

    const assertSafeManagedHomeLocation = (): string => {
      const currentStateDir = bindRealDirectory(config.stateDir, "The Moss state directory");
      if (currentStateDir !== canonicalStateDir) {
        throw new Error("The Moss state directory changed after provider initialization.");
      }
      const canonicalManagedHome = bindRealDirectory(managedHomePath, "The managed Moss home");
      if (
        path.dirname(canonicalManagedHome) !== canonicalStateDir ||
        path.basename(canonicalManagedHome) !== "moss-codex-home"
      ) {
        throw new Error("The managed Moss home escapes the Moss state directory.");
      }
      return canonicalManagedHome;
    };

    const assertSafeManagedHome = (ownershipNonce: string | undefined): string => {
      const canonicalManagedHome = assertSafeManagedHomeLocation();
      assertManagedHomeMarker(
        path.join(managedHomePath, MOSS_MANAGED_HOME_OWNERSHIP_MARKER),
        ownershipNonce,
      );
      return canonicalManagedHome;
    };

    const createManagedHomeExclusive = () =>
      Effect.try({
        try: () => {
          mkdirSync(managedHomePath, { mode: PRIVATE_DIRECTORY_MODE });
          if (supportsPosixPermissions()) {
            // mkdir's mode is filtered by the process umask; enforce the
            // private mode explicitly so a permissive umask cannot leave the
            // managed home group/other-writable, which ensurePrivateDirectory
            // rejects during later atomic writes.
            chmodSync(managedHomePath, PRIVATE_DIRECTORY_MODE);
          }
          return true;
        },
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          isAlreadyExistsError(cause) ? Effect.succeed(false) : Effect.fail(cause),
        ),
      );

    const prepareManagedHome = (reservation: VerifiedMossManagedCodexReservation) =>
      Effect.gen(function* () {
        const currentStateDir = yield* Effect.try({
          try: () => bindRealDirectory(config.stateDir, "The Moss state directory"),
          catch: (cause) => cause,
        });
        if (currentStateDir !== canonicalStateDir) {
          return yield* Effect.fail(
            new Error("The Moss state directory changed after provider initialization."),
          );
        }
        let createdFresh = yield* createManagedHomeExclusive();
        let canonicalManagedHome = yield* Effect.try({
          try: assertSafeManagedHomeLocation,
          catch: (cause) => cause,
        });
        if (
          path.dirname(canonicalManagedHome) !== canonicalStateDir ||
          path.basename(canonicalManagedHome) !== "moss-codex-home"
        ) {
          return yield* Effect.fail(
            new Error("The managed Moss home escapes the Moss state directory."),
          );
        }
        if (!createdFresh) {
          const existingMarkerFailure = yield* Effect.sync(() => {
            try {
              assertSafeManagedHome(reservation.ownershipNonce);
              return undefined;
            } catch (cause) {
              return cause;
            }
          });
          if (existingMarkerFailure === undefined) return canonicalManagedHome;
          if (!reservation.provisioning || !reservation.ownershipNonce) {
            return yield* Effect.fail(existingMarkerFailure);
          }
          const recoveredIncompleteHome = yield* Effect.try({
            try: () =>
              removeRecoverableIncompleteManagedHome(
                managedHomePath,
                reservation.ownershipNonce as string,
              ),
            catch: (cause) => cause,
          });
          if (!recoveredIncompleteHome) return yield* Effect.fail(existingMarkerFailure);
          // The durable nonce reservation was committed before the first
          // mkdir. Only an empty or provably partial nonce-marker write is
          // eligible for crash recovery; arbitrary entries are never removed.
          yield* Effect.try({
            try: () => mkdirSync(managedHomePath),
            catch: (cause) => cause,
          });
          createdFresh = true;
          canonicalManagedHome = yield* Effect.try({
            try: assertSafeManagedHomeLocation,
            catch: (cause) => cause,
          });
        }
        if (createdFresh) {
          const ownershipNonce = reservation.ownershipNonce;
          if (!ownershipNonce) {
            return yield* Effect.fail(
              new Error("A fresh managed Moss home requires a durable ownership nonce."),
            );
          }
          yield* writeManagedFileAtomically({
            filePath: path.join(managedHomePath, MOSS_MANAGED_HOME_OWNERSHIP_MARKER),
            contents: buildMossManagedHomeOwnershipMarker(ownershipNonce),
          }).pipe(
            Effect.catch((cause) =>
              Effect.sync(() => {
                try {
                  removeRecoverableIncompleteManagedHome(managedHomePath, ownershipNonce);
                } catch {
                  // Leave unexpected content untouched and fail closed.
                }
              }).pipe(Effect.flatMap(() => Effect.fail(cause))),
            ),
          );
        }
        return yield* Effect.try({
          try: () => assertSafeManagedHome(reservation.ownershipNonce),
          catch: (cause) => cause,
        });
      });

    const materializeManagedPluginMarketplace = (
      reservation: VerifiedMossManagedCodexReservation,
    ) =>
      Effect.try({
        try: () => {
          assertSafeManagedHome(reservation.ownershipNonce);
          return materializeMossBundledPluginMarketplace(managedHomePath);
        },
        catch: toProviderError,
      });

    const stopManagedAccountContexts = (
      runtimeGeneration: string | undefined,
    ): Effect.Effect<void, unknown> => {
      const stopCodexAccountRuntimes = providerService.stopCodexAccountRuntimes;
      return stopCodexAccountRuntimes
        ? stopCodexAccountRuntimes({
            homePath: managedHomePath,
            accountId: MOSS_MANAGED_CODEX_ACCOUNT_ID,
            ...(runtimeGeneration ? { runtimeGeneration } : {}),
          })
        : Effect.fail(
            new Error("Codex account runtime cleanup is unavailable; refusing to remove secrets."),
          );
    };

    const stopVerifiedManagedRuntimesAndWait = (input: {
      readonly stopCodex: boolean;
      readonly runtimeGeneration: string | undefined;
      readonly checkClaude: boolean;
      readonly checkOpenCode: boolean;
      readonly checkPi: boolean;
      readonly relayInstanceIds?: ReadonlyArray<string> | undefined;
    }): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        const failures: unknown[] = [];
        if (input.stopCodex) {
          const fenceProviderInstanceLaunchesAndWait =
            providerService.fenceProviderInstanceLaunchesAndWait;
          if (fenceProviderInstanceLaunchesAndWait) {
            yield* fenceProviderInstanceLaunchesAndWait({
              providerInstanceId: MOSS_MANAGED_PROVIDER_INSTANCE_ID,
            }).pipe(
              Effect.catch((error) =>
                Effect.sync(() => {
                  failures.push(error);
                }),
              ),
            );
          } else {
            failures.push(
              new Error("Managed Codex runtime cleanup cannot fence in-flight provider launches."),
            );
          }

          let stopFailure: unknown;
          yield* stopManagedAccountContexts(input.runtimeGeneration).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                stopFailure = error;
              }),
            ),
          );
          if (stopFailure !== undefined) {
            if (isCodexLifecycleIdentityResolutionFailure(stopFailure)) {
              let sessionInspectionFailure: unknown;
              let sessions: ReadonlyArray<{ readonly provider: string }> = [];
              yield* providerService.listSessions().pipe(
                Effect.tap((currentSessions) =>
                  Effect.sync(() => {
                    sessions = currentSessions;
                  }),
                ),
                Effect.catch((error) =>
                  Effect.sync(() => {
                    sessionInspectionFailure = error;
                  }),
                ),
              );
              if (
                sessionInspectionFailure !== undefined ||
                sessions.some((session) => session.provider === "codex")
              ) {
                failures.push(stopFailure);
              } else {
                yield* Effect.logWarning(
                  "skipped unresolved Codex account identity stop after fencing launches; no live Codex runtime remains",
                );
              }
            } else {
              failures.push(stopFailure);
            }
          }
        }
        // The account-scoped Codex API above waits for every Codex child and
        // persists stopped bindings. Claude has no equivalent identity-bound
        // stop yet, so fail closed if one remains instead of stopping a newer
        // replacement through its reused thread key.
        if (input.checkClaude) {
          yield* stopMossManagedProviderRuntimes(providerService).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                failures.push(error);
              }),
            ),
          );
        }
        if (input.checkOpenCode) {
          yield* stopMossManagedOpenCodeProviderRuntimes(providerService).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                failures.push(error);
              }),
            ),
          );
        }
        if (input.checkPi) {
          yield* stopMossManagedPiProviderRuntimes(providerService).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                failures.push(error);
              }),
            ),
          );
        }
        for (const relay of MOSS_MANAGED_RELAY_PROVIDERS) {
          if (!input.relayInstanceIds?.includes(relay.instanceId)) continue;
          yield* stopMossManagedCompanionRuntimes(
            providerService,
            relay.driver,
            relay.instanceId,
          ).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                failures.push(error);
              }),
            ),
          );
        }
        const failure = failures[0];
        if (failure) return yield* Effect.fail(failure);
      }).pipe(Effect.asVoid);

    const removeManagedAccountOverlay = () =>
      removeMossCodexAccountOverlay(fs, {
        env: codexRuntimeEnv,
        homePath: managedHomePath,
        accountId: MOSS_MANAGED_CODEX_ACCOUNT_ID,
      });

    const reservationConflict = () =>
      new MossCloudAccountServiceError({
        code: "provider_error",
        message: "A reserved Moss provider conflicts with an existing user-managed account.",
      });

    const requiresPreviousCnGatewayCleanup = (settings: ServerSettings): boolean =>
      asConfigRecord(settings.providerInstances[MOSS_MANAGED_PROVIDER_INSTANCE_ID]?.config)
        .gatewayBaseUrl === PREVIOUS_CN_MANAGED_GATEWAY &&
      process.env[MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL_ENV_KEY] !== PREVIOUS_CN_MANAGED_GATEWAY;

    // undefined: ordinary current-route inspection; null: a historical
    // generation whose ownership cannot be proved. Never publish this local
    // environment or pass it to a provider process/credential resolver.
    const previousCnCompanionCleanupEnvironment = (
      settings: ServerSettings,
      reservation: VerifiedMossManagedCodexReservation | undefined,
    ): Readonly<Record<string, string | undefined>> | null | undefined => {
      if (!requiresPreviousCnGatewayCleanup(settings)) return undefined;
      const codex = settings.providerInstances[MOSS_MANAGED_PROVIDER_INSTANCE_ID];
      const codexConfig = asConfigRecord(codex?.config);
      if (
        process.env[MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL_ENV_KEY] !== DIRECT_CN_MANAGED_GATEWAY ||
        !reservation?.ownershipNonce ||
        reservation.provisioning ||
        codex?.displayName !== "Moss" ||
        codexConfig.credentialEnvKey !== MOSS_MANAGED_PROVIDER_ENV_KEY ||
        typeof codexConfig.runtimeGeneration !== "string" ||
        !codexConfig.runtimeGeneration.trim()
      )
        return null;
      for (const instanceId of [
        MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID,
        MOSS_MANAGED_OPENCODE_PROVIDER_INSTANCE_ID,
        MOSS_MANAGED_PI_PROVIDER_INSTANCE_ID,
        ...MOSS_MANAGED_RELAY_PROVIDERS.map((relay) => relay.instanceId),
      ]) {
        const instance = settings.providerInstances[instanceId];
        if (!instance) continue;
        const companion = asConfigRecord(instance.config);
        if (
          companion.runtimeGeneration !== codexConfig.runtimeGeneration ||
          companion.gatewayBaseUrl !==
            (instanceId === MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID
              ? PREVIOUS_CN_MANAGED_GATEWAY.replace(/\/v1$/, "")
              : PREVIOUS_CN_MANAGED_GATEWAY) ||
          ((instanceId === MOSS_MANAGED_PI_PROVIDER_INSTANCE_ID ||
            isMossManagedRelayInstanceId(instanceId)) &&
            companion.realm !== "cn")
        )
          return null;
      }
      try {
        // A nonce-shaped setting is not ownership: verify the fixed real home
        // and its exact persisted marker before adopting any old companion.
        assertSafeManagedHome(reservation.ownershipNonce);
      } catch {
        return null;
      }
      return {
        ...process.env,
        [MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL_ENV_KEY]: PREVIOUS_CN_MANAGED_GATEWAY,
      };
    };

    const inspectVerifiedManagedSurfaces = (
      settings: ServerSettings,
      expectedAccessToken?: string,
      expectedAccessTokenHash?: string,
      allowStalePairedCredential = false,
      expectedGatewayBaseUrl?: string,
      expectedCredentialEnvKey?: string,
    ): VerifiedMossManagedSurfaces => {
      const codexReservation = verifiedMossManagedCodexReservation(settings, managedHomePath);
      const candidateCodex = settings.providerInstances[MOSS_MANAGED_PROVIDER_INSTANCE_ID];
      const candidateClaude = settings.providerInstances[MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID];
      const candidateOpenCode =
        settings.providerInstances[MOSS_MANAGED_OPENCODE_PROVIDER_INSTANCE_ID];
      const historicalEnvironment = previousCnCompanionCleanupEnvironment(
        settings,
        codexReservation,
      );
      const companionCleanupEnv = historicalEnvironment ?? process.env;
      const collisions = inspectMossManagedReservationCollisions(
        settings,
        managedHomePath,
        process.env,
        expectedAccessToken,
        expectedAccessTokenHash,
        allowStalePairedCredential,
        expectedGatewayBaseUrl,
        expectedCredentialEnvKey,
        companionCleanupEnv,
      );
      if (
        historicalEnvironment === null ||
        (historicalEnvironment !== undefined &&
          (collisions.hasReservedSurfaceCollision || collisions.hasLifecycleHomeCollision))
      ) {
        // Do not partially fence/stop a historical generation with a foreign
        // or unproved member. The same proof controls both collision and owned
        // surfaces, including retries after a durably committed fence.
        return {
          codexReservation: undefined,
          codexInstance: undefined,
          claudeInstance: undefined,
          opencodeInstance: undefined,
          piInstance: undefined,
          relayInstances: {},
          hasCollision: true,
          hasLifecycleHomeCollision: collisions.hasLifecycleHomeCollision,
        };
      }
      return {
        codexReservation,
        codexInstance:
          codexReservation && !codexReservation.provisioning
            ? settings.providerInstances[MOSS_MANAGED_PROVIDER_INSTANCE_ID]
            : undefined,
        claudeInstance: isCleanupOwnedMossManagedClaudeInstance({
          instance: candidateClaude,
          codexInstance: candidateCodex,
          codexReservation,
          expectedAccessToken,
          expectedAccessTokenHash,
          allowStalePairedCredential,
          expectedGatewayBaseUrl,
          expectedCredentialEnvKey,
        })
          ? candidateClaude
          : undefined,
        opencodeInstance: isCleanupOwnedMossManagedOpenCodeInstance(
          settings,
          managedHomePath,
          companionCleanupEnv,
        )
          ? candidateOpenCode
          : undefined,
        piInstance: isVerifiedMossManagedPiInstance(
          settings.providerInstances[MOSS_MANAGED_PI_PROVIDER_INSTANCE_ID],
          managedHomePath,
          companionCleanupEnv,
        )
          ? settings.providerInstances[MOSS_MANAGED_PI_PROVIDER_INSTANCE_ID]
          : undefined,
        relayInstances: inspectMossManagedRelayInstances(
          settings.providerInstances,
          nodePath.dirname(managedHomePath),
          companionCleanupEnv,
        ).owned,
        hasCollision:
          collisions.hasReservedSurfaceCollision || collisions.hasLifecycleHomeCollision,
        hasLifecycleHomeCollision: collisions.hasLifecycleHomeCollision,
      };
    };

    const inspectVerifiedManagedSurfacesWithCleanupFallback = (
      settings: ServerSettings,
      input: {
        readonly expectedAccessToken?: string | undefined;
        readonly cleanupFallbackAccessToken?: string | undefined;
      },
    ): VerifiedMossManagedSurfaces => {
      const structuralOrExpected = inspectVerifiedManagedSurfaces(
        settings,
        input.expectedAccessToken,
      );
      if (!structuralOrExpected.hasCollision || !input.cleanupFallbackAccessToken) {
        return structuralOrExpected;
      }
      const fallback = inspectVerifiedManagedSurfaces(settings, input.cleanupFallbackAccessToken);
      return fallback.hasCollision ? structuralOrExpected : fallback;
    };

    const updateManagedSettingsWithRevision = (input: {
      readonly buildPatch: (settings: ServerSettings) => ServerSettingsPatch | undefined;
      readonly validate?: (
        settings: ServerSettings,
      ) => Effect.Effect<void, MossCloudAccountServiceError>;
    }): Effect.Effect<boolean, MossCloudAccountServiceError> =>
      Effect.gen(function* () {
        let remainingAttempts = 4;
        while (true) {
          const snapshot = yield* settingsService.getSnapshot;
          if (input.validate) {
            yield* input.validate(snapshot.settings);
          }
          const patch = input.buildPatch(snapshot.settings);
          if (!patch) return false;
          const updated = yield* settingsService.updateSettingsIfRevision({
            expectedRevision: snapshot.revision,
            patch,
          });
          if (updated !== undefined) return true;
          if (remainingAttempts === 0) {
            return yield* Effect.fail(
              new MossCloudAccountServiceError({
                code: "provider_error",
                message:
                  "Managed Moss cleanup settings changed during reconciliation; retry required.",
              }),
            );
          }
          remainingAttempts -= 1;
        }
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof MossCloudAccountServiceError ? cause : toProviderError(cause),
        ),
      );

    const safeUnownedSelectionRepairPatch = (
      settings: ServerSettings,
    ): ServerSettingsPatch | undefined => {
      const hasReservedCodexAccount = settings.providers.codex.accounts.some(
        (account) => account.id === MOSS_MANAGED_CODEX_ACCOUNT_ID,
      );
      const hasReservedCodexInstance =
        settings.providerInstances[MOSS_MANAGED_PROVIDER_INSTANCE_ID] !== undefined;
      const shouldRestoreCodexAccount =
        !hasReservedCodexAccount &&
        !hasReservedCodexInstance &&
        settings.providers.codex.selectedAccountId === MOSS_MANAGED_CODEX_ACCOUNT_ID;
      const shouldRestoreTextGeneration =
        (!hasReservedCodexInstance &&
          settings.textGenerationModelSelection.instanceId === MOSS_MANAGED_PROVIDER_INSTANCE_ID) ||
        (settings.providerInstances[MOSS_MANAGED_OPENCODE_PROVIDER_INSTANCE_ID] === undefined &&
          settings.textGenerationModelSelection.instanceId ===
            MOSS_MANAGED_OPENCODE_PROVIDER_INSTANCE_ID) ||
        (settings.providerInstances[MOSS_MANAGED_PI_PROVIDER_INSTANCE_ID] === undefined &&
          settings.textGenerationModelSelection.instanceId ===
            MOSS_MANAGED_PI_PROVIDER_INSTANCE_ID) ||
        (settings.textGenerationModelSelection.instanceId !== undefined &&
          isMossManagedRelayInstanceId(settings.textGenerationModelSelection.instanceId) &&
          settings.providerInstances[settings.textGenerationModelSelection.instanceId] ===
            undefined);
      if (!shouldRestoreCodexAccount && !shouldRestoreTextGeneration) return undefined;
      return {
        ...(shouldRestoreCodexAccount
          ? { providers: { codex: { selectedAccountId: DEFAULT_CODEX_ACCOUNT_ID } } }
          : {}),
        ...(shouldRestoreTextGeneration
          ? {
              textGenerationModelSelection: {
                provider: "codex",
                instanceId: "codex",
                model: DEFAULT_GIT_TEXT_GENERATION_MODEL,
              },
            }
          : {}),
      };
    };

    const repairUnownedManagedSelections = (_settings?: ServerSettings) =>
      updateManagedSettingsWithRevision({
        buildPatch: (settings) => safeUnownedSelectionRepairPatch(settings),
      }).pipe(Effect.asVoid);

    const hasOnlyUnownedManagedSelections = (settings: ServerSettings): boolean =>
      settings.providerInstances[MOSS_MANAGED_PROVIDER_INSTANCE_ID] === undefined &&
      settings.providerInstances[MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID] === undefined &&
      settings.providerInstances[MOSS_MANAGED_OPENCODE_PROVIDER_INSTANCE_ID] === undefined &&
      settings.providerInstances[MOSS_MANAGED_PI_PROVIDER_INSTANCE_ID] === undefined &&
      MOSS_MANAGED_RELAY_PROVIDERS.every(
        (relay) => settings.providerInstances[relay.instanceId] === undefined,
      ) &&
      !settings.providers.codex.accounts.some(
        (account) => account.id === MOSS_MANAGED_CODEX_ACCOUNT_ID,
      ) &&
      safeUnownedSelectionRepairPatch(settings) !== undefined;

    const launchSurfaceIsDurablyDisabled = (instance: ProviderInstanceConfig | undefined) =>
      instance === undefined ||
      (instance.enabled === false && (instance.environment?.length ?? 0) === 0);

    const cleanupIsDurablyComplete = (instance: ProviderInstanceConfig | undefined) =>
      instance === undefined ||
      (launchSurfaceIsDurablyDisabled(instance) &&
        managedCleanupStateFromConfig(instance.config) === MOSS_MANAGED_CLEANUP_COMPLETE);

    const ensureCredentialFreeManagedFence = () =>
      Effect.gen(function* () {
        const latest = yield* settingsService.getSettings;
        const latestSurfaces = inspectVerifiedManagedSurfaces(latest);
        if (latestSurfaces.hasCollision) return yield* Effect.fail(reservationConflict());
        if (
          !launchSurfaceIsDurablyDisabled(
            latest.providerInstances[MOSS_MANAGED_PROVIDER_INSTANCE_ID],
          ) ||
          !launchSurfaceIsDurablyDisabled(
            latest.providerInstances[MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID],
          ) ||
          !launchSurfaceIsDurablyDisabled(
            latest.providerInstances[MOSS_MANAGED_OPENCODE_PROVIDER_INSTANCE_ID],
          ) ||
          !launchSurfaceIsDurablyDisabled(
            latest.providerInstances[MOSS_MANAGED_PI_PROVIDER_INSTANCE_ID],
          ) ||
          MOSS_MANAGED_RELAY_PROVIDERS.some(
            (relay) => !launchSurfaceIsDurablyDisabled(latest.providerInstances[relay.instanceId]),
          )
        ) {
          return yield* Effect.fail(
            new MossCloudAccountServiceError({
              code: "provider_error",
              message: "The managed Moss credential fence was not durably committed.",
            }),
          );
        }
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof MossCloudAccountServiceError ? cause : toProviderError(cause),
        ),
        Effect.asVoid,
      );

    const fenceVerifiedManagedSurfaces = (input: {
      readonly selectionPolicy: MossManagedSettingsSelectionPolicy;
      readonly expectedAccessToken?: string | undefined;
      readonly cleanupFallbackAccessToken?: string | undefined;
      readonly expectedAccessTokenHash?: string | undefined;
      readonly allowStalePairedCredential?: boolean | undefined;
      readonly expectedGatewayBaseUrl?: string | undefined;
      readonly expectedCredentialEnvKey?: string | undefined;
    }): Effect.Effect<void, MossCloudAccountServiceError> =>
      updateManagedSettingsWithRevision({
        validate: (settings) => {
          if (!requiresPreviousCnGatewayCleanup(settings)) return Effect.void;
          const surfaces = input.cleanupFallbackAccessToken
            ? inspectVerifiedManagedSurfacesWithCleanupFallback(settings, input)
            : inspectVerifiedManagedSurfaces(
                settings,
                input.expectedAccessToken,
                input.expectedAccessTokenHash,
                input.allowStalePairedCredential,
                input.expectedGatewayBaseUrl,
                input.expectedCredentialEnvKey,
              );
          return surfaces.hasCollision ? Effect.fail(reservationConflict()) : Effect.void;
        },
        buildPatch: (settings) => {
          const surfaces = input.cleanupFallbackAccessToken
            ? inspectVerifiedManagedSurfacesWithCleanupFallback(settings, input)
            : inspectVerifiedManagedSurfaces(
                settings,
                input.expectedAccessToken,
                input.expectedAccessTokenHash,
                input.allowStalePairedCredential,
                input.expectedGatewayBaseUrl,
                input.expectedCredentialEnvKey,
              );
          if (surfaces.codexInstance) {
            return buildMossManagedSettingsPatch({
              settings,
              managedHomePath,
              relayInstances: mapMossManagedRelayInstances(surfaces.relayInstances, (instance) => ({
                ...withManagedCleanupState(instance, MOSS_MANAGED_CLEANUP_PENDING),
                enabled: false,
                environment: [],
              })),
              instance: {
                ...withManagedCleanupState(surfaces.codexInstance, MOSS_MANAGED_CLEANUP_PENDING),
                enabled: false,
                environment: [],
              },
              ...(surfaces.claudeInstance
                ? {
                    claudeInstance: {
                      ...withManagedCleanupState(
                        surfaces.claudeInstance,
                        MOSS_MANAGED_CLEANUP_PENDING,
                      ),
                      enabled: false,
                      environment: [],
                    },
                  }
                : {}),
              ...(surfaces.piInstance
                ? {
                    piInstance: {
                      ...withManagedCleanupState(surfaces.piInstance, MOSS_MANAGED_CLEANUP_PENDING),
                      enabled: false,
                      environment: [],
                    },
                  }
                : {}),
              ...(surfaces.opencodeInstance
                ? {
                    opencodeInstance: {
                      ...withManagedCleanupState(
                        surfaces.opencodeInstance,
                        MOSS_MANAGED_CLEANUP_PENDING,
                      ),
                      enabled: false,
                      environment: [],
                    },
                  }
                : {}),
              selectionPolicy: input.selectionPolicy,
            });
          }
          const companionTombstones: Record<string, ProviderInstanceConfig> = {
            ...mapMossManagedRelayInstances(surfaces.relayInstances, (instance) => ({
              ...withManagedCleanupState(instance, MOSS_MANAGED_CLEANUP_PENDING),
              enabled: false,
              environment: [],
            })),
          };
          if (surfaces.claudeInstance) {
            companionTombstones[MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID] = {
              ...withManagedCleanupState(surfaces.claudeInstance, MOSS_MANAGED_CLEANUP_PENDING),
              enabled: false,
              environment: [],
            };
          }
          if (surfaces.opencodeInstance) {
            companionTombstones[MOSS_MANAGED_OPENCODE_PROVIDER_INSTANCE_ID] = {
              ...withManagedCleanupState(surfaces.opencodeInstance, MOSS_MANAGED_CLEANUP_PENDING),
              enabled: false,
              environment: [],
            };
          }
          if (surfaces.piInstance) {
            companionTombstones[MOSS_MANAGED_PI_PROVIDER_INSTANCE_ID] = {
              ...withManagedCleanupState(surfaces.piInstance, MOSS_MANAGED_CLEANUP_PENDING),
              enabled: false,
              environment: [],
            };
          }
          if (Object.keys(companionTombstones).length === 0) {
            return safeUnownedSelectionRepairPatch(settings);
          }
          return {
            ...(safeUnownedSelectionRepairPatch(settings) ?? {}),
            providerInstances: {
              ...settings.providerInstances,
              ...companionTombstones,
            },
          };
        },
      }).pipe(Effect.asVoid);

    const markVerifiedManagedCleanupComplete = () =>
      updateManagedSettingsWithRevision({
        validate: (settings) => {
          const surfaces = inspectVerifiedManagedSurfaces(settings);
          if (surfaces.hasCollision) return Effect.fail(reservationConflict());
          if (
            !launchSurfaceIsDurablyDisabled(surfaces.codexInstance) ||
            !launchSurfaceIsDurablyDisabled(surfaces.claudeInstance) ||
            !launchSurfaceIsDurablyDisabled(surfaces.opencodeInstance) ||
            !launchSurfaceIsDurablyDisabled(surfaces.piInstance) ||
            !Object.values(surfaces.relayInstances).every(launchSurfaceIsDurablyDisabled)
          ) {
            return Effect.fail(
              new MossCloudAccountServiceError({
                code: "provider_error",
                message: "Managed Moss cleanup completed without a durable credential fence.",
              }),
            );
          }
          return Effect.void;
        },
        buildPatch: (latest) => {
          const surfaces = inspectVerifiedManagedSurfaces(latest);
          // Remove companion tombstones only after their exact runtimes have
          // been fenced and drained. Colliding user-owned instances are retained.
          if (
            !surfaces.codexInstance &&
            !surfaces.claudeInstance &&
            !surfaces.opencodeInstance &&
            !surfaces.piInstance &&
            Object.keys(surfaces.relayInstances).length === 0
          ) {
            return undefined;
          }
          if (!surfaces.codexInstance) {
            const providerInstances = {
              ...Object.fromEntries(
                Object.entries(latest.providerInstances).filter(
                  ([instanceId]) =>
                    surfaces.relayInstances[instanceId] === undefined &&
                    (!surfaces.opencodeInstance ||
                      instanceId !== MOSS_MANAGED_OPENCODE_PROVIDER_INSTANCE_ID) &&
                    (!surfaces.piInstance || instanceId !== MOSS_MANAGED_PI_PROVIDER_INSTANCE_ID),
                ),
              ),
              ...(surfaces.claudeInstance
                ? {
                    [MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID]: withManagedCleanupState(
                      surfaces.claudeInstance,
                      MOSS_MANAGED_CLEANUP_COMPLETE,
                    ),
                  }
                : {}),
            } as ProviderInstanceConfigMap;
            return {
              ...(safeUnownedSelectionRepairPatch(latest) ?? {}),
              providerInstances,
            };
          }
          return buildMossManagedSettingsPatch({
            settings: latest,
            managedHomePath,
            instance: withManagedCleanupState(
              surfaces.codexInstance,
              MOSS_MANAGED_CLEANUP_COMPLETE,
            ),
            ...(surfaces.claudeInstance
              ? {
                  claudeInstance: withManagedCleanupState(
                    surfaces.claudeInstance,
                    MOSS_MANAGED_CLEANUP_COMPLETE,
                  ),
                }
              : {}),
            ...(surfaces.opencodeInstance ? { removeManagedOpenCodeInstance: true } : {}),
            ...(surfaces.piInstance ? { removeManagedPiInstance: true } : {}),
            removeManagedRelayInstanceIds: Object.keys(surfaces.relayInstances),
            selectionPolicy: "preserve",
          });
        },
      }).pipe(Effect.asVoid);

    const migrateLegacyCredentialFreeCleanup = (
      surfaces: VerifiedMossManagedSurfaces,
      expectedAccessToken?: string,
      expectedAccessTokenHash?: string,
    ): Effect.Effect<boolean, MossCloudAccountServiceError> =>
      Effect.gen(function* () {
        const hasManagedSurface =
          surfaces.codexInstance !== undefined ||
          surfaces.claudeInstance !== undefined ||
          surfaces.opencodeInstance !== undefined ||
          surfaces.piInstance !== undefined ||
          Object.keys(surfaces.relayInstances).length > 0;
        const isLegacyCredentialFreeTombstone =
          hasManagedSurface &&
          !surfaces.hasCollision &&
          launchSurfaceIsDurablyDisabled(surfaces.codexInstance) &&
          launchSurfaceIsDurablyDisabled(surfaces.claudeInstance) &&
          launchSurfaceIsDurablyDisabled(surfaces.opencodeInstance) &&
          launchSurfaceIsDurablyDisabled(surfaces.piInstance) &&
          Object.values(surfaces.relayInstances).every(launchSurfaceIsDurablyDisabled) &&
          Object.values(surfaces.relayInstances).every(
            (instance) => managedCleanupStateFromConfig(instance.config) === undefined,
          ) &&
          managedCleanupStateFromConfig(surfaces.codexInstance?.config) === undefined &&
          managedCleanupStateFromConfig(surfaces.claudeInstance?.config) === undefined &&
          managedCleanupStateFromConfig(surfaces.opencodeInstance?.config) === undefined &&
          managedCleanupStateFromConfig(surfaces.piInstance?.config) === undefined;
        if (!isLegacyCredentialFreeTombstone) return false;

        // Older builds persisted a safe credential-free reservation but had
        // no durable bit distinguishing a completed cleanup from an interrupted
        // one. Record pending before inspecting the live manager so a crash in
        // this one-time migration retries the full teardown on the next boot.
        yield* fenceVerifiedManagedSurfaces({
          selectionPolicy: "preserve",
          expectedAccessToken,
          expectedAccessTokenHash,
        });

        const fenceProviderInstanceLaunchesAndWait =
          providerService.fenceProviderInstanceLaunchesAndWait;
        if (!fenceProviderInstanceLaunchesAndWait) return false;
        if (surfaces.codexInstance) {
          yield* fenceProviderInstanceLaunchesAndWait({
            providerInstanceId: MOSS_MANAGED_PROVIDER_INSTANCE_ID,
          });
        }
        if (surfaces.claudeInstance) {
          yield* fenceProviderInstanceLaunchesAndWait({
            providerInstanceId: MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID,
          });
        }
        if (surfaces.opencodeInstance) {
          yield* fenceProviderInstanceLaunchesAndWait({
            providerInstanceId: MOSS_MANAGED_OPENCODE_PROVIDER_INSTANCE_ID,
          });
        }
        if (surfaces.piInstance) {
          yield* fenceProviderInstanceLaunchesAndWait({
            providerInstanceId: MOSS_MANAGED_PI_PROVIDER_INSTANCE_ID,
          });
        }
        for (const instanceId of Object.keys(surfaces.relayInstances)) {
          yield* fenceProviderInstanceLaunchesAndWait({ providerInstanceId: instanceId });
        }
        const sessions = yield* providerService.listSessions();
        const hasManagedRuntime = sessions.some(
          (session) =>
            (surfaces.codexInstance !== undefined &&
              session.providerInstanceId === MOSS_MANAGED_PROVIDER_INSTANCE_ID) ||
            (surfaces.claudeInstance !== undefined &&
              session.providerInstanceId === MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID) ||
            (surfaces.opencodeInstance !== undefined &&
              session.providerInstanceId === MOSS_MANAGED_OPENCODE_PROVIDER_INSTANCE_ID) ||
            (surfaces.piInstance !== undefined &&
              session.providerInstanceId === MOSS_MANAGED_PI_PROVIDER_INSTANCE_ID) ||
            (session.providerInstanceId !== undefined &&
              surfaces.relayInstances[session.providerInstanceId] !== undefined),
        );
        if (hasManagedRuntime) return false;

        if (
          surfaces.codexInstance &&
          surfaces.codexReservation &&
          !surfaces.hasLifecycleHomeCollision
        ) {
          yield* removeVerifiedManagedAccountOverlayIfPresent(surfaces.codexReservation);
        }
        yield* markVerifiedManagedCleanupComplete();
        return true;
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof MossCloudAccountServiceError ? cause : toProviderError(cause),
        ),
      );

    const ensureVerifiedManagedHome = (
      reservation: VerifiedMossManagedCodexReservation,
    ): Effect.Effect<void, MossCloudAccountServiceError> =>
      Effect.try({
        try: () => assertSafeManagedHome(reservation.ownershipNonce),
        catch: () => reservationConflict(),
      }).pipe(Effect.asVoid);

    const removeVerifiedManagedAccountOverlayIfPresent = (
      reservation: VerifiedMossManagedCodexReservation,
    ): Effect.Effect<void, MossCloudAccountServiceError> =>
      fs.exists(managedHomePath).pipe(
        Effect.flatMap((managedHomeExists) =>
          managedHomeExists
            ? ensureVerifiedManagedHome(reservation).pipe(
                Effect.flatMap(removeManagedAccountOverlay),
              )
            : Effect.void,
        ),
        Effect.mapError((cause) =>
          cause instanceof MossCloudAccountServiceError ? cause : toProviderError(cause),
        ),
        Effect.asVoid,
      );

    const ensureReservationProvenance = (
      settings: ServerSettings,
    ): Effect.Effect<
      VerifiedMossManagedCodexReservation | undefined,
      MossCloudAccountServiceError
    > =>
      Effect.gen(function* () {
        const surfaces = inspectVerifiedManagedSurfaces(settings);
        if (surfaces.hasCollision) return yield* Effect.fail(reservationConflict());
        return surfaces.codexReservation;
      });

    const ensureReservationReadyForEnable = (
      settings: ServerSettings,
    ): Effect.Effect<void, MossCloudAccountServiceError> =>
      Effect.gen(function* () {
        const managedReservation = yield* ensureReservationProvenance(settings);
        if (!managedReservation) return yield* Effect.fail(reservationConflict());
        yield* ensureVerifiedManagedHome(managedReservation);
      }).pipe(Effect.asVoid);

    const updateInstances = (input: {
      readonly instance?: ProviderInstanceConfig | undefined;
      readonly claudeInstance?: ProviderInstanceConfig | undefined;
      readonly enableManagedClaudeInstance?: boolean | undefined;
      readonly opencodeInstance?: ProviderInstanceConfig | undefined;
      readonly piInstance?: ProviderInstanceConfig | undefined;
      readonly relayInstances?: ProviderInstanceConfigMap | undefined;
      readonly removeManagedRelayInstanceIds?: ReadonlyArray<string> | undefined;
      readonly removeManagedClaudeInstance?: boolean | undefined;
      readonly removeManagedOpenCodeInstance?: boolean | undefined;
      readonly removeManagedPiInstance?: boolean | undefined;
      readonly restoreManagedSelectionFromCleanup?: boolean | undefined;
      readonly selectionPolicy: MossManagedSettingsSelectionPolicy;
    }) =>
      Effect.gen(function* () {
        let remainingAttempts = 4;
        while (true) {
          const snapshot = yield* settingsService.getSnapshot;
          const settings = snapshot.settings;
          const enablesManagedInstance =
            input.instance !== undefined && input.instance.enabled !== false;
          if (enablesManagedInstance) {
            yield* ensureReservationReadyForEnable(settings);
          } else {
            yield* ensureReservationProvenance(settings);
          }
          const restoreManagedSelectionFromCleanup =
            input.restoreManagedSelectionFromCleanup === true &&
            managedSelectionFallbackFromSettings(settings) !== undefined;
          const patch = buildMossManagedSettingsPatch({
            settings,
            managedHomePath,
            instance: input.instance,
            claudeInstance: input.claudeInstance,
            enableManagedClaudeInstance: input.enableManagedClaudeInstance,
            opencodeInstance: input.opencodeInstance,
            piInstance: input.piInstance,
            relayInstances: input.relayInstances,
            removeManagedRelayInstanceIds: input.removeManagedRelayInstanceIds,
            removeManagedClaudeInstance: input.removeManagedClaudeInstance,
            removeManagedOpenCodeInstance: input.removeManagedOpenCodeInstance,
            removeManagedPiInstance: input.removeManagedPiInstance,
            restoreManagedSelectionFromCleanup,
            selectionPolicy: input.selectionPolicy,
          });
          // Re-read and rebuild after a conflict. This is what prevents a
          // recovery decision made from an older marker or provider map from
          // overwriting a user's personal selection or a newly added instance.
          const updated = yield* settingsService.updateSettingsIfRevision({
            expectedRevision: snapshot.revision,
            patch,
          });
          if (updated !== undefined) return;
          if (remainingAttempts === 0) {
            return yield* Effect.fail(
              new MossCloudAccountServiceError({
                code: "provider_error",
                message: "Managed Moss settings changed during reconciliation; retry required.",
              }),
            );
          }
          remainingAttempts -= 1;
        }
      }).pipe(Effect.mapError(toProviderError), Effect.asVoid);

    const reuseMatchingManagedInstance = (input: {
      readonly settings: ServerSettings;
      readonly accessToken: string;
      readonly gatewayBaseUrl: string;
      readonly credentialEnvKey: string;
      readonly useProcessGatewayApiKey: boolean;
      readonly bundledCodexPath: string | undefined;
      readonly models: ReadonlyArray<string>;
      readonly realm: MossAccessLane;
      readonly cleanupAccessTokenHash?: string | undefined;
      readonly restoreManagedSelectionFromCleanup?: boolean | undefined;
      readonly selectionPolicy: MossManagedSettingsSelectionPolicy;
    }): Effect.Effect<boolean, MossCloudAccountServiceError> =>
      Effect.gen(function* () {
        if (input.restoreManagedSelectionFromCleanup === true) return false;
        const managedSurfaces = inspectVerifiedManagedSurfaces(
          input.settings,
          input.accessToken,
          input.cleanupAccessTokenHash,
        );
        const currentInstance = managedSurfaces.codexInstance;
        const requiresClaudeSurface = !input.useProcessGatewayApiKey;
        if (
          managedSurfaces.hasCollision ||
          (requiresClaudeSurface
            ? managedSurfaces.claudeInstance === undefined
            : managedSurfaces.claudeInstance !== undefined) ||
          currentInstance === undefined ||
          currentInstance.enabled === false
        ) {
          return false;
        }

        const currentConfig = asConfigRecord(currentInstance.config);
        const expectedEnvironment = buildMossManagedProviderEnvironment({
          accessToken: input.accessToken,
          gatewayBaseUrl: input.gatewayBaseUrl,
          useProcessGatewayApiKey: input.useProcessGatewayApiKey,
          env: process.env,
        });
        const currentEnvironment = currentInstance.environment ?? [];
        const environmentMatches =
          currentEnvironment.length === expectedEnvironment.length &&
          currentEnvironment.every((entry, index) => {
            const expected = expectedEnvironment[index];
            return (
              expected !== undefined &&
              entry.name === expected.name &&
              entry.value === expected.value &&
              entry.sensitive === expected.sensitive
            );
          });
        const runtimeGeneration = currentConfig.runtimeGeneration;
        const expectedClaudeInstance =
          requiresClaudeSurface && typeof runtimeGeneration === "string" && runtimeGeneration.trim()
            ? buildMossManagedClaudeInstance({
                accessToken: input.accessToken,
                gatewayBaseUrl: input.gatewayBaseUrl,
                runtimeGeneration,
                env: process.env,
                realm: input.realm,
              })
            : undefined;
        const expectedOpenCodeInstance =
          requiresClaudeSurface && typeof runtimeGeneration === "string" && runtimeGeneration.trim()
            ? buildMossManagedOpenCodeInstance({
                accessToken: input.accessToken,
                gatewayBaseUrl: input.gatewayBaseUrl,
                runtimeGeneration,
                env: process.env,
              })
            : undefined;
        const expectedPiInstance =
          requiresClaudeSurface && typeof runtimeGeneration === "string" && runtimeGeneration.trim()
            ? buildMossManagedPiProviderInstance({
                accessToken: input.accessToken,
                gatewayBaseUrl: input.gatewayBaseUrl,
                runtimeGeneration,
                realm: input.realm,
                agentDir: path.join(config.stateDir, "provider-homes", "pi", input.realm),
                env: process.env,
              })
            : undefined;
        const piPresenceMatches = matchesMossManagedPiProviderInstance(
          managedSurfaces.piInstance,
          expectedPiInstance,
        );
        const expectedRelayInstances =
          requiresClaudeSurface && typeof runtimeGeneration === "string" && runtimeGeneration.trim()
            ? buildMossManagedRelayInstances({
                stateDir: config.stateDir,
                accessToken: input.accessToken,
                gatewayBaseUrl: input.gatewayBaseUrl,
                runtimeGeneration,
                realm: input.realm,
                env: process.env,
              })
            : {};
        const currentClaudeEnvironment = managedSurfaces.claudeInstance?.environment ?? [];
        const currentClaudeConfig = asConfigRecord(managedSurfaces.claudeInstance?.config);
        const expectedClaudeConfig = asConfigRecord(expectedClaudeInstance?.config);
        const claudeMatches =
          !requiresClaudeSurface ||
          (isVerifiedMossManagedClaudeProviderInstance({
            instanceId: MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID,
            instance: managedSurfaces.claudeInstance,
            env: process.env,
          }) &&
            currentClaudeEnvironment.find((entry) => entry.name === "ANTHROPIC_AUTH_TOKEN")
              ?.value === input.accessToken &&
            currentClaudeConfig.gatewayBaseUrl === expectedClaudeConfig.gatewayBaseUrl &&
            currentClaudeConfig.runtimeGeneration === runtimeGeneration);
        const currentOpenCodeConfig = asConfigRecord(managedSurfaces.opencodeInstance?.config);
        const currentOpenCodeToken = managedSurfaces.opencodeInstance?.environment?.find(
          (entry) => entry.name === MOSS_MANAGED_OPENCODE_CREDENTIAL_ENV_KEY,
        )?.value;
        const expectedOpenCodeConfig = asConfigRecord(expectedOpenCodeInstance?.config);
        const openCodeMatches =
          !expectedOpenCodeInstance ||
          (isVerifiedMossManagedOpenCodeInstance(managedSurfaces.opencodeInstance, process.env) &&
            currentOpenCodeToken === input.accessToken &&
            currentOpenCodeConfig.gatewayBaseUrl === expectedOpenCodeConfig.gatewayBaseUrl &&
            currentOpenCodeConfig.runtimeGeneration === runtimeGeneration);
        const openCodePresenceMatches = expectedOpenCodeInstance
          ? managedSurfaces.opencodeInstance !== undefined && openCodeMatches
          : managedSurfaces.opencodeInstance === undefined;
        if (
          !environmentMatches ||
          currentConfig.gatewayBaseUrl !== input.gatewayBaseUrl ||
          currentConfig.credentialEnvKey !== input.credentialEnvKey ||
          typeof runtimeGeneration !== "string" ||
          !runtimeGeneration.trim() ||
          !claudeMatches ||
          !openCodePresenceMatches ||
          !piPresenceMatches ||
          !matchesMossManagedRelayInstances(managedSurfaces.relayInstances, expectedRelayInstances)
        ) {
          return false;
        }

        const managedReservation = managedSurfaces.codexReservation;
        if (!managedReservation) return false;
        yield* ensureVerifiedManagedHome(managedReservation);
        const bundledMarketplace = yield* materializeManagedPluginMarketplace(managedReservation);
        // Desktop keeps Moss catalog ids; the gateway resolves them against the OpenRouter upstream.
        const defaultModel = input.models[0] ?? MOSS_MANAGED_DEFAULT_MODEL;
        yield* writeManagedFileAtomically({
          filePath: managedModelCatalogPath,
          contents: buildMossManagedCodexModelCatalog(input.models),
        });
        yield* fs.chmod(managedModelCatalogPath, 0o600).pipe(Effect.orElseSucceed(() => undefined));
        yield* Effect.tryPromise(() =>
          writeMossManagedPluginConfig({
            managedHomePath,
            configPath: managedConfigPath,
            assertCurrent: () => {
              assertSafeManagedHome(managedReservation.ownershipNonce);
            },
            writeAtomically: (input) => Effect.runPromise(writeManagedFileAtomically(input)),
            generatedConfig: buildMossManagedCodexConfig({
              gatewayBaseUrl: input.gatewayBaseUrl,
              defaultModel,
              credentialEnvKey: input.credentialEnvKey,
              bundledPluginMarketplaceRoot: bundledMarketplace.root,
              modelCatalogPath: managedModelCatalogPath,
            }),
          }),
        );
        yield* fs.chmod(managedConfigPath, 0o600).pipe(Effect.orElseSucceed(() => undefined));

        const refreshedConfig = { ...currentConfig };
        delete refreshedConfig.binaryPath;
        delete refreshedConfig[MOSS_MANAGED_CLEANUP_STATE_CONFIG_KEY];
        yield* updateInstances({
          selectionPolicy: input.selectionPolicy,
          relayInstances: expectedRelayInstances,
          removeManagedRelayInstanceIds: Object.keys(managedSurfaces.relayInstances).filter(
            (id) => expectedRelayInstances[id] === undefined,
          ),
          ...(expectedClaudeInstance ? { claudeInstance: expectedClaudeInstance } : {}),
          ...(expectedClaudeInstance ? { enableManagedClaudeInstance: true } : {}),
          ...(expectedPiInstance
            ? { piInstance: expectedPiInstance }
            : managedSurfaces.piInstance
              ? { removeManagedPiInstance: true }
              : {}),
          ...(expectedOpenCodeInstance
            ? { opencodeInstance: expectedOpenCodeInstance }
            : managedSurfaces.opencodeInstance
              ? { removeManagedOpenCodeInstance: true }
              : {}),
          instance: {
            ...currentInstance,
            driver: "codex",
            displayName: "Moss",
            enabled: true,
            environment: expectedEnvironment,
            config: {
              ...refreshedConfig,
              ...(input.bundledCodexPath ? { binaryPath: input.bundledCodexPath } : {}),
              homePath: managedHomePath,
              accountId: MOSS_MANAGED_CODEX_ACCOUNT_ID,
              customModels: [...input.models],
              modelAllowlist: [...input.models],
              defaultModel,
              managed: true,
              gatewayBaseUrl: input.gatewayBaseUrl,
              credentialEnvKey: input.credentialEnvKey,
              runtimeGeneration,
            },
          },
        });
        return true;
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof MossCloudAccountServiceError ? cause : toProviderError(cause),
        ),
      );

    const provision = (input: {
      readonly authority: MossManagedGatewayAuthority;
      readonly accessToken: string;
      readonly gatewayBaseUrl: string;
      readonly models?: ReadonlyArray<string>;
      readonly cleanupAccessTokenHash?: string;
      readonly recoverStalePairedGeneration?: true;
      readonly selectionPolicy: "select" | "preserve";
    }) =>
      Effect.gen(function* () {
        const accessToken = input.accessToken.trim();
        if (!accessToken) {
          return yield* Effect.fail(
            new MossCloudAccountServiceError({
              code: "authentication_required",
              message: "A valid Moss account session is required.",
            }),
          );
        }
        const realm = mossAccessLaneForAuthority(input.authority);
        const models = resolveMossManagedModels({
          accountModels: input.models,
          processGatewayModel: process.env[MOSS_MANAGED_GATEWAY_MODEL_ENV_KEY],
          realm,
        });
        const gatewayCredential = yield* Effect.try({
          try: () =>
            resolveMossManagedGatewayCredential({
              authority: input.authority,
              gatewayBaseUrl: input.gatewayBaseUrl,
              processGatewayApiKey: process.env[MOSS_MANAGED_GATEWAY_API_KEY_ENV_KEY],
              env: process.env,
            }),
          catch: (cause) =>
            new MossCloudAccountServiceError({
              code: "provider_error",
              message:
                cause instanceof Error
                  ? cause.message
                  : "The managed Moss model gateway credentials are invalid.",
              cause,
            }),
        });
        const { gatewayBaseUrl, credentialEnvKey, useProcessGatewayApiKey } = gatewayCredential;
        const bundledCodexPath = resolveMossBundledCodexBinaryPath(process.env);
        let currentSettings = yield* settingsService.getSettings;
        if (hasOnlyUnownedManagedSelections(currentSettings)) {
          // Selections are routing pointers, not ownership records. Repair a
          // selection-only remnant before claiming a fresh reservation, then
          // re-read so a concurrent account/instance insertion is validated by
          // the normal provenance and lifecycle-home collision checks below.
          yield* repairUnownedManagedSelections(currentSettings);
          currentSettings = yield* settingsService.getSettings;
        }
        // Recovery is eligible only for the internal cleanup provenance that
        // is still present in the durable settings snapshot. A user settings
        // write clears this marker, so a stale in-memory decision cannot turn
        // a personal selection back into managed routing.
        const restoreManagedSelectionFromCleanup =
          input.selectionPolicy === "preserve" &&
          managedSelectionFallbackFromSettings(currentSettings) !== undefined;
        const reusedManagedInstance = yield* reuseMatchingManagedInstance({
          realm,
          settings: currentSettings,
          accessToken,
          gatewayBaseUrl,
          credentialEnvKey,
          useProcessGatewayApiKey,
          bundledCodexPath,
          models,
          cleanupAccessTokenHash: input.cleanupAccessTokenHash,
          restoreManagedSelectionFromCleanup,
          selectionPolicy: input.selectionPolicy,
        });
        if (reusedManagedInstance) return;
        const managedSurfaces = inspectVerifiedManagedSurfaces(
          currentSettings,
          accessToken,
          input.cleanupAccessTokenHash,
          input.recoverStalePairedGeneration === true,
          input.recoverStalePairedGeneration === true ? gatewayBaseUrl : undefined,
          input.recoverStalePairedGeneration === true ? credentialEnvKey : undefined,
        );
        let managedReservation = managedSurfaces.codexReservation;
        let recoverStagedPluginConfig = managedReservation?.provisioning === true;
        const currentInstance = managedSurfaces.codexInstance;
        const currentClaudeInstance = managedSurfaces.claudeInstance;
        const currentOpenCodeInstance = managedSurfaces.opencodeInstance;
        const currentPiInstance = managedSurfaces.piInstance;
        const currentRelayInstances = managedSurfaces.relayInstances;
        const runtimeGeneration = randomUUID();
        const hasVerifiedManagedSurface =
          currentInstance !== undefined ||
          currentClaudeInstance !== undefined ||
          currentOpenCodeInstance !== undefined ||
          currentPiInstance !== undefined ||
          Object.keys(currentRelayInstances).length > 0;
        if (input.recoverStalePairedGeneration === true && managedSurfaces.hasCollision) {
          return yield* Effect.fail(reservationConflict());
        }
        if (
          input.recoverStalePairedGeneration === true &&
          managedReservation &&
          currentClaudeInstance
        ) {
          // The coordinator proof contains no old bearer. Re-check the exact
          // managed-home marker before fencing the paired orphaned generation.
          yield* ensureVerifiedManagedHome(managedReservation);
        }
        if (hasVerifiedManagedSurface) {
          const cleanupAlreadyComplete =
            cleanupIsDurablyComplete(currentInstance) &&
            cleanupIsDurablyComplete(currentClaudeInstance) &&
            cleanupIsDurablyComplete(currentOpenCodeInstance) &&
            cleanupIsDurablyComplete(currentPiInstance) &&
            Object.values(currentRelayInstances).every(cleanupIsDurablyComplete);
          const migratedLegacyCleanup = cleanupAlreadyComplete
            ? false
            : yield* migrateLegacyCredentialFreeCleanup(
                managedSurfaces,
                accessToken,
                input.cleanupAccessTokenHash,
              );
          recoverStagedPluginConfig ||= migratedLegacyCleanup;
          // Every existing managed generation must be retired before a fresh
          // generation is exposed, including selection-preserving token
          // refreshes. Revoke both launch surfaces in settings first so a
          // failed shutdown cannot leave reusable secrets.
          if (!cleanupAlreadyComplete && !migratedLegacyCleanup) {
            yield* runMossManagedDisableSteps({
              disableProviderSettings: () =>
                fenceVerifiedManagedSurfaces({
                  selectionPolicy: "preserve",
                  expectedAccessToken: accessToken,
                  expectedAccessTokenHash: input.cleanupAccessTokenHash,
                  allowStalePairedCredential: input.recoverStalePairedGeneration === true,
                  ...(input.recoverStalePairedGeneration === true
                    ? {
                        expectedGatewayBaseUrl: gatewayBaseUrl,
                        expectedCredentialEnvKey: credentialEnvKey,
                      }
                    : {}),
                }),
              stopRuntimes: () =>
                stopVerifiedManagedRuntimesAndWait({
                  stopCodex:
                    currentInstance !== undefined && !managedSurfaces.hasLifecycleHomeCollision,
                  runtimeGeneration: runtimeGenerationFromConfig(currentInstance?.config),
                  checkClaude: currentClaudeInstance !== undefined,
                  checkOpenCode: currentOpenCodeInstance !== undefined,
                  checkPi: currentPiInstance !== undefined,
                  relayInstanceIds: Object.keys(currentRelayInstances),
                }).pipe(
                  Effect.mapError((cause) =>
                    cause instanceof MossCloudAccountServiceError ? cause : toProviderError(cause),
                  ),
                ),
              removeAccountOverlay: () =>
                currentInstance && managedReservation && !managedSurfaces.hasLifecycleHomeCollision
                  ? removeVerifiedManagedAccountOverlayIfPresent(managedReservation)
                  : Effect.void,
            });
          }
          if (managedSurfaces.hasCollision) return yield* Effect.fail(reservationConflict());
          if (!cleanupAlreadyComplete && !migratedLegacyCleanup) {
            yield* markVerifiedManagedCleanupComplete();
          }
        } else if (managedSurfaces.hasCollision) {
          return yield* Effect.fail(reservationConflict());
        }
        if (!managedReservation) {
          if (yield* fs.exists(managedHomePath)) {
            return yield* Effect.fail(
              new Error(
                "The pre-existing managed Moss home is not bound to a persisted managed reservation.",
              ),
            );
          }
          const ownershipNonce = randomUUID();
          yield* updateInstances({
            selectionPolicy: "preserve",
            instance: {
              driver: "codex",
              displayName: "Moss",
              enabled: false,
              environment: [],
              config: {
                homePath: managedHomePath,
                accountId: MOSS_MANAGED_CODEX_ACCOUNT_ID,
                managed: true,
                homeOwnershipNonce: ownershipNonce,
                homeProvisioningState: MOSS_MANAGED_HOME_PROVISIONING_STATE,
              },
            },
          });
          managedReservation = {
            ownershipNonce,
            provisioning: true,
          };
        }
        yield* prepareManagedHome(managedReservation);
        const verifiedManagedReservation = managedReservation;
        const bundledMarketplace = yield* materializeManagedPluginMarketplace(managedReservation);
        // Desktop keeps Moss catalog ids; the gateway resolves them against the OpenRouter upstream.
        const defaultModel = models[0] ?? MOSS_MANAGED_DEFAULT_MODEL;
        yield* writeManagedFileAtomically({
          filePath: managedModelCatalogPath,
          contents: buildMossManagedCodexModelCatalog(models),
        });
        yield* fs.chmod(managedModelCatalogPath, 0o600).pipe(Effect.orElseSucceed(() => undefined));
        yield* Effect.tryPromise(() =>
          writeMossManagedPluginConfig({
            managedHomePath,
            configPath: managedConfigPath,
            recoverStagedConfig: recoverStagedPluginConfig,
            assertCurrent: () => {
              assertSafeManagedHome(verifiedManagedReservation.ownershipNonce);
            },
            writeAtomically: (input) => Effect.runPromise(writeManagedFileAtomically(input)),
            generatedConfig: buildMossManagedCodexConfig({
              gatewayBaseUrl,
              defaultModel,
              credentialEnvKey,
              bundledPluginMarketplaceRoot: bundledMarketplace.root,
              modelCatalogPath: managedModelCatalogPath,
            }),
          }),
        );
        yield* fs.chmod(managedConfigPath, 0o600).pipe(Effect.orElseSucceed(() => undefined));
        yield* updateInstances({
          selectionPolicy: input.selectionPolicy,
          restoreManagedSelectionFromCleanup,
          removeManagedClaudeInstance: useProcessGatewayApiKey,
          relayInstances: useProcessGatewayApiKey
            ? {}
            : buildMossManagedRelayInstances({
                stateDir: config.stateDir,
                accessToken,
                gatewayBaseUrl,
                runtimeGeneration,
                realm,
                env: process.env,
              }),
          removeManagedRelayInstanceIds: useProcessGatewayApiKey
            ? Object.keys(currentRelayInstances)
            : [],
          ...(useProcessGatewayApiKey
            ? { removeManagedPiInstance: currentPiInstance !== undefined }
            : {
                piInstance: buildMossManagedPiProviderInstance({
                  accessToken,
                  gatewayBaseUrl,
                  runtimeGeneration,
                  realm,
                  agentDir: path.join(config.stateDir, "provider-homes", "pi", realm),
                  env: process.env,
                }),
              }),
          ...(useProcessGatewayApiKey
            ? { removeManagedOpenCodeInstance: currentOpenCodeInstance !== undefined }
            : {
                opencodeInstance: buildMossManagedOpenCodeInstance({
                  accessToken,
                  gatewayBaseUrl,
                  runtimeGeneration,
                  env: process.env,
                }),
              }),
          ...(!useProcessGatewayApiKey
            ? {
                claudeInstance: buildMossManagedClaudeInstance({
                  accessToken,
                  gatewayBaseUrl,
                  runtimeGeneration,
                  env: process.env,
                  realm,
                  ...(input.models ? { accountModels: input.models } : {}),
                }),
                enableManagedClaudeInstance: true,
              }
            : {}),
          instance: {
            driver: "codex",
            displayName: "Moss",
            enabled: true,
            environment: buildMossManagedProviderEnvironment({
              accessToken,
              gatewayBaseUrl,
              useProcessGatewayApiKey,
              env: process.env,
            }),
            config: {
              ...(bundledCodexPath ? { binaryPath: bundledCodexPath } : {}),
              homePath: managedHomePath,
              accountId: MOSS_MANAGED_CODEX_ACCOUNT_ID,
              customModels: [...models],
              modelAllowlist: [...models],
              defaultModel,
              managed: true,
              gatewayBaseUrl,
              credentialEnvKey,
              runtimeGeneration,
              ...(managedReservation.ownershipNonce
                ? { homeOwnershipNonce: managedReservation.ownershipNonce }
                : {}),
            },
          },
        });
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof MossCloudAccountServiceError ? cause : toProviderError(cause),
        ),
      );

    const disable: MossManagedProviderShape["disable"] = (input = {}) =>
      Effect.gen(function* () {
        const settings = yield* settingsService.getSettings;
        const managedSurfaces = inspectVerifiedManagedSurfacesWithCleanupFallback(settings, input);
        const current = managedSurfaces.codexInstance;
        const currentClaude = managedSurfaces.claudeInstance;
        const currentOpenCode = managedSurfaces.opencodeInstance;
        const currentPi = managedSurfaces.piInstance;
        const currentRelayInstances = managedSurfaces.relayInstances;
        if (
          !current &&
          !currentClaude &&
          !currentOpenCode &&
          !currentPi &&
          Object.keys(currentRelayInstances).length === 0
        ) {
          // Signed-out reconciliation may run against an unowned fixed home.
          // With no verified managed surface, only repair demonstrably stale
          // Moss selections; never stop by home identity or touch its overlay.
          yield* repairUnownedManagedSelections(settings);
          if (managedSurfaces.hasCollision) return yield* Effect.fail(reservationConflict());
          yield* ensureCredentialFreeManagedFence();
          return;
        }
        // Credential fencing is settings-authoritative. Filesystem ownership
        // is checked only after the exact managed records are durably disabled.
        const durableFenceAlreadyPresent =
          launchSurfaceIsDurablyDisabled(current) &&
          launchSurfaceIsDurablyDisabled(currentClaude) &&
          launchSurfaceIsDurablyDisabled(currentOpenCode) &&
          launchSurfaceIsDurablyDisabled(currentPi) &&
          Object.values(currentRelayInstances).every(launchSurfaceIsDurablyDisabled);
        yield* runMossManagedDisableSteps({
          durableFenceAlreadyPresent:
            durableFenceAlreadyPresent &&
            cleanupIsDurablyComplete(current) &&
            cleanupIsDurablyComplete(currentClaude) &&
            cleanupIsDurablyComplete(currentOpenCode) &&
            cleanupIsDurablyComplete(currentPi) &&
            Object.values(currentRelayInstances).every(cleanupIsDurablyComplete),
          disableProviderSettings: () =>
            fenceVerifiedManagedSurfaces({
              selectionPolicy: "fallback-if-selected",
              expectedAccessToken: input.expectedAccessToken,
              cleanupFallbackAccessToken: input.cleanupFallbackAccessToken,
            }),
          stopRuntimes: () =>
            stopVerifiedManagedRuntimesAndWait({
              stopCodex: current !== undefined && !managedSurfaces.hasLifecycleHomeCollision,
              runtimeGeneration: runtimeGenerationFromConfig(current?.config),
              checkClaude: currentClaude !== undefined,
              checkOpenCode: currentOpenCode !== undefined,
              checkPi: currentPi !== undefined,
              relayInstanceIds: Object.keys(currentRelayInstances),
            }).pipe(
              Effect.mapError((cause) =>
                cause instanceof MossCloudAccountServiceError ? cause : toProviderError(cause),
              ),
            ),
          removeAccountOverlay: () =>
            current &&
            managedSurfaces.codexReservation &&
            !managedSurfaces.hasLifecycleHomeCollision
              ? removeVerifiedManagedAccountOverlayIfPresent(managedSurfaces.codexReservation)
              : Effect.void,
        });
        if (managedSurfaces.hasCollision) return yield* Effect.fail(reservationConflict());
        yield* markVerifiedManagedCleanupComplete();
        yield* ensureCredentialFreeManagedFence();
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof MossCloudAccountServiceError ? cause : toProviderError(cause),
        ),
        Effect.asVoid,
      );

    const needsDisable = () =>
      settingsService.getSettings.pipe(
        Effect.map((settings) => {
          const managedSurfaces = inspectVerifiedManagedSurfaces(settings);
          if (managedSurfaces.hasCollision) return true;
          // Any verified legacy OpenCode record, including a credential-free
          // tombstone left by an older build, still needs one disable pass so
          // the safe fence/drain path can remove it.
          if (
            managedSurfaces.opencodeInstance !== undefined ||
            managedSurfaces.piInstance !== undefined ||
            Object.keys(managedSurfaces.relayInstances).length > 0
          )
            return true;
          return (
            !launchSurfaceIsDurablyDisabled(
              settings.providerInstances[MOSS_MANAGED_PROVIDER_INSTANCE_ID],
            ) ||
            !launchSurfaceIsDurablyDisabled(
              settings.providerInstances[MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID],
            ) ||
            !launchSurfaceIsDurablyDisabled(
              settings.providerInstances[MOSS_MANAGED_OPENCODE_PROVIDER_INSTANCE_ID],
            )
          );
        }),
        Effect.mapError(toProviderError),
      );

    const getProvisioningState = (input: {
      readonly authority: MossManagedGatewayAuthority;
      readonly accessToken: string;
      readonly gatewayBaseUrl: string;
    }) =>
      Effect.gen(function* () {
        let gatewayCredential: ReturnType<typeof resolveMossManagedGatewayCredential>;
        try {
          gatewayCredential = resolveMossManagedGatewayCredential({
            authority: input.authority,
            gatewayBaseUrl: input.gatewayBaseUrl,
            processGatewayApiKey: process.env[MOSS_MANAGED_GATEWAY_API_KEY_ENV_KEY],
            env: process.env,
          });
        } catch {
          return "stale" as const;
        }

        const settings = yield* settingsService.getSettings;
        const ownershipSurfaces = inspectVerifiedManagedSurfaces(
          settings,
          requiresPreviousCnGatewayCleanup(settings) ? input.accessToken : undefined,
          undefined,
          true,
          gatewayCredential.gatewayBaseUrl,
          gatewayCredential.credentialEnvKey,
        );
        if (ownershipSurfaces.hasCollision) return "collision" as const;
        const managedSurfaces = inspectVerifiedManagedSurfaces(settings, input.accessToken);
        const recoverableSurfaces = inspectVerifiedManagedSurfaces(
          settings,
          input.accessToken,
          undefined,
          true,
          gatewayCredential.gatewayBaseUrl,
          gatewayCredential.credentialEnvKey,
        );
        const recoverableCodex = recoverableSurfaces.codexInstance;
        const recoverableClaude = recoverableSurfaces.claudeInstance;
        if (
          !gatewayCredential.useProcessGatewayApiKey &&
          !recoverableSurfaces.hasCollision &&
          isCleanupPendingMossManagedPair({
            codexInstance: recoverableCodex,
            claudeInstance: recoverableClaude,
            codexReservation: recoverableSurfaces.codexReservation,
          })
        ) {
          return yield* ensureVerifiedManagedHome(recoverableSurfaces.codexReservation!).pipe(
            Effect.as("recoverable-stale" as const),
            Effect.catch(() => Effect.succeed("stale" as const)),
          );
        }
        const currentInstance = managedSurfaces.codexInstance;
        if (
          currentInstance === undefined ||
          currentInstance.enabled === false ||
          managedSurfaces.codexReservation === undefined
        ) {
          return "stale" as const;
        }

        const expectedEnvironment = buildMossManagedProviderEnvironment({
          accessToken: input.accessToken,
          gatewayBaseUrl: gatewayCredential.gatewayBaseUrl,
          useProcessGatewayApiKey: gatewayCredential.useProcessGatewayApiKey,
          env: process.env,
        });
        const currentEnvironment = currentInstance.environment ?? [];
        const environmentsMatch =
          currentEnvironment.length === expectedEnvironment.length &&
          currentEnvironment.every((entry, index) => {
            const expected = expectedEnvironment[index];
            return (
              expected !== undefined &&
              entry.name === expected.name &&
              entry.value === expected.value &&
              entry.sensitive === expected.sensitive
            );
          });
        const currentConfig = asConfigRecord(currentInstance.config);
        const runtimeGeneration = currentConfig.runtimeGeneration;
        if (
          !environmentsMatch ||
          currentConfig.gatewayBaseUrl !== gatewayCredential.gatewayBaseUrl ||
          currentConfig.credentialEnvKey !== gatewayCredential.credentialEnvKey ||
          typeof runtimeGeneration !== "string" ||
          !runtimeGeneration.trim()
        ) {
          return "stale" as const;
        }

        const expectedOpenCodeInstance = !gatewayCredential.useProcessGatewayApiKey
          ? buildMossManagedOpenCodeInstance({
              accessToken: input.accessToken,
              gatewayBaseUrl: gatewayCredential.gatewayBaseUrl,
              runtimeGeneration,
              env: process.env,
            })
          : undefined;
        const currentOpenCode = managedSurfaces.opencodeInstance;
        const currentOpenCodeConfig = asConfigRecord(currentOpenCode?.config);
        const currentOpenCodeToken = currentOpenCode?.environment?.find(
          (entry) => entry.name === MOSS_MANAGED_OPENCODE_CREDENTIAL_ENV_KEY,
        )?.value;
        const expectedOpenCodeConfig = asConfigRecord(expectedOpenCodeInstance?.config);
        const openCodeReady = expectedOpenCodeInstance
          ? currentOpenCode !== undefined &&
            isVerifiedMossManagedOpenCodeInstance(currentOpenCode, process.env) &&
            currentOpenCodeToken === input.accessToken &&
            currentOpenCodeConfig.gatewayBaseUrl === expectedOpenCodeConfig.gatewayBaseUrl &&
            currentOpenCodeConfig.runtimeGeneration === runtimeGeneration
          : currentOpenCode === undefined;
        if (!openCodeReady) return "stale" as const;
        const realm = mossAccessLaneForAuthority(input.authority);
        const expectedPiInstance = !gatewayCredential.useProcessGatewayApiKey
          ? buildMossManagedPiProviderInstance({
              accessToken: input.accessToken,
              gatewayBaseUrl: gatewayCredential.gatewayBaseUrl,
              runtimeGeneration,
              realm,
              agentDir: path.join(config.stateDir, "provider-homes", "pi", realm),
              env: process.env,
            })
          : undefined;
        if (!matchesMossManagedPiProviderInstance(managedSurfaces.piInstance, expectedPiInstance))
          return "stale" as const;
        const expectedRelayInstances = gatewayCredential.useProcessGatewayApiKey
          ? {}
          : buildMossManagedRelayInstances({
              stateDir: config.stateDir,
              accessToken: input.accessToken,
              gatewayBaseUrl: gatewayCredential.gatewayBaseUrl,
              runtimeGeneration,
              realm,
              env: process.env,
            });
        if (
          !matchesMossManagedRelayInstances(managedSurfaces.relayInstances, expectedRelayInstances)
        )
          return "stale" as const;

        if (gatewayCredential.useProcessGatewayApiKey) {
          if (managedSurfaces.claudeInstance !== undefined) return "stale" as const;
        } else {
          const expectedClaudeInstance = buildMossManagedClaudeInstance({
            accessToken: input.accessToken,
            gatewayBaseUrl: gatewayCredential.gatewayBaseUrl,
            runtimeGeneration,
            env: process.env,
            realm: mossAccessLaneForAuthority(input.authority),
          });
          const currentClaudeInstance = managedSurfaces.claudeInstance;
          const currentClaudeConfig = asConfigRecord(currentClaudeInstance?.config);
          const expectedClaudeConfig = asConfigRecord(expectedClaudeInstance.config);
          const currentClaudeEnvironment = currentClaudeInstance?.environment ?? [];
          const expectedClaudeEnvironment = expectedClaudeInstance.environment ?? [];
          const claudeEnvironmentMatches =
            currentClaudeEnvironment.length === expectedClaudeEnvironment.length &&
            currentClaudeEnvironment.every((entry, index) => {
              const expected = expectedClaudeEnvironment[index];
              return (
                expected !== undefined &&
                entry.name === expected.name &&
                entry.value === expected.value &&
                entry.sensitive === expected.sensitive
              );
            });
          if (
            currentClaudeInstance === undefined ||
            currentClaudeInstance.enabled === false ||
            !claudeEnvironmentMatches ||
            currentClaudeConfig.gatewayBaseUrl !== expectedClaudeConfig.gatewayBaseUrl ||
            currentClaudeConfig.runtimeGeneration !== runtimeGeneration
          ) {
            return "stale" as const;
          }
        }

        // The Codex catalog projection ships with the app. A stale models.json
        // (older field set, older ladder) must trigger a re-provision, otherwise
        // Codex silently drops the catalog and the picker collapses to the
        // config.toml default model.
        const currentModels = Array.isArray(currentConfig.modelAllowlist)
          ? currentConfig.modelAllowlist.filter(
              (entry): entry is string => typeof entry === "string" && entry.length > 0,
            )
          : [];
        const currentCatalog = yield* fs
          .readFileString(managedModelCatalogPath)
          .pipe(Effect.orElseSucceed(() => undefined));
        if (
          currentModels.length === 0 ||
          currentCatalog !== buildMossManagedCodexModelCatalog(currentModels)
        ) {
          return "stale" as const;
        }

        return yield* ensureVerifiedManagedHome(managedSurfaces.codexReservation).pipe(
          Effect.as("ready" as const),
          Effect.catch(() => Effect.succeed("stale" as const)),
        );
      }).pipe(Effect.mapError(toProviderError));

    return {
      needsDisable: () => withMossAccountLifecycleLock(settingsService, needsDisable()),
      getProvisioningState: (input) =>
        withMossAccountLifecycleLock(settingsService, getProvisioningState(input)),
      provision: (input) => withMossAccountLifecycleLock(settingsService, provision(input)),
      disable: (input) => withMossAccountLifecycleLock(settingsService, disable(input)),
    };
  }),
);
