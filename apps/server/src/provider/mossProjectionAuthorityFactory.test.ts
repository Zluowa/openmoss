import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { makeMossProjectionAuthorityFactory } from "./mossProjectionAuthorityFactory.ts";

describe("MossProjectionAuthorityFactory", () => {
  it("resolves one store-backed adapter only for a registered workspace and bound session", async () => {
    const root = await mkdtemp(join(tmpdir(), "moss-projection-factory-"));
    try {
      const factory = makeMossProjectionAuthorityFactory({
        stateDir: root,
        resolveWorkspace: async (id) =>
          id === "workspace-1"
            ? {
                id,
                ownerId: "principal-1",
                projectId: "project-1",
                workspaceRoot: "/workspace-1",
              }
            : undefined,
      });
      factory.bindConnection({
        connectionId: "connection-1",
        principalId: "principal-1",
        sessionId: "session-1",
      });

      const first = await factory.resolve({
        registeredWorkspaceId: "workspace-1",
        connectionId: "connection-1",
        sessionId: "session-1",
      });
      const second = await factory.resolve({
        registeredWorkspaceId: "workspace-1",
        connectionId: "connection-1",
        sessionId: "session-1",
      });

      expect(first).toBeDefined();
      expect(second).toBe(first);
      expect(first?.canonicalAuthority).toBeDefined();
      expect(first?.ownerId).toBe("principal-1");
      await expect(
        factory.resolve({
          registeredWorkspaceId: "workspace-1",
          connectionId: "connection-1",
          sessionId: "stale-session",
        }),
      ).resolves.toBeUndefined();
      factory.unbindSession("session-1");
      await expect(
        factory.resolve({
          registeredWorkspaceId: "workspace-1",
          connectionId: "connection-1",
          sessionId: "session-1",
        }),
      ).resolves.toBeUndefined();
      await expect(
        factory.resolve({
          registeredWorkspaceId: "unregistered",
          connectionId: "connection-1",
          sessionId: "session-1",
        }),
      ).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("gives registered workspaces independent private authorities and concurrent locks", async () => {
    const root = await mkdtemp(join(tmpdir(), "moss-projection-factory-isolated-"));
    const workspaceA = join(root, "workspace-a");
    const workspaceB = join(root, "workspace-b");
    await Promise.all([
      mkdir(workspaceA, { recursive: true }),
      mkdir(workspaceB, { recursive: true }),
    ]);
    try {
      const factory = makeMossProjectionAuthorityFactory({
        stateDir: root,
        resolveWorkspace: async (id) =>
          id === "workspace-a"
            ? { id, ownerId: "principal-a", projectId: "project-a", workspaceRoot: workspaceA }
            : id === "workspace-b"
              ? {
                  id,
                  ownerId: "principal-b",
                  projectId: "project-b",
                  workspaceRoot: workspaceB,
                }
              : undefined,
      });
      factory.bindConnection({
        connectionId: "connection-a",
        principalId: "principal-a",
        sessionId: "session-a",
      });
      factory.bindConnection({
        connectionId: "connection-b",
        principalId: "principal-b",
        sessionId: "session-b",
      });

      const authorityA = await factory.resolve({
        registeredWorkspaceId: "workspace-a",
        connectionId: "connection-a",
        sessionId: "session-a",
      });
      const authorityB = await factory.resolve({
        registeredWorkspaceId: "workspace-b",
        connectionId: "connection-b",
        sessionId: "session-b",
      });

      expect(authorityA).toBeDefined();
      expect(authorityB).toBeDefined();
      expect(authorityA?.canonicalAuthority).not.toBe(authorityB?.canonicalAuthority);
      expect(authorityA?.ownershipStore).not.toBe(authorityB?.ownershipStore);
      expect(authorityA?.canonicalAuthority.filesystemCapability).not.toBe(
        authorityB?.canonicalAuthority.filesystemCapability,
      );
      expect(authorityA?.canonicalAuthority.stateDir).not.toBe(
        authorityB?.canonicalAuthority.stateDir,
      );

      const lockA = await authorityA!.canonicalAuthority.ownershipStore.acquireLock({
        cwd: workspaceA,
        ownerId: authorityA!.ownerId,
        projectId: authorityA!.workspace.projectId,
        workspaceId: authorityA!.workspace.id,
        principalId: authorityA!.connection.principalId,
        sessionId: authorityA!.connection.sessionId,
        nonce: "nonce-a",
      });
      try {
        const lockB = await authorityB!.canonicalAuthority.ownershipStore.acquireLock({
          cwd: workspaceB,
          ownerId: authorityB!.ownerId,
          projectId: authorityB!.workspace.projectId,
          workspaceId: authorityB!.workspace.id,
          principalId: authorityB!.connection.principalId,
          sessionId: authorityB!.connection.sessionId,
          nonce: "nonce-b",
        });
        if (process.platform === "win32")
          await expect(lockB.release()).rejects.toMatchObject({ code: "durability-unsupported" });
        else await lockB.release();
      } finally {
        if (process.platform === "win32")
          await expect(lockA.release()).rejects.toMatchObject({ code: "durability-unsupported" });
        else await lockA.release();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not resolve a thread from a stale read-model-only workspace binding", async () => {
    const root = await mkdtemp(join(tmpdir(), "moss-projection-factory-stale-"));
    let registered = true;
    try {
      const factory = makeMossProjectionAuthorityFactory({
        stateDir: root,
        resolveWorkspace: async (id) =>
          registered && id === "workspace-1"
            ? {
                id,
                ownerId: "principal-1",
                projectId: "project-1",
                workspaceRoot: "/registered-workspace",
              }
            : undefined,
      });
      factory.bindConnection({
        connectionId: "connection-1",
        principalId: "principal-1",
        sessionId: "session-1",
      });
      factory.bindThread({
        threadId: "thread-1",
        context: {
          registeredWorkspaceId: "workspace-1",
          connectionId: "connection-1",
          sessionId: "session-1",
        },
        workspace: {
          id: "workspace-1",
          ownerId: "principal-1",
          projectId: "project-1",
          workspaceRoot: "/registered-workspace",
        },
      });

      expect(
        await factory.resolveForThread({
          threadId: "thread-1",
          projectPath: "/registered-workspace/worktree",
        }),
      ).toBeDefined();
      registered = false;
      await expect(
        factory.resolveForThread({
          threadId: "thread-1",
          projectPath: "/registered-workspace/worktree",
        }),
      ).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps thread resolution fail-closed when the server binding is absent or cwd differs", async () => {
    const root = await mkdtemp(join(tmpdir(), "moss-projection-factory-"));
    try {
      const factory = makeMossProjectionAuthorityFactory({
        stateDir: root,
        resolveWorkspace: async (id) => ({
          id,
          ownerId: "principal-1",
          projectId: id,
          workspaceRoot: "/registered-workspace",
        }),
      });
      await expect(
        factory.resolveForThread({ threadId: "thread-1", projectPath: "/registered-workspace" }),
      ).resolves.toBeUndefined();

      factory.bindConnection({
        connectionId: "connection-1",
        principalId: "principal-1",
        sessionId: "session-1",
      });
      factory.bindThread({
        threadId: "thread-1",
        context: {
          registeredWorkspaceId: "workspace-1",
          connectionId: "connection-1",
          sessionId: "session-1",
        },
        workspace: {
          id: "workspace-1",
          ownerId: "principal-1",
          projectId: "workspace-1",
          workspaceRoot: "/registered-workspace",
        },
      });
      await expect(
        factory.resolveForThread({
          threadId: "thread-1",
          projectPath: "/registered-workspace/worktree",
        }),
      ).resolves.toMatchObject({ ownerId: "principal-1" });
      await expect(
        factory.resolveForThread({ threadId: "thread-1", projectPath: "/other-workspace" }),
      ).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("revokes a resolved handle before any later authority consumer can use it", async () => {
    const root = await mkdtemp(join(tmpdir(), "moss-projection-factory-liveness-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    try {
      const factory = makeMossProjectionAuthorityFactory({
        stateDir: root,
        now: () => 1_000,
      } as unknown as Parameters<typeof makeMossProjectionAuthorityFactory>[0]);
      factory.registerWorkspace({
        id: "workspace-1",
        ownerId: "principal-1",
        projectId: "project-1",
        workspaceRoot: workspace,
      });
      factory.bindConnection({
        connectionId: "connection-1",
        principalId: "principal-1",
        sessionId: "session-1",
      });
      const handle = await factory.resolve({
        registeredWorkspaceId: "workspace-1",
        connectionId: "connection-1",
        sessionId: "session-1",
      });
      expect(handle).toBeDefined();
      const assertLive = (handle as unknown as { readonly assertLive: () => void }).assertLive;
      expect(() => assertLive()).not.toThrow();

      factory.unbindSession("session-1");

      expect(() => assertLive()).toThrow(/stale|revoked|liveness/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("invalidates an old handle across workspace re-registration and connection replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "moss-projection-factory-rebind-"));
    try {
      const factory = makeMossProjectionAuthorityFactory({ stateDir: root });
      factory.registerWorkspace({
        id: "workspace-1",
        ownerId: "principal-1",
        projectId: "project-1",
        workspaceRoot: "/workspace-before",
      });
      factory.bindConnection({
        connectionId: "connection-1",
        principalId: "principal-1",
        sessionId: "session-1",
      });
      const oldHandle = await factory.resolve({
        registeredWorkspaceId: "workspace-1",
        connectionId: "connection-1",
        sessionId: "session-1",
      });
      expect(oldHandle).toBeDefined();
      const assertOldLive = (oldHandle as unknown as { readonly assertLive: () => void })
        .assertLive;

      factory.registerWorkspace({
        id: "workspace-1",
        ownerId: "principal-1",
        projectId: "project-2",
        workspaceRoot: "/workspace-after",
      });
      expect(() => assertOldLive()).toThrow(/stale|revoked|liveness/i);
      const newHandle = await factory.resolve({
        registeredWorkspaceId: "workspace-1",
        connectionId: "connection-1",
        sessionId: "session-1",
      });
      expect(newHandle).toBeDefined();
      expect(newHandle).not.toBe(oldHandle);
      expect(() => newHandle!.assertLive()).not.toThrow();

      factory.bindConnection({
        connectionId: "connection-1",
        principalId: "principal-1",
        sessionId: "session-2",
      });
      expect(() => newHandle!.assertLive()).toThrow(/stale|revoked|liveness/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("revokes a handle when its server-provided connection expiry is reached", async () => {
    const root = await mkdtemp(join(tmpdir(), "moss-projection-factory-expiry-"));
    let now = 1_000;
    try {
      const factory = makeMossProjectionAuthorityFactory({
        stateDir: root,
        now: () => now,
      } as unknown as Parameters<typeof makeMossProjectionAuthorityFactory>[0]);
      factory.registerWorkspace({
        id: "workspace-1",
        ownerId: "principal-1",
        projectId: "project-1",
        workspaceRoot: "/workspace-1",
      });
      factory.bindConnection({
        connectionId: "connection-1",
        principalId: "principal-1",
        sessionId: "session-1",
        expiresAt: 2_000,
      } as unknown as Parameters<typeof factory.bindConnection>[0]);
      const handle = await factory.resolve({
        registeredWorkspaceId: "workspace-1",
        connectionId: "connection-1",
        sessionId: "session-1",
      });
      expect(handle).toBeDefined();
      now = 2_000;
      expect(() => handle!.assertLive()).toThrow(/stale|revoked|liveness|expired/i);
      await expect(
        factory.resolve({
          registeredWorkspaceId: "workspace-1",
          connectionId: "connection-1",
          sessionId: "session-1",
        }),
      ).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const invalidation of [
    {
      name: "session unbind",
      apply: (factory: ReturnType<typeof makeMossProjectionAuthorityFactory>) =>
        factory.unbindSession("session-1"),
      expire: false,
    },
    {
      name: "workspace unregister",
      apply: (factory: ReturnType<typeof makeMossProjectionAuthorityFactory>) =>
        factory.unregisterWorkspace({ id: "workspace-1", ownerId: "principal-1" }),
      expire: false,
    },
    {
      name: "workspace re-registration",
      apply: (factory: ReturnType<typeof makeMossProjectionAuthorityFactory>) =>
        factory.registerWorkspace({
          id: "workspace-1",
          ownerId: "principal-1",
          projectId: "project-after",
          workspaceRoot: "/workspace-after",
        }),
      expire: false,
    },
    {
      name: "connection replacement",
      apply: (factory: ReturnType<typeof makeMossProjectionAuthorityFactory>) =>
        factory.bindConnection({
          connectionId: "connection-1",
          principalId: "principal-1",
          sessionId: "session-2",
        }),
      expire: false,
    },
    {
      name: "connection expiry",
      apply: (factory: ReturnType<typeof makeMossProjectionAuthorityFactory>) => undefined,
      expire: true,
    },
  ] as const) {
    it(`rejects every mutation seam after ${invalidation.name}`, async () => {
      const root = await mkdtemp(join(tmpdir(), "moss-projection-factory-facade-"));
      let now = 1_000;
      try {
        const factory = makeMossProjectionAuthorityFactory({
          stateDir: root,
          now: () => now,
        });
        factory.registerWorkspace({
          id: "workspace-1",
          ownerId: "principal-1",
          projectId: "project-1",
          workspaceRoot: "/workspace-1",
        });
        factory.bindConnection({
          connectionId: "connection-1",
          principalId: "principal-1",
          sessionId: "session-1",
          ...(invalidation.expire ? { expiresAt: 2_000 } : {}),
        });
        const handle = await factory.resolve({
          registeredWorkspaceId: "workspace-1",
          connectionId: "connection-1",
          sessionId: "session-1",
        });
        expect(handle).toBeDefined();

        const livenessBoundAdapter = handle!.ownershipStore;
        const rawCanonicalStore = handle!.canonicalAuthority.ownershipStore;
        const rawCanonicalCapability = handle!.canonicalAuthority.filesystemCapability;
        const rawAcquireLock = vi.spyOn(rawCanonicalStore, "acquireLock").mockResolvedValue({
          ownerId: "principal-1",
          projectId: "project-1",
          workspaceId: "workspace-1",
          principalId: "principal-1",
          sessionId: "session-1",
          nonce: "raw-bypass",
          fencingToken: "raw-fencing",
          generation: "raw-generation",
          release: async () => undefined,
        });
        const capabilityResult = {} as Awaited<ReturnType<typeof rawCanonicalCapability.create>>;
        const rawCapabilityCalls = {
          create: vi.spyOn(rawCanonicalCapability, "create").mockResolvedValue(capabilityResult),
          publish: vi.spyOn(rawCanonicalCapability, "publish").mockResolvedValue(capabilityResult),
          replace: vi.spyOn(rawCanonicalCapability, "replace").mockResolvedValue(capabilityResult),
          remove: vi.spyOn(rawCanonicalCapability, "remove").mockResolvedValue(capabilityResult),
        };
        const capturedAcquireLock = rawCanonicalStore.acquireLock;
        const capturedCapabilityMethods = {
          create: rawCanonicalCapability.create,
          publish: rawCanonicalCapability.publish,
          replace: rawCanonicalCapability.replace,
          remove: rawCanonicalCapability.remove,
        };

        if (invalidation.expire) now = 2_000;
        invalidation.apply(factory);

        const projectionScope = {
          projectRoot: "/workspace-1",
          projectRootIdentity: {
            realpath: "/workspace-1",
            dev: "device",
            ino: "inode",
            ctimeMs: 1,
          },
          ownerId: "principal-1",
          generation: handle!.generation,
          operationId: "operation-1",
          nonce: "nonce-1",
        } as const;
        await expect(
          livenessBoundAdapter.withMutationLock(projectionScope, async () => "mutated"),
          "liveness-bound projection adapter",
        ).rejects.toMatchObject({ name: "MossProjectionAuthorityError" });

        await expect(
          capturedAcquireLock({
            cwd: "/workspace-1",
            ownerId: "principal-1",
            projectId: "project-1",
            workspaceId: "workspace-1",
            principalId: "principal-1",
            sessionId: "session-1",
            nonce: "raw-bypass",
          }),
          "canonical ownership store facade",
        ).rejects.toMatchObject({ name: "MossProjectionAuthorityError" });

        for (const method of ["create", "publish", "replace", "remove"] as const) {
          await expect(
            capturedCapabilityMethods[method](
              {} as Parameters<typeof rawCanonicalCapability.create>[0],
            ),
            `canonical filesystem capability facade: ${method}`,
          ).rejects.toMatchObject({ name: "MossProjectionAuthorityError" });
          expect(rawCapabilityCalls[method]).not.toHaveBeenCalled();
        }
        expect(rawAcquireLock).not.toHaveBeenCalled();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
