// Page coordinates avoid scaling fixed gaps and preserve mixed-size page anchors.
export interface PdfPageRect {
  pageNumber: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PdfZoomAnchor {
  pageNumber: number;
  pageX: number;
  pageY: number;
  viewportX: number;
  viewportY: number;
}

export function capturePdfZoomAnchor(
  pages: readonly PdfPageRect[],
  point: { x: number; y: number },
): PdfZoomAnchor | null {
  let nearest: PdfPageRect | undefined;
  let distance = Infinity;
  for (const page of pages) {
    const dx = Math.max(page.left - point.x, 0, point.x - page.left - page.width);
    const dy = Math.max(page.top - point.y, 0, point.y - page.top - page.height);
    const nextDistance = dx * dx + dy * dy;
    if (nextDistance < distance && page.width > 0 && page.height > 0) {
      nearest = page;
      distance = nextDistance;
    }
  }
  if (!nearest) return null;
  return {
    pageNumber: nearest.pageNumber,
    pageX: (point.x - nearest.left) / nearest.width,
    pageY: (point.y - nearest.top) / nearest.height,
    viewportX: point.x,
    viewportY: point.y,
  };
}

export function pdfZoomAnchorDelta(anchor: PdfZoomAnchor, page: PdfPageRect) {
  return {
    left: page.left + page.width * anchor.pageX - anchor.viewportX,
    top: page.top + page.height * anchor.pageY - anchor.viewportY,
  };
}

/** Largest intersection ratio wins; ties retain document order. */
export function resolvePdfCurrentPage(
  pages: readonly { pageNumber: number; top: number; intersectionRatio: number }[],
): number | null {
  let visible: (typeof pages)[number] | undefined;
  let nearest: (typeof pages)[number] | undefined;
  for (const page of pages) {
    if (!visible || page.intersectionRatio > visible.intersectionRatio) visible = page;
    if (!nearest || Math.abs(page.top) < Math.abs(nearest.top)) nearest = page;
  }
  return visible && visible.intersectionRatio > 0
    ? visible.pageNumber
    : (nearest?.pageNumber ?? null);
}

export function readPdfPageRects(container: HTMLElement): PdfPageRect[] {
  const root = container.getBoundingClientRect();
  return Array.from(container.querySelectorAll<HTMLElement>("[data-page-number]"), (element) => {
    const rect = element.getBoundingClientRect();
    return {
      pageNumber: Number(element.dataset.pageNumber),
      left: rect.left - root.left,
      top: rect.top - root.top,
      width: rect.width,
      height: rect.height,
    };
  });
}
