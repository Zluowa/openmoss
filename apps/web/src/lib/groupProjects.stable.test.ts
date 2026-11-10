// Stable build: the hub entry points are off, but Mossbot assistants live in group folders,
// so a group folder is still a container, never an ordinary project.
import { type ProjectId } from "@moss/contracts";
import { describe, expect, it, vi } from "vitest";

vi.mock(import("../betaFeatures"), async (importOriginal) => ({
  ...(await importOriginal()),
  GROUPS_ON: false,
}));

import type { Project } from "../types";
import { isGroupContainerProject } from "./groupProjects";

describe("isGroupContainerProject on Stable", () => {
  it("keeps a group folder (a Mossbot assistant) out of the ordinary projects", () => {
    const project = {
      id: "project-group" as ProjectId,
      kind: "group",
      cwd: "/Users/tester/Documents/Moss/Groups/release",
    } as unknown as Project;
    expect(
      isGroupContainerProject(project, {
        homeDir: "/Users/tester",
        groupsWorkspaceRoot: "/Users/tester/Documents/Moss/Groups",
      }),
    ).toBe(true);
  });
});
