// FILE: themeHookPaint.ts
// Purpose: Shared measurements for the rendered theme-hook checks: whether a rule on a hook shows
//          on screen, judged from a screenshot of the test page rather than from computed style
//          alone (a `display: contents` element reports the computed background it never paints).
// Layer: Browser test helper

import { page } from "vitest/browser";

import { applyThemeCss } from "../theme/themeCss";

/** A colour no Moss surface uses, so finding it on screen means the theme rule painted. */
export const PROBE_RGB = [255, 0, 170] as const;
export const PROBE_CSS_COLOR = `rgb(${PROBE_RGB.join(", ")})`;

export interface ViewportPixels {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  /** Screenshot pixels per CSS pixel. */
  readonly scale: number;
}

/** Screenshot the test page and decode it, so a test can read what a person would see. */
export async function captureViewportPixels(): Promise<ViewportPixels> {
  // With `save: false` the result is the base64 string itself, not `{ path, base64 }`.
  const shot: unknown = await page.screenshot({ base64: true, save: false });
  const base64 = typeof shot === "string" ? shot : (shot as { readonly base64: string }).base64;
  const encoded = base64.replace(/^data:[^,]*,/, "").replace(/[^A-Za-z0-9+/=]/g, "");
  const blob = await (await fetch(`data:image/png;base64,${encoded}`)).blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("No 2D context for the screenshot.");
  context.drawImage(bitmap, 0, 0);
  const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
  return {
    data: image.data,
    width: bitmap.width,
    height: bitmap.height,
    scale: bitmap.width / window.innerWidth,
  };
}

export interface CssRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Share of the pixels inside `rect` (CSS pixels) that are within `tolerance` of `rgb`. */
export function colorShare(
  pixels: ViewportPixels,
  rect: CssRect,
  rgb: readonly [number, number, number] = PROBE_RGB,
  tolerance = 12,
): number {
  const x0 = Math.max(0, Math.floor(rect.left * pixels.scale));
  const y0 = Math.max(0, Math.floor(rect.top * pixels.scale));
  const x1 = Math.min(pixels.width, Math.ceil((rect.left + rect.width) * pixels.scale));
  const y1 = Math.min(pixels.height, Math.ceil((rect.top + rect.height) * pixels.scale));
  let total = 0;
  let matching = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const offset = (y * pixels.width + x) * 4;
      total += 1;
      if (
        Math.abs(pixels.data[offset]! - rgb[0]) <= tolerance &&
        Math.abs(pixels.data[offset + 1]! - rgb[1]) <= tolerance &&
        Math.abs(pixels.data[offset + 2]! - rgb[2]) <= tolerance
      ) {
        matching += 1;
      }
    }
  }
  return total === 0 ? 0 : matching / total;
}

/** Whether `element` has a box with size and is not hidden by opacity or visibility. */
function isShown(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    getComputedStyle(element).display !== "contents" &&
    element.checkVisibility({ opacityProperty: true, visibilityProperty: true })
  );
}

/** The first element matching `selector` that has a box with size and is shown, or null. */
export function firstBoxedElement(selector: string): HTMLElement | null {
  for (const element of document.querySelectorAll<HTMLElement>(selector)) {
    if (isShown(element)) return element;
  }
  return null;
}

const inViewport = (element: Element) => {
  const rect = visibleRect(element);
  return rect.width > 0 && rect.height > 0;
};

