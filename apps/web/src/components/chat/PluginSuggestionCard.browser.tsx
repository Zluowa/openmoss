import "../../index.css";

import { MOSS_DEVELOPER_PLUGIN_ID } from "@moss/shared/mossDeveloperPlugin";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  DEFAULT_SERVER_SETTINGS,
  ThreadId,
  type NativeApi,
  type PluginSuggestionActivityPayload,
  type ProviderKind,
} from "@moss/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import { MossLocaleScope } from "~/localization";
import { resetWsNativeApiForTest } from "~/wsNativeApi";
import { PluginSuggestionCard } from "./PluginSuggestionCard";

const threadId = ThreadId.makeUnsafe("thread-suggest-1");

function installNativeApiMock(
  options: {
    connectedSlugs?: string[];
    serviceInstalled?: string[];
    uninstalledOfficial?: string[];
    connectError?: Error;
  } = {},
) {
  const connected = new Set(options.connectedSlugs ?? []);
  const installedService = new Set(options.serviceInstalled ?? []);
  let serverSettings = {
    ...DEFAULT_SERVER_SETTINGS,
    ...(options.uninstalledOfficial
      ? {
          officialPlugins: {
            uninstalled: [...options.uninstalledOfficial],
            dismissedSuggestions: [],
          },
        }
      : {}),
  };

  const server = {
    getSettings: vi.fn(async () => serverSettings),
    updateSettings: vi.fn(
      async (input: {
        officialPlugins?: {
          uninstalled?: string[];
          dismissedSuggestions?: Array<{ pluginId: string; dismissedAt: string }>;
        };
      }) => {
        if (input.officialPlugins) {
          serverSettings = {
            ...serverSettings,
            officialPlugins: {
              uninstalled:
                input.officialPlugins.uninstalled ??
                serverSettings.officialPlugins?.uninstalled ??
                [],
              dismissedSuggestions:
                input.officialPlugins.dismissedSuggestions ??
                serverSettings.officialPlugins?.dismissedSuggestions ??
                [],
            },
          };
        }
        return serverSettings;
      },
    ),
    getMossAppsStatus: vi.fn(async () => ({ availability: "ready" as const })),
    listMossAppConnections: vi.fn(async () => ({
      connections: [...connected].map((slug) => ({
        connectionId: `conn-${slug}`,
        toolkitSlug: slug,
        status: "active" as const,
        createdAt: "2026-11-26T00:00:00.000Z",
      })),
    })),
    connectMossApp: vi.fn(async (input: { toolkitSlug: string }) => {
      if (options.connectError) throw options.connectError;
      connected.add(input.toolkitSlug);
      return {
        signInUrl: null,
        connection: {
          connectionId: `conn-${input.toolkitSlug}`,
          toolkitSlug: input.toolkitSlug,
          status: "active" as const,
          createdAt: "2026-11-26T00:00:00.000Z",
        },
      };
    }),
    getMossAppConnectFields: vi.fn(async () => ({ fields: [], helpUrl: null })),
    listMcpConnectors: vi.fn(async () => []),
    getMcpConnectorSetup: vi.fn(async () => ({
      redirectUrl: "http://127.0.0.1:4100/callback",
      presets: [],
    })),
    connectMcpConnector: vi.fn(async () => ({ authorizationUrl: null, connector: null })),
    listMossServicePlugins: vi.fn(async () => ({
      installed: [...installedService],
      skills: [],
    })),
    setMossServicePluginInstalled: vi.fn(
      async (input: { pluginId: string; installed: boolean }) => {
        if (input.installed) installedService.add(input.pluginId);
        else installedService.delete(input.pluginId);
        return { installed: [...installedService], skills: [] };
      },
    ),
    mossAccount: {
      session: vi.fn(async () => ({ authenticated: false })),
    },
  };

  const provider = {
    listPlugins: vi.fn(async () => ({
      marketplaces: [
        {
          name: "moss-catalog",
          path: "/tmp/moss-catalog",
          plugins: [],
        },
      ],
    })),
    installPlugin: vi.fn(async () => ({ ok: true })),
  };

  window.nativeApi = { server, provider } as unknown as NativeApi;
  return { server, provider, getSettingsSnapshot: () => serverSettings };
}

