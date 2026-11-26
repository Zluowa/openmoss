// FILE: PageAppList.desktopApps.browser.tsx
// Purpose: Browser component tests for PageAppList desktop installation badges
//          and install / open desktop app action buttons.
// Layer: Web browser tests

import "../../index.css";

import type {
  DesktopPageAppsBridge,
  InstalledDesktopPageApp,
  PageApp,
  PageAppId,
} from "@moss/contracts";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { MossLocaleScope } from "~/localization";
import { SidebarProvider } from "../ui/sidebar";
import { pageAppsClient } from "./pageAppsClient";
import { PageAppList } from "./PageAppList";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children, to }: { children?: ReactNode; to?: string }) => (
    <a href={typeof to === "string" ? to : "#"}>{children}</a>
  ),
}));

const APP_1 = "app-list-1" as PageAppId;
const APP_2 = "app-list-2" as PageAppId;

function makePageApp(id: PageAppId, title: string): PageApp {
  const now = "2026-11-26T00:00:00.000Z";
  return {
    id,
    scopeSpaceId: null,
    spaceId: null,
    title,
    description: "",
    revision: 1,
    capabilities: { desktop: { permissions: ["notifications"] } },
    favorite: false,
    thumbnail: null,
    sourceThreadId: null,
    htmlChars: 256,
    trashedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function makeInstalled(appId: PageAppId, name: string): InstalledDesktopPageApp {
  return {
    installId:
      appId === APP_1 ? "11111111111111111111111111111111" : "22222222222222222222222222222222",
    appId,
    name,
    revision: 1,
    places: ["start-menu", "desktop"],
    installedAt: "2026-11-26T00:00:00.000Z",
  };
}

function createMockDesktopBridge(initial: InstalledDesktopPageApp[]) {
  let installed = [...initial];
  const listeners = new Set<(apps: readonly InstalledDesktopPageApp[]) => void>();
  const emit = (next: InstalledDesktopPageApp[]) => {
    installed = next;
    for (const listener of listeners) listener(installed);
  };

  const bridge: DesktopPageAppsBridge = {
    isAvailable: vi.fn(async () => true),
    installFromPage: vi.fn<DesktopPageAppsBridge["installFromPage"]>(async (input) => {
      const record = makeInstalled(input.appId, input.title ?? "应用页");
      emit([...installed.filter((item) => item.appId !== input.appId), record]);
      return { status: "installed", app: record, opened: true };
    }),
    requestInstall: vi.fn<DesktopPageAppsBridge["requestInstall"]>(async () => ({
      status: "cancelled",
    })),
    isInstalled: vi.fn(async (appId) => installed.some((item) => item.appId === appId)),
    getInstalled: vi.fn(async (appId) => installed.find((item) => item.appId === appId) ?? null),
    listInstalled: vi.fn(async () => installed),
    openInstalled: vi.fn(async () => ({ opened: true, windowId: 12 })),
    uninstall: vi.fn(async () => ({
      uninstalled: true,
      removedAppIds: [],
      removedInstallIds: [],
    })),
    showInFolder: vi.fn(async () => true),
    openPermissions: vi.fn(async () => undefined),
    getPermissions: vi.fn(async (input) => ({
      appId: input.appId,
      revision: 1,
      contentHash: null,
      declared: [],
      states: {},
      details: {},
    })),
    requestPermissions: vi.fn(async () => ({})),
    setPermission: vi.fn(async (input) => ({
      appId: input.appId,
      revision: 1,
      contentHash: null,
      declared: [],
      states: {},
      details: {},
    })),
    syncAppVersion: vi.fn(async () => ({ invalidated: false, reloaded: false })),
    reportAppGone: vi.fn(async () => undefined),
    offerInMenu: vi.fn(async () => undefined),
    onPickedInMenu: vi.fn(() => () => undefined),
    onInstalledChanged: vi.fn((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    invokeDesktopApi: vi.fn(async () => null),
  };

  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    writable: true,
    value: { pageApps: bridge },
  });

  return { bridge, emit };
}

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "desktopBridge");
});

