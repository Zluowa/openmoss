import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  MossCanonicalRootDescriptor,
  MossFilesystemIdentity,
  MossOwnershipStore,
} from "@synara/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  makeMossCanonicalRecoveryJournal,
  readMossCanonicalRecoveryRecord,
  recoverMossCanonicalResourceMutation,
} from "./mossCanonicalResourceRecovery.ts";
import type { MossCanonicalRecoveryPhase } from "./mossCanonicalResourceRecovery.ts";
import { makeNodeMossOwnershipStore } from "./mossResourceImport.ts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const posixDurabilityIt = it.skipIf(process.platform === "win32");

describe("Moss canonical recovery binding", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "moss-canonical-recovery-binding-"));
    const stateParent = await mkdtemp(join(tmpdir(), "moss-canonical-recovery-binding-state-"));
    roots.push(root, stateParent);
    const stateDir = join(stateParent, "resource-import");
    await mkdir(stateDir, { mode: 0o700 });
    const ownershipStore = makeNodeMossOwnershipStore(stateDir);
    const targetPath = join(root, "target.txt");
    const canonicalRoot: MossCanonicalRootDescriptor = {
      rootPath: root,
      identityFingerprint: sha256(root),
      ownerId: "owner-1",
      projectId: "project-1",
      workspaceId: "workspace-1",
      principalId: "principal-1",
      sessionId: "session-1",
    };
    const expectedBefore: MossFilesystemIdentity = {
      identityFingerprint: "absent",
      hash: sha256("missing"),
    };
    const expectedAfter: MossFilesystemIdentity = {
      identityFingerprint: "after",
      hash: sha256("after"),
    };
    const binding = {
      currentOperationId: "operation-1",
      action: "create" as const,
      transactionId: "transaction-1",
      canonicalRoot,
      targetPath,
      expectedBefore,
      expectedAfter,
      fencingToken: "fence-1",
      generation: "generation-1",
      nonce: "nonce-1",
    } as const;
    return { root, targetPath, ownershipStore, binding };
  }

  async function appendIntent(
    ownershipStore: MossOwnershipStore,
    binding: Parameters<typeof makeMossCanonicalRecoveryJournal>[0]["binding"],
    phase: MossCanonicalRecoveryPhase = "intent",
  ) {
    return ownershipStore.appendPrivateManifest({
      fileName: "filesystem-mutations.json",
      transactionId: binding.transactionId,
      value: makeMossCanonicalRecoveryJournal({ binding, phase }),
      ownerId: binding.canonicalRoot.ownerId ?? binding.canonicalRoot.principalId,
      projectId: binding.canonicalRoot.projectId,
      workspaceId: binding.canonicalRoot.workspaceId,
      principalId: binding.canonicalRoot.principalId,
      sessionId: binding.canonicalRoot.sessionId,
      stateFingerprint: binding.canonicalRoot.identityFingerprint,
      nonce: binding.nonce,
    });
  }

  it("preserves the original transaction and request binding across pure journal phase changes", async () => {
    const { binding } = await fixture();
    const intent = makeMossCanonicalRecoveryJournal({
      binding: { ...binding, currentIdempotencyKey: "request-original" },
      phase: "intent",
    });
    const next = makeMossCanonicalRecoveryJournal({
      binding: {
        ...binding,
        currentOperationId: "later-operation",
        currentIdempotencyKey: "later-key",
        transactionId: "later-transaction",
        fencingToken: "new-fence",
        generation: "new-generation",
      },
      phase: "cas-observed",
      base: intent,
      observed: binding.expectedAfter,
    });
    expect(next).toMatchObject({
      phase: "cas-observed",
      transactionId: binding.transactionId,
      operationId: binding.currentOperationId,
      idempotencyKey: "request-original",
      planHash: intent.planHash,
      targetPath: binding.targetPath,
      fencingToken: "new-fence",
      generation: "new-generation",
      observed: binding.expectedAfter,
    });
  });

  it.each([{ schemaVersion: 2 }, { schemaVersion: 3, phase: "intent" }])(
    "rejects malformed journal values through a read-only store seam: %j",
    async (value) => {
      const { ownershipStore, binding } = await fixture();
      await expect(
        readMossCanonicalRecoveryRecord({
          ...ownershipStore,
          readPrivateManifest: async () => ({
            locator: "test://malformed",
            transactionId: binding.transactionId,
            sequence: 0,
            previousHash: "0".repeat(64),
            recordHash: "1".repeat(64),
            ownerId: binding.canonicalRoot.ownerId!,
            projectId: binding.canonicalRoot.projectId,
            workspaceId: binding.canonicalRoot.workspaceId,
            principalId: binding.canonicalRoot.principalId,
            sessionId: binding.canonicalRoot.sessionId,
            stateFingerprint: binding.canonicalRoot.identityFingerprint,
            nonce: binding.nonce,
            value,
          }),
        }),
      ).rejects.toMatchObject({ code: "transaction-invalid" });
    },
  );

  it.runIf(process.platform === "win32")(
    "refuses to confirm native journal durability and leaves canonical bytes untouched",
    async () => {
      const { root, targetPath, ownershipStore, binding } = await fixture();
      await writeFile(targetPath, "keep-canonical");
      await expect(appendIntent(ownershipStore, binding)).rejects.toMatchObject({
        code: "durability-unsupported",
      });
      expect(await readFile(targetPath, "utf8")).toBe("keep-canonical");
      expect(await readdir(root)).toEqual(["target.txt"]);
    },
  );

  posixDurabilityIt(
    "fails closed for unsupported and malformed recovery journal values",
    async () => {
      const { ownershipStore, binding } = await fixture();

      await ownershipStore.appendPrivateManifest({
        fileName: "filesystem-mutations.json",
        transactionId: binding.transactionId,
        value: { schemaVersion: 2 },
        ownerId: binding.canonicalRoot.ownerId!,
        projectId: binding.canonicalRoot.projectId,
        workspaceId: binding.canonicalRoot.workspaceId,
        principalId: binding.canonicalRoot.principalId,
        sessionId: binding.canonicalRoot.sessionId,
        stateFingerprint: binding.canonicalRoot.identityFingerprint,
        nonce: binding.nonce,
      });

      await expect(readMossCanonicalRecoveryRecord(ownershipStore)).rejects.toMatchObject({
        code: "transaction-invalid",
      });

      const malformedStateParent = await mkdtemp(join(tmpdir(), "moss-malformed-state-"));
      roots.push(malformedStateParent);
      await mkdir(join(malformedStateParent, "resource-import"), { mode: 0o700 });
      const malformedStore = makeNodeMossOwnershipStore(
        join(malformedStateParent, "resource-import"),
      );
      const malformed = { ...binding, transactionId: "transaction-malformed" };
      await malformedStore.appendPrivateManifest({
        fileName: "filesystem-mutations.json",
        transactionId: malformed.transactionId,
        value: { schemaVersion: 3, phase: "intent" },
        ownerId: malformed.canonicalRoot.ownerId!,
        projectId: malformed.canonicalRoot.projectId,
        workspaceId: malformed.canonicalRoot.workspaceId,
        principalId: malformed.canonicalRoot.principalId,
        sessionId: malformed.canonicalRoot.sessionId,
        stateFingerprint: malformed.canonicalRoot.identityFingerprint,
        nonce: malformed.nonce,
      });
      await expect(readMossCanonicalRecoveryRecord(malformedStore)).rejects.toMatchObject({
        code: "transaction-invalid",
      });
    },
  );

  posixDurabilityIt("rejects a journal whose transaction binding changed", async () => {
    const { ownershipStore, binding, targetPath } = await fixture();
    await appendIntent(ownershipStore, binding);
    await writeFile(targetPath, "after");

    await expect(
      recoverMossCanonicalResourceMutation({
        ownershipStore,
        binding: { ...binding, transactionId: "transaction-new" },
      }),
    ).rejects.toMatchObject({ code: "concurrent-modification" });
    await expect(readMossCanonicalRecoveryRecord(ownershipStore)).resolves.toMatchObject({
      journal: { phase: "intent", transactionId: binding.transactionId },
    });
  });

  posixDurabilityIt("rejects a journal whose stable idempotency key changed", async () => {
    const { ownershipStore, binding, targetPath } = await fixture();
    await appendIntent(ownershipStore, binding);
    await writeFile(targetPath, "after");

    await expect(
      recoverMossCanonicalResourceMutation({
        ownershipStore,
        binding: { ...binding, currentIdempotencyKey: "idempotency-2" },
      }),
    ).rejects.toMatchObject({ code: "concurrent-modification" });
    await expect(readMossCanonicalRecoveryRecord(ownershipStore)).resolves.toMatchObject({
      journal: { phase: "intent", idempotencyKey: binding.currentOperationId },
    });
  });

  posixDurabilityIt("settles a post-CAS journal only with the current fencing lease", async () => {
    const { ownershipStore, binding, targetPath } = await fixture();
    await appendIntent(ownershipStore, binding, "cas-observed");
    await writeFile(targetPath, "after");

    const recovered = await recoverMossCanonicalResourceMutation({
      ownershipStore,
      binding: {
        ...binding,
        fencingToken: "fence-new",
        generation: "generation-new",
        nonce: "nonce-new",
      },
    });
    expect(recovered).toMatchObject({
      status: "committed",
      receipt: {
        fencingToken: "fence-new",
        generation: "generation-new",
        nonce: "nonce-new",
      },
    });
    await expect(readMossCanonicalRecoveryRecord(ownershipStore)).resolves.toMatchObject({
      journal: {
        phase: "committed",
        fencingToken: "fence-new",
        generation: "generation-new",
        nonce: "nonce-new",
      },
    });
  });

  posixDurabilityIt(
    "does not settle a different operation or transaction over an after-state",
    async () => {
      const { ownershipStore, binding, targetPath } = await fixture();
      await appendIntent(ownershipStore, binding);
      await writeFile(targetPath, "after");

      await expect(
        recoverMossCanonicalResourceMutation({
          ownershipStore,
          binding: {
            ...binding,
            currentOperationId: "operation-2",
            transactionId: "transaction-2",
          },
        }),
      ).rejects.toMatchObject({ code: "concurrent-modification" });
      await expect(readMossCanonicalRecoveryRecord(ownershipStore)).resolves.toMatchObject({
        journal: { phase: "intent", operationId: binding.currentOperationId },
      });
    },
  );

  posixDurabilityIt(
    "replays a committed journal idempotently without changing its receipt",
    async () => {
      const { ownershipStore, binding, targetPath } = await fixture();
      await appendIntent(ownershipStore, binding);
      await writeFile(targetPath, "after");
      const first = await recoverMossCanonicalResourceMutation({ ownershipStore, binding });
      const second = await recoverMossCanonicalResourceMutation({ ownershipStore, binding });

      expect(first.status).toBe("committed");
      expect(second).toEqual(first);
    },
  );
});
