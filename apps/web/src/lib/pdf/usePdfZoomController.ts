// Owns fit-width/custom zoom and preserves the point under the pointer (wheel)
// or viewport center (menu) while the page stack changes size.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { capturePdfZoomAnchor, pdfZoomAnchorDelta, readPdfPageRects } from "./pdfViewport";
import type { PdfZoomAnchor } from "./pdfViewport";
import {
  clampPdfScale,
  nextZoomScale,
  type PdfPageIntrinsicSize,
  type PdfViewportSize,
  type PdfZoomMode,
  previousZoomScale,
  resolvePdfScale,
} from "./pdfZoom";

export function usePdfZoomController(input: {
  firstPageSize: PdfPageIntrinsicSize | null;
  containerSize: PdfViewportSize | null;
  scrollRoot: HTMLElement | null;
  resetKey: unknown;
}) {
  const { firstPageSize, containerSize, scrollRoot, resetKey } = input;
  const [state, setState] = useState<{ key: unknown; mode: PdfZoomMode }>({
    key: resetKey,
    mode: { type: "fit-width" },
  });
  const zoomMode: PdfZoomMode = Object.is(state.key, resetKey) ? state.mode : { type: "fit-width" };
  const scale = resolvePdfScale(zoomMode, firstPageSize, containerSize);
  const pendingAnchor = useRef<{ key: unknown; anchor: PdfZoomAnchor } | null>(null);

  const changeZoom = useCallback(
    (mode: PdfZoomMode, point?: { x: number; y: number }) => {
      if (scrollRoot) {
        const anchor = capturePdfZoomAnchor(
          readPdfPageRects(scrollRoot),
          point ?? {
            x: scrollRoot.clientWidth / 2,
            y: scrollRoot.clientHeight / 2,
          },
        );
        pendingAnchor.current = anchor ? { key: resetKey, anchor } : null;
      }
      setState({ key: resetKey, mode });
    },
    [resetKey, scrollRoot],
  );

  useLayoutEffect(() => {
    const pending = pendingAnchor.current;
    pendingAnchor.current = null;
    if (!scrollRoot || !pending || !Object.is(pending.key, resetKey)) return;
    const page = readPdfPageRects(scrollRoot).find(
      (rect) => rect.pageNumber === pending.anchor.pageNumber,
    );
    if (!page) return;
    const delta = pdfZoomAnchorDelta(pending.anchor, page);
    scrollRoot.scrollLeft += delta.left;
    scrollRoot.scrollTop += delta.top;
  }, [resetKey, scale, scrollRoot, state]);

  useEffect(() => {
    if (!scrollRoot) return;
    let delta = 0;
    let lastWheelAt = 0;
    let wheelScale = scale;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      if (event.timeStamp - lastWheelAt > 200) delta = 0;
      lastWheelAt = event.timeStamp;
      delta += event.deltaY;
      if (Math.abs(delta) < 5) return;
      wheelScale = delta < 0 ? nextZoomScale(wheelScale) : previousZoomScale(wheelScale);
      delta = 0;
      const root = scrollRoot.getBoundingClientRect();
      changeZoom(
        { type: "custom", scale: wheelScale },
        {
          x: event.clientX - root.left,
          y: event.clientY - root.top,
        },
      );
    };
    scrollRoot.addEventListener("wheel", onWheel, { passive: false });
    return () => scrollRoot.removeEventListener("wheel", onWheel);
  }, [changeZoom, scale, scrollRoot]);

  return {
    zoomMode,
    scale,
    onZoomIn: () => changeZoom({ type: "custom", scale: nextZoomScale(scale) }),
    onZoomOut: () => changeZoom({ type: "custom", scale: previousZoomScale(scale) }),
    onSetScale: (nextScale: number) =>
      changeZoom({ type: "custom", scale: clampPdfScale(nextScale) }),
    onFitWidth: () => changeZoom({ type: "fit-width" }),
    onFitPage: () => changeZoom({ type: "fit-page" }),
  };
}
