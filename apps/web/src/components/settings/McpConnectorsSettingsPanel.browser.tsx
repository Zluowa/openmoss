// Reconnect must expose the current callback URL without requiring saved credentials again.
import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { McpConnectorsSettingsPanel } from "./McpConnectorsSettingsPanel";

const api = vi.hoisted(() => ({
  listMcpConnectors: vi.fn(),
  getMcpConnectorSetup: vi.fn(),
  connectMcpConnector: vi.fn(),
  openExternal: vi.fn(),
}));
vi.mock("~/nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../nativeApi")>()),
  ensureNativeApi: () => ({ server: api, shell: { openExternal: api.openExternal } }),
}));

it.each(["slack", null])(
  "shows the changed redirect when reconnecting an own-app connector (%s)",
  async (presetId) => {
    const name = presetId ? "Slack" : "Custom app";
    api.listMcpConnectors.mockResolvedValue([
      {
        connectorId: "own-app",
        presetId,
        name,
        url: "https://example.com/mcp",
        serverName: "own_app_connector",
        authKind: "oauth",
        usesOwnOAuthApp: true,
        status: "needs-auth",
        createdAt: "2026-10-14T10:00:00Z",
        updatedAt: "2026-10-14T10:00:00Z",
      },
    ]);
    const redirectUrl = "http://127.0.0.1:5999/oauth/mcp/callback";
    api.getMcpConnectorSetup.mockResolvedValue({ redirectUrl });
    api.connectMcpConnector.mockResolvedValue({
      authorizationUrl: "https://example.com/authorize",
      connector: null,
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <McpConnectorsSettingsPanel active />
      </QueryClientProvider>,
    );
    try {
      await screen.getByRole("button", { name: "Reconnect", exact: true }).click();
      await expect
        .element(screen.getByRole("textbox", { name: "Redirect URL" }), { timeout: 3_000 })
        .toHaveValue(redirectUrl);
      if (presetId === "slack") {
        // Links in the consent text are the shared TextLink and open in the system browser.
        for (const [label, url] of [
          ["Learn more", "https://docs.slack.dev/ai/slack-mcp-server/"],
          ["Create an app", "https://api.slack.com/apps"],
        ] as const) {
          const link = screen.getByRole("link", { name: label, exact: true });
          await expect.element(link).toBeVisible();
          expect(link.element().getAttribute("data-slot")).toBe("text-link");
          expect(getComputedStyle(link.element()).cursor).toBe("pointer");
          await link.click();
          expect(api.openExternal).toHaveBeenLastCalledWith(url);
        }
      }
      const connect = screen.getByRole("button", { name: `Continue to ${name}` });
      await expect.element(connect).toBeEnabled();
      await connect.click();
      await expect
        .poll(() => api.connectMcpConnector.mock.calls.at(-1)?.[0])
        .toEqual(presetId ? { presetId } : { url: "https://example.com/mcp", name });
    } finally {
      await screen.unmount();
      queryClient.clear();
      vi.clearAllMocks();
    }
  },
);

it("draws Get a key in the API-key connector dialog as the shared TextLink, opening the vendor's page", async () => {
  const { McpConnectorConnectDialog, mcpConnectorPresetTarget } =
    await import("./McpConnectorConnectDialog");
  const { MCP_CONNECTOR_PRESETS } = await import("@moss/shared/mcpConnectors");
  const amap = MCP_CONNECTOR_PRESETS.find((preset) => preset.id === "amap")!;
  api.getMcpConnectorSetup.mockResolvedValue({ redirectUrl: "http://127.0.0.1:5999/cb" });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <McpConnectorConnectDialog
        target={mcpConnectorPresetTarget(amap)}
        onOpenChange={() => {}}
        onConnected={() => {}}
      />
    </QueryClientProvider>,
  );
  try {
    const link = screen.getByRole("link", { name: "Get a key", exact: true });
    await expect.element(link).toBeVisible();
    expect(link.element().getAttribute("data-slot")).toBe("text-link");
    expect(getComputedStyle(link.element()).cursor).toBe("pointer");
    await link.click();
    expect(api.openExternal).toHaveBeenLastCalledWith("https://console.amap.com/dev/key/app");
  } finally {
    await screen.unmount();
    queryClient.clear();
    vi.clearAllMocks();
  }
});
