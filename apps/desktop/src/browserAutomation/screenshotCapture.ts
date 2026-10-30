import type {
  BrowserScreenshotHostOutput,
  BrowserScreenshotInput,
  BrowserTabId,
} from "@synara/contracts";

import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import { drainOnAbort, evaluateInContext, sendCdpCommand, throwIfAborted } from "./cdpRuntime";
import { browserHostError } from "./hostErrors";

const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const MAX_SCREENSHOT_WIDTH = 3_840;
const MAX_FULL_PAGE_HEIGHT = 16_384;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

let screenshotTail: Promise<void> = Promise.resolve();

const withScreenshotLock = async <T>(operation: () => Promise<T>): Promise<T> => {
  const previous = screenshotTail;
  let release!: () => void;
  screenshotTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
};

function screenshotTooLarge(runtime: BrowserAutomationVisibleRuntime): never {
  return browserHostError({
    code: "BrowserScreenshotTooLarge",
    tabId: runtime.tabId as BrowserTabId,
  });
}

const pngDimensions = (
  runtime: BrowserAutomationVisibleRuntime,
  data: Buffer,
): { readonly width: number; readonly height: number } => {
  if (
    data.byteLength < 24 ||
    !data.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE) ||
    data.subarray(12, 16).toString("ascii") !== "IHDR"
  ) {
    screenshotTooLarge(runtime);
  }
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (width < 1 || height < 1) {
    screenshotTooLarge(runtime);
  }
  return { width, height };
};

const boundedUrl = (value: string): string => {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= 8_192) return value;
  let end = 8_192;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
};

// Electron's webContents.capturePage needs a live compositor surface; a parked
// (setVisible(false)) automation view has none and the call never settles. CDP
// captureScreenshot with fromSurface:false rasterizes straight from the
// renderer, which works for visible, hidden, and occluded guests alike.
const captureViewport = async (
  runtime: BrowserAutomationVisibleRuntime,
  signal?: AbortSignal,
): Promise<{ readonly png: Buffer; readonly width: number; readonly height: number }> => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    throwIfAborted(signal);
    // stayHidden/stayAwake let a parked native view produce a frame without
    // flashing it on screen; a plain capturePage never settles on Electron 43
    // once the view lost its compositor surface.
    let image = await drainOnAbort(
      runtime.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }),
      signal,
    );
    const initialSize = image.getSize();
    if (initialSize.width > MAX_SCREENSHOT_WIDTH || initialSize.height > MAX_FULL_PAGE_HEIGHT) {
      const scale = Math.min(
        MAX_SCREENSHOT_WIDTH / initialSize.width,
        MAX_FULL_PAGE_HEIGHT / initialSize.height,
      );
      image = image.resize({
        width: Math.max(1, Math.floor(initialSize.width * scale)),
        height: Math.max(1, Math.floor(initialSize.height * scale)),
        quality: "best",
      });
    }
    const png = image.toPNG();
    if (png.byteLength >= 24) {
      const dimensions = pngDimensions(runtime, png);
      if (
        png.byteLength > MAX_SCREENSHOT_BYTES ||
        dimensions.width > MAX_SCREENSHOT_WIDTH ||
        dimensions.height > MAX_FULL_PAGE_HEIGHT
      )
        screenshotTooLarge(runtime);
      return { png, ...dimensions };
    }
  }
  screenshotTooLarge(runtime);
};

