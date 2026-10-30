import { describe, expect, it } from "vitest";

import type {
  ProviderListPluginsResult,
  ProviderMcpServerDescriptor,
  ProviderPluginDescriptor,
  ProviderSkillDescriptor,
} from "@synara/contracts";

import {
  LIBRARY_BUCKETS,
  canInstallPluginToHarness,
  collectSources,
  filterPluginDirectorySections,
  filterVisibleManageTabs,
  CODEX_DIRECTORY_CATEGORY_ORDER,
  installedPluginDirectoryEntries,
  isCodexManagedPlugin,
  isPluginInstalledForDirectory,
  isProviderPluginListingLoadError,
  mossCanonicalPluginManifestPath,
  mcpSource,
  mcpTransportLabel,
  originLabel,
  pluginBucket,
  providerPluginDirectoryEntries,
  pluginSource,
  pluginMutationOwner,
  resolvePluginLibraryProviderInstanceId,
  resolvePluginPrimaryAction,
  sectionCodexPluginDirectory,
  skillSource,
  withRemotePluginDirectory,
} from "./pluginLibraryModel";

describe("originLabel", () => {
  it("maps known origins and title-cases unknown ones", () => {
    expect(originLabel("moss")).toBe("Moss");
    expect(originLabel("claudeAgent")).toBe("Claude");
    expect(originLabel("project")).toBe("Workspace");
    expect(originLabel("weird")).toBe("Weird");
    expect(originLabel("")).toBe("Other");
  });
});

describe("source classification", () => {
  it("labels a personal plugin marketplace as Personal", () => {
    expect(
      pluginSource({
        marketplaceName: "x",
        marketplacePath: "/home/u/.agents/plugins/marketplace.json",
      }),
    ).toEqual({ key: "plugin:personal", label: "Personal" });
  });

  it("labels a named marketplace by its name", () => {
    const source = pluginSource({ marketplaceName: "OpenAI", marketplacePath: "/mkt/openai.json" });
    expect(source.label).toBe("OpenAI");
    expect(source.key).toBe("plugin:/mkt/openai.json");
  });

  it("derives mcp + skill sources from origin/scope", () => {
    const server = { origin: "codex", transport: "stdio" } as ProviderMcpServerDescriptor;
    expect(mcpSource(server)).toEqual({ key: "mcp:codex", label: "Codex" });
    const skill = { scope: "moss" } as ProviderSkillDescriptor;
    expect(skillSource(skill)).toEqual({ key: "skill:moss", label: "Moss" });
  });
});

describe("provider discovery instance binding", () => {
  it("uses the enabled standalone Moss host instead of the automatic text-generation default", () => {
    expect(
      resolvePluginLibraryProviderInstanceId({
        selectedProvider: "codex",
        activeThread: null,
        standaloneMossInstanceId: "codex_moss",
        fallbackModelSelection: { provider: "codex", instanceId: "codex", model: "gpt-6-astra" },
      }),
    ).toBe("codex_moss");
  });

  it("preserves an active personal thread binding despite an available standalone Moss host", () => {
    expect(
      resolvePluginLibraryProviderInstanceId({
        selectedProvider: "codex",
        standaloneMossInstanceId: "codex_moss",
        activeThread: {
          modelSelection: { provider: "codex", instanceId: "codex_personal", model: "gpt-6-astra" },
          session: { providerName: "codex", providerInstanceId: "codex_personal" },
        },
      }),
    ).toBe("codex_personal");
  });

  it("does not route another provider through the standalone Moss Codex host", () => {
    expect(
      resolvePluginLibraryProviderInstanceId({
        selectedProvider: "claudeAgent",
        standaloneMossInstanceId: "codex_moss",
        fallbackModelSelection: {
          provider: "claudeAgent",
          instanceId: "claudeAgent",
          model: "claude",
        },
      }),
    ).toBe("claudeAgent");
  });

  it("keeps plugin discovery on the active Moss Codex account", () => {
    expect(
      resolvePluginLibraryProviderInstanceId({
        selectedProvider: "codex",
        activeThread: {
          modelSelection: { provider: "codex", instanceId: "codex_moss", model: "gpt-5.6-luna" },
          session: { providerName: "codex", providerInstanceId: "codex_moss" },
        },
        fallbackModelSelection: { provider: "codex", instanceId: "codex", model: "gpt-5-codex" },
      }),
    ).toBe("codex_moss");
  });

  it("uses the globally selected Moss account when the library has no active thread", () => {
    expect(
      resolvePluginLibraryProviderInstanceId({
        selectedProvider: "codex",
        activeThread: null,
        fallbackModelSelection: {
          provider: "codex",
          instanceId: "codex_moss",
          model: "gpt-5.6-luna",
        },
      }),
    ).toBe("codex_moss");
  });
});

