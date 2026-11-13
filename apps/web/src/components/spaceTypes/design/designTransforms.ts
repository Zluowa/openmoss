// FILE: designTransforms.ts
// Purpose: Two 设计 element commands that change more than one style: scale (K), which grows or
//          shrinks an element with everything inside it (text, spacing, corners, borders), and
//          crop, which trims a picture without moving what stays visible.
// Layer: 资料空间 设计 (web)
// Why: Resizing changes only the box; scaling multiplies every pixel length in the element's
//      own and its children's inline styles. Crop uses `object-view-box`, so the picture data
//      stays whole and a crop can always be undone or reset.

type Rect = { x: number; y: number; w: number; h: number };

/** Where an element sits; scaling keeps it, only the size and contents grow. */
const ANCHOR = new Set(["left", "top", "right", "bottom", "position", "z-index"]);

export interface ScaleSnapshot {
  readonly root: HTMLElement;
  readonly styles: ReadonlyArray<readonly [HTMLElement, string | null]>;
  readonly fontSize: number;
}

/** Remembers the element's and its children's styles before a scale starts. */
export function scaleSnapshot(root: HTMLElement): ScaleSnapshot {
  const nodes = [root, ...root.querySelectorAll<HTMLElement>("*")].slice(0, 2_000);
  const view = root.ownerDocument.defaultView;
  return {
    root,
    styles: nodes.map((node) => [node, node.getAttribute("style")] as const),
    fontSize: Number.parseFloat(view?.getComputedStyle(root).fontSize ?? "") || 16,
  };
}

const round = (value: number) => Math.round(value * 100) / 100;

function scaleValue(value: string, factor: number): string {
  return value.replace(
    /(-?\d*\.?\d+)px/gu,
    (_, number: string) => `${round(Number(number) * factor)}px`,
  );
}

/** Puts the snapshot back, then scales it by `factor` (1 = as it was). */
export function applyScale(snapshot: ScaleSnapshot, factor: number) {
  for (const [node, style] of snapshot.styles) {
    if (style === null) node.removeAttribute("style");
    else node.setAttribute("style", style);
  }
  if (factor === 1) return;
  const { root } = snapshot;
  // Text that inherits its size grows with the element.
  if (!root.style.getPropertyValue("font-size"))
    root.style.setProperty("font-size", `${round(snapshot.fontSize)}px`);
  for (const [node] of snapshot.styles) {
    const style = node.style;
    for (let index = 0; index < style.length; index += 1) {
      const name = style.item(index);
      if (node === root && ANCHOR.has(name)) continue;
      const value = style.getPropertyValue(name);
      if (!value.includes("px")) continue;
      const next = scaleValue(value, factor);
      if (next !== value) style.setProperty(name, next, style.getPropertyPriority(name));
    }
  }
}

// ─── Crop ─────────────────────────────────────────────────────────────────────────────

/** Trimmed fractions of the picture on each side (0–1). */
export interface CropInset {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export const NO_CROP: CropInset = { top: 0, right: 0, bottom: 0, left: 0 };

/** Reads `object-view-box: inset(…)` with one to four values, as browsers may shorten it. */
export function readCrop(image: HTMLElement): CropInset {
  const value = image.style.getPropertyValue("object-view-box");
  const inner = /inset\(([^)]*)\)/u.exec(value)?.[1];
  if (!inner) return NO_CROP;
  const parts = inner
    .trim()
    .split(/\s+/u)
    .map((part) => (part.endsWith("%") ? Number.parseFloat(part) / 100 : 0));
  if (!parts.length || parts.some((part) => !Number.isFinite(part))) return NO_CROP;
  const [top = 0, right = top, bottom = top, left = right] = parts;
  const clamp = (part: number) => Math.min(0.95, Math.max(0, part));
  return { top: clamp(top), right: clamp(right), bottom: clamp(bottom), left: clamp(left) };
}

/** The whole picture's rectangle, given the box it shows now and its crop. */
export function fullImageRect(box: Rect, crop: CropInset): Rect {
  const w = box.w / Math.max(0.05, 1 - crop.left - crop.right);
  const h = box.h / Math.max(0.05, 1 - crop.top - crop.bottom);
  return { x: box.x - crop.left * w, y: box.y - crop.top * h, w, h };
}

/** The crop that shows `rect` of the whole picture `full`. */
export function cropOf(full: Rect, rect: Rect): CropInset {
  const clamp = (value: number) => Math.min(0.95, Math.max(0, value));
  return {
    left: clamp((rect.x - full.x) / full.w),
    top: clamp((rect.y - full.y) / full.h),
    right: clamp((full.x + full.w - (rect.x + rect.w)) / full.w),
    bottom: clamp((full.y + full.h - (rect.y + rect.h)) / full.h),
  };
}

const percent = (value: number) => `${Math.round(value * 10_000) / 100}%`;

/**
 * Shows `rect` (artboard coordinates) of the picture: the box takes that size, and a freely
 * placed picture moves so the kept part stays where it was. `origin` is the box and left/top
 * when the crop started.
 */
export function writeCrop(
  image: HTMLElement,
  crop: CropInset,
  rect: Rect,
  origin: { box: Rect; left: number; top: number; free: boolean },
) {
  const none = crop.top + crop.right + crop.bottom + crop.left < 0.0001;
  if (none) image.style.removeProperty("object-view-box");
  else
    image.style.setProperty(
      "object-view-box",
      `inset(${percent(crop.top)} ${percent(crop.right)} ${percent(crop.bottom)} ${percent(crop.left)})`,
    );
  image.style.setProperty("object-fit", "fill");
  image.style.setProperty("width", `${Math.round(rect.w)}px`);
  image.style.setProperty("height", `${Math.round(rect.h)}px`);
  if (origin.free) {
    image.style.setProperty("left", `${Math.round(origin.left + rect.x - origin.box.x)}px`);
    image.style.setProperty("top", `${Math.round(origin.top + rect.y - origin.box.y)}px`);
  }
}
