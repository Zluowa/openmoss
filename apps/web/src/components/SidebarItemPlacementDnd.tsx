// FILE: SidebarItemPlacementDnd.tsx
// Purpose: Mixed project/thread placement boundary for the production sidebar.

import {
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import type { ReactNode } from "react";

import type { SidebarSectionItemKey } from "@synara/contracts";

export type SidebarItemPlacementDestination = "pinned" | "default" | "custom";

export interface SidebarItemPlacementRequest {
  readonly itemKey: SidebarSectionItemKey;
  readonly itemType: "thread" | "project";
  readonly destination: SidebarItemPlacementDestination;
  readonly sectionId: string | null;
  readonly sectionCreatedAt: string | null;
  readonly beforeItemKey: SidebarSectionItemKey | null;
}

export type SidebarItemPlacementHandler = (
  request: SidebarItemPlacementRequest,
) => void | boolean | Promise<void | boolean>;

export interface SidebarItemPlacementDragData {
  readonly type: "sidebar-item-placement-source";
  readonly itemKey: SidebarSectionItemKey;
  readonly itemType: "thread" | "project";
}

export interface SidebarItemPlacementTargetData {
  readonly type: "sidebar-item-placement-target";
  readonly destination: SidebarItemPlacementDestination;
  readonly sectionId: string | null;
  readonly sectionCreatedAt: string | null;
  readonly beforeItemKey: SidebarSectionItemKey | null;
}

const SOURCE_ID_PREFIX = "sidebar-item-placement-source:";
const TARGET_ID_PREFIX = "sidebar-item-placement-target:";

function targetContainerKey(element: HTMLElement): string {
  return element.dataset.placementContainer ?? "";
}

function placementTargets(): HTMLElement[] {
  if (typeof document === "undefined") return [];
  return Array.from(document.querySelectorAll<HTMLElement>("[data-sidebar-item-placement]")).filter(
    (element) => element.dataset.placementDisabled !== "true",
  );
}

function targetCenter(element: HTMLElement): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function sourceDragSize(source: HTMLElement): { readonly width: number; readonly height: number } {
  const handle = source.querySelector<HTMLElement>("[data-sidebar-item-placement-handle]");
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

export const sidebarItemPlacementKeyboardCoordinates: KeyboardCoordinateGetter = (
  event,
  { active, currentCoordinates },
) => {
  if (event.code !== "ArrowDown" && event.code !== "ArrowUp") return;
  const activeString = String(active);
  const itemKey = activeString.startsWith(SOURCE_ID_PREFIX)
    ? activeString.slice(SOURCE_ID_PREFIX.length)
    : `project:${activeString}`;
  const targets = placementTargets();
  const source = targets.find(
    (element) =>
      element.dataset.itemKey === itemKey || element.dataset.placementBeforeItemKey === itemKey,
  );
  if (!source) return;
  // KeyboardSensor keeps the active id fixed while its coordinates move. Use
  // the current target coordinates as the cursor so repeated Arrow presses can
  // traverse containers instead of restarting from the source container.
  const dragSize = sourceDragSize(source);
  const currentTarget = nearestPlacementTarget(targets, currentCoordinates, dragSize) ?? source;
  const container = targetContainerKey(currentTarget) || targetContainerKey(source);
  const visibleContainers = [...new Set(targets.map(targetContainerKey).filter(Boolean))];
  const containerTargets = targets.filter((target) => targetContainerKey(target) === container);
  const rowTargets = containerTargets.filter(
    (target) => target.dataset.itemKey || target.dataset.placementBeforeItemKey,
  );
  const sourceIndex = rowTargets.findIndex(
    (target) => (target.dataset.itemKey ?? target.dataset.placementBeforeItemKey) === itemKey,
  );
  const currentRowIndex = rowTargets.indexOf(currentTarget);
  const endTarget = targets.find(
    (target) =>
      targetContainerKey(target) === container && target.dataset.placementEndTarget === "true",
  );
  const step = event.code === "ArrowDown" ? 1 : -1;
  const target =
    currentTarget === source
      ? event.code === "ArrowDown"
        ? (rowTargets[sourceIndex + 2] ?? (rowTargets[sourceIndex + 1] ? endTarget : undefined))
        : rowTargets[sourceIndex - 1]
      : event.code === "ArrowDown"
        ? currentRowIndex >= 0
          ? (rowTargets[currentRowIndex + 1] ?? endTarget)
          : undefined
        : currentRowIndex >= 0
          ? rowTargets[currentRowIndex - 1]
          : rowTargets.at(-1);
  if (target) return targetCoordinates(target, dragSize);
  const containerIndex = visibleContainers.indexOf(container);
  const nextContainer = visibleContainers[containerIndex + step];
  if (!nextContainer) return currentCoordinates;
  const nextTargets = targets.filter(
    (candidate) => targetContainerKey(candidate) === nextContainer,
  );
  const nextTarget =
    event.code === "ArrowDown"
      ? (nextTargets.find(
          (candidate) => candidate.dataset.itemKey || candidate.dataset.placementBeforeItemKey,
        ) ?? nextTargets.find((candidate) => candidate.dataset.placementEndTarget === "true"))
      : (nextTargets.find((candidate) => candidate.dataset.placementEndTarget === "true") ??
        [...nextTargets]
          .reverse()
          .find(
            (candidate) => candidate.dataset.itemKey || candidate.dataset.placementBeforeItemKey,
          ));
  return nextTarget ? targetCoordinates(nextTarget, dragSize) : currentCoordinates;
};

export function sidebarItemPlacementAnnouncements() {
  return {
    onDragStart({ active }: DragStartEvent) {
      const data = active.data.current as SidebarItemPlacementDragData | undefined;
      return data?.type === "sidebar-item-placement-source"
        ? `Picked up sidebar ${data.itemType} ${data.itemKey}. Use ArrowUp or ArrowDown to choose a position.`
        : "Picked up sidebar item.";
    },
    onDragOver({ over }: DragOverEvent) {
      const data = over?.data.current as SidebarItemPlacementTargetData | undefined;
      if (!data || data.type !== "sidebar-item-placement-target") return "";
      return data.beforeItemKey
        ? `Sidebar item will be placed before ${data.beforeItemKey}.`
        : `Sidebar item will be placed at the end of the ${data.destination} container.`;
    },
    onDragEnd({ over }: DragEndEvent) {
      return over?.data.current &&
        (over.data.current as SidebarItemPlacementTargetData).type ===
          "sidebar-item-placement-target"
        ? "Sidebar placement committed."
        : "Sidebar placement cancelled.";
    },
    onDragCancel() {
      return "Sidebar placement cancelled.";
    },
  };
}

export function SidebarItemPlacementDnd(props: {
  readonly itemKey?: SidebarSectionItemKey | undefined;
  readonly itemType: "thread" | "project";
  readonly destination: SidebarItemPlacementDestination;
  readonly sectionId?: string | null | undefined;
  readonly sectionCreatedAt?: string | null | undefined;
  readonly beforeItemKey?: SidebarSectionItemKey | null | undefined;
  readonly disabled?: boolean | undefined;
  readonly inFlight?: boolean | undefined;
  readonly onPlace: SidebarItemPlacementHandler;
  readonly children: ReactNode;
}) {
  const {
    beforeItemKey = null,
    children,
    destination,
    disabled = false,
    inFlight = false,
    itemKey,
    itemType,
    sectionCreatedAt = null,
    sectionId = null,
  } = props;
  const targetBeforeItemKey = itemKey ?? beforeItemKey;
  const targetData: SidebarItemPlacementTargetData = {
    type: "sidebar-item-placement-target",
    destination,
    sectionId,
    sectionCreatedAt,
    beforeItemKey: targetBeforeItemKey,
  };
  const targetId = `${TARGET_ID_PREFIX}${destination}:${sectionId ?? ""}:${sectionCreatedAt ?? ""}:${targetBeforeItemKey ?? "end"}`;
  const { isOver, setNodeRef: setTargetNodeRef } = useDroppable({
    id: targetId,
    data: targetData,
    disabled,
  });
  const sourceData: SidebarItemPlacementDragData | undefined =
    itemKey === undefined
      ? undefined
      : { type: "sidebar-item-placement-source", itemKey, itemType };
  const draggableOptions = {
    id: `${SOURCE_ID_PREFIX}${itemKey ?? targetId}`,
    disabled: disabled || inFlight || itemKey === undefined,
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
      aria-label={itemKey === undefined ? `Drop ${itemType} in ${destination}` : `Move ${itemKey}`}
      aria-roledescription="sidebar item placement"
      data-sidebar-item-placement
      data-item-key={itemKey}
      data-placement-container={`${destination}:${sectionId ?? ""}:${sectionCreatedAt ?? ""}`}
      data-placement-before-item-key={targetBeforeItemKey ?? undefined}
      data-placement-end-target={targetBeforeItemKey === null ? "true" : undefined}
      data-placement-destination={destination}
      data-placement-target={isOver ? "true" : undefined}
      data-placement-dragging={isDragging ? "true" : undefined}
      data-placement-disabled={disabled || inFlight ? "true" : undefined}
    >
      {itemKey === undefined ? null : (
        <span
          ref={setSourceNodeRef}
          {...listeners}
          {...attributes}
          role="button"
          aria-label={`Reorder ${itemKey}`}
          aria-roledescription="sidebar item placement handle"
          data-sidebar-item-placement-handle
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
          ? targetBeforeItemKey === null
            ? `Drop ${itemType} in ${destination}`
            : `Drop ${itemType} before ${targetBeforeItemKey}`
          : ""}
      </span>
    </div>
  );
}
