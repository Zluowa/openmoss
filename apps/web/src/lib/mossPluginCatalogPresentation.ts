// FILE: mossPluginCatalogPresentation.ts
// Purpose: How the Moss plugin catalog's plugins read in the directory. The
//          CLI lists every catalog plugin from Moss's local marketplace, but
//          only knows a plugin's name and category until its files are on disk;
//          Moss's own catalog copy fills in the card (name, one-line Chinese or
//          English description, developer, icon) either way.
// Layer: Web model (pure)
// Exports: isMossPluginCatalogPlugin, withMossPluginCatalogPresentation,
//          withMossPluginCatalogEntryPresentation

import type { ProviderPluginDescriptor, ProviderPluginInterface } from "@moss/contracts";
import {
  MOSS_PLUGIN_CATALOG_DEFAULT_BASE_URL,
  mossPluginCatalogEntryForPluginId,
  mossPluginCatalogIconUrl,
} from "@moss/shared/mossPluginCatalog";

import type { MossLocaleCode } from "../appSettings";

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
