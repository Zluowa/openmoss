import { describe, expect, it } from "vitest";
import { capturePdfZoomAnchor, pdfZoomAnchorDelta, resolvePdfCurrentPage } from "./pdfViewport";
import { isPdfAnnotationShortcut, normalizePdfAnnotationRect } from "./pdfAnnotations";

describe("PDF reading position", () => {
  it("anchors within the visible second page without scaling its fixed gap", () => {
    const anchor = capturePdfZoomAnchor(
      [
        { pageNumber: 1, left: 24, top: -780, width: 600, height: 800 },
        { pageNumber: 2, left: 124, top: 44, width: 400, height: 500 },
      ],
      { x: 324, y: 294 },
    );
    expect(anchor).toEqual({
      pageNumber: 2,
      pageX: 0.5,
      pageY: 0.5,
      viewportX: 324,
      viewportY: 294,
    });
    expect(
      pdfZoomAnchorDelta(anchor!, {
        pageNumber: 2,
        left: 224,
        top: 844,
        width: 800,
        height: 1000,
      }),
    ).toEqual({ left: 300, top: 1050 });
  });

  it("uses the closest page for a pointer over the gap", () => {
    expect(
      capturePdfZoomAnchor(
        [
          { pageNumber: 1, left: 0, top: 0, width: 200, height: 100 },
          { pageNumber: 2, left: 0, top: 124, width: 200, height: 100 },
        ],
        { x: 100, y: 122 },
      )?.pageNumber,
    ).toBe(2);
    expect(capturePdfZoomAnchor([], { x: 0, y: 0 })).toBeNull();
  });

  it("chooses visible proportion, retains the first tie, and falls back to nearest top", () => {
    const pages = [
      { pageNumber: 1, top: -400, intersectionRatio: 0.25 },
      { pageNumber: 2, top: 50, intersectionRatio: 0.75 },
    ];
    expect(resolvePdfCurrentPage(pages)).toBe(2);
    expect(resolvePdfCurrentPage(pages.map((page) => ({ ...page, intersectionRatio: 0.5 })))).toBe(
      1,
    );
    expect(resolvePdfCurrentPage(pages.map((page) => ({ ...page, intersectionRatio: 0 })))).toBe(2);
    expect(resolvePdfCurrentPage([])).toBeNull();
  });
});

describe("PDF annotation anchors", () => {
  it("preserves normalized coordinates across zoom and clips selections to the page", () => {
    expect(
      normalizePdfAnnotationRect(
        { left: 110, top: 220, width: 200, height: 100 },
        { left: 10, top: 20, width: 400, height: 800 },
      ),
    ).toEqual({ x: 0.25, y: 0.25, width: 0.5, height: 0.125 });
    expect(
      normalizePdfAnnotationRect(
        { left: -10, top: 20, width: 500, height: 900 },
        { left: 10, top: 20, width: 400, height: 800 },
      ),
    ).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(
      normalizePdfAnnotationRect(
        { left: 10, top: 20, width: 0, height: 0 },
        { left: 10, top: 20, width: 400, height: 800 },
      ),
    ).toBeNull();
  });

  it("accepts Ctrl/Cmd+I only, excluding alt/shift variants", () => {
    const event = { key: "I", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false };
    expect(isPdfAnnotationShortcut(event)).toBe(true);
    expect(isPdfAnnotationShortcut({ ...event, ctrlKey: false, metaKey: true })).toBe(true);
    expect(isPdfAnnotationShortcut({ ...event, altKey: true })).toBe(false);
    expect(isPdfAnnotationShortcut({ ...event, shiftKey: true })).toBe(false);
    expect(isPdfAnnotationShortcut({ ...event, key: "+" })).toBe(false);
  });
});