const captureFullPage = async (
  runtime: BrowserAutomationVisibleRuntime,
  signal?: AbortSignal,
): Promise<{
  readonly png: Buffer;
  readonly width: number;
  readonly height: number;
  readonly clipped: boolean;
}> => {
  const metrics = await sendCdpCommand<{
    readonly cssContentSize: { readonly width: number; readonly height: number };
    readonly cssLayoutViewport?: { readonly clientWidth?: number; readonly clientHeight?: number };
    readonly layoutViewport?: { readonly clientWidth?: number; readonly clientHeight?: number };
  }>(runtime, "Page.getLayoutMetrics", {}, signal);
  // Full-page means full content height at the layout viewport's width;
  // cssContentSize.width excludes a classic scrollbar's column.
  const layoutWidth = metrics.cssLayoutViewport?.clientWidth ?? metrics.layoutViewport?.clientWidth;
  const rawWidth = Math.max(1, Math.ceil(layoutWidth ?? metrics.cssContentSize.width));
  const rawHeight = Math.max(1, Math.ceil(metrics.cssContentSize.height));
  const width = Math.min(MAX_SCREENSHOT_WIDTH, rawWidth);
  const height = Math.min(MAX_FULL_PAGE_HEIGHT, rawHeight);
  const clipped = width < rawWidth || height < rawHeight;
  const view = runtime.view;
  if (view && !view.getVisible()) {
    // A parked native view has no compositor surface and CDP rasterization of a
    // tall emulated viewport never settles on Electron 43. Relayout the guest
    // at full content height for the capture instead; the view stays hidden.
    const parkedBounds = view.getBounds();
    const wasVisible = view.getVisible();
    try {
      // Hidden views never resize their renderer; make the view briefly
      // visible (it stays parked behind the shell content at z-index 0).
      if (!wasVisible) view.setVisible(true);
      // Keep the guest's viewport width (innerWidth includes a classic
      // scrollbar column, cssContentSize excludes it); only the height grows.
      view.setBounds({ x: 0, y: 0, width: Math.max(parkedBounds.width, width), height });
      // The view resize reaches the guest asynchronously; capture only after
      // the renderer reports the tall layout viewport. (Read innerHeight
      // directly: observePage clamps viewport dimensions for its callers.)
      const deadline = Date.now() + 2_000;
      for (;;) {
        const observed = await evaluateInContext<{ readonly h?: unknown; readonly w?: unknown }>(
          runtime,
          "({ w: window.innerWidth, h: window.innerHeight })",
          { signal },
        );
        const currentHeight = typeof observed.value?.h === "number" ? observed.value.h : 0;
        const currentWidth = typeof observed.value?.w === "number" ? observed.value.w : 0;
        if (currentHeight >= height && currentWidth >= width) break;
        throwIfAborted(signal);
        if (Date.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const image = await drainOnAbort(
        runtime.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }),
        signal,
      );
      const png = image.toPNG();
      if (png.byteLength < 24) screenshotTooLarge(runtime);
      const dimensions = pngDimensions(runtime, png);
      if (
        png.byteLength > MAX_SCREENSHOT_BYTES ||
        dimensions.width > MAX_SCREENSHOT_WIDTH ||
        dimensions.height > MAX_FULL_PAGE_HEIGHT
      )
        screenshotTooLarge(runtime);
      return { png, ...dimensions, clipped };
    } finally {
      if (!runtime.webContents.isDestroyed()) {
        view.setBounds(parkedBounds);
        if (!wasVisible) view.setVisible(false);
      }
    }
  }
  const scales = [1, 0.75, 0.5, 0.25] as const;
  for (const scale of scales) {
    throwIfAborted(signal);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await sendCdpCommand<{ readonly data?: string }>(
        runtime,
        "Page.captureScreenshot",
        {
          format: "png",
          fromSurface: true,
          captureBeyondViewport: true,
          optimizeForSpeed: true,
          clip: { x: 0, y: 0, width, height, scale },
        },
        signal,
      );
      const data =
        typeof response.data === "string" ? Buffer.from(response.data, "base64") : Buffer.alloc(0);
      if (data.byteLength < 24) continue;
      const dimensions = pngDimensions(runtime, data);
      if (dimensions.width > MAX_SCREENSHOT_WIDTH || dimensions.height > MAX_FULL_PAGE_HEIGHT)
        break;
      if (data.byteLength <= MAX_SCREENSHOT_BYTES) {
        return { png: data, ...dimensions, clipped };
      }
      break;
    }
  }
  screenshotTooLarge(runtime);
};

/** Capture pixels from the same visible guest, serialized across Chromium. */
export const captureBrowserScreenshot = async (
  runtime: BrowserAutomationVisibleRuntime,
  input: Pick<BrowserScreenshotInput, "fullPage">,
  signal?: AbortSignal,
): Promise<BrowserScreenshotHostOutput> =>
  withScreenshotLock(async () => {
    throwIfAborted(signal);
    // A throttled (parked/backgrounded) renderer may never service the forced
    // BeginFrame a capture needs. Wake it for the duration of the capture.
    const throttled = runtime.webContents.getBackgroundThrottling();
    if (throttled && !runtime.webContents.isDestroyed()) {
      runtime.webContents.setBackgroundThrottling(false);
    }
    let captured: Awaited<ReturnType<typeof captureFullPage>> & { clipped: boolean };
    try {
      captured = input.fullPage
        ? await captureFullPage(runtime, signal)
        : { ...(await captureViewport(runtime, signal)), clipped: false };
    } finally {
      if (throttled && !runtime.webContents.isDestroyed()) {
        runtime.webContents.setBackgroundThrottling(true);
      }
    }
    throwIfAborted(signal);
    const metadata = {
      mimeType: "image/png" as const,
      width: captured.width,
      height: captured.height,
      byteLength: captured.png.byteLength,
    };
    return {
      structuredContent: {
        tabId: runtime.tabId as BrowserTabId,
        url: boundedUrl(runtime.webContents.getURL()),
        capturedAt:
          new Date().toISOString() as unknown as BrowserScreenshotHostOutput["structuredContent"]["capturedAt"],
        mode: input.fullPage ? "fullPage" : "viewport",
        clipped: captured.clipped,
        image: metadata,
      },
      image: { ...metadata, data: captured.png.toString("base64") },
    };
  });
