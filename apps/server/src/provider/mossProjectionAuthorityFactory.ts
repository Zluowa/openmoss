import { createHash, randomUUID } from "node:crypto";
import { relative, resolve as resolvePath, sep } from "node:path";

import { Effect, Layer, ServiceMap } from "effect";

import { ServerConfig } from "../config.ts";
import {
  makeMossCanonicalResourceAuthority,
  type MossCanonicalResourceAuthority,
} from "./mossCanonicalResourceAuthority.ts";
import { makeMossProjectionOwnershipAdapter } from "@synara/shared/mossProjectionOwnershipAdapter";
import type { MossProjectionOwnershipStore } from "@synara/shared/mossProjectionMaterializer";

const RESOURCE_IMPORT_STATE_DIR_NAME = "resource-import";

export interface MossProjectionWorkspaceBinding {
  readonly id: string;
  /** Owner identity returned by the server workspace registry. */
  readonly ownerId: string;
  readonly workspaceRoot: string;
  readonly projectId: string;
}

export interface MossProjectionConnectionBinding {
  readonly connectionId: string;
  readonly principalId: string;
  readonly sessionId: string;
  /** Optional server-auth expiry; expired bindings are revoked on first use. */
  readonly expiresAt?: number;
}

export interface MossProjectionAuthorityContext {
  readonly registeredWorkspaceId: string;
  readonly connectionId: string;
  readonly sessionId: string;
}

/** Server-provided context for approval/discovery operations. */
export const CurrentMossProjectionAuthorityContext = ServiceMap.Reference<
  MossProjectionAuthorityContext | undefined
>("moss/provider/CurrentProjectionAuthorityContext", {
  defaultValue: () => undefined,
});

export type MossProjectionAuthorityErrorCode =
  | "stale-handle"
  | "connection-expired"
  | "workspace-unregistered";

/** A factory-issued handle is unusable after its server binding is revoked. */
export class MossProjectionAuthorityError extends Error {
  readonly code: MossProjectionAuthorityErrorCode;

  constructor(code: MossProjectionAuthorityErrorCode, message: string) {
    super(message);
    this.name = "MossProjectionAuthorityError";
    this.code = code;
  }
}

export interface MossProjectionAuthorityHandle {
  /** The shared #116 store-backed adapter for this workspace/connection. */
  readonly ownershipStore: MossProjectionOwnershipStore;
  readonly ownerId: string;
  readonly generation: string;
  readonly workspace: MossProjectionWorkspaceBinding;
  readonly connection: MossProjectionConnectionBinding;
  readonly canonicalAuthority: MossCanonicalResourceAuthority;
  /** Factory-owned liveness check required immediately before every mutation. */
  readonly assertLive: () => void;
  /** Monotonic factory epoch captured by this handle. */
  readonly epoch: number;
  /** Opaque factory-owned revocation token captured by this handle. */
  readonly revocationToken: string;
}

export interface MossProjectionAuthorityFactory {
  /**
   * Resolve only a server-registered workspace and a live server connection.
   * No caller-supplied actor, root, or store is accepted here.
   */
  readonly resolve: (
    input: MossProjectionAuthorityContext,
  ) => Promise<MossProjectionAuthorityHandle | undefined>;
  /**
   * Register only a workspace result returned by the server authorization
   * registry. Wire clients cannot call this method.
   */
  readonly registerWorkspace: (workspace: MossProjectionWorkspaceBinding) => void;
  readonly unregisterWorkspace: (input: { readonly id: string; readonly ownerId?: string }) => void;
  /** Bind a server-known connection to its authenticated session principal. */
  readonly bindConnection: (input: MossProjectionConnectionBinding) => void;
  /** Drop all connection/thread authority cached for a closed session. */
  readonly unbindSession: (sessionId: string) => void;
  /**
   * Bind a thread to the connection that accepted its command. ProviderService
   * uses this durable-in-process binding after orchestration dispatch; it never
   * guesses a connection from cwd or creates a global workspace authority.
   */
  readonly bindThread: (input: {
    readonly threadId: string;
    readonly context: MossProjectionAuthorityContext;
    readonly workspace: MossProjectionWorkspaceBinding;
  }) => void;
  readonly resolveForThread: (input: {
    readonly threadId: string;
    readonly projectPath: string;
  }) => Promise<MossProjectionAuthorityHandle | undefined>;
}

export interface MossProjectionAuthorityFactoryOptions {
  readonly stateDir: string;
  /** Test/embedding clock; production uses the process clock. */
  readonly now?: () => number;
  /** Optional live registry resolver. When omitted, explicit registry bindings
   * are the only source of workspace root/owner/project identity. */
  readonly resolveWorkspace?: (
    registeredWorkspaceId: string,
    principalId: string,
  ) => Promise<MossProjectionWorkspaceBinding | undefined>;
}

