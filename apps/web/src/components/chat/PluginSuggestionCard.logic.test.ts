import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatPluginSuggestionMeta,
  readDismissedSuggestionIds,
  resolveProviderInstallMarketplaceSelector,
  resolveSuggestionInstallState,
  writeSuggestionDismissed,
} from "./PluginSuggestionCard.logic";

function installMemoryStorage() {
  const backing = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => {
        backing.set(key, value);
      },
      removeItem: (key: string) => {
        backing.delete(key);
      },
      clear: () => {
        backing.clear();
      },
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PluginSuggestionCard.logic", () => {
  it("resolves connected/installed/available states across all plugin sources", () => {
    const context = {
      connectedToolkitSlugs: new Set(["outlook"]),
      connectedConnectorPresetIds: new Set(["notion"]),
      installedServicePluginIds: new Set(["flyai"]),
      installedProviderPluginIds: new Set(["github@moss-catalog"]),
      locallyInstalledPluginIds: new Set<string>(),
    };

    expect(
      resolveSuggestionInstallState(
        {
          pluginId: "outlook@moss-apps",
          sourceKind: "moss-app",
          toolkitSlug: "outlook",
        },
        context,
      ),
    ).toBe("connected");

    expect(
      resolveSuggestionInstallState(
        {
          pluginId: "gmail@moss-apps",
          sourceKind: "moss-app",
          toolkitSlug: "gmail",
        },
        context,
      ),
    ).toBe("available");

    expect(
      resolveSuggestionInstallState(
        {
          pluginId: "notion@mcp-connector",
          sourceKind: "mcp-connector",
          connectorPresetId: "notion",
        },
        context,
      ),
    ).toBe("connected");

    expect(
      resolveSuggestionInstallState(
        {
          pluginId: "flyai@moss-connector-apps",
          sourceKind: "moss-service-plugin",
          servicePluginId: "flyai",
        },
        context,
      ),
    ).toBe("installed");

    expect(
      resolveSuggestionInstallState(
        {
          pluginId: "github@moss-catalog",
          sourceKind: "moss-catalog",
        },
        context,
      ),
    ).toBe("installed");

    expect(
      resolveSuggestionInstallState(
        {
          pluginId: "moss-imagegen@moss-bundled",
          sourceKind: "moss-bundled",
        },
        context,
      ),
    ).toBe("available");
  });

  it("persists dismissals per thread and suggestion", () => {
    installMemoryStorage();
    const items = [{ pluginId: "outlook@moss-apps" }, { pluginId: "gmail@moss-apps" }];
    writeSuggestionDismissed("thread-1", "sugg-1", "outlook@moss-apps", true);

    expect(readDismissedSuggestionIds("thread-1", "sugg-1", items)).toEqual(
      new Set(["outlook@moss-apps"]),
    );
    expect(readDismissedSuggestionIds("thread-2", "sugg-1", items)).toEqual(new Set());

    writeSuggestionDismissed("thread-1", "sugg-1", "outlook@moss-apps", false);
    expect(readDismissedSuggestionIds("thread-1", "sugg-1", items)).toEqual(new Set());
  });

  it("formats screenshot-matched developer subtitle and marketplace selectors", () => {
    expect(
      formatPluginSuggestionMeta(
        {
          developerName: "OpenAI",
          shortDescription: "Triage Outlook inboxes",
        },
        "开发者：",
      ),
    ).toBe("开发者：OpenAI · Triage Outlook inboxes");

    expect(
      resolveProviderInstallMarketplaceSelector(
        { pluginId: "moss-imagegen@moss-bundled", marketplaceName: "moss-bundled" },
        [
          {
            name: "moss-bundled",
            path: "C:/Users/demo/.moss/plugins/moss-bundled",
            interface: null,
            plugins: [],
          },
        ],
      ),
    ).toEqual({ marketplacePath: "C:/Users/demo/.moss/plugins/moss-bundled" });

    expect(
      resolveProviderInstallMarketplaceSelector(
        { pluginId: "github@moss-catalog", marketplaceName: "moss-catalog" },
        [
          {
            name: "moss-catalog",
            path: null,
            interface: null,
            plugins: [],
          },
        ],
      ),
    ).toEqual({ remoteMarketplaceName: "moss-catalog" });
  });
});
