import type {
  MossFilesystemCapability,
  MossOwnershipStore,
  MossPrivateManifest,
  MossPrivateManifestReceipt,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  mossProjectionPrivateManifestRecordHash,
  type MossOwnershipMutationScope,
  type MossProjectionPrivateManifestInput,
} from "./mossProjectionMaterializer";
import { makeMossProjectionOwnershipAdapter } from "./mossProjectionOwnershipAdapter";

function canonicalStore(calls: {
  readonly locks: MossOwnershipMutationScope[];
  readonly manifests: unknown[];
}): MossOwnershipStore {
  let latest: MossPrivateManifest | null = null;
  const lock = {
    ownerId: "owner-1",
    projectId: "project-1",
    workspaceId: "workspace-1",
    principalId: "principal-1",
    sessionId: "session-1",
    nonce: "nonce-1",
    fencingToken: "fence-1",
    generation: "generation-1",
    release: async () => undefined,
  };
  const receipt = (
    input: Parameters<MossOwnershipStore["appendPrivateManifest"]>[0],
  ): MossPrivateManifestReceipt => ({
    locator: "server-state://projection",
    transactionId: input.transactionId,
    sequence: 0,
    previousHash: "0".repeat(64),
    recordHash: "1".repeat(64),
    ownerId: input.ownerId,
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    principalId: input.principalId,
    sessionId: input.sessionId,
    stateFingerprint: input.stateFingerprint,
    nonce: input.nonce,
    value: input.value,
  });
  return {
    acquireLock: async (input) => {
      calls.locks.push({
        projectRoot: input.cwd,
        projectRootIdentity: { realpath: input.cwd, dev: "1", ino: "1", ctimeMs: 1 },
        ownerId: input.ownerId,
        generation: "generation-1",
        operationId: "operation-1",
        nonce: input.nonce,
      });
      return lock;
    },
    assertStateBudget: async () => undefined,
    createPrivateStage: async () => {
      throw new Error("not used");
    },
    readPrivateStage: async () => {
      throw new Error("not used");
    },
    writePrivateStage: async () => undefined,
    appendPrivateManifest: async (input) => {
      calls.manifests.push(input);
      const result = receipt(input);
      latest = result;
      return result;
    },
    readPrivateManifest: async () => latest,
    appendPrivateRecord: async (input) => receipt(input),
    readPrivateRecord: async () => null,
    listPrivateRecords: async () => [],
    publishPrivateSnapshot: async () => {
      throw new Error("not used");
    },
    recoverPrivateStages: async () => undefined,
  };
}

const capability = {} as MossFilesystemCapability;

describe("Moss projection ownership adapter", () => {
  it("uses the canonical store lock exactly once and binds every authority identity", async () => {
    const calls = { locks: [] as MossOwnershipMutationScope[], manifests: [] as unknown[] };
    const ownershipStore = canonicalStore(calls);
    const adapter = makeMossProjectionOwnershipAdapter({
      ownershipStore,
      filesystemCapability: capability,
      authority: {
        ownerId: "owner-1",
        projectId: "project-1",
        workspaceId: "workspace-1",
        principalId: "principal-1",
        sessionId: "session-1",
      },
    });
    const scope: MossOwnershipMutationScope = {
      projectRoot: "/workspace",
      projectRootIdentity: { realpath: "/workspace", dev: "1", ino: "1", ctimeMs: 1 },
      ownerId: "owner-1",
      generation: "generation-1",
      operationId: "operation-1",
      nonce: "nonce-1",
    };

    await expect(
      adapter.withMutationLock(scope, async (fencingToken) => fencingToken),
    ).resolves.toBe("fence-1");
    expect(calls.locks).toHaveLength(1);
    expect(calls.locks[0]).toMatchObject({
      projectRoot: "/workspace",
      ownerId: "owner-1",
      generation: "generation-1",
      operationId: "operation-1",
      nonce: "nonce-1",
    });
  });

  it("maps projection manifest sequencing onto the canonical private chain", async () => {
    const calls = { locks: [] as MossOwnershipMutationScope[], manifests: [] as unknown[] };
    const adapter = makeMossProjectionOwnershipAdapter({
      ownershipStore: canonicalStore(calls),
      filesystemCapability: capability,
      authority: {
        ownerId: "owner-1",
        projectId: "project-1",
        workspaceId: "workspace-1",
        principalId: "principal-1",
        sessionId: "session-1",
      },
    });
    const input: MossProjectionPrivateManifestInput = {
      fileName: "projection-manifest.v3.json",
      transactionId: "generation-1",
      operationId: "operation-1",
      sequence: 1,
      previousHash: "0".repeat(64),
      recordHash: mossProjectionPrivateManifestRecordHash({
        operationId: "operation-1",
        sequence: 1,
        previousHash: "0".repeat(64),
        value: { version: 1, generatedAt: "2026-08-08T00:00:00.000Z", entries: {} },
      }),
      value: { version: 1, generatedAt: "2026-08-08T00:00:00.000Z", entries: {} },
    };

    const receipt = await adapter.withMutationLock(
      {
        projectRoot: "/workspace",
        projectRootIdentity: { realpath: "/workspace", dev: "1", ino: "1", ctimeMs: 1 },
        ownerId: "owner-1",
        generation: "generation-1",
        operationId: "operation-1",
        nonce: "nonce-1",
      },
      () => adapter.appendPrivateManifest(input),
    );

    expect(receipt).toEqual({
      locator: "server-state://projection",
      transactionId: "generation-1",
      operationId: "operation-1",
      sequence: 1,
      previousHash: "0".repeat(64),
      recordHash: input.recordHash,
    });
    expect(calls.manifests).toHaveLength(1);
    expect(calls.manifests[0]).toMatchObject({
      fileName: "projection-manifest.v3.json",
      ownerId: "owner-1",
      projectId: "project-1",
      workspaceId: "workspace-1",
      principalId: "principal-1",
      sessionId: "session-1",
    });
  });

  it("rejects an underlying receipt that forges authority metadata", async () => {
    const calls = { locks: [] as MossOwnershipMutationScope[], manifests: [] as unknown[] };
    const base = canonicalStore(calls);
    const ownershipStore: MossOwnershipStore = {
      ...base,
      appendPrivateManifest: async (input) => ({
        ...(await base.appendPrivateManifest(input)),
        ownerId: "forged-owner",
      }),
    };
    const adapter = makeMossProjectionOwnershipAdapter({
      ownershipStore,
      filesystemCapability: capability,
      authority: {
        ownerId: "owner-1",
        projectId: "project-1",
        workspaceId: "workspace-1",
        principalId: "principal-1",
        sessionId: "session-1",
      },
    });
    const input: MossProjectionPrivateManifestInput = {
      fileName: "projection-manifest.v3.json",
      transactionId: "generation-1",
      operationId: "operation-1",
      sequence: 1,
      previousHash: "0".repeat(64),
      recordHash: mossProjectionPrivateManifestRecordHash({
        operationId: "operation-1",
        sequence: 1,
        previousHash: "0".repeat(64),
        value: { version: 1, entries: {} },
      }),
      value: { version: 1, entries: {} },
    };
    await expect(
      adapter.withMutationLock(
        {
          projectRoot: "/workspace",
          projectRootIdentity: { realpath: "/workspace", dev: "1", ino: "1", ctimeMs: 1 },
          ownerId: "owner-1",
          generation: "generation-1",
          operationId: "operation-1",
          nonce: "nonce-1",
        },
        () => adapter.appendPrivateManifest(input),
      ),
    ).rejects.toMatchObject({ code: "concurrent-modification" });
  });
});
