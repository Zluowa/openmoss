// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MOSS_CANVAS_PREWARMED_MESSAGE,
  mossCanvasPrewarmUrl,
  resetMossCanvasPrewarmForTests,
  scheduleMossCanvasPrewarm,
} from "./mossCanvasPrewarm";

const PAGE_WITH_PREWARM =
  '<html><head><meta name="moss-canvas-prewarm" content="1" /></head></html>';

function hiddenFrames(): HTMLIFrameElement[] {
  return [...document.querySelectorAll<HTMLIFrameElement>('iframe[src*="moss_prewarm"]')];
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

/** Answer the current hidden frame as the Canvas page does once its code has loaded. */
function answer(frame: HTMLIFrameElement, ok = true): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { type: MOSS_CANVAS_PREWARMED_MESSAGE, version: 1, ok },
      origin: new URL(frame.src).origin,
      source: frame.contentWindow,
    }),
  );
}

describe("Moss Canvas prewarm", () => {
  beforeEach(() => {
    resetMossCanvasPrewarmForTests();
    vi.useFakeTimers();
    // No idle callback in the test DOM: prewarm falls back to a short timer.
    vi.stubGlobal("requestIdleCallback", undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("asks for the Canvas page without any credential", () => {
    const url = mossCanvasPrewarmUrl();
    expect(url.pathname).toBe("/canvas/");
    expect([...url.searchParams.keys()]).toEqual(["moss_prewarm"]);
  });

  it("loads the page hidden twice, then removes it, once per session", async () => {
    const fetchImpl = vi.fn(async () => new Response(PAGE_WITH_PREWARM, { status: 200 }));
    scheduleMossCanvasPrewarm(fetchImpl);
    scheduleMossCanvasPrewarm(fetchImpl);
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    for (let round = 0; round < 2; round += 1) {
      const [frame] = hiddenFrames();
      expect(frame).toBeDefined();
      expect(frame!.getAttribute("aria-hidden")).toBe("true");
      expect(frame!.tabIndex).toBe(-1);
      expect(frame!.style.left).toBe("-10000px");
      expect(frame!.style.visibility).toBe("hidden");
      answer(frame!);
      await flush();
    }
    expect(hiddenFrames()).toHaveLength(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    scheduleMossCanvasPrewarm(fetchImpl);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("never loads a Canvas build that does not advertise prewarming", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html></html>", { status: 200 }));
    scheduleMossCanvasPrewarm(fetchImpl);
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(hiddenFrames()).toHaveLength(0);
  });

  it("stops when a real Canvas is already open", async () => {
    const open = document.createElement("iframe");
    open.src = "http://127.0.0.1:3773/canvas/?moss_host=1&moss_thread=t";
    document.body.append(open);
    const fetchImpl = vi.fn(async () => new Response(PAGE_WITH_PREWARM, { status: 200 }));
    scheduleMossCanvasPrewarm(fetchImpl);
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(hiddenFrames()).toHaveLength(0);
  });

  it("gives up on a frame that never answers", async () => {
    const fetchImpl = vi.fn(async () => new Response(PAGE_WITH_PREWARM, { status: 200 }));
    scheduleMossCanvasPrewarm(fetchImpl);
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(hiddenFrames()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(hiddenFrames()).toHaveLength(0);
  });
});
