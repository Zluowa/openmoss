// FILE: mossPluginCatalogPresentation.ts
// Purpose: How the Moss plugin catalog's plugins read in the directory. The
//          CLI lists every catalog plugin from Moss's local marketplace, but
//          only knows a plugin's name and category until its files are on disk;
//          Moss's own catalog copy fills in the card (name, one-line Chinese or
//          English description, developer, icon) either way.
// Layer: Web model (pure)
// Exports: isMossPluginCatalogPlugin, withMossPluginCatalogPresentation,
//          withMossPluginCatalogEntryPresentation

import type {
  ProviderCatalogPage,
  ProviderPluginDescriptor,
  ProviderPluginInterface,
} from "@moss/contracts";
import {
  MOSS_PLUGIN_CATALOG,
  MOSS_PLUGIN_CATALOG_DEFAULT_BASE_URL,
  MOSS_PLUGIN_CATALOG_MARKETPLACE_DISPLAY_NAME,
  MOSS_PLUGIN_CATALOG_MARKETPLACE_NAME,
  mossPluginCatalogEntryForPluginId,
  mossPluginCatalogIconUrl,
} from "@moss/shared/mossPluginCatalog";

import type { MossLocaleCode } from "../appSettings";
import type { ProviderPluginDirectoryEntry } from "./pluginLibraryModel";

export function isMossPluginCatalogPlugin(plugin: Pick<ProviderPluginDescriptor, "id">): boolean {
  return mossPluginCatalogEntryForPluginId(plugin.id) !== undefined;
}

const EMPTY_INTERFACE: ProviderPluginInterface = {
  displayName: null,
  shortDescription: null,
  longDescription: null,
  developerName: null,
  category: null,
  capabilities: [],
  websiteUrl: null,
  privacyPolicyUrl: null,
  termsOfServiceUrl: null,
  defaultPrompt: null,
  brandColor: null,
  composerIcon: null,
  composerIconUrl: null,
  logo: null,
  logoDark: null,
  logoUrl: null,
  logoUrlDark: null,
  screenshots: [],
  screenshotUrls: [],
};

/** The catalog plugin as the directory shows it; any other plugin is returned unchanged. */
export function withMossPluginCatalogPresentation<
  TPlugin extends Pick<ProviderPluginDescriptor, "id" | "interface">,
>(plugin: TPlugin, locale: MossLocaleCode): TPlugin {
  const entry = mossPluginCatalogEntryForPluginId(plugin.id);
  if (!entry) return plugin;
  const listed = plugin.interface ?? EMPTY_INTERFACE;
  const hasOwnLogo = Boolean(listed.logo?.trim() || listed.logoUrl?.trim());
  return {
    ...plugin,
    interface: {
      ...listed,
      displayName: listed.displayName?.trim() || entry.displayName,
      shortDescription:
        locale === "zh-CN" ? entry.zhDescription : listed.shortDescription || entry.description,
      longDescription:
        locale === "zh-CN" ? entry.zhDescription : listed.longDescription || entry.description,
      developerName: listed.developerName?.trim() || entry.developerName,
      // Moss's directory sections, not the upstream catalog's own labels.
      category: entry.category,
      websiteUrl: listed.websiteUrl ?? entry.websiteUrl,
      // An <img> takes one URL: the R2 copy, which every lane can reach. The web does not know the
      // account's lane, and the shared card icon serves every plugin, so it has no source list to
      // fall back through; the plugin's own icon replaces this once its files are on disk.
      logoUrl: hasOwnLogo
        ? listed.logoUrl
        : mossPluginCatalogIconUrl(MOSS_PLUGIN_CATALOG_DEFAULT_BASE_URL, entry),
    },
  };
}

/** Directory entries with the catalog's plugins presented; other entries are passed through as is. */
export function withMossPluginCatalogEntryPresentation<
  TEntry extends { readonly plugin: ProviderPluginDescriptor },
>(entries: readonly TEntry[], locale: MossLocaleCode): TEntry[] {
  const presented: TEntry[] = [];
  for (const entry of entries) {
    presented.push(
      isMossPluginCatalogPlugin(entry.plugin)
        ? Object.assign({}, entry, {
            plugin: withMossPluginCatalogPresentation(entry.plugin, locale),
          })
        : entry,
    );
  }
  return presented;
}

