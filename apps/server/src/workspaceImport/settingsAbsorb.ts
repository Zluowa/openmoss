// FILE: settingsAbsorb.ts
// Purpose: Map Claude Code / Cursor settings onto the honor-able Moss subset.
//          Never touches account, payment, hosted routing, or reserved instances.
// Layer: Server import helper

import type {
  ServerSettings,
  ServerSettingsPatch,
  SupportedProviderKind,
  WorkspaceImportClientPreferences,
  WorkspaceImportLocalePreference,
  WorkspaceImportSettingChange,
  WorkspaceImportSourceKind,
  WorkspaceImportThemePreference,
} from "@synara/contracts";
import {
  MODEL_OPTIONS_BY_PROVIDER,
  MODEL_SLUG_ALIASES_BY_PROVIDER,
  normalizeWorkspaceImportSource,
} from "@synara/contracts";
import { normalizeModelSlug } from "@synara/shared/model";

const SKIP_ACCOUNT_PAYMENT_ROUTING = "Moss account, payment, and hosted routing stay unchanged.";
const SKIP_UNSUPPORTED = "Moss cannot honor this setting.";
const SKIP_CREDENTIAL = "Credentials and secrets are never imported.";
const SKIP_MCP_PLUGIN = "MCP servers and plugins are not installed by Import.";
const SKIP_UNKNOWN_MODEL = "Model is not a known Moss model for this provider.";
const SKIP_INVALID_MODEL = "Model id contains unsupported characters.";
const SKIP_EXTERNAL_ENDPOINT =
  "External endpoints require explicit provider setup and are never imported automatically.";

const FORBIDDEN_KEY_PATTERN =
  /(api[-_]?key|token|secret|password|credential|authorization|moss[-_]?pay|account|routing)/i;
const MCP_PLUGIN_KEY_PATTERN = /(mcp|plugin|marketplace)/i;

export interface AbsorbedWorkspaceSettings {
  readonly patch: ServerSettingsPatch;
  readonly changes: WorkspaceImportSettingChange[];
  readonly clientPreferences: WorkspaceImportClientPreferences;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function honorKnownModelSlug(provider: SupportedProviderKind, slug: string): string | null {
  const normalized = normalizeModelSlug(slug, provider);
  if (!normalized) {
    return null;
  }
  const aliases = MODEL_SLUG_ALIASES_BY_PROVIDER[provider];
  const aliased = aliases[normalized] ?? aliases[slug.trim()] ?? normalized;
  return MODEL_OPTIONS_BY_PROVIDER[provider].some((option) => option.slug === aliased)
    ? aliased
    : null;
}

function honorCodexModelSlug(slug: string): string | null {
  const known = honorKnownModelSlug("codex", slug);
  if (known) return known;
  // Codex's model catalog can be newer than Moss's built-in catalog. Preserve
  // a plain provider model id as a custom model, while rejecting values that
  // could be interpreted as a path, option or shell fragment.
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(slug) ? slug : null;
}

function mapTheme(value: unknown): WorkspaceImportThemePreference | null {
  const raw = readString(value)?.toLowerCase();
  if (!raw) {
    return null;
  }
  if (raw === "light" || raw.includes("light") || raw.includes("quiet light")) {
    return "light";
  }
  if (raw === "dark" || raw.includes("dark") || raw.includes("quiet dark")) {
    return "dark";
  }
  if (raw === "system" || raw === "auto" || raw.includes("auto detect")) {
    return "system";
  }
  return null;
}

function mapLocale(value: unknown): WorkspaceImportLocalePreference | null {
  const raw = readString(value)?.toLowerCase();
  if (!raw) {
    return null;
  }
  if (raw === "en" || raw.startsWith("en-") || raw === "english") {
    return "en";
  }
  if (raw === "zh-cn" || raw === "zh" || raw.startsWith("zh-") || raw.includes("chinese")) {
    return "zh-CN";
  }
  return null;
}

function readBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  const raw = readString(value)?.toLowerCase();
  if (raw === "true" || raw === "on" || raw === "enabled") {
    return true;
  }
  if (raw === "false" || raw === "off" || raw === "disabled") {
    return false;
  }
  return null;
}

function skipReasonForKey(key: string): string | null {
  if (FORBIDDEN_KEY_PATTERN.test(key)) {
    return key.toLowerCase().includes("account") ||
      key.toLowerCase().includes("pay") ||
      key.toLowerCase().includes("routing")
      ? SKIP_ACCOUNT_PAYMENT_ROUTING
      : SKIP_CREDENTIAL;
  }
  if (MCP_PLUGIN_KEY_PATTERN.test(key)) {
    return SKIP_MCP_PLUGIN;
  }
  return null;
}

