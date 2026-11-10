// FILE: surfaceContentTabs.logic.ts
// Purpose: Pure geometry for the content tab strip: its overflow menu, and when a dragged
//          tab leaves the strip.
// Layer: Chat surface UI logic

interface HorizontalSpan {
  left: number;
  right: number;
}

// Sub-pixel layout can leave a fully shown tab a fraction past the strip's edge.
const VISIBILITY_TOLERANCE_PX = 1;

/** Indexes of the tabs that are not wholly inside the strip's visible span. */
export function findHiddenSurfaceTabIndexes(
  strip: HorizontalSpan,
  tabs: readonly HorizontalSpan[],
): number[] {
  const hidden: number[] = [];
  tabs.forEach((tab, index) => {
    if (
      tab.left < strip.left - VISIBILITY_TOLERANCE_PX ||
      tab.right > strip.right + VISIBILITY_TOLERANCE_PX
    ) {
      hidden.push(index);
    }
  });
  return hidden;
}

interface VerticalSpan {
  top: number;
  bottom: number;
}

// A tab dragged this far above or below its strip leaves it; closer than that, the
// wobble of a sideways reorder stays a reorder.
export const SURFACE_TAB_DRAG_OUT_DISTANCE_PX = 16;

/** Whether a dragged tab's pointer has left the strip vertically, ending the reorder. */
export function isSurfaceTabDraggedOut(strip: VerticalSpan, pointerY: number): boolean {
  return (
    pointerY > strip.bottom + SURFACE_TAB_DRAG_OUT_DISTANCE_PX ||
    pointerY < strip.top - SURFACE_TAB_DRAG_OUT_DISTANCE_PX
  );
}
