// FILE: generatedImagePreviewControls.logic.ts
// Purpose: Pure maths and keyboard/rail rules for the dedicated generated-image preview.
// Layer: Chat right-dock UI logic
// Notes: Manual zoom remains component-local; this module contains no persistence or URLs.

export const GENERATED_IMAGE_PREVIEW_ZOOM_OPTIONS = [25, 50, 100, 150, 200] as const;
export const GENERATED_IMAGE_PREVIEW_MIN_ZOOM_PERCENT = 10;
export const GENERATED_IMAGE_PREVIEW_MAX_ZOOM_PERCENT = 400;
export const GENERATED_IMAGE_PREVIEW_WHEEL_ZOOM_FACTOR = 0.01;
export const GENERATED_IMAGE_PREVIEW_PINCH_CLICK_SUPPRESSION_MS = 500;

export const GENERATED_IMAGE_PREVIEW_RAIL_WIDTH_PX = 72;
export const GENERATED_IMAGE_PREVIEW_RAIL_GAP_PX = 8;
export const GENERATED_IMAGE_PREVIEW_RAIL_INLINE_RESERVE_PX =
  GENERATED_IMAGE_PREVIEW_RAIL_WIDTH_PX + GENERATED_IMAGE_PREVIEW_RAIL_GAP_PX * 2;
export const GENERATED_IMAGE_PREVIEW_RAIL_TILE_SIZE_PX = 46;
export const GENERATED_IMAGE_PREVIEW_RAIL_TILE_STEP_PX =
  GENERATED_IMAGE_PREVIEW_RAIL_TILE_SIZE_PX + GENERATED_IMAGE_PREVIEW_RAIL_GAP_PX;
export const GENERATED_IMAGE_PREVIEW_RAIL_TOP_INSET_PX = 6;

export function generatedImagePreviewRailTotalContentHeightPx(imageCount: number): number {
  const count = Math.max(1, Math.trunc(imageCount));
  return (
    GENERATED_IMAGE_PREVIEW_RAIL_TOP_INSET_PX * 2 +
    (count - 1) * GENERATED_IMAGE_PREVIEW_RAIL_TILE_STEP_PX +
    GENERATED_IMAGE_PREVIEW_RAIL_TILE_SIZE_PX
  );
}

export interface GeneratedImagePreviewSize {
  width: number;
  height: number;
}

export interface GeneratedImagePreviewPoint {
  clientX: number;
  clientY: number;
}

export function clampGeneratedImagePreviewZoomPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 100;
  }
  return Math.min(
    GENERATED_IMAGE_PREVIEW_MAX_ZOOM_PERCENT,
    Math.max(GENERATED_IMAGE_PREVIEW_MIN_ZOOM_PERCENT, value),
  );
}

export function normalizeGeneratedImagePreviewWheelDeltaY(
  deltaY: number,
  deltaMode = 0,
  pageHeightPx = 800,
): number {
  if (!Number.isFinite(deltaY)) {
    return 0;
  }
  if (deltaMode === 1) {
    return deltaY * 16;
  }
  if (deltaMode === 2) {
    return deltaY * (Number.isFinite(pageHeightPx) && pageHeightPx > 0 ? pageHeightPx : 800);
  }
  return deltaY;
}

export function resolveGeneratedImagePreviewZoomForWheel(input: {
  currentZoomPercent: number;
  deltaY: number;
  deltaMode?: number;
  pageHeightPx?: number;
}): number {
  const currentZoomPercent = clampGeneratedImagePreviewZoomPercent(input.currentZoomPercent);
  const normalizedDeltaY = normalizeGeneratedImagePreviewWheelDeltaY(
    input.deltaY,
    input.deltaMode,
    input.pageHeightPx,
  );
  if (!Number.isFinite(normalizedDeltaY)) {
    return currentZoomPercent;
  }
  return clampGeneratedImagePreviewZoomPercent(
    Math.round(
      currentZoomPercent * Math.exp(-normalizedDeltaY * GENERATED_IMAGE_PREVIEW_WHEEL_ZOOM_FACTOR),
    ),
  );
}

