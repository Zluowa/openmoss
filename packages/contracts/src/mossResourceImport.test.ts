import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  MossResourceImportApplyInput,
  MossResourceImportInventoryInput,
  MossResourceImportInventoryResult,
  MossResourceImportJournal,
  MossResourceImportPlanInput,
  MossResourceImportPlanResult,
  MossResourceImportRollbackInput,
  MossResourceImportRollbackResult,
  type MossFilesystemCapabilityInput,
  type MossFilesystemCapabilityReceipt,
  type MossOwnershipLock,
  type MossOwnershipStore,
} from "./mossResourceImport";

describe("Moss resource import contracts", () => {
  it("decodes the inventory request and keeps the provider filter bounded", () => {
    const input = Schema.decodeUnknownSync(MossResourceImportInventoryInput)({
      cwd: " /workspace ",
      providers: ["codex", "claude", "agents"],
      kinds: ["skill", "plugin", "mcp"],
    });

    expect(input.cwd).toBe("/workspace");
    expect(input.providers).toEqual(["codex", "claude", "agents"]);
    expect("filesystemGrant" in input).toBe(false);
  });

  it("accepts only a bounded server-staged local source", () => {
    const input = Schema.decodeUnknownSync(MossResourceImportPlanInput)({
      cwd: "/workspace",
      selectionOrigin: "local",
      localSource: {
        kind: "plugin",
        sourceName: "plugin.json",
        contents: '{"name":"local-plugin"}',
      },
    });

    expect(input.localSource).toEqual({
      kind: "plugin",
      sourceName: "plugin.json",
      contents: '{"name":"local-plugin"}',
    });
    expect(
      Schema.decodeUnknownSync(MossResourceImportPlanInput)({
        cwd: "/workspace",
        selectionOrigin: "local",
        localSource: {
          kind: "plugin",
          sourceName: "plugin.json",
          contents: '{"name":"local-plugin"}',
          replaceExisting: true,
        },
      }).localSource?.replaceExisting,
    ).toBe(true);
    expect(() =>
      Schema.decodeUnknownSync(MossResourceImportPlanInput)({
        cwd: "/workspace",
        localSource: {
          kind: "skill",
          sourceName: "../SKILL.md",
          contents: "x",
        },
      }),
    ).toThrow();
  });

  it("models a source-safe inventory and a dry-run plan without secret values", () => {
    const inventory = Schema.decodeUnknownSync(MossResourceImportInventoryResult)({
      inventoryId: "inventory-1",
      cwd: "/workspace",
      generatedAt: "2026-08-06T01:02:03.000Z",
      roots: [
        {
          provider: "claude",
          scope: "user",
          kind: "skills",
          path: "/Users/moss/.claude/skills",
          exists: true,
          permissionRequired: false,
        },
      ],
      resources: [
        {
          id: "resource-1",
          kind: "skill",
          provider: "claude",
          scope: "user",
          name: "release-notes",
          sourcePath: "/Users/moss/.claude/skills/release-notes/SKILL.md",
          sourceSha256: "a".repeat(64),
          sizeBytes: 42,
          format: "markdown",
          secretFields: [],
          warnings: [],
        },
      ],
      issues: [],
    });

    const plan = Schema.decodeUnknownSync(MossResourceImportPlanResult)({
      plan: {
        schemaVersion: 1,
        planId: "plan-1",
        cwd: "/workspace",
        createdAt: "2026-08-06T01:02:03.000Z",
        expiresAt: "2026-08-06T01:07:03.000Z",
        issuer: "local-loopback",
        ownerId: "local-loopback",
        projectId: "workspace-1",
        principalId: "local-loopback",
        sessionId: "local-loopback",
        workspaceId: "workspace-1",
        stateFingerprint: "c".repeat(64),
        stateRoot: "/server/state",
        nonce: "plan-nonce-1",
        planHash: "b".repeat(64),
        selectedResourceIds: ["resource-1"],
        operations: [
          {
            operationId: "operation-1",
            resourceId: "resource-1",
            kind: "skill",
            provider: "claude",
            scope: "user",
            name: "release-notes",
            sourcePath: "/Users/moss/.claude/skills/release-notes/SKILL.md",
            sourceSha256: "a".repeat(64),
            snapshotPath: "/server/state/blobs/sha256/" + "a".repeat(64),
            snapshotSha256: "a".repeat(64),
            targetPath: "/workspace/.moss/skills/release-notes/SKILL.md",
            action: "copy",
            secretFields: [],
            warnings: [],
          },
        ],
        issues: [],
        selectionSnapshotSha256: "d".repeat(64),
      },
    });

    expect(inventory.resources[0]?.sourceSha256).toHaveLength(64);
    expect(plan.plan.operations[0]?.action).toBe("copy");
    expect(JSON.stringify(plan)).not.toContain("secret-value");
  });

  it("requires the full plan for apply and an explicit transaction for rollback", () => {
    const apply = Schema.decodeUnknownSync(MossResourceImportApplyInput)({
      cwd: "/workspace",
      plan: {
        schemaVersion: 1,
        planId: "plan-1",
        cwd: "/workspace",
        createdAt: "2026-08-06T01:02:03.000Z",
        expiresAt: "2026-08-06T01:07:03.000Z",
        issuer: "local-loopback",
        ownerId: "local-loopback",
        projectId: "workspace-1",
        principalId: "local-loopback",
        sessionId: "local-loopback",
        workspaceId: "workspace-1",
        stateFingerprint: "c".repeat(64),
        stateRoot: "/server/state",
        nonce: "plan-nonce-1",
        planHash: "b".repeat(64),
        selectedResourceIds: [],
        operations: [],
        issues: [],
        selectionSnapshotSha256: "d".repeat(64),
      },
    });
    const rollback = Schema.decodeUnknownSync(MossResourceImportRollbackInput)({
      cwd: "/workspace",
      transactionId: "transaction-1",
    });
    const result = Schema.decodeUnknownSync(MossResourceImportRollbackResult)({
      transactionId: rollback.transactionId,
      status: "rolled-back",
      restored: [],
      issues: [],
    });

    expect(apply.plan.planHash).toBe("b".repeat(64));
    expect(result.status).toBe("rolled-back");
  });

  it("rejects transaction ids that could escape the canonical journal directory", () => {
    expect(() =>
      Schema.decodeUnknownSync(MossResourceImportRollbackInput)({
        cwd: "/workspace",
        transactionId: "../outside/transaction-1",
      }),
    ).toThrow();
  });

  it("requires the v3 journal binding, hash chain, and canonical change hash fields", () => {
    const journal = Schema.decodeUnknownSync(MossResourceImportJournal)({
      schemaVersion: 3,
      transactionId: "transaction-1",
      planId: "plan-1",
      ownerId: "session-owner",
      issuer: "session-owner",
      projectId: "project-1",
      principalId: "session-owner",
      sessionId: "session-owner",
      workspaceId: "project-1",
      cwd: "/workspace",
      canonicalRoot: "/workspace/.moss",
      planHash: "a".repeat(64),
      selectionSnapshotSha256: "b".repeat(64),
      stateFingerprint: "c".repeat(64),
      stateRoot: "/server/state",
      nonce: "transaction-nonce",
      previousHash: "d".repeat(64),
      recordHash: "e".repeat(64),
      expiresAt: "2026-08-06T01:07:03.000Z",
      sequence: 0,
      createdAt: "2026-08-06T01:02:03.000Z",
      updatedAt: "2026-08-06T01:02:04.000Z",
      state: "applying",
      changes: [
        {
          operationId: "operation-1",
          phase: "intent",
          kind: "skill",
          provider: "claude",
          scope: "user",
          name: "release",
          canonicalIdentityKey: "identity-1",
          sourcePath: "/Users/moss/.claude/skills/release/SKILL.md",
          sourceSha256: "c".repeat(64),
          snapshotPath: "/server/state/blobs/sha256/" + "c".repeat(64),
          snapshotSha256: "c".repeat(64),
          targetPath: "/workspace/.moss/skills/release/SKILL.md",
          beforeHash: "e".repeat(64),
          expectedHash: "d".repeat(64),
          stagingPath: "/workspace/.moss/skills/release/.SKILL.md.tmp",
          markerPath: "/workspace/.moss/skills/release/.import-marker",
        },
      ],
    });

    expect(journal.schemaVersion).toBe(3);
    expect(journal.changes[0]?.canonicalIdentityKey).toBe("identity-1");
    expect(journal.changes[0]?.phase).toBe("intent");
    expect(journal.changes[0]?.stagingPath).toContain(".tmp");
    expect(() =>
      Schema.decodeUnknownSync(MossResourceImportJournal)({
        ...journal,
        schemaVersion: 1,
      }),
    ).toThrow();
  });

  it("defines one capability protocol with complete authority and fingerprint binding", () => {
    const canonicalRoot = {
      rootPath: "/workspace/.moss",
      identityFingerprint: "root-fingerprint",
      projectId: "project-1",
      workspaceId: "workspace-1",
      principalId: "principal-1",
      sessionId: "session-1",
    } satisfies MossFilesystemCapabilityInput["canonicalRoot"];
    const input = {
      cwd: "/workspace",
      canonicalRoot,
      projectId: "project-1",
      workspaceId: "workspace-1",
      principalId: "principal-1",
      sessionId: "session-1",
      targetPath: "/workspace/.moss/skills/release/SKILL.md",
      operationId: "operation-1",
      kind: "skill",
      fencingToken: "fence-1",
      generation: "generation-1",
      nonce: "nonce-1",
      expectedFingerprint: "root-fingerprint",
      expectedBeforeHash: "a".repeat(64),
      expected: {
        identityFingerprint: "before-identity",
        hash: "a".repeat(64),
      },
      expectedAfter: {
        identityFingerprint: "after-identity",
        hash: "b".repeat(64),
      },
    } satisfies MossFilesystemCapabilityInput;
    const receipt = {
      canonicalRoot,
      projectId: "project-1",
      workspaceId: "workspace-1",
      principalId: "principal-1",
      sessionId: input.sessionId,
      operationId: input.operationId,
      fencingToken: input.fencingToken,
      generation: input.generation,
      nonce: input.nonce,
      expected: input.expected,
      ...(input.expectedAfter ? { expectedAfter: input.expectedAfter } : {}),
      observed: {
        identityFingerprint: "after-identity",
        hash: "b".repeat(64),
      },
      afterHash: "b".repeat(64),
      durableObservedFingerprint: "after-identity",
      durable: true,
    } satisfies MossFilesystemCapabilityReceipt;

    expect(receipt.observed.hash).toBe("b".repeat(64));
  });

  it("requires lock fencing and private record methods on the single ownership store", () => {
    const lock = {
      ownerId: "owner-1",
      projectId: "project-1",
      workspaceId: "workspace-1",
      principalId: "principal-1",
      nonce: "nonce-1",
      fencingToken: "fence-1",
      generation: "generation-1",
      sessionId: "session-1",
      release: async () => undefined,
    } satisfies MossOwnershipLock;
    const store = {
      acquireLock: async () => lock,
      assertStateBudget: async () => undefined,
      createPrivateStage: async () => ({
        id: "stage-1",
        transactionId: "transaction-1",
        operationId: "operation-1",
        kind: "skill" as const,
        canonicalRoot: "/workspace/.moss",
        ownerId: "owner-1",
        projectId: "project-1",
        workspaceId: "workspace-1",
        principalId: "principal-1",
        sessionId: "session-1",
        fencingToken: "fence-1",
        generation: "generation-1",
        nonce: "stage-nonce-1",
        createdAt: "2026-08-06T01:02:03.000Z",
        leaseExpiresAt: "2026-08-06T01:07:03.000Z",
        opaque: {},
      }),
      appendPrivateManifest: async () => ({
        locator: "server-state://manifest",
        transactionId: "transaction-1",
        sequence: 0,
        previousHash: "0".repeat(64),
        recordHash: "1".repeat(64),
        ownerId: "owner-1",
        projectId: "project-1",
        workspaceId: "workspace-1",
        principalId: "principal-1",
        sessionId: "session-1",
        stateFingerprint: "2".repeat(64),
        nonce: "nonce-1",
        value: {},
      }),
      readPrivateManifest: async () => null,
      appendPrivateRecord: async () => ({
        locator: "server-state://record",
        transactionId: "transaction-1",
        sequence: 0,
        previousHash: "0".repeat(64),
        recordHash: "1".repeat(64),
        ownerId: "owner-1",
        projectId: "project-1",
        workspaceId: "workspace-1",
        principalId: "principal-1",
        sessionId: "session-1",
        stateFingerprint: "2".repeat(64),
        nonce: "nonce-1",
        value: {},
      }),
      readPrivateRecord: async () => null,
      listPrivateRecords: async () => [],
      publishPrivateSnapshot: async () => ({
        snapshotLocator: "server-state://snapshot",
        snapshotPath: "/server/state/snapshots/plugin-a/tree",
        snapshotSha256: "a".repeat(64),
        revision: "b".repeat(64),
        payloadBytes: 1,
        durable: true,
        sealed: true,
      }),
      recoverPrivateStages: async () => undefined,
    } satisfies MossOwnershipStore;

    expect(store).toBeDefined();
  });

  it("rejects a v3 journal record without its append-only hash chain fields", () => {
    expect(() =>
      Schema.decodeUnknownSync(MossResourceImportJournal)({
        schemaVersion: 3,
        transactionId: "transaction-missing-chain",
        planId: "plan-1",
        ownerId: "owner-1",
        issuer: "issuer-1",
        projectId: "project-1",
        principalId: "owner-1",
        sessionId: "session-1",
        workspaceId: "project-1",
        cwd: "/workspace",
        canonicalRoot: "/workspace/.moss",
        planHash: "a".repeat(64),
        selectionSnapshotSha256: "b".repeat(64),
        stateFingerprint: "c".repeat(64),
        stateRoot: "/server/state",
        nonce: "transaction-nonce",
        expiresAt: "2026-08-06T01:07:03.000Z",
        sequence: 0,
        createdAt: "2026-08-06T01:02:03.000Z",
        updatedAt: "2026-08-06T01:02:04.000Z",
        state: "prepared",
        changes: [],
      }),
    ).toThrow();
  });

  it("binds plans and receipts to one issuer, session, state, nonce, and expiry", () => {
    const plan = Schema.decodeUnknownSync(MossResourceImportPlanResult)({
      plan: {
        schemaVersion: 1,
        planId: "plan-bound",
        cwd: "/workspace",
        createdAt: "2026-08-07T00:00:00.000Z",
        expiresAt: "2026-08-07T00:05:00.000Z",
        issuer: "session-a",
        ownerId: "session-a",
        projectId: "project-1",
        principalId: "session-a",
        sessionId: "session-a",
        workspaceId: "project-1",
        stateFingerprint: "a".repeat(64),
        stateRoot: "/server/state",
        nonce: "plan-nonce",
        planHash: "b".repeat(64),
        selectedResourceIds: [],
        operations: [],
        issues: [],
        selectionSnapshotSha256: "c".repeat(64),
      },
    });
    expect((plan.plan as Record<string, unknown>).issuer).toBe("session-a");
    expect((plan.plan as Record<string, unknown>).expiresAt).toBe("2026-08-07T00:05:00.000Z");

    const journal = Schema.decodeUnknownSync(MossResourceImportJournal)({
      schemaVersion: 3,
      transactionId: "transaction-receipt",
      planId: "plan-bound",
      issuer: "session-a",
      ownerId: "session-a",
      projectId: "project-1",
      principalId: "session-a",
      sessionId: "session-a",
      workspaceId: "project-1",
      cwd: "/workspace",
      canonicalRoot: "/workspace/.moss",
      planHash: "b".repeat(64),
      selectionSnapshotSha256: "c".repeat(64),
      stateFingerprint: "a".repeat(64),
      stateRoot: "/server/state",
      nonce: "transaction-nonce",
      previousHash: "e".repeat(64),
      recordHash: "f".repeat(64),
      expiresAt: "2026-08-07T00:05:00.000Z",
      sequence: 0,
      createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:00.000Z",
      state: "prepared",
      changes: [
        {
          operationId: "operation-receipt",
          phase: "intent",
          kind: "skill",
          provider: "claude",
          scope: "user",
          name: "receipt",
          canonicalIdentityKey: "identity-receipt",
          sourcePath: "/Users/moss/.claude/skills/receipt/SKILL.md",
          sourceSha256: "d".repeat(64),
          snapshotPath: "/server/state/blobs/sha256/" + "d".repeat(64),
          snapshotSha256: "d".repeat(64),
          targetPath: "/workspace/.moss/skills/receipt/SKILL.md",
          beforeHash: "e".repeat(64),
          receiptPath: "/server/state/receipts/transaction-receipt-operation-receipt.json",
          receiptNonce: "receipt-nonce",
        },
      ],
    });
    expect((journal as Record<string, unknown>).sequence).toBe(0);
    expect((journal.changes[0] as Record<string, unknown>).receiptNonce).toBe("receipt-nonce");
  });
});
