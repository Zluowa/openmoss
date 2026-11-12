// FILE: transcriptSelectionAnchor.ts
// Purpose: Pins a floating transcript-selection surface (the "Start a side chat | Reply"
//          pill and the Reply card) to the selected text, the way desktop chat does: centred
//          on the selection, above its first line when it fits, otherwise below, clamped to
//          the transcript, and following the text as the transcript scrolls.
// Layer: Chat transcript interaction UI

import { useLayoutEffect, type RefObject } from "react";

/** Gap between the selected line and the surface. */
const ANCHOR_GAP_PX = 8;
/** Smallest distance the surface keeps from the transcript and window edges. */
const ANCHOR_EDGE_PX = 12;

function firstAndLastLineRects(range: Range): { first: DOMRect; last: DOMRect } | null {
  if (!range.startContainer.isConnected || range.collapsed) return null;
  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 && rect.height > 0,
  );
  const first = rects[0];
  const last = rects[rects.length - 1];
  if (first && last) return { first, last };
  const box = range.getBoundingClientRect();
  return box.width > 0 || box.height > 0 ? { first: box, last: box } : null;
}

export interface SelectionAnchorPlacement {
  left: number;
  top: number;
  side: "above" | "below";
}

/**
 * Pure placement: where a surface of `size` goes for a selection whose first and last
 * lines are `first` and `last`, inside `bounds` (the transcript) and the window.
 */
export function placeSelectionSurface(input: {
  first: Pick<DOMRect, "left" | "width" | "top" | "bottom">;
  last: Pick<DOMRect, "left" | "width" | "top" | "bottom">;
  size: { width: number; height: number };
  bounds: { left: number; right: number; top: number; bottom: number };
  viewport: { width: number; height: number };
  /** Side chosen on an earlier frame: a surface never flips while it is shown. */
  side?: "above" | "below" | null;
}): SelectionAnchorPlacement {
  const { first, last, size, viewport } = input;
  const bounds = {
    left: Math.max(0, input.bounds.left),
    right: Math.min(viewport.width, input.bounds.right),
    top: Math.max(0, input.bounds.top),
    bottom: Math.min(viewport.height, input.bounds.bottom),
  };
  const fitsAbove = first.top - ANCHOR_GAP_PX - size.height >= bounds.top + ANCHOR_EDGE_PX;
  const fitsBelow = last.bottom + ANCHOR_GAP_PX + size.height <= bounds.bottom - ANCHOR_EDGE_PX;
  const side = input.side ?? (fitsAbove || !fitsBelow ? "above" : "below");
  const line = side === "above" ? first : last;
  const half = size.width / 2 + ANCHOR_EDGE_PX;
  const centre = line.left + line.width / 2;
  const left =
    bounds.right - bounds.left >= half * 2
      ? Math.min(Math.max(centre, bounds.left + half), bounds.right - half)
      : (bounds.left + bounds.right) / 2;
  const rawTop =
    side === "above" ? first.top - ANCHOR_GAP_PX - size.height : last.bottom + ANCHOR_GAP_PX;
  const top = Math.min(
    Math.max(rawTop, ANCHOR_EDGE_PX),
    Math.max(ANCHOR_EDGE_PX, viewport.height - size.height - ANCHOR_EDGE_PX),
  );
  return {
    left: Math.round(Math.min(Math.max(left, half), viewport.width - half)),
    top: Math.round(top),
    side,
  };
}

/**
 * Keeps `surfaceRef` (a `position: fixed; left: 0; top: 0` element) on `range`, repainting
 * on scroll, resize and its own size changes. `onLost` runs when the text it points at is
 * gone (the message re-rendered or the transcript switched), so the surface can close.
 */
export function useSelectionAnchor(input: {
  surfaceRef: RefObject<HTMLElement | null>;
  range: Range;
  boundary: HTMLElement | null;
  onLost?: (() => void) | undefined;
}): void {
  const { surfaceRef, range, boundary, onLost } = input;
  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    let frame: number | null = null;
    let side: "above" | "below" | null = null;
    const place = () => {
      const lines = firstAndLastLineRects(range);
      if (!lines) {
        onLost?.();
        return;
      }
      const box = boundary?.getBoundingClientRect();
      const placement = placeSelectionSurface({
        first: lines.first,
        last: lines.last,
        size: { width: surface.offsetWidth, height: surface.offsetHeight },
        bounds: {
          left: box?.left ?? 0,
          right: box?.right ?? window.innerWidth,
          top: box?.top ?? 0,
          bottom: box?.bottom ?? window.innerHeight,
        },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        side,
      });
      side = placement.side;
      surface.dataset.side = placement.side;
      surface.style.transform = `translate(${placement.left}px, ${placement.top}px) translateX(-50%)`;
      surface.style.visibility = "visible";
    };
    const schedule = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        place();
      });
    };
    place();
    document.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(surface);
    return () => {
      document.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [boundary, onLost, range, surfaceRef]);
}

const REPLY_SELECTION_HIGHLIGHT = "moss-reply-selection";

/**
 * Paints `range` as selected while the Reply card is open, without holding the document
 * selection (focus moves into the card's field, which would otherwise collapse it).
 * Desktop chat does the same with a CSS custom highlight.
 */
export function useReplySelectionHighlight(range: Range | null): void {
  useLayoutEffect(() => {
    if (!range) return;
    const highlights = (globalThis.CSS as { highlights?: Map<string, unknown> } | undefined)
      ?.highlights;
    const HighlightCtor = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown })
      .Highlight;
    if (!highlights || !HighlightCtor) return;
    highlights.set(REPLY_SELECTION_HIGHLIGHT, new HighlightCtor(range));
    return () => {
      highlights.delete(REPLY_SELECTION_HIGHLIGHT);
    };
  }, [range]);
}
