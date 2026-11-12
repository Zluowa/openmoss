import "../../index.css";

import type { ComputerStatusResult, ServerSettings } from "@moss/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { AppSettingsSchema } from "~/appSettings";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import { installZhCnUiLocalization, uninstallZhCnUiLocalization } from "~/localization/zhCN";
import { BrowserThemeFixture, installBrowserFixtureTheme } from "~/test/browserThemeFixture";
import { ComputerSettingsPanel } from "./ComputerSettingsPanel";

let restoreTheme: (() => void) | undefined;

const api = vi.hoisted(() => ({
  getStatus: vi.fn(),
  getAuditHistory: vi.fn(),
  listUsedApps: vi.fn(),
  updateSettings: vi.fn(),
}));
vi.mock("~/nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../nativeApi")>()),
  ensureNativeApi: () => ({
    computer: {
      getStatus: api.getStatus,
      getAuditHistory: api.getAuditHistory,
      listUsedApps: api.listUsedApps,
    },
    server: { updateSettings: api.updateSettings },
  }),
}));

const STATUS: ComputerStatusResult = {
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
    focus: false,
    raise: false,
    ghostCursor: false,
    visibleDesktop: true,
  },
};

let serverSettings: ServerSettings;

beforeEach(async () => {
  await page.viewport(900, 1000);
  vi.resetAllMocks();
  serverSettings = DEFAULT_SERVER_SETTINGS;
  api.getStatus.mockResolvedValue(STATUS);
  api.listUsedApps.mockResolvedValue({
    apps: [
      { name: "Google Chrome", iconPath: "C:\\Chrome\\chrome.exe" },
      { name: "Notepad", iconPath: "C:\\Windows\\System32\\notepad.exe" },
      { name: "WeChat" },
    ],
  });
  api.updateSettings.mockImplementation(async (patch: Partial<ServerSettings>) => {
    serverSettings = { ...serverSettings, ...patch } as ServerSettings;
    return serverSettings;
  });
  // A coloured square stands in for the system icon the desktop app reads.
  vi.stubGlobal("desktopBridge", {
    getAppFileIcon: vi.fn(async (path: string) =>
      path.includes("chrome")
        ? "data:image/svg+xml;utf8," +
          encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#2f7cf6"/></svg>',
          )
        : null,
    ),
  });
});

afterEach(() => {
  restoreTheme?.();
  restoreTheme = undefined;
  uninstallZhCnUiLocalization();
  document.documentElement.removeAttribute("lang");
  delete document.documentElement.dataset.mossLocale;
  vi.unstubAllGlobals();
});

async function mount(masterEnabled = true) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(serverQueryKeys.computerStatus(), STATUS);
  queryClient.setQueryData(serverQueryKeys.settings(), serverSettings);
  const settings = AppSettingsSchema.makeUnsafe({ computerControlEnabled: masterEnabled });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <BrowserThemeFixture>
        <div style={{ width: 720, padding: 24 }} className="bg-background text-foreground">
          <ComputerSettingsPanel
            settings={settings}
            defaults={settings}
            updateSettings={vi.fn()}
            active
          />
        </div>
      </BrowserThemeFixture>
    </QueryClientProvider>,
  );
  return { screen, queryClient };
}

it("lists every app Moss used with its own switch, and a switch writes the server setting", async () => {
  const { screen, queryClient } = await mount();
  await expect.element(screen.getByText("Google Chrome")).toBeVisible();
  await expect.element(screen.getByText("Notepad")).toBeVisible();
  await expect.element(screen.getByText("WeChat")).toBeVisible();
  expect(api.listUsedApps).toHaveBeenCalledWith({});
  // The desktop icon is used when it can be read, a letter otherwise.
  await expect
    .poll(() =>
      document
        .querySelector('[data-app="Google Chrome"] [data-app-icon]')
        ?.getAttribute("data-app-icon"),
    )
    .toBe("system");
  expect(
    document.querySelector('[data-app="WeChat"] [data-app-icon]')?.getAttribute("data-app-icon"),
  ).toBe("letter");

  const chrome = screen.getByRole("switch", { name: "Let Moss use Google Chrome" });
  await expect.element(chrome).toBeChecked();
  await chrome.click();
  await expect.poll(() => api.updateSettings.mock.calls.length).toBe(1);
  expect(api.updateSettings).toHaveBeenLastCalledWith({
    computer: { blockedApps: ["Google Chrome"], alwaysAllowedApps: [] },
  });
  await expect.element(chrome).not.toBeChecked();
  await expect.element(screen.getByText("Moss won't use this app")).toBeVisible();

  await chrome.click();
  await expect.poll(() => api.updateSettings.mock.calls.length).toBe(2);
  expect(api.updateSettings).toHaveBeenLastCalledWith({
    computer: { blockedApps: [], alwaysAllowedApps: [] },
  });
  await screen.unmount();
  queryClient.clear();
});

