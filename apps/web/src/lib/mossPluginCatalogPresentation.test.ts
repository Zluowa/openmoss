import type { ProviderPluginDescriptor } from "@moss/contracts";
import { describe, expect, it } from "vitest";

import {
  isMossPluginCatalogPlugin,
  withMossPluginCatalogPresentation,
} from "./mossPluginCatalogPresentation";

function listed(id: string, iface: ProviderPluginDescriptor["interface"] = null) {
  return { id, interface: iface };
}

describe("Moss plugin catalog presentation", () => {
  it("fills a card the CLI lists before the plugin's files are on disk", () => {
    const plugin = withMossPluginCatalogPresentation(listed("superpowers@moss-catalog"), "zh-CN");
    expect(isMossPluginCatalogPlugin(plugin)).toBe(true);
    expect(plugin.interface).toMatchObject({
      displayName: "Superpowers",
      developerName: "Jesse Vincent",
      category: "Developer Tools",
      logoUrl: "https://moss-update.comiction.cn/plugin-catalog/v1/icons/superpowers.png",
    });
    expect(plugin.interface?.shortDescription).toMatch(/[\u4e00-\u9fff]/u);
  });

  it("keeps the plugin's own logo and English copy once it is downloaded", () => {
    const plugin = withMossPluginCatalogPresentation(
      listed("remotion@moss-catalog", {
        displayName: "Remotion",
        shortDescription: "Create motion graphics from prompts",
        longDescription: null,
        developerName: "Remotion",
        category: "Developer Tools",
        capabilities: [],
        websiteUrl: null,
        privacyPolicyUrl: null,
        termsOfServiceUrl: null,
        defaultPrompt: null,
        brandColor: null,
        composerIcon: null,
        composerIconUrl: null,
        logo: "C:/moss/plugins/remotion/assets/logo.png",
        logoDark: null,
        logoUrl: null,
        logoUrlDark: null,
        screenshots: [],
        screenshotUrls: [],
      }),
      "en",
    );
    expect(plugin.interface).toMatchObject({
      shortDescription: "Create motion graphics from prompts",
      category: "Creativity",
      logo: "C:/moss/plugins/remotion/assets/logo.png",
      logoUrl: null,
    });
  });

  it("leaves every other plugin untouched", () => {
    const other = listed("github@openai-curated");
    expect(withMossPluginCatalogPresentation(other, "zh-CN")).toBe(other);
    expect(isMossPluginCatalogPlugin(other)).toBe(false);
  });
});
