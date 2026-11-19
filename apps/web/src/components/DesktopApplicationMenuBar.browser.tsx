// FILE: DesktopApplicationMenuBar.browser.tsx
// Purpose: The full-window pages (图像, 资料空间) show the same title bar as every other
//          page on Windows: route arrows, no 文件 编辑 视图 帮助 menus.
// Layer: Browser UI test

import "../index.css";

import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("~/env", async (original) => ({
  ...(await original<typeof import("~/env")>()),
  isElectron: true,
}));
vi.mock("~/lib/utils", async (original) => ({
  ...(await original<typeof import("~/lib/utils")>()),
  isMacNavigatorPlatform: () => false,
}));
vi.mock("./AppNavigationButtons", () => ({
  AppNavigationButtons: () => (
    <span>
      <button type="button">Back</button>
      <button type="button">Forward</button>
    </span>
  ),
}));

import { DesktopApplicationMenuBar } from "./DesktopApplicationMenuBar";

afterEach(() => {
  delete (window as { desktopBridge?: unknown }).desktopBridge;
});

describe("DesktopApplicationMenuBar", () => {
  it("shows the route arrows and no application menus", async () => {
    // The bridge offers the native menus, as in the packaged app.
    (window as { desktopBridge?: unknown }).desktopBridge = {
      showApplicationMenu: vi.fn(async () => undefined),
    };
    const screen = await render(<DesktopApplicationMenuBar />);
    await expect.element(page.getByRole("button", { name: "Back" })).toBeVisible();
    for (const menu of ["文件", "编辑", "视图", "帮助"]) {
      expect(page.getByRole("button", { name: menu, exact: true }).elements()).toHaveLength(0);
    }
    await screen.unmount();
  });
});
