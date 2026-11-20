import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isRecentlyArrivedAppSnapCapture,
  markAppSnapCaptureArrived,
  resetAppSnapArrivalStateForTests,
  triggerAppSnapWindowReturnAnimation,
} from "./appSnapArrival";

afterEach(() => {
  resetAppSnapArrivalStateForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("appSnapArrival", () => {
  it("tracks freshly arrived capture ids within their short entrance window", () => {
    markAppSnapCaptureArrived("cap-1", 1_000);
    expect(isRecentlyArrivedAppSnapCapture("cap-1", 1_200)).toBe(true);
    expect(isRecentlyArrivedAppSnapCapture("cap-other", 1_200)).toBe(false);
    expect(isRecentlyArrivedAppSnapCapture("cap-1", 3_000)).toBe(false);
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
    vi.stubGlobal("document", { getElementById: () => fakeRoot });
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });

    expect(triggerAppSnapWindowReturnAnimation()).toBe(true);
    expect(classes.has("appsnap-window-return")).toBe(true);
    listeners.get("animationend")?.();
    expect(classes.has("appsnap-window-return")).toBe(false);

    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    expect(triggerAppSnapWindowReturnAnimation()).toBe(false);
    expect(classes.has("appsnap-window-return")).toBe(false);
  });
});
