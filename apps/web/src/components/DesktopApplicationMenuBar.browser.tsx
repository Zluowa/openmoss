// FILE: DesktopApplicationMenuBar.browser.tsx
// Purpose: The full-window pages (图像, 资料空间) get a bare title band on Windows to drag the
//          window by: no arrows of its own (the shell's one cluster serves every page, walk R-9),
//          no 文件 编辑 视图 帮助 menus.
// Layer: Browser UI test

import "../index.css";

import { render } from "vitest-browser-react";
import { describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ mac: false }));
vi.mock("~/env", async (original) => ({
  ...(await original<typeof import("~/env")>()),
  isElectron: true,
}));
vi.mock("~/lib/utils", async (original) => ({
  ...(await original<typeof import("~/lib/utils")>()),
  isMacNavigatorPlatform: () => platform.mac,
}));

import { DesktopApplicationMenuBar } from "./DesktopApplicationMenuBar";

describe("DesktopApplicationMenuBar", () => {
  it("is a bare drag band under the shell's controls on Windows, and absent on macOS", async () => {
    const screen = await render(<DesktopApplicationMenuBar />);
    const band = screen.container.querySelector<HTMLElement>("[data-moss-destination-menubar]")!;
    expect(band).not.toBeNull();
    expect(band.querySelectorAll("button, a, [role='menuitem']")).toHaveLength(0);
    expect(band.textContent).toBe("");
    expect(getComputedStyle(band).getPropertyValue("-webkit-app-region")).toBe("drag");
    // Under the cluster the dock paints (z-30), so the cluster takes the clicks.
    expect(Number(getComputedStyle(band).zIndex)).toBeLessThan(30);
    await screen.unmount();

    platform.mac = true;
    const mac = await render(<DesktopApplicationMenuBar />);
    expect(mac.container.querySelector("[data-moss-destination-menubar]")).toBeNull();
    await mac.unmount();
    platform.mac = false;
  });
});
