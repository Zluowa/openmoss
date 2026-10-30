import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { Buffer } from "node:buffer";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type {
  MossFilesystemCapabilityInput,
  MossPrivateStage,
  MossOwnershipStore,
} from "@synara/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { makeNodeMossOwnershipStore, MossResourceImportError } from "./mossResourceImport.ts";
import {
  makeMossNativeFilesystemCapability as makeNativeFilesystemCapability,
  type MossNativeFilesystemCapabilityOptions,
} from "./mossNativeFilesystemCapability.ts";
import { makeMossCanonicalFilesystemHelper } from "./mossCanonicalFilesystemHelper.ts";
import { canonicalFilesystemHelperTestArch } from "./mossCanonicalFilesystemHelperTestRuntime.ts";

const execFile = promisify(execFileCallback);
let testHelperPath = "";
let testHelperDirectory: string | undefined;
let testHelperReady = false;
const describeWithCanonicalFilesystemHelper =
  canonicalFilesystemHelperTestArch === null ? describe.skip : describe;

beforeAll(async () => {
  if (canonicalFilesystemHelperTestArch === null) return;
  testHelperDirectory = await mkdtemp(join(tmpdir(), "moss-canonical-filesystem-helper-test-"));
  const outputPath = join(testHelperDirectory, "moss-canonical-filesystem-helper-test");
  await execFile(
    process.execPath,
    [
      "scripts/build-canonical-filesystem-helper.mjs",
      "--arch",
      canonicalFilesystemHelperTestArch,
      "--test-hooks",
      "--output",
      outputPath,
    ],
    { cwd: process.cwd() },
  );
  testHelperPath = outputPath;
  testHelperReady = true;
});

afterAll(async () => {
  if (testHelperDirectory !== undefined)
    await rm(testHelperDirectory, { recursive: true, force: true });
});

function makeMossNativeFilesystemCapability(options: MossNativeFilesystemCapabilityOptions) {
  if (!testHelperReady) throw new Error("The canonical filesystem test helper was not built.");
  const helperOptions = {
    helperPath: testHelperPath,
    timeoutMs: options.helperTimeoutMs ?? 5_000,
    ...(options.helperEnv !== undefined ? { env: options.helperEnv } : {}),
  } as const;
  return makeNativeFilesystemCapability({
    ...options,
    filesystemHelper: makeMossCanonicalFilesystemHelper(helperOptions),
  });
}