describe("collectSources", () => {
  it("dedupes by key while preserving first-seen order", () => {
    const sources = collectSources([
      { key: "a", label: "A" },
      { key: "b", label: "B" },
      { key: "a", label: "A" },
    ]);
    expect(sources).toEqual([
      { key: "a", label: "A" },
      { key: "b", label: "B" },
    ]);
  });
});

describe("mcpTransportLabel", () => {
  it("renders human transport labels", () => {
    expect(mcpTransportLabel("stdio")).toBe("stdio");
    expect(mcpTransportLabel("http")).toBe("HTTP");
    expect(mcpTransportLabel("sse")).toBe("SSE");
    expect(mcpTransportLabel("unknown")).toBe("MCP");
  });
});

describe("plugin mutation ownership", () => {
  const base = {
    enabled: true,
    installed: true,
    installPolicy: "INSTALLED_BY_DEFAULT" as const,
  };

  it("routes .moss plugin manifests only through canonical Moss resource APIs", () => {
    const plugin = {
      ...base,
      source: { type: "local" as const, path: "/repo/.moss/plugins/demo/plugin.json" },
    };
    expect(mossCanonicalPluginManifestPath(plugin)).toBe("/repo/.moss/plugins/demo/plugin.json");
    expect(pluginMutationOwner(plugin)).toBe("moss");

    const windowsPlugin = {
      ...base,
      source: {
        type: "local" as const,
        path: "C:\\repo\\.moss\\plugins\\demo\\plugin.json",
      },
    };
    expect(mossCanonicalPluginManifestPath(windowsPlugin)).toBe(windowsPlugin.source.path);
    expect(pluginMutationOwner(windowsPlugin)).toBe("moss");
  });

  it("keeps installed provider plugins native and uninstalled plugins non-mutable", () => {
    expect(
      pluginMutationOwner({
        ...base,
        source: { type: "local", path: "/home/.codex/plugins/demo/plugin.json" },
      }),
    ).toBe("native");
    expect(
      pluginMutationOwner({
        enabled: false,
        installed: false,
        installPolicy: "AVAILABLE",
        source: { type: "remote" },
      }),
    ).toBeNull();
  });
});

