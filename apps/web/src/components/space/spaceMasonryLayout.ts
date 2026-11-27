// FILE: spaceMasonryLayout.ts
// Purpose: Pure masonry column-width scaling and balanced shortest-column placement logic for
//          the 资料空间 item grid (shared across Ctrl+wheel zoom and ResizeObserver reflow).
// Layer: Space UI layout helper

export const DEFAULT_MASONRY_TARGET_WIDTH = 260;
export const MIN_MASONRY_TARGET_WIDTH = 150;
export const MAX_MASONRY_TARGET_WIDTH = 480;
export const MASONRY_ZOOM_STORAGE_KEY = "moss:space:grid-zoom:v1";

export interface MasonryMetrics {
  readonly columnCount: number;
  readonly columnWidth: number;
  readonly gap: number;
}

export interface MasonryItemPosition {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly column: number;
}

export interface MasonryLayoutResult {
  readonly positions: ReadonlyMap<string, MasonryItemPosition>;
  readonly totalHeight: number;
}

export function clampMasonryTargetWidth(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MASONRY_TARGET_WIDTH;
  return Math.round(Math.min(MAX_MASONRY_TARGET_WIDTH, Math.max(MIN_MASONRY_TARGET_WIDTH, value)));
}

/** Reads stored card width preference, falling back to DEFAULT_MASONRY_TARGET_WIDTH. */
export function readStoredMasonryTargetWidth(): number {
  try {
    const raw = globalThis.localStorage?.getItem(MASONRY_ZOOM_STORAGE_KEY);
    if (!raw) return DEFAULT_MASONRY_TARGET_WIDTH;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clampMasonryTargetWidth(parsed) : DEFAULT_MASONRY_TARGET_WIDTH;
  } catch {
    return DEFAULT_MASONRY_TARGET_WIDTH;
  }
}

export function writeStoredMasonryTargetWidth(width: number): void {
  try {
    globalThis.localStorage?.setItem(
      MASONRY_ZOOM_STORAGE_KEY,
      String(clampMasonryTargetWidth(width)),
    );
  } catch {
    // Ignore private window or full-storage failures.
  }
}

/**
 * Computes responsive column count, exact filled column width, and scaled gap so zooming
 * smoothly adapts from dense contact sheets to large showcase cards without clipping.
 */
export function computeMasonryMetrics(
  containerWidth: number,
  targetColumnWidth: number,
): MasonryMetrics {
  const safeWidth = Math.max(240, Number.isFinite(containerWidth) ? containerWidth : 960);
  const clampedTarget = clampMasonryTargetWidth(targetColumnWidth);
  const gap = Math.round(Math.min(24, Math.max(12, clampedTarget * 0.065)));
  const maxCols = Math.max(1, Math.floor((safeWidth + gap) / 140));
  const idealCols = Math.round((safeWidth + gap) / (clampedTarget + gap));
  const columnCount = Math.min(8, maxCols, Math.max(1, idealCols));
  const columnWidth = Math.max(120, (safeWidth - gap * (columnCount - 1)) / columnCount);
  return { columnCount, columnWidth, gap };
}

/**
 * Greedy shortest-column placement so masonry columns stay visually balanced after drops,
 * pagination, or column-count changes.
 */
export function layoutMasonryItems(
  keys: readonly string[],
  heights: ReadonlyMap<string, number>,
  metrics: MasonryMetrics,
  fallbackHeight = 220,
): MasonryLayoutResult {
  const { columnCount, columnWidth, gap } = metrics;
  const colHeights = Array<number>(columnCount).fill(0);
  const positions = new Map<string, MasonryItemPosition>();

  for (const key of keys) {
    let bestCol = 0;
    for (let col = 1; col < columnCount; col += 1) {
      if (colHeights[col]! < colHeights[bestCol]!) {
        bestCol = col;
      }
    }
    const y = colHeights[bestCol]!;
    const x = bestCol * (columnWidth + gap);
    positions.set(key, { x, y, width: columnWidth, column: bestCol });
    const measured = heights.get(key);
    const height = Math.max(40, measured && measured > 0 ? measured : fallbackHeight);
    colHeights[bestCol] = y + height + gap;
  }

  const maxHeight = colHeights.reduce((best, value) => Math.max(best, value), 0);
  return {
    positions,
    totalHeight: keys.length > 0 ? Math.max(0, maxHeight - gap) : 0,
  };
}
