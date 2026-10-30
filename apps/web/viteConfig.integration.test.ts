import type { PluginOption } from "vite";
import { describe, expect, it } from "vitest";

import viteConfig, { reactCompilerPlugin } from "./vite.config";
import { browserViteConfig } from "./vitest.browser.config";

function flattenPluginOptions(options: unknown): unknown[] {
  if (Array.isArray(options)) return options.flatMap(flattenPluginOptions);
  if (!options || typeof options !== "object") return [];
  return [options];
}

function pluginName(plugin: unknown): string | undefined {
  if (!plugin || typeof plugin !== "object") return undefined;
  const name = (plugin as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

describe("real Vite project plugin wiring", () => {
  it("keeps production/unit plugins and excludes only the real browser compiler plugin", () => {
    const basePlugins = flattenPluginOptions(
      viteConfig.plugins as readonly PluginOption[] | undefined,
    );
    const browserPlugins = flattenPluginOptions(
      browserViteConfig.plugins as readonly PluginOption[] | undefined,
    );
    const baseNames = basePlugins.map(pluginName).filter((name): name is string => Boolean(name));
    const browserNames = browserPlugins
      .map(pluginName)
      .filter((name): name is string => Boolean(name));
    const centralIconPlugin = basePlugins.find(
      (plugin) => pluginName(plugin) === "moss-central-icon-prune",
    );

    expect(basePlugins).toContain(reactCompilerPlugin);
    expect(baseNames).toContain("tanstack-router:code-splitter:compile-reference-file");
    expect(browserPlugins).not.toContain(reactCompilerPlugin);
    expect(browserNames).toContain("tanstack-router:code-splitter:compile-reference-file");
    expect(browserNames).toContain("vite:react-babel");
    expect(browserNames).toContain("moss-central-icon-prune");
    expect(centralIconPlugin).toBeDefined();
    expect(browserPlugins).toContain(centralIconPlugin);
    expect(reactCompilerPlugin).toMatchObject({ apply: "build" });
    expect(viteConfig.optimizeDeps).toMatchObject({ holdUntilCrawlEnd: false });
  });
});
