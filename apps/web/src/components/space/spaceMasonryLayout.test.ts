// FILE: spaceMasonryLayout.test.ts
// Purpose: Unit tests for responsive masonry column sizing, zoom clamping, and shortest-column
//          balanced placement used by SpaceMasonryGrid and Ctrl+wheel zoom.

import { describe, expect, it } from "vitest";

import {
  clampMasonryTargetWidth,
  computeMasonryMetrics,
  DEFAULT_MASONRY_TARGET_WIDTH,
  layoutMasonryItems,
  MAX_MASONRY_TARGET_WIDTH,
  MIN_MASONRY_TARGET_WIDTH,
} from "./spaceMasonryLayout";

describe("spaceMasonryLayout", () => {
  it("clamps zoom target column widths within safe bounds", () => {
    expect(clampMasonryTargetWidth(40)).toBe(MIN_MASONRY_TARGET_WIDTH);
    expect(clampMasonryTargetWidth(900)).toBe(MAX_MASONRY_TARGET_WIDTH);
    expect(clampMasonryTargetWidth(Number.NaN)).toBe(DEFAULT_MASONRY_TARGET_WIDTH);
    expect(clampMasonryTargetWidth(285.4)).toBe(285);
  });

  it("adapts column count smoothly as target column width scales", () => {
    const dense = computeMasonryMetrics(1200, 160);
    const medium = computeMasonryMetrics(1200, 260);
    const large = computeMasonryMetrics(1200, 440);

    expect(dense.columnCount).toBeGreaterThan(medium.columnCount);
    expect(medium.columnCount).toBeGreaterThan(large.columnCount);
    expect(dense.columnWidth).toBeLessThan(medium.columnWidth);
    expect(medium.columnWidth).toBeLessThan(large.columnWidth);

    // Every zoom level fills the full container cleanly without overflow.
    for (const m of [dense, medium, large]) {
      const spanned = m.columnCount * m.columnWidth + (m.columnCount - 1) * m.gap;
      expect(Math.abs(spanned - 1200)).toBeLessThan(1);
    }
  });

  it("places each next item into the shortest column to stay balanced", () => {
    const metrics = { columnCount: 3, columnWidth: 200, gap: 20 };
    const heights = new Map<string, number>([
      ["a", 300],
      ["b", 100],
      ["c", 200],
      ["d", 120],
      ["e", 100],
    ]);

    const result = layoutMasonryItems(["a", "b", "c", "d", "e"], heights, metrics);
    // Row 1 places a (col 0), b (col 1), c (col 2). Shortest after that is col 1 (100+20=120).
    expect(result.positions.get("d")).toEqual({ x: 220, y: 120, width: 200, column: 1 });
    // Now colHeights are [320, 260, 220], so next shortest is col 2 at y=220.
    expect(result.positions.get("e")).toEqual({ x: 440, y: 220, width: 200, column: 2 });
    // Tallest bottom across columns: col 2 ends at 220 + 100 = 320, col 0 ends at 300.
    expect(result.totalHeight).toBe(320);
  });
});
