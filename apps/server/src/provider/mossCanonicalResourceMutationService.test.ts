import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type {
  MossCanonicalResourceMutationPayload,
  MossCanonicalResourceMutationAction,
  MossOwnershipStore,
} from "@synara/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { makeMossCanonicalFilesystemHelper } from "./mossCanonicalFilesystemHelper.ts";
import { canonicalFilesystemHelperTestArch } from "./mossCanonicalFilesystemHelperTestRuntime.ts";
import { makeMossNativeFilesystemCapability } from "./mossNativeFilesystemCapability.ts";
import { makeNodeMossOwnershipStore, MossResourceImportError } from "./mossResourceImport.ts";
import { makeMossCanonicalResourceMutationService } from "./mossCanonicalResourceMutationService.ts";
import { issueMossCanonicalMutationPlan } from "./mossCanonicalMutationIntent.ts";

const execFile = promisify(execFileCallback);
const testHelperPath = join(
  process.cwd(),
  "native/moss-canonical-filesystem-helper/build/moss-canonical-filesystem-helper-mutation-test",
);
const describeWithCanonicalFilesystemHelper =
  canonicalFilesystemHelperTestArch === null ? describe.skip : describe;

beforeAll(async () => {
  if (canonicalFilesystemHelperTestArch === null) return;
  await execFile(
    process.execPath,
    [
      "scripts/build-canonical-filesystem-helper.mjs",
      "--arch",
      canonicalFilesystemHelperTestArch,
      "--test-hooks",
      "--output",
      testHelperPath,
    ],
    { cwd: process.cwd() },
  );
});

afterAll(async () => {
  if (canonicalFilesystemHelperTestArch === null) return;
  await rm(testHelperPath, { force: true });
  await rm(`${testHelperPath}.build.json`, { force: true });
});

function makeTestNativeFilesystemCapability(
  options: Parameters<typeof makeMossNativeFilesystemCapability>[0],
) {
  return makeMossNativeFilesystemCapability({
    ...options,
    filesystemHelper: makeMossCanonicalFilesystemHelper({
      helperPath: testHelperPath,
      timeoutMs: 5_000,
    }),
  });
}

