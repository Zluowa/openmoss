import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getMossSourceLayout } from "@synara/shared/mossSourceLayout";

import { deriveMossPluginProviderMcpServers, discoverMossPluginRuntime } from "./mossPluginRuntime";
import {
  createMossPluginProductionApprovalService,
  MossPluginApprovalError,
  notifyMossPluginApprovalChanged,
} from "./mossPluginApprovalService";
import type { MossProjectionOwnershipStore } from "@synara/shared/mossProjectionMaterializer";

const tempDirs: string[] = [];
const repositoryRoot = resolve(import.meta.dirname, "../../../..");

function makeProjectionAuthority(ownerId = "approval-test-owner") {
  const ownershipStore = {
    withMutationLock: async <T>(
      _scope: unknown,
      operation: (fence: string) => Promise<T>,
    ): Promise<T> => operation("approval-test-fence"),
    appendPrivateManifest: async (input: {
      readonly transactionId: string;
      readonly operationId: string;
      readonly sequence: number;
      readonly previousHash: string;
      readonly recordHash: string;
    }) => ({
      locator: "approval-test",
      transactionId: input.transactionId,
      operationId: input.operationId,
      sequence: input.sequence,
      previousHash: input.previousHash,
      recordHash: input.recordHash,
    }),
    readPrivateManifest: async () => null,
    create: async () => ({ status: "missing" as const }),
    publish: async () => ({ status: "missing" as const }),
    replace: async () => ({ status: "missing" as const }),
    remove: async () => ({ status: "missing" as const }),
  } satisfies MossProjectionOwnershipStore;
  return {
    ownershipStore,
    ownerId,
    generation: "approval-test-generation",
    assertLive: () => undefined,
  };
}

