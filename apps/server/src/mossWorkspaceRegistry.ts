import { resolve } from "node:path";

import { workspaceRootsEqual } from "@synara/shared/threadWorkspace";

export type MossWorkspaceRegistryCode = "authorization-required" | "workspace-unregistered";

export class MossWorkspaceRegistryError extends Error {
  readonly code: MossWorkspaceRegistryCode;

  constructor(code: MossWorkspaceRegistryCode, message: string) {
    super(message);
    this.name = "MossWorkspaceRegistryError";
    this.code = code;
  }
}

export interface MossWorkspaceRegistryProject {
  readonly id: string;
  readonly workspaceRoot: string;
  readonly deletedAt: string | null;
}

export interface MossWorkspaceRegistryResolveInput {
  readonly role: "owner" | "client";
  readonly ownerId: string;
  readonly cwd: string;
  readonly workspaceId?: string;
  readonly mutation: boolean;
  readonly projects: readonly MossWorkspaceRegistryProject[];
}

export interface MossWorkspaceRegistry {
  readonly resolve: (input: MossWorkspaceRegistryResolveInput) => {
    readonly cwd: string;
    readonly ownerId: string;
    readonly workspaceId: string;
  };
}

export function makeMossWorkspaceRegistry(options: {
  readonly authorize: (input: {
    readonly ownerId: string;
    readonly workspaceId: string;
    readonly workspaceRoot: string;
  }) => boolean;
}): MossWorkspaceRegistry {
  return {
    resolve: (input) => {
      if (input.mutation && input.role !== "owner") {
        throw new MossWorkspaceRegistryError(
          "authorization-required",
          "Owner authorization is required for Moss workspace mutation.",
        );
      }
      const ownerId = input.ownerId.trim();
      const workspaceId = input.workspaceId?.trim();
      if (!ownerId) {
        throw new MossWorkspaceRegistryError(
          "authorization-required",
          "The Moss workspace owner binding is missing.",
        );
      }
      if (!workspaceId) {
        throw new MossWorkspaceRegistryError(
          "workspace-unregistered",
          "A server-registered Moss workspace is required.",
        );
      }
      const project = input.projects.find(
        (candidate) => candidate.id === workspaceId && candidate.deletedAt === null,
      );
      if (
        !project ||
        !workspaceRootsEqual(project.workspaceRoot, input.cwd, { platform: process.platform })
      ) {
        throw new MossWorkspaceRegistryError(
          "workspace-unregistered",
          "The requested path is not the registered Moss workspace root.",
        );
      }
      const workspaceRoot = resolve(project.workspaceRoot);
      if (
        !options.authorize({
          ownerId,
          workspaceId: project.id,
          workspaceRoot,
        })
      ) {
        throw new MossWorkspaceRegistryError(
          "authorization-required",
          "The requested Moss workspace is not authorized for this owner.",
        );
      }
      return { cwd: workspaceRoot, ownerId, workspaceId: project.id };
    },
  };
}