function nonEmpty(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function authorityGeneration(stateDir: string, workspace: MossProjectionWorkspaceBinding): string {
  return `projection-${createHash("sha256")
    .update(
      `${stateDir}\0${workspace.id}\0${workspace.ownerId}\0${workspace.projectId}\0${resolvePath(workspace.workspaceRoot)}`,
    )
    .digest("hex")}`;
}

function workspaceAuthorityStateDir(
  stateDir: string,
  workspace: MossProjectionWorkspaceBinding,
): string {
  const workspaceNamespace = createHash("sha256")
    .update(
      `${workspace.id}\0${workspace.ownerId}\0${workspace.projectId}\0${resolvePath(workspace.workspaceRoot)}`,
    )
    .digest("hex");
  // Keep the namespace directly below the prepared server state directory so
  // the ownership store can safely create the leaf on first use. No workspace
  // path or `.moss` directory is ever used as a parent.
  return `${stateDir}/${RESOURCE_IMPORT_STATE_DIR_NAME}-${workspaceNamespace}`;
}

function sameWorkspaceBinding(
  left: MossProjectionWorkspaceBinding,
  right: MossProjectionWorkspaceBinding,
): boolean {
  return (
    left.id === right.id &&
    left.ownerId === right.ownerId &&
    left.projectId === right.projectId &&
    resolvePath(left.workspaceRoot) === resolvePath(right.workspaceRoot)
  );
}

function sameWorkspacePath(left: string, right: string): boolean {
  const root = resolvePath(left);
  const candidate = resolvePath(right);
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !child.startsWith(sep));
}

interface MossProjectionAuthorityLiveness {
  readonly epoch: number;
  readonly revocationToken: string;
  readonly assertLive: () => void;
}

/**
 * Keep the server-owned canonical authority private behind a per-handle
 * revocation facade. The check lives inside the returned method, so a method
 * captured while the handle was live still re-checks the same epoch when it is
 * eventually invoked.
 */
function makeLivenessBoundFacade<T extends object>(
  target: T,
  liveness: MossProjectionAuthorityLiveness,
): T {
  return new Proxy(target, {
    get(innerTarget, property, receiver) {
      const value = Reflect.get(innerTarget, property, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        liveness.assertLive();
        return Reflect.apply(value, innerTarget, args);
      };
    },
  });
}