afterEach(async () => {
  await cleanup();
  await resetWsNativeApiForTest();
  delete (window as unknown as { nativeApi?: NativeApi }).nativeApi;
  window.localStorage.clear();
  vi.restoreAllMocks();
});

async function mountCard(
  payload: PluginSuggestionActivityPayload,
  extra: {
    provider?: ProviderKind;
    onSendPromptTurn?: (prompt: string) => Promise<boolean>;
    onAccountRequired?: (action: "login" | "account") => void;
  } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <MossLocaleScope locale="zh-CN">
        <PluginSuggestionCard
          payload={payload}
          threadId={threadId}
          cwd="/repo/project"
          provider={extra.provider}
          onSendPromptTurn={extra.onSendPromptTurn}
          onAccountRequired={extra.onAccountRequired}
        />
      </MossLocaleScope>
    </QueryClientProvider>,
  );
  return { screen, queryClient };
}

describe("PluginSuggestionCard", () => {
  it("supports capability preview, Not now / Undo synced to server, and already-connected badges", async () => {
    const { server, getSettingsSnapshot } = installNativeApiMock({ connectedSlugs: ["gmail"] });
    const { screen } = await mountCard({
      suggestionId: "sugg-ui-1",
      suggestions: [
        {
          pluginId: "outlook@moss-apps",
          sourceKind: "moss-app",
          displayName: "Outlook Email",
          developerName: "OpenAI",
          shortDescription: "Triage Outlook inboxes",
          iconUrl: null,
          toolkitSlug: "outlook",
          signIn: "managed",
          requiresAuth: true,
        },
        {
          pluginId: "gmail@moss-apps",
          sourceKind: "moss-app",
          displayName: "Gmail",
          developerName: "Moss",
          shortDescription: "Read and send Gmail",
          iconUrl: null,
          toolkitSlug: "gmail",
          signIn: "managed",
          requiresAuth: true,
        },
      ],
    });

    await expect.element(screen.getByText("Moss 找到了可能有帮助的插件")).toBeVisible();
    await expect.element(screen.getByText("Outlook Email")).toBeVisible();
    await expect.element(screen.getByText("开发者：OpenAI · Triage Outlook inboxes")).toBeVisible();
    await expect.element(screen.getByText("已连接")).toBeVisible();
    expect(document.querySelector('[data-brand-icon="outlook"]')).not.toBeNull();

    // Expand capability preview on Outlook Email.
    const previewTriggers = screen.getByRole("button", { name: "查看能力说明" }).elements();
    await (previewTriggers[0] as HTMLButtonElement).click();
    await expect.element(screen.getByText("OAuth 授权 · 可随时在设置中断开")).toBeVisible();

    await screen.getByRole("button", { name: "以后再说" }).click();
    await expect.element(screen.getByText("已忽略")).toBeVisible();
    await expect
      .poll(() => getSettingsSnapshot().officialPlugins?.dismissedSuggestions?.length ?? 0, {
        timeout: 3_000,
      })
      .toBe(1);
    expect(server.updateSettings).toHaveBeenCalled();

    await screen.getByRole("button", { name: "撤销" }).click();
    await expect.element(screen.getByRole("button", { name: "安装" })).toBeVisible();
    await expect
      .poll(() => getSettingsSnapshot().officialPlugins?.dismissedSuggestions?.length ?? 0, {
        timeout: 3_000,
      })
      .toBe(0);
  });

  it("opens MossAppConnectDialog on Install, supports post-install Continue, and uses the active provider", async () => {
    const { server, provider } = installNativeApiMock();
    const onSendPromptTurn = vi.fn(async () => true);
    const { screen } = await mountCard(
      {
        suggestionId: "sugg-install-1",
        suggestions: [
          {
            pluginId: "outlook@moss-apps",
            sourceKind: "moss-app",
            displayName: "Outlook Email",
            developerName: "OpenAI",
            shortDescription: "Triage Outlook inboxes",
            iconUrl: null,
            toolkitSlug: "outlook",
            signIn: "managed",
            requiresAuth: true,
          },
          {
            pluginId: "flyai@moss-service-plugins",
            sourceKind: "moss-service-plugin",
            displayName: "飞猪 Travel",
            developerName: "Moss",
            shortDescription: "Search flights and trains",
            iconUrl: null,
            servicePluginId: "flyai",
            requiresAuth: false,
          },
          {
            pluginId: "remotion@moss-catalog",
            sourceKind: "moss-catalog",
            displayName: "Remotion",
            developerName: "Remotion",
            shortDescription: "Programmatic video skill",
            iconUrl: null,
            marketplaceName: "moss-catalog",
            pluginName: "remotion",
            requiresAuth: false,
          },
        ],
      },
      { provider: "claudeAgent", onSendPromptTurn },
    );

    const installButtons = screen.getByRole("button", { name: "安装" }).elements();
    expect(installButtons).toHaveLength(3);

    // 1. Installing flyai marks it installed and offers "继续任务" to resume seamlessly.
    await (installButtons[1] as HTMLButtonElement).click();
    await expect
      .poll(() => server.setMossServicePluginInstalled.mock.calls.length, { timeout: 3_000 })
      .toBe(1);
    await expect.element(screen.getByText("已安装")).toBeVisible();
    await screen.getByRole("button", { name: "继续任务" }).click();
    expect(onSendPromptTurn).toHaveBeenCalledWith(expect.stringContaining("飞猪 Travel"));

    // 2. Installing moss-catalog uses the active provider (`claudeAgent`), not hardcoded `codex`.
    await (screen.getByRole("button", { name: "安装" }).elements()[1] as HTMLButtonElement).click();
    await expect.poll(() => provider.installPlugin.mock.calls.length, { timeout: 3_000 }).toBe(1);
    expect(provider.installPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "claudeAgent", pluginName: "remotion" }),
    );

    // 3. Clicking Install on Outlook opens MossAppConnectDialog inline with Outlook brand icon.
    await screen.getByRole("button", { name: "安装" }).click();
    await expect.element(screen.getByRole("dialog")).toBeVisible();
    expect(document.querySelector('[role="dialog"] [data-brand-icon="outlook"]')).not.toBeNull();
  });

  it("opens McpConnectorConnectDialog on Install for mcp-connector suggestions", async () => {
    installNativeApiMock();
    const { screen } = await mountCard({
      suggestionId: "sugg-mcp-1",
      suggestions: [
        {
          pluginId: "notion@mcp-connector",
          sourceKind: "mcp-connector",
          displayName: "Notion",
          developerName: "Notion",
          shortDescription: "Search and edit Notion pages",
          iconUrl: null,
          connectorPresetId: "notion",
          requiresAuth: true,
        },
      ],
    });

    await screen.getByRole("button", { name: "安装" }).click();
    await expect.element(screen.getByRole("dialog")).toBeVisible();
  });

  it("installs Moss 开发者 (moss-developer@moss-bundled) via officialPlugins without needing a workspace", async () => {
    const { server, getSettingsSnapshot } = installNativeApiMock({
      uninstalledOfficial: [MOSS_DEVELOPER_PLUGIN_ID],
    });
    const onSendPromptTurn = vi.fn(async () => true);
    const { screen } = await mountCard(
      {
        suggestionId: "sugg-moss-dev-1",
        suggestions: [
          {
            pluginId: MOSS_DEVELOPER_PLUGIN_ID,
            sourceKind: "moss-bundled",
            displayName: "Moss 开发者",
            developerName: "Moss",
            shortDescription: "一句话零外部密钥打造 Moss 原生应用页与 AI 小工具",
            iconUrl: null,
            marketplaceName: "moss-bundled",
            pluginName: "moss-developer",
            requiresAuth: false,
          },
        ],
      },
      { provider: "claudeAgent", onSendPromptTurn },
    );

    await expect.element(screen.getByText("Moss 开发者")).toBeVisible();
    await screen.getByRole("button", { name: "安装" }).click();
    await expect
      .poll(() => getSettingsSnapshot().officialPlugins?.uninstalled ?? [], { timeout: 3_000 })
      .not.toContain(MOSS_DEVELOPER_PLUGIN_ID);
    expect(server.updateSettings).toHaveBeenCalled();
    await expect.element(screen.getByText("已安装")).toBeVisible();
    await screen.getByRole("button", { name: "继续任务" }).click();
    expect(onSendPromptTurn).toHaveBeenCalledWith(expect.stringContaining("Moss 开发者"));
  });
});
