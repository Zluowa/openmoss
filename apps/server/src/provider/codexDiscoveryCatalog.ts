// FILE: codexDiscoveryCatalog.ts
// Purpose: Normalize Codex app-server discovery responses into provider contracts.
// Layer: Server provider domain
// Exports: Pure skills, plugin, and model discovery response parsers.

import {
  ProviderListModelsResult,
  ProviderListPluginsResult,
  ProviderPluginAppSummary,
  ProviderPluginDescriptor,
  ProviderPluginDetail,
  type ProviderSkillDescriptor,
} from "@synara/contracts";
import { MOSS_CODEX_RESPONSES_MODEL_IDS } from "@synara/shared/mossManagedModelCatalog";
import { mossLaneEngineModelIds, type MossAccessLane } from "@synara/shared/mossRealmCatalog";
import { Schema } from "effect";

import { pathIsWithin } from "./claudePluginSkills.ts";

export const MOSS_MANAGED_DISCOVERY_MODEL_SLUGS = MOSS_CODEX_RESPONSES_MODEL_IDS;

const MOSS_MANAGED_DISCOVERY_MODEL_SLUG_SET = new Set<string>(MOSS_MANAGED_DISCOVERY_MODEL_SLUGS);

function readObject(value: unknown, key?: string): Record<string, unknown> | undefined {
  const target =
    key === undefined
      ? value
      : value && typeof value === "object"
        ? (value as Record<string, unknown>)[key]
        : undefined;

  return target && typeof target === "object" ? (target as Record<string, unknown>) : undefined;
}

function readArray(value: unknown, key?: string): unknown[] | undefined {
  const target =
    key === undefined
      ? value
      : value && typeof value === "object"
        ? (value as Record<string, unknown>)[key]
        : undefined;
  return Array.isArray(target) ? target : undefined;
}

function readString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function readBoolean(value: unknown, key: string): boolean | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "boolean" ? candidate : undefined;
}

function readFirstBoolean(value: unknown, keys: readonly string[]): boolean | undefined {
  for (const key of keys) {
    const candidate = readBoolean(value, key);
    if (candidate !== undefined) {
      return candidate;
    }
  }
  return undefined;
}

function parseSkillDescriptor(skill: unknown): ProviderSkillDescriptor | undefined {
  const record = readObject(skill);
  if (!record) return undefined;
  const name = readString(record, "name")?.trim();
  const path = readString(record, "path")?.trim();
  if (!name || !path) {
    return undefined;
  }
  const description = readString(record, "description")?.trim();
  const scope = readString(record, "scope")?.trim();
  const display = readObject(record, "interface");
  const displayText = (...keys: string[]) => {
    for (const key of keys) {
      const value = readString(display, key)?.trim();
      if (value) return value;
    }
    return undefined;
  };
  const iconSmall = displayText("iconSmall", "iconLarge");
  const iconSmallUrl = displayText("iconSmallUrl", "iconLargeUrl");
  const brandColor = displayText("brandColor");
  return {
    name,
    path,
    enabled: record.enabled !== false,
    ...(description ? { description } : {}),
    ...(scope ? { scope } : {}),
    ...(display
      ? {
          interface: {
            ...(readString(display, "displayName")
              ? { displayName: readString(display, "displayName") }
              : {}),
            ...(readString(display, "shortDescription")
              ? { shortDescription: readString(display, "shortDescription") }
              : {}),
            ...(iconSmall ? { iconSmall } : {}),
            ...(iconSmallUrl ? { iconSmallUrl } : {}),
            ...(brandColor ? { brandColor } : {}),
          },
        }
      : {}),
    ...(record.dependencies !== undefined ? { dependencies: record.dependencies } : {}),
  } satisfies ProviderSkillDescriptor;
}

