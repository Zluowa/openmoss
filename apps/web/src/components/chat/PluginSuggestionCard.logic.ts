// FILE: PluginSuggestionCard.logic.ts
// Purpose: Pure helpers for inline chat plugin suggestion cards: dismissal
//          persistence, live connection/installation status resolution across
//          all Moss plugin sources, and screenshot-matched subtitle formatting.
// Layer: Web chat logic (pure)
// Exports: DISMISS_STORAGE_PREFIX, dismissalStorageKey,
//          readDismissedSuggestionIds, writeSuggestionDismissed,
//          resolveSuggestionInstallState, formatPluginSuggestionMeta,
//          resolveProviderInstallMarketplaceSelector

import type { PluginSuggestionItem, ProviderListPluginsResult } from "@moss/contracts";

export const DISMISS_STORAGE_PREFIX = "moss:plugin-suggestion:dismissed:v1";

export type SuggestionInstallState = "available" | "connected" | "installed";

export interface SuggestionInstallContext {
  readonly connectedToolkitSlugs?: ReadonlySet<string>;
  readonly connectedConnectorPresetIds?: ReadonlySet<string>;
  readonly installedServicePluginIds?: ReadonlySet<string>;
  readonly installedProviderPluginIds?: ReadonlySet<string>;
  readonly locallyInstalledPluginIds?: ReadonlySet<string>;
}

export function dismissalStorageKey(
  threadId: string | undefined,
  suggestionId: string,
  pluginId: string,
): string {
  return `${DISMISS_STORAGE_PREFIX}:${threadId ?? "global"}:${suggestionId}:${pluginId}`;
}

export function readDismissedSuggestionIds(
  threadId: string | undefined,
  suggestionId: string,
  items: ReadonlyArray<Pick<PluginSuggestionItem, "pluginId">>,
): Set<string> {
  const dismissed = new Set<string>();
  if (typeof window === "undefined") return dismissed;
  for (const item of items) {
    try {
      if (
        window.localStorage.getItem(dismissalStorageKey(threadId, suggestionId, item.pluginId)) ===
        "1"
      ) {
        dismissed.add(item.pluginId);
      }
    } catch {
      // Blocked storage treats suggestions as visible.
    }
  }
  return dismissed;
}

export function writeSuggestionDismissed(
  threadId: string | undefined,
  suggestionId: string,
  pluginId: string,
  dismissed: boolean,
): void {
  if (typeof window === "undefined") return;
  try {
    const key = dismissalStorageKey(threadId, suggestionId, pluginId);
    if (dismissed) window.localStorage.setItem(key, "1");
    else window.localStorage.removeItem(key);
  } catch {
    // Ignore blocked storage.
  }
}

export function resolveSuggestionInstallState(
  item: Pick<
    PluginSuggestionItem,
    "pluginId" | "sourceKind" | "toolkitSlug" | "connectorPresetId" | "servicePluginId"
  >,
  context: SuggestionInstallContext,
): SuggestionInstallState {
  if (context.locallyInstalledPluginIds?.has(item.pluginId)) {
    return item.sourceKind === "moss-app" || item.sourceKind === "mcp-connector"
      ? "connected"
      : "installed";
  }

  switch (item.sourceKind) {
    case "moss-app":
      return item.toolkitSlug && context.connectedToolkitSlugs?.has(item.toolkitSlug)
        ? "connected"
        : "available";
    case "mcp-connector":
      return item.connectorPresetId &&
        context.connectedConnectorPresetIds?.has(item.connectorPresetId)
        ? "connected"
        : "available";
    case "moss-service-plugin":
      if (
        item.connectorPresetId &&
        context.connectedConnectorPresetIds?.has(item.connectorPresetId)
      ) {
        return "connected";
      }
      if (item.servicePluginId && context.installedServicePluginIds?.has(item.servicePluginId)) {
        return "installed";
      }
      return "available";
    case "moss-catalog":
    case "moss-bundled":
      return context.installedProviderPluginIds?.has(item.pluginId) ? "installed" : "available";
  }
}

export function formatPluginSuggestionMeta(
  item: Pick<PluginSuggestionItem, "developerName" | "shortDescription">,
  developerPrefix: string,
): string {
  return `${developerPrefix}${item.developerName} · ${item.shortDescription}`;
}

export function resolveProviderInstallMarketplaceSelector(
  item: Pick<PluginSuggestionItem, "pluginId" | "marketplaceName">,
  marketplaces: ReadonlyArray<ProviderListPluginsResult["marketplaces"][number]>,
): { readonly marketplacePath: string } | { readonly remoteMarketplaceName: string } | null {
  const byPlugin = marketplaces.find((marketplace) =>
    marketplace.plugins.some((plugin) => plugin.id === item.pluginId),
  );
  const byMarketplaceName = item.marketplaceName
    ? marketplaces.find((marketplace) => marketplace.name === item.marketplaceName)
    : undefined;
  const matched = byPlugin ?? byMarketplaceName;
  if (matched) {
    return matched.path !== null
      ? { marketplacePath: matched.path }
      : { remoteMarketplaceName: matched.name };
  }
  return item.marketplaceName ? { remoteMarketplaceName: item.marketplaceName } : null;
}
