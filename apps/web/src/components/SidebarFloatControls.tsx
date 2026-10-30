// FILE: SidebarFloatControls.tsx
// Purpose: Tear-off/dock interactions for the floating conversation sidebar — the top grip
//          that drags the glass panel (drop near the left edge snaps back into the dock) and
//          the seam zone where a vertical pull tears the docked sidebar out.
// Layer: Web shell interaction
// Depends on: sidebarFloatStore, shared motion tokens.

import {
  useCallback,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import {
  clampSidebarFloatPosition,
  isSidebarTearOffDrag,
  resolveSidebarFloatDrop,
  useSidebarFloatStore,
} from "~/sidebarFloatStore";

function setDraggingFlag(active: boolean): void {
  if (active) {
    document.documentElement.dataset.mossSidebarFloatDragging = "true";
  } else {
    delete document.documentElement.dataset.mossSidebarFloatDragging;
  }
}

function currentSidebarWidth(): number {
  const gap = document.querySelector<HTMLElement>("[data-slot='sidebar-gap']");
  const measured = gap?.getBoundingClientRect().width;
  return measured && measured > 0 ? measured : 288;
}

function clampToViewport(position: { x: number; y: number }, panelWidth: number) {
  return clampSidebarFloatPosition(position, {
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    panelWidth,
  });
}

/** Slim grab strip rendered at the top edge of the floating panel. */
export function SidebarFloatGrip() {
  const setPosition = useSidebarFloatStore((state) => state.setPosition);
  const dock = useSidebarFloatStore((state) => state.dock);
  const dragRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startX: number;
    startY: number;
    panelWidth: number;
    lastX: number;
  } | null>(null);

  const finishDrag = useCallback(
    (commit: boolean) => {
      const drag = dragRef.current;
      dragRef.current = null;
      setDraggingFlag(false);
      if (!drag || !commit) return;
      if (resolveSidebarFloatDrop(drag.lastX) === "docked") {
        dock();
      }
    },
    [dock],
  );

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const { position } = useSidebarFloatStore.getState();
    const panelWidth = currentSidebarWidth();
    dragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: position.x,
      startY: position.y,
      panelWidth,
      lastX: position.x,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraggingFlag(true);
    event.preventDefault();
  }, []);

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      const next = clampToViewport(
        {
          x: drag.startX + (event.clientX - drag.startClientX),
          y: drag.startY + (event.clientY - drag.startClientY),
        },
        drag.panelWidth,
      );
      drag.lastX = next.x;
      setPosition(next);
    },
    [setPosition],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (dragRef.current?.pointerId !== event.pointerId) return;
      finishDrag(true);
    },
    [finishDrag],
  );

  const onPointerCancel = useCallback(() => finishDrag(false), [finishDrag]);

  return (
    <div
      aria-label="拖动悬浮侧栏，双击吸附回去"
      className="moss-sidebar-float-grip"
      data-moss-sidebar-float-grip
      role="separator"
      title="拖动移动 · 双击吸附 · 靠左放下吸附"
      onDoubleClick={() => dock()}
      onPointerCancel={onPointerCancel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  );
}

/**
 * Wraps the resize seam: a vertical-dominant pull tears the docked sidebar into the
 * floating panel and hands the same drag over to it. Horizontal drags fall through to
 * the normal resize handler untouched.
 */
export function SidebarTearOffZone({ children }: { readonly children: ReactNode }) {
  const floatAt = useSidebarFloatStore((state) => state.floatAt);
  const setPosition = useSidebarFloatStore((state) => state.setPosition);
  const dock = useSidebarFloatStore((state) => state.dock);
  const trackRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    tornOff: boolean;
    panelWidth: number;
    lastX: number;
  } | null>(null);

  const stopTracking = useCallback(() => {
    const track = trackRef.current;
    trackRef.current = null;
    setDraggingFlag(false);
    if (!track?.tornOff) return;
    if (resolveSidebarFloatDrop(track.lastX) === "docked") {
      dock();
    }
  }, [dock]);

  useEffect(() => {
    const onUp = () => stopTracking();
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [stopTracking]);

  const onPointerMoveCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const track = trackRef.current;
      if (!track || event.pointerId !== track.pointerId) return;
      const dx = event.clientX - track.startX;
      const dy = event.clientY - track.startY;
      if (!track.tornOff) {
        if (!isSidebarTearOffDrag(dx, dy)) return;
        track.tornOff = true;
        floatAt(
          clampToViewport(
            { x: event.clientX - track.panelWidth / 2, y: event.clientY - 28 },
            track.panelWidth,
          ),
        );
        setDraggingFlag(true);
      }
      const next = clampToViewport(
        { x: event.clientX - track.panelWidth / 2, y: event.clientY - 28 },
        track.panelWidth,
      );
      track.lastX = next.x;
      setPosition(next);
    },
    [floatAt, setPosition],
  );

  const onPointerDownCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    trackRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      tornOff: false,
      panelWidth: currentSidebarWidth(),
      lastX: Number.POSITIVE_INFINITY,
    };
  }, []);

  return (
    <div
      className="contents"
      onPointerDownCapture={onPointerDownCapture}
      onPointerMoveCapture={onPointerMoveCapture}
    >
      {children}
    </div>
  );
}
