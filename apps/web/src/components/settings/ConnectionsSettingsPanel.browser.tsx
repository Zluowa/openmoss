import {
  useConnectionSettingsBrowserTheme,
  captureConnectionDialog,
} from "~/test/connectionSettingsBrowserFixture";
import "../../index.css";
import type { ComputerStatusResult, DesktopBridge } from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { AppSettingsSchema, type AppSettings } from "~/appSettings";
import { MossLocaleScope } from "~/localization";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import type { ConnectionTab } from "~/connectionSettingsNavigation";
import { ConnectionsSettingsPanel } from "./ConnectionsSettingsPanel";

useConnectionSettingsBrowserTheme();

const calls = vi.hoisted(() => ({ getStatus: vi.fn(), updateSettings: vi.fn() }));
vi.mock("~/nativeApi", async (original) => ({
  ...(await original<typeof import("../../nativeApi")>()),
  readNativeApi: () => ({
    computer: { getStatus: calls.getStatus },
    server: { getAuthSession: async () => ({ authenticated: false }) },
  }),
  ensureNativeApi: () => ({
    computer: { getStatus: calls.getStatus },
    server: { getAuthSession: async () => ({ authenticated: false }) },
  }),
}));
const status: ComputerStatusResult = {
  computerId: "desktop",
  availability: { kind: "available", backend: "cua" },
  health: { status: "connected", consecutiveFailures: 0, reconnects: 0, captureAvailable: true },
  capabilities: {
    windows: true,
    windowBounds: true,
    stacking: true,
    capture: true,
    input: true,
    clipboard: true,
    focus: true,
    raise: true,
    ghostCursor: true,
    visibleDesktop: true,
  },
};
function Hub({ initial = "this" }: { initial?: ConnectionTab }) {
  const [tab, setTab] = useState(initial);
  const [settings, setSettings] = useState(() =>
    AppSettingsSchema.makeUnsafe({ computerControlEnabled: false }),
  );
  return (
    <ConnectionsSettingsPanel
      active
      tab={tab}
      onTabChange={setTab}
      settings={settings}
      defaults={AppSettingsSchema.makeUnsafe({})}
      updateSettings={(patch: Partial<AppSettings>) => {
        calls.updateSettings(patch);
        setSettings((current) => ({ ...current, ...patch }));
      }}
    />
  );
}
beforeEach(async () => {
  await page.viewport(1100, 780);
  vi.clearAllMocks();
  calls.getStatus.mockResolvedValue(status);
  window.desktopBridge = {
    ssh: { list: async () => [], listConfigHosts: async () => [] },
  } as unknown as DesktopBridge;
});
afterEach(() => {
  delete window.desktopBridge;
});
const mount = async (initial: ConnectionTab = "this") => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(serverQueryKeys.computerStatus(), status);
  const screen = await render(
    <QueryClientProvider client={client}>
      <MossLocaleScope locale="en">
        <div style={{ width: 760, padding: 24 }}>
          <Hub initial={initial} />
        </div>
      </MossLocaleScope>
    </QueryClientProvider>,
  );
  return { screen, client };
};
it("preserves the real local-computer preference when switching through the hub", async () => {
  const { screen, client } = await mount();
  const local = page.getByRole("tab", { name: "Control this computer", exact: true });
  await expect.element(local).toHaveAttribute("aria-selected", "true");
  const control = page.getByRole("switch", {
    name: "Let the agent use the desktop in any chat",
    exact: true,
  });
  await control.click();
  expect(calls.updateSettings).toHaveBeenCalledWith({ computerControlEnabled: true });
  await expect.element(control).toBeChecked();
  await page.getByRole("tab", { name: "SSH", exact: true }).click();
  await expect.element(page.getByTestId("ssh-connections-settings")).toBeVisible();
  await expect.element(control).not.toBeInTheDocument();
  await local.click();
  await expect.element(control).toBeChecked();
  await screen.unmount();
  client.clear();
});
it("uses keyboard tabs and identifies desktop-only pairing in a browser", async () => {
  const { screen, client } = await mount("ssh");
  const ssh = page.getByRole("tab", { name: "SSH", exact: true });
  await ssh.click();
  await userEvent.keyboard("{Home}");
  await expect
    .element(page.getByRole("tab", { name: "Control this computer" }))
    .toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{ArrowRight}");
  await expect
    .element(page.getByRole("tab", { name: "Control other devices" }))
    .toHaveAttribute("aria-selected", "true");
  await expect
    .element(page.getByTestId("remote-computers-settings"))
    .toHaveTextContent("Add and connect to other devices in the Moss desktop app.");
  await ssh.click();
  await expect.element(ssh).toHaveAttribute("aria-selected", "true");
  await captureConnectionDialog("connection-hub-ssh-empty.png");
  await screen.unmount();
  client.clear();
});
