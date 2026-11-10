// Adapted from OpenMaus src/lib/folder-order.ts @ 58378e8 (Apache-2.0).
// See third_party/openmaus/UI-PORTS.md. Drag transport is owned by the host.
export function placeFolder(
  ids: readonly string[],
  from: string,
  target: string,
  place: "before" | "after",
): string[] {
  if (from === target || !ids.includes(from) || !ids.includes(target)) return [...ids];
  const next = ids.filter((id) => id !== from);
  next.splice(next.indexOf(target) + (place === "after" ? 1 : 0), 0, from);
  return next;
}

export function moveFolder(ids: readonly string[], id: string, direction: -1 | 1): string[] {
  const index = ids.indexOf(id);
  const target = ids[index + direction];
  return index < 0 || !target
    ? [...ids]
    : placeFolder(ids, id, target, direction < 0 ? "before" : "after");
}
