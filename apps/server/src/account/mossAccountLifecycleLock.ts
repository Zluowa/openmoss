import { createHash, randomUUID } from "node:crypto";

import { Effect } from "effect";
import * as Semaphore from "effect/Semaphore";

import type { ServerSecretStoreShape } from "../auth/Services/ServerSecretStore";
import {
  isMossManagedGatewayAuthority,
  type MossManagedGatewayAuthority,
} from "../provider/mossManagedGatewayTrust";
import type { ServerSettingsShape } from "../serverSettings";
import type { MossManagedProviderShape } from "./Services/MossManagedProvider";

/**
 * Account providers replace the provider-instance map when they commit a
 * lifecycle transition. Bind one process-local mutex to the shared settings
 * authority so a BYOK snapshot cannot overwrite a newer managed-account fence
 * (or vice versa).
 */
const accountLifecycleLocks = new WeakMap<ServerSettingsShape, Semaphore.Semaphore>();

// Share the local-read fence across reconstructed services and both realms.
// Network validation alone does not fence a verified owner; explicit account
// mutations fence before waiting for the lifecycle permit and advance a revision.
const localAuthorityTransitions = new WeakMap<
  ServerSecretStoreShape,
  { pending: number; revision: number }
>();

export function readMossLocalAuthorityRevision(secretStore: ServerSecretStoreShape): number | null {
  const state = localAuthorityTransitions.get(secretStore);
  return state?.pending ? null : (state?.revision ?? 0);
}

export function withMossLocalAuthorityTransition<A, E, R>(
  secretStore: ServerSecretStoreShape,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      let state = localAuthorityTransitions.get(secretStore);
      if (!state) {
        state = { pending: 0, revision: 0 };
        localAuthorityTransitions.set(secretStore, state);
      }
      state.pending += 1;
      state.revision += 1;
      return state;
    }),
    () => effect,
    (state) =>
      Effect.sync(() => {
        state.pending -= 1;
        state.revision += 1;
      }),
  );
}

function accountLifecycleLockFor(settingsService: ServerSettingsShape): Semaphore.Semaphore {
  const existing = accountLifecycleLocks.get(settingsService);
  if (existing) return existing;

  const created = Semaphore.makeUnsafe(1);
  accountLifecycleLocks.set(settingsService, created);
  return created;
}

export function withMossAccountLifecycleLock<A, E, R>(
  settingsService: ServerSettingsShape,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return accountLifecycleLockFor(settingsService).withPermits(1)(effect);
}

export type MossManagedBinding = {
  readonly authority: MossManagedGatewayAuthority;
  readonly version: number;
  readonly bindingId: string;
  readonly accessToken: string;
};

export type MossManagedReconcileState =
  | "current"
  | "same-authority-stale"
  | "owned-by-other"
  | "missing"
  | "collision";

type StoredBinding = {
  readonly version: number;
  readonly state: "active" | "pending";
  readonly authority: MossManagedGatewayAuthority;
  readonly bindingId: string;
  readonly accessTokenHash: string;
  readonly previous?: {
    readonly authority: MossManagedGatewayAuthority;
    readonly version: number;
    readonly bindingId: string;
    readonly accessTokenHash: string;
  };
};

type MossManagedProvisionInput = Omit<
  Parameters<MossManagedProviderShape["provision"]>[0],
  "cleanupAccessTokenHash" | "recoverStalePairedGeneration"
>;
type MossManagedBindingExpectation = {
  readonly authority: MossManagedGatewayAuthority;
  readonly version?: number;
  readonly bindingId?: string;
  readonly accessToken?: string;
};

export interface MossManagedProviderCoordinatorShape {
  /** Read durable selection without reconciling providers or routing a bearer. */
  readonly getLocalActiveAuthority: () => Effect.Effect<
    MossManagedGatewayAuthority | null,
    unknown
  >;
  readonly provision: (
    input: MossManagedProvisionInput,
  ) => Effect.Effect<MossManagedBinding, unknown>;
  readonly release: (input: {
    readonly authority: MossManagedGatewayAuthority;
    readonly expected?: MossManagedBindingExpectation;
    /** Explicit logout and confirmed remote revocation may fence this realm's current binding. */
    readonly force?: boolean;
    /**
     * `true` means this authority no longer owns an unfenced managed surface.
     * It can therefore also mean that another authority owns the active
     * binding and no mutation was required.
     */
  }) => Effect.Effect<boolean, unknown>;
  readonly getReconcileState: (input: {
    readonly authority: MossManagedGatewayAuthority;
    readonly accessToken: string;
    readonly gatewayBaseUrl: string;
  }) => Effect.Effect<MossManagedReconcileState, unknown>;
}

