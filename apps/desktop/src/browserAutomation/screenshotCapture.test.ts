import { ThreadId } from "@moss/contracts";
import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";

import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import { captureBrowserScreenshot } from "./screenshotCapture";

const THREAD_ID = ThreadId.makeUnsafe("thread-screenshot");
const TAB_ID = "b5f2ebcf-6b4b-409f-b6bd-408a5fb19d3b";

const png = (width: number, height: number, extraBytes = 0): Buffer => {
  const value = Buffer.alloc(24 + extraBytes);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(value, 0);
  value.write("IHDR", 12, "ascii");
  value.writeUInt32BE(width, 16);
  value.writeUInt32BE(height, 20);
  return value;
};

const createRuntime = (
  options: {
    readonly viewportPng?: Buffer;
    readonly fullPagePng?: Buffer;
    readonly contentWidth?: number;
    readonly contentHeight?: number;
    readonly viewVisible?: boolean;
    readonly compositedFails?: boolean;
  } = {},
) => {
  const viewportPng = options.viewportPng ?? png(1_024, 768);
  const fullPagePng = options.fullPagePng ?? png(1_500, 4_000);
  const capturePage = vi.fn(async () => ({
    toPNG: () => viewportPng,
    getSize: () => ({ width: 1_024, height: 768 }),
    resize: vi.fn(),
  }));
  const sendCommand = vi.fn(async (method: string, params?: { clip?: unknown }) => {
    if (method === "Page.captureScreenshot" && !params?.clip) {
      if (options.compositedFails) throw new Error("No frame");
      return { data: viewportPng.toString("base64") };
    }
    if (method === "Page.getLayoutMetrics") {
      return {
        cssContentSize: {
          width: options.contentWidth ?? 1_500,
          height: options.contentHeight ?? 4_000,
        },
        contentSize: { width: 3_000, height: 8_000 },
      };
    }
    if (method === "Page.captureScreenshot") {
      return { data: fullPagePng.toString("base64") };
    }
    return {};
  });
  const webContents = {
    isDestroyed: () => false,
    getURL: () => "https://example.test/page",
    getBackgroundThrottling: () => false,
    setBackgroundThrottling: vi.fn(),
    capturePage,
    debugger: { isAttached: () => true, attach: vi.fn(), sendCommand },
  } as unknown as WebContents;
  return {
    runtime: {
      threadId: THREAD_ID,
      tabId: TAB_ID,
      webContents,
      ...(options.viewVisible === undefined
        ? {}
        : {
            view: {
              getBounds: () => ({ x: 0, y: 0, width: 1_024, height: 768 }),
              setBounds: vi.fn(),
              getVisible: () => options.viewVisible!,
              setVisible: vi.fn(),
            },
          }),
    } satisfies BrowserAutomationVisibleRuntime,
    sendCommand,
    capturePage,
  };
};

describe("browser screenshot capture", () => {
  it("returns a bounded viewport PNG sidecar from the exact guest", async () => {
    const { runtime } = createRuntime();

    await expect(captureBrowserScreenshot(runtime, { fullPage: false })).resolves.toMatchObject({
      structuredContent: {
        tabId: TAB_ID,
        url: "https://example.test/page",
        mode: "viewport",
        clipped: false,
        image: { width: 1_024, height: 768, byteLength: 24 },
      },
      image: { mimeType: "image/png", width: 1_024, height: 768 },
    });
  });

  it("captures an on-screen page from its composited frame, not capturePage", async () => {
    // capturePage returns a magnified crop at 150% after a page navigated while hidden.
    const { runtime, sendCommand, capturePage } = createRuntime();

    await captureBrowserScreenshot(runtime, { fullPage: false });

    expect(sendCommand).toHaveBeenCalledWith("Page.captureScreenshot", { format: "png" });
    expect(capturePage).not.toHaveBeenCalled();
  });

  it("keeps capturePage for a parked view, which never composites a CDP frame", async () => {
    const { runtime, sendCommand, capturePage } = createRuntime({ viewVisible: false });

    await expect(captureBrowserScreenshot(runtime, { fullPage: false })).resolves.toMatchObject({
      image: { width: 1_024, height: 768 },
    });
    expect(capturePage).toHaveBeenCalledWith(undefined, { stayHidden: true, stayAwake: true });
    expect(sendCommand).not.toHaveBeenCalledWith("Page.captureScreenshot", expect.anything());
  });

  it("falls back to capturePage when the composited capture fails", async () => {
    const { runtime, capturePage } = createRuntime({ viewVisible: true, compositedFails: true });

    await expect(captureBrowserScreenshot(runtime, { fullPage: false })).resolves.toMatchObject({
      image: { width: 1_024, height: 768 },
    });
    expect(capturePage).toHaveBeenCalled();
  });

  it("caps full-page CSS dimensions and reports clipping", async () => {
    const { runtime, sendCommand } = createRuntime({
      contentWidth: 5_000,
      contentHeight: 20_000,
      fullPagePng: png(3_840, 16_384),
    });

    await expect(captureBrowserScreenshot(runtime, { fullPage: true })).resolves.toMatchObject({
      structuredContent: {
        mode: "fullPage",
        clipped: true,
        image: { width: 3_840, height: 16_384 },
      },
    });
    expect(sendCommand).toHaveBeenCalledWith(
      "Page.captureScreenshot",
      expect.objectContaining({
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: 3_840, height: 16_384, scale: 1 },
      }),
    );
  });

  it("rejects images above the hard byte limit", async () => {
    const { runtime } = createRuntime({ viewportPng: png(1_024, 768, 8 * 1024 * 1024) });

    await expect(captureBrowserScreenshot(runtime, { fullPage: false })).rejects.toMatchObject({
      browserError: { code: "BrowserScreenshotTooLarge" },
    });
  });

  it("uses CSS metrics instead of Retina device pixels for the clip", async () => {
    const { runtime, sendCommand } = createRuntime();
    await captureBrowserScreenshot(runtime, { fullPage: true });
    expect(sendCommand).toHaveBeenCalledWith(
      "Page.captureScreenshot",
      expect.objectContaining({
        clip: { x: 0, y: 0, width: 1_500, height: 4_000, scale: 1 },
      }),
    );
  });

  it("reduces capture scale when Retina output exceeds the pixel limit", async () => {
    const { runtime, sendCommand } = createRuntime({ contentWidth: 3_000, contentHeight: 8_000 });
    const metrics = await sendCommand("Page.getLayoutMetrics");
    sendCommand.mockClear();
    sendCommand
      .mockResolvedValueOnce(metrics)
      .mockResolvedValueOnce({ data: png(6_000, 16_000).toString("base64") })
      .mockResolvedValueOnce({ data: png(4_500, 12_000).toString("base64") })
      .mockResolvedValueOnce({ data: png(3_000, 8_000).toString("base64") });
    await expect(captureBrowserScreenshot(runtime, { fullPage: true })).resolves.toMatchObject({
      image: { width: 3_000, height: 8_000 },
    });
    expect(sendCommand).toHaveBeenCalledTimes(4);
    expect(sendCommand).toHaveBeenLastCalledWith(
      "Page.captureScreenshot",
      expect.objectContaining({
        clip: { x: 0, y: 0, width: 3_000, height: 8_000, scale: 0.5 },
      }),
    );
  });
});