afterEach(async () => {
  for (const directory of tempDirs.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("MossPluginProductionApprovalService", () => {
  it("fails closed before the issuer when no server authority is resolved", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "moss-plugin-approval-no-authority-"));
    tempDirs.push(workspace);
    const root = join(getMossSourceLayout(workspace).pluginsRoot, "no-authority-kit");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "plugin.json"),
      JSON.stringify({
        name: "no-authority-kit",
        description: "No authority fixture.",
        mcpServers: { docs: { command: "docs-server" } },
      }),
    );
    const plugin = (await discoverMossPluginRuntime({ cwd: workspace })).plugins[0]!;
    const service = createMossPluginProductionApprovalService();

    await expect(
      service.authorize({ cwd: workspace, plugin, enabled: true }),
    ).rejects.toBeInstanceOf(MossPluginApprovalError);
    await expect(
      service.authorize({ cwd: workspace, plugin, enabled: true }),
    ).rejects.toMatchObject({ code: "authorization-required" });
    const derived = await deriveMossPluginProviderMcpServers({
      cwd: workspace,
      provider: "claudeAgent",
      plugin,
      approvalStore: service.store,
    });
    expect(derived.definitions).toEqual([]);
    service.dispose();
  });

  it("does not revoke an existing approval when disable or revoke lacks authority", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "moss-plugin-approval-revoke-no-authority-"));
    tempDirs.push(workspace);
    const root = join(getMossSourceLayout(workspace).pluginsRoot, "revoke-no-authority-kit");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "plugin.json"),
      JSON.stringify({
        name: "revoke-no-authority-kit",
        description: "Revoke no authority fixture.",
        mcpServers: { docs: { command: "docs-server" } },
      }),
    );
    const plugin = (await discoverMossPluginRuntime({ cwd: workspace })).plugins[0]!;
    const service = createMossPluginProductionApprovalService();
    const authority = {
      ownershipStore: {
        withMutationLock: async <T>(
          _scope: unknown,
          operation: (fence: string) => Promise<T>,
        ): Promise<T> => operation("approval-fence"),
        appendPrivateManifest: async (input: { readonly transactionId: string }) => ({
          locator: "approval",
          transactionId: input.transactionId,
          operationId: input.transactionId,
          sequence: 0,
          previousHash: "genesis",
          recordHash: "record",
        }),
        readPrivateManifest: async () => null,
        create: async () => ({ status: "missing" as const }),
        publish: async () => ({ status: "missing" as const }),
        replace: async () => ({ status: "missing" as const }),
        remove: async () => ({ status: "missing" as const }),
      },
      ownerId: "approval-owner",
      generation: "approval-generation",
      assertLive: () => undefined,
    } as const;

    await service.authorize({
      cwd: workspace,
      plugin,
      enabled: true,
      projectionAuthority: authority,
    });
    const before = await deriveMossPluginProviderMcpServers({
      cwd: workspace,
      provider: "claudeAgent",
      plugin,
      approvalStore: service.store,
    });
    expect(before.definitions.map((definition) => definition.serverName)).toEqual(["docs"]);

    await expect(
      service.authorize({ cwd: workspace, plugin, enabled: false }),
    ).rejects.toMatchObject({
      code: "authorization-required",
    });
    await expect(service.revoke({ cwd: workspace, pluginId: plugin.id })).rejects.toMatchObject({
      code: "authorization-required",
    });
    const after = await deriveMossPluginProviderMcpServers({
      cwd: workspace,
      provider: "claudeAgent",
      plugin,
      approvalStore: service.store,
    });
    expect(after.definitions.map((definition) => definition.serverName)).toEqual(["docs"]);
    service.dispose();
  });

  it("rechecks the factory liveness token before authorize and revoke issuer mutations", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "moss-plugin-approval-stale-handle-"));
    tempDirs.push(workspace);
    const root = join(getMossSourceLayout(workspace).pluginsRoot, "stale-handle-kit");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "plugin.json"),
      JSON.stringify({
        name: "stale-handle-kit",
        description: "Stale authority fixture.",
        mcpServers: { docs: { command: "docs-server" } },
      }),
    );
    const plugin = (await discoverMossPluginRuntime({ cwd: workspace })).plugins[0]!;
    const service = createMossPluginProductionApprovalService();
    let live = true;
    const authority = {
      ...makeProjectionAuthority("stale-owner"),
      assertLive: () => {
        if (!live) {
          throw new MossPluginApprovalError(
            "authorization-required",
            "The Moss projection authority handle is stale.",
          );
        }
      },
    };

    await service.authorize({
      cwd: workspace,
      plugin,
      enabled: true,
      projectionAuthority: authority,
    });
    live = false;
    await expect(
      service.authorize({ cwd: workspace, plugin, enabled: true, projectionAuthority: authority }),
    ).rejects.toMatchObject({ code: "authorization-required" });
    await expect(
      service.revoke({ cwd: workspace, pluginId: plugin.id, projectionAuthority: authority }),
    ).rejects.toMatchObject({ code: "authorization-required" });
    service.dispose();
  });

  it("serializes scoped engine cleanup and returns a durable revoke receipt", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "moss-plugin-approval-receipt-"));
    tempDirs.push(workspace);
    const root = join(getMossSourceLayout(workspace).pluginsRoot, "receipt-kit");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "plugin.json"),
      JSON.stringify({
        name: "receipt-kit",
        description: "Receipt fixture.",
        mcpServers: { docs: { command: "docs-server" } },
      }),
    );
    const plugin = (await discoverMossPluginRuntime({ cwd: workspace })).plugins[0]!;
    let activeLocks = 0;
    const projectionOwnershipStore = {
      withMutationLock: async (_scope, operation) => {
        activeLocks += 1;
        if (activeLocks !== 1) throw new Error("projection engines reconciled concurrently");
        try {
          await new Promise((resolve) => setTimeout(resolve, 0));
          return await operation("receipt-fence");
        } finally {
          activeLocks -= 1;
        }
      },
      appendPrivateManifest: async (input) => ({
        locator: "receipt-projection-journal",
        transactionId: input.transactionId,
        operationId: input.operationId,
        sequence: input.sequence,
        previousHash: input.previousHash,
        recordHash: input.recordHash,
      }),
      readPrivateManifest: async () => null,
      create: async () => ({ status: "missing" as const }),
      publish: async () => ({ status: "missing" as const }),
      replace: async () => ({ status: "missing" as const }),
      remove: async () => ({ status: "missing" as const }),
    } satisfies MossProjectionOwnershipStore;
    const authority = {
      ownershipStore: projectionOwnershipStore,
      ownerId: "receipt-owner",
      generation: "receipt-generation",
      assertLive: () => undefined,
    };

    const service = createMossPluginProductionApprovalService();
    await service.authorize({
      cwd: workspace,
      plugin,
      enabled: true,
      projectionAuthority: authority,
    });
    const receipt = await service.revoke({
      cwd: workspace,
      pluginId: plugin.id,
      projectionAuthority: authority,
    });

    expect(receipt).toMatchObject({ status: "committed", durable: true });
    expect(receipt.engines).toHaveLength(2);
    expect(receipt.engines.map((engine) => engine.engineId)).toEqual(["codex", "claudeAgent"]);
    service.dispose();
  });

  it("is the server-owned authorization path and issues a bounded approval without exposing an issuer", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "moss-plugin-production-approval-"));
    tempDirs.push(workspace);
    const root = join(getMossSourceLayout(workspace).pluginsRoot, "production-kit");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "plugin.json"),
      JSON.stringify({
        name: "production-kit",
        description: "Production approval fixture.",
        mcpServers: { docs: { command: "docs-server" } },
      }),
    );

    const plugin = (await discoverMossPluginRuntime({ cwd: workspace })).plugins[0]!;
    const service = createMossPluginProductionApprovalService();
    expect("issuer" in service).toBe(false);
    const authority = makeProjectionAuthority();

    const authorization = await service.authorize({
      cwd: workspace,
      plugin,
      enabled: true,
      projectionAuthority: authority,
    });
    expect(authorization.approved).toBe(true);
    expect(authorization.expiresAt).toBeGreaterThan(Date.now());
    expect(Number.isFinite(authorization.expiresAt)).toBe(true);

    const derived = await deriveMossPluginProviderMcpServers({
      cwd: workspace,
      provider: "claudeAgent",
      plugin,
      approvalStore: service.store,
    });
    expect(derived.definitions.map((definition) => definition.serverName)).toEqual(["docs"]);
    service.dispose();
  });

  it("removes its internal approval listener at dispose without affecting another layer", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "moss-plugin-approval-lifecycle-"));
    tempDirs.push(workspace);
    const root = join(getMossSourceLayout(workspace).pluginsRoot, "lifecycle-kit");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "plugin.json"),
      JSON.stringify({
        name: "lifecycle-kit",
        description: "Lifecycle fixture.",
        mcpServers: { docs: { command: "docs-server" } },
      }),
    );
    const plugin = (await discoverMossPluginRuntime({ cwd: workspace })).plugins[0]!;
    const first = createMossPluginProductionApprovalService();
    const second = createMossPluginProductionApprovalService();
    const authority = makeProjectionAuthority("lifecycle-owner");
    await first.authorize({
      cwd: workspace,
      plugin,
      enabled: true,
      projectionAuthority: authority,
    });
    await second.authorize({
      cwd: workspace,
      plugin,
      enabled: true,
      projectionAuthority: authority,
    });

    first.dispose();
    await notifyMossPluginApprovalChanged({
      cwd: workspace,
      pluginId: plugin.id,
      enabled: false,
      projectionAuthority: authority,
    });

    const firstStillApproved = await deriveMossPluginProviderMcpServers({
      cwd: workspace,
      provider: "claudeAgent",
      plugin,
      approvalStore: first.store,
    });
    const secondRevoked = await deriveMossPluginProviderMcpServers({
      cwd: workspace,
      provider: "claudeAgent",
      plugin,
      approvalStore: second.store,
    });
    expect(firstStillApproved.definitions.map((definition) => definition.serverName)).toEqual([
      "docs",
    ]);
    expect(secondRevoked.definitions).toEqual([]);
    second.dispose();
  });

  it("registers the ProviderService approval cleanup as a callback-shaped Effect finalizer", async () => {
    const source = await readFile(
      join(repositoryRoot, "apps", "server", "src", "provider", "Layers", "ProviderService.ts"),
      "utf8",
    );
    expect(source).toContain(
      "Effect.addFinalizer(() => Effect.sync(unregisterMossPluginApprovalChange))",
    );
    expect(source).not.toContain(
      "Effect.addFinalizer(Effect.sync(unregisterMossPluginApprovalChange))",
    );
  });
});
