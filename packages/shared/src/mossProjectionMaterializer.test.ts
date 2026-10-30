import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import OS from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { Schema } from "effect";

import { MossProjectionManifest } from "@synara/contracts";

import {
  MOSS_ENGINE_NATIVE_TARGETS,
  buildMossEngineProjection,
  type MossEngineResourceProjection,
} from "./mossProjectionGovernance";
import {
  materializeMossProjection as materializeMossProjectionRuntime,
  materializeMossWorkspaceProjections as materializeMossWorkspaceProjectionsRuntime,
  readMossProjectionManifestSummary,
  removeMossProjectionResource,
  summarizeMossProjectionResults,
  type MaterializeMossProjectionOptions,
  type MaterializeMossWorkspaceProjectionsOptions,
  type MossProjectionFrozenTarget,
  type MossProjectionOwnershipMutationRequest,
  type MossProjectionOwnershipStore,
  type MossProjectionMaterializeResult,
  mossProjectionIdentityFingerprint,
  mossProjectionPrivateManifestRecordHash,
} from "./mossProjectionMaterializer";
import {
  unsupportedTestProjectionTarget,
  WINDOWS_FILE_SYMLINK_UNSUPPORTED_REASON,
} from "./mossProjectionTestSupport";
import { discoverMossSourceResources } from "./mossResourceRegistry";
import { ensureMossSource } from "./mossSourceBootstrap";
import { MOSS_RELATIVE_PATHS, getMossSourceLayout } from "./mossSourceLayout";

const CODEX_TARGETS = MOSS_ENGINE_NATIVE_TARGETS.codex;
const CLAUDE_TARGETS = MOSS_ENGINE_NATIVE_TARGETS.claudeAgent;
const decodeManifest = Schema.decodeUnknownSync(MossProjectionManifest);

const tempDirs: string[] = [];

