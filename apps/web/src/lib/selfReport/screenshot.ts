// FILE: screenshot.ts
// Purpose: `screenshot`: the window or one element as PNG files, at the current size or at a
//          list of sizes. The desktop app resizes the window, captures and writes the files; this
//          side waits for the layout at each size and measures the element there.
// Layer: Web dev/test tooling (self-report)

import { type SelfReportRect } from "./dom";

export interface SelfReportSize {
  readonly width: number;
  readonly height: number;
}

/** The desktop side (`window.desktopBridge.selfReport`). Sizes are CSS pixels of the page. */
export interface SelfReportCaptureBridge {
  readonly resize: (size: SelfReportSize) => Promise<void>;
  readonly capture: (input: {
    readonly rect?: SelfReportRect;
    readonly dir?: string;
    readonly name: string;
  }) => Promise<{ readonly path: string; readonly width: number; readonly height: number }>;
  readonly restore: () => Promise<void>;
}

/** The owner's window, the acceptance window and a phone (2026-11-18 work order). */
export const STANDARD_SCREENSHOT_SIZES: readonly SelfReportSize[] = [
  { width: 1101, height: 782 },
  { width: 1375, height: 886 },
  { width: 390, height: 844 },
];

export interface ScreenshotInput {
  /** One element instead of the whole window. */
  readonly selector?: string;
  /** Sizes to capture at, or "standard"; the current size when left out. */
  readonly sizes?: readonly SelfReportSize[] | "standard";
  /** Where the files go (absolute). The desktop app picks a folder in its profile otherwise. */
  readonly dir?: string;
}

export interface ScreenshotFile {
  readonly path: string;
  /** The image, in device pixels. */
  readonly width: number;
  readonly height: number;
  /** The page's size when it was taken, in CSS pixels. */
  readonly viewport: SelfReportSize;
}

export interface ScreenshotResult {
  readonly files: ScreenshotFile[];
  readonly error?: string;
}

/** Kept short so a call with three sizes answers within 10 s (the acceptance kit allows 15). */
const SIZE_WAIT_MS = 2000;
const FONTS_WAIT_MS = 1500;

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Before measuring: the page's fonts loaded (at most 1.5 s, never the network beyond what the
 * page already asked for) and two animation frames, so a box mid-transition is not measured.
 */
export async function settleLayout(): Promise<void> {
  const fonts = typeof document !== "undefined" ? document.fonts?.ready : undefined;
  if (fonts) await Promise.race([fonts, delay(FONTS_WAIT_MS)]);
  await frame();
  await frame();
}

/** Until the page has the size (or 3 s passed), then two frames and a short pause for layout. */
export async function waitForViewport(size: SelfReportSize): Promise<void> {
  const until = Date.now() + SIZE_WAIT_MS;
  while (
    (Math.abs(window.innerWidth - size.width) > 1 ||
      Math.abs(window.innerHeight - size.height) > 1) &&
    Date.now() < until
  ) {
    await delay(25);
  }
  await frame();
  await frame();
  await delay(120);
}

function validSize(size: SelfReportSize): boolean {
  return (
    Number.isFinite(size.width) &&
    Number.isFinite(size.height) &&
    size.width >= 200 &&
    size.height >= 200 &&
    size.width <= 7680 &&
    size.height <= 4320
  );
}

export async function takeScreenshots(
  bridge: SelfReportCaptureBridge | undefined,
  input: ScreenshotInput = {},
): Promise<ScreenshotResult> {
  if (!bridge) {
    return { files: [], error: "Screenshots need the Moss desktop app." };
  }
  const sizes = input.sizes === "standard" ? STANDARD_SCREENSHOT_SIZES : input.sizes;
  if (sizes && !sizes.every(validSize)) {
    return { files: [], error: "Each size needs a width and height between 200 and 7680x4320." };
  }
  const files: ScreenshotFile[] = [];
  const shoot = async () => {
    await settleLayout();
    let rect: SelfReportRect | undefined;
    if (input.selector) {
      const element = document.querySelector(input.selector);
      if (!element) throw new Error(`No element matches ${input.selector}.`);
      const box = element.getBoundingClientRect();
      rect = { x: box.left, y: box.top, width: box.width, height: box.height };
    }
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const file = await bridge.capture({
      ...(rect ? { rect } : {}),
      ...(input.dir ? { dir: input.dir } : {}),
      name: `${input.selector ? "element" : "window"}-${viewport.width}x${viewport.height}`,
    });
    files.push({ ...file, viewport });
  };
  try {
    if (!sizes || sizes.length === 0) {
      await shoot();
    } else {
      try {
        for (const size of sizes) {
          await bridge.resize(size);
          await waitForViewport(size);
          await shoot();
        }
      } finally {
        await bridge.restore();
      }
    }
    return { files };
  } catch (error) {
    return { files, error: error instanceof Error ? error.message : String(error) };
  }
}
