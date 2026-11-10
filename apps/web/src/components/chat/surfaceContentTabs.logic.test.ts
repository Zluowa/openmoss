import { describe, expect, it } from "vitest";

import {
  findHiddenSurfaceTabIndexes,
  isSurfaceTabDraggedOut,
  SURFACE_TAB_DRAG_OUT_DISTANCE_PX,
} from "./surfaceContentTabs.logic";

describe("findHiddenSurfaceTabIndexes", () => {
  const strip = { left: 100, right: 500 };

  it("lists tabs scrolled past either edge, including partly visible ones", () => {
    expect(
      findHiddenSurfaceTabIndexes(strip, [
        { left: -60, right: 90 },
        { left: 90, right: 240 },
        { left: 240, right: 390 },
        { left: 390, right: 540 },
        { left: 540, right: 690 },
      ]),
    ).toEqual([0, 1, 3, 4]);
  });

  it("keeps tabs that only overhang by sub-pixel layout", () => {
    expect(
      findHiddenSurfaceTabIndexes(strip, [
        { left: 99.5, right: 300 },
        { left: 300, right: 500.6 },
      ]),
    ).toEqual([]);
  });
});

describe("isSurfaceTabDraggedOut", () => {
  const strip = { top: 40, bottom: 76 };

  it("keeps a drag that wobbles near the strip a reorder", () => {
    expect(isSurfaceTabDraggedOut(strip, 60)).toBe(false);
    expect(isSurfaceTabDraggedOut(strip, strip.bottom + SURFACE_TAB_DRAG_OUT_DISTANCE_PX)).toBe(
      false,
    );
    expect(isSurfaceTabDraggedOut(strip, strip.top - SURFACE_TAB_DRAG_OUT_DISTANCE_PX)).toBe(false);
  });

  it("lets a tab out once it travels past the strip's top or bottom", () => {
    expect(isSurfaceTabDraggedOut(strip, strip.bottom + SURFACE_TAB_DRAG_OUT_DISTANCE_PX + 1)).toBe(
      true,
    );
    expect(isSurfaceTabDraggedOut(strip, strip.top - SURFACE_TAB_DRAG_OUT_DISTANCE_PX - 1)).toBe(
      true,
    );
  });
});