export function parseCodexSkillsListResponse(
  response: unknown,
  cwd: string,
): ProviderSkillDescriptor[] {
  const responseRecord = readObject(response);
  const resultRecord = readObject(responseRecord, "result") ?? responseRecord;
  const dataItems = readArray(resultRecord, "data") ?? [];
  const scopedData = dataItems.find((value) => {
    const item = readObject(value);
    return readString(item, "cwd") === cwd;
  });
  const scopedSkills = readArray(readObject(scopedData), "skills");
  const directSkills = readArray(resultRecord, "skills");
  const rawSkills = scopedSkills ?? directSkills ?? [];

  const parsedSkills = rawSkills.flatMap((skill) => {
    const parsedSkill = parseSkillDescriptor(skill);
    return parsedSkill ? [parsedSkill] : [];
  });

  return parsedSkills.toSorted((a, b) => a.name.localeCompare(b.name));
}

/**
 * Moss's portable skills root is a fallback for Codex as for every CLI: where
 * Codex has its own skill of the same name (its bundled skill-creator), Codex
 * keeps using it and the Moss copy is not listed a second time.
 */
export function withoutShadowedMossSkills(
  skills: ReadonlyArray<ProviderSkillDescriptor>,
  mossSkillsDir: string | undefined,
): ProviderSkillDescriptor[] {
  if (!mossSkillsDir) return [...skills];
  const fromMoss = (skill: ProviderSkillDescriptor) => pathIsWithin(mossSkillsDir, skill.path);
  const nativeNames = new Set(
    skills.filter((skill) => !fromMoss(skill)).map((skill) => skill.name.toLowerCase()),
  );
  return skills.filter((skill) => !fromMoss(skill) || !nativeNames.has(skill.name.toLowerCase()));
}

function parsePluginInterface(value: unknown): ProviderPluginDescriptor["interface"] | undefined {
  const record = readObject(value);
  if (!record) return undefined;
  const capabilities = (readArray(record, "capabilities") ?? [])
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  const defaultPrompt = (readArray(record, "defaultPrompt") ?? [])
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  const screenshots = (readArray(record, "screenshots") ?? [])
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);

  const nullableString = (key: string): string | null => readString(record, key)?.trim() || null;
  const screenshotUrls = (readArray(record, "screenshotUrls") ?? [])
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);

  return {
    displayName: nullableString("displayName"),
    shortDescription: nullableString("shortDescription"),
    longDescription: nullableString("longDescription"),
    developerName: nullableString("developerName"),
    category: nullableString("category"),
    capabilities,
    websiteUrl: nullableString("websiteUrl"),
    privacyPolicyUrl: nullableString("privacyPolicyUrl"),
    termsOfServiceUrl: nullableString("termsOfServiceUrl"),
    defaultPrompt: defaultPrompt.length > 0 ? defaultPrompt : null,
    brandColor: nullableString("brandColor"),
    composerIcon: nullableString("composerIcon"),
    composerIconUrl: nullableString("composerIconUrl"),
    logo: nullableString("logo"),
    logoDark: nullableString("logoDark"),
    logoUrl: nullableString("logoUrl"),
    logoUrlDark: nullableString("logoUrlDark"),
    screenshots,
    screenshotUrls,
  };
}

function parsePluginSummary(plugin: unknown): ProviderPluginDescriptor | undefined {
  try {
    return Schema.decodeUnknownSync(ProviderPluginDescriptor)(plugin);
  } catch {
    // Older Codex app-server versions omit fields added to the canonical plugin contract.
  }
  const record = readObject(plugin);
  if (!record) return undefined;
  const id = readString(record, "id")?.trim();
  const name = readString(record, "name")?.trim();
  const source = readObject(record, "source");
  const sourcePath = readString(source, "path")?.trim();
  const installPolicy = readString(record, "installPolicy");
  const authPolicy = readString(record, "authPolicy");
  if (
    !id ||
    !name ||
    !sourcePath ||
    (installPolicy !== "NOT_AVAILABLE" &&
      installPolicy !== "AVAILABLE" &&
      installPolicy !== "INSTALLED_BY_DEFAULT") ||
    (authPolicy !== "ON_INSTALL" && authPolicy !== "ON_USE")
  ) {
    return undefined;
  }

  const pluginInterface = parsePluginInterface(readObject(record, "interface"));

  return {
    id,
    remotePluginId: readString(record, "remotePluginId")?.trim() || null,
    name,
    version: readString(record, "version")?.trim() || null,
    localVersion: readString(record, "localVersion")?.trim() || null,
    shareContext: null,
    availability:
      readString(record, "availability") === "DISABLED_BY_ADMIN"
        ? "DISABLED_BY_ADMIN"
        : "AVAILABLE",
    keywords: (readArray(record, "keywords") ?? [])
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0),
    source: {
      type: "local",
      path: sourcePath,
    },
    installed: record.installed === true,
    enabled: record.enabled === true,
    installPolicy,
    installPolicySource:
      readString(record, "installPolicySource") === "WORKSPACE_SETTING"
        ? "WORKSPACE_SETTING"
        : readString(record, "installPolicySource") === "IMPLICIT_CANONICAL_APP"
          ? "IMPLICIT_CANONICAL_APP"
          : null,
    authPolicy,
    interface: pluginInterface ?? null,
  } satisfies ProviderPluginDescriptor;
}

