// FILE: PluginManagementPanel.browser.tsx
// Purpose: Locks the frozen Plugins, Apps, and MCP Manage taxonomy and compatibility boundaries.

import "../index.css";

import type { ProviderAppInfo } from "@synara/contracts";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { PluginLibraryManageSnapshot } from "~/lib/pluginLibraryHistoryState";
import { PluginManagementPanel, type ManagedPlugin } from "./PluginManagementPanel";
import { MossLocalizationProvider } from "~/localization";

vi.mock("~/appSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/appSettings")>();
  return {
    ...actual,
    useAppSettings: () => ({
      settings: {
        codexAccounts: [],
        codexHomePath: "",
        localeOverride: "zh-CN",
        selectedCodexAccountId: "default",
      },
    }),
  };
});

// zh-CN 表面：裸挂载默认 localization context 按浏览器语言解析为 en，统一以 zh Provider 包裹。
function renderZh(ui: Parameters<typeof render>[0]) {
  return render(<MossLocalizationProvider>{ui}</MossLocalizationProvider>);
}

function app(overrides: Partial<ProviderAppInfo> = {}): ProviderAppInfo {
  return {
    id: "gmail",
    name: "Gmail",
    description: "Read and send mail",
    logoUrl: null,
    logoUrlDark: null,
    iconAssets: null,
    iconDarkAssets: null,
    distributionChannel: null,
    branding: null,
    appMetadata: null,
    labels: null,
    installUrl: "https://example.test/connect/gmail",
    isAccessible: true,
    isEnabled: true,
    pluginDisplayNames: ["Google Workspace"],
    ...overrides,
  };
}

function lifecycleFixturePlugin(overrides: Partial<ManagedPlugin["plugin"]> = {}): ManagedPlugin {
  return {
    plugin: {
      id: "moss-plugin-lifecycle-fixture@moss-parity-fixture",
      remotePluginId: null,
      name: "moss-plugin-lifecycle-fixture",
      version: "1.0.0",
      localVersion: "1.0.0",
      shareContext: null,
      availability: "AVAILABLE",
      keywords: [],
      source: { type: "local", path: "/fixture-marketplace" },
      installed: true,
      enabled: true,
      installPolicy: "AVAILABLE",
      installPolicySource: null,
      authPolicy: "ON_USE",
      interface: {
        displayName: "Moss lifecycle fixture",
        shortDescription: "Packaged plugin lifecycle smoke fixture",
        longDescription: null,
        developerName: "Moss",
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
        logoUrl:
          "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Crect width='24' height='24' fill='%230c79d8'/%3E%3C/svg%3E",
        logoUrlDark: null,
        screenshots: [],
        screenshotUrls: [],
      },
      ...overrides,
    },
    marketplaceName: "Moss parity fixture",
    marketplacePath: "/fixture-marketplace/.agents/plugins/marketplace.json",
    remoteMarketplaceName: null,
  };
}

function commonProps() {
  return {
    plugins: [],
    appsLoading: false,
    appsError: null,
    mcpServers: [],
    onTogglePlugin: vi.fn(),
    onToggleMcp: vi.fn(),
  } as const;
}

