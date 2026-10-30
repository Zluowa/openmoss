import {
  createMossPluginApprovalStore,
  type MossPluginApprovalStore,
} from "./mossPluginRuntime.ts";
import { resolve } from "node:path";
import type { MossPluginIR } from "@synara/shared/mossResourceRegistry";
import {
  reconcileMossProjectionResources,
  type MossProjectionOwnershipStore,
} from "@synara/shared/mossProjectionMaterializer";
import { discoverMossPluginRuntime } from "./mossPluginRuntime.ts";

export interface MossPluginApprovalChange {
  readonly cwd: string;
  readonly pluginId: string;
  readonly enabled: boolean;
  readonly projectionAuthority?: MossPluginProjectionAuthorityScope | undefined;
}

export type MossPluginApprovalErrorCode = "authorization-required" | "durability-unsupported";

export class MossPluginApprovalError extends Error {
  readonly code: MossPluginApprovalErrorCode;

  constructor(code: MossPluginApprovalErrorCode, message: string) {
    super(message);
    this.name = "MossPluginApprovalError";
    this.code = code;
  }
}

export type MossPluginApprovalChangeListener = (
  input: MossPluginApprovalChange,
) => void | Promise<void>;
const approvalChangeListeners = new Set<MossPluginApprovalChangeListener>();

export function subscribeMossPluginApprovalChanges(
  listener: MossPluginApprovalChangeListener,
): () => void {
  approvalChangeListeners.add(listener);
  return () => approvalChangeListeners.delete(listener);
}

export async function notifyMossPluginApprovalChanged(
  input: MossPluginApprovalChange,
): Promise<void> {
  await Promise.all([...approvalChangeListeners].map((listener) => listener(input)));
}

/**
 * The only projection authority shape accepted by production approval. The
 * concrete factory handle is server-bound; this narrow structural port keeps
 * the approval issuer independent from the WS transport.
 */
export interface MossPluginProjectionAuthorityScope {
  readonly ownershipStore: MossProjectionOwnershipStore;
  readonly ownerId: string;
  readonly generation: string;
  /** Factory-issued liveness check; must run before every issuer/store mutation. */
  readonly assertLive: () => void;
}

export interface MossPluginApprovalRevokeReceipt {
  readonly status: "committed" | "conflict" | "read-only";
  readonly durable: boolean;
  readonly engines: ReadonlyArray<{
    readonly engineId: "codex" | "claudeAgent";
    readonly removedEntries: ReadonlyArray<string>;
    readonly removedTargets: ReadonlyArray<string>;
    readonly conflictedTargets?: ReadonlyArray<string> | undefined;
  }>;
}

export interface MossPluginProductionApprovalService {
  /** Runtime-only store; never sourced from workspace files or plugin metadata. */
  readonly store: MossPluginApprovalStore;
  /** Server authorization action used by the provider discovery/RPC boundary. */
  readonly authorize: (input: {
    readonly cwd: string;
    readonly plugin: MossPluginIR;
    readonly enabled: boolean;
    readonly projectionAuthority?: MossPluginProjectionAuthorityScope | undefined;
  }) => Promise<{ readonly approved: boolean; readonly expiresAt?: number | undefined }>;
  readonly revoke: (input: {
    readonly cwd: string;
    readonly pluginId: string;
    readonly projectionAuthority?: MossPluginProjectionAuthorityScope | undefined;
  }) => Promise<MossPluginApprovalRevokeReceipt>;
  readonly registerApprovalChangeListener: (
    listener: MossPluginApprovalChangeListener,
  ) => () => void;
  /** Removes this service's internal global listener; safe to call repeatedly. */
  readonly dispose: () => void;
}

function executableComponentIds(plugin: MossPluginIR): string[] {
  return plugin.components
    .filter(
      (component) =>
        component.enabled &&
        (component.kind === "skill" || component.kind === "subagent" || component.kind === "mcp"),
    )
    .map((component) => component.id);
}

/**
 * Build the production approval boundary. The issuer remains in this module's
 * closure; callers receive only a server authorization action and the runtime
 * store. Workspace/plugin data can request display state but cannot mint a
 * token or replace the authority.
 */
