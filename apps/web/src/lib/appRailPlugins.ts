// FILE: appRailPlugins.ts
// Purpose: Common plugin shortcuts from the account's actual plugin directory.
// Layer: Web navigation model
import type { ProviderListPluginsResult } from "@moss/contracts";

export type AppRailPlugin = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
};

/** Installed and recently opened plugins lead; pins survive temporary discovery failures. */
export function commonAppRailPlugins(input: {
  readonly result?: ProviderListPluginsResult | undefined;
  readonly pinned: readonly AppRailPlugin[];
  readonly recent: readonly string[];
}): AppRailPlugin[] {
  const plugins = new Map<string, AppRailPlugin>();
  const featured = new Set(input.result?.featuredPluginIds ?? []);
  for (const marketplace of input.result?.marketplaces ?? []) {
    for (const plugin of marketplace.plugins) {
      if (!plugin.installed && !featured.has(plugin.id)) continue;
      plugins.set(plugin.id, {
        id: plugin.id,
        name: plugin.interface?.displayName?.trim() || plugin.name,
        description: plugin.interface?.shortDescription ?? "",
      });
    }
  }
  for (const plugin of input.pinned) if (!plugins.has(plugin.id)) plugins.set(plugin.id, plugin);
  const ordered = new Map<string, AppRailPlugin>();
  for (const id of input.recent) {
    const plugin = plugins.get(id);
    if (plugin) ordered.set(id, plugin);
  }
  for (const plugin of plugins.values()) ordered.set(plugin.id, plugin);
  return [...ordered.values()];
}