/** The part of `element`'s box inside the viewport, in CSS pixels. */
export function visibleRect(element: Element): CssRect {
  const rect = element.getBoundingClientRect();
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(window.innerWidth, rect.right);
  const bottom = Math.min(window.innerHeight, rect.bottom);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/**
 * How a hook is probed. Most hooks promise a surface, so a background must show. A hook that
 * promises only layout, whose own background its children cover by design, is probed with an
 * outline, which paints outside its box.
 */
export type ThemeHookProbe = "background" | "outline" | "mask";

/** A second known colour, for hooks measured against their own painted shape. */
const REFERENCE_RGB = [0, 200, 255] as const;

/** A rule that paints the probe colour on `selector` and nothing else. */
export function probeRule(
  selector: string,
  probe: ThemeHookProbe = "background",
  color: string = PROBE_CSS_COLOR,
): string {
  return probe === "outline"
    ? `${selector} { outline: 6px solid ${color} !important; outline-offset: 0 !important; }`
    : `${selector} { background: ${color} !important; }`;
}

export interface ThemeHookMeasure {
  /** An element the hook matches has a box with size and is shown. */
  readonly boxed: boolean;
  /** The largest share of one shown element's box that shows the probe colour. */
  readonly share: number;
}

/**
 * Apply a probe rule on `selector` through `applyThemeCss` (the path every theme takes), then
 * read from a screenshot how much of the hooked elements shows it. Elements scrolled out of view
 * are brought in first. `onNotShown` runs while the rule is still applied, for a screenshot.
 */
export async function measureThemeHook(
  selector: string,
  options: {
    readonly probe?: ThemeHookProbe;
    readonly minShare: number;
    readonly onNotShown?: () => Promise<void>;
  },
): Promise<ThemeHookMeasure> {
  const shown = () =>
    [...document.querySelectorAll<HTMLElement>(selector)].filter(isShown).slice(0, 40);
  const candidates = shown();
  if (candidates.length === 0) return { boxed: false, share: 0 };
  if (!candidates.some(inViewport)) candidates[0]!.scrollIntoView({ block: "center" });
  if (options.probe === "mask") return measureMaskHook(selector, shown, options);
  applyThemeCss(probeRule(selector, options.probe));
  try {
    await settleThemeChange();
    const pixels = await captureViewportPixels();
    let share = 0;
    for (const element of shown().filter(inViewport)) {
      const rect = element.getBoundingClientRect();
      // An outline paints just outside the box.
      const area =
        options.probe === "outline"
          ? { left: rect.left - 6, top: rect.top - 6, width: rect.width + 12, height: 6 }
          : visibleRect(element);
      share = Math.max(share, colorShare(pixels, area));
    }
    if (share <= options.minShare) await options.onNotShown?.();
    return { boxed: true, share };
  } finally {
    applyThemeCss("");
  }
}

/** A small PNG, as a data: address, that is the probe colour edge to edge. */
export function probeImageDataUrl(width: number, height: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  context.fillStyle = PROBE_CSS_COLOR;
  context.fillRect(0, 0, width, height);
  return canvas.toDataURL("image/png");
}

export const waitForPaint = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

/**
 * Wait until a theme change has painted. Moss's controls animate colour changes (about 150 ms),
 * so a rule shows only after its transition; a rule that never shows stays absent.
 */
export async function settleThemeChange(): Promise<void> {
  await waitForPaint();
  await new Promise((resolve) => setTimeout(resolve, 450));
  await waitForPaint();
}

/**
 * A mask hook (an icon: a shape filled with its background colour) covers only its glyph, a few
 * percent of its box that varies with the platform's antialiasing. It is measured against
 * itself: the same icons are painted once in a reference colour and once in the probe colour,
 * both through `applyThemeCss`, and `share` is probe pixels over reference pixels (about 1
 * when the rule shows; 0 when nothing paints, as no reference pixels then means no shape).
 */
async function measureMaskHook(
  selector: string,
  shown: () => HTMLElement[],
  options: { readonly minShare: number; readonly onNotShown?: () => Promise<void> },
): Promise<ThemeHookMeasure> {
  const countIn = async (color: string, rgb: readonly [number, number, number]) => {
    applyThemeCss(probeRule(selector, "background", color));
    await settleThemeChange();
    const pixels = await captureViewportPixels();
    let count = 0;
    for (const element of shown().filter(inViewport)) {
      const rect = visibleRect(element);
      count += colorShare(pixels, rect, rgb) * rect.width * rect.height;
    }
    return count;
  };
  try {
    const reference = await countIn(`rgb(${REFERENCE_RGB.join(", ")})`, REFERENCE_RGB);
    const probe = await countIn(PROBE_CSS_COLOR, PROBE_RGB);
    const share = reference > 0 ? probe / reference : 0;
    if (share <= options.minShare) await options.onNotShown?.();
    return { boxed: true, share };
  } finally {
    applyThemeCss("");
  }
}
