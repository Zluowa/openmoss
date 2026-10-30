import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import type { MossFilesystemCapability } from "@synara/contracts";
import { ensureMossSource } from "@synara/shared/mossSourceBootstrap";
import { makeMossProjectionOwnershipAdapter } from "@synara/shared/mossProjectionOwnershipAdapter";
import { materializeMossWorkspaceProjections } from "@synara/shared/mossProjectionMaterializer";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { makeNodeMossOwnershipStore } from "./mossResourceImport.ts";
import { makeMossCanonicalResourceAuthority } from "./mossCanonicalResourceAuthority.ts";
import { canonicalFilesystemHelperTestArch } from "./mossCanonicalFilesystemHelperTestRuntime.ts";

const execFile = promisify(execFileCallback);
const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const REAL_TMPDIR = realpathSync(tmpdir());
const testHelperPath = join(
  repositoryRoot,
  "apps/server",
  "native/moss-canonical-filesystem-helper/build/moss-canonical-filesystem-helper-authority-seam-test",
);
const canonicalFilesystemHelperBuilderPath = join(
  repositoryRoot,
  "apps/server/scripts/build-canonical-filesystem-helper.mjs",
);
const helperPathEnv = "MOSS_CANONICAL_FILESYSTEM_HELPER_PATH";
const projectionPrivateManifestTest =
  "accepts the projection private manifest through the canonical Node authority";
let previousHelperPath: string | undefined;
let previousMossMode: string | undefined;
const nativeIt = canonicalFilesystemHelperTestArch === null ? it.skip : it;

beforeAll(async () => {
  if (canonicalFilesystemHelperTestArch === null) return;
  previousHelperPath = process.env[helperPathEnv];
  previousMossMode = process.env.MOSS_MODE;
  await execFile(
    process.execPath,
    [
      canonicalFilesystemHelperBuilderPath,
      "--arch",
      canonicalFilesystemHelperTestArch,
      "--test-hooks",
      "--output",
      testHelperPath,
    ],
    { cwd: repositoryRoot },
  );
  process.env.MOSS_MODE = "desktop";
  process.env[helperPathEnv] = testHelperPath;
});

afterAll(async () => {
  if (canonicalFilesystemHelperTestArch === null) return;
  await rm(testHelperPath, { force: true });
  await rm(`${testHelperPath}.build.json`, { force: true });
  if (previousHelperPath === undefined) delete process.env[helperPathEnv];
  else process.env[helperPathEnv] = previousHelperPath;
  if (previousMossMode === undefined) delete process.env.MOSS_MODE;
  else process.env.MOSS_MODE = previousMossMode;
});

describe("Moss canonical resource authority seam", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("keeps one injected ownership store and capability as the authority", async () => {
    const stateDir = await mkdtemp(join(REAL_TMPDIR, "moss-canonical-authority-seam-"));
    roots.push(stateDir);
    const ownershipStore = makeNodeMossOwnershipStore(stateDir);
    const filesystemCapability = {} as MossFilesystemCapability;

    const authority = makeMossCanonicalResourceAuthority({
      stateDir,
      ownershipStore,
      filesystemCapability,
    });

    expect(authority.ownershipStore).toBe(ownershipStore);
    expect(authority.filesystemCapability).toBe(filesystemCapability);
    expect(authority.stateDir).toBe(stateDir);
    expect(authority).not.toHaveProperty("workspaceManifest");
    expect(authority).not.toHaveProperty("workspaceLock");
  });

  nativeIt("wires the default native capability to the same Node private stage store", async () => {
    const root = await mkdtemp(join(REAL_TMPDIR, "moss-canonical-authority-live-root-"));
    const stateDir = await mkdtemp(join(REAL_TMPDIR, "moss-canonical-authority-live-state-"));
    roots.push(root, stateDir);
    const authority = makeMossCanonicalResourceAuthority({ stateDir });
    const identity = {
      ownerId: "owner-1",
      projectId: "project-1",
      workspaceId: "workspace-1",
      principalId: "principal-1",
      sessionId: "session-1",
    } as const;
    const lock = await authority.ownershipStore.acquireLock({
      cwd: root,
      ...identity,
      nonce: "nonce-1",
    });
    const stage = await authority.ownershipStore.createPrivateStage({
      transactionId: "transaction-1",
      operationId: "operation-1",
      kind: "skill",
      canonicalRoot: root,
      ...identity,
      fencingToken: lock.fencingToken,
      generation: lock.generation,
      nonce: lock.nonce,
      createdAt: "2026-08-08T00:00:00.000Z",
      leaseExpiresAt: "2099-08-08T00:00:00.000Z",
    });
    await authority.ownershipStore.writePrivateStage?.({
      stage,
      payload: { kind: "file", content: new TextEncoder().encode("native authority\n") },
    });
    const target = join(root, ".moss", "skills", "authority", "SKILL.md");
    const rootFingerprint = createHash("sha256").update(root).digest("hex");
    await authority.filesystemCapability.create({
      cwd: root,
      canonicalRoot: {
        rootPath: root,
        identityFingerprint: rootFingerprint,
        ...identity,
      },
      ...identity,
      targetPath: target,
      stage,
      operationId: "operation-1",
      kind: "skill",
      fencingToken: lock.fencingToken,
      generation: lock.generation,
      nonce: lock.nonce,
      expectedFingerprint: rootFingerprint,
      expectedBeforeHash: createHash("sha256").update("missing").digest("hex"),
      expected: {
        identityFingerprint: rootFingerprint,
        hash: createHash("sha256").update("missing").digest("hex"),
      },
      expectedAfterHash: createHash("sha256").update("native authority\n").digest("hex"),
      expectedAfter: {
        identityFingerprint: rootFingerprint,
        hash: createHash("sha256").update("native authority\n").digest("hex"),
      },
    });
    await expect(readFile(target, "utf8")).resolves.toBe("native authority\n");
    await lock.release();
  });

  nativeIt(projectionPrivateManifestTest, async () => {
    const workspace = await mkdtemp(join(REAL_TMPDIR, "moss-canonical-projection-workspace-"));
    const stateDir = await mkdtemp(join(REAL_TMPDIR, "moss-canonical-projection-state-"));
    roots.push(workspace, stateDir);

    await ensureMossSource({ projectPath: workspace });
    const authority = makeMossCanonicalResourceAuthority({ stateDir });
    const projectionOwnership = makeMossProjectionOwnershipAdapter({
      ownershipStore: authority.ownershipStore,
      filesystemCapability: authority.filesystemCapability,
      authority: {
        ownerId: "owner-projection",
        projectId: "project-projection",
        workspaceId: "workspace-projection",
        principalId: "principal-projection",
        sessionId: "session-projection",
      },
    });

    const result = await materializeMossWorkspaceProjections({
      projectPath: workspace,
      engines: ["codex"],
      ownershipStore: projectionOwnership,
      ownershipOwnerId: "owner-projection",
      ownershipGeneration: "generation-projection",
    });

    expect(result.projections).toHaveLength(1);
    expect(result.projections[0]?.failed ?? false).toBe(false);
    expect(result.projections[0]?.reason ?? "").not.toContain(
      "Private ownership manifest name is not safe",
    );
  });
});
