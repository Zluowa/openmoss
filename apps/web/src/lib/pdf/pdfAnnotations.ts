export interface PdfAnnotationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfPreviewAnnotation {
  pageNumber: number;
  pageCount: number;
  selectedText: string;
  /** Coordinates normalized to the PDF page, independent of zoom. */
  rect: PdfAnnotationRect;
  body: string;
}

export function normalizePdfAnnotationRect(
  rect: { left: number; top: number; width: number; height: number },
  page: { left: number; top: number; width: number; height: number },
): PdfAnnotationRect | null {
  if (page.width <= 0 || page.height <= 0) return null;
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const x = clamp((rect.left - page.left) / page.width);
  const y = clamp((rect.top - page.top) / page.height);
  const right = clamp((rect.left + rect.width - page.left) / page.width);
  const bottom = clamp((rect.top + rect.height - page.top) / page.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

export function isPdfAnnotationShortcut(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}) {
  return (
    event.key.toLowerCase() === "i" &&
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey
  );
}