/**
 * Codex's remote directory (plugin/list without kinds) is ~9.5k plugins, ~23 MB
 * as sent. An uninstalled remote plugin is only ever a card until its page
 * reads it with plugin/read, so its listing keeps what a card shows. Installed
 * plugins keep every field: the composer and the manage page use them.
 */
export function compactRemotePluginDirectory<
  TResult extends Pick<ProviderListPluginsResult, "marketplaces">,
>(result: TResult): TResult {
  return {
    ...result,
    marketplaces: result.marketplaces.map((marketplace) =>
      marketplace.path !== null
        ? marketplace
        : {
            ...marketplace,
            plugins: marketplace.plugins.map((plugin) =>
              plugin.installed || !plugin.interface
                ? plugin
                : {
                    ...plugin,
                    interface: {
                      ...plugin.interface,
                      longDescription: null,
                      capabilities: [],
                      websiteUrl: null,
                      privacyPolicyUrl: null,
                      termsOfServiceUrl: null,
                      defaultPrompt: null,
                      screenshots: [],
                      screenshotUrls: [],
                    },
                  },
            ),
          },
    ),
  };
}

export function parseCodexPluginListResponse(
  response: unknown,
): Omit<ProviderListPluginsResult, "source" | "cached"> {
  const responseRecord = readObject(response);
  const resultRecord = readObject(responseRecord, "result") ?? responseRecord;
  const marketplaces = (readArray(resultRecord, "marketplaces") ?? []).flatMap((marketplace) => {
    const record = readObject(marketplace);
    if (!record) return [];
    const name = readString(record, "name")?.trim();
    const marketplacePath = record.path === null ? null : readString(record, "path")?.trim();
    if (!name || marketplacePath === undefined) {
      return [];
    }
    const rawPlugins = readArray(record, "plugins") ?? [];
    const plugins = rawPlugins.flatMap((plugin) => {
      const parsedPlugin = parsePluginSummary(plugin);
      return parsedPlugin ? [parsedPlugin] : [];
    });
    const marketplaceInterface = readObject(record, "interface");
    const marketplaceDisplayName = readString(marketplaceInterface, "displayName")?.trim();
    return [
      {
        name,
        path: marketplacePath,
        interface: marketplaceInterface ? { displayName: marketplaceDisplayName || null } : null,
        plugins,
      },
    ];
  });
  const marketplaceLoadErrors = (readArray(resultRecord, "marketplaceLoadErrors") ?? [])
    .map((error) => readObject(error))
    .flatMap((error) => {
      if (!error) return [];
      const marketplacePath = readString(error, "marketplacePath")?.trim();
      const message = readString(error, "message")?.trim();
      return marketplacePath && message ? [{ marketplacePath, message }] : [];
    });
  const featuredPluginIds = (readArray(resultRecord, "featuredPluginIds") ?? [])
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);
  const remoteSyncError = readString(resultRecord, "remoteSyncError")?.trim() ?? null;

  return {
    marketplaces,
    marketplaceLoadErrors,
    remoteSyncError: remoteSyncError?.length ? remoteSyncError : null,
    featuredPluginIds,
  };
}

