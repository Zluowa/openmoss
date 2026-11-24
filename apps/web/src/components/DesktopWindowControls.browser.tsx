import "../index.css";

import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({ toastAdd: vi.fn() }));
vi.mock("~/env", () => ({ isElectron: true }));
vi.mock("~/hooks/useDesktopCustomTitleBar", () => ({
  useDesktopCustomTitleBarActive: () => true,
}));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: harness.toastAdd } }));

import { DesktopWindowControls } from "./DesktopWindowControls";

const originalBridge = Object.getOwnPropertyDescriptor(window, "desktopBridge");
afterEach(() => {
  harness.toastAdd.mockReset();
  if (originalBridge) Object.defineProperty(window, "desktopBridge", originalBridge);
  else Reflect.deleteProperty(window, "desktopBridge");
});

it("reports a failed maximize request and lets the user retry", async () => {
  const toggleMaximize = vi
    .fn()
    .mockRejectedValueOnce(new Error("Window is unavailable."))
    .mockResolvedValue({ isMaximized: true, isFullscreen: false });
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: {
      windowControls: {
        getState: vi.fn().mockResolvedValue({ isMaximized: false, isFullscreen: false }),
        onState: vi.fn(() => () => undefined),
        toggleMaximize,
      },
    },
  });
  const view = await render(<DesktopWindowControls />);
  try {
    await page.getByRole("button", { name: "Maximize", exact: true }).click();
    await vi.waitFor(() =>
      expect(harness.toastAdd).toHaveBeenCalledWith({
        type: "error",
        title: "Could not resize window",
        description: "Window is unavailable.",
      }),
    );
    await page.getByRole("button", { name: "Maximize", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
  } finally {
    await view.unmount();
  }
});

it.each([
  ["Minimize", "minimize", "Could not minimize window"],
  ["Close", "close", "Could not close window"],
])("reports a failed %s request and allows retry", async (button, method, title) => {
  const action = vi
    .fn()
    .mockRejectedValueOnce(new Error("Window is unavailable."))
    .mockResolvedValue(undefined);
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: {
      windowControls: {
        getState: vi.fn().mockResolvedValue({ isMaximized: false, isFullscreen: false }),
        onState: vi.fn(() => () => undefined),
        [method]: action,
      },
    },
  });
  const view = await render(<DesktopWindowControls />);
  try {
    await page.getByRole("button", { name: button, exact: true }).click();
    await vi.waitFor(() =>
      expect(harness.toastAdd).toHaveBeenCalledWith({
        type: "error",
        title,
        description: "Window is unavailable.",
      }),
    );
    await page.getByRole("button", { name: button, exact: true }).click();
    expect(action).toHaveBeenCalledTimes(2);
  } finally {
    await view.unmount();
  }
});

it("contains failed initial state reads while keeping native state updates", async () => {
  let publishState!: (state: { isMaximized: boolean; isFullscreen: boolean }) => void;
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: {
      windowControls: {
        getState: vi.fn().mockRejectedValue(new Error("Initial window state is unavailable.")),
        onState: vi.fn((listener) => {
          publishState = listener;
          return () => undefined;
        }),
      },
    },
  });
  const view = await render(<DesktopWindowControls />);
  try {
    await vi.waitFor(() =>
      expect(harness.toastAdd).toHaveBeenCalledWith({
        type: "error",
        title: "Could not read window state",
        description: "Initial window state is unavailable.",
      }),
    );
    publishState({ isMaximized: true, isFullscreen: false });
    await expect.element(page.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
  } finally {
    await view.unmount();
  }
});

it("keeps the window buttons readable over the dark image viewer (walk D-10)", async () => {
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: {
      windowControls: {
        getState: vi.fn().mockResolvedValue({ isMaximized: false, isFullscreen: false }),
        onState: vi.fn(() => () => undefined),
      },
    },
  });
  const view = await render(<DesktopWindowControls />);
  const overlay = document.createElement("div");
  try {
    // Keep the pointer off the buttons: hover tints them on its own.
    const away = document.createElement("div");
    away.style.cssText = "position:fixed;left:0;bottom:0;width:80px;height:80px";
    document.body.append(away);
    await page.elementLocator(away).hover();
    away.remove();
    // Let the 75 ms colour transition settle before reading the page's ink.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const close = page.getByRole("button", { name: "Close", exact: true }).element();
    const inkOnPage = getComputedStyle(close).color;
    // The image viewer marks itself as a dark full-window overlay (#181818).
    overlay.setAttribute("data-dark-window-overlay", "");
    overlay.style.background = "#181818";
    document.body.append(overlay);
    // The palette's white, however the engine spells it (rgb or oklab).
    const lightInk = /^(rgb\(255, 255, 255\)|oklab\((0\.99\d*|1) [-\d.e]+ [-\d.e]+\))$/u;
    await vi.waitFor(() => expect(getComputedStyle(close).color).toMatch(lightInk));
    expect(inkOnPage).not.toMatch(lightInk);
    overlay.remove();
    await vi.waitFor(() => expect(getComputedStyle(close).color).toBe(inkOnPage));
  } finally {
    overlay.remove();
    await view.unmount();
  }
});
