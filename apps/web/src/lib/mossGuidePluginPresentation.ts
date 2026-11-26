// FILE: mossGuidePluginPresentation.ts
// Purpose: Marketplace & detail presentation for the plug-and-play official
//          "Moss 使用手册" (`moss-guide@moss-official`) plugin. Synthesizes its
//          directory entry, plugin detail page, bundled skill previews, and
//          settings uninstall state without requiring Codex or an external CLI.
// Layer: Web model (pure)
// Exports: isMossOfficialPlugin, mossOfficialSkillPreview,
//          mossGuidePluginDescriptor, mossGuidePluginDetail,
//          mossGuidePluginDirectoryEntry, nextOfficialPluginsUninstalled

import type { ProviderPluginDescriptor, ProviderPluginDetail } from "@moss/contracts";
import {
  MOSS_GUIDE_PLUGIN_COPY,
  MOSS_GUIDE_PLUGIN_ID,
  MOSS_GUIDE_PLUGIN_NAME,
  MOSS_GUIDE_SKILLS,
  MOSS_OFFICIAL_MARKETPLACE_NAME,
  mossGuideSkillMarkdown,
} from "@moss/shared/mossGuidePlugin";
import { MOSS_MEDIA_PLUGINS } from "@moss/shared/mossMediaPlugins";

import type { MossLocaleCode } from "../appSettings";
import type { ProviderPluginDirectoryEntry } from "./pluginLibraryModel";

export const MOSS_OFFICIAL_SKILL_URI_PREFIX = `moss-official-plugin://${MOSS_GUIDE_PLUGIN_NAME}/`;
const MOSS_OFFICIAL_BUILTIN_SOURCE_PREFIX = "moss-official-builtin://";
const MOSS_BUNDLED_MARKETPLACE_NAME = "moss-bundled";

export function isMossOfficialPlugin(plugin: Pick<ProviderPluginDescriptor, "id">): boolean {
  return plugin.id === MOSS_GUIDE_PLUGIN_ID;
}

export function isMossOfficialFallbackBuiltinPlugin(
  plugin: Pick<ProviderPluginDescriptor, "source">,
): boolean {
  return (
    plugin.source.type === "local" &&
    plugin.source.path.startsWith(MOSS_OFFICIAL_BUILTIN_SOURCE_PREFIX)
  );
}

function localizedCopy(locale: MossLocaleCode) {
  return locale === "zh-CN" ? MOSS_GUIDE_PLUGIN_COPY.zhCN : MOSS_GUIDE_PLUGIN_COPY.en;
}

export function mossGuideOfficialSkillPath(skillName: string): string {
  return `${MOSS_OFFICIAL_SKILL_URI_PREFIX}${skillName}/SKILL.md`;
}

/** Synthesizes SKILL.md preview content for `moss-guide`'s bundled skills even when uninstalled. */
export function mossOfficialSkillPreview(path: string): { contents: string } | null {
  if (!path.startsWith(MOSS_OFFICIAL_SKILL_URI_PREFIX)) return null;
  const rest = path.slice(MOSS_OFFICIAL_SKILL_URI_PREFIX.length);
  const slashIndex = rest.indexOf("/");
  const skillName = slashIndex === -1 ? rest : rest.slice(0, slashIndex);
  const spec = MOSS_GUIDE_SKILLS.find((candidate) => candidate.name === skillName);
  if (!spec) return null;
  return { contents: mossGuideSkillMarkdown(spec) };
}

export function mossGuidePluginDescriptor(
  installed: boolean,
  locale: MossLocaleCode,
): ProviderPluginDescriptor {
  const copy = localizedCopy(locale);
  return {
    id: MOSS_GUIDE_PLUGIN_ID,
    remotePluginId: null,
    name: MOSS_GUIDE_PLUGIN_NAME,
    version: "1.0.0",
    localVersion: installed ? "1.0.0" : null,
    shareContext: null,
    availability: "AVAILABLE",
    keywords: ["moss", "guide", "manual", "skills", "plugins", "visual", "使用手册", "插件推荐"],
    source: { type: "remote" },
    installed,
    enabled: installed,
    installPolicy: "AVAILABLE",
    installPolicySource: null,
    authPolicy: "ON_INSTALL",
    interface: {
      displayName: copy.displayName,
      shortDescription: copy.shortDescription,
      longDescription: copy.longDescription,
      developerName: copy.developerName,
      category: copy.category,
      capabilities: [...copy.capabilities],
      websiteUrl: null,
      privacyPolicyUrl: null,
      termsOfServiceUrl: null,
      defaultPrompt: [...copy.defaultPrompt],
      brandColor: null,
      composerIcon: null,
      composerIconUrl: null,
      logo: null,
      logoDark: null,
      logoUrl: null,
      logoUrlDark: null,
      screenshots: [],
      screenshotUrls: [],
    },
  };
}