async function waitForBarrier(path: string, outcome: { readonly error?: unknown }): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await lstat(path);
      return;
    } catch (cause) {
      if (outcome.error) throw outcome.error;
      if (!(cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT")) {
        throw cause;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`Timed out waiting for canonical helper barrier ${path}`);
}

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
const missingHash = sha256("missing");

async function canonicalTreeHash(targetPath: string): Promise<string> {
  const targetStat = await lstat(targetPath);
  if (targetStat.isFile()) return sha256(await readFile(targetPath));
  if (!targetStat.isDirectory()) throw new Error(`Unsupported test tree entry: ${targetPath}`);
  const entries = await readdir(targetPath, { withFileTypes: true });
  const parts: string[] = [];
  for (const entry of entries.toSorted((left, right) =>
    Buffer.from(left.name).compare(Buffer.from(right.name)),
  )) {
    parts.push(`${entry.name}\0${await canonicalTreeHash(join(targetPath, entry.name))}`);
  }
  return sha256(parts.join("\n"));
}

function stage(
  rootPath = "/private/moss-root",
  kind: MossPrivateStage["kind"] = "skill",
): MossPrivateStage {
  return {
    id: "transaction-1:operation-1",
    transactionId: "transaction-1",
    operationId: "operation-1",
    kind,
    canonicalRoot: rootPath,
    ownerId: "owner-1",
    projectId: "project-1",
    workspaceId: "workspace-1",
    principalId: "principal-1",
    sessionId: "session-1",
    fencingToken: "fence-1",
    generation: "generation-1",
    nonce: "nonce-1",
    createdAt: "2026-08-08T00:00:00.000Z",
    leaseExpiresAt: "2099-08-08T00:00:00.000Z",
    opaque: { test: true },
  };
}

function input(
  rootPath: string,
  targetPath: string,
  overrides: Partial<MossFilesystemCapabilityInput> = {},
) {
  const canonicalRoot = {
    rootPath,
    identityFingerprint: sha256(rootPath),
    projectId: "project-1",
    workspaceId: "workspace-1",
    principalId: "principal-1",
    sessionId: "session-1",
  } as const;
  return {
    cwd: rootPath,
    canonicalRoot,
    projectId: "project-1",
    workspaceId: "workspace-1",
    ownerId: "owner-1",
    principalId: "principal-1",
    sessionId: "session-1",
    targetPath,
    stage: stage(rootPath),
    operationId: "operation-1",
    kind: "skill" as const,
    fencingToken: "fence-1",
    generation: "generation-1",
    nonce: "nonce-1",
    expectedFingerprint: canonicalRoot.identityFingerprint,
    expectedBeforeHash: missingHash,
    expected: { identityFingerprint: canonicalRoot.identityFingerprint, hash: missingHash },
    expectedAfterHash: sha256("hello\n"),
    expectedAfter: {
      identityFingerprint: canonicalRoot.identityFingerprint,
      hash: sha256("hello\n"),
    },
    ...overrides,
  } satisfies MossFilesystemCapabilityInput;
}

describeWithCanonicalFilesystemHelper("Moss native filesystem capability", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("commits a file CAS and private manifest as one durable receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "moss-native-capability-root-"));
    const stateDir = await mkdtemp(join(tmpdir(), "moss-native-capability-state-"));
    roots.push(root, stateDir);
    const target = join(root, ".moss", "skills", "native", "SKILL.md");
    const ownershipStore = makeNodeMossOwnershipStore(stateDir);
    const capability = makeMossNativeFilesystemCapability({
      ownershipStore,
      readStage: async () => ({
        kind: "file" as const,
        content: new TextEncoder().encode("hello\n"),
      }),
    });

    const result = await capability.create(input(root, target));

    await expect(readFile(target, "utf8")).resolves.toBe("hello\n");
    expect(result).toMatchObject({
      afterHash: sha256("hello\n"),
      durableObservedFingerprint: expect.any(String),
      receipt: {
        operationId: "operation-1",
        fencingToken: "fence-1",
        generation: "generation-1",
        nonce: "nonce-1",
        durable: true,
      },
    });
    await expect(
      ownershipStore.readPrivateManifest({ fileName: "filesystem-mutations.json" }),
    ).resolves.toMatchObject({
      value: expect.objectContaining({
        operationId: "operation-1",
        phase: "committed",
        expectedAfter: expect.objectContaining({ hash: sha256("hello\n") }),
      }),
    });
  });

  it("keeps helper ctime observations as integer seconds and nanoseconds", async () => {
    const root = await mkdtemp(join(tmpdir(), "moss-native-capability-ctime-"));
    const stateDir = await mkdtemp(join(tmpdir(), "moss-native-capability-ctime-state-"));
    roots.push(root, stateDir);
    const target = join(root, ".moss", "skills", "ctime", "SKILL.md");
    const helper = makeMossCanonicalFilesystemHelper({
      helperPath: testHelperPath,
      timeoutMs: 5_000,
    });
    let observation: Awaited<ReturnType<typeof helper.execute>>["after"] | undefined;
    const capability = makeNativeFilesystemCapability({
      ownershipStore: makeNodeMossOwnershipStore(stateDir),
      readStage: async () => ({
        kind: "file" as const,
        content: new TextEncoder().encode("hello\n"),
      }),
      filesystemHelper: {
        execute: async (helperInput) => {
          const result = await helper.execute(helperInput);
          observation = result.after;
          return result;
        },
      },
    });

    await capability.create(input(root, target));
    expect(observation).toMatchObject({ kind: "file" });
    expect(Number.isSafeInteger(observation?.ctimeSeconds)).toBe(true);
    expect(Number.isSafeInteger(observation?.ctimeNanoseconds)).toBe(true);
    expect(observation?.ctimeNanoseconds).toBeGreaterThanOrEqual(0);
    expect(observation?.ctimeNanoseconds).toBeLessThan(1_000_000_000);
  });

  it("rejects missing private stage capability before touching the target", async () => {
    const root = await mkdtemp(join(tmpdir(), "moss-native-capability-missing-stage-"));
    const stateDir = await mkdtemp(join(tmpdir(), "moss-native-capability-missing-state-"));
    roots.push(root, stateDir);
    const target = join(root, ".moss", "skills", "missing", "SKILL.md");
    const capability = makeMossNativeFilesystemCapability({
      ownershipStore: makeNodeMossOwnershipStore(stateDir),
      readStage: async () => {
        throw new MossResourceImportError("durability-unsupported", "stage reader unavailable");
      },
    });

    await expect(capability.create(input(root, target))).rejects.toMatchObject({
      code: "durability-unsupported",
    });
    await expect(readFile(target, "utf8")).rejects.toThrow();
  });

  it("maps a target CAS race to concurrent-modification", async () => {
    const root = await mkdtemp(join(tmpdir(), "moss-native-capability-race-"));
    const stateDir = await mkdtemp(join(tmpdir(), "moss-native-capability-race-state-"));
    roots.push(root, stateDir);
    const target = join(root, ".moss", "skills", "race", "SKILL.md");
    const capability = makeMossNativeFilesystemCapability({
      ownershipStore: makeNodeMossOwnershipStore(stateDir),
      readStage: async () => ({
        kind: "file" as const,
        content: new TextEncoder().encode("hello\n"),
      }),
      beforeMutation: async () => {
        await mkdir(join(root, ".moss", "skills", "race"), { recursive: true });
        await writeFile(target, "external writer\n");
      },
    });

    await expect(capability.create(input(root, target))).rejects.toMatchObject({
      code: "concurrent-modification",
    });
    await expect(readFile(target, "utf8")).resolves.toBe("external writer\n");
  });

  it("never reports applied when private manifest durability fails after CAS", async () => {
    const root = await mkdtemp(join(tmpdir(), "moss-native-capability-manifest-fault-"));
    const stateDir = await mkdtemp(join(tmpdir(), "moss-native-capability-manifest-state-"));
    roots.push(root, stateDir);
    const target = join(root, ".moss", "skills", "fault", "SKILL.md");
    const base = makeNodeMossOwnershipStore(stateDir);
    let appendCount = 0;
    const ownershipStore: MossOwnershipStore = {
      ...base,
      appendPrivateManifest: async (input) => {
        appendCount += 1;
        if (appendCount === 2) {
          throw new MossResourceImportError("recovery-needed", "manifest fsync fault");
        }
        return base.appendPrivateManifest(input);
      },
    };
    const capability = makeMossNativeFilesystemCapability({
      ownershipStore,
      readStage: async () => ({
        kind: "file" as const,
        content: new TextEncoder().encode("hello\n"),
      }),
    });

    await expect(capability.create(input(root, target))).rejects.toMatchObject({
      code: "recovery-needed",
    });
    await expect(readFile(target, "utf8")).resolves.toBe("hello\n");
  });

  it("retries the same operation after an intent-only pre-CAS failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "moss-native-capability-before-retry-"));
    const stateDir = await mkdtemp(join(tmpdir(), "moss-native-capability-before-retry-state-"));
    roots.push(root, stateDir);
    const target = join(root, ".moss", "skills", "retry", "SKILL.md");
    const ownershipStore = makeNodeMossOwnershipStore(stateDir);
    const first = makeMossNativeFilesystemCapability({
      ownershipStore,
      readStage: async () => ({
        kind: "file" as const,
        content: new TextEncoder().encode("hello\n"),
      }),
      beforeMutation: () => {
        throw new MossResourceImportError("concurrent-modification", "pre-CAS interruption");
      },
    });
    await expect(first.create(input(root, target))).rejects.toMatchObject({
      code: "concurrent-modification",
    });
    await expect(readFile(target, "utf8")).rejects.toThrow();
    const second = makeMossNativeFilesystemCapability({
      ownershipStore,
      readStage: async () => ({
        kind: "file" as const,
        content: new TextEncoder().encode("hello\n"),
      }),
    });
    await expect(second.create(input(root, target))).resolves.toMatchObject({
      afterHash: sha256("hello\n"),
    });
    await expect(readFile(target, "utf8")).resolves.toBe("hello\n");
  });

  it("records a conflict when recovery observes neither bound state", async () => {
    const root = await mkdtemp(join(tmpdir(), "moss-native-capability-neither-"));
    const stateDir = await mkdtemp(join(tmpdir(), "moss-native-capability-neither-state-"));
    roots.push(root, stateDir);
    const target = join(root, ".moss", "skills", "neither", "SKILL.md");
    const ownershipStore = makeNodeMossOwnershipStore(stateDir);
    const first = makeMossNativeFilesystemCapability({
      ownershipStore,
      readStage: async () => ({
        kind: "file" as const,
        content: new TextEncoder().encode("hello\n"),
      }),
      beforeMutation: async () => {
        await mkdir(join(root, ".moss", "skills", "neither"), { recursive: true });
        await writeFile(target, "external writer\n");
      },
    });
    await expect(first.create(input(root, target))).rejects.toMatchObject({
      code: "concurrent-modification",
    });
    const second = makeMossNativeFilesystemCapability({
      ownershipStore,
      readStage: async () => ({
        kind: "file" as const,
        content: new TextEncoder().encode("hello\n"),
      }),
    });
    await expect(second.create(input(root, target))).rejects.toMatchObject({
      code: "concurrent-modification",
    });
    await expect(
      ownershipStore.readPrivateManifest({ fileName: "filesystem-mutations.json" }),
    ).resolves.toMatchObject({ value: { phase: "conflict" } });
  });

  it("replays a committed operation without a second filesystem CAS", async () => {
    const root = await mkdtemp(join(tmpdir(), "moss-native-capability-committed-retry-"));
    const stateDir = await mkdtemp(join(tmpdir(), "moss-native-capability-committed-retry-state-"));
    roots.push(root, stateDir);
    const target = join(root, ".moss", "skills", "committed", "SKILL.md");
    const ownershipStore = makeNodeMossOwnershipStore(stateDir);
    let casCount = 0;
    const makeCapability = () =>
      makeMossNativeFilesystemCapability({
        ownershipStore,
        readStage: async () => ({
          kind: "file" as const,
          content: new TextEncoder().encode("hello\n"),
        }),
        beforeMutation: () => {
          casCount += 1;
        },
      });
    await makeCapability().create(input(root, target));
    const replayed = await makeCapability().create(input(root, target));
    expect(replayed.observed.hash).toBe(sha256("hello\n"));
    expect(casCount).toBe(1);
  });

  it("rejects a forged private receipt after CAS and leaves recovery evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "moss-native-capability-receipt-mismatch-"));
    const stateDir = await mkdtemp(
      join(tmpdir(), "moss-native-capability-receipt-mismatch-state-"),
    );
    roots.push(root, stateDir);
    const target = join(root, ".moss", "skills", "receipt-mismatch", "SKILL.md");
    const base = makeNodeMossOwnershipStore(stateDir);
    let appendCount = 0;
    const ownershipStore: MossOwnershipStore = {
      ...base,
      appendPrivateManifest: async (manifestInput) => {
        appendCount += 1;
        const receipt = await base.appendPrivateManifest(manifestInput);
        if (appendCount === 2) return { ...receipt, recordHash: "0".repeat(64) };
        return receipt;
      },
    };
    const capability = makeMossNativeFilesystemCapability({
      ownershipStore,
      readStage: async () => ({
        kind: "file" as const,
        content: new TextEncoder().encode("hello\n"),
      }),
    });
    await expect(capability.create(input(root, target))).rejects.toMatchObject({
      code: "recovery-needed",
    });
    await expect(readFile(target, "utf8")).resolves.toBe("hello\n");
    await expect(
      ownershipStore.readPrivateManifest({ fileName: "filesystem-mutations.json" }),
    ).resolves.toMatchObject({ value: { phase: "cas-observed" } });
  });

  it("rejects reusing an idempotency key for a different target", async () => {
    const root = await mkdtemp(join(tmpdir(), "moss-native-capability-binding-"));
    const stateDir = await mkdtemp(join(tmpdir(), "moss-native-capability-binding-state-"));
    roots.push(root, stateDir);
    const firstTarget = join(root, ".moss", "skills", "binding", "SKILL.md");
    const secondTarget = join(root, ".moss", "skills", "other", "SKILL.md");
    const ownershipStore = makeNodeMossOwnershipStore(stateDir);
    const first = makeMossNativeFilesystemCapability({
      ownershipStore,
      readStage: async () => ({
        kind: "file" as const,
        content: new TextEncoder().encode("hello\n"),
      }),
      beforeMutation: () => {
        throw new MossResourceImportError("concurrent-modification", "leave intent pending");
      },
    });
    await expect(first.create(input(root, firstTarget))).rejects.toMatchObject({
      code: "concurrent-modification",
    });
    const second = makeMossNativeFilesystemCapability({
      ownershipStore,
      readStage: async () => ({
        kind: "file" as const,
        content: new TextEncoder().encode("hello\n"),
      }),
    });
    const changedActor = input(root, firstTarget, {
      ownerId: "owner-2",
      canonicalRoot: { ...input(root, firstTarget).canonicalRoot, ownerId: "owner-2" },
      stage: { ...stage(root), ownerId: "owner-2" },
    });
    await expect(second.create(changedActor)).rejects.toMatchObject({
      code: "concurrent-modification",
    });
    await expect(second.create(input(root, secondTarget))).rejects.toMatchObject({
      code: "concurrent-modification",
    });
  });

  it("fails closed when the canonical root descriptor no longer names the opened root", async () => {
    const root = await mkdtemp(join(tmpdir(), "moss-native-capability-root-race-"));
    const stateDir = await mkdtemp(join(tmpdir(), "moss-native-capability-root-race-state-"));
    roots.push(root, stateDir);
    const target = join(root, ".moss", "skills", "root-race", "SKILL.md");
    const capability = makeMossNativeFilesystemCapability({
      ownershipStore: makeNodeMossOwnershipStore(stateDir),
      readStage: async () => ({
        kind: "file" as const,
        content: new TextEncoder().encode("hello\n"),
      }),
      beforeMutation: async () => {
        await writeFile(join(root, "root-marker"), "changed root content\n");
      },
    });
    const forged = input(root, target, {
      canonicalRoot: {
        ...input(root, target).canonicalRoot,
        identityFingerprint: "0".repeat(64),
      },
      expectedFingerprint: "0".repeat(64),
      expected: { identityFingerprint: "0".repeat(64), hash: missingHash },
    });

    await expect(capability.create(forged)).rejects.toMatchObject({
      code: "concurrent-modification",
    });
    await expect(readFile(target, "utf8")).rejects.toThrow();
  });

  it.each(["relative/SKILL.md", "~/SKILL.md"])(
    "rejects non-absolute canonical target paths: %s",
    async (targetPath) => {
      const root = await mkdtemp(join(tmpdir(), "moss-native-capability-path-contract-"));
      const stateDir = await mkdtemp(join(tmpdir(), "moss-native-capability-path-contract-state-"));
      roots.push(root, stateDir);
      const capability = makeMossNativeFilesystemCapability({
        ownershipStore: makeNodeMossOwnershipStore(stateDir),
        readStage: async () => ({
          kind: "file" as const,
          content: new TextEncoder().encode("hello\n"),
        }),
      });

      await expect(capability.create(input(root, targetPath))).rejects.toMatchObject({
        code: "path-traversal",
      });
    },
  );

  it.each(["create", "publish", "replace", "remove"] as const)(
    "rejects a same-inode content race after the helper boundary for %s",
    async (action) => {
      const root = await mkdtemp(join(tmpdir(), `moss-native-capability-same-inode-${action}-`));
      const stateDir = await mkdtemp(
        join(tmpdir(), `moss-native-capability-same-inode-${action}-state-`),
      );
      roots.push(root, stateDir);
      const targetParent = join(root, ".moss", "skills", "same-inode");
      const target = join(targetParent, "SKILL.md");
      const barrierPath = join(root, "same-inode-barrier");
      await mkdir(targetParent, { recursive: true });
      const beforeContent = "before\n";
      const racedContent = "same inode writer\n";
      if (action === "replace" || action === "remove") await writeFile(target, beforeContent);
      const beforeHash =
        action === "create" || action === "publish" ? missingHash : sha256(beforeContent);
      const afterHash = action === "remove" ? missingHash : sha256("hello\n");
      const capability = makeMossNativeFilesystemCapability({
        ownershipStore: makeNodeMossOwnershipStore(stateDir),
        readStage: async () => ({
          kind: "file" as const,
          content: new TextEncoder().encode("hello\n"),
        }),
        helperEnv: { MOSS_CANONICAL_FS_TEST_BARRIER: barrierPath },
      });
      const base = input(root, target, {
        expectedBeforeHash: beforeHash,
        expected: { identityFingerprint: sha256(root), hash: beforeHash },
        expectedAfterHash: afterHash,
        expectedAfter: { identityFingerprint: sha256(root), hash: afterHash },
      });
      const outcome: { error?: unknown } = {};
      const mutation = (async () => {
        try {
          const value =
            action === "create"
              ? await capability.create(base)
              : action === "publish"
                ? await capability.publish(base)
                : action === "replace"
                  ? await capability.replace(base)
                  : await capability.remove(base);
          return { value };
        } catch (error) {
          outcome.error = error;
          return { error };
        }
      })();
      await waitForBarrier(`${barrierPath}.ready`, outcome);
      let racedIdentity: { readonly dev: number; readonly ino: number } | undefined;
      if (action === "replace" || action === "remove") {
        const beforeStat = await lstat(target);
        await writeFile(target, racedContent);
        const afterStat = await lstat(target);
        racedIdentity = { dev: afterStat.dev, ino: afterStat.ino };
        expect(afterStat.dev).toBe(beforeStat.dev);
        expect(afterStat.ino).toBe(beforeStat.ino);
      } else {
        await writeFile(target, racedContent);
      }
      await writeFile(`${barrierPath}.release`, "release");
      const result = await mutation;
      const expectedCode =
        action === "create" || action === "publish"
          ? expect.stringMatching(/^(concurrent-modification|conflict)$/u)
          : "concurrent-modification";
      expect(result).toMatchObject({ error: { code: expectedCode } });
      expect(outcome.error).toMatchObject({ code: expectedCode });
      await expect(readFile(target, "utf8")).resolves.toBe(racedContent);
      if (racedIdentity) {
        const finalStat = await lstat(target);
        expect(finalStat.dev).toBe(racedIdentity.dev);
        expect(finalStat.ino).toBe(racedIdentity.ino);
      }
    },
  );

  it.each(["remove", "replace"] as const)(
    "rejects a same-inode directory tree race after the helper boundary for %s",
    async (action) => {
      const root = await mkdtemp(join(tmpdir(), `moss-native-capability-tree-race-${action}-`));
      const stateDir = await mkdtemp(
        join(tmpdir(), `moss-native-capability-tree-race-${action}-state-`),
      );
      const stageRoot = await mkdtemp(
        join(tmpdir(), `moss-native-capability-tree-stage-${action}-`),
      );
      roots.push(root, stateDir, stageRoot);
      const targetParent = join(root, ".moss", "plugins");
      const target = join(targetParent, "tree");
      const barrierPath = join(root, "tree-race-barrier");
      await mkdir(join(target, "nested"), { recursive: true });
      await writeFile(join(target, "nested", "before.txt"), "before tree\n");
      const beforeHash = await canonicalTreeHash(target);
      let afterHash = missingHash;
      if (action === "replace") {
        await writeFile(join(stageRoot, "new.txt"), "replacement tree\n");
        afterHash = await canonicalTreeHash(stageRoot);
      }
      const capability = makeMossNativeFilesystemCapability({
        ownershipStore: makeNodeMossOwnershipStore(stateDir),
        readStage: async () => ({
          kind: "directory" as const,
          entries: [
            {
              relativePath: "new.txt",
              kind: "file" as const,
              content: new TextEncoder().encode("replacement tree\n"),
            },
          ],
        }),
        helperEnv: { MOSS_CANONICAL_FS_TEST_BARRIER: barrierPath },
      });
      const base = input(root, target, {
        stage: { ...stage(root), kind: "plugin" },
        kind: "plugin",
        expectedBeforeHash: beforeHash,
        expected: { identityFingerprint: sha256(root), hash: beforeHash },
        expectedAfterHash: afterHash,
        expectedAfter: { identityFingerprint: sha256(root), hash: afterHash },
      });
      const outcome: { error?: unknown } = {};
      const mutation = (async () => {
        try {
          const value =
            action === "replace" ? await capability.replace(base) : await capability.remove(base);
          return { value };
        } catch (error) {
          outcome.error = error;
          return { error };
        }
      })();
      await waitForBarrier(`${barrierPath}.ready`, outcome);
      const beforeStat = await lstat(target);
      await writeFile(join(target, "nested", "before.txt"), "same tree inode writer\n");
      const racedStat = await lstat(target);
      expect(racedStat.dev).toBe(beforeStat.dev);
      expect(racedStat.ino).toBe(beforeStat.ino);
      await writeFile(`${barrierPath}.release`, "release");
      const result = await mutation;
      expect(result).toMatchObject({ error: { code: "concurrent-modification" } });
      expect(outcome.error).toMatchObject({ code: "concurrent-modification" });
      await expect(readFile(join(target, "nested", "before.txt"), "utf8")).resolves.toBe(
        "same tree inode writer\n",
      );
      await expect(readFile(join(target, "new.txt"), "utf8")).rejects.toThrow();
    },
  );

  it.each(["file", "directory"] as const)(
    "rejects remove when the same inode changes after final verification: %s",
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), `moss-native-capability-remove-final-${kind}-`));
      const stateDir = await mkdtemp(
        join(tmpdir(), `moss-native-capability-remove-final-${kind}-state-`),
      );
      roots.push(root, stateDir);
      const targetParent = join(root, ".moss", kind === "file" ? "skills" : "plugins");
      const target = join(targetParent, kind === "file" ? "SKILL.md" : "tree");
      const barrierPath = join(root, "remove-final-barrier");
      await mkdir(targetParent, { recursive: true });
      if (kind === "file") {
        await writeFile(target, "before\n");
      } else {
        await mkdir(join(target, "nested"), { recursive: true });
        await writeFile(join(target, "nested", "before.txt"), "before tree\n");
      }
      const beforeHash = kind === "file" ? sha256("before\n") : await canonicalTreeHash(target);
      const capability = makeMossNativeFilesystemCapability({
        ownershipStore: makeNodeMossOwnershipStore(stateDir),
        readStage: async () => ({
          kind: "file" as const,
          content: new TextEncoder().encode("unused\n"),
        }),
        helperEnv: { MOSS_CANONICAL_FS_TEST_REMOVE_BEFORE_UNLINK_BARRIER: barrierPath },
      });
      const base = input(root, target, {
        stage: { ...stage(root), kind: kind === "file" ? "skill" : "plugin" },
        kind: kind === "file" ? "skill" : "plugin",
        expectedBeforeHash: beforeHash,
        expected: { identityFingerprint: sha256(root), hash: beforeHash },
        expectedAfterHash: missingHash,
        expectedAfter: { identityFingerprint: sha256(root), hash: missingHash },
      });
      const outcome: { error?: unknown } = {};
      const mutation = (async () => {
        try {
          return { value: await capability.remove(base) };
        } catch (error) {
          outcome.error = error;
          return { error };
        }
      })();
      await waitForBarrier(`${barrierPath}.ready`, outcome);
      const backupName = (await readdir(targetParent)).find((name) =>
        name.startsWith(".moss-canonical-backup-"),
      );
      expect(backupName).toBeDefined();
      const backupPath = join(targetParent, backupName!);
      const beforeStat = await lstat(backupPath);
      if (kind === "file") {
        await writeFile(backupPath, "same inode writer\n");
      } else {
        await writeFile(join(backupPath, "nested", "before.txt"), "same tree inode writer\n");
      }
      const racedStat = await lstat(backupPath);
      expect(racedStat.dev).toBe(beforeStat.dev);
      expect(racedStat.ino).toBe(beforeStat.ino);
      await writeFile(`${barrierPath}.release`, "release");

      const result = await mutation;
      expect(result).toMatchObject({ error: { code: "concurrent-modification" } });
      expect(outcome.error).toMatchObject({ code: "concurrent-modification" });
      expect(result).not.toMatchObject({ value: expect.anything() });
      await expect(lstat(target)).rejects.toThrow();
      await expect(readdir(targetParent)).resolves.toContain(backupName);
      if (kind === "file") {
        await expect(readFile(backupPath, "utf8")).resolves.toBe("same inode writer\n");
      } else {
        await expect(readFile(join(backupPath, "nested", "before.txt"), "utf8")).resolves.toBe(
          "same tree inode writer\n",
        );
      }
      const finalBackupStat = await lstat(backupPath);
      expect(finalBackupStat.dev).toBe(racedStat.dev);
      expect(finalBackupStat.ino).toBe(racedStat.ino);
    },
  );

  it("fences a concurrent remove after the hidden tombstone is modified", async () => {
    const root = await mkdtemp(join(tmpdir(), "moss-native-capability-remove-retry-race-"));
    const stateDir = await mkdtemp(
      join(tmpdir(), "moss-native-capability-remove-retry-race-state-"),
    );
    roots.push(root, stateDir);
    const targetParent = join(root, ".moss", "skills", "remove-retry-race");
    const target = join(targetParent, "SKILL.md");
    const barrierPath = join(root, "remove-retry-race-barrier");
    await mkdir(targetParent, { recursive: true });
    await writeFile(target, "before\n");
    const ownershipStore = makeNodeMossOwnershipStore(stateDir);
    const capability = makeMossNativeFilesystemCapability({
      ownershipStore,
      readStage: async () => ({
        kind: "file" as const,
        content: new TextEncoder().encode("unused\n"),
      }),
      helperEnv: { MOSS_CANONICAL_FS_TEST_REMOVE_BEFORE_UNLINK_BARRIER: barrierPath },
    });
    const base = input(root, target, {
      expectedBeforeHash: sha256("before\n"),
      expected: { identityFingerprint: sha256(root), hash: sha256("before\n") },
      expectedAfterHash: missingHash,
      expectedAfter: { identityFingerprint: sha256(root), hash: missingHash },
    });
    const outcome: { error?: unknown } = {};
    const first = (async () => {
      try {
        return { value: await capability.remove(base) };
      } catch (error) {
        outcome.error = error;
        return { error };
      }
    })();

    await waitForBarrier(`${barrierPath}.ready`, outcome);
    const tombstoneName = (await readdir(targetParent)).find((name) =>
      name.startsWith(".moss-canonical-backup-"),
    );
    expect(tombstoneName).toBeDefined();
    const tombstonePath = join(targetParent, tombstoneName!);
    await expect(lstat(target)).rejects.toThrow();
    const tombstoneStat = await lstat(tombstonePath);
    await writeFile(tombstonePath, "concurrent writer\n");
    const racedTombstoneStat = await lstat(tombstonePath);
    expect(racedTombstoneStat.dev).toBe(tombstoneStat.dev);
    expect(racedTombstoneStat.ino).toBe(tombstoneStat.ino);
    await writeFile(`${barrierPath}.release`, "release");

    const firstResult = await first;
    expect(firstResult).toMatchObject({ error: { code: "concurrent-modification" } });
    expect(outcome.error).toMatchObject({ code: "concurrent-modification" });
    await expect(lstat(target)).rejects.toThrow();
    await expect(readFile(tombstonePath, "utf8")).resolves.toBe("concurrent writer\n");

    await expect(capability.remove(base)).rejects.toMatchObject({
      code: "concurrent-modification",
    });
    await expect(
      ownershipStore.readPrivateManifest({ fileName: "filesystem-mutations.json" }),
    ).resolves.toMatchObject({ value: { phase: "conflict" } });
  });

  it("commits a remove with a recoverable quarantine tombstone", async () => {
    const root = await mkdtemp(join(tmpdir(), "moss-native-capability-remove-tombstone-"));
    const stateDir = await mkdtemp(
      join(tmpdir(), "moss-native-capability-remove-tombstone-state-"),
    );
    roots.push(root, stateDir);
    const targetParent = join(root, ".moss", "skills", "tombstone");
    const target = join(targetParent, "SKILL.md");
    await mkdir(targetParent, { recursive: true });
    await writeFile(target, "before\n");
    const capability = makeMossNativeFilesystemCapability({
      ownershipStore: makeNodeMossOwnershipStore(stateDir),
      readStage: async () => ({
        kind: "file" as const,
        content: new TextEncoder().encode("unused\n"),
      }),
    });

    await expect(
      capability.remove(
        input(root, target, {
          expectedBeforeHash: sha256("before\n"),
          expected: { identityFingerprint: sha256(root), hash: sha256("before\n") },
          expectedAfterHash: missingHash,
          expectedAfter: { identityFingerprint: sha256(root), hash: missingHash },
        }),
      ),
    ).resolves.toMatchObject({ afterHash: missingHash });
    await expect(lstat(target)).rejects.toThrow();
    const tombstoneName = (await readdir(targetParent)).find((name) =>
      name.startsWith(".moss-canonical-backup-"),
    );
    expect(tombstoneName).toBeDefined();
    await expect(readFile(join(targetParent, tombstoneName!), "utf8")).resolves.toBe("before\n");
  });

  it("does not create a missing parent while removing a missing target", async () => {
    const root = await mkdtemp(join(tmpdir(), "moss-native-capability-remove-missing-parent-"));
    const stateDir = await mkdtemp(
      join(tmpdir(), "moss-native-capability-remove-missing-parent-state-"),
    );
    roots.push(root, stateDir);
    await mkdir(join(root, ".moss", "skills"), { recursive: true });
    const targetParent = join(root, ".moss", "skills", "never-created");
    const target = join(targetParent, "SKILL.md");
    const capability = makeMossNativeFilesystemCapability({
      ownershipStore: makeNodeMossOwnershipStore(stateDir),
      readStage: async () => ({
        kind: "file" as const,
        content: new TextEncoder().encode("unused\n"),
      }),
    });

    await expect(capability.remove(input(root, target))).rejects.toMatchObject({
      code: "concurrent-modification",
    });
    await expect(lstat(targetParent)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects dot and NUL segments before invoking the descriptor helper", async () => {
    const root = await mkdtemp(join(tmpdir(), "moss-native-capability-path-segments-"));
    const stateDir = await mkdtemp(join(tmpdir(), "moss-native-capability-path-segments-state-"));
    roots.push(root, stateDir);
    const capability = makeMossNativeFilesystemCapability({
      ownershipStore: makeNodeMossOwnershipStore(stateDir),
      readStage: async () => ({
        kind: "file" as const,
        content: new TextEncoder().encode("hello\n"),
      }),
    });

    await expect(
      capability.create(input(root, `${root}/.moss/skills/./dot/SKILL.md`)),
    ).rejects.toMatchObject({ code: "path-traversal" });
    await expect(
      capability.create(input(root, `${root}/.moss/skills/bad\0/SKILL.md`)),
    ).rejects.toMatchObject({ code: "path-traversal" });
  });

  it.each(["create", "publish", "replace", "remove"] as const)(
    "fails closed when the target parent becomes an external symlink before %s",
    async (action) => {
      const root = await mkdtemp(
        join(tmpdir(), `moss-native-capability-parent-symlink-${action}-`),
      );
      const stateDir = await mkdtemp(
        join(tmpdir(), `moss-native-capability-parent-symlink-${action}-state-`),
      );
      const external = await mkdtemp(
        join(tmpdir(), `moss-native-capability-parent-symlink-${action}-external-`),
      );
      roots.push(root, stateDir, external);
      const targetParent = join(root, ".moss", "skills", "parent-race");
      const target = join(targetParent, "SKILL.md");
      const movedParent = join(root, ".moss", "skills", `parent-race-${action}-moved`);
      const externalTarget = join(external, "SKILL.md");
      const existingContent = "before\n";
      const beforeHash =
        action === "create" || action === "publish" ? missingHash : sha256(existingContent);
      const afterHash = action === "remove" ? missingHash : sha256("hello\n");

      await mkdir(targetParent, { recursive: true });
      if (action === "replace" || action === "remove") {
        await writeFile(target, existingContent);
        await writeFile(externalTarget, existingContent);
      }

      const base = input(root, target, {
        expectedBeforeHash: beforeHash,
        expected: { identityFingerprint: sha256(root), hash: beforeHash },
        expectedAfterHash: afterHash,
        expectedAfter: { identityFingerprint: sha256(root), hash: afterHash },
      });
      const capability = makeMossNativeFilesystemCapability({
        ownershipStore: makeNodeMossOwnershipStore(stateDir),
        readStage: async () => ({
          kind: "file" as const,
          content: new TextEncoder().encode("hello\n"),
        }),
        helperEnv: { MOSS_CANONICAL_FS_TEST_BARRIER: join(root, "helper-barrier") },
      });

      const barrierPath = join(root, "helper-barrier");
      const outcome: { error?: unknown } = {};
      const mutation = (async () => {
        try {
          const value =
            action === "create"
              ? await capability.create(base)
              : action === "publish"
                ? await capability.publish(base)
                : action === "replace"
                  ? await capability.replace(base)
                  : await capability.remove(base);
          return { value };
        } catch (error) {
          outcome.error = error;
          return { error };
        }
      })();
      await waitForBarrier(`${barrierPath}.ready`, outcome);
      await rename(targetParent, movedParent);
      await symlink(external, targetParent, "dir");
      await writeFile(`${barrierPath}.release`, "release");
      const result = await mutation;
      expect(result).toMatchObject({
        error: {
          code: expect.stringMatching(/^(concurrent-modification|symlink-escape)$/u),
        },
      });
      expect(result).not.toMatchObject({
        value: expect.anything(),
      });

      expect(outcome.error).toMatchObject({
        code: expect.stringMatching(/^(concurrent-modification|symlink-escape)$/u),
      });

      if (action === "create" || action === "publish") {
        await expect(readFile(externalTarget, "utf8")).rejects.toThrow();
      } else {
        await expect(readFile(externalTarget, "utf8")).resolves.toBe(existingContent);
      }
    },
  );

  it("keeps replacement rollback failure in recovery-needed instead of reporting applied", async () => {
    const root = await mkdtemp(join(tmpdir(), "moss-native-capability-rollback-failure-"));
    const stateDir = await mkdtemp(
      join(tmpdir(), "moss-native-capability-rollback-failure-state-"),
    );
    roots.push(root, stateDir);
    const targetParent = join(root, ".moss", "skills", "rollback");
    const target = join(targetParent, "SKILL.md");
    await mkdir(targetParent, { recursive: true });
    await writeFile(target, "before\n");
    const ownershipStore = makeNodeMossOwnershipStore(stateDir);
    const capability = makeMossNativeFilesystemCapability({
      ownershipStore,
      readStage: async () => ({
        kind: "file" as const,
        content: new TextEncoder().encode("after\n"),
      }),
      helperEnv: { MOSS_CANONICAL_FS_TEST_REPLACE_ROLLBACK_FAILURE: "1" },
    });

    await expect(
      capability.replace(
        input(root, target, {
          expectedBeforeHash: sha256("before\n"),
          expected: { identityFingerprint: sha256(root), hash: sha256("before\n") },
          expectedAfterHash: sha256("after\n"),
          expectedAfter: { identityFingerprint: sha256(root), hash: sha256("after\n") },
        }),
      ),
    ).rejects.toMatchObject({ code: "recovery-needed" });
    await expect(
      ownershipStore.readPrivateManifest({ fileName: "filesystem-mutations.json" }),
    ).resolves.toMatchObject({ value: { phase: "intent" } });
    await expect(readFile(target, "utf8")).resolves.toBe("");
    const rollbackResidues = (await readdir(targetParent)).filter((name) =>
      name.startsWith(".moss-canonical-backup-"),
    );
    expect(rollbackResidues).toHaveLength(1);
    await expect(readFile(join(targetParent, rollbackResidues[0]!), "utf8")).resolves.toBe(
      "before\n",
    );
  });

  it("returns recovery-needed and preserves the backup when replacement cleanup fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "moss-native-capability-backup-cleanup-"));
    const stateDir = await mkdtemp(join(tmpdir(), "moss-native-capability-backup-cleanup-state-"));
    roots.push(root, stateDir);
    const targetParent = join(root, ".moss", "skills", "backup-cleanup");
    const target = join(targetParent, "SKILL.md");
    await mkdir(targetParent, { recursive: true });
    await writeFile(target, "before\n");
    const ownershipStore = makeNodeMossOwnershipStore(stateDir);
    const capability = makeMossNativeFilesystemCapability({
      ownershipStore,
      readStage: async () => ({
        kind: "file" as const,
        content: new TextEncoder().encode("after\n"),
      }),
      helperEnv: { MOSS_CANONICAL_FS_TEST_BACKUP_CLEANUP_FAILURE: "1" },
    });

    await expect(
      capability.replace(
        input(root, target, {
          expectedBeforeHash: sha256("before\n"),
          expected: { identityFingerprint: sha256(root), hash: sha256("before\n") },
          expectedAfterHash: sha256("after\n"),
          expectedAfter: { identityFingerprint: sha256(root), hash: sha256("after\n") },
        }),
      ),
    ).rejects.toMatchObject({ code: "recovery-needed" });
    await expect(readFile(target, "utf8")).resolves.toBe("after\n");
    const residues = (await readdir(targetParent)).filter((name) =>
      name.startsWith(".moss-canonical-backup-"),
    );
    expect(residues).toHaveLength(1);
    await expect(readFile(join(targetParent, residues[0]!), "utf8")).resolves.toBe("before\n");
    await expect(
      ownershipStore.readPrivateManifest({ fileName: "filesystem-mutations.json" }),
    ).resolves.toMatchObject({ value: { phase: "intent" } });
  });
});
