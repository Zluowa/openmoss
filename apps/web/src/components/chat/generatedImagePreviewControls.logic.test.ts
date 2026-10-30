import { describe, expect, it } from "vitest";

import {
  GENERATED_IMAGE_PREVIEW_RAIL_INLINE_RESERVE_PX,
  GENERATED_IMAGE_PREVIEW_ZOOM_OPTIONS,
  clampGeneratedImagePreviewZoomPercent,
  distanceBetweenGeneratedImagePreviewPoints,
  generatedImagePreviewRailTotalContentHeightPx,
  normalizeGeneratedImagePreviewWheelDeltaY,
  resolveGeneratedImagePreviewArrowNavigation,
  resolveGeneratedImagePreviewFitZoomPercent,
  resolveGeneratedImagePreviewRailWheel,
  resolveGeneratedImagePreviewZoomScrollPosition,
  resolveGeneratedImagePreviewZoomForPinch,
  resolveGeneratedImagePreviewZoomForWheel,
  safeGeneratedImagePreviewDownloadName,
} from "./generatedImagePreviewControls.logic";

describe("generated image preview controls", () => {
  it("keeps the frozen zoom options and clamps manual zoom", () => {
    expect(GENERATED_IMAGE_PREVIEW_ZOOM_OPTIONS).toEqual([25, 50, 100, 150, 200]);
    expect(clampGeneratedImagePreviewZoomPercent(0)).toBe(10);
    expect(clampGeneratedImagePreviewZoomPercent(401)).toBe(400);
    expect(clampGeneratedImagePreviewZoomPercent(Number.NaN)).toBe(100);
  });

  it("calculates fit zoom with the rail inline reserve", () => {
    expect(
      resolveGeneratedImagePreviewFitZoomPercent({
        naturalImageSize: { width: 1_000, height: 800 },
        viewportSize: { width: 600, height: 600 },
      }),
    ).toBe(60);
    expect(
      resolveGeneratedImagePreviewFitZoomPercent({
        naturalImageSize: { width: 1_000, height: 800 },
        viewportSize: { width: 600, height: 600 },
        hasImageRail: true,
      }),
    ).toBe(((600 - GENERATED_IMAGE_PREVIEW_RAIL_INLINE_RESERVE_PX) / 1_000) * 100);
    expect(
      resolveGeneratedImagePreviewFitZoomPercent({ naturalImageSize: null, viewportSize: null }),
    ).toBeNull();
  });

  it("uses normalized exponential wheel and proportional pinch zoom", () => {
    expect(normalizeGeneratedImagePreviewWheelDeltaY(2, 1)).toBe(32);
    expect(normalizeGeneratedImagePreviewWheelDeltaY(2, 2, 500)).toBe(1_000);
    expect(
      resolveGeneratedImagePreviewZoomForWheel({ currentZoomPercent: 100, deltaY: -100 }),
    ).toBe(272);
    expect(
      resolveGeneratedImagePreviewZoomForWheel({ currentZoomPercent: 390, deltaY: -100 }),
    ).toBe(400);
    expect(resolveGeneratedImagePreviewZoomForWheel({ currentZoomPercent: 11, deltaY: 100 })).toBe(
      10,
    );
    expect(
      distanceBetweenGeneratedImagePreviewPoints(
        { clientX: 0, clientY: 0 },
        { clientX: 3, clientY: 4 },
      ),
    ).toBe(5);
    expect(
      resolveGeneratedImagePreviewZoomForPinch({
        initialDistance: 100,
        initialZoomPercent: 100,
        nextDistance: 150,
      }),
    ).toBe(150);
    expect(
      resolveGeneratedImagePreviewZoomForPinch({
        initialDistance: 100,
        initialZoomPercent: 101,
        nextDistance: 133,
      }),
    ).toBe(134);
    expect(
      resolveGeneratedImagePreviewZoomForPinch({
        initialDistance: 100,
        initialZoomPercent: 100,
        nextDistance: 1_000,
      }),
    ).toBe(400);
  });

  it("keeps an off-center image pixel anchored during zoom", () => {
    const oldTargetRect = { left: 100, top: 80, width: 400, height: 300 };
    const newTargetRect = { left: 40, top: 20, width: 800, height: 600 };
    const point = { clientX: 100 + 400 * 0.73, clientY: 80 + 300 * 0.31 };
    const scrollPosition = resolveGeneratedImagePreviewZoomScrollPosition({
      scrollLeft: 37,
      scrollTop: 19,
      oldTargetRect,
      newTargetRect,
      point,
    });
    expect(scrollPosition.left).toBeCloseTo(37 + 40 + 800 * 0.73 - point.clientX, 8);
    expect(scrollPosition.top).toBeCloseTo(19 + 20 + 600 * 0.31 - point.clientY, 8);
  });

  it("navigates the rail without wrapping or stealing modified/editable keys", () => {
    const input = { imageIndex: 1, imageCount: 3, key: "ArrowRight" };
    expect(resolveGeneratedImagePreviewArrowNavigation(input)).toBe(2);
    expect(resolveGeneratedImagePreviewArrowNavigation({ ...input, key: "ArrowLeft" })).toBe(0);
    expect(
      resolveGeneratedImagePreviewArrowNavigation({ imageIndex: 0, imageCount: 3, key: "ArrowUp" }),
    ).toBeNull();
    expect(
      resolveGeneratedImagePreviewArrowNavigation({ ...input, key: "ArrowDown", metaKey: true }),
    ).toBeNull();
    expect(
      resolveGeneratedImagePreviewArrowNavigation({
        ...input,
        key: "ArrowDown",
        isEditableTarget: true,
      }),
    ).toBeNull();

    const wheel = resolveGeneratedImagePreviewRailWheel({
      position: 29,
      deltaY: 60,
      imageCount: 3,
      viewportHeightPx: 100,
      scrollHeightPx: 260,
      totalContentHeightPx: generatedImagePreviewRailTotalContentHeightPx(3),
    });
    expect(wheel.imageIndex).toBe(1);
    expect(wheel.scrollTop).toBeGreaterThanOrEqual(0);
    expect(
      resolveGeneratedImagePreviewRailWheel({
        position: wheel.position,
        deltaY: -10_000,
        imageCount: 3,
        viewportHeightPx: 100,
      }).imageIndex,
    ).toBe(0);
    expect(generatedImagePreviewRailTotalContentHeightPx(3)).toBe(166);
  });

  it("uses only a sanitized persisted display name for downloads", () => {
    expect(safeGeneratedImagePreviewDownloadName("render-final.png")).toBe("render-final.png");
    expect(safeGeneratedImagePreviewDownloadName("../private/render?.png")).toBe("render_.png");
    expect(safeGeneratedImagePreviewDownloadName("render\u0000-final.png")).toBe(
      "render-final.png",
    );
    expect(safeGeneratedImagePreviewDownloadName("   ")).toBe("generated-image");
  });
});