async function makeTempWorkspace(prefix = "t3-moss-materialize-"): Promise<string> {
  const tempDir = await mkdtemp(join(OS.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(async () => {
  testProjectionStores.clear();
  for (const tempDir of tempDirs.splice(0)) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

/** Hand-built `.moss` fixture mirroring the 1code projection test fixture. */
async function makeFixture(prefix = "t3-moss-materialize-"): Promise<string> {
  const workspace = await makeTempWorkspace(prefix);
  const layout = getMossSourceLayout(workspace);

  await mkdir(dirname(layout.sourceInstruction), { recursive: true });
  await mkdir(layout.memoryRoot, { recursive: true });
  await mkdir(join(layout.skillsRoot, "review"), { recursive: true });
  await mkdir(dirname(layout.mcpConfig), { recursive: true });
  await mkdir(layout.hooksRoot, { recursive: true });

  await writeFile(layout.sourceInstruction, "# Moss rules\nUse the unified source.\n", "utf8");
  await writeFile(layout.providersConfig, "default: moss\n", "utf8");
  await writeFile(
    join(layout.skillsRoot, "review", "SKILL.md"),
    "---\nname: review\ndescription: Review code\n---\nReview code.\n",
    "utf8",
  );
  await writeFile(
    layout.mcpConfig,
    `${JSON.stringify(
      {
        mcpServers: {
          browser: {
            command: "browser",
            args: ["--headless"],
            env: { MOSS_MCP: "1" },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    join(layout.hooksRoot, "on-stop.md"),
    "---\nname: on-stop\nevent: Stop\ncommand: node on-stop.mjs\n---\nRun after stop.\n",
    "utf8",
  );

  return workspace;
}

async function buildProjection(
  workspace: string,
  engineId: "codex" | "claudeAgent",
): Promise<MossEngineResourceProjection> {
  const resources = await discoverMossSourceResources(workspace);
  return buildMossEngineProjection(engineId, resources);
}

async function expectLinkTo(
  workspace: string,
  linkPath: string,
  sourcePath: string,
): Promise<void> {
  const target = await readlink(join(workspace, linkPath));
  expect(resolve(dirname(join(workspace, linkPath)), target)).toBe(join(workspace, sourcePath));
}

async function expectInstructionProjection(
  workspace: string,
  targetPath: string,
  results: ReadonlyArray<MossProjectionMaterializeResult>,
): Promise<void> {
  const result = results.find((entry) => entry.targetPath === targetPath);
  if (process.platform === "win32") {
    expect(result).toMatchObject({
      action: "symlink",
      status: "unsupported",
      reason: WINDOWS_FILE_SYMLINK_UNSUPPORTED_REASON,
    });
    await expect(lstat(join(workspace, targetPath))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readManifestRaw(workspace)).entries[targetPath]).toBeUndefined();
    return;
  }
  expect(result).toMatchObject({ action: "symlink", status: "created" });
  await expectLinkTo(workspace, targetPath, MOSS_RELATIVE_PATHS.sourceInstruction);
}

async function readManifestRaw(workspace: string): Promise<{
  version: number;
  generatedAt: string;
  entries: Record<
    string,
    {
      engineId: string;
      resourceId: string;
      action: string;
      sourcePath?: string;
      targetPath: string;
      contentHash?: string;
      updatedAt: string;
      contributors?: Array<{ resourceId: string; sourcePath?: string }>;
    }
  >;
}> {
  const raw = await readFile(getMossSourceLayout(workspace).projectionsManifest, "utf8");
  return JSON.parse(raw);
}

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function rejectingCasStore(
  barrier: (targetAbs: string) => Promise<void>,
): MossProjectionOwnershipStore {
  let currentWorkspace: string | undefined;
  let lastRecord:
    | {
        locator: string;
        transactionId: string;
        operationId: string;
        sequence: number;
        previousHash: string;
        recordHash: string;
        value: unknown;
      }
    | undefined;
  return {
    withMutationLock: async (scope, operation) => {
      currentWorkspace = scope.projectRoot;
      return operation("test-fencing-token");
    },
    appendPrivateManifest: async () => {
      throw new Error("deterministic CAS barrier does not write private manifest");
    },
    readPrivateManifest: async () => {
      if (lastRecord) return lastRecord;
      if (!currentWorkspace) return null;
      try {
        const value = JSON.parse(
          await readFile(getMossSourceLayout(currentWorkspace).projectionsManifest, "utf8"),
        ) as unknown;
        lastRecord = {
          locator: "test-private-manifest",
          transactionId: "test-projection-generation",
          operationId: "test-journal-operation",
          sequence: 1,
          previousHash: "0".repeat(64),
          recordHash: mossProjectionPrivateManifestRecordHash({
            operationId: "test-journal-operation",
            sequence: 1,
            previousHash: "0".repeat(64),
            value,
          }),
          value,
        };
        return lastRecord;
      } catch {
        return null;
      }
    },
    create: async () => ({
      status: "conflict",
      reason: "deterministic CAS barrier rejected new creation",
    }),
    publish: async () => ({
      status: "unsupported",
      reason: "deterministic CAS barrier does not publish plugin stages",
    }),
    replace: async (request) => {
      await barrier(request.targetAbs);
      return { status: "conflict", reason: "deterministic CAS barrier rejected the replacement" };
    },
    remove: async (request) => {
      await barrier(request.targetAbs);
      return { status: "conflict", reason: "deterministic CAS barrier rejected the removal" };
    },
  };
}

/**
 * Test-only authority double. Production never installs a canonical target
 * from shared code; this fake stands in for #116's server-owned
 * MossOwnershipStore so the materializer's descriptor contract can be tested
 * without introducing a second durable staging implementation here.
 */
async function installFrozenTarget(
  targetAbs: string,
  target: MossProjectionFrozenTarget,
): Promise<void> {
  if (target.kind === "file") {
    await mkdir(dirname(targetAbs), { recursive: true });
    await writeFile(targetAbs, target.content);
    return;
  }
  if (target.kind === "symlink") {
    await mkdir(dirname(targetAbs), { recursive: true });
    await symlink(target.target, targetAbs, target.linkType);
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

async function appliedProjectionMutation(
  request: MossProjectionOwnershipMutationRequest,
  targetAbs: string,
  target: MossProjectionFrozenTarget,
): Promise<{
  status: "applied";
  receipt: MossProjectionOwnershipMutationRequest["privateManifest"] extends never
    ? never
    : {
        operationId: string;
        canonicalRoot: MossProjectionOwnershipMutationRequest["canonicalRoot"];
        expectedFingerprint: string;
        observedFingerprint: string;
        expectedBeforeHash: string;
        after: {
          state: "present";
          identity: {
            dev: string;
            ino: string;
            mode: number;
            ctimeMs: number;
          };
          fingerprint: string;
          contentHash: string;
        };
        fencingToken: string;
        generation: string;
        nonce: string;
        manifest: {
          locator: string;
          transactionId: string;
          operationId: string;
          sequence: number;
          previousHash: string;
          recordHash: string;
        };
        durable: true;
      };
}> {
  const targetStat = await lstat(targetAbs);
  const identity = {
    dev: String(targetStat.dev),
    ino: String(targetStat.ino),
    mode: targetStat.mode,
    ctimeMs: targetStat.ctimeMs,
  };
  const contentHash =
    target.kind === "symlink" ? sha256(`symlink\0${target.target}`) : target.contentHash;
  return {
    status: "applied",
    receipt: {
      operationId: request.operationId,
      canonicalRoot: request.canonicalRoot,
      expectedFingerprint: request.expectedFingerprint,
      observedFingerprint: mossProjectionIdentityFingerprint(identity),
      expectedBeforeHash: request.expectedBeforeHash,
      after: {
        state: "present",
        identity,
        fingerprint: mossProjectionIdentityFingerprint(identity),
        contentHash,
      },
      fencingToken: request.fencingToken,
      generation: request.generation,
      nonce: request.nonce,
      manifest: {
        locator: "test-private-manifest",
        transactionId: request.privateManifest.transactionId,
        operationId: request.privateManifest.operationId,
        sequence: request.privateManifest.sequence,
        previousHash: request.privateManifest.previousHash,
        recordHash: request.privateManifest.recordHash,
      },
      durable: true,
    },
  };
}

function createTestProjectionStore(): MossProjectionOwnershipStore {
  let currentWorkspace: string | undefined;
  let lockTail = Promise.resolve();
  let lastRecord:
    | {
        locator: string;
        transactionId: string;
        operationId: string;
        sequence: number;
        previousHash: string;
        recordHash: string;
        value: unknown;
      }
    | undefined;
  return {
    withMutationLock: async (scope, operation) => {
      const previous = lockTail;
      let release!: () => void;
      lockTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      currentWorkspace = scope.projectRoot;
      try {
        return await operation("test-fencing-token");
      } finally {
        release();
      }
    },
    appendPrivateManifest: async (input) => {
      if (!currentWorkspace) throw new Error("test authority has no active workspace");
      const manifestPath = getMossSourceLayout(currentWorkspace).projectionsManifest;
      await mkdir(dirname(manifestPath), { recursive: true });
      await writeFile(manifestPath, `${JSON.stringify(input.value)}\n`, "utf8");
      lastRecord = {
        locator: "test-private-manifest",
        transactionId: input.transactionId,
        operationId: input.operationId,
        sequence: input.sequence,
        previousHash: input.previousHash,
        recordHash: input.recordHash,
        value: input.value,
      };
      return lastRecord;
    },
    readPrivateManifest: async () => {
      if (lastRecord) return lastRecord;
      if (!currentWorkspace) return null;
      try {
        const value = JSON.parse(
          await readFile(getMossSourceLayout(currentWorkspace).projectionsManifest, "utf8"),
        ) as unknown;
        lastRecord = {
          locator: "test-private-manifest",
          transactionId: "test-projection-generation",
          operationId: "test-journal-operation",
          sequence: 1,
          previousHash: "0".repeat(64),
          recordHash: mossProjectionPrivateManifestRecordHash({
            operationId: "test-journal-operation",
            sequence: 1,
            previousHash: "0".repeat(64),
            value,
          }),
          value,
        };
        return lastRecord;
      } catch {
        return null;
      }
    },
    create: async (request, target) => {
      const unsupported = unsupportedTestProjectionTarget(target);
      if (unsupported) return unsupported;
      try {
        await lstat(request.targetAbs);
        return { status: "conflict", reason: "test target already exists" };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await installFrozenTarget(request.targetAbs, target);
      return appliedProjectionMutation(request, request.targetAbs, target);
    },
    publish: async (request, target) => {
      const unsupported = unsupportedTestProjectionTarget(target);
      if (unsupported) return unsupported;
      try {
        await lstat(request.targetAbs);
        return { status: "conflict", reason: "test target already exists" };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await installFrozenTarget(request.targetAbs, target);
      if (!currentWorkspace) throw new Error("test authority has no active workspace");
      const manifestPath = getMossSourceLayout(currentWorkspace).projectionsManifest;
      await mkdir(dirname(manifestPath), { recursive: true });
      await writeFile(manifestPath, `${JSON.stringify(request.privateManifest.value)}\n`, "utf8");
      lastRecord = {
        locator: "test-private-manifest",
        transactionId: request.privateManifest.transactionId,
        operationId: request.privateManifest.operationId,
        sequence: request.privateManifest.sequence,
        previousHash: request.privateManifest.previousHash,
        recordHash: request.privateManifest.recordHash,
        value: request.privateManifest.value,
      };
      return appliedProjectionMutation(request, request.targetAbs, target);
    },
    replace: async () => ({
      status: "conflict",
      reason: "test store does not exercise replacement",
    }),
    remove: async () => ({
      status: "conflict",
      reason: "test store does not exercise removal",
    }),
  };
}

const testProjectionStores = new Map<string, MossProjectionOwnershipStore>();

function testProjectionStoreFor(workspace: string): MossProjectionOwnershipStore {
  const existing = testProjectionStores.get(workspace);
  if (existing) return existing;
  const store = createTestProjectionStore();
  testProjectionStores.set(workspace, store);
  return store;
}

async function materializeMossProjection(
  options: MaterializeMossProjectionOptions,
): ReturnType<typeof materializeMossProjectionRuntime> {
  return materializeMossProjectionRuntime({
    ...options,
    ownershipStore: options.ownershipStore ?? testProjectionStoreFor(options.projectPath),
    ownershipOwnerId: options.ownershipOwnerId ?? "test-projection-owner",
    ownershipGeneration: options.ownershipGeneration ?? "test-projection-generation",
  });
}

async function materializeMossWorkspaceProjections(
  options: MaterializeMossWorkspaceProjectionsOptions,
): ReturnType<typeof materializeMossWorkspaceProjectionsRuntime> {
  return materializeMossWorkspaceProjectionsRuntime({
    ...options,
    ownershipStore: options.ownershipStore ?? testProjectionStoreFor(options.projectPath),
    ownershipOwnerId: options.ownershipOwnerId ?? "test-projection-owner",
    ownershipGeneration: options.ownershipGeneration ?? "test-projection-generation",
  });
}

/** Recursive relative-path -> sha256 manifest of every file/symlink under root. */
async function snapshotTree(root: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};

  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        entries[relative(root, absolutePath)] = `link:${await readlink(absolutePath)}`;
        continue;
      }
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      entries[relative(root, absolutePath)] = sha256(await readFile(absolutePath));
    }
  }

  await walk(root);
  return entries;
}

describe("materializeMossProjection", () => {
  it("keeps native durability absence typed as unsupported instead of conflict", async () => {
    const workspace = await makeFixture();
    const results = await materializeMossProjection({
      projectPath: workspace,
      projection: {
        engineId: "codex",
        status: "ready",
        warnings: [],
        mappings: [
          {
            resourceId: "unsupported:symlink",
            action: "symlink",
            sourcePath: MOSS_RELATIVE_PATHS.sourceInstruction,
            targetPath: ".codex/unsupported-link",
          },
        ],
      },
      ownershipStore: rejectingCasStore(async () => undefined),
      ownershipOwnerId: "test-owner",
      ownershipGeneration: "test-generation",
    });

    expect(results[0]).toMatchObject({
      action: "symlink",
      status: "unsupported",
      reason: "deterministic CAS barrier does not publish plugin stages",
    });
  });

  it("merges concurrent workspace writes instead of losing a projection contributor", async () => {
    const workspace = await makeFixture();
    const action = process.platform === "win32" ? "copy" : "symlink";
    const first: MossEngineResourceProjection = {
      engineId: "codex",
      status: "ready",
      mappings: [
        {
          resourceId: "concurrent:first",
          action,
          sourcePath: MOSS_RELATIVE_PATHS.sourceInstruction,
          targetPath: ".codex/concurrent-first",
        },
      ],
      warnings: [],
    };
    const second: MossEngineResourceProjection = {
      engineId: "codex",
      status: "ready",
      mappings: [
        {
          resourceId: "concurrent:second",
          action,
          sourcePath: MOSS_RELATIVE_PATHS.providersConfig,
          targetPath: ".codex/concurrent-second",
        },
      ],
      warnings: [],
    };

    await Promise.all([
      materializeMossProjection({ projectPath: workspace, projection: first }),
      materializeMossProjection({ projectPath: workspace, projection: second }),
    ]);

    const manifest = await readManifestRaw(workspace);
    expect(manifest.entries[join(".codex", "concurrent-first")]?.resourceId).toBe(
      "concurrent:first",
    );
    expect(manifest.entries[join(".codex", "concurrent-second")]?.resourceId).toBe(
      "concurrent:second",
    );
    expect(await readFile(join(workspace, ".codex", "concurrent-first"), "utf8")).toBe(
      await readFile(join(workspace, MOSS_RELATIVE_PATHS.sourceInstruction), "utf8"),
    );
    expect(await readFile(join(workspace, ".codex", "concurrent-second"), "utf8")).toBe(
      await readFile(join(workspace, MOSS_RELATIVE_PATHS.providersConfig), "utf8"),
    );
  });

  it("checks parent containment before adopting a same-source symlink", async () => {
    const workspace = await makeFixture();
    const external = await makeTempWorkspace("t3-moss-materialize-external-");
    const externalTarget = join(external, "adopted");
    const sourcePath =
      process.platform === "win32"
        ? `${MOSS_RELATIVE_PATHS.skillsRoot}/review`
        : MOSS_RELATIVE_PATHS.sourceInstruction;
    await symlink(
      join(workspace, sourcePath),
      externalTarget,
      process.platform === "win32" ? "junction" : "file",
    );
    await symlink(
      external,
      join(workspace, ".codex"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const projection: MossEngineResourceProjection = {
      engineId: "codex",
      status: "ready",
      mappings: [
        {
          resourceId: "moss:unsafe-parent",
          action: "symlink",
          sourcePath,
          targetPath: ".codex/adopted",
        },
      ],
      warnings: [],
    };
    const results = await materializeMossProjection({ projectPath: workspace, projection });

    expect(results[0]).toMatchObject({ status: "conflict" });
    expect(await readlink(externalTarget)).toBe(join(workspace, sourcePath));
    await expect(lstat(getMossSourceLayout(workspace).projectionsManifest)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("materializes supported claudeAgent links, bridge, and adapter with manifest provenance", async () => {
    const workspace = await makeFixture();
    const projection = await buildProjection(workspace, "claudeAgent");
    const results = await materializeMossProjection({ projectPath: workspace, projection });

    expect(results).toContainEqual(
      expect.objectContaining({
        engineId: "claudeAgent",
        resourceId: "moss:instruction:moss.md",
        action: "symlink",
        status: process.platform === "win32" ? "unsupported" : "created",
      }),
    );
    await expectInstructionProjection(workspace, CLAUDE_TARGETS.instructionFile, results);
    await expectLinkTo(workspace, CLAUDE_TARGETS.memoryRoot, MOSS_RELATIVE_PATHS.memoryRoot);
    await expectLinkTo(
      workspace,
      join(CLAUDE_TARGETS.skillsRoot, "review"),
      `${MOSS_RELATIVE_PATHS.skillsRoot}/review`,
    );
    const skillLinkStat = await lstat(join(workspace, CLAUDE_TARGETS.skillsRoot, "review"));
    expect(skillLinkStat.isSymbolicLink()).toBe(true);

    // .mcp.json passthrough of the canonical Moss MCP config.
    const mcpConfig = JSON.parse(await readFile(join(workspace, CLAUDE_TARGETS.mcpBridge), "utf8"));
    expect(mcpConfig.mcpServers.browser.command).toBe("browser");

    // Hook adapter manifest.
    const adapter = JSON.parse(
      await readFile(join(workspace, CLAUDE_TARGETS.hooksRoot, ".moss-adapter.json"), "utf8"),
    );
    expect(adapter).toMatchObject({ version: 1, engineId: "claudeAgent", generatedBy: "moss" });
    expect(adapter.resources).toContainEqual(
      expect.objectContaining({ resourceId: "moss:hook:on-stop" }),
    );

    // Manifest decodes through the contracts schema and records provenance.
    const manifest = decodeManifest(await readManifestRaw(workspace));
    const instructionEntry = manifest.entries[CLAUDE_TARGETS.instructionFile];
    if (process.platform === "win32") {
      expect(instructionEntry).toBeUndefined();
    } else {
      expect(instructionEntry).toMatchObject({
        engineId: "claudeAgent",
        resourceId: "moss:instruction:moss.md",
        action: "symlink",
        sourcePath: MOSS_RELATIVE_PATHS.sourceInstruction,
      });
    }
    const bridgeEntry = manifest.entries[CLAUDE_TARGETS.mcpBridge];
    expect(bridgeEntry?.contentHash).toBe(
      sha256(await readFile(join(workspace, CLAUDE_TARGETS.mcpBridge))),
    );
    const adapterEntry = manifest.entries[join(CLAUDE_TARGETS.hooksRoot, ".moss-adapter.json")];
    expect(adapterEntry?.contentHash).toBe(
      sha256(await readFile(join(workspace, CLAUDE_TARGETS.hooksRoot, ".moss-adapter.json"))),
    );
  });

  it("materializes the codex config.toml bridge with multi-contributor provenance", async () => {
    const workspace = await makeFixture();
    const projection = await buildProjection(workspace, "codex");
    const results = await materializeMossProjection({ projectPath: workspace, projection });

    await expectInstructionProjection(workspace, CODEX_TARGETS.instructionFile, results);
    await expectLinkTo(
      workspace,
      join(CODEX_TARGETS.skillsRoot, "review"),
      `${MOSS_RELATIVE_PATHS.skillsRoot}/review`,
    );

    const codexToml = await readFile(join(workspace, CODEX_TARGETS.mcpBridge), "utf8");
    expect(codexToml.startsWith("# Generated by Moss")).toBe(true);
    expect(codexToml).toContain("[mcp_servers.browser]");
    expect(codexToml).toContain('command = "browser"');
    expect(codexToml).toContain('args = ["--headless"]');
    expect(codexToml).toContain("[mcp_servers.browser.env]");
    expect(codexToml).toContain('MOSS_MCP = "1"');
    expect(codexToml).toContain(
      `# Moss provider routing source: ${join(MOSS_RELATIVE_PATHS.providersConfig)}`,
    );

    // Both mcp and provider resources share the toml target and are recorded.
    const bridgeResults = results.filter(
      (result) =>
        result.action === "managed-bridge" && result.targetPath === CODEX_TARGETS.mcpBridge,
    );
    expect(bridgeResults.map((result) => result.resourceId).toSorted()).toEqual([
      "moss:mcp:browser",
      "moss:provider:providers.yaml",
    ]);

    const manifest = decodeManifest(await readManifestRaw(workspace));
    const tomlEntry = manifest.entries[join(CODEX_TARGETS.mcpBridge)];
    expect(tomlEntry?.contentHash).toBe(sha256(codexToml));
    expect(
      tomlEntry?.contributors?.map((contributor) => contributor.resourceId).toSorted(),
    ).toEqual(["moss:mcp:browser", "moss:provider:providers.yaml"]);
  });

  it("writes the generic moss.generated marker for the claude provider bridge", async () => {
    const workspace = await makeFixture();
    const projection = await buildProjection(workspace, "claudeAgent");
    await materializeMossProjection({ projectPath: workspace, projection });

    const settings = JSON.parse(
      await readFile(join(workspace, CLAUDE_TARGETS.providerBridge), "utf8"),
    );
    expect(settings.moss.generated).toBe(true);
    expect(settings.moss.sources).toContain(join(MOSS_RELATIVE_PATHS.providersConfig));
  });

  it("refuses unmanaged targets and leaves them byte-identical (conflict)", async () => {
    const workspace = await makeFixture();
    const userInstruction = "local override\n";
    const userMcp = `${JSON.stringify(
      { mcpServers: { userServer: { command: "user-server" } } },
      null,
      2,
    )}\n`;
    await writeFile(join(workspace, CLAUDE_TARGETS.instructionFile), userInstruction, "utf8");
    await writeFile(join(workspace, CLAUDE_TARGETS.mcpBridge), userMcp, "utf8");

    const projection = await buildProjection(workspace, "claudeAgent");
    const results = await materializeMossProjection({ projectPath: workspace, projection });

    const instructionResult = results.find(
      (result) => result.targetPath === CLAUDE_TARGETS.instructionFile,
    );
    expect(instructionResult?.status).toBe("conflict");
    expect(instructionResult?.reason).toContain("Target exists and is not managed");
    const mcpResult = results.find((result) => result.targetPath === CLAUDE_TARGETS.mcpBridge);
    expect(mcpResult?.status).toBe("conflict");
    expect(mcpResult?.reason).toContain("Target exists and is not managed");

    expect(await readFile(join(workspace, CLAUDE_TARGETS.instructionFile), "utf8")).toBe(
      userInstruction,
    );
    expect(await readFile(join(workspace, CLAUDE_TARGETS.mcpBridge), "utf8")).toBe(userMcp);

    const manifest = await readManifestRaw(workspace);
    expect(manifest.entries[CLAUDE_TARGETS.instructionFile]).toBeUndefined();
    expect(manifest.entries[CLAUDE_TARGETS.mcpBridge]).toBeUndefined();
  });

  it("reports a conflict when the symlink source is missing", async () => {
    const workspace = await makeFixture();
    const projection: MossEngineResourceProjection = {
      engineId: "codex",
      status: "ready",
      mappings: [
        {
          resourceId: "moss:memory:gone",
          action: "symlink",
          sourcePath: `${MOSS_RELATIVE_PATHS.memoryRoot}/gone.md`,
          targetPath: join(CODEX_TARGETS.memoryRoot, "gone.md"),
        },
      ],
      warnings: [],
    };
    const results = await materializeMossProjection({ projectPath: workspace, projection });
    expect(results[0]).toMatchObject({
      status: "conflict",
      reason: "Source path does not exist.",
    });
  });

  it("keeps matching unowned links read-only and fail-closes forgeable bridge markers (A4)", async () => {
    const workspace = await makeFixture();
    const layout = getMossSourceLayout(workspace);
    // Overwrite the fixture MCP config with an empty one so the passthrough
    // projection content is observable against the compact preset below.
    await writeFile(layout.mcpConfig, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`, "utf8");

    // (a) Symlink already pointing at the Moss source.
    const existingLinkPath =
      process.platform === "win32" ? CLAUDE_TARGETS.memoryRoot : CLAUDE_TARGETS.instructionFile;
    await mkdir(dirname(join(workspace, existingLinkPath)), { recursive: true });
    await symlink(
      process.platform === "win32" ? layout.memoryRoot : layout.sourceInstruction,
      join(workspace, existingLinkPath),
      process.platform === "win32" ? "junction" : "file",
    );
    // (b) Compact empty mcp bridge (different bytes from the projection).
    await writeFile(join(workspace, CLAUDE_TARGETS.mcpBridge), '{"mcpServers":{}}', "utf8");
    // (c) Valid empty Moss adapter manifest.
    await mkdir(join(workspace, CLAUDE_TARGETS.hooksRoot), { recursive: true });
    await writeFile(
      join(workspace, CLAUDE_TARGETS.hooksRoot, ".moss-adapter.json"),
      `${JSON.stringify({ version: 1, generatedBy: "moss", resources: [] }, null, 2)}\n`,
      "utf8",
    );

    const projection = await buildProjection(workspace, "claudeAgent");
    const results = await materializeMossProjection({ projectPath: workspace, projection });

    expect(results.filter((result) => result.status === "conflict")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ targetPath: existingLinkPath }),
        expect.objectContaining({ targetPath: CLAUDE_TARGETS.mcpBridge }),
        expect.objectContaining({ targetPath: CLAUDE_TARGETS.hooksRoot }),
      ]),
    );
    expect(results).toContainEqual(
      expect.objectContaining({
        targetPath: existingLinkPath,
        status: "conflict",
        reason: expect.stringContaining("not registered"),
      }),
    );

    // (b) existing content is preserved because markers cannot authorize a
    // destructive replacement.
    expect(await readFile(join(workspace, CLAUDE_TARGETS.mcpBridge), "utf8")).toBe(
      '{"mcpServers":{}}',
    );
    // (c) existing adapter content is also preserved.
    const adapter = JSON.parse(
      await readFile(join(workspace, CLAUDE_TARGETS.hooksRoot, ".moss-adapter.json"), "utf8"),
    );
    expect(adapter.resources).toEqual([]);

    const manifest = await readManifestRaw(workspace);
    expect(manifest.entries[CLAUDE_TARGETS.instructionFile]).toBeUndefined();
    expect(manifest.entries[CLAUDE_TARGETS.mcpBridge]).toBeUndefined();
    expect(manifest.entries[join(CLAUDE_TARGETS.hooksRoot, ".moss-adapter.json")]).toBeUndefined();
  });

  it("does not let a forgeable moss.generated marker authorize bridge replacement", async () => {
    const workspace = await makeFixture();
    await mkdir(join(workspace, dirname(CLAUDE_TARGETS.providerBridge)), { recursive: true });
    await writeFile(
      join(workspace, CLAUDE_TARGETS.providerBridge),
      `${JSON.stringify(
        {
          moss: {
            generated: true,
            sources: [MOSS_RELATIVE_PATHS.providersConfig],
            note: "Generated by Moss.",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const projection = await buildProjection(workspace, "claudeAgent");
    const results = await materializeMossProjection({ projectPath: workspace, projection });

    expect(results).toContainEqual(
      expect.objectContaining({
        resourceId: "moss:provider:providers.yaml",
        targetPath: CLAUDE_TARGETS.providerBridge,
        status: "conflict",
      }),
    );
    expect(await readFile(join(workspace, CLAUDE_TARGETS.providerBridge), "utf8")).toContain(
      '"generated": true',
    );
    const manifest = await readManifestRaw(workspace);
    expect(manifest.entries[CLAUDE_TARGETS.providerBridge]).toBeUndefined();
  });

  it("keeps Moss memory entries native under one projected memory root", async () => {
    const workspace = await makeFixture();
    const layout = getMossSourceLayout(workspace);
    await writeFile(
      join(layout.memoryRoot, "customer-context.md"),
      "---\nname: customer-context\n---\nUse Moss memory.\n",
      "utf8",
    );

    const materialized = await materializeMossWorkspaceProjections({ projectPath: workspace });
    await expectLinkTo(workspace, CLAUDE_TARGETS.memoryRoot, MOSS_RELATIVE_PATHS.memoryRoot);
    await expectLinkTo(workspace, CODEX_TARGETS.memoryRoot, MOSS_RELATIVE_PATHS.memoryRoot);
    expect(
      await readFile(join(workspace, CLAUDE_TARGETS.memoryRoot, "customer-context.md"), "utf8"),
    ).toContain("Use Moss memory.");
    expect(
      await readFile(join(workspace, CODEX_TARGETS.memoryRoot, "customer-context.md"), "utf8"),
    ).toContain("Use Moss memory.");

    for (const engineId of ["claudeAgent", "codex"] as const) {
      const engineProjection = materialized.projections.find(
        (projection) => projection.engineId === engineId,
      );
      expect(engineProjection?.results).toContainEqual(
        expect.objectContaining({
          resourceId: "moss:memory:customer-context",
          action: "native",
          status: "skipped",
        }),
      );
    }
  });

  it("is idempotent: second run reports zero created/updated/conflict and leaves bytes unchanged", async () => {
    const workspace = await makeFixture();

    const first = await materializeMossWorkspaceProjections({ projectPath: workspace });
    for (const projection of first.projections) {
      expect(projection.summary.conflict).toBe(0);
      expect(projection.summary.created).toBeGreaterThan(0);
    }
    const firstSnapshot = await snapshotTree(workspace);
    const firstManifest = await readManifestRaw(workspace);

    const second = await materializeMossWorkspaceProjections({ projectPath: workspace });
    for (const projection of second.projections) {
      expect(projection.summary.created).toBe(0);
      expect(projection.summary.updated).toBe(0);
      expect(projection.summary.conflict).toBe(0);
      for (const result of projection.results) {
        expect(["skipped", "unsupported"]).toContain(result.status);
      }
    }

    const secondSnapshot = await snapshotTree(workspace);
    const secondManifest = await readManifestRaw(workspace);
    const manifestKey = relative(workspace, getMossSourceLayout(workspace).projectionsManifest);
    const { [manifestKey]: _firstManifestHash, ...firstRest } = firstSnapshot;
    const { [manifestKey]: _secondManifestHash, ...secondRest } = secondSnapshot;
    expect(secondRest).toEqual(firstRest);
    // Manifest changes only in generatedAt.
    expect(secondManifest.entries).toEqual(firstManifest.entries);
    expect(secondManifest.generatedAt >= firstManifest.generatedAt).toBe(true);
  });

  it("does not touch the filesystem in dry-run mode", async () => {
    const workspace = await makeFixture();
    const before = await snapshotTree(workspace);

    const projection = await buildProjection(workspace, "codex");
    const results = await materializeMossProjection({
      projectPath: workspace,
      projection,
      dryRun: true,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(await snapshotTree(workspace)).toEqual(before);
  });

  it("is fully read-only without a server-owned projection authority", async () => {
    const workspace = await makeFixture();
    const before = await snapshotTree(workspace);
    const projection = await buildProjection(workspace, "codex");

    const results = await materializeMossProjectionRuntime({
      projectPath: workspace,
      projection,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(
      results.some((result) => result.status === "created" || result.status === "updated"),
    ).toBe(false);
    expect(await snapshotTree(workspace)).toEqual(before);
    await expect(
      lstat(`${getMossSourceLayout(workspace).projectionsManifest}.lock`),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function copyProjection(
  sourcePath: string,
  targetPath: string,
  resourceId = "moss:memory:copy-entry",
): MossEngineResourceProjection {
  return {
    engineId: "codex",
    status: "ready",
    mappings: [{ resourceId, action: "copy", sourcePath, targetPath }],
    warnings: [],
  };
}

describe("materializeMossProjection copy action", () => {
  it("rejects an applied receipt whose canonical root is not bound to the request", async () => {
    const workspace = await makeFixture();
    const layout = getMossSourceLayout(workspace);
    const sourceRel = `${MOSS_RELATIVE_PATHS.memoryRoot}/forged-receipt.md`;
    const targetRel = join(CODEX_TARGETS.memoryRoot, "forged-receipt.md");
    await writeFile(join(layout.memoryRoot, "forged-receipt.md"), "frozen\n", "utf8");

    const base = createTestProjectionStore();
    const forgedStore: MossProjectionOwnershipStore = {
      ...base,
      publish: async (request, target) => {
        const result = await base.create(request, target);
        if (result.status !== "applied") return result;
        return {
          ...result,
          receipt: {
            ...result.receipt,
            canonicalRoot: {
              rootPath: "/tmp/other-project",
              identityFingerprint: "forged-root",
            },
          },
        } as unknown as typeof result;
      },
    };

    const results = await materializeMossProjectionRuntime({
      projectPath: workspace,
      projection: copyProjection(sourceRel, targetRel),
      ownershipStore: forgedStore,
      ownershipOwnerId: "server-test-owner",
      ownershipGeneration: "generation-forged-receipt",
    });

    expect(results[0]).toMatchObject({ status: "conflict" });
    expect(await readFile(join(workspace, targetRel), "utf8")).toBe("frozen\n");
    await expect(lstat(join(workspace, targetRel))).resolves.toBeDefined();
    await expect(lstat(layout.projectionsManifest)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when a private projection journal record hash cannot be recomputed", async () => {
    const workspace = await makeFixture();
    const layout = getMossSourceLayout(workspace);
    const sourceRel = `${MOSS_RELATIVE_PATHS.memoryRoot}/bad-journal.md`;
    const targetRel = join(CODEX_TARGETS.memoryRoot, "bad-journal.md");
    await writeFile(join(layout.memoryRoot, "bad-journal.md"), "journal\n", "utf8");

    const base = createTestProjectionStore();
    const corruptJournalStore: MossProjectionOwnershipStore = {
      ...base,
      readPrivateManifest: async () => ({
        locator: "corrupt-journal",
        transactionId: "generation-bad-journal",
        operationId: "operation-bad-journal",
        sequence: 1,
        previousHash: "0".repeat(64),
        recordHash: "f".repeat(64),
        value: { version: 1, generatedAt: new Date().toISOString(), entries: {} },
      }),
    } as MossProjectionOwnershipStore;

    await expect(
      materializeMossProjectionRuntime({
        projectPath: workspace,
        projection: copyProjection(sourceRel, targetRel),
        ownershipStore: corruptJournalStore,
        ownershipOwnerId: "server-test-owner",
        ownershipGeneration: "generation-bad-journal",
      }),
    ).rejects.toThrow(/journal|receipt|manifest/i);
    await expect(lstat(join(workspace, targetRel))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a target outside the canonical project root before invoking the authority", async () => {
    const workspace = await makeFixture();
    const layout = getMossSourceLayout(workspace);
    const sourceRel = `${MOSS_RELATIVE_PATHS.memoryRoot}/escape.md`;
    await writeFile(join(layout.memoryRoot, "escape.md"), "escape\n", "utf8");
    let mutationCalls = 0;
    const base = createTestProjectionStore();
    const guardedStore: MossProjectionOwnershipStore = {
      ...base,
      create: async () => {
        mutationCalls += 1;
        return { status: "conflict", reason: "authority should not receive escaped targets" };
      },
    };

    const results = await materializeMossProjectionRuntime({
      projectPath: workspace,
      projection: copyProjection(sourceRel, "../escaped-target.md"),
      ownershipStore: guardedStore,
      ownershipOwnerId: "server-test-owner",
      ownershipGeneration: "generation-root-guard",
    });

    expect(results[0]).toMatchObject({ status: "conflict" });
    expect(results[0]?.reason).toMatch(/canonical|root|outside|relative/i);
    expect(mutationCalls).toBe(0);
  });

  it("does not skip an identical target that is absent from the server-owned manifest", async () => {
    const workspace = await makeFixture();
    const layout = getMossSourceLayout(workspace);
    const sourceRel = `${MOSS_RELATIVE_PATHS.memoryRoot}/unregistered.md`;
    const targetRel = join(CODEX_TARGETS.memoryRoot, "unregistered.md");
    await writeFile(join(layout.memoryRoot, "unregistered.md"), "same bytes\n", "utf8");
    await mkdir(dirname(join(workspace, targetRel)), { recursive: true });
    await writeFile(join(workspace, targetRel), "same bytes\n", "utf8");

    const results = await materializeMossProjectionRuntime({
      projectPath: workspace,
      projection: copyProjection(sourceRel, targetRel),
    });

    expect(results[0]).toMatchObject({ status: "conflict" });
    expect(results[0]?.reason).toMatch(/managed|registered|authority|manifest/i);
  });

  it("creates the copy, records contentHash, and skips when bytes already match", async () => {
    const workspace = await makeFixture();
    const layout = getMossSourceLayout(workspace);
    const sourceRel = `${MOSS_RELATIVE_PATHS.memoryRoot}/copy-entry.md`;
    const targetRel = join(CODEX_TARGETS.memoryRoot, "copy-entry.md");
    await writeFile(join(layout.memoryRoot, "copy-entry.md"), "copy me\n", "utf8");

    const created = await materializeMossProjection({
      projectPath: workspace,
      projection: copyProjection(sourceRel, targetRel),
    });
    expect(created[0]).toMatchObject({ action: "copy", status: "created" });
    expect(await readFile(join(workspace, targetRel), "utf8")).toBe("copy me\n");
    const manifest = await readManifestRaw(workspace);
    expect(manifest.entries[targetRel]).toMatchObject({
      action: "copy",
      contentHash: sha256("copy me\n"),
    });
    expect("targetIdentity" in (manifest.entries[targetRel] ?? {})).toBe(false);

    const skipped = await materializeMossProjection({
      projectPath: workspace,
      projection: copyProjection(sourceRel, targetRel),
    });
    expect(skipped[0]).toMatchObject({ action: "copy", status: "skipped" });

    // Source change cannot replace an existing target without a real server
    // CAS authority; the existing target remains intact.
    await writeFile(join(layout.memoryRoot, "copy-entry.md"), "copy me v2\n", "utf8");
    const updated = await materializeMossProjection({
      projectPath: workspace,
      projection: copyProjection(sourceRel, targetRel),
    });
    expect(updated[0]).toMatchObject({ action: "copy", status: "conflict" });
    expect(await readFile(join(workspace, targetRel), "utf8")).toBe("copy me\n");
  });

  it("refuses unmanaged copy targets and leaves them unchanged", async () => {
    const workspace = await makeFixture();
    const layout = getMossSourceLayout(workspace);
    const sourceRel = `${MOSS_RELATIVE_PATHS.memoryRoot}/copy-entry.md`;
    const targetRel = join(CODEX_TARGETS.memoryRoot, "copy-entry.md");
    await writeFile(join(layout.memoryRoot, "copy-entry.md"), "moss copy\n", "utf8");
    await mkdir(join(workspace, CODEX_TARGETS.memoryRoot), { recursive: true });
    await writeFile(join(workspace, targetRel), "user data\n", "utf8");

    const results = await materializeMossProjection({
      projectPath: workspace,
      projection: copyProjection(sourceRel, targetRel),
    });
    expect(results[0]?.status).toBe("conflict");
    expect(results[0]?.reason).toContain("Target exists and is not managed");
    expect(await readFile(join(workspace, targetRel), "utf8")).toBe("user data\n");
  });

  it("does not let a forged manifest identity authorize deleting a replacement target", async () => {
    const workspace = await makeFixture();
    const layout = getMossSourceLayout(workspace);
    const sourceRel = MOSS_RELATIVE_PATHS.memoryRoot + "/identity-entry.md";
    const targetRel = join(CODEX_TARGETS.memoryRoot, "identity-entry.md");
    await writeFile(join(layout.memoryRoot, "identity-entry.md"), "owned\n", "utf8");
    await materializeMossProjection({
      projectPath: workspace,
      projection: copyProjection(sourceRel, targetRel),
    });

    await unlink(join(workspace, targetRel));
    await writeFile(join(workspace, targetRel), "owned\n", "utf8");

    // The workspace manifest is attacker-controlled.  Forge every field the
    // old implementation used for deletion, including the replacement inode.
    const manifestPath = getMossSourceLayout(workspace).projectionsManifest;
    const forgedManifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      entries: Record<string, Record<string, unknown>>;
    };
    const replacementIdentity = await lstat(join(workspace, targetRel));
    forgedManifest.entries[targetRel] = {
      ...forgedManifest.entries[targetRel],
      resourceId: "moss:memory:copy-entry",
      sourcePath: sourceRel,
      targetPath: targetRel,
      contentHash: sha256("owned\n"),
      targetIdentity: {
        dev: String(replacementIdentity.dev),
        ino: String(replacementIdentity.ino),
        mode: replacementIdentity.mode,
      },
    };
    await writeFile(manifestPath, `${JSON.stringify(forgedManifest)}\n`, "utf8");

    const removed = await removeMossProjectionResource({
      projectPath: workspace,
      resourceId: "moss:memory:copy-entry",
      targetPaths: [targetRel],
      removeTargets: true,
    });

    expect(removed.removedTargets).toEqual([]);
    expect(removed.removedEntries).toEqual([]);
    expect(removed.conflictedTargets).toEqual([targetRel]);
    expect(await readFile(join(workspace, targetRel), "utf8")).toBe("owned\n");
    expect((await readManifestRaw(workspace)).entries[targetRel]).toBeTruthy();
  });

  it("never deletes an explicit unowned symlink when the manifest has no matching entry", async () => {
    const workspace = await makeFixture();
    const layout = getMossSourceLayout(workspace);
    const sourceRel = `${MOSS_RELATIVE_PATHS.memoryRoot}/receipt-source.md`;
    const managedTargetRel = join(CODEX_TARGETS.memoryRoot, "receipt-source.md");
    await writeFile(join(layout.memoryRoot, "receipt-source.md"), "source\n", "utf8");
    await materializeMossProjection({
      projectPath: workspace,
      projection: copyProjection(sourceRel, managedTargetRel),
    });

    const unownedTargetRel = join(CODEX_TARGETS.memoryRoot, "user-link");
    const unownedSourceRel =
      process.platform === "win32" ? `${MOSS_RELATIVE_PATHS.skillsRoot}/review` : sourceRel;
    await symlink(
      join(workspace, unownedSourceRel),
      join(workspace, unownedTargetRel),
      process.platform === "win32" ? "junction" : "file",
    );
    const removed = await removeMossProjectionResource({
      projectPath: workspace,
      resourceId: "moss:unrelated:resource",
      targetPaths: [unownedTargetRel],
      removeTargets: true,
    });

    expect(removed.removedTargets).toEqual([]);
    expect(await readlink(join(workspace, unownedTargetRel))).toBe(
      join(workspace, unownedSourceRel),
    );
  });

  it("preserves a replacement written at the CAS barrier before materialize mutation", async () => {
    const workspace = await makeFixture();
    const layout = getMossSourceLayout(workspace);
    const sourceRel = `${MOSS_RELATIVE_PATHS.memoryRoot}/replace-barrier.md`;
    const targetRel = join(CODEX_TARGETS.memoryRoot, "replace-barrier.md");
    await writeFile(join(layout.memoryRoot, "replace-barrier.md"), "before\n", "utf8");
    await materializeMossProjection({
      projectPath: workspace,
      projection: copyProjection(sourceRel, targetRel),
    });
    await writeFile(join(layout.memoryRoot, "replace-barrier.md"), "after\n", "utf8");

    const store = rejectingCasStore(async (targetAbs) => {
      await writeFile(targetAbs, "external replacement\n", "utf8");
    });
    const results = await materializeMossProjection({
      projectPath: workspace,
      projection: copyProjection(sourceRel, targetRel),
      ownershipStore: store,
      ownershipOwnerId: "server-test-owner",
      ownershipGeneration: "generation-replace-barrier",
    });

    expect(results[0]).toMatchObject({
      status: "conflict",
      reason: "deterministic CAS barrier rejected the replacement",
    });
    expect(await readFile(join(workspace, targetRel), "utf8")).toBe("external replacement\n");
  });

  it("preserves a replacement written at the CAS barrier before delete", async () => {
    const workspace = await makeFixture();
    const layout = getMossSourceLayout(workspace);
    const sourceRel = `${MOSS_RELATIVE_PATHS.memoryRoot}/delete-barrier.md`;
    const targetRel = join(CODEX_TARGETS.memoryRoot, "delete-barrier.md");
    await writeFile(join(layout.memoryRoot, "delete-barrier.md"), "owned\n", "utf8");
    await materializeMossProjection({
      projectPath: workspace,
      projection: copyProjection(sourceRel, targetRel),
    });

    const store = rejectingCasStore(async (targetAbs) => {
      await writeFile(targetAbs, "external replacement\n", "utf8");
    });
    const removal = await removeMossProjectionResource({
      projectPath: workspace,
      resourceId: "moss:memory:copy-entry",
      targetPaths: [targetRel],
      removeTargets: true,
      ownershipStore: store,
      ownershipOwnerId: "server-test-owner",
      ownershipGeneration: "generation-delete-barrier",
    });

    expect(removal.removedEntries).toEqual([]);
    expect(removal.removedTargets).toEqual([]);
    expect(removal.conflictedTargets).toEqual([targetRel]);
    expect(await readFile(join(workspace, targetRel), "utf8")).toBe("external replacement\n");
    expect((await readManifestRaw(workspace)).entries[targetRel]).toBeTruthy();
  });

  it("preserves an external alias replacement written at the unlink barrier", async () => {
    const workspace = await makeFixture();
    const layout = getMossSourceLayout(workspace);
    const sourceRel = `${MOSS_RELATIVE_PATHS.memoryRoot}/symlink-barrier.md`;
    const targetRel = join(CODEX_TARGETS.memoryRoot, "symlink-barrier.md");
    const externalRel = `${MOSS_RELATIVE_PATHS.memoryRoot}/external.md`;
    await writeFile(join(layout.memoryRoot, "symlink-barrier.md"), "owned\n", "utf8");
    await writeFile(join(layout.memoryRoot, "external.md"), "external\n", "utf8");
    await materializeMossProjection({
      projectPath: workspace,
      projection: {
        engineId: "codex",
        status: "ready",
        mappings: [
          {
            resourceId: "moss:memory:symlink-barrier",
            action: process.platform === "win32" ? "copy" : "symlink",
            sourcePath: sourceRel,
            targetPath: targetRel,
          },
        ],
        warnings: [],
      },
    });

    const store = rejectingCasStore(async (targetAbs) => {
      await unlink(targetAbs);
      // This Windows directory alias is an unowned replacement being rejected,
      // never a stand-in for successful publication of the original file.
      await symlink(
        join(
          workspace,
          process.platform === "win32" ? `${MOSS_RELATIVE_PATHS.skillsRoot}/review` : externalRel,
        ),
        targetAbs,
        process.platform === "win32" ? "junction" : "file",
      );
    });
    const removal = await removeMossProjectionResource({
      projectPath: workspace,
      resourceId: "moss:memory:symlink-barrier",
      targetPaths: [targetRel],
      removeTargets: true,
      ownershipStore: store,
      ownershipOwnerId: "server-test-owner",
      ownershipGeneration: "generation-symlink-barrier",
    });

    expect(removal.removedTargets).toEqual([]);
    expect(removal.conflictedTargets).toEqual([targetRel]);
    expect(await readlink(join(workspace, targetRel))).toBe(
      join(
        workspace,
        process.platform === "win32" ? `${MOSS_RELATIVE_PATHS.skillsRoot}/review` : externalRel,
      ),
    );
    expect(await readFile(join(workspace, externalRel), "utf8")).toBe("external\n");
  });

  it("binds ownership requests to project root identity, owner, generation, and nonce", async () => {
    const firstWorkspace = await makeFixture("t3-moss-materialize-root-a-");
    const secondWorkspace = await makeFixture("t3-moss-materialize-root-b-");
    const requests: Array<{
      root: string;
      rootIdentity: string;
      owner: string;
      nonce: string;
      generation: string;
    }> = [];
    let currentWorkspace: string | undefined;
    const store: MossProjectionOwnershipStore = {
      withMutationLock: async (scope, operation) => {
        currentWorkspace = scope.projectRoot;
        return operation("test-fencing-token");
      },
      appendPrivateManifest: async () => {
        throw new Error("root identity fixture does not write private manifest");
      },
      readPrivateManifest: async () => {
        if (!currentWorkspace) return null;
        try {
          const value = JSON.parse(
            await readFile(getMossSourceLayout(currentWorkspace).projectionsManifest, "utf8"),
          ) as unknown;
          return {
            locator: "root-identity-fixture",
            transactionId: "test-projection-generation",
            operationId: "root-identity-operation",
            sequence: 1,
            previousHash: "0".repeat(64),
            recordHash: mossProjectionPrivateManifestRecordHash({
              operationId: "root-identity-operation",
              sequence: 1,
              previousHash: "0".repeat(64),
              value,
            }),
            value,
          };
        } catch {
          return null;
        }
      },
      create: async () => ({ status: "conflict", reason: "root identity fixture" }),
      publish: async () => ({ status: "unsupported", reason: "root identity fixture" }),
      replace: async (request) => {
        requests.push({
          root: request.projectRoot,
          rootIdentity: request.projectRootIdentity.realpath,
          owner: request.ownerId,
          nonce: request.nonce,
          generation: request.generation,
        });
        return { status: "conflict", reason: "root identity fixture" };
      },
      remove: async (request) => {
        requests.push({
          root: request.projectRoot,
          rootIdentity: request.projectRootIdentity.realpath,
          owner: request.ownerId,
          nonce: request.nonce,
          generation: request.generation,
        });
        return { status: "conflict", reason: "root identity fixture" };
      },
    };

    for (const [workspace, suffix] of [
      [firstWorkspace, "a"],
      [secondWorkspace, "b"],
    ] as const) {
      const layout = getMossSourceLayout(workspace);
      const sourceRel = `${MOSS_RELATIVE_PATHS.memoryRoot}/root-${suffix}.md`;
      const targetRel = join(CODEX_TARGETS.memoryRoot, `root-${suffix}.md`);
      await writeFile(join(layout.memoryRoot, `root-${suffix}.md`), "owned\n", "utf8");
      await materializeMossProjection({
        projectPath: workspace,
        projection: copyProjection(sourceRel, targetRel),
      });
      await removeMossProjectionResource({
        projectPath: workspace,
        resourceId: "moss:memory:copy-entry",
        targetPaths: [targetRel],
        removeTargets: true,
        ownershipStore: store,
        ownershipOwnerId: "server-test-owner",
        ownershipGeneration: "shared-generation",
      });
    }

    expect(requests).toHaveLength(2);
    expect(requests[0]?.root).not.toBe(requests[1]?.root);
    expect(requests[0]?.rootIdentity).toBe(requests[0]?.root);
    expect(requests[1]?.rootIdentity).toBe(requests[1]?.root);
    expect(requests[0]?.owner).toBe("server-test-owner");
    expect(requests[0]?.generation).toBe("shared-generation");
    expect(requests[1]?.generation).toBe("shared-generation");
    expect(requests[0]?.nonce).not.toBe(requests[1]?.nonce);
  });

  it("atomically copies directory sources without creating provider symlinks", async () => {
    const workspace = await makeFixture();
    const results = await materializeMossProjection({
      projectPath: workspace,
      projection: copyProjection(MOSS_RELATIVE_PATHS.memoryRoot, CODEX_TARGETS.memoryRoot),
    });
    expect(results[0]).toMatchObject({
      action: "copy",
      status: "created",
    });
    expect((await lstat(join(workspace, CODEX_TARGETS.memoryRoot))).isDirectory()).toBe(true);
  });

  it("reports a conflict when the copy source is missing", async () => {
    const workspace = await makeFixture();
    const results = await materializeMossProjection({
      projectPath: workspace,
      projection: copyProjection(
        `${MOSS_RELATIVE_PATHS.memoryRoot}/absent.md`,
        join(CODEX_TARGETS.memoryRoot, "absent.md"),
      ),
    });
    expect(results[0]).toMatchObject({ status: "conflict", reason: "Source path does not exist." });
  });
});

describe("removeMossProjectionResource", () => {
  it("keeps managed skill projections and manifest entries when CAS cleanup is unavailable (A6)", async () => {
    const workspace = await makeFixture();
    const layout = getMossSourceLayout(workspace);
    const skillName = "cleanup-skill";
    await mkdir(join(layout.skillsRoot, skillName), { recursive: true });
    await writeFile(
      join(layout.skillsRoot, skillName, "SKILL.md"),
      `---\nname: ${skillName}\n---\nRun cleanup.\n`,
      "utf8",
    );

    await materializeMossWorkspaceProjections({ projectPath: workspace });
    await expectLinkTo(
      workspace,
      join(CLAUDE_TARGETS.skillsRoot, skillName),
      `${MOSS_RELATIVE_PATHS.skillsRoot}/${skillName}`,
    );

    // Manual neighbors with no manifest entry.
    const manualFileRel = join(CLAUDE_TARGETS.skillsRoot, "manual-note.md");
    const manualDirRel = join(CLAUDE_TARGETS.skillsRoot, "manual-dir");
    await writeFile(join(workspace, manualFileRel), "handwritten\n", "utf8");
    await mkdir(join(workspace, manualDirRel), { recursive: true });
    await writeFile(join(workspace, manualDirRel, "keep.txt"), "keep\n", "utf8");

    await rm(join(layout.skillsRoot, skillName), { recursive: true, force: true });
    const cleanup = await removeMossProjectionResource({
      projectPath: workspace,
      resourceId: `moss:skill:${skillName}`,
      sourcePath: `${MOSS_RELATIVE_PATHS.skillsRoot}/${skillName}`,
      targetPaths: [
        join(CLAUDE_TARGETS.skillsRoot, skillName),
        join(CODEX_TARGETS.skillsRoot, skillName),
        // Manual paths passed explicitly: must survive the guard.
        manualFileRel,
        manualDirRel,
      ],
      removeTargets: true,
    });

    expect(cleanup.removedTargets).toEqual([]);
    expect(cleanup.conflictedTargets).toEqual(
      expect.arrayContaining([
        join(CLAUDE_TARGETS.skillsRoot, skillName),
        join(CODEX_TARGETS.skillsRoot, skillName),
      ]),
    );
    await expect(
      lstat(join(workspace, CLAUDE_TARGETS.skillsRoot, skillName)),
    ).resolves.toBeDefined();
    await expect(
      lstat(join(workspace, CODEX_TARGETS.skillsRoot, skillName)),
    ).resolves.toBeDefined();

    // Counter-proof: unmanaged manual file/dir survive byte-identically.
    expect(cleanup.removedTargets).not.toContain(manualFileRel);
    expect(cleanup.removedTargets).not.toContain(manualDirRel);
    expect(await readFile(join(workspace, manualFileRel), "utf8")).toBe("handwritten\n");
    expect(await readFile(join(workspace, manualDirRel, "keep.txt"), "utf8")).toBe("keep\n");

    const manifest = await readManifestRaw(workspace);
    expect(
      Object.values(manifest.entries).some(
        (entry) => entry.resourceId === `moss:skill:${skillName}`,
      ),
    ).toBe(true);
  });

  it("keeps managed subagent file projections when CAS cleanup is unavailable", async () => {
    const workspace = await makeFixture();
    const layout = getMossSourceLayout(workspace);
    const agentName = "cleanup-agent";
    await mkdir(layout.subagentsRoot, { recursive: true });
    await writeFile(
      join(layout.subagentsRoot, `${agentName}.md`),
      `---\nname: ${agentName}\n---\nRun cleanup.\n`,
      "utf8",
    );

    const materialized = await materializeMossWorkspaceProjections({ projectPath: workspace });
    const sourcePath = `${MOSS_RELATIVE_PATHS.subagentsRoot}/${agentName}.md`;
    for (const engineId of ["codex", "claudeAgent"] as const) {
      const targetPath = join(
        MOSS_ENGINE_NATIVE_TARGETS[engineId].subagentsRoot,
        `${agentName}.md`,
      );
      if (process.platform === "win32") {
        expect(
          materialized.projections.find((entry) => entry.engineId === engineId)?.results,
        ).toContainEqual(
          expect.objectContaining({ targetPath, status: "unsupported", action: "symlink" }),
        );
        const projection = copyProjection(sourcePath, targetPath, `moss:subagent:${agentName}`);
        const results = await materializeMossProjection({
          projectPath: workspace,
          projection: { ...projection, engineId },
        });
        expect(results[0]).toMatchObject({ status: "created", action: "copy" });
        expect((await lstat(join(workspace, targetPath))).isFile()).toBe(true);
        expect(await readFile(join(workspace, targetPath), "utf8")).toBe(
          await readFile(join(workspace, sourcePath), "utf8"),
        );
      } else {
        await expectLinkTo(workspace, targetPath, sourcePath);
      }
    }

    await unlink(join(layout.subagentsRoot, `${agentName}.md`));
    const cleanup = await removeMossProjectionResource({
      projectPath: workspace,
      resourceId: `moss:subagent:${agentName}`,
      sourcePath: `${MOSS_RELATIVE_PATHS.subagentsRoot}/${agentName}.md`,
      targetPaths: [
        join(CLAUDE_TARGETS.subagentsRoot, `${agentName}.md`),
        join(CODEX_TARGETS.subagentsRoot, `${agentName}.md`),
      ],
      removeTargets: true,
    });

    expect(cleanup.removedEntries).toEqual([]);
    expect(cleanup.removedTargets).toEqual([]);
    expect(cleanup.conflictedTargets).toEqual(
      expect.arrayContaining([
        join(CLAUDE_TARGETS.subagentsRoot, `${agentName}.md`),
        join(CODEX_TARGETS.subagentsRoot, `${agentName}.md`),
      ]),
    );
    await expect(
      lstat(join(workspace, CODEX_TARGETS.subagentsRoot, `${agentName}.md`)),
    ).resolves.toBeDefined();
    const manifest = await readManifestRaw(workspace);
    expect(
      Object.values(manifest.entries).some(
        (entry) => entry.resourceId === `moss:subagent:${agentName}`,
      ),
    ).toBe(true);
  });

  it("keeps hook adapter manifests when stale cleanup is denied without CAS", async () => {
    const workspace = await makeFixture();
    const layout = getMossSourceLayout(workspace);
    const claudeAdapterRel = join(CLAUDE_TARGETS.hooksRoot, ".moss-adapter.json");
    const codexAdapterRel = join(CODEX_TARGETS.hooksRoot, ".moss-adapter.json");
    await writeFile(
      join(layout.hooksRoot, "kept-hook.md"),
      "---\nname: kept-hook\nevent: Stop\ncommand: node kept.mjs\n---\nKeep me.\n",
      "utf8",
    );

    await materializeMossWorkspaceProjections({ projectPath: workspace });
    const readAdapter = async (adapterRel: string) =>
      JSON.parse(await readFile(join(workspace, adapterRel), "utf8"));
    expect((await readAdapter(claudeAdapterRel)).resources).toContainEqual(
      expect.objectContaining({ resourceId: "moss:hook:on-stop" }),
    );

    await unlink(join(layout.hooksRoot, "on-stop.md"));
    const cleanup = await removeMossProjectionResource({
      projectPath: workspace,
      resourceId: "moss:hook:on-stop",
      sourcePath: `${MOSS_RELATIVE_PATHS.hooksRoot}/on-stop.md`,
      targetPaths: [claudeAdapterRel, codexAdapterRel],
      removeTargets: true,
    });
    expect(cleanup.removedTargets).toEqual([]);
    expect(cleanup.conflictedTargets).toEqual(
      expect.arrayContaining([claudeAdapterRel, codexAdapterRel]),
    );
    await expect(lstat(join(workspace, claudeAdapterRel))).resolves.toBeDefined();

    await materializeMossWorkspaceProjections({ projectPath: workspace });
    for (const adapterRel of [claudeAdapterRel, codexAdapterRel]) {
      const adapter = await readAdapter(adapterRel);
      expect(adapter.resources).toContainEqual(
        expect.objectContaining({ resourceId: "moss:hook:on-stop" }),
      );
    }
  });

  it("reclaims a single contributor from a shared bridge entry without dropping co-contributors", async () => {
    const workspace = await makeFixture();
    await materializeMossWorkspaceProjections({ projectPath: workspace });

    const before = await readManifestRaw(workspace);
    expect(before.entries[join(CODEX_TARGETS.mcpBridge)]?.contributors).toHaveLength(2);

    const result = await removeMossProjectionResource({
      projectPath: workspace,
      resourceId: "moss:mcp:browser",
      targetPaths: [CODEX_TARGETS.mcpBridge],
      removeTargets: false,
      ownershipStore: testProjectionStoreFor(workspace),
      ownershipOwnerId: "test-projection-owner",
      ownershipGeneration: "test-projection-generation",
    });
    expect(result.removedEntries).toContain(join(CODEX_TARGETS.mcpBridge));
    expect(result.removedTargets).toEqual([]);

    const after = await readManifestRaw(workspace);
    const entry = after.entries[join(CODEX_TARGETS.mcpBridge)];
    expect(entry).toBeTruthy();
    expect(entry?.contributors).toEqual([
      expect.objectContaining({ resourceId: "moss:provider:providers.yaml" }),
    ]);
    expect(entry?.resourceId).toBe("moss:provider:providers.yaml");
    // The shared file itself is left in place for re-materialize.
    expect(
      (await readFile(join(workspace, CODEX_TARGETS.mcpBridge), "utf8")).length,
    ).toBeGreaterThan(0);

    // Re-materialize restores the mcp contributor (source still exists).
    await materializeMossWorkspaceProjections({ projectPath: workspace });
    const restored = await readManifestRaw(workspace);
    expect(restored.entries[join(CODEX_TARGETS.mcpBridge)]?.contributors).toHaveLength(2);
  });

  it("returns empty results when there is no manifest and never deletes unmanaged targets", async () => {
    const workspace = await makeFixture();
    const manualRel = join(CLAUDE_TARGETS.skillsRoot, "manual-note.md");
    await mkdir(join(workspace, CLAUDE_TARGETS.skillsRoot), { recursive: true });
    await writeFile(join(workspace, manualRel), "handwritten\n", "utf8");

    const result = await removeMossProjectionResource({
      projectPath: workspace,
      resourceId: "moss:skill:anything",
      targetPaths: [manualRel],
      removeTargets: true,
    });
    expect(result).toEqual({ removedEntries: [], removedTargets: [] });
    expect(await readFile(join(workspace, manualRel), "utf8")).toBe("handwritten\n");
  });
});

describe("workspace orchestration and manifest summary", () => {
  it("bootstraps then materializes a plain workspace across both lead engines", async () => {
    const workspace = await makeTempWorkspace("t3-moss-bootstrap-mat-");
    await ensureMossSource({ projectPath: workspace });

    const materialized = await materializeMossWorkspaceProjections({ projectPath: workspace });
    expect(materialized.projections.map((projection) => projection.engineId)).toEqual([
      "codex",
      "claudeAgent",
    ]);
    for (const projection of materialized.projections) {
      expect(projection.projectionStatus).toBe("ready");
      expect(projection.summary.conflict).toBe(0);
      expect(projection.summary.created).toBeGreaterThan(0);
      expect(projection.failed).toBeUndefined();
    }

    for (const projection of materialized.projections) {
      const targetPath =
        projection.engineId === "codex"
          ? CODEX_TARGETS.instructionFile
          : CLAUDE_TARGETS.instructionFile;
      await expectInstructionProjection(workspace, targetPath, projection.results);
    }
    const codexToml = await readFile(join(workspace, CODEX_TARGETS.mcpBridge), "utf8");
    expect(codexToml.startsWith("# Generated by Moss")).toBe(true);
  });

  it("reports non-materialized engines with a warning and zero writes", async () => {
    // cursor is governance-covered (SY8) but not materialized on disk: its MCP
    // surface is injected at runtime via the ACP session/new handshake. The
    // materializer must skip it — even when explicitly requested — and write
    // nothing, not even the manifest.
    const workspace = await makeFixture();
    const before = await snapshotTree(workspace);
    const materialized = await materializeMossWorkspaceProjections({
      projectPath: workspace,
      engines: ["cursor"],
    });

    expect(materialized.projections[0]).toMatchObject({
      engineId: "cursor",
      projectionStatus: "unsupported",
    });
    expect(materialized.projections[0]?.summary.total).toBe(0);
    expect(materialized.projections[0]?.warnings[0]).toContain("SY8");
    // Not materialized on disk — write nothing, not even the manifest.
    expect(await snapshotTree(workspace)).toEqual(before);
  });

  it("skips workspaces without a .moss source", async () => {
    const workspace = await makeTempWorkspace("t3-moss-plain-");
    const materialized = await materializeMossWorkspaceProjections({ projectPath: workspace });
    for (const projection of materialized.projections) {
      expect(projection.projectionStatus).toBe("skipped");
      expect(projection.reason).toContain("No .moss Unified Source");
    }
    const layout = getMossSourceLayout(workspace);
    await expect(lstat(layout.root)).rejects.toThrow();
  });

  it("summarizes the manifest without rematerializing and flags corrupt manifests", async () => {
    const workspace = await makeFixture();
    const missing = await readMossProjectionManifestSummary(workspace);
    expect(missing.status).toBe("missing");
    expect(missing.totalEntries).toBe(0);

    await materializeMossWorkspaceProjections({ projectPath: workspace });
    const summary = await readMossProjectionManifestSummary(workspace);
    expect(summary.status).toBe("found");
    expect(summary.totalEntries).toBeGreaterThan(0);
    expect(summary.sourcePath).toBe(getMossSourceLayout(workspace).projectionsManifest);
    expect(summary.engines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ engineId: "codex" }),
        expect.objectContaining({ engineId: "claudeAgent" }),
      ]),
    );

    await writeFile(getMossSourceLayout(workspace).projectionsManifest, "{ not json", "utf8");
    const corrupt = await readMossProjectionManifestSummary(workspace);
    expect(corrupt.status).toBe("parse-error");
    expect(typeof corrupt.error).toBe("string");

    // Lenient manifest read: remove on a corrupt manifest degrades to no-op.
    const removal = await removeMossProjectionResource({
      projectPath: workspace,
      resourceId: "moss:hook:on-stop",
      targetPaths: [join(CLAUDE_TARGETS.hooksRoot, ".moss-adapter.json")],
      removeTargets: false,
    });
    expect(removal.removedEntries).toEqual([]);
  });

  it("summarize helper counts statuses", () => {
    expect(
      summarizeMossProjectionResults([
        { engineId: "codex", resourceId: "a", action: "symlink", status: "created" },
        { engineId: "codex", resourceId: "b", action: "symlink", status: "skipped" },
        { engineId: "codex", resourceId: "c", action: "managed-bridge", status: "conflict" },
      ]),
    ).toEqual({ created: 1, updated: 0, skipped: 1, conflict: 1, unsupported: 0, total: 3 });
  });
});
