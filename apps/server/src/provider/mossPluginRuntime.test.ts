import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getMossSourceLayout } from "@synara/shared/mossSourceLayout";
import type { MossPluginIR } from "@synara/shared/mossResourceRegistry";
import {
  mossProjectionIdentityFingerprint,
  type MossProjectionFrozenTarget,
  type MossProjectionOwnershipMutationRequest,
  type MossProjectionOwnershipMutationResult,
  type MossProjectionOwnershipStore,
} from "@synara/shared/mossProjectionMaterializer";

import {
  buildMossPluginPromptInjection,
  buildMossPluginRuntimePlan,
  createMossPluginApprovalStore,
  createMossPluginPinnedMcpFetchForTest,
  createMossPluginSecureMcpFetch,
  deriveMossPluginMcpServers,
  deriveMossPluginProviderMcpServers,
  discoverMossPluginPiTools,
  discoverMossPluginRuntime,
  callMossPluginPiTool,
  closeMossPluginPiTools,
  executeMossPluginComponent,
  materializeMossPluginProviderComponents,
  mossPluginRuntimeContentHash,
  redactMossPluginMcpUrl,
  toMossPluginClaudeMcpServers,
  toMossPluginCodexMcpOverrides,
  toMossPluginOpenCodeMcpServers,
  type MossPluginMcpFetch,
  type MossPluginMcpServerDefinition,
} from "./mossPluginRuntime";
import { createMossPluginProductionApprovalService } from "./mossPluginApprovalService";

const tempDirs: string[] = [];
const repositoryRoot = resolve(import.meta.dirname, "../../../..");

afterEach(async () => {
  for (const directory of tempDirs.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function formalPluginWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "moss-plugin-runtime-"));
  tempDirs.push(workspace);
  const root = join(getMossSourceLayout(workspace).pluginsRoot, "runtime-kit");
  await mkdir(join(root, ".codex-plugin"), { recursive: true });
  await mkdir(join(root, "skills", "runtime"), { recursive: true });
  await writeFile(
    join(root, "skills", "runtime", "SKILL.md"),
    "---\nname: runtime\ndescription: Runtime skill.\n---\n# Runtime skill\n",
    "utf8",
  );
  await writeFile(
    join(root, ".app.json"),
    JSON.stringify({ apps: { docs: { id: "docs", category: "Productivity" } } }),
    "utf8",
  );
  await writeFile(
    join(root, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        docs: { command: "node", args: ["docs-server.mjs"], env: { MODE: "test" } },
        remote: { type: "http", url: "https://mcp.example.test/server" },
      },
    }),
    "utf8",
  );
  await writeFile(
    join(root, ".codex-plugin", "plugin.json"),
    JSON.stringify({
      name: "runtime-kit",
      version: "1.0.0",
      description: "Runtime fixture.",
      author: { name: "Moss" },
      interface: {
        displayName: "Runtime Kit",
        shortDescription: "Runtime",
        longDescription: "Runtime fixture.",
        developerName: "Moss",
        category: "Productivity",
        capabilities: ["Runtime"],
        defaultPrompt: ["Run runtime"],
      },
      skills: "./skills/",
      apps: "./.app.json",
      mcpServers: "./.mcp.json",
    }),
  );
  return workspace;
}

async function approvePlugin(
  workspace: string,
  plugin: MossPluginIR,
  kinds?: ReadonlyArray<string>,
) {
  const { store, issuer } = createMossPluginApprovalStore();
  await issuer.approve({
    cwd: workspace,
    plugin,
    componentIds: plugin.components
      .filter((component) => !kinds || kinds.includes(component.kind))
      .map((component) => component.id),
  });
  return store;
}

/**
 * Test-only server-owned authority double. It deliberately keeps the private
 * journal in memory and exposes no workspace trust or manifest authority.
 */
function createTestProjectionOwnershipStore(): MossProjectionOwnershipStore {
  let privateRecord:
    | {
        readonly locator: string;
        readonly transactionId: string;
        readonly operationId: string;
        readonly sequence: number;
        readonly previousHash: string;
        readonly recordHash: string;
        readonly value: unknown;
      }
    | undefined;
  let lockTail = Promise.resolve();

  const recordFor = (input: MossProjectionOwnershipMutationRequest) => ({
    locator: "test-plugin-projection-journal",
    transactionId: input.privateManifest.transactionId,
    operationId: input.privateManifest.operationId,
    sequence: input.privateManifest.sequence,
    previousHash: input.privateManifest.previousHash,
    recordHash: input.privateManifest.recordHash,
    value: input.privateManifest.value,
  });

  const identityFor = async (targetAbs: string) => {
    const targetStat = await lstat(targetAbs);
    return {
      dev: String(targetStat.dev),
      ino: String(targetStat.ino),
      mode: targetStat.mode,
      ctimeMs: targetStat.ctimeMs,
    };
  };

  const applied = async (
    input: MossProjectionOwnershipMutationRequest,
    target: MossProjectionFrozenTarget,
  ): Promise<MossProjectionOwnershipMutationResult> => {
    const identity = await identityFor(input.targetAbs);
    privateRecord = recordFor(input);
    return {
      status: "applied",
      receipt: {
        operationId: input.operationId,
        canonicalRoot: input.canonicalRoot,
        expectedFingerprint: input.expectedFingerprint,
        observedFingerprint: mossProjectionIdentityFingerprint(identity),
        expectedBeforeHash: input.expectedBeforeHash,
        after: {
          state: "present",
          identity,
          fingerprint: mossProjectionIdentityFingerprint(identity),
          contentHash: input.contentHash ?? "",
        },
        fencingToken: input.fencingToken,
        generation: input.generation,
        nonce: input.nonce,
        manifest: {
          locator: privateRecord.locator,
          transactionId: privateRecord.transactionId,
          operationId: privateRecord.operationId,
          sequence: privateRecord.sequence,
          previousHash: privateRecord.previousHash,
          recordHash: privateRecord.recordHash,
        },
        durable: true,
      },
    };
  };

  const writeFrozenTarget = async (targetAbs: string, target: MossProjectionFrozenTarget) => {
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
  };

  const publish = async (
    input: MossProjectionOwnershipMutationRequest,
    target: MossProjectionFrozenTarget,
  ): Promise<MossProjectionOwnershipMutationResult> => {
    try {
      await lstat(input.targetAbs);
      return { status: "conflict", reason: "test authority target already exists" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeFrozenTarget(input.targetAbs, target);
    return applied(input, target);
  };

  return {
    withMutationLock: async (_scope, operation) => {
      const previous = lockTail;
      let release!: () => void;
      lockTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await operation("test-plugin-fencing-token");
      } finally {
        release();
      }
    },
    appendPrivateManifest: async (input) => {
      privateRecord = {
        locator: "test-plugin-projection-journal",
        transactionId: input.transactionId,
        operationId: input.operationId,
        sequence: input.sequence,
        previousHash: input.previousHash,
        recordHash: input.recordHash,
        value: input.value,
      };
      return privateRecord;
    },
    readPrivateManifest: async () => privateRecord ?? null,
    create: publish,
    publish,
    replace: async (input, target) => {
      try {
        await lstat(input.targetAbs);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { status: "missing", reason: "test authority target is absent" };
        }
        throw error;
      }
      await rm(input.targetAbs, { recursive: true, force: true });
      await writeFrozenTarget(input.targetAbs, target);
      return applied(input, target);
    },
    remove: async (input) => {
      try {
        await lstat(input.targetAbs);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { status: "missing", reason: "test authority target is absent" };
        }
        throw error;
      }
      await rm(input.targetAbs, { recursive: true, force: true });
      privateRecord = recordFor(input);
      return {
        status: "applied",
        receipt: {
          operationId: input.operationId,
          canonicalRoot: input.canonicalRoot,
          expectedFingerprint: input.expectedFingerprint,
          observedFingerprint: "absent",
          expectedBeforeHash: input.expectedBeforeHash,
          after: { state: "absent", fingerprint: "absent", contentHash: "absent" },
          fencingToken: input.fencingToken,
          generation: input.generation,
          nonce: input.nonce,
          manifest: {
            locator: privateRecord.locator,
            transactionId: privateRecord.transactionId,
            operationId: privateRecord.operationId,
            sequence: privateRecord.sequence,
            previousHash: privateRecord.previousHash,
            recordHash: privateRecord.recordHash,
          },
          durable: true,
        },
      };
    },
  };
}

