// FILE: ThreadTabDragOverlay.tsx
// Purpose: While a tab is dragged out of the open-thread strip, covers the window (so a
//          browser pane's iframe or webview cannot swallow the pointer) and carries a lifted
//          copy of the tab under the pointer. The split preview itself is the target pane's
//          own drop-zone overlay, the same one a dragged sidebar thread lights up.
// Layer: Chat surface UI
// Depends on: the tab-drag state in chatPaneDropTargets.

import { createPortal } from "react-dom";

import { cn } from "../../lib/utils";
import { useThreadTabDragState } from "./chatPaneDropTargets";

// Where the pointer holds the copy: near its leading edge, like the grip on the real tab.
const GHOST_POINTER_OFFSET = { x: 24, y: 14 };

export function ThreadTabDragOverlay(props: { ownerId: string }) {
  const state = useThreadTabDragState();
  if (!state || state.ownerId !== props.ownerId) return null;
  return createPortal(
    <div
      data-thread-tab-drag-overlay=""
      aria-hidden
      className={cn(
        "fixed inset-0 z-[90] select-none",
        state.zone ? "cursor-grabbing" : "cursor-no-drop",
      )}
    >
      <div
        className="pointer-events-none absolute top-0 left-0 flex h-7 max-w-64 items-center gap-2 rounded-control border border-border bg-popover px-2.5 text-ui-sm text-foreground shadow-lg"
        style={{
          transform: `translate(${state.point.x - GHOST_POINTER_OFFSET.x}px, ${
            state.point.y - GHOST_POINTER_OFFSET.y
          }px) rotate(-2deg)`,
        }}
      >
        <span className="flex size-4 shrink-0 items-center justify-center">{state.ghost.icon}</span>
        <span className="min-w-0 truncate">{state.ghost.title}</span>
      </div>
    </div>,
    document.body,
  );
}