function parsePluginAppSummary(value: unknown): ProviderPluginAppSummary | undefined {
  const record = readObject(value);
  if (!record) return undefined;
  const id = readString(record, "id")?.trim();
  const name = readString(record, "name")?.trim();
  if (!id || !name) {
    return undefined;
  }
  const description = readString(record, "description")?.trim();
  const installUrl = readString(record, "installUrl")?.trim();
  const category = readString(record, "category")?.trim();
  return {
    id,
    name,
    description: description || null,
    installUrl: installUrl || null,
    category: category || null,
  };
}

export function parseCodexPluginReadResponse(response: unknown): ProviderPluginDetail {
  const responseRecord = readObject(response);
  const resultRecord = readObject(responseRecord, "result") ?? responseRecord;
  const pluginRecord = readObject(resultRecord, "plugin") ?? resultRecord;
  try {
    return Schema.decodeUnknownSync(ProviderPluginDetail)(pluginRecord);
  } catch {
    // Normalize older partial plugin/read payloads below.
  }
  const marketplaceName = readString(pluginRecord, "marketplaceName")?.trim();
  const marketplacePath =
    pluginRecord?.marketplacePath === null
      ? null
      : readString(pluginRecord, "marketplacePath")?.trim();
  const summary = parsePluginSummary(readObject(pluginRecord, "summary"));
  if (!marketplaceName || marketplacePath === undefined || !summary) {
    throw new Error("plugin/read response did not include a valid plugin payload.");
  }
  const skills = (readArray(pluginRecord, "skills") ?? []).flatMap((skill) => {
    const parsedSkill = parseSkillDescriptor(skill);
    return parsedSkill ? [parsedSkill] : [];
  });
  const apps = (readArray(pluginRecord, "apps") ?? []).flatMap((app) => {
    const parsedApp = parsePluginAppSummary(app);
    return parsedApp ? [parsedApp] : [];
  });
  const mcpServers = (readArray(pluginRecord, "mcpServers") ?? [])
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);
  const description = readString(pluginRecord, "description")?.trim();
  const shareUrl = readString(pluginRecord, "shareUrl")?.trim();
  const eventNames = new Set<ProviderPluginDetail["hooks"][number]["eventName"]>([
    "preToolUse",
    "permissionRequest",
    "postToolUse",
    "preCompact",
    "postCompact",
    "sessionStart",
    "userPromptSubmit",
    "subagentStart",
    "subagentStop",
    "stop",
  ]);
  const hooks = (readArray(pluginRecord, "hooks") ?? []).flatMap((hook) => {
    const record = readObject(hook);
    const key = readString(record, "key");
    const eventName = readString(record, "eventName");
    if (
      !key ||
      !eventName ||
      !eventNames.has(eventName as ProviderPluginDetail["hooks"][number]["eventName"])
    ) {
      return [];
    }
    return [{ key, eventName: eventName as ProviderPluginDetail["hooks"][number]["eventName"] }];
  });
  const appTemplates = (readArray(pluginRecord, "appTemplates") ?? []).flatMap((template) => {
    const record = readObject(template);
    const templateId = readString(record, "templateId")?.trim();
    const name = readString(record, "name")?.trim();
    if (!record || !templateId || !name) return [];
    const reason: ProviderPluginDetail["appTemplates"][number]["reason"] =
      record.reason === "NOT_CONFIGURED_FOR_WORKSPACE" || record.reason === "NO_ACTIVE_WORKSPACE"
        ? record.reason
        : null;
    return [
      {
        templateId,
        name,
        description: readString(record, "description")?.trim() || null,
        category: readString(record, "category")?.trim() || null,
        canonicalConnectorId: readString(record, "canonicalConnectorId")?.trim() || null,
        logoUrl: readString(record, "logoUrl")?.trim() || null,
        logoUrlDark: readString(record, "logoUrlDark")?.trim() || null,
        materializedAppIds: (readArray(record, "materializedAppIds") ?? []).filter(
          (value): value is string => typeof value === "string",
        ),
        reason,
      } satisfies ProviderPluginDetail["appTemplates"][number],
    ];
  });

  return {
    marketplaceName,
    marketplacePath,
    summary,
    shareUrl: shareUrl || null,
    description: description || null,
    skills,
    hooks,
    apps,
    appTemplates,
    mcpServers,
  };
}

