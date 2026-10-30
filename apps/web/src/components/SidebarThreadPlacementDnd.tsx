// FILE: SidebarThreadPlacementDnd.tsx
// Purpose: Production pointer/keyboard placement boundary for sidebar threads.

import {
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import { type ReactNode } from "react";

import type { ThreadId } from "@synara/contracts";

/**
 * Kept as a public boundary marker for consumers that explicitly reject split
 * pane drags. Placement itself is dnd-kit state and never emits or consumes
 * this MIME type, so a native thread drag cannot be mistaken for a placement.
 */
export const SIDEBAR_THREAD_PLACEMENT_MIME = "application/x-moss-sidebar-placement";

export type SidebarThreadPlacementDestination = "pinned" | "default" | "custom";

export interface SidebarThreadPlacementRequest {
  readonly threadId: ThreadId;
  readonly destination: SidebarThreadPlacementDestination;
  readonly sectionId: string | null;
  readonly sectionCreatedAt: string | null;
  readonly beforeThreadId: ThreadId | null;
}

export type SidebarThreadPlacementHandler = (
  request: SidebarThreadPlacementRequest,
) => void | boolean | Promise<void | boolean>;

export interface SidebarThreadPlacementDragData {
  readonly type: "sidebar-thread-placement-source";
  readonly threadId: ThreadId;
}

export interface SidebarThreadPlacementTargetData {
  readonly type: "sidebar-thread-placement-target";
  readonly destination: SidebarThreadPlacementDestination;
  readonly sectionId: string | null;
  readonly sectionCreatedAt: string | null;
  readonly beforeThreadId: ThreadId | null;
}

const SOURCE_ID_PREFIX = "sidebar-thread-placement-source:";
const TARGET_ID_PREFIX = "sidebar-thread-placement-target:";

function targetContainerKey(element: HTMLElement): string {
  return element.dataset.placementContainer ?? "";
}

function placementTargets(): HTMLElement[] {
  if (typeof document === "undefined") return [];
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-sidebar-thread-placement]"),
  ).filter((element) => element.dataset.placementDisabled !== "true");
}