function collectUnknownKeys(
  raw: Record<string, unknown>,
  knownKeys: ReadonlySet<string>,
): WorkspaceImportSettingChange[] {
  return Object.keys(raw)
    .filter((key) => !knownKeys.has(key))
    .map((key) => ({
      key,
      action: "skipped" as const,
      reason: skipReasonForKey(key) ?? SKIP_UNSUPPORTED,
    }));
}

function mergeCustomModels(current: readonly string[], incoming: string): string[] {
  return current.includes(incoming) ? [...current] : [...current, incoming];
}

export function sanitizeImportSettingsPatch(
  patch: ServerSettingsPatch,
  options: { readonly allowCodexSafeSettings?: boolean } = {},
): ServerSettingsPatch {
  const {
    providerInstances: _providerInstances,
    textGenerationModelSelection: _routing,
    ...rest
  } = patch;
  if (!rest.providers) {
    return rest;
  }
  const codex = rest.providers.codex;
  const providers = { ...rest.providers } as Record<string, unknown>;
  delete providers.codex;
  if (options.allowCodexSafeSettings && codex?.customModels) {
    providers.codex = { customModels: [...codex.customModels] };
  }
  if (Object.keys(providers).length === 0) {
    const { providers: _providers, ...withoutProviders } = rest;
    return withoutProviders;
  }
  return { ...rest, providers: providers as NonNullable<ServerSettingsPatch["providers"]> };
}

