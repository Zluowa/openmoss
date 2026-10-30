import { describe, expect, it } from "vitest";

import {
  normalizePluginInstallActionResult,
  pluginMarketplaceSelector,
} from "./usePluginResourceActions";
import type { ResourceDetail } from "~/components/PluginResourceDetailDialog";

const resource: Extract<ResourceDetail, { kind: "plugin" }> = {
  kind: "plugin",
  marketplaceName: "OpenAI",
  marketplacePath: "/tmp/openai-curated",
  remoteMarketplaceName: null,
  plugin: {
    id: "github@openai-curated",
    remotePluginId: null,
    version: null,
    localVersion: null,
    name: "github",
    shareContext: null,
    source: { type: "local", path: "/tmp/openai-curated/github/plugin.json" },
    installed: false,
    enabled: false,
    installPolicy: "AVAILABLE",
    installPolicySource: null,
    authPolicy: "ON_USE",
    availability: "AVAILABLE",
    keywords: [],
    interface: {
      displayName: "GitHub",
      shortDescription: "Use GitHub in chat.",
      longDescription: null,
      developerName: null,
      category: "Developer",
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
    },
  },
};

describe("pluginMarketplaceSelector", () => {
  it("addresses local and remote catalogs with mutually exclusive native selectors", () => {
    expect(pluginMarketplaceSelector(resource)).toEqual({
      marketplacePath: "/tmp/openai-curated",
    });
    expect(
      pluginMarketplaceSelector({
        ...resource,
        marketplacePath: null,
        remoteMarketplaceName: "created-by-me",
      }),
    ).toEqual({ remoteMarketplaceName: "created-by-me" });
  });

  it("preserves the native auth policy in the web install result", () => {
    expect(
      normalizePluginInstallActionResult({
        authPolicy: "ON_INSTALL",
        appsNeedingAuth: [
          {
            id: "connector/github",
            name: "GitHub",
            description: "Work with repositories",
            installUrl: "https://chatgpt.com/gpts/editor",
            category: "Developer",
          },
        ],
      }),
    ).toEqual({
      created: true,
      authPolicy: "ON_INSTALL",
      appsNeedingAuth: [
        {
          id: "connector/github",
          name: "GitHub",
          description: "Work with repositories",
          installUrl: "https://chatgpt.com/gpts/editor",
          category: "Developer",
        },
      ],
    });
  });
});
