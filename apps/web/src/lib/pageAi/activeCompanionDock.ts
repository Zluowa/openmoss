// FILE: activeCompanionDock.ts
// Purpose: External store publishing the currently active standalone Space/App companion dock
//          so ThreadSidebar and SpaceSidebar can reflect companion state without coupling.
// Layer: Web lib (page AI)
// Exports: publishActiveCompanionDock, getActiveCompanionDockSnapshot,
//          useActiveCompanionDock, resetActiveCompanionDockForTests

import type { ThreadId } from "@moss/contracts";
import { useSyncExternalStore } from "react";

import type {
  SpaceArtifactKind,
  SpaceCanvasDockState,
  SpaceCanvasFloatingLauncherMode,
} from "~/components/space/spaceCanvasDockContract";

export interface ActiveCompanionDockState {
  readonly artifactKind: SpaceArtifactKind;
  readonly itemId: string;
  readonly artifactKey: string;
  readonly threadId: ThreadId | null;
  readonly dockState: SpaceCanvasDockState;
  readonly launcherMode: SpaceCanvasFloatingLauncherMode;
  readonly busy: boolean;
  readonly hasUnread: boolean;
}

const hosts = new Map<symbol, ActiveCompanionDockState>();
const listeners = new Set<() => void>();
let currentSnapshot: ActiveCompanionDockState | null = null;

function statesEqual(
  left: ActiveCompanionDockState | null,
  right: ActiveCompanionDockState | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.artifactKind === right.artifactKind &&
    left.itemId === right.itemId &&
    left.artifactKey === right.artifactKey &&
    left.threadId === right.threadId &&
    left.dockState === right.dockState &&
    left.launcherMode === right.launcherMode &&
    left.busy === right.busy &&
    left.hasUnread === right.hasUnread
  );
}

function recomputeSnapshot() {
  let latest: ActiveCompanionDockState | null = null;
  for (const value of hosts.values()) {
    latest = value;
  }
  if (statesEqual(currentSnapshot, latest)) return;
  currentSnapshot = latest;
  for (const listener of listeners) listener();
}

export function publishActiveCompanionDock(
  hostId: symbol,
  state: ActiveCompanionDockState | null,
): void {
  const existing = hosts.get(hostId) ?? null;
  if (state === null) {
    if (!hosts.has(hostId)) return;
    hosts.delete(hostId);
    recomputeSnapshot();
    return;
  }
  if (statesEqual(existing, state)) return;
  hosts.set(hostId, state);
  recomputeSnapshot();
}

export function getActiveCompanionDockSnapshot(): ActiveCompanionDockState | null {
  return currentSnapshot;
}

export function subscribeActiveCompanionDock(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useActiveCompanionDock(): ActiveCompanionDockState | null {
  return useSyncExternalStore(
    subscribeActiveCompanionDock,
    getActiveCompanionDockSnapshot,
    getActiveCompanionDockSnapshot,
  );
}

export function resetActiveCompanionDockForTests(): void {
  hosts.clear();
  currentSnapshot = null;
  for (const listener of listeners) listener();
}