export function absorbHonorAbleSettings(input: {
  readonly source: WorkspaceImportSourceKind;
  readonly raw: unknown;
  readonly current: ServerSettings;
}): AbsorbedWorkspaceSettings {
  const raw = asRecord(input.raw) ?? {};
  const changes: WorkspaceImportSettingChange[] = [];
  const clientPreferences: {
    theme?: WorkspaceImportThemePreference;
    locale?: WorkspaceImportLocalePreference;
  } = {};
  let patch: ServerSettingsPatch = {};
  const knownKeys = new Set<string>();

  const applyTheme = (key: string, value: unknown) => {
    knownKeys.add(key);
    const theme = mapTheme(value);
    if (theme) {
      clientPreferences.theme = theme;
      changes.push({ key, action: "applied" });
      return;
    }
    if (value !== undefined) {
      changes.push({ key, action: "skipped", reason: SKIP_UNSUPPORTED });
    }
  };

  const applyLocale = (key: string, value: unknown) => {
    knownKeys.add(key);
    const locale = mapLocale(value);
    if (locale) {
      clientPreferences.locale = locale;
      changes.push({ key, action: "applied" });
      return;
    }
    if (value !== undefined) {
      changes.push({ key, action: "skipped", reason: SKIP_UNSUPPORTED });
    }
  };

  const applyStreaming = (key: string, value: unknown) => {
    knownKeys.add(key);
    const enabled = readBoolean(value);
    if (enabled === null) {
      if (value !== undefined) {
        changes.push({ key, action: "skipped", reason: SKIP_UNSUPPORTED });
      }
      return;
    }
    patch = { ...patch, enableAssistantStreaming: enabled };
    changes.push({ key, action: "applied" });
  };

  const applyModel = (
    key: string,
    provider: SupportedProviderKind,
    value: unknown,
    options: { readonly allowUnknownCodexModel?: boolean } = {},
  ) => {
    knownKeys.add(key);
    const slug = readString(value);
    if (!slug) {
      if (value !== undefined) {
        changes.push({ key, action: "skipped", reason: SKIP_UNSUPPORTED });
      }
      return;
    }
    const honored =
      provider === "codex" && options.allowUnknownCodexModel
        ? honorCodexModelSlug(slug)
        : honorKnownModelSlug(provider, slug);
    if (!honored) {
      changes.push({
        key,
        action: "skipped",
        reason:
          provider === "codex" && options.allowUnknownCodexModel
            ? SKIP_INVALID_MODEL
            : SKIP_UNKNOWN_MODEL,
      });
      return;
    }
    const currentModels = input.current.providers?.[provider]?.customModels ?? [];
    patch = {
      ...patch,
      providers: {
        ...patch.providers,
        [provider]: {
          ...patch.providers?.[provider],
          customModels: mergeCustomModels(currentModels, honored),
        },
      },
    };
    changes.push({ key, action: "applied" });
  };

  const skipExternalEndpoint = (key: string, value: unknown) => {
    knownKeys.add(key);
    if (value !== undefined) {
      changes.push({ key, action: "skipped", reason: SKIP_EXTERNAL_ENDPOINT });
    }
  };

  const source = normalizeWorkspaceImportSource(input.source);
  if (source === "claude") {
    applyTheme("theme", raw.theme ?? raw.preferredTheme ?? raw.appearance);
    applyLocale("locale", raw.locale ?? raw.language);
    applyStreaming("stream", raw.stream ?? raw.streaming ?? raw.enableStreaming);
    applyModel("model", "claudeAgent", raw.model ?? raw.defaultModel);
  } else if (source === "cursor") {
    applyTheme(
      "workbench.colorTheme",
      raw["workbench.colorTheme"] ?? raw.theme ?? raw["window.autoDetectColorScheme"],
    );
    applyLocale("locale", raw.locale ?? raw["locale"]);
    applyStreaming(
      "cursor.general.enableStreaming",
      raw["cursor.general.enableStreaming"] ?? raw.streaming,
    );
    applyModel(
      "cursor.general.defaultModel",
      "cursor",
      raw["cursor.general.defaultModel"] ??
        raw["cursor.cpp.defaultModel"] ??
        raw["cursor.model"] ??
        raw.model,
    );
    skipExternalEndpoint(
      "cursor.apiEndpoint",
      raw["cursor.apiEndpoint"] ?? raw["cursor.apiBaseUrl"] ?? raw.apiEndpoint,
    );
  } else if (source === "codex") {
    applyTheme("theme", raw.theme ?? raw.appearance ?? raw["tui.theme"]);
    applyLocale("locale", raw.locale ?? raw.language);
    applyStreaming("stream", raw.stream ?? raw.streaming ?? raw.enableStreaming);
    applyModel("model", "codex", raw.model ?? raw.defaultModel, {
      allowUnknownCodexModel: true,
    });
    knownKeys.add("model_reasoning_effort");
    const reasoningEffort = readString(raw.model_reasoning_effort);
    if (reasoningEffort) {
      changes.push({ key: "model_reasoning_effort", action: "skipped", reason: SKIP_UNSUPPORTED });
    }
  } else if (source === "grok") {
    applyTheme("theme", raw.theme ?? raw.appearance ?? raw.colorScheme);
    applyLocale("locale", raw.locale ?? raw.language);
    applyStreaming("stream", raw.stream ?? raw.streaming ?? raw.enableStreaming);
    applyModel("model", "grok", raw.model ?? raw.defaultModel ?? raw.default_model);
  } else {
    applyTheme("theme", raw.theme ?? raw.appearance ?? raw.colorScheme);
    applyLocale("locale", raw.locale ?? raw.language);
    applyStreaming("stream", raw.stream ?? raw.streaming ?? raw.enableStreaming);
    applyModel("model", "opencode", raw.model ?? raw.defaultModel ?? raw.default_model);
    skipExternalEndpoint("serverUrl", raw.serverUrl ?? raw.baseUrl ?? raw.endpoint ?? raw.url);
  }

  changes.push(...collectUnknownKeys(raw, knownKeys));
  return {
    patch: sanitizeImportSettingsPatch(patch, { allowCodexSafeSettings: source === "codex" }),
    changes,
    clientPreferences,
  };
}

export function mergeAbsorbedSettings(
  results: readonly AbsorbedWorkspaceSettings[],
): AbsorbedWorkspaceSettings {
  const changes: WorkspaceImportSettingChange[] = [];
  let patch: ServerSettingsPatch = {};
  const clientPreferences: {
    theme?: WorkspaceImportThemePreference;
    locale?: WorkspaceImportLocalePreference;
  } = {};
  for (const result of results) {
    changes.push(...result.changes);
    const previousProviders = patch.providers;
    const mergedPatch = Object.assign({}, patch, result.patch);
    patch =
      previousProviders || result.patch.providers
        ? Object.assign(mergedPatch, {
            providers: Object.assign({}, previousProviders, result.patch.providers),
          })
        : mergedPatch;
    if (result.clientPreferences.theme) {
      clientPreferences.theme = result.clientPreferences.theme;
    }
    if (result.clientPreferences.locale) {
      clientPreferences.locale = result.clientPreferences.locale;
    }
  }
  const sanitized = sanitizeImportSettingsPatch(patch, { allowCodexSafeSettings: true });
  return {
    patch: sanitized,
    changes,
    clientPreferences,
  };
}