export function parseCodexModelListResponse(response: unknown): ProviderListModelsResult["models"] {
  const responseRecord = readObject(response);
  const resultRecord = readObject(responseRecord, "result") ?? responseRecord;
  const rawModels =
    readArray(resultRecord, "items") ??
    readArray(resultRecord, "data") ??
    readArray(resultRecord, "models") ??
    [];
  const seen = new Set<string>();

  return rawModels.flatMap((value) => {
    const model = readObject(value);
    if (!model) {
      return [];
    }

    const slug = readString(model, "id") ?? readString(model, "slug") ?? readString(model, "model");
    const trimmedSlug = slug?.trim();
    if (!trimmedSlug) {
      return [];
    }

    const name =
      readString(model, "name") ??
      readString(model, "displayName") ??
      readString(model, "display_name") ??
      trimmedSlug;
    const trimmedName = name.trim();
    if (!trimmedName || seen.has(trimmedSlug)) {
      return [];
    }

    const supportedReasoningEfforts = Array.from(
      new Map(
        (
          readArray(model, "supportedReasoningEfforts") ??
          readArray(model, "supported_reasoning_efforts") ??
          []
        )
          .flatMap((entry) => {
            if (typeof entry === "string") {
              const value = entry.trim();
              return value.length > 0 ? [{ value }] : [];
            }

            const descriptor = readObject(entry);
            if (!descriptor) {
              return [];
            }

            const value =
              readString(descriptor, "reasoningEffort") ??
              readString(descriptor, "reasoning_effort") ??
              readString(descriptor, "value");
            const trimmedValue = value?.trim();
            if (!trimmedValue) {
              return [];
            }

            const label = readString(descriptor, "description") ?? readString(descriptor, "label");
            const trimmedLabel = label?.trim();
            return [
              {
                value: trimmedValue,
                ...(trimmedLabel ? { description: trimmedLabel } : {}),
              },
            ];
          })
          .map((descriptor) => [descriptor.value, descriptor] as const),
      ).values(),
    );
    const defaultReasoningEffort =
      readString(model, "defaultReasoningEffort") ?? readString(model, "default_reasoning_effort");
    const trimmedDefaultReasoningEffort = defaultReasoningEffort?.trim();
    const additionalSpeedTiers =
      readArray(model, "additionalSpeedTiers") ?? readArray(model, "additional_speed_tiers") ?? [];
    const hasFastSpeedTier = additionalSpeedTiers.some(
      (tier) => typeof tier === "string" && tier.trim().toLowerCase() === "fast",
    );
    const supportsFastMode =
      readFirstBoolean(model, [
        "supportsFastMode",
        "supports_fast_mode",
        "fastMode",
        "fast_mode",
        "fastServiceTier",
        "fast_service_tier",
      ]) ?? (hasFastSpeedTier ? true : undefined);

    seen.add(trimmedSlug);
    return [
      {
        slug: trimmedSlug,
        name: trimmedName,
        ...(supportedReasoningEfforts.length > 0 ? { supportedReasoningEfforts } : {}),
        ...(trimmedDefaultReasoningEffort &&
        supportedReasoningEfforts.some(
          (descriptor) => descriptor.value === trimmedDefaultReasoningEffort,
        )
          ? { defaultReasoningEffort: trimmedDefaultReasoningEffort }
          : {}),
        ...(supportsFastMode !== undefined ? { supportsFastMode } : {}),
      },
    ];
  });
}

/** Keep the managed Moss discovery response closed under the curated source list. */
export function filterMossManagedCodexModels<T extends { readonly slug: string }>(
  models: ReadonlyArray<T>,
  options?: {
    readonly lane?: MossAccessLane;
    readonly allowedSlugs?: ReadonlyArray<string>;
  },
): T[] {
  const supported = options?.lane
    ? new Set(mossLaneEngineModelIds(options.lane, "codex"))
    : MOSS_MANAGED_DISCOVERY_MODEL_SLUG_SET;
  const allowed = options?.allowedSlugs ? new Set(options.allowedSlugs) : null;
  return models.filter(
    (model) => supported.has(model.slug) && (!allowed || allowed.has(model.slug)),
  );
}
