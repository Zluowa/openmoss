// FILE: chatPaneDropTargets.ts
// Purpose: Lets a pointer drag that is not a native drag (a tab pulled out of the open-thread
//          strip) split a chat pane exactly as a dropped sidebar thread does. Every mounted
//          ChatPaneDropOverlay registers here; the drag hit-tests the registered panes and
//          drives their own drop-zone preview, so both kinds of drag look and behave the same.
// Layer: UI helpers (module state, no React)
// Exports: registerChatPaneDropTarget, the tab-drag lifecycle (move/clear/drop/cancel) and
//          its subscription hook, and the pure target resolver used by tests.

import { type ReactNode, useSyncExternalStore } from "react";

import { type SplitDirection, type SplitDropSide } from "../../splitViewStore";
import { type ThreadDragPayload } from "../../lib/threadDrag";
import { type DropZone } from "./ChatPaneDropOverlay";

export interface ChatPaneDropPoint {
  x: number;
  y: number;
}

export interface ChatPaneDropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** What a chat pane offers a pointer drag. The overlay implements it from its own props. */
export interface ChatPaneDropTarget {
  getRect(): ChatPaneDropRect;
  /** The zone this drag would split toward at the point, or null when the pane refuses it. */
  resolveZone(point: ChatPaneDropPoint, payload: ThreadDragPayload): DropZone | null;
  /** Shows (or with null hides) the pane's own drop-zone preview. */
  showZone(zone: DropZone | null): void;
  drop(payload: ThreadDragPayload & { direction: SplitDirection; side: SplitDropSide }): void;
}

const targets = new Set<ChatPaneDropTarget>();

export function registerChatPaneDropTarget(target: ChatPaneDropTarget): () => void {
  targets.add(target);
  return () => {
    targets.delete(target);
    if (activeTarget === target) activeTarget = null;
  };
}

function rectContains(rect: ChatPaneDropRect, point: ChatPaneDropPoint): boolean {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    point.x >= rect.left &&
    point.x <= rect.left + rect.width &&
    point.y >= rect.top &&
    point.y <= rect.top + rect.height
  );
}

/**
 * The pane under the point. Panes can nest (a kept-alive chat inside a split pane), so the
 * innermost one (the smallest containing rect) wins.
 */
export function resolveChatPaneDropTargetAt<Target>(
  candidates: Iterable<{ target: Target; rect: ChatPaneDropRect }>,
  point: ChatPaneDropPoint,
): Target | null {
  let best: { target: Target; area: number } | null = null;
  for (const candidate of candidates) {
    if (!rectContains(candidate.rect, point)) continue;
    const area = candidate.rect.width * candidate.rect.height;
    if (!best || area < best.area) best = { target: candidate.target, area };
  }
  return best?.target ?? null;
}

export function dropZoneToDirectionSide(zone: DropZone): {
  direction: SplitDirection;
  side: SplitDropSide;
} {
  if (zone === "top") return { direction: "vertical", side: "first" };
  if (zone === "bottom") return { direction: "vertical", side: "second" };
  if (zone === "left") return { direction: "horizontal", side: "first" };
  return { direction: "horizontal", side: "second" };
}

/** What the dragged tab looks like under the pointer. */
export interface ThreadTabDragGhost {
  title: string;
  icon: ReactNode;
}

export interface ThreadTabDragState {
  /** Which strip started the drag, so only that strip draws the ghost. */
  ownerId: string;
  payload: ThreadDragPayload;
  ghost: ThreadTabDragGhost;
  point: ChatPaneDropPoint;
  zone: DropZone | null;
}

let dragState: ThreadTabDragState | null = null;
// The pane showing a preview right now; kept out of the rendered state.
let activeTarget: ChatPaneDropTarget | null = null;
const listeners = new Set<() => void>();

function setDragState(next: ThreadTabDragState | null) {
  if (dragState === next) return;
  dragState = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useThreadTabDragState(): ThreadTabDragState | null {
  return useSyncExternalStore(
    subscribe,
    () => dragState,
    () => null,
  );
}

function setActiveTarget(target: ChatPaneDropTarget | null, zone: DropZone | null) {
  if (activeTarget && activeTarget !== target) activeTarget.showZone(null);
  activeTarget = target;
  target?.showZone(zone);
}

/** Follows a tab dragged out of its strip: previews the split under the pointer, if any. */
export function moveThreadTabDrag(input: {
  ownerId: string;
  payload: ThreadDragPayload;
  ghost: ThreadTabDragGhost;
  point: ChatPaneDropPoint;
}): void {
  const target = resolveChatPaneDropTargetAt(
    Array.from(targets, (candidate) => ({ target: candidate, rect: candidate.getRect() })),
    input.point,
  );
  const zone = target?.resolveZone(input.point, input.payload) ?? null;
  setActiveTarget(zone ? target : null, zone);
  const previous = dragState;
  if (
    previous &&
    previous.ownerId === input.ownerId &&
    previous.payload.threadId === input.payload.threadId &&
    previous.point.x === input.point.x &&
    previous.point.y === input.point.y &&
    previous.zone === zone
  ) {
    return;
  }
  setDragState({ ...input, zone });
}

/** The tab came back into its strip: reordering takes over again. */
export function clearThreadTabDrag(): void {
  setActiveTarget(null, null);
  setDragState(null);
}

/** Releases the tab over the previewed split. Returns true when a pane took it. */
export function dropThreadTabDrag(): boolean {
  const current = dragState;
  const target = activeTarget;
  clearThreadTabDrag();
  if (!current?.zone || !target) return false;
  target.drop({ ...current.payload, ...dropZoneToDirectionSide(current.zone) });
  return true;
}

export const cancelThreadTabDrag = clearThreadTabDrag;