describe("mossPluginRuntime", () => {
  it("loads the shared plugin IR and builds an explicit provider plan", async () => {
    const workspace = await formalPluginWorkspace();
    const runtime = await discoverMossPluginRuntime({ cwd: workspace });
    expect(runtime.errors).toEqual([]);
    expect(runtime.plugins).toHaveLength(1);

    const plugin = runtime.plugins[0]!;
    const codex = buildMossPluginRuntimePlan({ plugin, provider: "codex" });
    const cursor = buildMossPluginRuntimePlan({ plugin, provider: "cursor" });

    expect(codex.validation.ok).toBe(true);
    expect(codex.components.find((component) => component.kind === "skill")).toMatchObject({
      projection: "native",
      execution: "native",
      status: "ready",
      plannedSupportStatus: "projected",
      supportStatus: "unsupported",
    });
    expect(codex.components.find((component) => component.kind === "mcp")).toMatchObject({
      plannedSupportStatus: "injected",
      supportStatus: "unsupported",
    });
    expect(codex.components.find((component) => component.kind === "app")).toMatchObject({
      projection: "display-only",
      execution: "none",
      status: "display-only",
      supportStatus: "unsupported",
    });
    expect(cursor.components.find((component) => component.kind === "skill")).toMatchObject({
      plannedSupportStatus: "injected",
      supportStatus: "unsupported",
    });
    expect(cursor.components.find((component) => component.kind === "mcp")).toMatchObject({
      plannedSupportStatus: "injected",
      supportStatus: "unsupported",
    });
    expect(cursor.components.find((component) => component.kind === "app")).toMatchObject({
      supportStatus: "unsupported",
    });
    expect(cursor.executionReady).toBe(false);

    const antigravity = buildMossPluginRuntimePlan({ plugin, provider: "antigravity" });
    expect(antigravity.components.find((component) => component.kind === "mcp")).toMatchObject({
      plannedSupportStatus: "unsupported",
      supportStatus: "unsupported",
      status: "display-only",
    });
  });

  it("isolates a malformed canonical plugin source while retaining valid sources", async () => {
    const workspace = await formalPluginWorkspace();
    const badRoot = join(getMossSourceLayout(workspace).pluginsRoot, "broken-kit");
    await mkdir(badRoot, { recursive: true });
    await writeFile(join(badRoot, "plugin.json"), "{ not valid json", "utf8");

    const runtime = await discoverMossPluginRuntime({ cwd: workspace });

    expect(runtime.plugins.some((plugin) => plugin.name === "runtime-kit")).toBe(true);
    expect(runtime.plugins.some((plugin) => plugin.name === "broken-kit")).toBe(true);
    expect(runtime.errors).toContainEqual(expect.stringContaining("broken-kit"));
  });

  it("materializes lead-provider plugin skills with a target read-back", async () => {
    const workspace = await formalPluginWorkspace();
    const runtime = await discoverMossPluginRuntime({ cwd: workspace });
    const plugin = runtime.plugins[0]!;
    const projectionOwnershipStore = createTestProjectionOwnershipStore();

    const materialized = await materializeMossPluginProviderComponents({
      cwd: workspace,
      provider: "codex",
      plugin,
      approvalStore: await approvePlugin(workspace, plugin, ["skill"]),
      projectionOwnershipStore,
      projectionOwnershipOwnerId: "test-plugin-owner",
      projectionOwnershipGeneration: "test-plugin-generation",
    });

    expect(materialized.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "skill",
          supportStatus: "projected",
          readBack: true,
        }),
      ]),
    );
    expect(materialized.warnings).toEqual([]);
  });

  it("reconciles revoked projections without deleting user files", async () => {
    const workspace = await formalPluginWorkspace();
    const plugin = (await discoverMossPluginRuntime({ cwd: workspace })).plugins[0]!;
    const skill = plugin.components.find((component) => component.kind === "skill")!;
    const approval = createMossPluginApprovalStore();
    const projectionOwnershipStore = createTestProjectionOwnershipStore();
    await approval.issuer.approve({ cwd: workspace, plugin, componentIds: [skill.id] });

    const firstMaterialized = await materializeMossPluginProviderComponents({
      cwd: workspace,
      provider: "codex",
      plugin,
      approvalStore: approval.store,
      projectionOwnershipStore,
      projectionOwnershipOwnerId: "test-plugin-owner",
      projectionOwnershipGeneration: "test-plugin-generation",
    });
    const managedTarget = join(
      workspace,
      firstMaterialized.components.find((component) => component.kind === "skill")?.results[0]
        ?.targetPath ?? "",
    );
    await access(managedTarget);
    const userTarget = join(workspace, ".codex", "skills", "user-owned.md");
    await writeFile(userTarget, "keep me", "utf8");

    approval.issuer.revoke({ cwd: workspace, pluginId: plugin.id });
    await materializeMossPluginProviderComponents({
      cwd: workspace,
      provider: "codex",
      plugin,
      approvalStore: approval.store,
      projectionOwnershipStore,
      projectionOwnershipOwnerId: "test-plugin-owner",
      projectionOwnershipGeneration: "test-plugin-generation",
    });
    await expect(access(managedTarget)).rejects.toThrow();
    await access(userTarget);
  });

  it("derives plugin MCP declarations into provider session shapes", async () => {
    const workspace = await formalPluginWorkspace();
    const runtime = await discoverMossPluginRuntime({ cwd: workspace });
    const plugin = runtime.plugins[0]!;

    const acp = await deriveMossPluginMcpServers({
      cwd: workspace,
      provider: "cursor",
      plugin,
      approvalStore: await approvePlugin(workspace, plugin, ["mcp"]),
    });
    expect(acp.servers).toEqual([
      expect.objectContaining({ name: "docs", command: "node", args: ["docs-server.mjs"] }),
      expect.objectContaining({
        name: "remote",
        type: "http",
        url: "https://mcp.example.test/server",
      }),
    ]);
    expect(acp.serverNames).toEqual(["docs", "remote"]);
    expect(acp.warnings).toEqual([]);
  });

  it("does not inject a skill into an ordinary turn without explicit selection and approval", async () => {
    const workspace = await formalPluginWorkspace();

    const result = await buildMossPluginPromptInjection({ cwd: workspace, provider: "cursor" });

    expect(result.injected).toBe(false);
    expect(result.componentIds).toEqual([]);
    expect(result.reason).toMatch(/explicit|approved|disabled/i);
  });

  it("fails closed for disabled nested MCP declarations", async () => {
    const workspace = await formalPluginWorkspace();
    const runtime = await discoverMossPluginRuntime({ cwd: workspace });
    const plugin = runtime.plugins[0]!;
    const disabledPlugin = {
      ...plugin,
      components: plugin.components.map((component) =>
        component.kind === "mcp"
          ? {
              ...component,
              enabled: false,
              metadata: {
                ...component.metadata,
                definition: {
                  ...(component.metadata.definition as Record<string, unknown>),
                  enabled: false,
                },
              },
            }
          : component,
      ),
    };

    const result = await deriveMossPluginProviderMcpServers({
      cwd: workspace,
      provider: "claudeAgent",
      plugin: disabledPlugin,
    });

    expect(result.definitions).toEqual([]);
    expect(result.warnings).toContainEqual(expect.stringContaining("disabled"));
  });

  it("does not execute MCP declarations when marketplace policy needs installation/auth approval", async () => {
    const workspace = await formalPluginWorkspace();
    const runtime = await discoverMossPluginRuntime({ cwd: workspace });
    const plugin = {
      ...runtime.plugins[0]!,
      marketplacePolicy: {
        installation: "NOT_AVAILABLE" as const,
        authentication: "ON_USE" as const,
        category: "Productivity",
      },
    };

    const result = await deriveMossPluginProviderMcpServers({
      cwd: workspace,
      provider: "claudeAgent",
      plugin,
    });

    expect(result.definitions).toEqual([]);
    expect(result.warnings).toContainEqual(expect.stringMatching(/approval|policy|trust/i));
  });

  it("does not treat a workspace trust file as runtime authority", async () => {
    const workspace = await formalPluginWorkspace();
    const plugin = (await discoverMossPluginRuntime({ cwd: workspace })).plugins[0]!;
    await writeFile(
      join(getMossSourceLayout(workspace).pluginsRoot, ".trust.json"),
      JSON.stringify({
        plugins: {
          [plugin.id]: {
            authority: "moss-server",
            provenance: "server-owned-import",
            pluginId: plugin.id,
            contentHash: mossPluginRuntimeContentHash(plugin),
            componentIds: plugin.components
              .filter((component) => component.kind === "mcp")
              .map((component) => component.id),
          },
        },
      }),
      "utf8",
    );

    const forged = await deriveMossPluginProviderMcpServers({
      cwd: workspace,
      provider: "claudeAgent",
      plugin,
    });
    expect(forged.definitions).toEqual([]);
    expect(forged.warnings).toContainEqual(
      expect.stringMatching(/approval|provenance|unsupported/i),
    );

    await writeFile(
      join(plugin.absolutePluginRoot, ".mcp.json"),
      JSON.stringify({ mcpServers: {} }),
      "utf8",
    );
    const changedPlugin = (await discoverMossPluginRuntime({ cwd: workspace })).plugins[0]!;
    const stale = await deriveMossPluginProviderMcpServers({
      cwd: workspace,
      provider: "claudeAgent",
      plugin: changedPlugin,
    });
    expect(stale.definitions).toEqual([]);
    expect(stale.warnings).toContainEqual(
      expect.stringMatching(/approval|provenance|unsupported/i),
    );
  });

  it("rejects an unregistered caller-supplied approval store", async () => {
    const workspace = await formalPluginWorkspace();
    const plugin = (await discoverMossPluginRuntime({ cwd: workspace })).plugins[0]!;
    const forgedStore = {
      get: async () => ({
        authority: "moss-server" as const,
        provenance: "server-owned-import" as const,
        pluginId: plugin.id,
        contentHash: mossPluginRuntimeContentHash(plugin),
        componentIds: plugin.components.map((component) => component.id),
        tokenId: "forged",
        expiresAt: Date.now() + 60_000,
      }),
    };

    const result = await deriveMossPluginProviderMcpServers({
      cwd: workspace,
      provider: "claudeAgent",
      plugin,
      approvalStore: forgedStore,
    });
    expect(result.definitions).toEqual([]);
    expect(result.warnings).toContainEqual(
      expect.stringMatching(/approval|provenance|unsupported/i),
    );
  });

  it("keeps an approved snapshot stable when the live source changes until revoke", async () => {
    const workspace = await formalPluginWorkspace();
    const plugin = (await discoverMossPluginRuntime({ cwd: workspace })).plugins[0]!;
    const skill = plugin.components.find((component) => component.kind === "skill")!;
    const approval = createMossPluginApprovalStore();
    await approval.issuer.approve({ cwd: workspace, plugin, componentIds: [skill.id] });

    const before = await buildMossPluginPromptInjection({
      cwd: workspace,
      provider: "cursor",
      plugin,
      selectedComponentIds: [skill.id],
      approvalStore: approval.store,
    });
    expect(before.injected).toBe(true);

    await writeFile(
      join(plugin.absolutePluginRoot, "skills", "runtime", "SKILL.md"),
      "tampered",
      "utf8",
    );
    const after = await buildMossPluginPromptInjection({
      cwd: workspace,
      provider: "cursor",
      plugin,
      selectedComponentIds: [skill.id],
      approvalStore: approval.store,
    });
    expect(after.injected).toBe(true);
    expect(after.text).toContain("# Runtime skill");

    approval.issuer.revoke({ cwd: workspace, pluginId: plugin.id });
    const revoked = await buildMossPluginPromptInjection({
      cwd: workspace,
      provider: "cursor",
      plugin,
      selectedComponentIds: [skill.id],
      approvalStore: approval.store,
    });
    expect(revoked.injected).toBe(false);
    expect(revoked.warnings).toContainEqual(
      expect.stringMatching(/approval|provenance|unsupported/i),
    );
  });

  it("uses one immutable approval snapshot for nested MCP, Skill, and executor inputs", async () => {
    const workspace = await formalPluginWorkspace();
    const plugin = (await discoverMossPluginRuntime({ cwd: workspace })).plugins[0]!;
    const skill = plugin.components.find((component) => component.kind === "skill")!;
    const mcp = plugin.components.find((component) => component.kind === "mcp")!;
    const approval = createMossPluginApprovalStore();
    await approval.issuer.approve({
      cwd: workspace,
      plugin,
      componentIds: [skill.id, mcp.id],
    });

    const livePlugin = plugin as unknown as {
      components: Array<{
        sourcePath?: string;
        metadata: Record<string, unknown>;
      }>;
      manifest: Record<string, unknown>;
      enabled: boolean;
    };
    const liveSkill = livePlugin.components.find((component) => component === skill)!;
    const liveMcp = livePlugin.components.find((component) => component === mcp)!;
    const liveDefinition = liveMcp.metadata.definition as Record<string, unknown>;
    liveDefinition.command = "evil-mcp-command";
    liveDefinition.args = ["--evil-metadata"];
    liveMcp.metadata.path = "../outside-plugin";
    liveSkill.sourcePath = "../outside-plugin/SKILL.md";
    liveSkill.metadata.steps = ["evil-step"];
    livePlugin.manifest.mcpServers = { evil: { command: "evil-manifest-command" } };
    livePlugin.enabled = false;
    livePlugin.components.reverse();
    livePlugin.components.push({
      sourcePath: "../unapproved",
      metadata: { definition: { command: "unapproved" } },
    });

    const derived = await deriveMossPluginProviderMcpServers({
      cwd: workspace,
      provider: "claudeAgent",
      plugin,
      approvalStore: approval.store,
    });
    expect(derived.definitions).toHaveLength(1);
    expect(derived.definitions[0]?.config).toMatchObject({
      command: "node",
      args: ["docs-server.mjs"],
    });

    const prompt = await buildMossPluginPromptInjection({
      cwd: workspace,
      provider: "cursor",
      plugin,
      selectedComponentIds: [skill.id],
      approvalStore: approval.store,
    });
    expect(prompt.injected).toBe(true);
    expect(prompt.text).toContain("# Runtime skill");

    const execution = await executeMossPluginComponent({
      cwd: workspace,
      provider: "codex",
      plugin,
      component: skill,
      approvalStore: approval.store,
      executors: {
        native: ({ component }) => ({
          sourcePath: component.sourcePath,
          metadata: component.metadata,
        }),
      },
    });
    expect(execution).toMatchObject({
      executed: true,
      result: {
        sourcePath: "./skills/runtime",
        metadata: expect.objectContaining({}),
      },
    });
    expect(
      (execution.result as { readonly metadata: Record<string, unknown> }).metadata.steps,
    ).toBeUndefined();
  });

  it("passes the production projection authority through approval revoke reconciliation", async () => {
    const workspace = await formalPluginWorkspace();
    const plugin = (await discoverMossPluginRuntime({ cwd: workspace })).plugins[0]!;
    const projectionOwnershipStore = createTestProjectionOwnershipStore();
    const service = createMossPluginProductionApprovalService();
    const projectionAuthority = {
      ownershipStore: projectionOwnershipStore,
      ownerId: "production-test-owner",
      generation: "production-test-generation",
      assertLive: () => undefined,
    };

    await service.authorize({ cwd: workspace, plugin, enabled: true, projectionAuthority });
    const materialized = await materializeMossPluginProviderComponents({
      cwd: workspace,
      provider: "codex",
      plugin,
      approvalStore: service.store,
      projectionOwnershipStore,
      projectionOwnershipOwnerId: "production-test-owner",
      projectionOwnershipGeneration: "production-test-generation",
    });
    const targetPath = materialized.components
      .flatMap((component) => component.results)
      .map((entry) => entry.targetPath)
      .find((targetPath): targetPath is string => targetPath !== undefined);
    expect(targetPath).toBeDefined();
    await access(join(workspace, targetPath!));

    await service.revoke({ cwd: workspace, pluginId: plugin.id, projectionAuthority });
    await expect(access(join(workspace, targetPath!))).rejects.toThrow();
    service.dispose();
  });

  it("keeps the server-imported loop ledger library free of a CLI entry point", async () => {
    const source = await readFile(
      join(repositoryRoot, "scripts", "lib", "moss-loop-ledger-snapshot.ts"),
      "utf8",
    );
    expect(source).not.toContain("process.argv");
    expect(source).not.toContain("pathToFileURL");
    expect(source).not.toContain("unknown moss loop ledger snapshot option");
  });

  it("manually revalidates every secure MCP redirect and DNS address", async () => {
    const calls: string[] = [];
    const secureFetch = createMossPluginSecureMcpFetch({
      fetch: createMossPluginPinnedMcpFetchForTest(async (input, init) => {
        calls.push(`${String(input)}:${String(init?.redirect)}`);
        return calls.length === 1
          ? new Response(null, {
              status: 307,
              headers: { location: "https://public.example/next" },
            })
          : new Response("ok", { status: 200 });
      }),
      resolveHost: async (hostname) => {
        expect(hostname).toMatch(/public\.example/);
        return ["93.184.216.34"];
      },
    });

    const response = await secureFetch("https://public.example/start");
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      "https://public.example/start:manual",
      "https://public.example/next:manual",
    ]);

    await expect(
      createMossPluginSecureMcpFetch({
        fetch: createMossPluginPinnedMcpFetchForTest(async () => new Response("must not run")),
        resolveHost: async () => ["127.0.0.1"],
      })("https://public.example/private"),
    ).rejects.toThrow(/public-address binding/);
  });

  it("rejects field-name-independent argv/header carriers and every URL query by default", () => {
    const attacks: MossPluginMcpServerDefinition[] = [
      {
        pluginId: "moss:plugin:argv-carrier",
        pluginName: "argv-carrier",
        componentId: "plugin:mcp:argv-carrier",
        serverName: "argv-carrier",
        config: {
          command: "mcp-server",
          args: [
            "--header",
            "Authorization: Bearer literal",
            "--access-token",
            "literal",
            "-H",
            "Cookie: session=literal",
          ],
        },
      },
      {
        pluginId: "moss:plugin:header-carrier",
        pluginName: "header-carrier",
        componentId: "plugin:mcp:header-carrier",
        serverName: "header-carrier",
        config: {
          url: "https://mcp.example.test/server",
          headers: { "X-Moss-Forwarded": "Bearer literal" },
        },
      },
      {
        pluginId: "moss:plugin:query-carrier",
        pluginName: "query-carrier",
        componentId: "plugin:mcp:query-carrier",
        serverName: "query-carrier",
        config: { url: "https://mcp.example.test/server?mode=read" },
      },
    ];

    const codex = toMossPluginCodexMcpOverrides(attacks);
    expect(codex.serverNames).toEqual([]);
    expect(codex.args.join(" ")).not.toContain("literal");
    expect(toMossPluginClaudeMcpServers(attacks)).toEqual({});
    expect(toMossPluginOpenCodeMcpServers(attacks)).toEqual([]);
  });

  it("rejects an ordinary fetch seam and never forwards custom headers across origins", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const ordinaryFetch: MossPluginMcpFetch = async (input, init) => {
      calls.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers)) });
      return calls.length === 1
        ? new Response(null, {
            status: 307,
            headers: { location: "https://other.example/next" },
          })
        : new Response("must not receive credentials", { status: 200 });
    };

    expect(() =>
      createMossPluginSecureMcpFetch({
        fetch: ordinaryFetch,
        resolveHost: async () => ["93.184.216.34"],
      }),
    ).toThrow(/pinned|internal/i);

    const secureFetch = createMossPluginSecureMcpFetch({
      fetch: createMossPluginPinnedMcpFetchForTest(ordinaryFetch),
      resolveHost: async () => ["93.184.216.34"],
    });
    await expect(secureFetch("https://public.example/start?token=literal")).rejects.toThrow(
      /query|URL/i,
    );
    await expect(
      secureFetch("https://public.example/start", {
        headers: {
          Authorization: "env:MOSS_SECRET_TOKEN",
          "Mcp-Session-Id": "session-secret",
        },
      }),
    ).rejects.toThrow(/origin|redirect|pinned/i);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.authorization).toBe("env:MOSS_SECRET_TOKEN");
    expect(calls[0]?.headers["mcp-session-id"]).toBe("session-secret");
  });

  it("does not serialize typed secret references into any provider payload", () => {
    const definition: MossPluginMcpServerDefinition = {
      pluginId: "moss:plugin:typed-secret",
      pluginName: "typed-secret",
      componentId: "plugin:mcp:typed-secret",
      serverName: "typed-secret",
      config: {
        command: "mcp-server",
        env: { API_KEY: "${MOSS_SECRET_TOKEN}" },
        args: ["--safe", "value"],
      },
    };

    expect(toMossPluginCodexMcpOverrides([definition])).toMatchObject({ serverNames: [] });
    expect(toMossPluginClaudeMcpServers([definition])).toEqual({});
    expect(toMossPluginOpenCodeMcpServers([definition])).toEqual([]);
  });

  it("rejects mutable registered stores and non-finite approval TTLs", async () => {
    const workspace = await formalPluginWorkspace();
    const plugin = (await discoverMossPluginRuntime({ cwd: workspace })).plugins[0]!;
    const approval = createMossPluginApprovalStore();
    await expect(
      approval.issuer.approve({
        cwd: workspace,
        plugin,
        componentIds: plugin.components
          .filter((component) => component.kind === "mcp")
          .map((component) => component.id),
        ttlMs: Number.POSITIVE_INFINITY,
      }),
    ).rejects.toThrow(/finite|TTL/i);

    const mutable = createMossPluginApprovalStore();
    const forged = {
      authority: "moss-server" as const,
      provenance: "server-owned-import" as const,
      pluginId: plugin.id,
      contentHash: mossPluginRuntimeContentHash(plugin),
      componentIds: plugin.components.map((component) => component.id),
      tokenId: "forged-token",
      expiresAt: Date.now() + 60_000,
    };
    try {
      (mutable.store as unknown as { get: (...args: never[]) => Promise<unknown> }).get =
        async () => forged;
    } catch {
      // GREEN: production stores are frozen and cannot be replaced by callers.
    }
    const forgedResult = await deriveMossPluginProviderMcpServers({
      cwd: workspace,
      provider: "claudeAgent",
      plugin,
      approvalStore: mutable.store,
    });
    expect(forgedResult.definitions).toEqual([]);
  });

  it("fails a large unreadable source at the fstat budget gate before reading it", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "moss-plugin-budget-"));
    tempDirs.push(workspace);
    const root = join(getMossSourceLayout(workspace).pluginsRoot, "budget-kit");
    const assetRoot = join(root, "assets");
    await mkdir(assetRoot, { recursive: true });
    const sourcePath = join(assetRoot, "large.bin");
    const handle = await open(sourcePath, "w");
    await handle.truncate(16 * 1024 * 1024 + 1);
    await handle.close();
    await writeFile(
      join(root, "plugin.json"),
      JSON.stringify({
        name: "budget-kit",
        description: "Budget fixture.",
        assets: ["./assets"],
      }),
    );
    const budgetRuntime = await discoverMossPluginRuntime({ cwd: workspace, pluginRoots: [root] });
    const plugin = budgetRuntime.plugins[0]!;
    const asset = plugin.components.find((component) => component.kind === "asset")!;
    const approval = createMossPluginApprovalStore();
    await expect(
      approval.issuer.approve({ cwd: workspace, plugin, componentIds: [asset.id] }),
    ).rejects.toThrow(/byte limit|budget/i);
  });

  it("keeps approved plugin materialization off mutable workspace symlinks", async () => {
    const workspace = await formalPluginWorkspace();
    const plugin = (await discoverMossPluginRuntime({ cwd: workspace })).plugins[0]!;
    const approval = createMossPluginApprovalStore();
    const projectionOwnershipStore = createTestProjectionOwnershipStore();
    await approval.issuer.approve({
      cwd: workspace,
      plugin,
      componentIds: plugin.components
        .filter((component) => component.kind === "skill")
        .map((component) => component.id),
    });

    const materialized = await materializeMossPluginProviderComponents({
      cwd: workspace,
      provider: "codex",
      plugin,
      approvalStore: approval.store,
      projectionOwnershipStore,
      projectionOwnershipOwnerId: "test-plugin-owner",
      projectionOwnershipGeneration: "test-plugin-generation",
    });
    const projected = materialized.components.find((component) => component.kind === "skill");
    expect(projected?.readBack).toBe(true);
    const target = join(workspace, projected?.results[0]?.targetPath ?? "");
    expect((await lstat(target)).isSymbolicLink()).toBe(false);
  });

  it("maps an explicitly selected non-native Skill by server-approved path", async () => {
    const workspace = await formalPluginWorkspace();
    const runtime = await discoverMossPluginRuntime({ cwd: workspace });
    const plugin = runtime.plugins[0]!;
    const skill = plugin.components.find((component) => component.kind === "skill")!;
    const result = await buildMossPluginPromptInjection({
      cwd: workspace,
      provider: "cursor",
      plugin,
      selectedSkills: [{ name: skill.name, path: skill.sourcePath ?? "" }],
      approvalStore: await approvePlugin(workspace, plugin, ["skill"]),
    } as never);
    expect(result.injected).toBe(true);
    expect(result.componentIds).toEqual([skill.id]);
  });

  it("does not project two plugins with the same Skill name onto one target", async () => {
    const workspace = await formalPluginWorkspace();
    const secondRoot = join(getMossSourceLayout(workspace).pluginsRoot, "second-kit");
    await mkdir(join(secondRoot, "skills", "runtime"), { recursive: true });
    await writeFile(
      join(secondRoot, "plugin.json"),
      JSON.stringify({
        name: "second-kit",
        description: "Second fixture.",
        skills: [{ name: "runtime", path: "./skills/runtime" }],
      }),
    );
    await writeFile(join(secondRoot, "skills", "runtime", "SKILL.md"), "second skill", "utf8");

    const runtime = await discoverMossPluginRuntime({ cwd: workspace });
    const approval = createMossPluginApprovalStore();
    for (const plugin of runtime.plugins) {
      await approval.issuer.approve({
        cwd: workspace,
        plugin,
        componentIds: plugin.components
          .filter((component) => component.kind === "skill")
          .map((component) => component.id),
      });
    }
    const projectionOwnershipStore = createTestProjectionOwnershipStore();
    const materialized = await materializeMossPluginProviderComponents({
      cwd: workspace,
      provider: "codex",
      approvalStore: approval.store,
      projectionOwnershipStore,
      projectionOwnershipOwnerId: "test-plugin-owner",
      projectionOwnershipGeneration: "test-plugin-generation",
    });
    const skills = materialized.components.filter((component) => component.kind === "skill");
    expect(skills.filter((component) => component.readBack)).toHaveLength(2);
    expect(
      new Set(skills.flatMap((component) => component.results.map((entry) => entry.targetPath)))
        .size,
    ).toBe(2);
  });

  it("redacts URL credentials and credential-like query values", () => {
    const redacted = redactMossPluginMcpUrl(
      "https://user:password@mcp.example.test/server?access_token=secret&mode=read#fragment",
    );
    expect(redacted).not.toContain("password");
    expect(redacted).not.toContain("secret");
    expect(redacted).toBe("https://mcp.example.test/server");
    expect(redacted).not.toContain("fragment");
  });

  it("rejects private MCP URLs and canonical-name collisions before provider injection", async () => {
    const workspace = await formalPluginWorkspace();
    const root = join(getMossSourceLayout(workspace).pluginsRoot, "runtime-kit");
    await writeFile(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "a.b": { type: "http", url: "https://mcp.example.test/a" },
          "a-b": { type: "http", url: "https://mcp.example.test/b" },
          loopback: { type: "http", url: "http://127.0.0.1:8080/mcp" },
          metadata: { type: "http", url: "http://169.254.169.254/latest/meta-data" },
          loopbackAlias: { type: "http", url: "http://localhost./mcp" },
          mappedLoopback: { type: "http", url: "http://[::ffff:127.0.0.1]/mcp" },
        },
      }),
      "utf8",
    );

    const plugin = (await discoverMossPluginRuntime({ cwd: workspace })).plugins[0]!;
    const result = await deriveMossPluginProviderMcpServers({
      cwd: workspace,
      provider: "claudeAgent",
      plugin,
      approvalStore: await approvePlugin(workspace, plugin, ["mcp"]),
    });

    expect(result.definitions).toHaveLength(1);
    expect(result.definitions[0]?.serverName).toBe("a-b");
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/collision|canonical|private|loopback|metadata/i),
      ]),
    );
  });

  it("never serializes MCP secret values and preserves supported Codex auth identities", () => {
    const secret: MossPluginMcpServerDefinition = {
      pluginId: "moss:plugin:secret",
      pluginName: "secret",
      componentId: "plugin:mcp:secret",
      serverName: "secret",
      config: { command: "secret-server", env: { API_KEY: "plaintext-secret" } },
    };
    const auth: MossPluginMcpServerDefinition = {
      pluginId: "moss:plugin:auth",
      pluginName: "auth",
      componentId: "plugin:mcp:auth",
      serverName: "auth",
      config: {
        url: "https://mcp.example.test/server",
        bearer_token_env_var: "MCP_BEARER",
        env_http_headers: { Authorization: "MCP_BEARER" },
        cwd: "/tmp/ignored",
        timeout: 10,
      },
    };
    const urlSecret: MossPluginMcpServerDefinition = {
      pluginId: "moss:plugin:url-secret",
      pluginName: "url-secret",
      componentId: "plugin:mcp:url-secret",
      serverName: "url-secret",
      config: { url: "https://mcp.example.test/server?access_token=plaintext-secret" },
    };

    const result = toMossPluginCodexMcpOverrides([secret, auth, urlSecret]);
    expect(result.args.join(" ")).not.toContain("plaintext-secret");
    expect(result.serverNames).toEqual(["auth"]);
    expect(result.args).toEqual(
      expect.arrayContaining([
        "-c",
        'mcp_servers.auth.bearer_token_env_var="MCP_BEARER"',
        "-c",
        'mcp_servers.auth.env_http_headers={Authorization = "MCP_BEARER"}',
      ]),
    );
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/secret|cwd|timeout/i)]),
    );
  });

  it("rejects literal credentials embedded in MCP command arguments", () => {
    const result = toMossPluginCodexMcpOverrides([
      {
        pluginId: "moss:plugin:args-secret",
        pluginName: "args-secret",
        componentId: "plugin:mcp:args-secret",
        serverName: "args-secret",
        config: { command: "mcp-server", args: ["--api-key=plaintext-secret"] },
      },
    ]);

    expect(result.serverNames).toEqual([]);
    expect(result.args.join(" ")).not.toContain("plaintext-secret");
    expect(result.warnings).toContainEqual(expect.stringMatching(/secret|credential|unsupported/i));
  });

  it("rejects MCP key injection and canonicalizes provider name collisions", () => {
    const unsafeKeys: MossPluginMcpServerDefinition = {
      pluginId: "moss:plugin:unsafe-keys",
      pluginName: "unsafe-keys",
      componentId: "plugin:mcp:unsafe-keys",
      serverName: "unsafe-keys",
      config: {
        command: "unsafe-server",
        env: { "BAD.KEY": "value" },
      },
    };
    const dotted: MossPluginMcpServerDefinition = {
      pluginId: "moss:plugin:names",
      pluginName: "names",
      componentId: "plugin:mcp:dotted",
      serverName: "a.b",
      config: { command: "first-server" },
    };
    const dashed: MossPluginMcpServerDefinition = {
      ...dotted,
      componentId: "plugin:mcp:dashed",
      serverName: "a-b",
      config: { command: "second-server" },
    };

    const codex = toMossPluginCodexMcpOverrides([unsafeKeys, dotted, dashed]);
    expect(codex.args.join(" ")).not.toContain("BAD.KEY");
    expect(codex.serverNames).toEqual(["a-b"]);
    expect(codex.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/unsafe|collision|owned/i)]),
    );
    expect(toMossPluginOpenCodeMcpServers([dotted, dashed]).map((server) => server.name)).toEqual([
      "a-b",
    ]);
    expect(Object.keys(toMossPluginClaudeMcpServers([dotted, dashed]))).toEqual(["a-b"]);
  });

  it("does not silently reinterpret SSE as an OpenCode remote server", () => {
    const sse: MossPluginMcpServerDefinition = {
      pluginId: "moss:plugin:sse",
      pluginName: "sse",
      componentId: "plugin:mcp:sse",
      serverName: "sse",
      config: { type: "sse", url: "https://mcp.example.test/events" },
    };

    expect(toMossPluginOpenCodeMcpServers([sse])).toEqual([]);
  });

  it("keeps unsafe plugin component names out of provider projection targets", async () => {
    const workspace = await formalPluginWorkspace();
    const plugin = (await discoverMossPluginRuntime({ cwd: workspace })).plugins[0]!;
    const unsafePlugin = {
      ...plugin,
      components: plugin.components.map((component) =>
        component.kind === "skill" ? { ...component, name: "../escape", enabled: true } : component,
      ),
    };
    const approval = createMossPluginApprovalStore();
    await expect(
      approval.issuer.approve({
        cwd: workspace,
        plugin: unsafePlugin,
        componentIds: unsafePlugin.components
          .filter((component) => component.kind === "skill")
          .map((component) => component.id),
      }),
    ).rejects.toThrow(/unsafe source path|component/i);
    const result = await materializeMossPluginProviderComponents({
      cwd: workspace,
      provider: "codex",
      plugin: unsafePlugin,
      approvalStore: approval.store,
    });

    expect(result.components).toContainEqual(
      expect.objectContaining({ kind: "skill", supportStatus: "unsupported", readBack: false }),
    );
  });

  it("builds provider-native MCP payloads without turning catalog metadata into execution", async () => {
    const workspace = await formalPluginWorkspace();
    const runtime = await discoverMossPluginRuntime({ cwd: workspace });
    const plugin = runtime.plugins[0]!;
    const derived = await deriveMossPluginProviderMcpServers({
      cwd: workspace,
      provider: "opencode",
      plugin,
      approvalStore: await approvePlugin(workspace, plugin, ["mcp"]),
    });

    expect(toMossPluginCodexMcpOverrides(derived.definitions).args).toEqual([
      "-c",
      'mcp_servers.docs.command="node"',
      "-c",
      'mcp_servers.docs.args=["docs-server.mjs"]',
      "-c",
      'mcp_servers.docs.env={MODE = "test"}',
      "-c",
      'mcp_servers.remote.url="https://mcp.example.test/server"',
    ]);
    expect(toMossPluginOpenCodeMcpServers(derived.definitions)).toEqual([
      expect.objectContaining({
        name: "docs",
        config: expect.objectContaining({ type: "local", command: ["node", "docs-server.mjs"] }),
      }),
      expect.objectContaining({
        name: "remote",
        config: expect.objectContaining({ type: "remote", url: "https://mcp.example.test/server" }),
      }),
    ]);
    expect(toMossPluginClaudeMcpServers(derived.definitions)).toMatchObject({
      docs: { command: "node", args: ["docs-server.mjs"], env: { MODE: "test" } },
      remote: { type: "http", url: "https://mcp.example.test/server" },
    });
  });

  it("discovers and calls Pi HTTP plugin tools through a read-back adapter", async () => {
    const workspace = await formalPluginWorkspace();
    const requests: string[] = [];
    const sessionHeaders: Array<string | null> = [];
    const fetch = createMossPluginPinnedMcpFetchForTest(async (_input, init) => {
      if (init?.method === "DELETE") {
        requests.push("DELETE");
        sessionHeaders.push(new Headers(init.headers).get("Mcp-Session-Id"));
        return new Response(null, { status: 200 });
      }
      const request = JSON.parse(String(init?.body)) as { method: string; id?: string };
      requests.push(request.method);
      sessionHeaders.push(new Headers(init?.headers).get("Mcp-Session-Id"));
      const result =
        request.method === "tools/list"
          ? {
              tools: [
                {
                  name: "search",
                  description: "Search docs.",
                  inputSchema: { type: "object", properties: { query: { type: "string" } } },
                },
              ],
            }
          : request.method === "tools/call"
            ? { content: [{ type: "text", text: "search result" }], isError: false }
            : {};
      if (request.method === "notifications/initialized") {
        return new Response(null, { status: 202, headers: { "Mcp-Session-Id": "session-1" } });
      }
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: request.id ?? "notification", result }),
        {
          status: 200,
          headers: { "content-type": "application/json", "Mcp-Session-Id": "session-1" },
        },
      );
    });

    const runtime = await discoverMossPluginRuntime({ cwd: workspace });
    const plugin = runtime.plugins[0]!;
    const discovered = await discoverMossPluginPiTools({
      cwd: workspace,
      fetch,
      resolveHost: async () => ["93.184.216.34"],
      approvalStore: await approvePlugin(workspace, plugin, ["mcp"]),
    });
    expect(discovered.warnings).toEqual([
      expect.stringContaining(
        "docs is unsupported on Pi: the session adapter only accepts HTTP MCP servers",
      ),
    ]);
    expect(discovered.tools).toEqual([
      expect.objectContaining({
        name: "moss_plugin_remote_search",
        remoteToolName: "search",
      }),
    ]);

    const result = await callMossPluginPiTool({
      tool: discovered.tools[0]!,
      arguments: { query: "Moss" },
      fetch,
    });
    expect(result).toEqual({ content: [{ type: "text", text: "search result" }], isError: false });
    await closeMossPluginPiTools(discovered.tools);
    expect(requests).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
      "DELETE",
    ]);
    expect(sessionHeaders).toEqual([null, "session-1", "session-1", "session-1", "session-1"]);
  });

  it("cancels a never-resolving Pi MCP request through the session AbortSignal", async () => {
    const workspace = await formalPluginWorkspace();
    const plugin = (await discoverMossPluginRuntime({ cwd: workspace })).plugins[0]!;
    const controller = new AbortController();
    const fetch = createMossPluginPinnedMcpFetchForTest(
      async (_input, init) =>
        new Promise<Response>((_, reject) => {
          const abort = () => reject(init?.signal?.reason ?? new Error("aborted"));
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener("abort", abort, { once: true });
        }),
    );
    const startedAt = Date.now();
    const pending = discoverMossPluginPiTools({
      cwd: workspace,
      fetch,
      resolveHost: async () => ["93.184.216.34"],
      signal: controller.signal,
      approvalStore: await approvePlugin(workspace, plugin, ["mcp"]),
    });
    setTimeout(() => controller.abort(new Error("test cancellation")), 20);
    const result = await pending;

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(result.tools).toEqual([]);
    expect(result.warnings).toContainEqual(expect.stringMatching(/aborted|cancellation|failed/i));
  });

  it("closes Pi sessions with empty catalogs and rejects canonical tool collisions", async () => {
    const workspace = await formalPluginWorkspace();
    const plugin = (await discoverMossPluginRuntime({ cwd: workspace })).plugins[0]!;
    const approval = await approvePlugin(workspace, plugin, ["mcp"]);
    const run = async (catalog: unknown[]) => {
      const requests: string[] = [];
      const fetch = createMossPluginPinnedMcpFetchForTest(async (_input, init) => {
        if (init?.method === "DELETE") {
          requests.push("DELETE");
          return new Response(null, { status: 202 });
        }
        const request = JSON.parse(String(init?.body)) as { method: string };
        requests.push(request.method);
        if (request.method === "tools/list") {
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: "list", result: { tools: catalog } }),
            {
              status: 200,
              headers: { "content-type": "application/json", "Mcp-Session-Id": "pi-test" },
            },
          );
        }
        if (request.method === "notifications/initialized") {
          return new Response(null, { status: 202, headers: { "Mcp-Session-Id": "pi-test" } });
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: "initialize", result: {} }), {
          status: 200,
          headers: { "content-type": "application/json", "Mcp-Session-Id": "pi-test" },
        });
      });
      const discovered = await discoverMossPluginPiTools({
        cwd: workspace,
        fetch,
        resolveHost: async () => ["93.184.216.34"],
        approvalStore: approval,
      });
      return { discovered, requests };
    };

    const empty = await run([]);
    expect(empty.discovered.tools).toEqual([]);
    expect(empty.requests).toContain("DELETE");

    const collision = await run([
      { name: "a.b", inputSchema: { type: "object" } },
      { name: "a_b", inputSchema: { type: "object" } },
    ]);
    expect(collision.discovered.tools).toHaveLength(1);
    expect(collision.discovered.warnings).toContainEqual(expect.stringMatching(/collision/i));
    await closeMossPluginPiTools(collision.discovered.tools.map((tool) => ({ ...tool })));
  });

  it("rolls back every Pi session when a later MCP catalog exceeds the aggregate budget", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "moss-plugin-pi-rollback-"));
    tempDirs.push(workspace);
    const root = join(getMossSourceLayout(workspace).pluginsRoot, "pi-rollback-kit");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "plugin.json"),
      JSON.stringify({
        name: "pi-rollback-kit",
        description: "Pi rollback fixture.",
        mcpServers: "./mcp.json",
      }),
    );
    await writeFile(
      join(root, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          first: { type: "http", url: "https://mcp.example.test/first" },
          second: { type: "http", url: "https://mcp.example.test/second" },
        },
      }),
    );
    const plugin = (await discoverMossPluginRuntime({ cwd: workspace })).plugins[0]!;
    const approval = await approvePlugin(workspace, plugin, ["mcp"]);
    const requests: string[] = [];
    const fetch = createMossPluginPinnedMcpFetchForTest(async (input, init) => {
      const url = String(input);
      if (init?.method === "DELETE") {
        requests.push(`DELETE:${url}`);
        return new Response(null, { status: 200 });
      }
      const request = JSON.parse(String(init?.body)) as { method: string };
      requests.push(`${request.method}:${url}`);
      if (request.method === "notifications/initialized") {
        return new Response(null, {
          status: 202,
          headers: { "Mcp-Session-Id": url.endsWith("first") ? "first" : "second" },
        });
      }
      if (request.method === "tools/list" && url.endsWith("second")) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "list",
            result: {
              tools: Array.from({ length: 257 }, (_, index) => ({
                name: `tool-${index}`,
                inputSchema: { type: "object" },
              })),
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json", "Mcp-Session-Id": "second" },
          },
        );
      }
      const result = request.method === "tools/list" ? { tools: [] } : {};
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "request", result }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "Mcp-Session-Id": url.endsWith("first") ? "first" : "second",
        },
      });
    });

    const result = await discoverMossPluginPiTools({
      cwd: workspace,
      fetch,
      resolveHost: async () => ["93.184.216.34"],
      approvalStore: approval,
    });
    expect(result.tools).toEqual([]);
    expect(requests.filter((request) => request.startsWith("DELETE:"))).toHaveLength(2);
  });

  it("injects validated skill text only when the provider has no native skill loader", async () => {
    const workspace = await formalPluginWorkspace();
    const runtime = await discoverMossPluginRuntime({ cwd: workspace });
    const plugin = runtime.plugins[0]!;
    const skill = plugin.components.find((component) => component.kind === "skill")!;

    const cursor = await buildMossPluginPromptInjection({
      cwd: workspace,
      provider: "cursor",
      selectedComponentIds: [skill.id],
      approvalStore: await approvePlugin(workspace, plugin, ["skill"]),
    });
    expect(cursor.injected).toBe(true);
    expect(cursor.text).toContain("# Runtime skill");
    expect(cursor.text).toContain("[source:moss-plugin");
    expect(cursor.componentIds).toEqual(["plugin:skill:runtime"]);

    const codex = await buildMossPluginPromptInjection({ cwd: workspace, provider: "codex" });
    expect(codex.injected).toBe(false);
    expect(codex.text).toBe("");
  });

  it("never reports execution without an explicit native or adapter executor", async () => {
    const workspace = await formalPluginWorkspace();
    const runtime = await discoverMossPluginRuntime({ cwd: workspace });
    const plugin = runtime.plugins[0]!;
    const skill = plugin.components.find((component) => component.kind === "skill")!;

    const result = await executeMossPluginComponent({
      cwd: workspace,
      plugin,
      provider: "codex",
      component: skill,
      approvalStore: await approvePlugin(workspace, plugin, ["skill"]),
    });

    expect(result.executed).toBe(false);
    expect(result.status).toBe("executor-unavailable");
    expect(result.reason).toContain("explicit");
  });

  it("executes against the immutable approval snapshot rather than the live plugin path", async () => {
    const workspace = await formalPluginWorkspace();
    const runtime = await discoverMossPluginRuntime({ cwd: workspace });
    const plugin = runtime.plugins[0]!;
    const skill = plugin.components.find((component) => component.kind === "skill")!;
    const approval = await approvePlugin(workspace, plugin, ["skill"]);
    let executorRoot = "";

    const result = await executeMossPluginComponent({
      cwd: workspace,
      plugin,
      provider: "codex",
      component: skill,
      approvalStore: approval,
      executors: {
        native: ({ plugin: approvedPlugin }) => {
          executorRoot = approvedPlugin.absolutePluginRoot;
          return "snapshot-executed";
        },
      },
    });

    expect(result).toMatchObject({
      executed: true,
      status: "executed",
      result: "snapshot-executed",
    });
    expect(executorRoot).not.toBe(plugin.absolutePluginRoot);
  });

  it("imports a formal plugin root with the plugin-creator marketplace policy", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "moss-plugin-marketplace-"));
    tempDirs.push(workspace);
    const root = join(workspace, "plugins", "policy-kit");
    await mkdir(join(root, ".codex-plugin"), { recursive: true });
    await writeFile(
      join(root, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "policy-kit",
        version: "1.0.0",
        description: "Policy fixture.",
        author: { name: "Moss" },
        interface: {
          displayName: "Policy Kit",
          shortDescription: "Policy",
          longDescription: "Policy fixture.",
          developerName: "Moss",
          category: "Productivity",
          capabilities: ["Policy"],
          defaultPrompt: ["Review policy"],
        },
      }),
    );
    const marketplacePath = join(workspace, "marketplace.json");
    await writeFile(
      marketplacePath,
      JSON.stringify({
        name: "personal",
        interface: { displayName: "Personal" },
        plugins: [
          {
            name: "policy-kit",
            source: { source: "local", path: "./plugins/policy-kit" },
            policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
            category: "Productivity",
          },
        ],
      }),
    );

    const runtime = await discoverMossPluginRuntime({
      cwd: workspace,
      // Importers may hand the runtime either a plugin root or the formal
      // manifest file. Both must resolve to the same plugin root.
      pluginRoots: [join(root, ".codex-plugin", "plugin.json")],
      marketplacePath,
    });

    expect(runtime.errors).toEqual([]);
    expect(runtime.plugins[0]?.marketplacePolicy).toEqual({
      installation: "AVAILABLE",
      authentication: "ON_INSTALL",
      category: "Productivity",
    });
  });

  it("does not execute a valid plugin that the canonical manifest disabled", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "moss-plugin-disabled-"));
    tempDirs.push(workspace);
    const root = join(getMossSourceLayout(workspace).pluginsRoot, "disabled-kit");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "plugin.json"),
      JSON.stringify({
        name: "disabled-kit",
        description: "Disabled fixture.",
        enabled: false,
        skills: [{ name: "disabled-skill", path: "./skills/disabled" }],
      }),
    );

    const runtime = await discoverMossPluginRuntime({ cwd: workspace });
    const plugin = runtime.plugins[0]!;
    const component = plugin.components[0]!;
    expect(plugin.enabled).toBe(false);
    expect(buildMossPluginRuntimePlan({ plugin, provider: "codex" }).components[0]).toMatchObject({
      status: "display-only",
      execution: "native",
    });

    const result = await executeMossPluginComponent({
      cwd: workspace,
      plugin,
      provider: "codex",
      component,
      executors: { native: () => "must-not-run" },
    });
    expect(result).toMatchObject({
      status: "display-only",
      executed: false,
      reason: "Plugin is disabled; no plugin component may execute.",
    });
  });

  it("rejects a component that is not part of the discovered plugin IR", async () => {
    const workspace = await formalPluginWorkspace();
    const runtime = await discoverMossPluginRuntime({ cwd: workspace });
    const plugin = runtime.plugins[0]!;
    const component = plugin.components[0]!;
    const result = await executeMossPluginComponent({
      cwd: workspace,
      plugin,
      provider: "codex",
      component: { ...component, id: "plugin:skill:forged" },
      executors: { native: () => "must-not-run" },
    });

    expect(result.status).toBe("blocked");
    expect(result.executed).toBe(false);
    expect(result.reason).toContain("not declared");
  });

  it("keeps legacy plugin hooks display-only until they carry explicit trust", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "moss-plugin-hook-"));
    tempDirs.push(workspace);
    const root = join(getMossSourceLayout(workspace).pluginsRoot, "hook-kit");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "plugin.json"),
      JSON.stringify({
        name: "hook-kit",
        description: "Hook fixture.",
        hooks: [{ name: "on-stop", event: "Stop", command: "echo unsafe" }],
      }),
    );

    const plugin = (await discoverMossPluginRuntime({ cwd: workspace })).plugins[0]!;
    const hook = plugin.components.find((component) => component.kind === "hook")!;
    expect(buildMossPluginRuntimePlan({ plugin, provider: "codex" }).components[0]).toMatchObject({
      status: "display-only",
      execution: "adapter",
    });
    const result = await executeMossPluginComponent({
      plugin,
      provider: "codex",
      component: hook,
      cwd: workspace,
      approvalStore: await approvePlugin(workspace, plugin, ["hook"]),
      executors: { adapter: () => "must-not-run" },
    });
    expect(result).toMatchObject({ status: "display-only", executed: false });
    expect(result.reason).toContain("explicitly trusted");
  });
});
