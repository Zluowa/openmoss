import { describe, expect, it } from "vitest";

import { ProjectId } from "@synara/contracts";

import {
  buildHeliosSidebarFixtureThreads,
  readHeliosSidebarFixtureEnabled,
} from "./heliosSidebarFixtures";

describe("Helios sidebar capture fixture", () => {
  it("requires the explicit projects query value", () => {
    expect(readHeliosSidebarFixtureEnabled("?heliosFixture=projects")).toBe(true);
    expect(readHeliosSidebarFixtureEnabled("?heliosFixture=library")).toBe(false);
    expect(readHeliosSidebarFixtureEnabled("")).toBe(false);
  });

  it("creates stable child rows scoped to the target project", () => {
    const projectId = ProjectId.makeUnsafe("project-helios");
    const rows = buildHeliosSidebarFixtureThreads({
      projectId,
      modelSelection: { provider: "codex", instanceId: "codex", model: "gpt-5.4" },
    });

    expect(rows).toHaveLength(8);
    expect(rows[0]).toMatchObject({
      id: "helios-sidebar-fixture-thread-1",
      projectId,
      title: "/context",
    });
    expect(rows.every((row) => row.projectId === projectId)).toBe(true);
    expect(rows.map((row) => row.id)).toEqual(
      expect.arrayContaining(["helios-sidebar-fixture-thread-8"]),
    );
  });
});