/**
 * Compiled-in Moss plugin catalog directory entries used whenever a provider-native
 * CLI is disabled, unavailable, or omitted `moss-catalog`. Keeps the curated Moss
 * plugin catalog browsable without requiring Codex to be enabled.
 */
export function mossPluginCatalogFallbackEntries(
  locale: MossLocaleCode,
): ProviderPluginDirectoryEntry[] {
  return MOSS_PLUGIN_CATALOG.map((entry) => {
    const id = `${entry.name}@${MOSS_PLUGIN_CATALOG_MARKETPLACE_NAME}`;
    const descriptor = withMossPluginCatalogPresentation(
      {
        id,
        remotePluginId: null,
        name: entry.name,
        version: entry.version,
        localVersion: null,
        shareContext: null,
        availability: "AVAILABLE" as const,
        keywords: [],
        source: { type: "remote" as const },
        installed: false,
        enabled: false,
        installPolicy: "AVAILABLE" as const,
        installPolicySource: null,
        authPolicy: "ON_USE" as const,
        interface: {
          ...EMPTY_INTERFACE,
          displayName: entry.displayName,
          shortDescription: entry.description,
          longDescription: entry.description,
          developerName: entry.developerName,
          category: entry.category,
          websiteUrl: entry.websiteUrl,
          logoUrl: mossPluginCatalogIconUrl(MOSS_PLUGIN_CATALOG_DEFAULT_BASE_URL, entry),
        },
      } satisfies ProviderPluginDescriptor,
      locale,
    );
    return {
      marketplaceName: MOSS_PLUGIN_CATALOG_MARKETPLACE_NAME,
      marketplaceDisplayName: MOSS_PLUGIN_CATALOG_MARKETPLACE_DISPLAY_NAME,
      marketplacePath: null,
      remoteMarketplaceName: MOSS_PLUGIN_CATALOG_MARKETPLACE_NAME,
      bucket: "moss",
      provenance: "local-or-vertical",
      plugin: descriptor,
      isFeatured: false,
      createdByYou: false,
      sharedWithYou: false,
    } satisfies ProviderPluginDirectoryEntry;
  });
}

const MOSS_REMOTE_MARKETPLACE_NAME = "moss-marketplace";

/** Maps aggregated `browseMossMarketplace` plugin entries into desktop directory rows. */
export function mossRemoteCatalogEntriesToDirectory(
  catalog: ProviderCatalogPage | undefined,
  locale: MossLocaleCode,
): ProviderPluginDirectoryEntry[] {
  if (!catalog || catalog.kind !== "plugin" || catalog.entries.length === 0) return [];
  const displayName = locale === "zh-CN" ? "扩展市场" : "Moss Marketplace";
  return catalog.entries.map((entry) => {
    const id = `${entry.id}@${MOSS_REMOTE_MARKETPLACE_NAME}`;
    const primarySource = entry.sourceIds[0] ?? null;
    const category = entry.tags[0]?.trim() || "Developer Tools";
    const description = entry.description?.trim() || null;
    const websiteUrl = entry.homepageUrl?.trim() || entry.sourceUrl?.trim() || null;
    const descriptor: ProviderPluginDescriptor = {
      id,
      remotePluginId: entry.id,
      name: entry.name,
      version: entry.version ?? null,
      localVersion: null,
      shareContext: null,
      availability: entry.withdrawal ? "DISABLED_BY_ADMIN" : "AVAILABLE",
      keywords: [...entry.tags],
      source: { type: "remote" },
      installed: false,
      enabled: false,
      installPolicy: entry.withdrawal ? "NOT_AVAILABLE" : "AVAILABLE",
      installPolicySource: null,
      authPolicy: "ON_USE",
      interface: {
        ...EMPTY_INTERFACE,
        displayName: entry.displayName?.trim() || entry.name,
        shortDescription: description,
        longDescription: description,
        developerName: primarySource,
        category,
        websiteUrl,
      },
    };
    return {
      marketplaceName: MOSS_REMOTE_MARKETPLACE_NAME,
      marketplaceDisplayName: displayName,
      marketplacePath: null,
      remoteMarketplaceName: MOSS_REMOTE_MARKETPLACE_NAME,
      bucket: "moss",
      provenance: "remote-directory",
      plugin: descriptor,
      isFeatured: entry.featured,
      createdByYou: false,
      sharedWithYou: false,
    } satisfies ProviderPluginDirectoryEntry;
  });
}
