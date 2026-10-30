import { mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { MossCanonicalResourceMutationPayload, MossOwnershipStore } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const compactionBarrier = vi.hoisted(() => ({
  beforeRename: undefined as
    | ((oldPath: string | URL, newPath: string | URL) => void | Promise<void>)
    | undefined,
  beforeUnlink: undefined as ((path: string | URL) => void | Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (oldPath: string | URL, newPath: string | URL) => {
      await compactionBarrier.beforeRename?.(oldPath, newPath);
      return actual.rename(oldPath, newPath);
    },
    unlink: async (path: string | URL) => {
      await compactionBarrier.beforeUnlink?.(path);
      return actual.unlink(path);
    },
  };
});

import {
  deriveMossCanonicalMutationIdempotencyKey,
  gcMossPrivatePlanRegistry,
  issueMossCanonicalMutationPlan,
  registerMossResourceImportPlan,
  resolveMossCanonicalMutationPlan,
} from "./mossCanonicalMutationIntent.ts";
import { makeNodeMossOwnershipStore } from "./mossResourceImport.ts";

// Real plan registry persistence requires POSIX directory fsync and no-follow paths.
const posixDurabilityIt = it.skipIf(process.platform === "win32");

describe("Moss canonical mutation intent registry", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture() {
    const stateParent = await mkdtemp(join(tmpdir(), "moss-canonical-intent-state-"));
    const workspace = await mkdtemp(join(tmpdir(), "moss-canonical-intent-workspace-"));
    const stateDir = join(stateParent, "resource-import");
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    roots.push(stateParent, workspace);
    const ownershipStore = makeNodeMossOwnershipStore(stateDir);
    const scope = {
      cwd: workspace,
      issuer: "moss-server",
      ownerId: "owner-1",
      projectId: "project-1",
      principalId: "principal-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
    } as const;
    const payload: MossCanonicalResourceMutationPayload = {
      kind: "plugin",
      cwd: workspace,
      name: "Immutable Plugin",
    };
    return { ownershipStore, stateDir, scope, payload };
  }

  it("binds a deterministic request key to private plan and authority identities without filesystem access", () => {
    const plan: Parameters<typeof deriveMossCanonicalMutationIdempotencyKey>[0]["plan"] = {
      planId: "plan-a",
      operationId: "operation-a",
      planHash: "a".repeat(64),
      action: "create",
      targetPath: ".moss/plugins/example",
      issuer: "moss-server",
      ownerId: "owner-a",
      projectId: "project-a",
      workspaceId: "workspace-a",
      principalId: "principal-a",
      sessionId: "session-a",
    };
    const key = deriveMossCanonicalMutationIdempotencyKey({ plan });
    expect(deriveMossCanonicalMutationIdempotencyKey({ plan: { ...plan } })).toBe(key);
    for (const changed of [
      { planId: "plan-b" },
      { operationId: "operation-b" },
      { ownerId: "owner-b" },
      { workspaceId: "workspace-b" },
      { sessionId: "session-b" },
      { selectionTicketDigest: "b".repeat(64) },
    ]) {
      expect(deriveMossCanonicalMutationIdempotencyKey({ plan: { ...plan, ...changed } })).not.toBe(
        key,
      );
    }
  });

  it.runIf(process.platform === "win32")(
    "refuses to issue a durable native mutation plan without changing the canonical workspace",
    async () => {
      const { ownershipStore, stateDir, scope, payload } = await fixture();
      const sentinel = join(scope.cwd, "sentinel");
      await writeFile(sentinel, "keep-canonical");
      await expect(
        issueMossCanonicalMutationPlan({
          ownershipStore,
          stateDir,
          scope,
          action: "create",
          payload,
        }),
      ).rejects.toMatchObject({ code: "durability-unsupported" });
      expect(await readFile(sentinel, "utf8")).toBe("keep-canonical");
      expect(await readdir(scope.cwd)).toEqual(["sentinel"]);
    },
  );

  posixDurabilityIt(
    "derives a stable key for the same private plan and distinct keys for equal-content plans",
    async () => {
      const { ownershipStore, stateDir, scope, payload } = await fixture();
      const first = await issueMossCanonicalMutationPlan({
        ownershipStore,
        stateDir,
        scope,
        action: "create",
        payload,
      });
      const second = await issueMossCanonicalMutationPlan({
        ownershipStore,
        stateDir,
        scope,
        action: "create",
        payload,
      });
      const firstResolved = await resolveMossCanonicalMutationPlan({
        ownershipStore,
        planId: first.planId,
        operationId: first.operationId,
        scope,
        action: "create",
      });
      const replayed = await resolveMossCanonicalMutationPlan({
        ownershipStore,
        planId: first.planId,
        operationId: first.operationId,
        scope,
        action: "create",
      });

      expect(firstResolved.intentKey).toBe(replayed.intentKey);
      expect(firstResolved.intentKey).toBe(
        deriveMossCanonicalMutationIdempotencyKey({ plan: first }),
      );
      expect(firstResolved.intentKey).not.toBe(
        deriveMossCanonicalMutationIdempotencyKey({ plan: second }),
      );
    },
  );

  posixDurabilityIt(
    "rejects forged operation ids, expired plans, and cross-workspace callers",
    async () => {
      const { ownershipStore, stateDir, scope, payload } = await fixture();
      const plan = await issueMossCanonicalMutationPlan({
        ownershipStore,
        stateDir,
        scope,
        action: "create",
        payload,
        planTtlMillis: 1_000,
        now: () => new Date("2026-08-09T00:00:00.000Z"),
      });

      await expect(
        resolveMossCanonicalMutationPlan({
          ownershipStore,
          planId: plan.planId,
          operationId: "operation-forged",
          scope,
          action: "create",
        }),
      ).rejects.toMatchObject({ code: "authorization-required" });
      await expect(
        resolveMossCanonicalMutationPlan({
          ownershipStore,
          planId: plan.planId,
          operationId: plan.operationId,
          scope: { ...scope, workspaceId: "workspace-other" },
          action: "create",
        }),
      ).rejects.toMatchObject({ code: "authorization-required" });
      await expect(
        resolveMossCanonicalMutationPlan({
          ownershipStore,
          planId: plan.planId,
          operationId: plan.operationId,
          scope,
          action: "create",
          now: new Date("2026-08-09T00:00:02.000Z"),
        }),
      ).rejects.toMatchObject({ code: "plan-expired" });
    },
  );

  posixDurabilityIt(
    "rejects private plan tampering and action/target mismatches before resolution",
    async () => {
      const { ownershipStore, stateDir, scope, payload } = await fixture();
      const plan = await issueMossCanonicalMutationPlan({
        ownershipStore,
        stateDir,
        scope,
        action: "create",
        payload,
      });
      const baseStore = ownershipStore;
      const tamperedStore: MossOwnershipStore = {
        ...baseStore,
        readPrivateRecord: async (input) => {
          const record = await baseStore.readPrivateRecord(input);
          if (!record) return record;
          return {
            ...record,
            value: { ...(record.value as object), planHash: "f".repeat(64) },
          };
        },
      };
      await expect(
        resolveMossCanonicalMutationPlan({
          ownershipStore: tamperedStore,
          planId: plan.planId,
          operationId: plan.operationId,
          scope,
          action: "create",
        }),
      ).rejects.toMatchObject({ code: "plan-invalid" });
      await expect(
        resolveMossCanonicalMutationPlan({
          ownershipStore,
          planId: plan.planId,
          operationId: plan.operationId,
          scope,
          action: "delete",
        }),
      ).rejects.toMatchObject({ code: "authorization-required" });
    },
  );

  posixDurabilityIt("records an expiry tombstone and defers unsafe plan compaction", async () => {
    const { ownershipStore, stateDir, scope, payload } = await fixture();
    const createdAt = new Date("2026-08-09T00:00:00.000Z");
    const plan = await issueMossCanonicalMutationPlan({
      ownershipStore,
      stateDir,
      scope,
      action: "create",
      payload,
      planTtlMillis: 1_000,
      now: () => createdAt,
    });

    await expect(
      gcMossPrivatePlanRegistry({
        ownershipStore,
        scope,
        now: new Date("2026-08-09T00:00:02.000Z"),
      }),
    ).rejects.toMatchObject({
      code: "durability-unsupported",
      message: expect.stringContaining("GC-deferred"),
    });
    const auditFiles = await ownershipStore.listPrivateRecords({ prefix: "plan-gc" });
    expect(auditFiles.length).toBeGreaterThan(0);
    const audit = await ownershipStore.readPrivateRecord({ fileName: auditFiles[0]! });
    expect(audit?.value).toMatchObject({
      kind: "moss-plan-expired-tombstone",
      planId: plan.planId,
      planHash: plan.planHash,
      payloadDigest: expect.any(String),
      compactedRecordHash: expect.any(String),
    });
    await expect(
      ownershipStore.readPrivateRecord({ fileName: `canonical-plans/${plan.planId}.json` }),
    ).resolves.toMatchObject({ value: expect.objectContaining({ planId: plan.planId }) });
  });

  posixDurabilityIt("keeps active plans bounded and defers expired reclamation", async () => {
    const { ownershipStore, stateDir, scope, payload } = await fixture();
    const registry = {
      maxPlansPerWorkspace: 1,
      maxBytesPerWorkspace: 64 * 1024,
      maxTombstoneRecords: 2,
    } as const;
    const active = await issueMossCanonicalMutationPlan({
      ownershipStore,
      stateDir,
      scope,
      action: "create",
      payload,
      planTtlMillis: 1_000,
      registry,
      now: () => new Date("2026-08-09T00:00:00.000Z"),
    });
    await expect(
      issueMossCanonicalMutationPlan({
        ownershipStore,
        stateDir,
        scope,
        action: "create",
        payload: { ...payload, name: "Second Active Plugin" },
        planTtlMillis: 60 * 60 * 1_000,
        registry,
        now: () => new Date("2026-08-09T00:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "plan-budget-exceeded" });

    await expect(
      issueMossCanonicalMutationPlan({
        ownershipStore,
        stateDir,
        scope,
        action: "create",
        payload: { ...payload, name: "Short Lived Plugin 0" },
        planTtlMillis: 1_000,
        registry,
        now: () => new Date("2026-08-09T00:00:02.000Z"),
      }),
    ).rejects.toMatchObject({ code: "durability-unsupported" });

    const canonicalFiles = await ownershipStore.listPrivateRecords({ prefix: "canonical-plans" });
    const auditFiles = await ownershipStore.listPrivateRecords({ prefix: "plan-gc" });
    expect(canonicalFiles.length).toBeLessThanOrEqual(1);
    expect(auditFiles.length).toBe(1);
    await expect(
      ownershipStore.readPrivateRecord({ fileName: `canonical-plans/${active.planId}.json` }),
    ).resolves.toMatchObject({ value: expect.objectContaining({ planId: active.planId }) });
  });

  posixDurabilityIt(
    "serializes concurrent plan issuance and reports deferred expiry GC under the authority lock",
    async () => {
      const { ownershipStore, stateDir, scope, payload } = await fixture();
      const registry = {
        maxPlansPerWorkspace: 2,
        maxBytesPerWorkspace: 64 * 1024,
        maxTombstoneRecords: 2,
      } as const;
      const plan = await issueMossCanonicalMutationPlan({
        ownershipStore,
        stateDir,
        scope,
        action: "create",
        payload,
        planTtlMillis: 1_000,
        now: () => new Date("2026-08-09T00:00:00.000Z"),
        registry,
      });

      const [gcResult, issueResult] = await Promise.allSettled([
        gcMossPrivatePlanRegistry({
          ownershipStore,
          scope,
          now: new Date("2026-08-09T00:00:02.000Z"),
          registry,
        }),
        issueMossCanonicalMutationPlan({
          ownershipStore,
          stateDir,
          scope,
          action: "create",
          payload: { ...payload, name: "Concurrent Plugin" },
          planTtlMillis: 60 * 60 * 1_000,
          now: () => new Date("2026-08-09T00:00:02.000Z"),
          registry,
        }),
      ]);

      expect(gcResult).toMatchObject({
        status: "rejected",
        reason: { code: "durability-unsupported" },
      });
      expect(issueResult).toMatchObject({
        status: "rejected",
        reason: { code: "durability-unsupported" },
      });
      await expect(
        ownershipStore.readPrivateRecord({ fileName: `canonical-plans/${plan.planId}.json` }),
      ).resolves.toMatchObject({ value: expect.objectContaining({ planId: plan.planId }) });
    },
  );

  posixDurabilityIt("rejects a plan that exceeds the bounded workspace byte budget", async () => {
    const { ownershipStore, stateDir, scope, payload } = await fixture();
    await expect(
      issueMossCanonicalMutationPlan({
        ownershipStore,
        stateDir,
        scope,
        action: "create",
        payload: {
          ...payload,
          name: "A plan whose serialized registry record exceeds the byte budget",
        },
        registry: { maxPlansPerWorkspace: 128, maxBytesPerWorkspace: 128 },
      }),
    ).rejects.toMatchObject({ code: "plan-budget-exceeded" });
  });

  posixDurabilityIt("applies the same expiry tombstone lifecycle to import plans", async () => {
    const { ownershipStore, stateDir, scope } = await fixture();
    const plan = {
      schemaVersion: 1 as const,
      planId: "plan-import-expiring",
      cwd: scope.cwd,
      createdAt: "2026-08-09T00:00:00.000Z",
      expiresAt: "2026-08-09T00:00:01.000Z",
      issuer: scope.issuer,
      ownerId: scope.ownerId,
      projectId: scope.projectId,
      principalId: scope.principalId,
      sessionId: scope.sessionId,
      workspaceId: scope.workspaceId,
      stateFingerprint: "a".repeat(64),
      stateRoot: stateDir,
      nonce: "nonce-import-expiring",
      planHash: "b".repeat(64),
      selectedResourceIds: [],
      operations: [],
      issues: [],
      selectionSnapshotSha256: "c".repeat(64),
    };
    const { createHash } = await import("node:crypto");
    const { planHash: _planHash, ...unsigned } = plan;
    const stable = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(stable);
      if (value !== null && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => [key, stable(entry)]),
        );
      }
      return value;
    };
    const importPlan = {
      ...plan,
      planHash: createHash("sha256")
        .update(JSON.stringify(stable(unsigned)))
        .digest("hex"),
    };
    await registerMossResourceImportPlan({ ownershipStore, plan: importPlan });
    await expect(
      gcMossPrivatePlanRegistry({
        ownershipStore,
        scope,
        now: new Date("2026-08-09T00:00:02.000Z"),
      }),
    ).rejects.toMatchObject({ code: "durability-unsupported" });
    await expect(
      ownershipStore.readPrivateRecord({
        fileName: `import-plans/${importPlan.planId}.json`,
      }),
    ).resolves.toMatchObject({ value: expect.objectContaining({ planId: importPlan.planId }) });
  });

  posixDurabilityIt(
    "requires the ownership-store fencing lock for private record compaction",
    async () => {
      const { ownershipStore, stateDir, scope, payload } = await fixture();
      const plan = await issueMossCanonicalMutationPlan({
        ownershipStore,
        stateDir,
        scope,
        action: "create",
        payload,
        planTtlMillis: 1_000,
        now: () => new Date("2026-08-09T00:00:00.000Z"),
      });
      const record = await ownershipStore.readPrivateRecord({
        fileName: `canonical-plans/${plan.planId}.json`,
      });
      expect(record).not.toBeNull();

      await expect(
        ownershipStore.compactPrivateRecord!({
          fileName: `canonical-plans/${plan.planId}.json`,
          expectedSequence: record!.sequence,
          expectedRecordHash: record!.recordHash,
          ownerId: scope.ownerId,
          projectId: scope.projectId,
          workspaceId: scope.workspaceId,
          principalId: scope.principalId,
          sessionId: scope.sessionId,
          stateFingerprint: record!.stateFingerprint,
          nonce: record!.nonce,
        } as unknown as Parameters<NonNullable<MossOwnershipStore["compactPrivateRecord"]>>[0]),
      ).rejects.toMatchObject({ code: "concurrent-modification" });
      await expect(
        ownershipStore.readPrivateRecord({ fileName: `canonical-plans/${plan.planId}.json` }),
      ).resolves.not.toBeNull();
    },
  );

  posixDurabilityIt(
    "retains the payload when the expected private record head no longer matches",
    async () => {
      const { ownershipStore, stateDir, scope, payload } = await fixture();
      const plan = await issueMossCanonicalMutationPlan({
        ownershipStore,
        stateDir,
        scope,
        action: "create",
        payload,
      });
      const record = await ownershipStore.readPrivateRecord({
        fileName: `canonical-plans/${plan.planId}.json`,
      });
      expect(record).not.toBeNull();
      const lock = await ownershipStore.acquireLock({
        cwd: scope.cwd,
        ownerId: scope.ownerId,
        projectId: scope.projectId,
        workspaceId: scope.workspaceId,
        principalId: scope.principalId,
        sessionId: scope.sessionId,
        nonce: "head-mismatch-test",
      });
      try {
        await expect(
          ownershipStore.compactPrivateRecord!({
            lock,
            fileName: `canonical-plans/${plan.planId}.json`,
            expectedSequence: record!.sequence,
            expectedRecordHash: "f".repeat(64),
            ownerId: scope.ownerId,
            projectId: scope.projectId,
            workspaceId: scope.workspaceId,
            principalId: scope.principalId,
            sessionId: scope.sessionId,
            stateFingerprint: record!.stateFingerprint,
            nonce: record!.nonce,
          }),
        ).rejects.toMatchObject({ code: "concurrent-modification" });
      } finally {
        await lock.release();
      }
      await expect(
        ownershipStore.readPrivateRecord({ fileName: `canonical-plans/${plan.planId}.json` }),
      ).resolves.toMatchObject({ recordHash: record!.recordHash });
    },
  );

  posixDurabilityIt("does not collect an active plan before its expiry", async () => {
    const { ownershipStore, stateDir, scope, payload } = await fixture();
    const plan = await issueMossCanonicalMutationPlan({
      ownershipStore,
      stateDir,
      scope,
      action: "create",
      payload,
      planTtlMillis: 60_000,
      now: () => new Date("2026-08-09T00:00:00.000Z"),
    });

    await expect(
      gcMossPrivatePlanRegistry({
        ownershipStore,
        scope,
        now: new Date("2026-08-09T00:00:00.500Z"),
      }),
    ).resolves.toMatchObject({ expiredPlans: 0, compactedPlans: 0 });
    await expect(
      ownershipStore.readPrivateRecord({ fileName: `canonical-plans/${plan.planId}.json` }),
    ).resolves.toMatchObject({ value: expect.objectContaining({ planId: plan.planId }) });
  });

  posixDurabilityIt("fails closed when a private plan parent is swapped to a symlink", async () => {
    const { ownershipStore, stateDir, scope, payload } = await fixture();
    await issueMossCanonicalMutationPlan({
      ownershipStore,
      stateDir,
      scope,
      action: "create",
      payload,
    });
    const canonicalDirectory = join(stateDir, "canonical-plans");
    const savedDirectory = join(stateDir, "canonical-plans.saved");
    let swapped = false;
    try {
      await rename(canonicalDirectory, savedDirectory);
      await symlink(scope.cwd, canonicalDirectory);
      swapped = true;
      await expect(
        gcMossPrivatePlanRegistry({
          ownershipStore,
          scope,
          now: new Date("2026-08-09T00:01:00.000Z"),
        }),
      ).rejects.toMatchObject({ code: "symlink-escape" });
    } finally {
      if (swapped) {
        await unlink(canonicalDirectory).catch(() => undefined);
        await rename(savedDirectory, canonicalDirectory).catch(() => undefined);
      }
    }
  });

  posixDurabilityIt(
    "does not move a plan through a parent swapped after the final compaction guard",
    async () => {
      const { ownershipStore, stateDir, scope, payload } = await fixture();
      const plan = await issueMossCanonicalMutationPlan({
        ownershipStore,
        stateDir,
        scope,
        action: "create",
        payload,
        planTtlMillis: 1_000,
        now: () => new Date("2026-08-09T00:00:00.000Z"),
      });
      const canonicalDirectory = join(stateDir, "canonical-plans");
      const savedDirectory = join(stateDir, "canonical-plans.saved");
      const planPath = join(canonicalDirectory, `${plan.planId}.json`);
      const outsidePlanPath = join(scope.cwd, `${plan.planId}.json`);
      await writeFile(outsidePlanPath, "outside-plan\n");
      let swapped = false;
      compactionBarrier.beforeRename = async (oldPath) => {
        if (!swapped && oldPath === planPath) {
          renameSync(canonicalDirectory, savedDirectory);
          symlinkSync(scope.cwd, canonicalDirectory);
          swapped = true;
        }
      };
      try {
        await gcMossPrivatePlanRegistry({
          ownershipStore,
          scope,
          now: new Date("2026-08-09T00:00:02.000Z"),
        }).catch(() => undefined);
      } finally {
        compactionBarrier.beforeRename = undefined;
        if (swapped) {
          await unlink(canonicalDirectory).catch(() => undefined);
          await rename(savedDirectory, canonicalDirectory).catch(() => undefined);
        }
      }

      await expect(readFile(outsidePlanPath, "utf8")).resolves.toBe("outside-plan\n");
    },
  );

  posixDurabilityIt(
    "does not unlink through a private trash parent swapped after the final guard",
    async () => {
      const { ownershipStore, stateDir, scope, payload } = await fixture();
      await issueMossCanonicalMutationPlan({
        ownershipStore,
        stateDir,
        scope,
        action: "create",
        payload,
        planTtlMillis: 1_000,
        now: () => new Date("2026-08-09T00:00:00.000Z"),
      });
      const trashDirectory = join(stateDir, ".trash");
      const savedTrashDirectory = join(stateDir, ".trash.saved");
      const outsideTrashDirectory = join(scope.cwd, "trash-target");
      let swapped = false;
      let outsideTrashPath: string | undefined;
      compactionBarrier.beforeUnlink = async (targetPath) => {
        if (
          !swapped &&
          typeof targetPath === "string" &&
          targetPath.startsWith(`${trashDirectory}/`)
        ) {
          renameSync(trashDirectory, savedTrashDirectory);
          mkdirSync(outsideTrashDirectory, { recursive: true });
          outsideTrashPath = join(outsideTrashDirectory, basename(targetPath));
          writeFileSync(outsideTrashPath, "outside-trash\n");
          symlinkSync(outsideTrashDirectory, trashDirectory);
          swapped = true;
        }
      };
      try {
        await gcMossPrivatePlanRegistry({
          ownershipStore,
          scope,
          now: new Date("2026-08-09T00:00:02.000Z"),
        }).catch(() => undefined);
      } finally {
        compactionBarrier.beforeUnlink = undefined;
        if (swapped) {
          await unlink(trashDirectory).catch(() => undefined);
          await rename(savedTrashDirectory, trashDirectory).catch(() => undefined);
        }
      }

      if (outsideTrashPath) {
        await expect(readFile(outsideTrashPath, "utf8")).resolves.toBe("outside-trash\n");
      }
    },
  );

  posixDurabilityIt(
    "does not move a replacement through a path that changed after the final guard",
    async () => {
      const { ownershipStore, stateDir, scope, payload } = await fixture();
      const plan = await issueMossCanonicalMutationPlan({
        ownershipStore,
        stateDir,
        scope,
        action: "create",
        payload,
        planTtlMillis: 1_000,
        now: () => new Date("2026-08-09T00:00:00.000Z"),
      });
      const canonicalDirectory = join(stateDir, "canonical-plans");
      const planPath = join(canonicalDirectory, `${plan.planId}.json`);
      const savedOriginalPath = join(stateDir, `${plan.planId}.original.json`);
      let replaced = false;
      compactionBarrier.beforeRename = async (oldPath) => {
        if (!replaced && oldPath === planPath) {
          renameSync(planPath, savedOriginalPath);
          writeFileSync(planPath, "replacement-plan\n");
          replaced = true;
        }
      };
      let safePathState = false;
      try {
        await gcMossPrivatePlanRegistry({
          ownershipStore,
          scope,
          now: new Date("2026-08-09T00:00:02.000Z"),
        }).catch(() => undefined);
        safePathState = await readFile(planPath, "utf8")
          .then((contents) => !replaced || contents === "replacement-plan\n")
          .catch(() => false);
      } finally {
        compactionBarrier.beforeRename = undefined;
        await rm(planPath, { force: true }).catch(() => undefined);
        await rename(savedOriginalPath, planPath).catch(() => undefined);
      }

      expect(safePathState).toBe(true);
    },
  );
});
