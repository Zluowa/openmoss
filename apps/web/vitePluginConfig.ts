import type { PluginOption } from "vite";

const REMOVED_PLUGIN = Symbol("removed-vite-plugin");
type FilteredPluginOption = PluginOption | typeof REMOVED_PLUGIN;

function filterPluginOption(
  plugin: PluginOption,
  excludedPlugin: PluginOption,
): FilteredPluginOption {
  if (plugin === excludedPlugin) return REMOVED_PLUGIN;
  if (!Array.isArray(plugin)) return plugin;

  return plugin
    .map((nestedPlugin) => filterPluginOption(nestedPlugin, excludedPlugin))
    .filter((nestedPlugin): nestedPlugin is PluginOption => nestedPlugin !== REMOVED_PLUGIN);
}

/** Remove one explicitly-owned plugin from a derived Vite project config. */
export function withoutVitePlugin(
  plugins: readonly PluginOption[] | undefined,
  excludedPlugin: PluginOption,
): PluginOption[] {
  return (plugins ?? [])
    .map((plugin) => filterPluginOption(plugin, excludedPlugin))
    .filter((plugin): plugin is PluginOption => plugin !== REMOVED_PLUGIN);
}