export function createMossPluginProductionApprovalService(): MossPluginProductionApprovalService {
  const { store, issuer } = createMossPluginApprovalStore();
  const requireProjectionAuthority = (
    authority: MossPluginProjectionAuthorityScope | undefined,
  ): MossPluginProjectionAuthorityScope => {
    if (!authority) {
      throw new MossPluginApprovalError(
        "authorization-required",
        "A server-scoped workspace authority is required before Moss plugin approval can change.",
      );
    }
    if (
      !authority.ownerId ||
      !authority.generation ||
      !authority.ownershipStore ||
      typeof authority.assertLive !== "function"
    ) {
      throw new MossPluginApprovalError(
        "durability-unsupported",
        "The server-scoped workspace authority is incomplete for Moss plugin approval.",
      );
    }
    try {
      authority.assertLive();
    } catch (cause) {
      throw new MossPluginApprovalError(
        "authorization-required",
        cause instanceof Error
          ? cause.message
          : "The server-scoped workspace authority handle is stale.",
      );
    }
    return authority;
  };
  const revokeApproval = async (input: {
    readonly cwd: string;
    readonly pluginId: string;
    readonly projectionAuthority?: MossPluginProjectionAuthorityScope | undefined;
  }): Promise<MossPluginApprovalRevokeReceipt> => {
    const authority = requireProjectionAuthority(input.projectionAuthority);
    // Recheck after resolving the input and immediately before the issuer
    // mutation. Session close/rebind may revoke the handle concurrently.
    requireProjectionAuthority(authority);
    issuer.revoke(input);
    const engines: Array<MossPluginApprovalRevokeReceipt["engines"][number]> = [];
    for (const engineId of ["codex", "claudeAgent"] as const) {
      requireProjectionAuthority(authority);
      const result = await reconcileMossProjectionResources({
        projectPath: input.cwd,
        engineId,
        resourceIdPrefix: `${input.pluginId}:`,
        ownershipStore: authority.ownershipStore,
        ownershipOwnerId: authority.ownerId,
        ownershipGeneration: authority.generation,
      });
      engines.push({ engineId, ...result });
    }
    return {
      status: engines.some((engine) => (engine.conflictedTargets?.length ?? 0) > 0)
        ? "conflict"
        : "committed",
      durable: true,
      engines,
    };
  };
  const authorize = async (input: {
    readonly cwd: string;
    readonly plugin: MossPluginIR;
    readonly enabled: boolean;
    readonly projectionAuthority?: MossPluginProjectionAuthorityScope | undefined;
  }) => {
    const authority = requireProjectionAuthority(input.projectionAuthority);
    const canonicalRuntime = await discoverMossPluginRuntime({ cwd: input.cwd });
    const plugin = canonicalRuntime.plugins.find(
      (candidate) =>
        candidate.id === input.plugin.id &&
        resolve(candidate.absolutePluginRoot) === resolve(input.plugin.absolutePluginRoot) &&
        resolve(candidate.absoluteManifestPath) === resolve(input.plugin.absoluteManifestPath),
    );
    if (!plugin) {
      throw new Error(
        "Plugin authorization must use the server-discovered canonical plugin source.",
      );
    }
    if (!input.enabled) {
      await revokeApproval({
        cwd: input.cwd,
        pluginId: plugin.id,
        projectionAuthority: authority,
      });
      await notifyMossPluginApprovalChanged({
        cwd: input.cwd,
        pluginId: plugin.id,
        enabled: false,
        projectionAuthority: authority,
      });
      return { approved: false };
    }
    if (!plugin.enabled || !plugin.validation.ok) {
      throw new Error("Plugin validation or enabled policy blocks server authorization.");
    }
    if (plugin.marketplacePolicy.installation === "NOT_AVAILABLE") {
      throw new Error("Plugin marketplace policy does not permit server authorization.");
    }
    const componentIds = executableComponentIds(plugin);
    if (componentIds.length === 0) {
      throw new Error("Plugin has no enabled executable components to authorize.");
    }
    // Discovery/validation is read-only; the final check gates the issuer.
    requireProjectionAuthority(authority);
    const approval = await issuer.approve({
      cwd: input.cwd,
      plugin,
      componentIds,
    });
    return { approved: true, expiresAt: approval.expiresAt };
  };
  const revoke = async (input: {
    readonly cwd: string;
    readonly pluginId: string;
    readonly projectionAuthority?: MossPluginProjectionAuthorityScope | undefined;
  }) => {
    const authority = requireProjectionAuthority(input.projectionAuthority);
    const receipt = await revokeApproval(input);
    await notifyMossPluginApprovalChanged({
      ...input,
      enabled: false,
      projectionAuthority: authority,
    });
    return receipt;
  };
  const unregisterInternalApprovalChangeListener = subscribeMossPluginApprovalChanges(
    async (change) => {
      try {
        if (!change.enabled) {
          await revokeApproval(change);
        } else {
          const runtime = await discoverMossPluginRuntime({ cwd: change.cwd });
          const plugin = runtime.plugins.find((candidate) => candidate.id === change.pluginId);
          if (!plugin) {
            await revokeApproval(change);
            await notifyMossPluginApprovalChanged({ ...change, enabled: false });
          } else {
            try {
              await authorize({
                cwd: change.cwd,
                plugin,
                enabled: true,
                ...(change.projectionAuthority
                  ? { projectionAuthority: change.projectionAuthority }
                  : {}),
              });
            } catch {
              // A changed or invalid manifest must not retain the previous
              // approval. Revoke directly so the invalidation path cannot
              // recurse through the public notification bus.
              await revokeApproval(change);
              await notifyMossPluginApprovalChanged({ ...change, enabled: false });
            }
          }
        }
      } catch {
        // Resource mutation is fail-closed: if the changed source cannot be
        // rediscovered, its previous approval is revoked without exposing the
        // issuer to workspace/plugin callers.
        await revokeApproval(change).catch(() => undefined);
        if (change.enabled) {
          await notifyMossPluginApprovalChanged({ ...change, enabled: false }).catch(
            () => undefined,
          );
        }
      }
    },
  );
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unregisterInternalApprovalChangeListener();
  };
  return Object.freeze({
    store,
    authorize,
    revoke,
    registerApprovalChangeListener: subscribeMossPluginApprovalChanges,
    dispose,
  });
}
