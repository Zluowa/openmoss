import "../../index.css";

import type { DesktopBehaviorState, DesktopBridge } from "@moss/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { DesktopTraySettingsSection } from "./DesktopTraySettingsSection";

const originalBridge = window.desktopBridge;

afterEach(() => {
  if (originalBridge) window.desktopBridge = originalBridge;
  else delete window.desktopBridge;
});

function installBehaviorBridge(initial: DesktopBehaviorState) {
  let state = initial;
  const getState = vi.fn(async () => state);
  const setCloseToTray = vi.fn(async (enabled: boolean) => {
    state = { ...state, closeToTray: enabled };
    return state;
  });
  const setOpenAtLogin = vi.fn(async (enabled: boolean) => {
    state = { ...state, openAtLogin: enabled };
    return state;
  });

  window.desktopBridge = {
    desktopBehavior: {
      getState,
      setCloseToTray,
      setOpenAtLogin,
      updateTrayStatus: vi.fn(async () => undefined),
    },
  } as unknown as DesktopBridge;

  return { getState, setCloseToTray, setOpenAtLogin };
}

describe("DesktopTraySettingsSection", () => {
  it("renders nothing when the desktop behavior bridge is absent", async () => {
    delete window.desktopBridge;
    const screen = await render(<DesktopTraySettingsSection />);
    try {
      expect(screen.container.innerHTML).toBe("");
    } finally {
      await screen.unmount();
    }
  });

  it("renders both switches on Windows and persists toggles", async () => {
    const mocks = installBehaviorBridge({
      closeToTray: true,
      closeToTraySupported: true,
      openAtLogin: false,
      openAtLoginSupported: true,
    });
    const screen = await render(<DesktopTraySettingsSection />);
    try {
      const closeSwitch = page.getByRole("switch", { name: "Close to system tray" });
      const loginSwitch = page.getByRole("switch", { name: "Launch at login" });
      await expect.element(closeSwitch).toHaveAttribute("aria-checked", "true");
      await expect.element(loginSwitch).toHaveAttribute("aria-checked", "false");

      await closeSwitch.click();
      await expect.element(closeSwitch).toHaveAttribute("aria-checked", "false");
      expect(mocks.setCloseToTray).toHaveBeenCalledWith(false);

      await loginSwitch.click();
      await expect.element(loginSwitch).toHaveAttribute("aria-checked", "true");
      expect(mocks.setOpenAtLogin).toHaveBeenCalledWith(true);
    } finally {
      await screen.unmount();
    }
  });

  it("hides close-to-tray on macOS while keeping launch-at-login", async () => {
    installBehaviorBridge({
      closeToTray: false,
      closeToTraySupported: false,
      openAtLogin: true,
      openAtLoginSupported: true,
    });
    const screen = await render(<DesktopTraySettingsSection />);
    try {
      await expect
        .element(page.getByRole("switch", { name: "Close to system tray" }))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByRole("switch", { name: "Launch at login" }))
        .toHaveAttribute("aria-checked", "true");
    } finally {
      await screen.unmount();
    }
  });

  it("omits launch-at-login when unsupported on Linux or unpackaged builds", async () => {
    installBehaviorBridge({
      closeToTray: true,
      closeToTraySupported: true,
      openAtLogin: false,
      openAtLoginSupported: false,
    });
    const screen = await render(<DesktopTraySettingsSection />);
    try {
      await expect
        .element(page.getByRole("switch", { name: "Close to system tray" }))
        .toHaveAttribute("aria-checked", "true");
      await expect
        .element(page.getByRole("switch", { name: "Launch at login" }))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("renders nothing when neither setting is supported", async () => {
    installBehaviorBridge({
      closeToTray: false,
      closeToTraySupported: false,
      openAtLogin: false,
      openAtLoginSupported: false,
    });
    const screen = await render(<DesktopTraySettingsSection />);
    try {
      await vi.waitFor(() => {
        expect(screen.container.innerHTML).toBe("");
      });
    } finally {
      await screen.unmount();
    }
  });
});
