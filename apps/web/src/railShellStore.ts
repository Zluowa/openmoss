// FILE: railShellStore.ts
// Purpose: Per-window state for the rail layout: the active rail item, which panel the
//          panel column shows (Home, or a project pinned to the rail), and that project.
// Layer: Web UI store (sessionStorage)

import type { ProjectId } from "@moss/contracts";
import { create } from "zustand";

import {
  RAIL_PANEL_ITEM_IDS,
  reconcileActiveRailItem,
  type RailItemId,
  type RailPanelItemId,
} from "./appRail.logic";

const STORAGE_KEY = "moss:rail-shell:v1";

interface PersistedRailShellState {
  activeItem: RailItemId;
  panelView: RailPanelItemId;
  railProjectId: ProjectId | null;
}

const DEFAULT_RAIL_SHELL_STATE: PersistedRailShellState = {
  activeItem: "home",
  panelView: "home",
  railProjectId: null,
};

function isRailPanelItemId(value: unknown): value is RailPanelItemId {
  return (RAIL_PANEL_ITEM_IDS as ReadonlyArray<unknown>).includes(value);
}

/**
 * The saved session state, or the default. A panel this build no longer has (the removed
 * Spaces panel, saved as "spaces") reads as Home.
 */
export function parsePersistedRailShellState(raw: string | null): PersistedRailShellState {
  try {
    const parsed = JSON.parse(raw ?? "null") as Partial<PersistedRailShellState> | null;
    const panelView = isRailPanelItemId(parsed?.panelView) ? parsed.panelView : "home";
    return {
      // The active item is re-derived from the route on mount (reconcile), so only a
      // valid panel item is worth restoring here.
      activeItem: panelView,
      panelView,
      railProjectId:
        typeof parsed?.railProjectId === "string" ? (parsed.railProjectId as ProjectId) : null,
    };
  } catch {
    return DEFAULT_RAIL_SHELL_STATE;
  }
}

function readPersisted(): PersistedRailShellState {
  if (typeof window === "undefined") {
    return DEFAULT_RAIL_SHELL_STATE;
  }
  try {
    return parsePersistedRailShellState(window.sessionStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_RAIL_SHELL_STATE;
  }
}

function persist(state: PersistedRailShellState): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        activeItem: state.activeItem,
        panelView: state.panelView,
        railProjectId: state.railProjectId,
      }),
    );
  } catch {
    // A blocked storage API must not make the rail unusable.
  }
}

interface RailShellState extends PersistedRailShellState {
  /** Explicit rail selections retire pending handoffs; route reconciliation does not. */
  selectionVersion: number;
  /** Route of the last reconcile; the active item re-syncs only when it changes. */
  reconciledRouteKey: string | null;
  selectPanelItem: (id: RailPanelItemId) => void;
  /** Route items and the Moss surface items (Images/Library) share the active slot. */
  selectRouteItem: (id: Exclude<RailItemId, RailPanelItemId>) => void;
  openRailProject: (projectId: ProjectId) => void;
  closeRailProject: () => void;
  /** `projectIds: null` means the project list is not hydrated yet, so the drill-in is kept. */
  reconcile: (input: {
    pathname: string;
    onMossbotSurface?: boolean;
    projectIds: ReadonlySet<ProjectId> | null;
  }) => void;
}

export const useRailShellStore = create<RailShellState>((set, get) => ({
  ...readPersisted(),
  selectionVersion: 0,
  reconciledRouteKey: null,
  selectPanelItem: (id) => {
    set((state) => ({
      activeItem: id,
      panelView: id,
      selectionVersion: state.selectionVersion + 1,
    }));
    persist(get());
  },
  selectRouteItem: (id) => {
    set((state) => ({ activeItem: id, selectionVersion: state.selectionVersion + 1 }));
    persist(get());
  },
  openRailProject: (projectId) => {
    set({ railProjectId: projectId });
    persist(get());
  },
  closeRailProject: () => {
    set({ railProjectId: null });
    persist(get());
  },
  reconcile: ({ pathname, onMossbotSurface = false, projectIds }) => {
    const current = get();
    // A clicked panel item stays active on a route item's route (a pinned project while on Pull
    // requests); only a navigation re-syncs it.
    const routeKey = onMossbotSurface ? `mossbot:${pathname}` : pathname;
    const activeItem =
      routeKey === current.reconciledRouteKey
        ? current.activeItem
        : reconcileActiveRailItem({
            current: current.activeItem,
            pathname,
            onMossbotSurface,
            panelView: current.panelView,
          });
    const railProjectId =
      current.railProjectId !== null &&
      projectIds !== null &&
      !projectIds.has(current.railProjectId)
        ? null
        : current.railProjectId;
    if (
      activeItem === current.activeItem &&
      railProjectId === current.railProjectId &&
      routeKey === current.reconciledRouteKey
    ) {
      return;
    }
    set({ activeItem, railProjectId, reconciledRouteKey: routeKey });
    persist(get());
  },
}));
