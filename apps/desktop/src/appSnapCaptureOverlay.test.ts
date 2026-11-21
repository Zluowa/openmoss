import { afterEach, describe, expect, it, vi } from "vitest";

import {
  APP_SNAP_OVERLAY_ANIMATION_MS,
  DesktopAppSnapCaptureOverlay,
  buildAppSnapCaptureOverlayHtml,
  normalizeCaptureOverlayBounds,
  shouldShowAppSnapCaptureOverlay,
  type AppSnapCaptureOverlayWindowLike,
  type AppSnapScreenBounds,
} from "./appSnapCaptureOverlay";

function makeFakeOverlayWindow(
  overrides: Partial<AppSnapCaptureOverlayWindowLike> = {},
): AppSnapCaptureOverlayWindowLike & {
  calls: string[];
  lastBounds: AppSnapScreenBounds | null;
} {
  let destroyed = false;
  const calls: string[] = [];
  const win = {
    calls,
    lastBounds: null as AppSnapScreenBounds | null,
    isDestroyed: () => destroyed,
    setBounds: (bounds: AppSnapScreenBounds) => {
      win.lastBounds = bounds;
      calls.push(`setBounds:${bounds.x},${bounds.y},${bounds.width}x${bounds.height}`);
    },
    showInactive: () => {
      calls.push("showInactive");
    },
    hide: () => {
      calls.push("hide");
    },
    destroy: () => {
      destroyed = true;
      calls.push("destroy");
    },
    executePlay: vi.fn(async () => {
      calls.push("executePlay");
      return true;
    }),
    ...overrides,
  };
  return win;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("appSnapCaptureOverlay policy & geometry", () => {
  it("enables the capture overlay only on Windows when motion is permitted and on-screen", () => {
    expect(shouldShowAppSnapCaptureOverlay({ platform: "win32" })).toBe(true);
    expect(shouldShowAppSnapCaptureOverlay({ platform: "darwin" })).toBe(false);
    expect(shouldShowAppSnapCaptureOverlay({ platform: "linux" })).toBe(false);
    expect(shouldShowAppSnapCaptureOverlay({ platform: "win32", reducedMotion: true })).toBe(false);
    expect(shouldShowAppSnapCaptureOverlay({ platform: "win32", highContrast: true })).toBe(false);
    expect(shouldShowAppSnapCaptureOverlay({ platform: "win32", offscreen: true })).toBe(false);
    expect(shouldShowAppSnapCaptureOverlay({ platform: "win32", disabled: true })).toBe(false);
  });

  it("clamps target bounds to display work area and rejects degenerate rects", () => {
    expect(
      normalizeCaptureOverlayBounds(
        { x: -20.4, y: 10.6, width: 1200.2, height: 800.4 },
        { x: 0, y: 0, width: 1920, height: 1080 },
      ),
    ).toEqual({ x: 0, y: 11, width: 1180, height: 800 });

    expect(normalizeCaptureOverlayBounds({ x: 10, y: 10, width: 20, height: 20 })).toBeNull();
    expect(
      normalizeCaptureOverlayBounds(
        { x: 2500, y: 0, width: 800, height: 600 },
        { x: 0, y: 0, width: 1920, height: 1080 },
      ),
    ).toBeNull();
  });

  it("uses GPU-composited transform/opacity animation in the 180-280ms budget and honors reduced motion", () => {
    expect(APP_SNAP_OVERLAY_ANIMATION_MS).toBeGreaterThanOrEqual(180);
    expect(APP_SNAP_OVERLAY_ANIMATION_MS).toBeLessThanOrEqual(280);
    const html = buildAppSnapCaptureOverlayHtml();
    expect(html).toContain("@media (prefers-reduced-motion: reduce)");
    expect(html).toContain("animation: none");
    expect(html).toContain("window.__mossPlayAppSnapOverlay");
    expect(html).toContain("transform: scale(");
  });
});

describe("DesktopAppSnapCaptureOverlay lifecycle", () => {
  it("prewarms once, plays with converted DIP bounds, and auto-hides after animation", async () => {
    vi.useFakeTimers();
    const win = makeFakeOverlayWindow();
    const createWindow = vi.fn(async () => win);
    const overlay = new DesktopAppSnapCaptureOverlay({
      platform: "win32",
      shouldShow: () => true,
      createWindow,
      toDipBounds: (b) => ({
        x: Math.round(b.x / 1.5),
        y: Math.round(b.y / 1.5),
        width: Math.round(b.width / 1.5),
        height: Math.round(b.height / 1.5),
      }),
      getDisplayBounds: () => ({ x: 0, y: 0, width: 2560, height: 1440 }),
      peakDelayMs: 75,
      hideAfterMs: 260,
    });

    overlay.prewarm();
    await vi.advanceTimersByTimeAsync(0);
    expect(createWindow).toHaveBeenCalledOnce();

    const playPromise = overlay.play({ x: 150, y: 150, width: 1500, height: 900 });
    await vi.advanceTimersByTimeAsync(0);
    expect(win.lastBounds).toEqual({ x: 100, y: 100, width: 1000, height: 600 });
    expect(win.calls).toEqual(["setBounds:100,100,1000x600", "executePlay", "showInactive"]);

    await vi.advanceTimersByTimeAsync(75);
    await expect(playPromise).resolves.toBe(true);

    // Overlay finishes fading out and hides cleanly.
    await vi.advanceTimersByTimeAsync(200);
    expect(win.calls).toContain("hide");

    overlay.dispose();
    expect(win.calls).toContain("destroy");
  });

  it("never shows when the renderer reports prefers-reduced-motion or policy disables it", async () => {
    const win = makeFakeOverlayWindow({
      executePlay: vi.fn(async () => false),
    });
    const overlay = new DesktopAppSnapCaptureOverlay({
      platform: "win32",
      shouldShow: () => true,
      createWindow: vi.fn(async () => win),
      peakDelayMs: 75,
    });

    await expect(overlay.play({ x: 0, y: 0, width: 800, height: 600 })).resolves.toBe(false);
    expect(win.calls).not.toContain("showInactive");
    expect(win.calls).toContain("hide");
    overlay.dispose();
  });

  it("is a no-op on non-Windows platforms and when offscreen policy disables it", async () => {
    const createWindow = vi.fn(async () => makeFakeOverlayWindow());
    const linuxOverlay = new DesktopAppSnapCaptureOverlay({
      platform: "linux",
      shouldShow: () => true,
      createWindow,
    });
    linuxOverlay.prewarm();
    await expect(linuxOverlay.play({ x: 0, y: 0, width: 800, height: 600 })).resolves.toBe(false);
    expect(createWindow).not.toHaveBeenCalled();

    const offscreenOverlay = new DesktopAppSnapCaptureOverlay({
      platform: "win32",
      shouldShow: () => false,
      createWindow,
    });
    offscreenOverlay.prewarm();
    await expect(offscreenOverlay.play({ x: 0, y: 0, width: 800, height: 600 })).resolves.toBe(
      false,
    );
    expect(createWindow).not.toHaveBeenCalled();
  });
});
