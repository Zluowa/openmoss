// FILE: spaceDragState.ts
// Purpose: Shared drag payload helpers for moving one or more 资料空间 items into folders
//          across SpaceHome, SpaceFolderCard, and SpaceSidebar.
// Layer: Space UI helper

export const SPACE_ITEMS_DRAG_MIME = "application/x-moss-space-items";

let activeDragKeys: readonly string[] = [];

export function getActiveSpaceDragKeys(): readonly string[] {
  return activeDragKeys;
}

export function setActiveSpaceDragKeys(keys: readonly string[]): void {
  activeDragKeys = [...new Set(keys)];
}

export function clearActiveSpaceDragKeys(): void {
  activeDragKeys = [];
}

/** Checks whether a dragover/drop event carries Space item keys. */
export function hasSpaceItemDrag(dataTransfer: DataTransfer | null): boolean {
  if (activeDragKeys.length > 0) return true;
  if (!dataTransfer) return false;
  return [...dataTransfer.types].includes(SPACE_ITEMS_DRAG_MIME);
}

/** Extracts dragged item keys from DataTransfer, falling back to module state for synthetic DnD. */
export function readDraggedSpaceKeys(dataTransfer: DataTransfer | null): string[] {
  const raw = dataTransfer?.getData(SPACE_ITEMS_DRAG_MIME);
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const keys = parsed.filter((entry): entry is string => typeof entry === "string");
        if (keys.length > 0) return [...new Set(keys)];
      }
    } catch {
      // Fall back to module state below.
    }
  }
  return [...activeDragKeys];
}
