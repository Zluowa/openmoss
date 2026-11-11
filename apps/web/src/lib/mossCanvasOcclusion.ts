// FILE: mossCanvasOcclusion.ts
// Purpose: Where host chrome floating over the Canvas (the conversation's
// composer) covers it, in the Canvas frame's own coordinates. Moss sends this
// rectangle to the Canvas (moss-canvas-host-occlusion), which keeps its panels
// and its bottom bar clear of it.
// Layer: Web renderer, Canvas host protocol

export interface MossCanvasOcclusionRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

type Box = Pick<DOMRectReadOnly, "left" | "top" | "right" | "bottom" | "width" | "height">;

/** `cover` relative to `frame`, or null when nothing visible covers it. */
export function mossCanvasOcclusionRect(
  frame: Box,
  cover: Box | null | undefined,
): MossCanvasOcclusionRect | null {
  if (!cover || cover.width <= 0 || cover.height <= 0) return null;
  return {
    left: cover.left - frame.left,
    top: cover.top - frame.top,
    right: cover.right - frame.left,
    bottom: cover.bottom - frame.top,
  };
}