const MOSS_MANAGED_BINDING_SECRET_NAME = "moss.managed.binding";
const bindingEncoder = new TextEncoder();
const bindingDecoder = new TextDecoder();

const managedProviderCoordinators = new WeakMap<
  ServerSecretStoreShape,
  MossManagedProviderCoordinatorShape
>();

const accessTokenHash = (accessToken: string): string =>
  createHash("sha256").update(accessToken).digest("hex");

const recoveryProof = (input: {
  readonly authority: MossManagedGatewayAuthority;
  readonly accessTokenHash: string;
  readonly gatewayBaseUrl: string;
}): string =>
  createHash("sha256")
    .update(`${input.authority}\0${input.accessTokenHash}\0${input.gatewayBaseUrl}`)
    .digest("hex");

const parseStoredBinding = (bytes: Uint8Array): StoredBinding | null => {
  try {
    const value: unknown = JSON.parse(bindingDecoder.decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
      typeof record.version !== "number" ||
      !Number.isSafeInteger(record.version) ||
      record.version <= 0 ||
      (record.state !== "active" && record.state !== "pending") ||
      !isMossManagedGatewayAuthority(record.authority) ||
      typeof record.bindingId !== "string" ||
      record.bindingId.length === 0 ||
      typeof record.accessTokenHash !== "string" ||
      record.accessTokenHash.length !== 64
    ) {
      return null;
    }
    const previous =
      record.previous && typeof record.previous === "object"
        ? (record.previous as NonNullable<StoredBinding["previous"]>)
        : null;
    return {
      version: record.version,
      state: record.state,
      authority: record.authority,
      bindingId: record.bindingId,
      accessTokenHash: record.accessTokenHash,
      ...(previous ? { previous } : {}),
    };
  } catch {
    return null;
  }
};

