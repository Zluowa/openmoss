// FILE: mossServicePlugins.ts
// Purpose: Moss service plugins in the plugin directory. Each mainland China
//          service is one plugin that bundles its MCP connector (when the
//          vendor offers one) with a Moss-written skill, the way a Codex
//          plugin bundles MCP servers and skills: installing it connects the
//          MCP (or, for a skill-only plugin, marks it installed) and the
//          server writes the skill for every CLI; uninstalling removes both.
//          Only the account's region sees its plugins.
// Layer: Web model
// Exports: marketplace identity helpers, descriptor/detail synthesis,
//          directory entries, skill preview and chat skill reference

import type {
  MossServicePluginSkillFile,
  ProviderPluginDescriptor,
  ProviderPluginDetail,
  ProviderSkillReference,
} from "@moss/contracts";
import type { McpConnectorRegion } from "@moss/shared/mcpConnectors";
import {
  findMossServicePlugin,
  MOSS_SERVICE_PLUGINS,
  type MossServicePlugin,
  mossServicePluginInfo,
  mossServiceSkillMarkdown,
} from "@moss/shared/mossServicePlugins";

import type { ProviderPluginDirectoryEntry } from "./pluginLibraryModel";
import { resolveSiteFaviconUrl } from "./siteFavicon";

export const MOSS_SERVICE_PLUGINS_MARKETPLACE_NAME = "moss-service-plugins";
const PLUGIN_ID_SUFFIX = `@${MOSS_SERVICE_PLUGINS_MARKETPLACE_NAME}`;
/** The directory's own category for daily-life services. */
const DIRECTORY_CATEGORY = "Travel";

export function mossServicePluginId(id: string): string {
  return `${id}${PLUGIN_ID_SUFFIX}`;
}

export function mossServicePluginFromPluginId(pluginId: string): MossServicePlugin | null {
  if (!pluginId.endsWith(PLUGIN_ID_SUFFIX)) return null;
  return findMossServicePlugin(pluginId.slice(0, -PLUGIN_ID_SUFFIX.length)) ?? null;
}

export function isMossServicePlugin(plugin: Pick<ProviderPluginDescriptor, "id">): boolean {
  return mossServicePluginFromPluginId(plugin.id) !== null;
}

/**
 * The plugin page names a service plugin's skill by this scheme, not a file:
 * the skill exists on disk only once installed, and the page shows it before.
 */
const SKILL_PATH_PREFIX = "moss-service-plugin://";

function mossServicePluginSkillPath(plugin: MossServicePlugin): string {
  return `${SKILL_PATH_PREFIX}${plugin.id}/${plugin.skill.name}/SKILL.md`;
}

/** The skill preview for a service plugin's skill path, from Moss's own text; null for any other path. */
export function mossServiceSkillPreview(path: string): { readonly contents: string } | null {
  if (!path.startsWith(SKILL_PATH_PREFIX)) return null;
  const plugin = findMossServicePlugin(path.slice(SKILL_PATH_PREFIX.length).split("/")[0] ?? "");
  return plugin && path === mossServicePluginSkillPath(plugin)
    ? { contents: mossServiceSkillMarkdown(plugin) }
    : null;
}

/** The installed skill file of this service plugin, ready to attach to a chat; null otherwise. */
export function mossServicePluginSkillReference(
  plugin: Pick<ProviderPluginDescriptor, "id">,
  skills: ReadonlyArray<MossServicePluginSkillFile>,
): ProviderSkillReference | null {
  const servicePlugin = mossServicePluginFromPluginId(plugin.id);
  const file = servicePlugin ? skills.find((skill) => skill.pluginId === servicePlugin.id) : null;
  return file ? { name: file.name, path: file.path } : null;
}

/** Plugins offered in a region: only that region's own. */
export function mossServicePluginsForRegion(
  region: McpConnectorRegion,
): ReadonlyArray<MossServicePlugin> {
  return MOSS_SERVICE_PLUGINS.filter((plugin) => mossServicePluginInfo(plugin).region === region);
}

