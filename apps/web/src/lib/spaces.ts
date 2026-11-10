// FILE: spaces.ts
// Purpose: Which projects are ordinary (not the Chats or Mossbot/group containers). The
//          sidebar Spaces that used this rule were removed (2026-11-10); the rule stays.
// Layer: Web domain helper

import type { Project } from "~/types";
import { isHomeChatContainerProject } from "~/lib/chatProjects";
import { isGroupContainerProject } from "~/lib/groupProjects";
import type { ServerWorkspacePaths } from "~/lib/serverWorkspacePaths";

/**
 * Ordinary projects only: the Chats and group (Mossbot) containers are not projects the
 * person filed, so the project list, pickers, and shortcut targets leave them out.
 */
export function isOrdinarySpaceProject(
  project: Project | null | undefined,
  paths: ServerWorkspacePaths,
): project is Project {
  return (
    project?.kind === "project" &&
    !isHomeChatContainerProject(project, paths) &&
    !isGroupContainerProject(project, paths)
  );
}
