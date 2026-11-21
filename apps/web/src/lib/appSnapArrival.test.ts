import { afterEach, describe, expect, it, vi } from "vitest";

import {
  APP_SNAP_FLIGHT_DURATION_MS,
  APP_SNAP_SETTLE_DURATION_MS,
  APP_SNAP_WINDOW_RETURN_MS,
  completeAppSnapFlight,
  computeAppSnapFlightVector,
  getActiveAppSnapFlight,
  getAppSnapCaptureMotionPhase,
  isRecentlyArrivedAppSnapCapture,
  launchAppSnapFlight,
  markAppSnapCaptureArrived,
  resetAppSnapArrivalStateForTests,
  scheduleAppSnapWindowReturnAnimation,
  triggerAppSnapWindowReturnAnimation,
} from "./appSnapArrival";

afterEach(() => {
  resetAppSnapArrivalStateForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("appSnapArrival", () => {
  it("keeps all AppSnap motion timings within the crisp 180-280ms budget", () => {
    expect(APP_SNAP_WINDOW_RETURN_MS).toBeGreaterThanOrEqual(180);
    expect(APP_SNAP_WINDOW_RETURN_MS).toBeLessThanOrEqual(280);
    expect(APP_SNAP_FLIGHT_DURATION_MS).toBeGreaterThanOrEqual(180);
    expect(APP_SNAP_FLIGHT_DURATION_MS).toBeLessThanOrEqual(280);
    expect(APP_SNAP_SETTLE_DURATION_MS).toBeGreaterThanOrEqual(180);
    expect(APP_SNAP_SETTLE_DURATION_MS).toBeLessThanOrEqual(280);
  });

  it("tracks freshly arrived capture ids within their short entrance window", () => {
    markAppSnapCaptureArrived("cap-1", 1_000);
    expect(isRecentlyArrivedAppSnapCapture("cap-1", 1_200)).toBe(true);
    expect(getAppSnapCaptureMotionPhase("cap-1", 1_200)).toBe("entering");
    expect(isRecentlyArrivedAppSnapCapture("cap-other", 1_200)).toBe(false);
    expect(isRecentlyArrivedAppSnapCapture("cap-1", 3_500)).toBe(false);
    expect(getAppSnapCaptureMotionPhase("cap-1", 3_500)).toBe("idle");
  });

  it("computes a downward GPU flight vector into the composer target rect", () => {
    const vector = computeAppSnapFlightVector({
      targetRect: { left: 260, top: 680, width: 208, height: 128 },
      viewport: { width: 1280, height: 900 },
    });
    expect(vector.startDy).toBeLessThan(-100);
    expect(vector.startScale).toBeGreaterThan(1.3);
    expect(vector.midScale).toBeGreaterThan(1);
    expect(vector.midScale).toBeLessThan(vector.startScale);
    expect(vector.durationMs).toBe(APP_SNAP_FLIGHT_DURATION_MS);

    const leftBiased = computeAppSnapFlightVector({
      targetRect: { left: 540, top: 680, width: 208, height: 128 },
      viewport: { width: 1280, height: 900 },
      sourceWindowBounds: { x: 40, y: 80, width: 600, height: 500 },
      screenWidth: 1920,
    });
    const rightBiased = computeAppSnapFlightVector({
      targetRect: { left: 540, top: 680, width: 208, height: 128 },
      viewport: { width: 1280, height: 900 },
      sourceWindowBounds: { x: 1280, y: 80, width: 600, height: 500 },
      screenWidth: 1920,
    });
    expect(leftBiased.startDx).toBeLessThan(rightBiased.startDx);
  });

  it("transitions cleanly from entering -> flying -> settling -> idle and respects reduced motion", () => {
    vi.useFakeTimers();
    vi.stubGlobal("document", { visibilityState: "visible" });
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });

    markAppSnapCaptureArrived("cap-fly");
    expect(getAppSnapCaptureMotionPhase("cap-fly")).toBe("entering");

    expect(
      launchAppSnapFlight({
        captureId: "cap-fly",
        previewUrl: "blob:cap-fly",
        appName: "Chrome",
        windowTitle: "Docs",
        appIconDataUrl: null,
        sourceWindowBounds: null,
        withReturnVeil: true,
      }),
    ).toBe(true);
    expect(getActiveAppSnapFlight()?.captureId).toBe("cap-fly");
    expect(getAppSnapCaptureMotionPhase("cap-fly")).toBe("flying");

    completeAppSnapFlight("cap-fly");
    expect(getActiveAppSnapFlight()).toBeNull();
    expect(getAppSnapCaptureMotionPhase("cap-fly")).toBe("settling");

    vi.advanceTimersByTime(APP_SNAP_SETTLE_DURATION_MS + 60);
    expect(getAppSnapCaptureMotionPhase("cap-fly")).toBe("idle");

    // Reduced motion suppresses flight launch and phase transitions immediately.
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    markAppSnapCaptureArrived("cap-reduced");
    expect(
      launchAppSnapFlight({
        captureId: "cap-reduced",
        previewUrl: "blob:cap-reduced",
        appName: "Chrome",
        windowTitle: null,
        appIconDataUrl: null,
        sourceWindowBounds: null,
        withReturnVeil: true,
      }),
    ).toBe(false);
    expect(getAppSnapCaptureMotionPhase("cap-reduced")).toBe("idle");
  });

  it("applies and cleans up the window-return animation class unless reduced motion is set", () => {
    vi.useFakeTimers();
    const classes = new Set<string>();
    const listeners = new Map<string, () => void>();
    const fakeRoot = {
      offsetWidth: 100,
      classList: {
        add: (name: string) => classes.add(name),
        remove: (name: string) => classes.delete(name),
      },
      addEventListener: (event: string, listener: () => void) => {
        listeners.set(event, listener);
      },
      removeEventListener: (event: string) => {
        listeners.delete(event);
      },
    };
    vi.stubGlobal("document", { getElementById: () => fakeRoot, visibilityState: "visible" });
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });

    expect(triggerAppSnapWindowReturnAnimation()).toBe(true);
    expect(classes.has("appsnap-window-return")).toBe(true);
    listeners.get("animationend")?.();
    expect(classes.has("appsnap-window-return")).toBe(false);

    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    expect(triggerAppSnapWindowReturnAnimation()).toBe(false);
    expect(classes.has("appsnap-window-return")).toBe(false);
  });

  it("defers scheduled window-return animation while document is hidden until visible", async () => {
    const classes = new Set<string>();
    const docListeners = new Map<string, () => void>();
    const fakeRoot = {
      offsetWidth: 100,
      classList: {
        add: (name: string) => classes.add(name),
        remove: (name: string) => classes.delete(name),
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const fakeDocument = {
      visibilityState: "hidden" as DocumentVisibilityState,
      getElementById: () => fakeRoot,
      addEventListener: (event: string, listener: () => void) => {
        docListeners.set(event, listener);
      },
      removeEventListener: (event: string) => {
        docListeners.delete(event);
      },
    };
    vi.stubGlobal("document", fakeDocument);
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(16);
      return 1;
    });

    scheduleAppSnapWindowReturnAnimation();
    expect(classes.has("appsnap-window-return")).toBe(false);

    fakeDocument.visibilityState = "visible";
    docListeners.get("visibilitychange")?.();
    await vi.waitFor(() => {
      expect(classes.has("appsnap-window-return")).toBe(true);
    });
  });
});
