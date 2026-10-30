// FILE: ccSwitchChannels.ts
// Purpose: Materialize the small, audited subset of CC Switch provider presets that Moss supports.
// Layer: Web settings helper

import type {
  ProviderInstanceConfig,
  ProviderInstanceConfigMap,
  ProviderInstanceId,
} from "@synara/contracts";

export const KIMI_CHANNEL_INSTANCE_ID = "claude_kimi" as ProviderInstanceId;
export const KIMI_CHANNEL_MODEL = "kimi-for-coding";
export const KIMI_CHANNEL_MODEL_LABEL = "K3";
export const KIMI_CHANNEL_BASE_URL = "https://api.kimi.com/coding/";

const KIMI_CHANNEL_ID = "kimi-coding-plan";
const KIMI_CONTEXT_WINDOW = "262144";
const KIMI_AUTH_ENV_KEY = "ANTHROPIC_AUTH_TOKEN";

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

function configRecord(instance: ProviderInstanceConfig | undefined): Record<string, unknown> {
  const config = instance?.config;
  return config !== null && typeof config === "object" && !Array.isArray(config)
    ? (config as Record<string, unknown>)
    : {};
}

function environmentValue(
  instance: ProviderInstanceConfig | undefined,
  name: string,
): string | undefined {
  return instance?.environment?.find((entry) => entry.name === name)?.value;
}

function hasStoredCredential(instance: ProviderInstanceConfig | undefined): boolean {
  const credential = instance?.environment?.find((entry) => entry.name === KIMI_AUTH_ENV_KEY);
  return (
    credential?.sensitive === true &&
    (credential.valueRedacted === true || Boolean(credential.value?.trim()))
  );
}

export function normalizeKimiApiKey(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > 4096 || containsControlCharacter(normalized)) {
    throw new Error("Enter a valid Kimi Coding Plan API key.");
  }
  return normalized;
}

/**
 * CC Switch 3.18's Kimi For Coding preset, stored as a normal isolated Moss
 * Claude instance. The secret is persisted by Moss's existing secret store.
 */
export function buildKimiChannelInstance(apiKey: string): ProviderInstanceConfig {
  const token = normalizeKimiApiKey(apiKey);
  return {
    driver: "claudeAgent",
    displayName: "Kimi",
    enabled: true,
    environment: [
      { name: "ANTHROPIC_BASE_URL", value: KIMI_CHANNEL_BASE_URL, sensitive: false },
      { name: KIMI_AUTH_ENV_KEY, value: token, sensitive: true },
      { name: "ANTHROPIC_MODEL", value: KIMI_CHANNEL_MODEL, sensitive: false },
      { name: "ANTHROPIC_DEFAULT_HAIKU_MODEL", value: KIMI_CHANNEL_MODEL, sensitive: false },
      { name: "ANTHROPIC_DEFAULT_SONNET_MODEL", value: KIMI_CHANNEL_MODEL, sensitive: false },
      { name: "ANTHROPIC_DEFAULT_OPUS_MODEL", value: KIMI_CHANNEL_MODEL, sensitive: false },
      { name: "CLAUDE_CODE_MAX_CONTEXT_TOKENS", value: KIMI_CONTEXT_WINDOW, sensitive: false },
      { name: "CLAUDE_CODE_AUTO_COMPACT_WINDOW", value: KIMI_CONTEXT_WINDOW, sensitive: false },
    ],
    config: {
      serviceChannel: KIMI_CHANNEL_ID,
      serviceChannelSource: "cc-switch",
      protocol: "anthropic-messages",
      defaultModel: KIMI_CHANNEL_MODEL,
      customModels: [KIMI_CHANNEL_MODEL],
      modelAllowlist: [KIMI_CHANNEL_MODEL],
    },
  };
}

/** Fail closed if a generic provider record merely reuses the reserved id. */
export function isKimiChannelConfigured(instance: ProviderInstanceConfig | undefined): boolean {
  const config = configRecord(instance);
  return (
    instance?.driver === "claudeAgent" &&
    instance.enabled !== false &&
    config.serviceChannel === KIMI_CHANNEL_ID &&
    config.serviceChannelSource === "cc-switch" &&
    config.protocol === "anthropic-messages" &&
    config.defaultModel === KIMI_CHANNEL_MODEL &&
    environmentValue(instance, "ANTHROPIC_BASE_URL") === KIMI_CHANNEL_BASE_URL &&
    environmentValue(instance, "ANTHROPIC_MODEL") === KIMI_CHANNEL_MODEL &&
    hasStoredCredential(instance)
  );
}

export function saveKimiChannel(
  providerInstances: ProviderInstanceConfigMap,
  apiKey: string,
): ProviderInstanceConfigMap {
  return {
    ...providerInstances,
    [KIMI_CHANNEL_INSTANCE_ID]: buildKimiChannelInstance(apiKey),
  } as ProviderInstanceConfigMap;
}

export function removeKimiChannel(
  providerInstances: ProviderInstanceConfigMap,
): ProviderInstanceConfigMap {
  const next = { ...providerInstances };
  delete next[KIMI_CHANNEL_INSTANCE_ID];
  return next as ProviderInstanceConfigMap;
}
