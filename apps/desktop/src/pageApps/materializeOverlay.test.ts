import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: vi.fn(),
  nativeTheme: { shouldUseDarkColors: false },
  screen: {
    getDisplayMatching: vi.fn(() => ({
      workArea: { x: 0, y: 0, width: 1440, height: 900 },
      scaleFactor: 1,
    })),
  },
  systemPreferences: { getAnimationSettings: () => ({ shouldRenderRichAnimation: false }) },
}));

import { startInstallMaterializeEffect } from "./materializeOverlay";

describe("materializeOverlay", () => {
  it("gracefully degrades and reveals target window when Reduce Motion is active", async () => {
    let visible = false;
    let revealed = false;
    const fakeWindow = {
      isDestroyed: () => false,
      isFullScreen: () => false,
      isMinimized: () => false,
      isVisible: () => visible,
      once: vi.fn(),
      removeListener: vi.fn(),
      showInactive: vi.fn(() => {
        visible = true;
      }),
      focus: vi.fn(),
      setOpacity: vi.fn(),
      getBounds: () => ({ x: 100, y: 100, width: 800, height: 600 }),
    };

    const handle = startInstallMaterializeEffect({
      targetWindow: fakeWindow as never,
      hiddenTarget: true,
      onRevealTarget: () => {
        revealed = true;
      },
    });

    expect(await handle.sourceCovered).toBe(false);
    handle.reveal();
    await handle.finished;
    expect(revealed).toBe(true);
    expect(fakeWindow.showInactive).toHaveBeenCalledTimes(1);
  });
});