function makeCoordinator(
  secretStore: ServerSecretStoreShape,
  managedProvider: MossManagedProviderShape,
): MossManagedProviderCoordinatorShape {
  const semaphore = Semaphore.makeUnsafe(1);
  let current: StoredBinding | null = null;
  let nextVersion = 0;
  let recoverableStaleProof: string | null = null;

  const readCurrent = () =>
    secretStore.get(MOSS_MANAGED_BINDING_SECRET_NAME).pipe(
      Effect.map((bytes) => {
        const persisted = bytes ? parseStoredBinding(bytes) : null;
        if (persisted) {
          current = persisted;
          nextVersion = Math.max(nextVersion, persisted.version);
        }
        return persisted ?? current;
      }),
    );

  const persist = (binding: StoredBinding) =>
    secretStore.set(
      MOSS_MANAGED_BINDING_SECRET_NAME,
      bindingEncoder.encode(JSON.stringify(binding)),
    );

  const clear = () => secretStore.remove(MOSS_MANAGED_BINDING_SECRET_NAME);

  const provision = (input: MossManagedProvisionInput) =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        const previous = yield* readCurrent();
        const previousOwner =
          previous?.state === "active"
            ? {
                authority: previous.authority,
                version: previous.version,
                bindingId: previous.bindingId,
                accessTokenHash: previous.accessTokenHash,
              }
            : previous?.previous;
        const version = Math.max(nextVersion, previous?.version ?? 0) + 1;
        nextVersion = version;
        const bindingId = randomUUID();
        const pending: StoredBinding = {
          version,
          state: "pending",
          authority: input.authority,
          bindingId,
          accessTokenHash: accessTokenHash(input.accessToken),
          ...(previousOwner ? { previous: previousOwner } : {}),
        };
        // A pending record is never treated as a live owner. It fences stale
        // releases across a crash while the provider transition is in flight.
        current = pending;
        yield* persist(current);

        const incomingAccessTokenHash = accessTokenHash(input.accessToken);
        const previousAccessTokenHash = previousOwner?.accessTokenHash;
        const recoverStalePairedGeneration =
          previousOwner?.authority === input.authority &&
          recoverableStaleProof ===
            recoveryProof({
              authority: input.authority,
              accessTokenHash: incomingAccessTokenHash,
              gatewayBaseUrl: input.gatewayBaseUrl,
            });
        recoverableStaleProof = null;
        const cleanupAccessTokenHash =
          previousAccessTokenHash && previousAccessTokenHash !== incomingAccessTokenHash
            ? previousAccessTokenHash
            : undefined;
        const provisioned = yield* managedProvider
          .provision({
            authority: input.authority,
            accessToken: input.accessToken,
            gatewayBaseUrl: input.gatewayBaseUrl,
            ...(input.models ? { models: input.models } : {}),
            ...(cleanupAccessTokenHash ? { cleanupAccessTokenHash } : {}),
            ...(recoverStalePairedGeneration ? { recoverStalePairedGeneration: true } : {}),
            selectionPolicy: input.selectionPolicy,
          })
          .pipe(
            Effect.map(() => ({ ok: true as const })),
            Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
          );
        if (!provisioned.ok) {
          // Preserve the last confirmed owner proof across same- or
          // cross-realm crash retries. The pending generation is never treated
          // as live, but its `previous` hash lets the next attempt fence the
          // exact credential-bearing surface without retaining the raw token.
          current = pending.previous ? pending : null;
          yield* (current ? persist(current) : clear()).pipe(Effect.ignore);
          return yield* Effect.fail(provisioned.error);
        }

        const active: StoredBinding = {
          version,
          state: "active",
          authority: input.authority,
          bindingId,
          accessTokenHash: accessTokenHash(input.accessToken),
        };
        current = active;
        const activeReceipt = yield* persist(current).pipe(
          Effect.map(() => ({ ok: true as const })),
          Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
        );
        if (!activeReceipt.ok) {
          // The provider surfaces may already carry the incoming bearer. A
          // failed active receipt must never leave those surfaces runnable
          // without durable ownership proof. Keep the previously persisted
          // pending fence for crash recovery and make a best-effort immediate
          // shutdown before reporting the persistence failure.
          current = pending;
          yield* managedProvider
            .disable({ expectedAccessToken: input.accessToken })
            .pipe(Effect.ignore);
          return yield* Effect.fail(activeReceipt.error);
        }
        return {
          authority: input.authority,
          version,
          bindingId,
          accessToken: input.accessToken,
        } satisfies MossManagedBinding;
      }),
    );

  const release = (input: {
    readonly authority: MossManagedGatewayAuthority;
    readonly expected?: MossManagedBindingExpectation;
    readonly force?: boolean;
  }) =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        recoverableStaleProof = null;
        const stored = yield* readCurrent();
        if (!stored) {
          const needsDisable = yield* managedProvider.needsDisable();
          if (!needsDisable) return true;
          // Without a durable authority receipt, an unscoped force fence could
          // tear down the other realm. Legacy cleanup is therefore permitted
          // only when the caller still has the exact bearer proof.
          if (input.expected?.accessToken === undefined) return false;
          yield* managedProvider.disable({ expectedAccessToken: input.expected.accessToken });
          return true;
        }
        if (stored.state === "pending") {
          const belongsToAuthority =
            stored.authority === input.authority || stored.previous?.authority === input.authority;
          if (!belongsToAuthority) {
            // Another realm owns every generation represented by this fence.
            // This caller is already released and must not mutate it.
            return true;
          }
          const expected = input.expected;
          if (
            expected?.accessToken !== undefined &&
            accessTokenHash(expected.accessToken) !== stored.accessTokenHash &&
            accessTokenHash(expected.accessToken) !== stored.previous?.accessTokenHash &&
            !input.force
          ) {
            return false;
          }
          // A pending receipt is deliberately ambiguous: provider mutation may
          // have succeeded even though the active receipt did not. Explicit
          // cleanup for either represented owner must fence the shared surface.
          yield* input.force && expected?.accessToken !== undefined
            ? managedProvider.disable({ cleanupFallbackAccessToken: expected.accessToken })
            : managedProvider.disable();
          current = null;
          yield* clear();
          return true;
        }
        if (stored.authority !== input.authority) {
          // The requested authority has no live surface to release.
          return true;
        }
        const expected = input.expected;
        if (expected && !input.force) {
          if (
            expected.authority !== stored.authority ||
            (expected.version !== undefined && expected.version !== stored.version) ||
            (expected.bindingId !== undefined && expected.bindingId !== stored.bindingId) ||
            (expected.accessToken !== undefined &&
              accessTokenHash(expected.accessToken) !== stored.accessTokenHash)
          ) {
            return false;
          }
        } else if (!input.force) {
          return false;
        }
        yield* !input.force && input.expected?.accessToken !== undefined
          ? managedProvider.disable({ expectedAccessToken: input.expected.accessToken })
          : input.force && input.expected?.accessToken !== undefined
            ? managedProvider.disable({
                cleanupFallbackAccessToken: input.expected.accessToken,
              })
            : managedProvider.disable();
        current = null;
        yield* clear();
        return true;
      }),
    );

  const getReconcileState = (input: {
    readonly authority: MossManagedGatewayAuthority;
    readonly accessToken: string;
    readonly gatewayBaseUrl: string;
  }) =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        recoverableStaleProof = null;
        const stored = yield* readCurrent();
        if (!stored) {
          return (yield* managedProvider.getProvisioningState(input)) === "collision"
            ? "collision"
            : "missing";
        }

        if (stored.state === "active" && stored.authority !== input.authority) {
          return "owned-by-other";
        }
        if (stored.state === "pending") {
          if (stored.previous) {
            // A failed cross-realm claim has exactly one automatic recovery
            // owner: the last confirmed binding. The pending target may retry
            // only through an explicit select/claim, which bypasses this
            // background reconciliation path.
            if (stored.previous.authority !== input.authority) return "owned-by-other";
          } else if (stored.authority !== input.authority) {
            return "owned-by-other";
          }
        }

        const provisioningState = yield* managedProvider.getProvisioningState(input);
        const representedOwner =
          stored.state === "active"
            ? stored
            : stored.previous?.authority === input.authority
              ? stored.previous
              : undefined;
        const inputAccessTokenHash = accessTokenHash(input.accessToken);
        if (
          provisioningState === "recoverable-stale" &&
          representedOwner?.authority === input.authority
        ) {
          // A valid account session may rotate its bearer while the previous
          // managed generation is still fenced (for example after a restart
          // or refresh-token exchange). The durable binding proves authority
          // ownership; the provider's recoverable-stale result proves the
          // exact paired server-owned surfaces. Keep the current token hash in
          // the one-shot proof so the next provision fences the old bearer
          // without ever persisting it in the coordinator receipt.
          recoverableStaleProof = recoveryProof({
            authority: input.authority,
            accessTokenHash: inputAccessTokenHash,
            gatewayBaseUrl: input.gatewayBaseUrl,
          });
          return "same-authority-stale";
        }
        recoverableStaleProof = null;
        if (provisioningState === "collision") return "collision";
        if (
          stored.state === "active" &&
          stored.accessTokenHash === accessTokenHash(input.accessToken) &&
          provisioningState === "ready"
        ) {
          return "current";
        }
        return "same-authority-stale";
      }),
    );

  const getLocalActiveAuthority = () =>
    Effect.gen(function* () {
      // Read the durable receipt directly. Provider work can hold the writer
      // permit across network/runtime operations; pending remains fail-closed.
      const bytes = yield* secretStore.get(MOSS_MANAGED_BINDING_SECRET_NAME);
      if (!bytes) return null;
      const stored = parseStoredBinding(bytes);
      // A pending or corrupt receipt cannot authorize a fallback account.
      // Do not use the process cache after a durable selection was removed.
      if (!stored || stored.state !== "active")
        return yield* Effect.fail(new Error("LOCAL_MANAGED_BINDING_UNAVAILABLE"));
      return stored.authority;
    });

  return { provision, release, getReconcileState, getLocalActiveAuthority };
}

export function makeMossManagedProviderCoordinator(
  secretStore: ServerSecretStoreShape,
  managedProvider: MossManagedProviderShape,
): MossManagedProviderCoordinatorShape {
  const existing = managedProviderCoordinators.get(secretStore);
  if (existing) return existing;
  const created = makeCoordinator(secretStore, managedProvider);
  managedProviderCoordinators.set(secretStore, created);
  return created;
}