describeWithCanonicalFilesystemHelper("Moss canonical resource mutation service", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture(
    options: {
      readonly beforeMutation?: Parameters<
        typeof makeMossNativeFilesystemCapability
      >[0]["beforeMutation"];
    } = {},
  ) {
    const root = await mkdtemp(join(tmpdir(), "moss-canonical-mutation-workspace-"));
    const stateParent = await mkdtemp(join(tmpdir(), "moss-canonical-mutation-state-"));
    roots.push(root, stateParent);
    const stateDir = join(stateParent, "resource-import");
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const ownershipStore = makeNodeMossOwnershipStore(stateDir);
    const filesystemCapability = makeTestNativeFilesystemCapability({
      ownershipStore,
      readStage: async (stage) => ownershipStore.readPrivateStage!({ stage }),
      ...(options.beforeMutation ? { beforeMutation: options.beforeMutation } : {}),
    });
    const service = makeMossCanonicalResourceMutationService({
      ownershipStore,
      filesystemCapability,
      stateDir,
    });
    const context = {
      cwd: root,
      ownerId: "owner-1",
      projectId: "project-1",
      workspaceId: "workspace-1",
      principalId: "principal-1",
      sessionId: "session-1",
      issuer: "issuer-1",
    } as const;
    const issue = async (
      action: MossCanonicalResourceMutationAction,
      payload: MossCanonicalResourceMutationPayload,
    ) => {
      const plan = await issueMossCanonicalMutationPlan({
        ownershipStore,
        stateDir,
        scope: context,
        action,
        payload,
      });
      return { planId: plan.planId, operationId: plan.operationId } as const;
    };
    return { root, stateDir, ownershipStore, filesystemCapability, service, context, issue };
  }

  it("creates, updates, and removes canonical plugin state through durable receipts", async () => {
    const { root, service, context, issue } = await fixture();
    const createIntent = await issue("create", {
      kind: "plugin",
      cwd: root,
      name: "Review Tools",
      description: "Review files.",
    });
    const created = await service.create(
      {
        cwd: root,
        ...createIntent,
      },
      context,
    );
    expect(created.created).toBe(true);
    expect(created.receipt).toMatchObject({
      schemaVersion: 3,
      transactionId: expect.any(String),
      operationId: expect.any(String),
      idempotencyKey: expect.any(String),
      planHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      canonicalRoot: {
        rootPath: expect.any(String),
        identityFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        ownerId: "owner-1",
        projectId: "project-1",
        workspaceId: "workspace-1",
        principalId: "principal-1",
        sessionId: "session-1",
      },
      targetPath: join(root, ".moss", "plugins", "review-tools"),
      expectedBefore: {
        identityFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
      expectedAfter: {
        identityFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
      observed: {
        identityFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
      fencingToken: expect.any(String),
      generation: expect.any(String),
      nonce: expect.any(String),
      manifest: {
        fileName: "filesystem-mutations.json",
        sequence: expect.any(Number),
        previousHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        recordHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
      durable: true,
      afterState: [{ state: "present", durable: true }],
    });
    await expect(readFile(created.path, "utf8")).resolves.toContain('"enabled": true');

    const updateIntent = await issue("update", {
      kind: "plugin",
      cwd: root,
      name: "Review Tools",
      enabled: false,
    });
    const updated = await service.update(
      {
        cwd: root,
        ...updateIntent,
      },
      context,
    );
    expect(updated.updated).toBe(true);
    expect(updated.receipt).toMatchObject({ afterState: [{ state: "present", durable: true }] });
    if (!updated.path) throw new Error("Expected the updated plugin path.");
    await expect(readFile(updated.path, "utf8")).resolves.toContain('"enabled": false');

    const deleteIntent = await issue("delete", {
      kind: "plugin",
      cwd: root,
      name: "Review Tools",
    });
    const removed = await service.delete({ cwd: root, ...deleteIntent }, context);
    expect(removed.removed).toBe(true);
    expect(removed.receipt).toMatchObject({ afterState: [{ state: "absent", durable: true }] });
  });

  it("uses one canonical MCP file and preserves typed durable receipts", async () => {
    const { root, service, context, issue } = await fixture();
    const createIntent = await issue("create", {
      kind: "mcp",
      cwd: root,
      name: "docs",
      command: "node",
      args: ["server.js"],
    });
    const created = await service.create(
      {
        cwd: root,
        ...createIntent,
      },
      context,
    );
    expect(created.created).toBe(true);
    await expect(readFile(created.path, "utf8")).resolves.toContain('"docs"');

    const updateIntent = await issue("update", {
      kind: "mcp",
      cwd: root,
      name: "docs",
      enabled: false,
    });
    const updated = await service.update({ cwd: root, ...updateIntent }, context);
    expect(updated.updated).toBe(true);
    if (!updated.path) throw new Error("Expected the updated MCP config path.");
    await expect(readFile(updated.path, "utf8")).resolves.toContain('"enabled": false');

    const deleteIntent = await issue("delete", { kind: "mcp", cwd: root, name: "docs" });
    const removed = await service.delete({ cwd: root, ...deleteIntent }, context);
    expect(removed.removed).toBe(true);
    expect(removed.receipt).toMatchObject({ afterState: [{ state: "present", durable: true }] });
    await expect(readFile(removed.path!, "utf8")).resolves.not.toContain('"docs"');
  });

  it("replays a post-CAS failure from the private journal without a second CAS", async () => {
    const root = await mkdtemp(join(tmpdir(), "moss-canonical-recovery-workspace-"));
    const stateParent = await mkdtemp(join(tmpdir(), "moss-canonical-recovery-state-"));
    roots.push(root, stateParent);
    const stateDir = join(stateParent, "resource-import");
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const baseStore = makeNodeMossOwnershipStore(stateDir);
    let appendCount = 0;
    let failAfterIntent = true;
    const ownershipStore: MossOwnershipStore = {
      ...baseStore,
      appendPrivateManifest: async (input) => {
        appendCount += 1;
        if (failAfterIntent && appendCount === 3) {
          throw new MossResourceImportError("recovery-needed", "simulated commit crash");
        }
        return baseStore.appendPrivateManifest(input);
      },
    };
    let casCount = 0;
    const makeService = () => {
      const filesystemCapability = makeTestNativeFilesystemCapability({
        ownershipStore,
        readStage: async (stage) => ownershipStore.readPrivateStage!({ stage }),
        beforeMutation: () => {
          casCount += 1;
        },
      });
      return makeMossCanonicalResourceMutationService({
        ownershipStore,
        filesystemCapability,
        stateDir,
      });
    };
    const context = {
      cwd: root,
      ownerId: "owner-1",
      projectId: "project-1",
      workspaceId: "workspace-1",
      principalId: "principal-1",
      sessionId: "session-1",
      issuer: "issuer-1",
    } as const;
    const plan = await issueMossCanonicalMutationPlan({
      ownershipStore,
      stateDir,
      scope: context,
      action: "create",
      payload: { kind: "skill", cwd: root, name: "Recover Me" },
    });
    const createInput = {
      cwd: root,
      planId: plan.planId,
      operationId: plan.operationId,
    };

    await expect(makeService().create(createInput, context)).rejects.toMatchObject({
      code: "recovery-needed",
    });
    await expect(
      readFile(join(root, ".moss", "skills", "recover-me", "SKILL.md"), "utf8"),
    ).resolves.toContain("# Recover Me");
    expect(casCount).toBe(1);

    failAfterIntent = false;
    const replayed = await makeService().create(createInput, context);
    expect(replayed).toMatchObject({
      created: true,
      receipt: {
        schemaVersion: 3,
        operationId: expect.any(String),
        idempotencyKey: expect.any(String),
        targetPath: join(root, ".moss", "skills", "recover-me", "SKILL.md"),
        durable: true,
        afterState: [{ state: "present", durable: true }],
      },
    });
    expect(casCount).toBe(1);
    await expect(
      ownershipStore.readPrivateManifest({ fileName: "filesystem-mutations.json" }),
    ).resolves.toMatchObject({ value: { phase: "committed" } });
  });

  it("replays the same stable idempotency receipt after rebuilding the service", async () => {
    let casCount = 0;
    const { root, stateDir, ownershipStore, filesystemCapability, service, context, issue } =
      await fixture({
        beforeMutation: () => {
          casCount += 1;
        },
      });
    const input = {
      cwd: root,
      ...(await issue("create", { kind: "skill", cwd: root, name: "Stable Replay" })),
    };

    const first = await service.create(input, context);
    const replay = await makeMossCanonicalResourceMutationService({
      ownershipStore,
      filesystemCapability,
      stateDir,
    }).create(input, context);

    expect(first.created).toBe(true);
    expect(replay).toMatchObject({
      created: true,
      receipt: {
        operationId: first.receipt?.operationId,
        idempotencyKey: first.receipt?.idempotencyKey,
        transactionId: first.receipt?.transactionId,
        planHash: first.receipt?.planHash,
        targetPath: first.receipt?.targetPath,
      },
    });
    expect(replay.receipt).toEqual(first.receipt);
    expect(casCount).toBe(1);
  });

  it("fails closed on a canonical CAS race before claiming a durable result", async () => {
    const { root, service, context, issue } = await fixture({
      beforeMutation: async ({ targetPath }) => {
        await mkdir(join(root, ".moss", "skills", "race"), { recursive: true });
        await writeFile(targetPath, "external writer\n");
      },
    });

    const intent = await issue("create", { kind: "skill", cwd: root, name: "Race" });
    await expect(service.create({ cwd: root, ...intent }, context)).rejects.toMatchObject({
      code: "concurrent-modification",
    });
    await expect(readFile(join(root, ".moss", "skills", "race", "SKILL.md"), "utf8")).resolves.toBe(
      "external writer\n",
    );
  });

  it("rejects a canonical root symlink instead of applying it", async () => {
    const { root, service, context, issue } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "moss-canonical-mutation-outside-"));
    roots.push(outside);
    await mkdir(root, { recursive: true });
    await symlink(outside, join(root, ".moss"));
    const intent = await issue("create", { kind: "skill", cwd: root, name: "Safe" });
    await expect(service.create({ cwd: root, ...intent }, context)).rejects.toMatchObject({
      code: "symlink-escape",
    });
  });

  it("fails closed when a mutation intent has no explicit idempotency key", async () => {
    const { root, service, context } = await fixture();

    await expect(service.create({ cwd: root } as never, context)).rejects.toMatchObject({
      code: "invalid-identity",
    });
  });

  it("rejects a client-controlled idempotency key even when bounded intent ids are present", async () => {
    const { root, service, context } = await fixture();

    await expect(
      service.create(
        {
          cwd: root,
          planId: "plan-server-issued",
          operationId: "operation-server-issued",
          idempotencyKey: "client-controlled",
        } as never,
        context,
      ),
    ).rejects.toMatchObject({ code: "invalid-identity" });
  });
});
