// FILE: mossbotRoomThreads.ts
// Purpose: A Mossbot group chat keeps one hidden "room" project with an internal thread per
//          member; those threads hold the raw group prompt, so no list, search, recents or
//          notification ever offers them. The room view is their only entry point.
// Layer: Web domain helper
// Exports: roomProjectIdsOf, isRoomProjectThread

import type { ProjectKind } from "@moss/contracts";

/** Ids of the hidden group-chat containers among the store's projects. */
export function roomProjectIdsOf(
  projects:
    | readonly { readonly id: string; readonly kind?: ProjectKind | undefined }[]
    | null
    | undefined,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const project of projects ?? []) if (project.kind === "room") ids.add(project.id);
  return ids;
}

/** True for a member thread of a group chat (its project is a hidden room container). */
export function isRoomProjectThread(
  projectId: string | null | undefined,
  roomProjectIds: ReadonlySet<string>,
): boolean {
  return projectId != null && roomProjectIds.has(projectId);
}
