import { createHash } from "node:crypto";
import { mkdir, mkdtemp, lstat, rm, symlink, writeFile } from "node:fs/promises";
import OS from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ensureMossSource } from "./mossSourceBootstrap";
import {
  computeMossProjectionFingerprint,
  summarizeMossWorkspaceProjectionEngines,
} from "./mossProjectionFingerprint";
import {
  materializeMossWorkspaceProjections,
  mossProjectionIdentityFingerprint,
  type MossProjectionFrozenTarget,
  type MossProjectionOwnershipMutationRequest,
  type MossProjectionTargetIdentity,
  type MossProjectionOwnershipStore,
  type MossProjectionPrivateManifest,
  type MossProjectionPrivateManifestReceipt,
  type MossProjectionOwnershipMutationResult,
} from "./mossProjectionMaterializer";
import { unsupportedTestProjectionTarget } from "./mossProjectionTestSupport";

const tempDirs: string[] = [];

async function makeTempWorkspace(): Promise<string> {
  const tempDir = await mkdtemp(join(OS.tmpdir(), "t3-moss-projection-fingerprint-"));
  tempDirs.push(tempDir);
  return tempDir;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function installFrozenTarget(
  targetAbs: string,
  target: MossProjectionFrozenTarget,
): Promise<void> {
  if (target.kind === "symlink") {
    await mkdir(dirname(targetAbs), { recursive: true });
    await symlink(target.target, targetAbs, target.linkType);
    return;
  }
  if (target.kind === "file") {
    await mkdir(dirname(targetAbs), { recursive: true });
    await writeFile(targetAbs, target.content);
    return;
  }
  await mkdir(targetAbs, { recursive: true });
  for (const entry of target.entries) {
    const entryAbs = join(targetAbs, entry.relativePath);
    if (entry.kind === "directory") {
      await mkdir(entryAbs, { recursive: true });
    } else {
      await mkdir(dirname(entryAbs), { recursive: true });
      await writeFile(entryAbs, entry.content ?? Buffer.alloc(0));
    }
  }
}

function fingerprintReceipt(
  request: MossProjectionOwnershipMutationRequest,
  target: MossProjectionFrozenTarget,
  identity: MossProjectionTargetIdentity,
): MossProjectionOwnershipMutationResult {
  const observedFingerprint = mossProjectionIdentityFingerprint(identity);
  const contentHash =
    target.kind === "symlink" ? sha256(`symlink\0${target.target}`) : target.contentHash;
  const manifest: MossProjectionPrivateManifestReceipt = {
    locator: "test-private-manifest",
    transactionId: request.privateManifest.transactionId,
    operationId: request.privateManifest.operationId,
    sequence: request.privateManifest.sequence,
    previousHash: request.privateManifest.previousHash,
    recordHash: request.privateManifest.recordHash,
  };
  return {
    status: "applied",
    receipt: {
      operationId: request.operationId,
      canonicalRoot: request.canonicalRoot,
      expectedFingerprint: request.expectedFingerprint,
      observedFingerprint,
      expectedBeforeHash: request.expectedBeforeHash,
      after: {
        state: "present",
        identity,
        fingerprint: observedFingerprint,
        contentHash,
      },
      fencingToken: request.fencingToken,
      generation: request.generation,
      nonce: request.nonce,
      manifest,
      durable: true,
    },
  };
}

function createFingerprintProjectionStore(): MossProjectionOwnershipStore {
  let privateManifest: MossProjectionPrivateManifest | null = null;
  const publish = async (
    request: MossProjectionOwnershipMutationRequest,
    target: MossProjectionFrozenTarget,
  ): Promise<MossProjectionOwnershipMutationResult> => {
    const unsupported = unsupportedTestProjectionTarget(target);
    if (unsupported) return unsupported;
    try {
      await lstat(request.targetAbs);
      return { status: "conflict", reason: "test target already exists" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await installFrozenTarget(request.targetAbs, target);
    const targetStat = await lstat(request.targetAbs);
    const identity = {
      dev: String(targetStat.dev),
      ino: String(targetStat.ino),
      mode: targetStat.mode,
      ctimeMs: targetStat.ctimeMs,
    };
    privateManifest = {
      locator: "test-private-manifest",
      ...request.privateManifest,
      value: request.privateManifest.value,
    };
    return fingerprintReceipt(request, target, identity);
  };
  return {
    withMutationLock: async (_scope, operation) => operation("test-fencing-token"),
    appendPrivateManifest: async (input) => {
      const receipt: MossProjectionPrivateManifestReceipt = {
        locator: "test-private-manifest",
        transactionId: input.transactionId,
        operationId: input.operationId,
        sequence: input.sequence,
        previousHash: input.previousHash,
        recordHash: input.recordHash,
      };
      privateManifest = { ...receipt, value: input.value };
      return receipt;
    },
    readPrivateManifest: async () => privateManifest,
    create: publish,
    publish,
    replace: async () => ({ status: "conflict", reason: "test replacement not needed" }),
    remove: async () => ({ status: "conflict", reason: "test removal not needed" }),
  };
}

afterEach(async () => {
  for (const tempDir of tempDirs.splice(0)) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("computeMossProjectionFingerprint", () => {
  it("is stable across an idempotent re-materialize (SY3 A5)", async () => {
    const workspace = await makeTempWorkspace();
    await ensureMossSource({ projectPath: workspace });

    // Production intentionally conflicts without server-owned authority. This
    // idempotence fixture supplies an explicit test authority so it exercises
    // the real create/read-back/skip path instead of the fail-closed branch.
    const ownershipStore = createFingerprintProjectionStore();
    const first = await materializeMossWorkspaceProjections({
      projectPath: workspace,
      ownershipStore,
      ownershipOwnerId: "test-projection-owner",
      ownershipGeneration: "test-projection-generation",
    });
    const second = await materializeMossWorkspaceProjections({
      projectPath: workspace,
      ownershipStore,
      ownershipOwnerId: "test-projection-owner",
      ownershipGeneration: "test-projection-generation",
    });

    // Second run reports skipped where the first reported created, but the
    // content-defining fingerprint must be byte-identical.
    const firstFingerprint = computeMossProjectionFingerprint(first);
    const secondFingerprint = computeMossProjectionFingerprint(second);
    expect(firstFingerprint).toBe(secondFingerprint);
    expect(firstFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);

    const secondSummary = summarizeMossWorkspaceProjectionEngines(second);
    const secondTotal = secondSummary.reduce((sum, engine) => sum + engine.total, 0);
    const secondSkipped = secondSummary.reduce((sum, engine) => sum + engine.skipped, 0);
    const secondCreated = secondSummary.reduce((sum, engine) => sum + engine.created, 0);
    const secondUpdated = secondSummary.reduce((sum, engine) => sum + engine.updated, 0);
    const secondConflict = secondSummary.reduce((sum, engine) => sum + engine.conflict, 0);
    // A5: the second run is a pure skip — no creates/updates/conflicts.
    expect(secondCreated).toBe(0);
    expect(secondUpdated).toBe(0);
    expect(secondConflict).toBe(0);
    expect(secondSkipped).toBeGreaterThan(0);
    expect(secondSkipped + secondSummary.reduce((sum, e) => sum + e.unsupported, 0)).toBe(
      secondTotal,
    );
  });

  it("changes when a .moss/skills entry is added or removed (SY3 A2 reverse-proof)", async () => {
    const workspace = await makeTempWorkspace();
    await ensureMossSource({ projectPath: workspace });

    const before = computeMossProjectionFingerprint(
      await materializeMossWorkspaceProjections({ projectPath: workspace }),
    );

    // Add a new skill directory to the .moss source.
    const skillDir = join(workspace, ".moss", "skills", "sy3-extra");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: sy3-extra\ndescription: SY3 fingerprint reverse-proof\n---\nBody.\n",
      "utf8",
    );

    const after = computeMossProjectionFingerprint(
      await materializeMossWorkspaceProjections({ projectPath: workspace }),
    );
    expect(after).not.toBe(before);
  });

  it("is independent of the projections' array order", () => {
    const materialized = {
      projectPath: "/tmp/ws",
      dryRun: false,
      projections: [
        {
          engineId: "codex" as const,
          projectPath: "/tmp/ws",
          projectionStatus: "ready" as const,
          warnings: [] as ReadonlyArray<string>,
          results: [
            {
              engineId: "codex" as const,
              resourceId: "moss:skill:a",
              action: "symlink" as const,
              sourcePath: ".moss/skills/a",
              targetPath: ".codex/skills/a",
              status: "created" as const,
            },
            {
              engineId: "codex" as const,
              resourceId: "moss:skill:b",
              action: "symlink" as const,
              sourcePath: ".moss/skills/b",
              targetPath: ".codex/skills/b",
              status: "created" as const,
            },
          ],
          summary: {
            created: 2,
            updated: 0,
            skipped: 0,
            conflict: 0,
            unsupported: 0,
            total: 2,
          },
        },
      ],
    };

    const reversed = {
      ...materialized,
      projections: [
        {
          ...materialized.projections[0]!,
          results: materialized.projections[0]!.results.toReversed(),
        },
      ],
    };

    expect(computeMossProjectionFingerprint(materialized)).toBe(
      computeMossProjectionFingerprint(reversed),
    );
  });

  it("ignores per-run status differences (created vs skipped) at equal content", () => {
    const base = {
      engineId: "codex" as const,
      resourceId: "moss:skill:a",
      action: "symlink" as const,
      sourcePath: ".moss/skills/a",
      targetPath: ".codex/skills/a",
    };
    const created = {
      projectPath: "/tmp/ws",
      dryRun: false,
      projections: [
        {
          engineId: "codex" as const,
          projectPath: "/tmp/ws",
          projectionStatus: "ready" as const,
          warnings: [] as ReadonlyArray<string>,
          results: [{ ...base, status: "created" as const }],
          summary: { created: 1, updated: 0, skipped: 0, conflict: 0, unsupported: 0, total: 1 },
        },
      ],
    };
    const skipped = {
      ...created,
      projections: [
        {
          ...created.projections[0]!,
          results: [{ ...base, status: "skipped" as const, reason: "already up to date" }],
          summary: { created: 0, updated: 0, skipped: 1, conflict: 0, unsupported: 0, total: 1 },
        },
      ],
    };

    expect(computeMossProjectionFingerprint(created)).toBe(
      computeMossProjectionFingerprint(skipped),
    );
  });
});