describe("PageAppList Desktop Page Apps", () => {
  it("shows installed badge and open/install buttons and updates live when installed state changes", async () => {
    await page.viewport(1024, 720);
    const mock = createMockDesktopBridge([makeInstalled(APP_1, "轨道追踪器")]);
    vi.spyOn(pageAppsClient, "list").mockResolvedValue({
      apps: [makePageApp(APP_1, "轨道追踪器"), makePageApp(APP_2, "桌面计时器")],
    });

    const screen = await render(
      <MossLocaleScope locale="zh-CN">
        <SidebarProvider open>
          <div style={{ position: "fixed", inset: 0, display: "flex" }}>
            <PageAppList />
          </div>
        </SidebarProvider>
      </MossLocaleScope>,
    );

    try {
      const card1 = page.getByTestId(`page-app-card-${APP_1}`);
      const card2 = page.getByTestId(`page-app-card-${APP_2}`);
      await expect.element(card1).toBeVisible();
      await expect.element(card2).toBeVisible();
      expect(card1.element().getBoundingClientRect().width).toBeGreaterThan(150);
      expect(card2.element().getBoundingClientRect().height).toBeGreaterThan(100);

      const badge1 = page.getByTestId(`page-app-installed-badge-${APP_1}`);
      await expect.element(badge1).toBeVisible();
      await expect.element(badge1).toHaveTextContent("已安装");
      await expect
        .element(page.getByTestId(`page-app-installed-badge-${APP_2}`))
        .not.toBeInTheDocument();

      const action1 = page.getByTestId(`page-app-card-desktop-action-${APP_1}`);
      const action2 = page.getByTestId(`page-app-card-desktop-action-${APP_2}`);
      await expect.element(action1).toHaveTextContent("打开桌面应用");
      await expect.element(action2).toHaveTextContent("安装为应用");
      expect(action1.element().getBoundingClientRect().height).toBeGreaterThan(20);
      expect(action2.element().getBoundingClientRect().width).toBeGreaterThan(60);

      await userEvent.click(action1);
      expect(mock.bridge.openInstalled).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: APP_1,
          installId: "11111111111111111111111111111111",
        }),
      );

      // Installed card also provides compact overflow menu actions.
      const cardMenuTrigger = page.getByTestId(`page-app-card-desktop-menu-trigger-${APP_1}`);
      await expect.element(cardMenuTrigger).toBeVisible();
      await userEvent.click(cardMenuTrigger);
      await expect.element(page.getByRole("menuitem", { name: "打开应用" })).toBeVisible();
      await expect.element(page.getByRole("menuitem", { name: "桌面权限…" })).toBeVisible();
      await expect.element(page.getByRole("menuitem", { name: "在文件夹中显示" })).toBeVisible();
      await expect.element(page.getByRole("menuitem", { name: "卸载应用…" })).toBeVisible();

      await userEvent.click(page.getByRole("menuitem", { name: "桌面权限…" }));
      expect(mock.bridge.openPermissions).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: APP_1,
          installId: "11111111111111111111111111111111",
          permissions: ["notifications"],
        }),
      );

      await userEvent.click(cardMenuTrigger);
      await userEvent.click(page.getByRole("menuitem", { name: "在文件夹中显示" }));
      expect(mock.bridge.showInFolder).toHaveBeenCalledWith({
        appId: APP_1,
        installId: "11111111111111111111111111111111",
      });

      await userEvent.click(action2);
      await vi.waitFor(() => {
        expect(mock.bridge.installFromPage).toHaveBeenCalledWith(
          expect.objectContaining({
            appId: APP_2,
            title: "桌面计时器",
          }),
        );
      });
      await expect.element(page.getByTestId(`page-app-installed-badge-${APP_2}`)).toBeVisible();
      await expect.element(action2).toHaveTextContent("打开桌面应用");

      await userEvent.click(page.getByTestId(`page-app-card-desktop-menu-trigger-${APP_2}`));
      await userEvent.click(page.getByRole("menuitem", { name: "卸载应用…" }));
      await vi.waitFor(() => {
        expect(mock.bridge.uninstall).toHaveBeenCalledWith({
          appId: APP_2,
          installId: "22222222222222222222222222222222",
        });
      });
      await expect
        .element(page.getByTestId(`page-app-installed-badge-${APP_2}`))
        .not.toBeInTheDocument();

      mock.emit([]);
      await expect.element(badge1).not.toBeInTheDocument();
      await expect.element(action1).toHaveTextContent("安装为应用");
      await expect.element(action2).toHaveTextContent("安装为应用");
    } finally {
      await screen.unmount();
    }
  });
});