/** Catalog copy is English; the page passes its locale's translation. */
export type MossServicePluginCopy = (english: string) => string;
const asIs: MossServicePluginCopy = (english) => english;

export function mossServicePluginDescriptor(
  plugin: MossServicePlugin,
  installed: boolean,
  copy: MossServicePluginCopy = asIs,
): ProviderPluginDescriptor {
  const info = mossServicePluginInfo(plugin);
  const description = copy(info.description);
  const requirements = info.requirements ? copy(info.requirements) : null;
  return {
    id: mossServicePluginId(plugin.id),
    remotePluginId: null,
    name: plugin.id,
    version: null,
    localVersion: null,
    shareContext: null,
    availability: "AVAILABLE",
    keywords: ["life"],
    source: { type: "remote" },
    installed,
    enabled: installed,
    installPolicy: "AVAILABLE",
    installPolicySource: null,
    authPolicy: "ON_INSTALL",
    interface: {
      displayName: info.name,
      shortDescription: description,
      longDescription: requirements ? `${description}\n\n${requirements}` : description,
      developerName: "Moss",
      category: DIRECTORY_CATEGORY,
      capabilities: [],
      websiteUrl: info.docsUrl || null,
      privacyPolicyUrl: null,
      termsOfServiceUrl: null,
      defaultPrompt: null,
      brandColor: null,
      composerIcon: null,
      composerIconUrl: null,
      logo: null,
      logoDark: null,
      logoUrl: resolveSiteFaviconUrl(info.iconHost),
      logoUrlDark: null,
      screenshots: [],
      screenshotUrls: [],
    },
  };
}

/** The plugin page: what one install brings — its skill and, when it has one, its MCP server. */
export function mossServicePluginDetail(
  plugin: MossServicePlugin,
  installed: boolean,
  copy: MossServicePluginCopy = asIs,
): ProviderPluginDetail {
  const info = mossServicePluginInfo(plugin);
  const summary = mossServicePluginDescriptor(plugin, installed, copy);
  return {
    marketplaceName: MOSS_SERVICE_PLUGINS_MARKETPLACE_NAME,
    marketplacePath: null,
    summary,
    shareUrl: null,
    description: summary.interface?.longDescription ?? null,
    skills: [
      {
        name: info.skill.name,
        description: info.skill.description,
        path: mossServicePluginSkillPath(plugin),
        enabled: installed,
        scope: "moss",
      },
    ],
    hooks: [],
    // The service is reached through the MCP server listed below, not a separate app.
    apps: [],
    appTemplates: [],
    mcpServers: info.mcpServerName ? [info.mcpServerName] : [],
  };
}

/**
 * Directory entries for the region's service plugins, installed ones first.
 * They join the Moss Apps section ahead of the hosted catalog.
 */
export function mossServicePluginDirectoryEntries(input: {
  readonly region: McpConnectorRegion;
  readonly installed: ReadonlySet<string>;
  readonly copy?: MossServicePluginCopy;
}): ProviderPluginDirectoryEntry[] {
  const installed: ProviderPluginDirectoryEntry[] = [];
  const rest: ProviderPluginDirectoryEntry[] = [];
  for (const plugin of mossServicePluginsForRegion(input.region)) {
    const isInstalled = input.installed.has(plugin.id);
    (isInstalled ? installed : rest).push({
      plugin: mossServicePluginDescriptor(plugin, isInstalled, input.copy),
      marketplaceName: MOSS_SERVICE_PLUGINS_MARKETPLACE_NAME,
      marketplaceDisplayName: "Moss Apps",
      marketplacePath: null,
      remoteMarketplaceName: MOSS_SERVICE_PLUGINS_MARKETPLACE_NAME,
      bucket: "moss",
      provenance: "moss-apps",
      isFeatured: false,
      createdByYou: false,
      sharedWithYou: false,
    });
  }
  return [...installed, ...rest];
}
