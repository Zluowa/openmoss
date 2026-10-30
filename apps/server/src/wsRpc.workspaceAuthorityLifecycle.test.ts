import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OrchestrationEvent } from "@synara/contracts";
import { Effect, Exit, Scope } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { makeMossProjectionAuthorityFactory } from "./provider/mossProjectionAuthorityFactory.ts";
import {
  invalidateMossProjectionWorkspaceAuthorityForEvent,
  makeMossProjectionAuthorityConnectionCloseHandler,
} from "./wsRpc.ts";
import { makeWsConnectionSessions, type WsConnectionSession } from "./wsConnectionSessions.ts";

const lockInput = {
  cwd: "/workspace-1",
  ownerId: "principal-1",
  projectId: "project-1",
  workspaceId: "workspace-1",
  principalId: "principal-1",
  sessionId: "session-1",
  nonce: "captured-after-lifecycle-change",
} as const;

describe("production WS workspace authority lifecycle", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("revokes captured store and capability methods after the server project is deleted", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "moss-ws-workspace-lifecycle-red-"));
    roots.push(stateDir);
    const factory = makeMossProjectionAuthorityFactory({ stateDir });
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
    });

    const handle = await factory.resolve({
      registeredWorkspaceId: "workspace-1",
      connectionId: "connection-1",
      sessionId: "session-1",
    });
    expect(handle).toBeDefined();

    const capturedAcquireLock = handle!.canonicalAuthority.ownershipStore.acquireLock;
    const capturedCreate = handle!.canonicalAuthority.filesystemCapability.create;
    invalidateMossProjectionWorkspaceAuthorityForEvent(factory, {
      type: "project.deleted",
      payload: { projectId: "workspace-1", deletedAt: "2026-08-10T00:00:00.000Z" },
    } as unknown as OrchestrationEvent);

    await expect(
      capturedAcquireLock({
        ...lockInput,
      }),
    ).rejects.toMatchObject({ name: "MossProjectionAuthorityError" });
    await expect(capturedCreate({} as Parameters<typeof capturedCreate>[0])).rejects.toMatchObject({
      name: "MossProjectionAuthorityError",
    });
  });

  it("revokes the old facade on an authoritative workspace replacement before re-registering", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "moss-ws-workspace-replacement-"));
    roots.push(stateDir);
    const factory = makeMossProjectionAuthorityFactory({ stateDir });
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
    const capturedAcquireLock = oldHandle!.canonicalAuthority.ownershipStore.acquireLock;

    invalidateMossProjectionWorkspaceAuthorityForEvent(factory, {
      type: "project.meta-updated",
      payload: { projectId: "workspace-1", workspaceRoot: "/workspace-after" },
    } as unknown as OrchestrationEvent);
    await expect(capturedAcquireLock({ ...lockInput })).rejects.toMatchObject({
      name: "MossProjectionAuthorityError",
    });

    factory.registerWorkspace({
      id: "workspace-1",
      ownerId: "principal-1",
      projectId: "project-1",
      workspaceRoot: "/workspace-after",
    });
    const newHandle = await factory.resolve({
      registeredWorkspaceId: "workspace-1",
      connectionId: "connection-1",
      sessionId: "session-1",
    });
    expect(newHandle).toBeDefined();
    expect(newHandle).not.toBe(oldHandle);
    expect(() => newHandle!.assertLive()).not.toThrow();
  });

  it("unbinds all captured authority when the real connection scope closes", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "moss-ws-connection-close-"));
    roots.push(stateDir);
    const factory = makeMossProjectionAuthorityFactory({ stateDir });
    factory.registerWorkspace({
      id: "workspace-1",
      ownerId: "principal-1",
      projectId: "project-1",
      workspaceRoot: "/workspace-1",
    });
    factory.bindConnection({
      connectionId: "connection-1",
      principalId: "principal-1",
      sessionId: "principal-1",
    });
    const handle = await factory.resolve({
      registeredWorkspaceId: "workspace-1",
      connectionId: "connection-1",
      sessionId: "principal-1",
    });
    expect(handle).toBeDefined();
    const capturedAcquireLock = handle!.canonicalAuthority.ownershipStore.acquireLock;

    const onClose = makeMossProjectionAuthorityConnectionCloseHandler(factory, {
      ownerKind: "session",
      ownerId: "principal-1",
    });
    expect(onClose).toBeDefined();
    const sessions = await Effect.runPromise(makeWsConnectionSessions);
    const scope = await Effect.runPromise(Scope.make());
    const session: WsConnectionSession = {
      role: "owner",
      attachmentPrincipal: { ownerKind: "session", ownerId: "principal-1" },
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        const key = yield* sessions.register(session);
        sessions.onClose(key, onClose!);
      }).pipe(Scope.provide(scope)),
    );
    await Effect.runPromise(Scope.close(scope, Exit.void));

    await expect(
      capturedAcquireLock({ ...lockInput, sessionId: "principal-1" }),
    ).rejects.toMatchObject({
      name: "MossProjectionAuthorityError",
    });
  });
});
