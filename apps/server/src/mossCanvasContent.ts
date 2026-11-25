// FILE: mossCanvasContent.ts
// Purpose: Whether a Canvas storage write saves a 画布 with content (at least one shape).
// Layer: Pure helper, no server services: the storage route (via mossCanvasEdited.ts) and the
//        page-editor browser test server both read it (WALK-7 N7-1).

const PROJECT_WRITE_METHODS = new Set(["projects.write", "projects.create"]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** True when a Canvas project snapshot (editor or store snapshot) holds at least one shape. */
export function canvasSnapshotHasShapes(snapshot: unknown): boolean {
  const value = record(snapshot);
  const store = record(record(value?.document)?.store ?? value?.store);
  if (!store) return false;
  return Object.values(store).some((entry) => record(entry)?.typeName === "shape");
}

/** True for a storage request that saves a conversation 画布 with content. */
export function isCanvasContentWrite(method: unknown, input: Record<string, unknown>): boolean {
  return (
    typeof method === "string" &&
    PROJECT_WRITE_METHODS.has(method) &&
    canvasSnapshotHasShapes(input.snapshot)
  );
}
