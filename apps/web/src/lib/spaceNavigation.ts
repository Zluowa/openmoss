// FILE: spaceNavigation.ts
// Purpose: Which threads a Space-scoped "/" landing (an old `?space=` link) may restore.
// Layer: Spaces domain helper
// Why: The sidebar's Spaces were removed (2026-11-10); only the "/" restore still honours a
//      Space in its URL, and it needs the thread-level reading of `isOrdinarySpaceProject`.

import type { SpaceId } from "@moss/contracts";

import type { ServerWorkspacePaths } from "~/lib/serverWorkspacePaths";
import { isOrdinarySpaceProject } from "~/lib/spaces";
import type { Project } from "~/types";

/** Strict membership: a project Spaces organize, filed into `spaceId`. */
export function isProjectInSpace(
  project: Project | null | undefined,
  spaceId: SpaceId | null,
  paths: ServerWorkspacePaths,
): project is Project {
  return isOrdinarySpaceProject(project, paths) && (project.spaceId ?? null) === spaceId;
}

/**
 * Whether a Space may land on a thread in this project. The Chats and Groups containers belong
 * to no Space and are reachable from every one of them; any other thread belongs to exactly its
 * project's Space. Fails closed on a project we cannot resolve — a thread we cannot classify is
 * not a safe landing, and a fresh chat beats silently reverting the user's Space selection.
 */
export function isThreadReachableFromSpace(input: {
  project: Project | null | undefined;
  spaceId: SpaceId | null;
  paths: ServerWorkspacePaths;
}): boolean {
  const { paths, project, spaceId } = input;
  if (!project) return false;
  if (!isOrdinarySpaceProject(project, paths)) return true;
  return (project.spaceId ?? null) === spaceId;
}
