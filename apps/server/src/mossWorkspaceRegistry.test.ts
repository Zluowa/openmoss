import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import { makeMossWorkspaceRegistry, MossWorkspaceRegistryError } from "./mossWorkspaceRegistry.ts";

describe("Moss workspace registry", () => {
  const workspaceRoot = resolve("/workspace/project");
  const projects = [
    {
      id: "project-1",
      workspaceRoot,
      deletedAt: null,
    },
  ];

  it("resolves only a server-registered root and an owner authorization", () => {
    const registry = makeMossWorkspaceRegistry({
      authorize: (input) =>
        input.ownerId === "owner-1" &&
        input.workspaceId === "project-1" &&
        input.workspaceRoot === workspaceRoot,
    });

    expect(
      registry.resolve({
        role: "owner",
        ownerId: "owner-1",
        cwd: workspaceRoot,
        workspaceId: "project-1",
        mutation: true,
        projects,
      }),
    ).toEqual({ cwd: workspaceRoot, ownerId: "owner-1", workspaceId: "project-1" });
  });

  it("does not let a client-supplied root or workspace id become authority", () => {
    const registry = makeMossWorkspaceRegistry({ authorize: () => true });

    expect(() =>
      registry.resolve({
        role: "client",
        ownerId: "owner-1",
        cwd: "/workspace/other",
        workspaceId: "project-1",
        mutation: true,
        projects,
      }),
    ).toThrowError(MossWorkspaceRegistryError);
  });
});
