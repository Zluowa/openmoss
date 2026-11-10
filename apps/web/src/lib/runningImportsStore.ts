// FILE: runningImportsStore.ts
// Purpose: Tracks imports that are copying conversations right now, so a desktop quit can
//          say that one is running instead of cutting it off silently.
// Layer: Web UI state

import { useEffect, useId } from "react";
import { create } from "zustand";

interface RunningImportsState {
  /** Label per running import, keyed by the surface that runs it. */
  readonly importsById: Readonly<Record<string, string>>;
  readonly setRunning: (id: string, label: string) => void;
  readonly clear: (id: string) => void;
}

export const useRunningImportsStore = create<RunningImportsState>((set) => ({
  importsById: {},
  setRunning: (id, label) =>
    set((state) =>
      state.importsById[id] === label
        ? state
        : { importsById: { ...state.importsById, [id]: label } },
    ),
  clear: (id) =>
    set((state) => {
      if (!(id in state.importsById)) return state;
      const next = { ...state.importsById };
      delete next[id];
      return { importsById: next };
    }),
}));

export function listRunningImports(
  importsById: Readonly<Record<string, string>>,
): ReadonlyArray<{ readonly id: string; readonly label: string }> {
  return Object.entries(importsById).map(([id, label]) => ({ id, label }));
}

/** Registers this surface's import while `active` is true; unmounting clears it. */
export function useReportRunningImport(active: boolean, label: string): void {
  const id = useId();
  useEffect(() => {
    if (!active) return;
    useRunningImportsStore.getState().setRunning(id, label);
    return () => useRunningImportsStore.getState().clear(id);
  }, [active, id, label]);
}