describe("PluginManagementPanel authoritative tabs", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("identifies the exact native plugin row and toggles its switch", async () => {
    const fixture = lifecycleFixturePlugin();
    const onTogglePlugin = vi.fn();
    const onOpenPlugin = vi.fn();
    const screen = await renderZh(
      <PluginManagementPanel
        {...commonProps()}
        plugins={[fixture]}
        apps={[]}
        marketplaces={[]}
        onTogglePlugin={onTogglePlugin}
        onOpenPlugin={onOpenPlugin}
      />,
    );

    try {
      const row = page.getByTestId("plugin-manage-plugin-row").filter({
        has: page.getByText("Moss lifecycle fixture", { exact: true }),
      });
      await expect.element(row).toBeInTheDocument();
      await expect
        .element(row.getByText("Moss lifecycle fixture", { exact: true }))
        .toBeInTheDocument();
      const toggle = row.getByRole("switch");
      await expect.element(toggle).toHaveAttribute("aria-checked", "true");
      await toggle.click();
      expect(onTogglePlugin).toHaveBeenCalledWith(fixture, false);
      expect(onOpenPlugin).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("matches the signed Codex manage hierarchy, native order, artwork, copy, and geometry", async () => {
    const first = lifecycleFixturePlugin();
    const second = lifecycleFixturePlugin({
      id: "second-plugin@native-provider",
      name: "second-plugin",
      interface: {
        ...first.plugin.interface!,
        displayName: "Second native plugin",
        shortDescription: "Second provider description",
        logoUrl: "./assets/native-plugin.svg",
      },
    });
    const screen = await renderZh(
      <div className="w-[1200px]">
        <PluginManagementPanel
          {...commonProps()}
          plugins={[second, first]}
          apps={[app()]}
          marketplaces={[]}
          artworkCwd="/native/provider"
          onOpenPlugin={vi.fn()}
        />
      </div>,
    );

    try {
      const content = page.getByTestId("plugin-manage-content");
      const heading = page.getByRole("heading", { level: 1, name: "插件" });
      await expect.element(content).toBeInTheDocument();
      await expect.element(heading).toHaveTextContent("插件");
      await expect.element(page.getByText("管理插件、技能和 MCP")).toBeInTheDocument();
      await expect.element(page.getByPlaceholder("搜索插件")).toBeInTheDocument();

      const tabs = [
        ...document.querySelectorAll<HTMLElement>('[data-testid^="plugin-manage-tab-"]'),
      ];
      expect(tabs.map((tab) => tab.dataset.testid)).toEqual([
        "plugin-manage-tab-plugins",
        "plugin-manage-tab-apps",
        "plugin-manage-tab-mcps",
      ]);
      expect(document.querySelector('[data-testid="plugin-manage-tab-skills"]')).toBeNull();
      expect(document.querySelector('[data-testid="plugin-manage-tab-marketplace"]')).toBeNull();

      const rows = [
        ...document.querySelectorAll<HTMLElement>('[data-testid="plugin-manage-plugin-row"]'),
      ];
      expect(rows.map((row) => row.querySelector("p")?.textContent)).toEqual([
        "Second native plugin",
        "Moss lifecycle fixture",
      ]);
      expect(rows[0]?.textContent).toContain("Second provider description");
      expect(rows[0]?.textContent).not.toContain("Moss parity fixture");
      expect(rows[0]?.textContent).not.toContain("personal");
      expect(rows[0]?.textContent).not.toContain("workspace");
      const artworkUrl = new URL(rows[0]!.querySelector("img")!.src);
      expect(artworkUrl.pathname).toBe("/api/local-image");
      expect(artworkUrl.searchParams.get("path")).toBe("./assets/native-plugin.svg");
      expect(artworkUrl.searchParams.get("cwd")).toBe("/native/provider");
      expect(rows[0]?.querySelector('button[aria-label="更多操作"]')).not.toBeNull();
      expect(rows[0]?.querySelector('[role="switch"]')).not.toBeNull();

      const contentBox = (content.element() as HTMLElement).getBoundingClientRect();
      const headingBox = (heading.element() as HTMLElement).getBoundingClientRect();
      const firstTabBox = tabs[0]!.getBoundingClientRect();
      const searchBox = document
        .querySelector<HTMLInputElement>("#plugins-page-manage-search")!
        .getBoundingClientRect();
      const firstBox = rows[0]!.getBoundingClientRect();
      const secondBox = rows[1]!.getBoundingClientRect();
      const headingStyle = getComputedStyle(heading.element() as HTMLElement);
      // Codex Settings › Plugins: the tab strip and a 32px search share a
      // centre line; rows are 64px lines of one bordered, hairline-split list.
      const list = page.getByTestId("plugin-manage-list").element() as HTMLElement;
      const listBox = list.getBoundingClientRect();
      expect(contentBox.width).toBeCloseTo(768, 3);
      expect(headingBox.top).toBeCloseTo(20, 3);
      expect(headingStyle.fontSize).toBe("24px");
      expect(headingStyle.fontWeight).toBe("545");
      expect(firstTabBox.height).toBeCloseTo(28, 3);
      expect(searchBox.width).toBeCloseTo(180, 3);
      expect(searchBox.height).toBeCloseTo(32, 3);
      expect(searchBox.top + searchBox.height / 2).toBeCloseTo(
        firstTabBox.top + firstTabBox.height / 2,
        3,
      );
      expect(listBox.width).toBeCloseTo(728, 3);
      expect(getComputedStyle(list).borderRadius).toBe("16px");
      expect(firstBox.top - listBox.top).toBeCloseTo(1, 3);
      expect(firstBox.height).toBeCloseTo(64, 3);
      expect(secondBox.top - firstBox.bottom).toBeCloseTo(0, 3);
    } finally {
      await screen.unmount();
    }
  });

  it("implements roving Manage tabs with arrows, Home, End, and focus", async () => {
    const screen = await renderZh(
      <PluginManagementPanel {...commonProps()} apps={[app()]} marketplaces={[]} />,
    );

    try {
      const plugins = page.getByTestId("plugin-manage-tab-plugins");
      const apps = page.getByTestId("plugin-manage-tab-apps");
      const mcps = page.getByTestId("plugin-manage-tab-mcps");
      await expect.element(plugins).toHaveAttribute("tabindex", "0");
      await expect.element(apps).toHaveAttribute("tabindex", "-1");
      await expect.element(mcps).toHaveAttribute("tabindex", "-1");

      plugins.element().focus();
      await userEvent.keyboard("{ArrowRight}");
      expect(document.activeElement).toBe(apps.element());
      await expect.element(apps).toHaveAttribute("aria-selected", "true");
      await expect.element(plugins).toHaveAttribute("tabindex", "-1");

      await userEvent.keyboard("{End}");
      expect(document.activeElement).toBe(mcps.element());
      await expect.element(mcps).toHaveAttribute("aria-selected", "true");

      await userEvent.keyboard("{ArrowLeft}");
      expect(document.activeElement).toBe(apps.element());
      await userEvent.keyboard("{Home}");
      expect(document.activeElement).toBe(plugins.element());
      await expect.element(plugins).toHaveAttribute("aria-selected", "true");
    } finally {
      await screen.unmount();
    }
  });

  it("shows only accessible apps, opens tools, toggles, and single-flights Manage on ChatGPT", async () => {
    let release: (() => void) | undefined;
    const onOpenAppUrl = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = () => resolve(true);
        }),
    );
    const onSetAppEnabled = vi.fn();
    const onOpenAppTools = vi.fn();
    const screen = await renderZh(
      <PluginManagementPanel
        {...commonProps()}
        apps={[
          app({ logoUrl: "./assets/gmail.svg" }),
          app({ id: "notion", name: "Notion", isAccessible: false, isEnabled: false }),
          app({
            id: "unsafe",
            name: "Unsafe",
            installUrl: "javascript:alert(1)",
            isAccessible: false,
            isEnabled: false,
          }),
          app({
            id: "file",
            name: "File",
            installUrl: "file:///tmp/secret",
            isAccessible: false,
            isEnabled: false,
          }),
        ]}
        marketplaces={[]}
        onOpenAppUrl={onOpenAppUrl}
        onOpenAppTools={onOpenAppTools}
        onSetAppEnabled={onSetAppEnabled}
        artworkCwd="/apps/provider"
      />,
    );

    try {
      const appsTab = page.getByTestId("plugin-manage-tab-apps");
      await expect.element(appsTab).toHaveTextContent("1");
      await appsTab.click();
      await page.getByRole("button", { name: /Open Gmail tools|打开 Gmail 工具/u }).click();
      expect(onOpenAppTools).toHaveBeenCalledWith(expect.objectContaining({ id: "gmail" }));
      const switches = document.querySelectorAll<HTMLInputElement>('[role="switch"]');
      switches[0]?.click();
      expect(onSetAppEnabled).toHaveBeenCalledWith(expect.objectContaining({ id: "gmail" }), false);

      const rows = document.querySelectorAll<HTMLElement>('[data-testid="plugin-manage-app-row"]');
      expect(rows).toHaveLength(1);
      const appArtworkUrl = new URL(rows[0]!.querySelector("img")!.src);
      expect(appArtworkUrl.pathname).toBe("/api/local-image");
      expect(appArtworkUrl.searchParams.get("path")).toBe("./assets/gmail.svg");
      expect(appArtworkUrl.searchParams.get("cwd")).toBe("/apps/provider");
      const manage = rows[0]?.querySelector<HTMLButtonElement>(
        'button[aria-label="Manage on ChatGPT"], button[aria-label="在 ChatGPT 上管理"]',
      );
      manage?.click();
      manage?.click();
      expect(onOpenAppUrl).toHaveBeenCalledTimes(1);
      expect(onOpenAppUrl).toHaveBeenCalledWith("https://example.test/connect/gmail");
      release?.();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps working app rows visible when a refresh reports an error", async () => {
    const onRetryApps = vi.fn();
    const screen = await renderZh(
      <PluginManagementPanel
        {...commonProps()}
        apps={[app()]}
        appsError={new Error("refresh failed")}
        marketplaces={[]}
        onRetryApps={onRetryApps}
      />,
    );

    try {
      await page.getByTestId("plugin-manage-tab-apps").click();
      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent(/Unable to load apps|无法加载应用/u);
      await expect.element(page.getByRole("alert")).toHaveTextContent("refresh failed");
      await expect.element(page.getByText("Gmail")).toBeInTheDocument();
      await page.getByRole("button", { name: /Retry|重试/u }).click();
      expect(onRetryApps).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });

  it("lists marketplaces under their own tab, built-ins tagged", async () => {
    const screen = await renderZh(
      <PluginManagementPanel
        {...commonProps()}
        apps={[]}
        marketplaces={[
          {
            key: "git",
            name: "team-marketplace",
            displayName: "Team marketplace",
            path: "/catalog/team",
            pluginCount: 2,
            isBuiltIn: false,
            isConfigured: true,
            isGit: true,
          },
          {
            key: "local",
            name: "local-marketplace",
            displayName: "Local marketplace",
            path: "/catalog/local",
            pluginCount: 1,
            isBuiltIn: false,
            isConfigured: true,
            isGit: false,
          },
          {
            key: "builtin",
            name: "openai-curated",
            displayName: "OpenAI Curated",
            path: "/catalog/openai",
            pluginCount: 12,
            isBuiltIn: true,
            isConfigured: true,
            isGit: true,
          },
        ]}
      />,
    );

    try {
      const tab = page.getByTestId("plugin-manage-tab-marketplaces");
      await expect.element(tab).toHaveTextContent("市场3");
      await tab.click();
      const list = page.getByTestId("plugin-manage-list");
      await expect.element(list.getByText("Team marketplace")).toBeInTheDocument();
      await expect.element(list.getByText("OpenAI Curated")).toBeInTheDocument();
      await expect.element(list.getByText("内置")).toBeInTheDocument();
      await expect.element(list.getByText("12 个插件 · /catalog/openai")).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("falls back to the first shown tab when a restored tab has no rows", async () => {
    const screen = await renderZh(
      <PluginManagementPanel
        {...commonProps()}
        viewState={{ initialTab: "marketplaces", search: "", scrollTop: 0, focusAnchor: null }}
        plugins={[lifecycleFixturePlugin()]}
        apps={[]}
        marketplaces={[]}
      />,
    );
    try {
      await expect
        .element(page.getByTestId("plugin-manage-tab-plugins"))
        .toHaveAttribute("aria-selected", "true");
      expect(document.querySelector('[data-testid="plugin-manage-tab-marketplaces"]')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("restores the Skills tab and manages the user's skills with switches", async () => {
    const screen = await renderZh(
      <PluginManagementPanel
        {...commonProps()}
        viewState={
          {
            initialTab: "skills",
            search: "fixture",
            scrollTop: 0,
            focusAnchor: null,
          } as unknown as PluginLibraryManageSnapshot
        }
        plugins={[lifecycleFixturePlugin()]}
        apps={[]}
        marketplaces={[
          {
            key: "team",
            name: "team-marketplace",
            displayName: "Team marketplace",
            path: "/catalog/team",
            pluginCount: 2,
            isBuiltIn: false,
            isConfigured: true,
            isGit: true,
          },
        ]}
        skills={[
          {
            name: "fixture-skill",
            path: "/skills/fixture-skill/SKILL.md",
            enabled: true,
            description: "Fixture skill",
            scope: "moss",
            interface: {
              displayName: "Fixture skill",
              shortDescription: "Should stay hidden in Manage",
            },
          },
        ]}
      />,
    );

    try {
      await expect
        .element(page.getByTestId("plugin-manage-tab-skills"))
        .toHaveAttribute("aria-selected", "true");
      const row = page.getByTestId("plugin-manage-skill-row");
      await expect.element(row.getByText("Fixture skill")).toBeInTheDocument();
      await expect.element(row.getByRole("switch")).toBeChecked();
      expect(document.querySelector('[data-testid="plugin-manage-plugin-row"]')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });
});
