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
  /** Where the desktop window is, measured by the desktop app. */
  readonly placement?: () => Promise<{
    readonly left: number;
    readonly top: number;
    readonly offscreen: boolean;
  }>;
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
/** A size that held this long after a resize is where the window landed. */
const SIZE_STILL_MS = 200;
const FONTS_WAIT_MS = 1500;
/** Transitions still running get this long to finish; endless ones are never waited for. */
const ANIMATIONS_WAIT_MS = 1000;

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Animations and transitions that are running and will end (not a spinner's endless loop). */
export function runningFiniteAnimations(): Animation[] {
  if (typeof document === "undefined" || typeof document.getAnimations !== "function") return [];
  return document.getAnimations().filter((animation) => {
    if (animation.playState !== "running") return false;
    const end = animation.effect?.getComputedTiming().endTime;
    return typeof end === "number" && Number.isFinite(end);
  });
}

/**
 * Before measuring: the page's fonts loaded (at most 1.5 s, never the network beyond what the
 * page already asked for), the transitions and animations already running finished (at most
 * 1 s; endless ones are not waited for), then two animation frames, so a box caught mid-way
 * (a column opening, a panel sliding) is not measured.
 */
export async function settleLayout(): Promise<void> {
  const fonts = typeof document !== "undefined" ? document.fonts?.ready : undefined;
  if (fonts) await Promise.race([fonts, delay(FONTS_WAIT_MS)]);
  await frame();
  const moving = runningFiniteAnimations();
  if (moving.length > 0) {
    await Promise.race([
      Promise.allSettled(moving.map((animation) => animation.finished)),
      delay(ANIMATIONS_WAIT_MS),
    ]);
  }
  await frame();
  await frame();
}

function currentViewport(): SelfReportSize {
  return { width: window.innerWidth, height: window.innerHeight };
}

function missesSize(viewport: SelfReportSize, size: SelfReportSize): boolean {
  return Math.abs(viewport.width - size.width) > 1 || Math.abs(viewport.height - size.height) > 1;
}

/**
 * Until the page has the size, or it changed from `from` and then held still for 200 ms (the
 * window landed on another size), or 2 s passed; then two frames and a short pause for layout.
 * Returns the size the page ended up with.
 */
export async function waitForViewport(
  size: SelfReportSize,
  from: SelfReportSize = currentViewport(),
): Promise<SelfReportSize> {
  const until = Date.now() + SIZE_WAIT_MS;
  let last = currentViewport();
  let stillSince = Date.now();
  while (missesSize(last, size) && Date.now() < until) {
    await delay(25);
    const now = currentViewport();
    if (now.width !== last.width || now.height !== last.height) {
      last = now;
      stillSince = Date.now();
    } else if (missesSize(now, from) && Date.now() - stillSince >= SIZE_STILL_MS) {
      break;
    }
  }
  await frame();
  await frame();
  await delay(120);
  return currentViewport();
}

/**
 * Resizes to `size` and checks the page's own size. A window that landed a few pixels off (seen
 * off-screen on Windows: +15x+8, the frame counted into the content) gets one corrected request.
 */
async function resizeTo(bridge: SelfReportCaptureBridge, size: SelfReportSize): Promise<void> {
  const from = currentViewport();
  await bridge.resize(size);
  const landed = await waitForViewport(size, from);
  if (!missesSize(landed, size)) return;
  const corrected = {
    width: size.width + (size.width - landed.width),
    height: size.height + (size.height - landed.height),
  };
  if (!validSize(corrected)) return;
  await bridge.resize(corrected);
  await waitForViewport(size, landed);
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
          await resizeTo(bridge, size);
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