describe("Codex plugin directory model", () => {
  function plugin(input: {
    id: string;
    name: string;
    category?: string;
    installed?: boolean;
    enabled?: boolean;
    installPolicy?: ProviderPluginDescriptor["installPolicy"];
  }): ProviderPluginDescriptor {
    return {
      id: input.id,
      remotePluginId: null,
      version: null,
      localVersion: null,
      name: input.name,
      shareContext: null,
      source: { type: "local", path: `/plugins/${input.name}` },
      installed: input.installed ?? false,
      enabled: input.enabled ?? false,
      installPolicy: input.installPolicy ?? "AVAILABLE",
      installPolicySource: null,
      authPolicy: "ON_USE",
      availability: "AVAILABLE",
      keywords: [],
      interface: {
        displayName: input.name,
        shortDescription: null,
        longDescription: null,
        developerName: null,
        category: input.category ?? null,
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
    };
  }

  it("uses Codex-style bucket labels while keeping Moss as the vendor bucket", () => {
    expect(LIBRARY_BUCKETS).toEqual([
      { id: "moss", label: "Moss" },
      { id: "workspace", label: "By your workspace" },
      { id: "personal", label: "Personal" },
    ]);
    expect(
      pluginBucket({ marketplaceName: "personal", marketplacePath: "/tmp/marketplace.json" }),
    ).toBe("personal");
    // A user-added marketplace is Personal whatever it is called; Workspace
    // comes only from the workspace-directory lane.
    expect(
      pluginBucket({ marketplaceName: "workspace", marketplacePath: "/tmp/marketplace.json" }),
    ).toBe("personal");
    expect(
      pluginBucket({ marketplaceName: "tuiyan-local", marketplacePath: "/tmp/marketplace.json" }),
    ).toBe("personal");
    for (const vendor of ["openai-curated", "openai-bundled", "moss-bundled"]) {
      expect(pluginBucket({ marketplaceName: vendor, marketplacePath: "/tmp/m.json" })).toBe(
        "moss",
      );
    }
  });

  it("features local plugins that Codex names by their remote catalog id", () => {
    const teams = plugin({ id: "teams@openai-curated", name: "Teams" });
    const sections = sectionCodexPluginDirectory({
      entries: [{ plugin: teams }],
      featuredPluginIds: ["teams@openai-curated-remote"],
    });
    expect(sections[0]).toMatchObject({ kind: "featured" });
    expect(sections[0]?.entries.map((entry) => entry.plugin.id)).toEqual([teams.id]);
  });

  it("leads the directory with Moss's own presets, then the full Moss Apps catalog", () => {
    const sections = sectionCodexPluginDirectory({
      entries: [
        {
          plugin: plugin({
            id: "gmail@openai-curated-remote",
            name: "Gmail",
            category: "Productivity",
          }),
          marketplaceName: "openai-curated-remote",
        },
        {
          plugin: plugin({
            id: "moss-imagegen@moss-bundled",
            name: "Moss Images",
            category: "Design",
          }),
          marketplaceName: "moss-bundled",
        },
        {
          plugin: plugin({ id: "gmail@moss-apps", name: "Gmail", category: "Productivity" }),
          marketplaceName: "moss-apps",
        },
      ],
      featuredPluginIds: ["gmail@openai-curated-remote"],
    });
    expect(
      sections.map((section) => [section.kind, section.entries.map((e) => e.plugin.id)]),
    ).toEqual([
      ["official", ["moss-imagegen@moss-bundled"]],
      ["apps", ["gmail@moss-apps"]],
      ["featured", ["gmail@openai-curated-remote"]],
      ["category", ["gmail@openai-curated-remote"]],
    ]);
  });

  it("titles Personal sections by the marketplaces the user added", () => {
    const sections = sectionCodexPluginDirectory({
      layout: "marketplaces",
      entries: [
        { plugin: plugin({ id: "mine@remote", name: "Mine" }), createdByYou: true },
        {
          plugin: plugin({ id: "a@tuiyan-local", name: "A" }),
          marketplaceName: "tuiyan-local",
          marketplaceDisplayName: "推衍 · 本地",
        },
        {
          plugin: plugin({ id: "b@android-use-local", name: "B" }),
          marketplaceName: "android-use-local",
          marketplaceDisplayName: "Android Use Local",
        },
      ],
    });
    expect(sections.map((section) => [section.kind, section.title])).toEqual([
      ["created", "Created by you"],
      ["marketplace", "推衍 · 本地"],
      ["marketplace", "Android Use Local"],
    ]);
  });

  it("keeps installed icons in provider order and excludes a duplicate connected row section", () => {
    const second = plugin({
      id: "second@market",
      name: "Zulu",
      installed: true,
      enabled: true,
    });
    const first = plugin({
      id: "first@market",
      name: "Alpha",
      installed: true,
      enabled: true,
    });

    const entries = [{ plugin: second }, { plugin: first }];
    expect(installedPluginDirectoryEntries(entries).map((entry) => entry.plugin.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect(sectionCodexPluginDirectory({ entries }).some((section) => section.title === null)).toBe(
      false,
    );
  });

  it("builds Created by you, Shared with you, Featured, then provider-ordered categories", () => {
    const installed = plugin({
      id: "installed@market",
      name: "Installed",
      category: "Productivity",
      installed: true,
      enabled: true,
    });
    const featured = plugin({
      id: "featured@market",
      name: "Featured",
      category: "Search",
    });
    const ordinary = plugin({
      id: "ordinary@market",
      name: "Ordinary",
      category: "Productivity",
      installPolicy: "NOT_AVAILABLE",
    });

    const sections = sectionCodexPluginDirectory({
      entries: [
        { plugin: ordinary, createdByYou: true },
        { plugin: featured, sharedWithYou: true },
        { plugin: installed },
      ],
      featuredPluginIds: [featured.id],
    });

    expect(sections.map((section) => [section.id, section.title])).toEqual([
      ["plugins-created-by-you", "Created by you"],
      ["plugins-shared-with-you", "Shared with you"],
      ["plugins-featured", "Featured"],
      ["plugins-productivity", "Productivity"],
      ["plugins-search", "Search"],
    ]);
    expect(sections[0]?.entries.map((entry) => entry.plugin.name)).toEqual(["Ordinary"]);
    expect(sections[1]?.entries.map((entry) => entry.plugin.name)).toEqual(["Featured"]);
    expect(sections[2]?.entries.map((entry) => entry.plugin.name)).toEqual(["Featured"]);
    expect(sections[3]?.entries.map((entry) => entry.plugin.name)).toEqual([
      "Ordinary",
      "Installed",
    ]);
    expect(sections[4]?.entries.map((entry) => entry.plugin.name)).toEqual(["Featured"]);
    expect(isPluginInstalledForDirectory(installed)).toBe(true);
    expect(isPluginInstalledForDirectory(ordinary)).toBe(false);
    expect(canInstallPluginToHarness(featured)).toBe(true);
    expect(canInstallPluginToHarness(installed)).toBe(false);
    expect(canInstallPluginToHarness(ordinary)).toBe(false);
  });

  it("uses provider featured and category order instead of alphabetizing the catalog", () => {
    const featuredSecond = plugin({ id: "second@market", name: "Second", category: "Zeta" });
    const featuredFirst = plugin({ id: "first@market", name: "First", category: "Alpha" });
    const ordinary = plugin({ id: "ordinary@market", name: "Ordinary", category: "Zeta" });

    const sections = sectionCodexPluginDirectory({
      entries: [{ plugin: ordinary }, { plugin: featuredFirst }, { plugin: featuredSecond }],
      featuredPluginIds: [featuredSecond.id, featuredFirst.id],
    });

    expect(sections.map((section) => section.title)).toEqual(["Featured", "Zeta", "Alpha"]);
    expect(sections[0]?.entries.map((entry) => entry.plugin.name)).toEqual(["Second", "First"]);
    expect(sections[1]?.entries.map((entry) => entry.plugin.name)).toEqual(["Ordinary", "Second"]);
  });

  it("places null-path remote descriptors by explicit shared and created query provenance", () => {
    const remoteResult = (
      marketplaceName: string,
      descriptor: ProviderPluginDescriptor,
    ): ProviderListPluginsResult => ({
      marketplaces: [
        {
          name: marketplaceName,
          path: null,
          interface: null,
          plugins: [descriptor],
        },
      ],
      marketplaceLoadErrors: [],
      remoteSyncError: null,
      featuredPluginIds: [],
      source: "app-server",
      cached: false,
    });
    const shared = providerPluginDirectoryEntries({
      result: remoteResult("shared-catalog", plugin({ id: "shared@remote", name: "Shared" })),
      provenance: "shared-with-me",
    });
    const created = providerPluginDirectoryEntries({
      result: remoteResult("my-catalog", plugin({ id: "created@remote", name: "Created" })),
      provenance: "created-by-me-remote",
    });

    expect(shared[0]).toMatchObject({
      marketplacePath: null,
      remoteMarketplaceName: "shared-catalog",
      bucket: "personal",
      provenance: "shared-with-me",
      sharedWithYou: true,
      createdByYou: false,
    });
    expect(created[0]).toMatchObject({
      marketplacePath: null,
      remoteMarketplaceName: "my-catalog",
      bucket: "personal",
      provenance: "created-by-me-remote",
      sharedWithYou: false,
      createdByYou: true,
    });

    const sections = sectionCodexPluginDirectory({ entries: [...shared, ...created] });
    expect(
      sections
        .find((section) => section.id === "plugins-shared-with-you")
        ?.entries.map((entry) => entry.plugin.name),
    ).toEqual(["Shared"]);
    expect(
      sections
        .find((section) => section.id === "plugins-created-by-you")
        ?.entries.map((entry) => entry.plugin.name),
    ).toEqual(["Created"]);
  });

  it("filters one current section while null keeps the All view", () => {
    const sections = [
      { id: "plugins-featured", title: "Featured", entries: ["featured"] },
      { id: "plugins-productivity", title: "Productivity", entries: ["ordinary"] },
    ];

    expect(filterPluginDirectorySections(sections, null)).toEqual(sections);
    expect(filterPluginDirectorySections(sections, "plugins-featured")).toEqual([sections[0]]);
    expect(filterPluginDirectorySections(sections, "plugins-missing")).toEqual([]);
  });

  it("keeps an installed disabled plugin actionable through Enable", () => {
    const disabled = plugin({
      id: "disabled@market",
      name: "Disabled",
      installed: true,
      enabled: false,
    });

    expect(
      resolvePluginPrimaryAction(disabled, {
        canTryInChat: false,
        canInstall: false,
        canEnable: true,
      }),
    ).toEqual({ action: "enable", disabled: false });
    expect(
      resolvePluginPrimaryAction(disabled, {
        canTryInChat: false,
        canInstall: false,
        canEnable: false,
      }),
    ).toEqual({ action: "enable", disabled: true });
  });
});

describe("Manage tab visibility", () => {
  it("models only the native Plugins, Apps, and MCP manage tabs", () => {
    const tabs = [
      { id: "plugins", label: "Plugins", count: 0 },
      { id: "apps", label: "Apps", count: 2 },
      { id: "mcps", label: "MCPs", count: 0 },
    ];

    expect(filterVisibleManageTabs(tabs)).toEqual([tabs[1], tabs[2]]);
  });
});

describe("plugin load errors", () => {
  it("tells a CLI's whole listing failing from one marketplace file failing", () => {
    expect(isProviderPluginListingLoadError({ marketplacePath: "codex-native" })).toBe(true);
    expect(isProviderPluginListingLoadError({ marketplacePath: "claudeAgent-native" })).toBe(true);
    expect(isProviderPluginListingLoadError({ marketplacePath: "C:/plugins/acme-native" })).toBe(
      false,
    );
    expect(isProviderPluginListingLoadError({ marketplacePath: "acme-native" })).toBe(false);
    expect(isProviderPluginListingLoadError({ marketplacePath: "/home/me/.agents/plugins" })).toBe(
      false,
    );
  });
});

function directoryEntry(marketplaceName: string, marketplacePath: string | null, name: string) {
  return { marketplaceName, marketplacePath, name };
}

describe("Codex's remote plugin directory", () => {
  const entry = directoryEntry;

  it("stands in for the local copy of its catalog and leads the order", () => {
    const local = [
      entry("openai-bundled", "/bundled.json", "chrome"),
      entry("openai-curated", "/curated.json", "gmail"),
      entry("personal", "/mine.json", "mine"),
    ];
    const directory = [
      entry("openai-bundled", "/bundled.json", "chrome"),
      entry("openai-curated-remote", null, "gmail"),
      entry("openai-curated-remote", null, "tripsy"),
    ];
    expect(
      withRemotePluginDirectory(local, directory).map((e) => `${e.marketplaceName}:${e.name}`),
    ).toEqual([
      "openai-curated-remote:gmail",
      "openai-curated-remote:tripsy",
      "openai-bundled:chrome",
      "personal:mine",
      "openai-bundled:chrome",
    ]);
    // Until the directory answers, the local lanes are the page.
    expect(withRemotePluginDirectory(local, [])).toEqual(local);
  });

  it("orders categories as Codex does, Productivity first and Other last", () => {
    expect(CODEX_DIRECTORY_CATEGORY_ORDER[0]).toBe("Productivity");
    expect(CODEX_DIRECTORY_CATEGORY_ORDER.at(-1)).toBe("Other");
  });

  it("leaves Codex's own bundles and default installs out of the installed lists", () => {
    const remote = { type: "remote" as const };
    const local = { type: "local" as const, path: "/p" };
    expect(
      isCodexManagedPlugin({
        marketplaceName: "openai-primary-runtime",
        plugin: { installPolicy: "AVAILABLE", source: local },
      }),
    ).toBe(true);
    expect(
      isCodexManagedPlugin({
        marketplaceName: "openai-curated-remote",
        plugin: { installPolicy: "INSTALLED_BY_DEFAULT", source: remote },
      }),
    ).toBe(true);
    expect(
      isCodexManagedPlugin({
        marketplaceName: "openai-curated-remote",
        plugin: { installPolicy: "AVAILABLE", source: remote },
      }),
    ).toBe(false);
    expect(
      isCodexManagedPlugin({
        marketplaceName: "personal",
        plugin: { installPolicy: "INSTALLED_BY_DEFAULT", source: local },
      }),
    ).toBe(false);
  });
});