it("adds and removes an always allowed app, and turning an app off takes it out", async () => {
  const { screen, queryClient } = await mount();
  await expect.element(screen.getByTestId("computer-always-allowed-empty")).toBeVisible();

  await screen.getByRole("button", { name: "Add an always allowed app" }).click();
  await page.getByRole("menuitem", { name: "Notepad" }).click();
  await expect.poll(() => api.updateSettings.mock.calls.length).toBe(1);
  expect(api.updateSettings).toHaveBeenLastCalledWith({
    computer: { blockedApps: [], alwaysAllowedApps: ["Notepad"] },
  });
  await expect
    .poll(() => document.querySelectorAll('[data-testid="computer-always-allowed-row"]').length)
    .toBe(1);

  // A turned-off app is never "always allowed".
  await screen.getByRole("switch", { name: "Let Moss use Notepad" }).click();
  await expect.poll(() => api.updateSettings.mock.calls.length).toBe(2);
  expect(api.updateSettings).toHaveBeenLastCalledWith({
    computer: { blockedApps: ["Notepad"], alwaysAllowedApps: [] },
  });
  await expect.element(screen.getByTestId("computer-always-allowed-empty")).toBeVisible();

  await screen.getByRole("switch", { name: "Let Moss use Notepad" }).click();
  await screen.getByRole("button", { name: "Add an always allowed app" }).click();
  await page.getByRole("menuitem", { name: "Notepad" }).click();
  await screen.getByRole("button", { name: "Stop always allowing Notepad" }).click();
  await expect.poll(() => api.updateSettings.mock.calls.length).toBe(5);
  expect(api.updateSettings).toHaveBeenLastCalledWith({
    computer: { blockedApps: [], alwaysAllowedApps: [] },
  });
  await screen.unmount();
  queryClient.clear();
});

it("keeps a choice visible for an app no longer in the used list, and waits while Any app is off", async () => {
  serverSettings = {
    ...DEFAULT_SERVER_SETTINGS,
    computer: { blockedApps: ["Photoshop"], alwaysAllowedApps: [] },
  };
  const { screen, queryClient } = await mount(false);
  await expect.element(screen.getByText("Photoshop")).toBeVisible();
  const photoshop = screen.getByRole("switch", { name: "Let Moss use Photoshop" });
  await expect.element(photoshop).toBeDisabled();
  await expect.element(photoshop).not.toBeChecked();
  await expect.element(screen.getByText("Off while Any app is off").first()).toBeVisible();
  await screen.unmount();
  queryClient.clear();
});

it("shows a plain line before Moss has used any app", async () => {
  api.listUsedApps.mockResolvedValue({ apps: [] });
  const { screen, queryClient } = await mount();
  await expect.element(screen.getByTestId("computer-apps-empty")).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Add an always allowed app" }))
    .toBeDisabled();
  await screen.unmount();
  queryClient.clear();
});

it.each(["dark", "light"] as const)("reads in Chinese (%s) — screenshot", async (theme) => {
  restoreTheme = installBrowserFixtureTheme(theme);
  document.documentElement.lang = "zh-CN";
  document.documentElement.dataset.mossLocale = "zh-CN";
  installZhCnUiLocalization();
  serverSettings = {
    ...DEFAULT_SERVER_SETTINGS,
    computer: { blockedApps: ["WeChat"], alwaysAllowedApps: ["Notepad"] },
  };
  const { screen, queryClient } = await mount();
  await expect.element(screen.getByText("任意应用")).toBeVisible();
  await expect.element(screen.getByText("始终允许的应用")).toBeVisible();
  await expect.element(screen.getByText("Moss 不会使用这个应用")).toBeVisible();
  await expect.element(screen.getByText("使用前会先询问你")).toBeVisible();
  await expect.element(screen.getByText("使用时不再询问").first()).toBeVisible();
  // App names are the apps' own words and are never translated.
  await expect.element(screen.getByText("Notepad").first()).toBeVisible();
  await expect
    .poll(() =>
      document
        .querySelector('[data-app="Google Chrome"] [data-app-icon]')
        ?.getAttribute("data-app-icon"),
    )
    .toBe("system");
  await page.screenshot({ path: `__screenshots__/computer-app-controls/zh-CN-${theme}.png` });
  await screen.unmount();
  queryClient.clear();
});
