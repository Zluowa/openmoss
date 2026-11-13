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
function Hub({ initial = "devices" }: { initial?: Exclude<ConnectionTab, "this"> }) {
  const [tab, setTab] = useState(initial);
  return (
    <ConnectionsSettingsPanel
      active
      tab={tab}
      onTabChange={(next) => setTab(next === "this" ? "devices" : next)}
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
const mount = async (initial: Exclude<ConnectionTab, "this"> = "devices") => {
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
it("holds connections only: no computer-use controls on any tab", async () => {
  const { screen, client } = await mount();
  await expect
    .element(page.getByRole("tab", { name: "Other devices", exact: true }))
    .toHaveAttribute("aria-selected", "true");
  await expect
    .element(page.getByRole("tab", { name: "Control this computer" }))
    .not.toBeInTheDocument();
  for (const name of ["Other devices", "Pair a device", "SSH"]) {
    await page.getByRole("tab", { name, exact: true }).click();
    await expect
      .element(page.getByRole("switch", { name: /desktop|apps on your computer/ }))
      .not.toBeInTheDocument();
  }
  await expect.element(page.getByTestId("ssh-connections-settings")).toBeVisible();
  await screen.unmount();
  client.clear();
});
it("uses keyboard tabs and identifies desktop-only pairing in a browser", async () => {
  const { screen, client } = await mount("ssh");
  const ssh = page.getByRole("tab", { name: "SSH", exact: true });
  await ssh.click();
  await userEvent.keyboard("{Home}");
  await expect
    .element(page.getByRole("tab", { name: "Other devices" }))
    .toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{ArrowRight}");
  await expect
    .element(page.getByRole("tab", { name: "Phone", exact: true }))
    .toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{ArrowRight}");
  await expect
    .element(page.getByRole("tab", { name: "Pair a device" }))
    .toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{Home}");
  await expect
    .element(page.getByTestId("remote-computers-settings"))
    .toHaveTextContent("Add and connect to other devices in the Moss desktop app.");
  await ssh.click();
  await expect.element(ssh).toHaveAttribute("aria-selected", "true");
  await captureConnectionDialog("connection-hub-ssh-empty.png");
  await screen.unmount();
  client.clear();
});