export function mossGuidePluginDetail(
  installed: boolean,
  locale: MossLocaleCode,
): ProviderPluginDetail {
  const summary = mossGuidePluginDescriptor(installed, locale);
  const copy = localizedCopy(locale);
  const isZh = locale === "zh-CN";
  return {
    marketplaceName: MOSS_OFFICIAL_MARKETPLACE_NAME,
    marketplacePath: null,
    summary,
    shareUrl: null,
    description: copy.longDescription,
    skills: MOSS_GUIDE_SKILLS.map((spec) => ({
      name: spec.name,
      path: mossGuideOfficialSkillPath(spec.name),
      description: isZh ? spec.shortDescription.zhCN : spec.shortDescription.en,
      enabled: installed,
      scope: "moss",
      interface: {
        displayName: isZh ? spec.displayName.zhCN : spec.displayName.en,
        shortDescription: isZh ? spec.shortDescription.zhCN : spec.shortDescription.en,
        defaultPrompt: copy.defaultPrompt[0],
      },
    })),
    hooks: [],
    apps: [],
    appTemplates: [],
    mcpServers: [],
  };
}

export function mossGuidePluginDirectoryEntry(
  installed: boolean,
  locale: MossLocaleCode,
): ProviderPluginDirectoryEntry {
  return {
    plugin: mossGuidePluginDescriptor(installed, locale),
    marketplaceName: MOSS_OFFICIAL_MARKETPLACE_NAME,
    marketplaceDisplayName: "Moss",
    marketplacePath: null,
    remoteMarketplaceName: MOSS_OFFICIAL_MARKETPLACE_NAME,
    bucket: "moss",
    provenance: "local-or-vertical",
    isFeatured: true,
    createdByYou: false,
    sharedWithYou: false,
  };
}

export function mossOfficialDefaultPluginFallbackEntries(
  locale: MossLocaleCode,
  existingIds: ReadonlySet<string>,
): ProviderPluginDirectoryEntry[] {
  const isZh = locale === "zh-CN";
  const entries: ProviderPluginDirectoryEntry[] = [];

  for (const media of MOSS_MEDIA_PLUGINS) {
    if (!media.defaultInstalled) continue;
    const id = `${media.name}@${MOSS_BUNDLED_MARKETPLACE_NAME}`;
    if (existingIds.has(id)) continue;
    const copy = isZh ? media.zhCN : media.en;
    entries.push({
      marketplaceName: MOSS_BUNDLED_MARKETPLACE_NAME,
      marketplaceDisplayName: "Moss",
      marketplacePath: null,
      remoteMarketplaceName: null,
      bucket: "moss",
      provenance: "local-or-vertical",
      isFeatured: false,
      createdByYou: false,
      sharedWithYou: false,
      plugin: {
        id,
        remotePluginId: null,
        name: media.name,
        version: "1.0.0",
        localVersion: "1.0.0",
        shareContext: null,
        availability: "AVAILABLE",
        keywords: ["moss", media.kind, media.name],
        source: { type: "local", path: `${MOSS_OFFICIAL_BUILTIN_SOURCE_PREFIX}${media.name}` },
        installed: true,
        enabled: true,
        installPolicy: "INSTALLED_BY_DEFAULT",
        installPolicySource: null,
        authPolicy: "ON_USE",
        interface: {
          displayName: copy.displayName,
          shortDescription: copy.shortDescription,
          longDescription: copy.longDescription,
          developerName: "Moss",
          category: "Creativity",
          capabilities: [copy.shortDescription],
          websiteUrl: null,
          privacyPolicyUrl: null,
          termsOfServiceUrl: null,
          defaultPrompt: [copy.defaultPrompt],
          brandColor: null,
          composerIcon: null,
          composerIconUrl: null,
          logo: null,
          logoDark: null,
          logoUrl: null,
          logoUrlDark: null,
          screenshots: [],
          screenshotUrls: [],
        },
      },
    });
  }

  return entries;
}

export function mossOfficialFallbackPluginDetail(
  plugin: ProviderPluginDescriptor,
  locale: MossLocaleCode,
): ProviderPluginDetail | null {
  if (!isMossOfficialFallbackBuiltinPlugin(plugin)) return null;
  const media = MOSS_MEDIA_PLUGINS.find((candidate) => candidate.name === plugin.name);
  const copy = media ? (locale === "zh-CN" ? media.zhCN : media.en) : null;
  return {
    marketplaceName: MOSS_BUNDLED_MARKETPLACE_NAME,
    marketplacePath: null,
    summary: plugin,
    shareUrl: null,
    description: copy?.longDescription ?? plugin.interface?.longDescription ?? null,
    skills: [],
    hooks: [],
    apps: [],
    appTemplates: [],
    mcpServers: [],
  };
}

export function nextOfficialPluginsUninstalled(
  current: ReadonlyArray<string> | undefined,
  pluginId: string,
  installed: boolean,
): string[] {
  const shortName = pluginId.split("@")[0] ?? pluginId;
  const normalized = (current ?? []).filter((entry) => entry.trim().length > 0);
  if (installed) {
    return normalized.filter((entry) => entry !== pluginId && entry !== shortName);
  }
  return normalized.includes(pluginId) ? [...normalized] : [...normalized, pluginId];
}