export function makeMossProjectionAuthorityFactory(
  options: MossProjectionAuthorityFactoryOptions,
): MossProjectionAuthorityFactory {
  const stateDir = nonEmpty(options.stateDir);
  if (!stateDir) throw new Error("A server-owned Moss authority state directory is required.");
  const now = options.now ?? Date.now;
  const connections = new Map<string, MossProjectionConnectionBinding>();
  const threads = new Map<string, MossProjectionAuthorityContext>();
  const handles = new Map<string, MossProjectionAuthorityHandle>();
  type AuthorityBindingState = {
    readonly key: string;
    readonly connectionId: string;
    readonly sessionId: string;
    readonly principalId: string;
    readonly workspace: MossProjectionWorkspaceBinding;
    readonly epoch: number;
    readonly revocationToken: string;
    handle?: MossProjectionAuthorityHandle;
    revoked: boolean;
  };
  const bindingStates = new Map<string, AuthorityBindingState>();
  const authorities = new Map<string, MossCanonicalResourceAuthority>();
  const registeredWorkspaces = new Map<string, MossProjectionWorkspaceBinding>();
  let nextEpoch = 0;

  const workspaceKey = (workspaceId: string, ownerId: string) => `${workspaceId}\0${ownerId}`;
  const authorityKey = (workspace: MossProjectionWorkspaceBinding) =>
    `${workspaceKey(workspace.id, workspace.ownerId)}\0${workspace.projectId}\0${resolvePath(workspace.workspaceRoot)}`;

  const revokeState = (state: AuthorityBindingState): void => {
    state.revoked = true;
    if (bindingStates.get(state.key) === state) bindingStates.delete(state.key);
    if (handles.get(state.key) === state.handle) handles.delete(state.key);
  };

  const revokeWhere = (predicate: (state: AuthorityBindingState) => boolean): void => {
    for (const state of [...bindingStates.values()]) {
      if (predicate(state)) revokeState(state);
    }
  };

  const expireConnectionIfNeeded = (connection: MossProjectionConnectionBinding): boolean => {
    if (connection.expiresAt === undefined) return false;
    if (!Number.isFinite(connection.expiresAt) || connection.expiresAt > now()) return false;
    revokeWhere((state) => state.connectionId === connection.connectionId);
    if (connections.get(connection.connectionId) === connection) {
      connections.delete(connection.connectionId);
    }
    for (const [threadId, context] of threads) {
      if (context.connectionId === connection.connectionId) threads.delete(threadId);
    }
    return true;
  };

  const assertBindingLive = (state: AuthorityBindingState): void => {
    if (state.revoked || bindingStates.get(state.key) !== state) {
      throw new MossProjectionAuthorityError(
        "stale-handle",
        "The Moss projection authority handle is stale or has been revoked.",
      );
    }
    const connection = connections.get(state.connectionId);
    if (
      !connection ||
      connection.sessionId !== state.sessionId ||
      connection.principalId !== state.principalId
    ) {
      revokeState(state);
      throw new MossProjectionAuthorityError(
        "stale-handle",
        "The Moss projection authority connection binding was replaced.",
      );
    }
    if (expireConnectionIfNeeded(connection)) {
      revokeState(state);
      throw new MossProjectionAuthorityError(
        "connection-expired",
        "The Moss projection authority connection has expired.",
      );
    }
    const registered = registeredWorkspaces.get(
      workspaceKey(state.workspace.id, state.workspace.ownerId),
    );
    if (
      !options.resolveWorkspace &&
      (!registered || !sameWorkspaceBinding(registered, state.workspace))
    ) {
      revokeState(state);
      throw new MossProjectionAuthorityError(
        "workspace-unregistered",
        "The Moss projection authority workspace binding was replaced.",
      );
    }
  };

  const resolve: MossProjectionAuthorityFactory["resolve"] = async (input) => {
    const registeredWorkspaceId = nonEmpty(input.registeredWorkspaceId);
    const connectionId = nonEmpty(input.connectionId);
    const sessionId = nonEmpty(input.sessionId);
    if (!registeredWorkspaceId || !connectionId || !sessionId) return undefined;
    const connection = connections.get(connectionId);
    if (!connection || connection.sessionId !== sessionId) return undefined;
    if (expireConnectionIfNeeded(connection)) return undefined;
    const workspace = options.resolveWorkspace
      ? await options.resolveWorkspace(registeredWorkspaceId, connection.principalId)
      : registeredWorkspaces.get(workspaceKey(registeredWorkspaceId, connection.principalId));
    if (
      !workspace ||
      workspace.id !== registeredWorkspaceId ||
      workspace.ownerId !== connection.principalId
    ) {
      return undefined;
    }
    const key = `${stateDir}\0${registeredWorkspaceId}\0${connectionId}\0${sessionId}`;
    const cached = handles.get(key);
    if (cached && sameWorkspaceBinding(cached.workspace, workspace)) {
      try {
        cached.assertLive();
        return cached;
      } catch {
        handles.delete(key);
      }
    }
    const cachedState = bindingStates.get(key);
    if (cachedState) revokeState(cachedState);
    const rawCanonicalAuthority =
      authorities.get(authorityKey(workspace)) ??
      makeMossCanonicalResourceAuthority({
        stateDir: workspaceAuthorityStateDir(stateDir, workspace),
      });
    authorities.set(authorityKey(workspace), rawCanonicalAuthority);
    const state: AuthorityBindingState = {
      key,
      connectionId,
      sessionId,
      principalId: connection.principalId,
      workspace,
      epoch: ++nextEpoch,
      revocationToken: randomUUID(),
      revoked: false,
    };
    const liveness: MossProjectionAuthorityLiveness = {
      epoch: state.epoch,
      revocationToken: state.revocationToken,
      assertLive: () => assertBindingLive(state),
    };
    const canonicalAuthority: MossCanonicalResourceAuthority = {
      ownershipStore: makeLivenessBoundFacade(rawCanonicalAuthority.ownershipStore, liveness),
      filesystemCapability: makeLivenessBoundFacade(
        rawCanonicalAuthority.filesystemCapability,
        liveness,
      ),
      stateDir: rawCanonicalAuthority.stateDir,
    };
    const handle: MossProjectionAuthorityHandle = {
      ownershipStore: makeMossProjectionOwnershipAdapter({
        ownershipStore: canonicalAuthority.ownershipStore,
        filesystemCapability: canonicalAuthority.filesystemCapability,
        assertLive: liveness.assertLive,
        authority: {
          ownerId: connection.principalId,
          projectId: workspace.projectId,
          workspaceId: workspace.id,
          principalId: connection.principalId,
          sessionId: connection.sessionId,
          stateFingerprint: createHash("sha256")
            .update(
              `${stateDir}\0${workspace.id}\0${workspace.projectId}\0${resolvePath(workspace.workspaceRoot)}`,
            )
            .digest("hex"),
        },
      }),
      ownerId: connection.principalId,
      generation: authorityGeneration(stateDir, workspace),
      workspace,
      connection,
      canonicalAuthority,
      assertLive: liveness.assertLive,
      epoch: liveness.epoch,
      revocationToken: liveness.revocationToken,
    };
    state.handle = handle;
    bindingStates.set(key, state);
    handles.set(key, handle);
    try {
      handle.assertLive();
    } catch {
      revokeState(state);
      return undefined;
    }
    return handle;
  };

  return {
    resolve,
    registerWorkspace: (workspace) => {
      const id = nonEmpty(workspace.id);
      const ownerId = nonEmpty(workspace.ownerId);
      const projectId = nonEmpty(workspace.projectId);
      const workspaceRoot = nonEmpty(workspace.workspaceRoot);
      if (!id || !ownerId || !projectId || !workspaceRoot) return;
      const normalized = {
        id,
        ownerId,
        projectId,
        workspaceRoot: resolvePath(workspaceRoot),
      };
      const key = workspaceKey(id, ownerId);
      const previous = registeredWorkspaces.get(key);
      if (previous && !sameWorkspaceBinding(previous, normalized)) {
        revokeWhere((state) => state.workspace.id === id && state.workspace.ownerId === ownerId);
      }
      registeredWorkspaces.set(key, normalized);
    },
    unregisterWorkspace: ({ id, ownerId }) => {
      const workspaceId = nonEmpty(id);
      const principalId = ownerId === undefined ? undefined : nonEmpty(ownerId);
      if (!workspaceId || (ownerId !== undefined && !principalId)) return;
      const workspacePrefix = `${workspaceId}\0`;
      for (const key of registeredWorkspaces.keys()) {
        if (
          key.startsWith(workspacePrefix) &&
          (principalId === undefined || key === workspaceKey(workspaceId, principalId))
        ) {
          registeredWorkspaces.delete(key);
        }
      }
      const authorityPrefix = workspacePrefix;
      for (const key of authorities.keys()) {
        if (key.startsWith(authorityPrefix)) authorities.delete(key);
      }
      revokeWhere(
        (state) =>
          state.workspace.id === workspaceId &&
          (principalId === undefined || state.workspace.ownerId === principalId),
      );
    },
    bindConnection: (input) => {
      const connectionId = nonEmpty(input.connectionId);
      const principalId = nonEmpty(input.principalId);
      const sessionId = nonEmpty(input.sessionId);
      if (!connectionId || !principalId || !sessionId) return;
      if (input.expiresAt !== undefined && !Number.isFinite(input.expiresAt)) return;
      const previous = connections.get(connectionId);
      if (
        previous &&
        previous.principalId === principalId &&
        previous.sessionId === sessionId &&
        previous.expiresAt === input.expiresAt
      ) {
        return;
      }
      if (previous) {
        revokeWhere((state) => state.connectionId === connectionId);
        for (const [threadId, context] of threads) {
          if (context.connectionId === connectionId) threads.delete(threadId);
        }
      }
      connections.set(connectionId, {
        connectionId,
        principalId,
        sessionId,
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      });
    },
    unbindSession: (sessionId) => {
      const normalizedSessionId = nonEmpty(sessionId);
      if (!normalizedSessionId) return;
      for (const [connectionId, connection] of connections) {
        if (connection.sessionId === normalizedSessionId) {
          revokeWhere((state) => state.connectionId === connectionId);
          connections.delete(connectionId);
        }
      }
      for (const [threadId, context] of threads) {
        if (context.sessionId === normalizedSessionId) threads.delete(threadId);
      }
    },
    bindThread: (input) => {
      const threadId = nonEmpty(input.threadId);
      if (!threadId) return;
      threads.set(threadId, input.context);
    },
    resolveForThread: async ({ threadId, projectPath }) => {
      const context = threads.get(threadId);
      if (!context) return undefined;
      const handle = await resolve(context);
      if (!handle || !sameWorkspacePath(handle.workspace.workspaceRoot, projectPath)) {
        return undefined;
      }
      handle.assertLive();
      return handle;
    },
  };
}

export const MossProjectionAuthorityFactoryService = ServiceMap.Reference<
  MossProjectionAuthorityFactory | undefined
>("moss/provider/MossProjectionAuthorityFactory", {
  defaultValue: () => undefined,
});

/** Production graph seam. Failure is intentionally read-only, never a fallback store. */
export const MossProjectionAuthorityFactoryLive = Layer.effect(
  MossProjectionAuthorityFactoryService,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    try {
      return makeMossProjectionAuthorityFactory({
        stateDir: config.stateDir,
        // The WS admission path registers only results returned by the
        // server-owned workspace registry. Until then this remains read-only;
        // it never infers a workspace from cwd or a provider read model.
      });
    } catch {
      return undefined;
    }
  }),
);
