import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clampSidebarFloatPosition,
  isSidebarTearOffDrag,
  resolveSidebarFloatDrop,
  SIDEBAR_FLOAT_DOCK_SNAP_X_PX,
  useSidebarFloatStore,
} from "./sidebarFloatStore";

function installLocalStorageStub(): void {
  const backing = new Map<string, string>();
  const localStorageStub = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, String(value)),
    removeItem: (key: string) => void backing.delete(key),
    clear: () => backing.clear(),
  };
  // The store guards on `typeof window`; give the node runtime a minimal one.
  vi.stubGlobal("window", { localStorage: localStorageStub });
  vi.stubGlobal("localStorage", localStorageStub);
}

describe("sidebarFloatStore", () => {
  beforeEach(() => {
    installLocalStorageStub();
    window.localStorage.clear();
    useSidebarFloatStore.setState({
      mode: "docked",
      position: { x: 76, y: 96 },
    });
  });

  it("floats at the given position and persists", () => {
    useSidebarFloatStore.getState().floatAt({ x: 140, y: 130 });
    const state = useSidebarFloatStore.getState();
    expect(state.mode).toBe("floating");
    expect(state.position).toEqual({ x: 140, y: 130 });
    const persisted = JSON.parse(window.localStorage.getItem("moss:sidebar-float:v1") ?? "{}");
    expect(persisted).toEqual({ mode: "floating", position: { x: 140, y: 130 } });
  });

  it("keeps the last position when floating without one", () => {
    useSidebarFloatStore.getState().setPosition({ x: 220, y: 180 });
    useSidebarFloatStore.getState().floatAt();
    expect(useSidebarFloatStore.getState().position).toEqual({ x: 220, y: 180 });
  });

  it("docks while keeping the position for the next float", () => {
    useSidebarFloatStore.getState().floatAt({ x: 300, y: 200 });
    useSidebarFloatStore.getState().dock();
    const state = useSidebarFloatStore.getState();
    expect(state.mode).toBe("docked");
    expect(state.position).toEqual({ x: 300, y: 200 });
    expect(JSON.parse(window.localStorage.getItem("moss:sidebar-float:v1") ?? "{}").mode).toBe(
      "docked",
    );
  });
});

describe("clampSidebarFloatPosition", () => {
  const bounds = { viewportWidth: 1200, viewportHeight: 800, panelWidth: 288 };

  it("keeps the panel inside the viewport", () => {
    expect(clampSidebarFloatPosition({ x: 2000, y: -40 }, bounds)).toEqual({
      x: 1200 - 288 - 8,
      y: 8,
    });
  });

  it("leaves valid positions untouched", () => {
    expect(clampSidebarFloatPosition({ x: 140, y: 130 }, bounds)).toEqual({ x: 140, y: 130 });
  });
});

describe("resolveSidebarFloatDrop", () => {
  it("docks at or within the snap threshold and floats beyond it", () => {
    expect(resolveSidebarFloatDrop(SIDEBAR_FLOAT_DOCK_SNAP_X_PX)).toBe("docked");
    expect(resolveSidebarFloatDrop(SIDEBAR_FLOAT_DOCK_SNAP_X_PX + 1)).toBe("floating");
  });
});

describe("isSidebarTearOffDrag", () => {
  it("requires a vertical-dominant pull", () => {
    expect(isSidebarTearOffDrag(2, 60)).toBe(true);
    expect(isSidebarTearOffDrag(40, 60)).toBe(false);
    expect(isSidebarTearOffDrag(2, 30)).toBe(false);
    expect(isSidebarTearOffDrag(2, -60)).toBe(false);
  });
});