export function distanceBetweenGeneratedImagePreviewPoints(
  first: GeneratedImagePreviewPoint,
  second: GeneratedImagePreviewPoint,
): number {
  return Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
}

export function resolveGeneratedImagePreviewZoomForPinch(input: {
  initialDistance: number;
  initialZoomPercent: number;
  nextDistance: number;
}): number {
  const initialZoomPercent = clampGeneratedImagePreviewZoomPercent(input.initialZoomPercent);
  if (
    !Number.isFinite(input.initialDistance) ||
    input.initialDistance <= 0 ||
    !Number.isFinite(input.nextDistance) ||
    input.nextDistance <= 0
  ) {
    return initialZoomPercent;
  }
  return clampGeneratedImagePreviewZoomPercent(
    Math.round((input.nextDistance / input.initialDistance) * initialZoomPercent),
  );
}

export function resolveGeneratedImagePreviewFitZoomPercent(input: {
  naturalImageSize: GeneratedImagePreviewSize | null;
  viewportSize: GeneratedImagePreviewSize | null;
  hasImageRail?: boolean;
}): number | null {
  const naturalImageSize = input.naturalImageSize;
  const viewportSize = input.viewportSize;
  if (
    naturalImageSize === null ||
    viewportSize === null ||
    !Number.isFinite(naturalImageSize.width) ||
    !Number.isFinite(naturalImageSize.height) ||
    naturalImageSize.width <= 0 ||
    naturalImageSize.height <= 0 ||
    !Number.isFinite(viewportSize.width) ||
    !Number.isFinite(viewportSize.height) ||
    viewportSize.width <= 0 ||
    viewportSize.height <= 0
  ) {
    return null;
  }

  const availableWidth = Math.max(
    1,
    viewportSize.width - (input.hasImageRail ? GENERATED_IMAGE_PREVIEW_RAIL_INLINE_RESERVE_PX : 0),
  );
  const scale = Math.min(
    1,
    availableWidth / naturalImageSize.width,
    viewportSize.height / naturalImageSize.height,
  );
  return Number.isFinite(scale) && scale > 0 ? scale * 100 : null;
}

export function resolveGeneratedImagePreviewZoomScrollPosition(input: {
  scrollLeft: number;
  scrollTop: number;
  oldTargetRect: { left: number; top: number; width: number; height: number };
  newTargetRect: { left: number; top: number; width: number; height: number };
  point?: GeneratedImagePreviewPoint;
  fallbackPoint?: GeneratedImagePreviewPoint;
}): { left: number; top: number } {
  const point = input.point ??
    input.fallbackPoint ?? {
      clientX: input.oldTargetRect.left + input.oldTargetRect.width / 2,
      clientY: input.oldTargetRect.top + input.oldTargetRect.height / 2,
    };
  const xRatio =
    input.oldTargetRect.width > 0
      ? Math.min(
          1,
          Math.max(0, (point.clientX - input.oldTargetRect.left) / input.oldTargetRect.width),
        )
      : 0.5;
  const yRatio =
    input.oldTargetRect.height > 0
      ? Math.min(
          1,
          Math.max(0, (point.clientY - input.oldTargetRect.top) / input.oldTargetRect.height),
        )
      : 0.5;
  return {
    left:
      input.scrollLeft +
      input.newTargetRect.left +
      input.newTargetRect.width * xRatio -
      point.clientX,
    top:
      input.scrollTop +
      input.newTargetRect.top +
      input.newTargetRect.height * yRatio -
      point.clientY,
  };
}