function targetCenter(element: HTMLElement): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function sourceDragSize(source: HTMLElement): { readonly width: number; readonly height: number } {
  const handle = source.querySelector<HTMLElement>("[data-sidebar-thread-placement-handle]");
  const rect = (handle ?? source).getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

function nearestPlacementTarget(
  targets: ReadonlyArray<HTMLElement>,
  coordinates: { readonly x: number; readonly y: number },
  dragSize: { readonly width: number; readonly height: number },
): HTMLElement | undefined {
  const dragCenter = {
    x: coordinates.x + dragSize.width / 2,
    y: coordinates.y + dragSize.height / 2,
  };
  let nearest: HTMLElement | undefined;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const target of targets) {
    const center = targetCenter(target);
    const distance = (center.x - dragCenter.x) ** 2 + (center.y - dragCenter.y) ** 2;
    if (distance < nearestDistance) {
      nearest = target;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function targetCoordinates(
  target: HTMLElement,
  dragSize: { readonly width: number; readonly height: number },
): { readonly x: number; readonly y: number } {
  const center = targetCenter(target);
  return { x: center.x - dragSize.width / 2, y: center.y - dragSize.height / 2 };
}

/**
 * Keyboard movement is anchor-based, not row-index based. ArrowDown from A
 * targets B (which means "before B"), and ArrowDown from the last row targets
 * that container's end sentinel. At a container boundary it traverses the
 * next/previous visible container, including empty and collapsed sentinels.
 */
export const sidebarThreadPlacementKeyboardCoordinates: KeyboardCoordinateGetter = (
  event,
  { active, currentCoordinates },
) => {
  if (event.code !== "ArrowDown" && event.code !== "ArrowUp") return;
  const activeString = String(active);
  const sourceId = activeString.startsWith(SOURCE_ID_PREFIX)
    ? activeString.slice(SOURCE_ID_PREFIX.length)
    : activeString;
  const targets = placementTargets();
  const source = targets.find((element) => element.dataset.threadId === sourceId);
  if (!source) return;
  // KeyboardSensor keeps the active id fixed while its coordinates move. Use
  // the current target coordinates as the cursor so repeated Arrow presses can
  // traverse containers instead of restarting from the source container.
  const dragSize = sourceDragSize(source);
  const currentTarget = nearestPlacementTarget(targets, currentCoordinates, dragSize) ?? source;
  const container = targetContainerKey(currentTarget) || targetContainerKey(source);
  const visibleContainers = [...new Set(targets.map(targetContainerKey).filter(Boolean))];
  const containerTargets = targets.filter((target) => targetContainerKey(target) === container);
  const rowTargets = containerTargets.filter((target) => target.dataset.threadId);
  const sameContainerEnd = targets.find(
    (target) =>
      targetContainerKey(target) === container && target.dataset.placementEndTarget === "true",
  );
  const sourceIndex = rowTargets.findIndex((target) => target.dataset.threadId === sourceId);
  const currentRowIndex = rowTargets.indexOf(currentTarget);
  const step = event.code === "ArrowDown" ? 1 : -1;
  const sameContainerTarget =
    currentTarget === source
      ? event.code === "ArrowDown"
        ? (rowTargets[sourceIndex + 2] ??
          (rowTargets[sourceIndex + 1] ? sameContainerEnd : undefined))
        : rowTargets[sourceIndex - 1]
      : event.code === "ArrowDown"
        ? currentRowIndex >= 0
          ? (rowTargets[currentRowIndex + 1] ?? sameContainerEnd)
          : undefined
        : currentRowIndex >= 0
          ? rowTargets[currentRowIndex - 1]
          : rowTargets.at(-1);
  if (sameContainerTarget) return targetCoordinates(sameContainerTarget, dragSize);

  const containerIndex = visibleContainers.indexOf(container);
  const nextContainer = visibleContainers[containerIndex + step];
  if (!nextContainer) return currentCoordinates;
  const nextTargets = targets.filter((target) => targetContainerKey(target) === nextContainer);
  const rowTarget =
    event.code === "ArrowDown"
      ? (nextTargets.find((target) => target.dataset.threadId) ??
        nextTargets.find((target) => target.dataset.placementEndTarget === "true"))
      : (nextTargets.find((target) => target.dataset.placementEndTarget === "true") ??
        [...nextTargets].reverse().find((target) => target.dataset.threadId));
  return rowTarget ? targetCoordinates(rowTarget, dragSize) : currentCoordinates;
};

export function sidebarThreadPlacementAnnouncements() {
  return {
    onDragStart({ active }: DragStartEvent) {
      const data = active.data.current as SidebarThreadPlacementDragData | undefined;
      return data?.type === "sidebar-thread-placement-source"
        ? `Picked up thread ${data.threadId}. Use ArrowUp or ArrowDown to choose a position.`
        : "Picked up sidebar item.";
    },
    onDragOver({ over }: DragOverEvent) {
      const data = over?.data.current as SidebarThreadPlacementTargetData | undefined;
      if (!data || data.type !== "sidebar-thread-placement-target") return "";
      return data.beforeThreadId
        ? `Thread will be placed before ${data.beforeThreadId}.`
        : `Thread will be placed at the end of the ${data.destination} container.`;
    },
    onDragEnd({ over }: DragEndEvent) {
      const data = over?.data.current as SidebarThreadPlacementTargetData | undefined;
      return data?.type === "sidebar-thread-placement-target"
        ? "Thread placement committed."
        : "Thread placement cancelled.";
    },
    onDragCancel() {
      return "Thread placement cancelled.";
    },
  };
}

export function SidebarThreadPlacementDnd(props: {
  /** Source identity for a draggable row; omitted for an empty drop target. */
  readonly threadId?: ThreadId | undefined;
  readonly destination: SidebarThreadPlacementDestination;
  readonly sectionId?: string | null | undefined;
  readonly sectionCreatedAt?: string | null | undefined;
  readonly beforeThreadId?: ThreadId | null | undefined;
  readonly previousThreadId?: ThreadId | null | undefined;
  readonly nextThreadId?: ThreadId | null | undefined;
  readonly disabled?: boolean | undefined;
  readonly inFlight?: boolean | undefined;
  readonly onPlace: SidebarThreadPlacementHandler;
  readonly children: ReactNode;
}) {
  const {
    beforeThreadId = null,
    children,
    destination,
    disabled = false,
    inFlight = false,
    sectionCreatedAt = null,
    sectionId = null,
    threadId,
  } = props;
  // Row wrappers are targets for "before this row". Older call sites pass the
  // next row as their keyboard successor, so a concrete source row always wins
  // as the authoritative anchor; empty/end sentinels keep null.
  const targetBeforeThreadId = threadId ?? beforeThreadId;
  const targetData: SidebarThreadPlacementTargetData = {
    type: "sidebar-thread-placement-target",
    destination,
    sectionId,
    sectionCreatedAt,
    beforeThreadId: targetBeforeThreadId,
  };
  const targetId = `${TARGET_ID_PREFIX}${destination}:${sectionId ?? ""}:${sectionCreatedAt ?? ""}:${targetBeforeThreadId ?? "end"}`;
  const { isOver, setNodeRef: setTargetNodeRef } = useDroppable({
    id: targetId,
    data: targetData,
    disabled,
  });
  const sourceData: SidebarThreadPlacementDragData | undefined =
    threadId === undefined ? undefined : { type: "sidebar-thread-placement-source", threadId };
  const draggableOptions = {
    id: `${SOURCE_ID_PREFIX}${threadId ?? targetId}`,
    disabled: disabled || inFlight || threadId === undefined,
    ...(sourceData === undefined ? {} : { data: sourceData }),
  };
  const {
    attributes,
    listeners,
    setNodeRef: setSourceNodeRef,
    isDragging,
  } = useDraggable(draggableOptions);
  return (
    <div
      ref={setTargetNodeRef}
      className="relative"
      role="listitem"
      aria-label={threadId === undefined ? `Drop thread in ${destination}` : `Move ${threadId}`}
      aria-roledescription="sidebar thread placement"
      data-sidebar-thread-placement
      data-thread-id={threadId}
      data-placement-container={`${destination}:${sectionId ?? ""}:${sectionCreatedAt ?? ""}`}
      data-placement-before-thread-id={targetBeforeThreadId ?? undefined}
      data-placement-end-target={targetBeforeThreadId === null ? "true" : undefined}
      data-placement-destination={destination}
      data-placement-target={isOver ? "true" : undefined}
      data-placement-dragging={isDragging ? "true" : undefined}
      data-placement-disabled={disabled || inFlight ? "true" : undefined}
    >
      {threadId === undefined ? null : (
        <span
          ref={setSourceNodeRef}
          {...listeners}
          {...attributes}
          role="button"
          aria-label={`Reorder ${threadId}`}
          aria-roledescription="sidebar thread placement handle"
          data-sidebar-thread-placement-handle
          className="absolute inset-y-0 left-0 z-10 w-1 cursor-grab active:cursor-grabbing"
        />
      )}
      <span
        aria-hidden="true"
        data-placement-indicator
        className={
          isOver ? "pointer-events-none absolute inset-x-0 -top-px h-0.5 bg-primary" : "hidden"
        }
      />
      {children}
      <span className="sr-only" aria-live="polite">
        {isOver
          ? threadId === undefined
            ? `Drop thread in ${destination}`
            : `Drop thread before ${threadId} in ${destination}`
          : ""}
      </span>
    </div>
  );
}
