import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LEGACY_HOOLA_CANVAS_OPEN_EVENT,
  closeMossCanvas,
  openMossCanvas,
  openMossLibraryDestination,
  registerMossCanvasHost,
} from "./mossCanvasBridge";

let disposeEmbeddedHost: (() => void) | null = null;

afterEach(() => {
  disposeEmbeddedHost?.();
  disposeEmbeddedHost = null;
  vi.unstubAllGlobals();
});

describe("openMossCanvas", () => {
  it("dispatches one compatibility event when no Canvas host is installed", () => {
    const events: Event[] = [];
    vi.stubGlobal("window", {
      dispatchEvent: (event: Event) => {
        events.push(event);
        return true;
      },
    });

    openMossCanvas();

    expect(events.map((event) => event.type)).toEqual([LEGACY_HOOLA_CANVAS_OPEN_EVENT]);
    expect((events[0] as CustomEvent).detail).toEqual({
      source: "moss-synara",
      surface: "images",
    });
  });

  it("prefers mossCanvasBridge.open over the compatibility execute APIs", () => {
    const open = vi.fn();
    const execute = vi.fn();
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", {
      mossCanvasBridge: { open },
      mossCanvas: { execute },
      dispatchEvent,
    });

    openMossCanvas({ surface: "images" });

    expect(open).toHaveBeenCalledWith({ source: "moss-synara", surface: "images" });
    expect(execute).not.toHaveBeenCalled();
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it("opens the embedded Moss Canvas host before optional preload APIs", () => {
    const embeddedOpen = vi.fn();
    const preloadOpen = vi.fn();
    disposeEmbeddedHost = registerMossCanvasHost(embeddedOpen);
    vi.stubGlobal("window", {
      mossCanvasBridge: { open: preloadOpen },
      dispatchEvent: vi.fn(),
    });

    openMossCanvas({ surface: "images" });

    expect(embeddedOpen).toHaveBeenCalledWith({ source: "moss-synara", surface: "images" });
    expect(preloadOpen).not.toHaveBeenCalled();
  });

  it("lets an embedded host decline other surfaces", () => {
    const preloadOpen = vi.fn();
    disposeEmbeddedHost = registerMossCanvasHost(() => false);
    vi.stubGlobal("window", {
      mossCanvasBridge: { open: preloadOpen },
      dispatchEvent: vi.fn(),
    });

    openMossCanvas({ surface: "library" });

    expect(preloadOpen).toHaveBeenCalledWith({ source: "moss-synara", surface: "library" });
  });

  it("falls back to mossCanvas.execute when the bridge opener is absent", () => {
    const execute = vi.fn();
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", {
      mossCanvas: { execute },
      dispatchEvent,
    });

    openMossCanvas({ surface: "images" });

    expect(execute).toHaveBeenCalledWith({
      action: "canvas.ui.open_main_menu",
      args: { source: "moss-synara", surface: "images" },
    });
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it("falls back to the compatibility event when a host promise rejects", async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", {
      mossCanvasBridge: { open: vi.fn().mockRejectedValue(new Error("stale bridge")) },
      dispatchEvent,
    });

    openMossCanvas({ surface: "images" });
    await Promise.resolve();

    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect(dispatchEvent.mock.calls[0]?.[0].type).toBe(LEGACY_HOOLA_CANVAS_OPEN_EVENT);
  });

  it("is safe when called without a renderer window", () => {
    expect(() => openMossCanvas()).not.toThrow();
  });

  it("marks destination switches so the shell can avoid a duplicate route write", () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });

    closeMossCanvas("destination-switch");

    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "moss-canvas-bridge:close",
        detail: { reason: "destination-switch" },
      }),
    );
  });
});

describe("openMossLibraryDestination", () => {
  it("opens the library surface via the shared destination bridge (not Images/Canvas)", () => {
    const open = vi.fn();
    disposeEmbeddedHost = registerMossCanvasHost((detail) => {
      open(detail);
      return true;
    });
    openMossLibraryDestination();
    expect(open).toHaveBeenCalledWith({ source: "moss-synara", surface: "library" });
  });
});