export function resolveGeneratedImagePreviewArrowNavigation(input: {
  imageIndex: number;
  imageCount: number;
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  isEditableTarget?: boolean;
}): number | null {
  if (
    (input.key !== "ArrowUp" &&
      input.key !== "ArrowDown" &&
      input.key !== "ArrowLeft" &&
      input.key !== "ArrowRight") ||
    input.altKey === true ||
    input.ctrlKey === true ||
    input.metaKey === true ||
    input.shiftKey === true ||
    input.isEditableTarget === true ||
    !Number.isFinite(input.imageIndex) ||
    !Number.isInteger(input.imageCount) ||
    input.imageCount <= 0
  ) {
    return null;
  }
  const activeIndex = Math.min(Math.max(input.imageIndex, 0), input.imageCount - 1);
  const direction = input.key === "ArrowUp" || input.key === "ArrowLeft" ? -1 : 1;
  const nextIndex = activeIndex + direction;
  return nextIndex < 0 || nextIndex >= input.imageCount ? null : nextIndex;
}

export function resolveGeneratedImagePreviewRailWheel(input: {
  position: number;
  deltaY: number;
  deltaMode?: number;
  imageCount: number;
  viewportHeightPx: number;
  scrollHeightPx?: number;
  totalContentHeightPx?: number;
}): { position: number; imageIndex: number; scrollTop: number } {
  const imageCount = Math.max(0, Math.trunc(input.imageCount));
  if (imageCount === 0) {
    return { position: 0, imageIndex: -1, scrollTop: 0 };
  }

  const firstTileCenter =
    GENERATED_IMAGE_PREVIEW_RAIL_TOP_INSET_PX + GENERATED_IMAGE_PREVIEW_RAIL_TILE_SIZE_PX / 2;
  const lastTileCenter =
    firstTileCenter + (imageCount - 1) * GENERATED_IMAGE_PREVIEW_RAIL_TILE_STEP_PX;
  const position = Math.min(
    lastTileCenter,
    Math.max(
      firstTileCenter,
      (Number.isFinite(input.position) ? input.position : firstTileCenter) +
        normalizeGeneratedImagePreviewWheelDeltaY(
          input.deltaY,
          input.deltaMode,
          input.viewportHeightPx,
        ),
    ),
  );
  const imageIndex = Math.min(
    imageCount - 1,
    Math.max(
      0,
      Math.round((position - firstTileCenter) / GENERATED_IMAGE_PREVIEW_RAIL_TILE_STEP_PX),
    ),
  );
  const viewportHeightPx =
    Number.isFinite(input.viewportHeightPx) && input.viewportHeightPx > 0
      ? input.viewportHeightPx
      : 0;
  const totalContentHeightPx =
    Number.isFinite(input.totalContentHeightPx) && (input.totalContentHeightPx ?? 0) > 0
      ? input.totalContentHeightPx!
      : generatedImagePreviewRailTotalContentHeightPx(imageCount);
  const scrollHeightPx =
    Number.isFinite(input.scrollHeightPx) && (input.scrollHeightPx ?? 0) > 0
      ? input.scrollHeightPx!
      : Math.max(viewportHeightPx, totalContentHeightPx);
  const centerOffset = Math.min(totalContentHeightPx, viewportHeightPx) / 2;
  const maxScrollTop = Math.max(0, scrollHeightPx - viewportHeightPx);
  return {
    position,
    imageIndex,
    scrollTop: Math.min(maxScrollTop, Math.max(0, position - centerOffset)),
  };
}

/** Sanitizes only the persisted display name; no path or URL is used as a fallback. */
export function safeGeneratedImagePreviewDownloadName(name: string): string {
  const trimmed = name.trim();
  const basename = trimmed.split(/[\\/]/u).at(-1) ?? trimmed;
  const withoutControlCharacters = Array.from(basename)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 0x20 && !(codePoint >= 0x7f && codePoint <= 0x9f);
    })
    .join("");
  const safeName = withoutControlCharacters
    .replace(/[<>:"/\\|?*]/gu, "_")
    .replace(/[. ]+$/u, "")
    .trim();
  return safeName || "generated-image";
}
