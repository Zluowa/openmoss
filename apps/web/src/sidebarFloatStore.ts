// FILE: sidebarFloatStore.ts
// Purpose: Docked/floating state for the conversation sidebar (tear-off glass panel).
// Layer: Web client state
// Depends on: zustand, localStorage persistence.

import { create } from "zustand";

export type SidebarFloatMode = "docked" | "floating";

export type SidebarFloatPosition = {
  readonly x: number;
  readonly y: number;
};

/** A drop this close to the window's left edge snaps the panel back into the dock. */
export const SIDEBAR_FLOAT_DOCK_SNAP_X_PX = 76;
/** Minimum visible margin kept around the floating panel while dragging. */
export const SIDEBAR_FLOAT_EDGE_MARGIN_PX = 8;
/** Vertical pull distance on the resize seam that tears the sidebar out. */
export const SIDEBAR_FLOAT_TEAR_OFF_DY_PX = 48;
/** Direction-classification slack before a seam drag counts as vertical. */
export const SIDEBAR_FLOAT_TEAR_OFF_DX_PX = 24;

const STORAGE_KEY = "moss:sidebar-float:v1";
const DEFAULT_POSITION: SidebarFloatPosition = { x: 76, y: 96 };

export type SidebarFloatState = {
  readonly mode: SidebarFloatMode;
  readonly position: SidebarFloatPosition;
  readonly floatAt: (position?: SidebarFloatPosition) => void;
  readonly dock: () => void;
  readonly setPosition: (position: SidebarFloatPosition) => void;
};

function readPersistedState(): Pick<SidebarFloatState, "mode" | "position"> {
  if (typeof window === "undefined") {
    return { mode: "docked", position: DEFAULT_POSITION };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { mode: "docked", position: DEFAULT_POSITION };
    const parsed = JSON.parse(raw) as Partial<{ mode: unknown; position: unknown }>;
    const position = parsed.position;
    const validPosition =
      typeof position === "object" &&
      position !== null &&
      typeof (position as { x?: unknown }).x === "number" &&
      typeof (position as { y?: unknown }).y === "number" &&
      Number.isFinite((position as { x: number }).x) &&
      Number.isFinite((position as { y: number }).y)
        ? { x: (position as { x: number }).x, y: (position as { y: number }).y }
        : DEFAULT_POSITION;
    return {
      mode: parsed.mode === "floating" ? "floating" : "docked",
      position: validPosition,
    };
  } catch {
    return { mode: "docked", position: DEFAULT_POSITION };
  }
}

function persist(state: Pick<SidebarFloatState, "mode" | "position">): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Persistence is best-effort; the panel keeps working without it.
  }
}

export const useSidebarFloatStore = create<SidebarFloatState>((set, get) => ({
  ...readPersistedState(),
  floatAt: (position) =>
    set(() => {
      const next = {
        mode: "floating" as const,
        position: position ?? get().position ?? DEFAULT_POSITION,
      };
      persist(next);
      return next;
    }),
  dock: () =>
    set((current) => {
      const next = { mode: "docked" as const, position: current.position };
      persist(next);
      return next;
    }),
  setPosition: (position) =>
    set((current) => {
      const next = { mode: current.mode, position };
      persist(next);
      return next;
    }),
}));

/** Keep the whole panel reachable: never past the right/bottom edge, never under the top bar. */
export function clampSidebarFloatPosition(
  position: SidebarFloatPosition,
  bounds: {
    readonly viewportWidth: number;
    readonly viewportHeight: number;
    readonly panelWidth: number;
  },
): SidebarFloatPosition {
  const maxX = Math.max(
    SIDEBAR_FLOAT_EDGE_MARGIN_PX,
    bounds.viewportWidth - bounds.panelWidth - SIDEBAR_FLOAT_EDGE_MARGIN_PX,
  );
  const maxY = Math.max(SIDEBAR_FLOAT_EDGE_MARGIN_PX, bounds.viewportHeight - 120);
  return {
    x: Math.min(Math.max(position.x, SIDEBAR_FLOAT_EDGE_MARGIN_PX), maxX),
    y: Math.min(Math.max(position.y, SIDEBAR_FLOAT_EDGE_MARGIN_PX), maxY),
  };
}

/** Where a released panel ends up based on its left edge. */
export function resolveSidebarFloatDrop(leftEdgeX: number): SidebarFloatMode {
  return leftEdgeX <= SIDEBAR_FLOAT_DOCK_SNAP_X_PX ? "docked" : "floating";
}

/** Direction classification for a seam drag: vertical-dominant pulls tear the panel out. */
export function isSidebarTearOffDrag(dx: number, dy: number): boolean {
  return dy >= SIDEBAR_FLOAT_TEAR_OFF_DY_PX && Math.abs(dx) <= SIDEBAR_FLOAT_TEAR_OFF_DX_PX;
}
