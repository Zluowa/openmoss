// FILE: useEdgeSwipeOpen.ts
// Purpose: Swipe in from the left screen edge to open the phone sidebar sheet.
// Layer: Touch interaction hook
//
// Only the installed app (display-mode: standalone) listens: there the browser has no
// back-swipe of its own, while in a Safari tab the same gesture belongs to Safari.
import { useEffect } from "react";
import { useMediaQuery } from "./useMediaQuery";

/** A touch that starts this close to the left edge can open the sheet. */
const EDGE_START_PX = 28;
/** Horizontal travel that commits the swipe. */
const COMMIT_DISTANCE_PX = 56;

export interface EdgeSwipeSample {
  readonly startX: number;
  readonly startY: number;
  readonly x: number;
  readonly y: number;
}

/** A swipe opens when it starts at the edge and travels mostly rightward. */
export function isEdgeSwipeOpen(sample: EdgeSwipeSample): boolean {
  if (sample.startX > EDGE_START_PX) return false;
  const dx = sample.x - sample.startX;
  const dy = Math.abs(sample.y - sample.startY);
  return dx >= COMMIT_DISTANCE_PX && dx > dy * 1.5;
}

export function useEdgeSwipeOpen(input: {
  readonly enabled: boolean;
  readonly onOpen: () => void;
}): void {
  const standalone = useMediaQuery("(display-mode: standalone)");
  const { enabled, onOpen } = input;
  useEffect(() => {
    if (!enabled || !standalone) return;
    let start: { x: number; y: number } | null = null;
    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches.length === 1 ? event.touches[0] : undefined;
      start =
        touch && touch.clientX <= EDGE_START_PX ? { x: touch.clientX, y: touch.clientY } : null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!start || !touch) return;
      if (
        isEdgeSwipeOpen({ startX: start.x, startY: start.y, x: touch.clientX, y: touch.clientY })
      ) {
        start = null;
        onOpen();
      }
    };
    const onTouchEnd = () => {
      start = null;
    };
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    window.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [enabled, standalone, onOpen]);
}
