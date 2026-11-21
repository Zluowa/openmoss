// FILE: providerModelDiscoveryCache.ts
// Purpose: Provider-agnostic model catalog cache shared by every adapter's
//          listModels dispatch. Serves fresh entries instantly, serves stale
//          entries immediately while revalidating in the background, single-
//          flights concurrent discovery per key, applies a hard timeout ceiling,
//          and short-circuits repeated failures so UI retries cannot fan out
//          into CLI/ACP spawn storms.
// Layer: Server provider runtime
// Exports: makeProviderModelDiscoveryCache, ProviderModelDiscoveryCache,
//          providerModelDiscoveryCacheKey, PROVIDER_MODEL_DISCOVERY_* defaults

import type { ProviderListModelsInput, ProviderListModelsResult } from "@moss/contracts";
import { Deferred, Effect, Exit, Option } from "effect";

import { ProviderAdapterRequestError } from "./Errors.ts";

/** A successful catalog is served without touching the adapter for this long. */
export const PROVIDER_MODEL_DISCOVERY_FRESH_TTL_MS = 30 * 60_000;
const MANUAL_REFRESH_MIN_INTERVAL_MS = 60_000;
/**
 * After the fresh window a catalog is still served immediately (marked
 * `cached: true`) while a background revalidation runs. Entries older than
 * this are dropped so a long-uninstalled CLI does not haunt the picker forever.
 */
export const PROVIDER_MODEL_DISCOVERY_STALE_TTL_MS = 24 * 60 * 60_000;
/**
 * A failed or empty discovery is replayed for this long instead of re-spawning
 * the provider. This turns "retry 3 times with backoff" from four process
 * spawns into one.
 */
export const PROVIDER_MODEL_DISCOVERY_FAILURE_TTL_MS = 30_000;
/**
 * Degraded or error-tagged fallback catalogs (e.g. broken or unauthenticated CLI
 * returning a static fallback) cool down longer than transient errors so periodic
 * mobile/web refreshes do not thrash subprocess spawns every minute.
 */
export const PROVIDER_MODEL_DISCOVERY_DEGRADED_TTL_MS = 5 * 60_000;
/**
 * Hard ceiling on a single discovery run. Some adapters (Pi, OpenCode CLI) have
 * no internal timeout; this keeps every provider under the 60s WebSocket RPC
 * timeout so the client sees a real error instead of a transport timeout.
 */
export const PROVIDER_MODEL_DISCOVERY_TIMEOUT_MS = 45_000;
export const PROVIDER_MODEL_DISCOVERY_CACHE_MAX_ENTRIES = 64;

export interface ProviderModelDiscoveryCacheKey {
  readonly provider: ProviderListModelsInput["provider"];
  readonly instanceId: string | null;
  readonly binaryPath: string | null;
  readonly homePath: string | null;
  readonly shadowHomePath: string | null;
  readonly accountId: string | null;
  readonly apiEndpoint: string | null;
  readonly agentDir: string | null;
  readonly serverUrl: string | null;
  readonly serverPasswordKey: string | null;
  readonly experimentalWebSockets: boolean;
  readonly environmentKey: string | null;
  readonly cwd: string | null;
  /** Claude catalogs depend on the installed CLI version, even at the same path. */
  readonly runtimeVersion?: string | null;
  /**
   * Fingerprint of a provider's own config files (size + mtime). Editing the
   * config changes the key, so a renamed or added model is rediscovered instead
   * of being served from the fresh/stale windows. Only OpenCode-family providers
   * set this today.
   */
  readonly configFingerprint?: string | null;
}

function hashCacheComponent(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function environmentFingerprint(
  environment: Readonly<Record<string, string>> | undefined,
): string | null {
  if (!environment || Object.keys(environment).length === 0) {
    return null;
  }
  return JSON.stringify(
    Object.entries(environment)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => [name, hashCacheComponent(value)]),
  );
}

export interface ProviderModelDiscoveryLookupOptions {
  /** Override fresh window for a single lookup (e.g. shorter cadence for OMP). */
  readonly freshTtlMs?: number | undefined;
  /**
   * When true and the exact `cwd` key misses, reuse the freshest non-expired
   * catalog matching every other key dimension (for clients like mobile that
   * omit `cwd` and want to hit desktop's warm catalog).
   */
  readonly allowCwdFallback?: boolean | undefined;
}

export interface ProviderModelDiscoveryPeekResult {
  readonly result: ProviderListModelsResult;
  readonly storedAt: number;
  readonly stale: boolean;
}

export interface ProviderModelDiscoveryCache<E> {
  /**
   * Resolve a model catalog for `key`, running `discover` only when the cache
   * cannot answer. `discover` always runs detached from the caller so a
   * disconnecting client never aborts a discovery other callers wait on.
   */
  readonly lookup: (
    key: ProviderModelDiscoveryCacheKey,
    discover: Effect.Effect<ProviderListModelsResult, E>,
    refresh?: ProviderListModelsInput["refresh"],
    options?: ProviderModelDiscoveryLookupOptions,
  ) => Effect.Effect<ProviderListModelsResult, E | ProviderAdapterRequestError>;
  /**
   * Synchronous in-memory peek for the freshest non-expired catalog belonging
   * to `(provider, instanceId)` — zero I/O and zero subprocess spawns.
   */
  readonly peekBestForInstance: (
    provider: ProviderListModelsInput["provider"],
    instanceId: string | null,
    cwd?: string | null,
    freshTtlMs?: number,
  ) => ProviderModelDiscoveryPeekResult | undefined;
  /** Forget every entry (settings changes, tests). */
  readonly clear: () => void;
  /** Number of catalog entries currently retained (tests/diagnostics). */
  readonly size: () => number;
}

interface CatalogEntry {
  readonly key: ProviderModelDiscoveryCacheKey | null;
  readonly result: ProviderListModelsResult;
  readonly storedAt: number;
}

interface FailureEntry {
  readonly exit: Exit.Exit<ProviderListModelsResult, unknown>;
  readonly storedAt: number;
  readonly degraded: boolean;
}

type DiscoveryExit<E> = Exit.Exit<ProviderListModelsResult, E | ProviderAdapterRequestError>;

export function providerModelDiscoveryCacheKey(
  input: ProviderListModelsInput,
): ProviderModelDiscoveryCacheKey {
  return {
    provider: input.provider,
    instanceId: input.instanceId ?? null,
    binaryPath: input.binaryPath ?? null,
    homePath: input.homePath ?? null,
    shadowHomePath: input.shadowHomePath ?? null,
    accountId: input.accountId ?? null,
    apiEndpoint: input.apiEndpoint ?? null,
    agentDir: input.agentDir ?? null,
    serverUrl: input.serverUrl ?? null,
    serverPasswordKey: input.serverPassword ? hashCacheComponent(input.serverPassword) : null,
    experimentalWebSockets: input.experimentalWebSockets === true,
    environmentKey: environmentFingerprint(input.environment),
    cwd: input.cwd ?? null,
  };
}

/**
 * Stable serialization for a cache key. This is the on-disk contract for the
 * persisted catalog snapshot (providerModelCatalogCache.ts), so field order
 * here is a file format, not an implementation detail. Snapshots written with
 * an older field list simply miss and fall back to fresh discovery.
 */
export const serializeProviderModelDiscoveryCacheKey = (
  key: ProviderModelDiscoveryCacheKey,
): string =>
  JSON.stringify([
    key.provider,
    key.instanceId,
    key.binaryPath,
    key.homePath,
    key.shadowHomePath,
    key.accountId,
    key.apiEndpoint,
    key.agentDir,
    key.serverUrl,
    key.serverPasswordKey,
    key.experimentalWebSockets,
    key.environmentKey,
    key.cwd,
    ...(key.runtimeVersion !== undefined ? [key.runtimeVersion] : []),
    ...(key.configFingerprint !== undefined ? [key.configFingerprint] : []),
  ]);

const parseSerializedProviderModelDiscoveryCacheKey = (
  serialized: string,
): ProviderModelDiscoveryCacheKey | null => {
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (!Array.isArray(parsed) || parsed.length < 13 || typeof parsed[0] !== "string") {
      return null;
    }
    const provider = parsed[0] as ProviderListModelsInput["provider"];
    const base: ProviderModelDiscoveryCacheKey = {
      provider,
      instanceId: typeof parsed[1] === "string" ? parsed[1] : null,
      binaryPath: typeof parsed[2] === "string" ? parsed[2] : null,
      homePath: typeof parsed[3] === "string" ? parsed[3] : null,
      shadowHomePath: typeof parsed[4] === "string" ? parsed[4] : null,
      accountId: typeof parsed[5] === "string" ? parsed[5] : null,
      apiEndpoint: typeof parsed[6] === "string" ? parsed[6] : null,
      agentDir: typeof parsed[7] === "string" ? parsed[7] : null,
      serverUrl: typeof parsed[8] === "string" ? parsed[8] : null,
      serverPasswordKey: typeof parsed[9] === "string" ? parsed[9] : null,
      experimentalWebSockets: parsed[10] === true,
      environmentKey: typeof parsed[11] === "string" ? parsed[11] : null,
      cwd: typeof parsed[12] === "string" ? parsed[12] : null,
    };
    if (parsed.length === 14) {
      const tail = typeof parsed[13] === "string" ? parsed[13] : null;
      return provider === "opencode"
        ? { ...base, configFingerprint: tail }
        : { ...base, runtimeVersion: tail };
    }
    if (parsed.length >= 15) {
      return {
        ...base,
        runtimeVersion: typeof parsed[13] === "string" ? parsed[13] : null,
        configFingerprint: typeof parsed[14] === "string" ? parsed[14] : null,
      };
    }
    return base;
  } catch {
    return null;
  }
};

const matchesInstanceId = (
  provider: ProviderListModelsInput["provider"],
  left: string | null,
  right: string | null,
): boolean =>
  left === right || (left === null && right === provider) || (right === null && left === provider);

const matchesIgnoringCwd = (
  entryKey: ProviderModelDiscoveryCacheKey | null,
  target: ProviderModelDiscoveryCacheKey,
): boolean => {
  if (!entryKey) return false;
  return (
    entryKey.provider === target.provider &&
    matchesInstanceId(target.provider, entryKey.instanceId, target.instanceId) &&
    entryKey.binaryPath === target.binaryPath &&
    entryKey.homePath === target.homePath &&
    entryKey.shadowHomePath === target.shadowHomePath &&
    entryKey.accountId === target.accountId &&
    entryKey.apiEndpoint === target.apiEndpoint &&
    entryKey.agentDir === target.agentDir &&
    entryKey.serverUrl === target.serverUrl &&
    entryKey.serverPasswordKey === target.serverPasswordKey &&
    entryKey.experimentalWebSockets === target.experimentalWebSockets &&
    entryKey.environmentKey === target.environmentKey &&
    (entryKey.runtimeVersion ?? null) === (target.runtimeVersion ?? null) &&
    (entryKey.configFingerprint ?? null) === (target.configFingerprint ?? null)
  );
};

/**
 * Only a complete, non-empty, error-free catalog is worth remembering as "good".
 * Partial catalogs, static fallbacks that carry `error`, and empty lists are
 * replayed briefly as failures so the next real attempt is not delayed by the
 * fresh window.
 */
const isUsableCatalog = (result: ProviderListModelsResult): boolean =>
  result.models.length > 0 && result.error === undefined && result.degraded !== true;

const isDegradedCatalogExit = (exit: Exit.Exit<ProviderListModelsResult, unknown>): boolean =>
  Exit.isSuccess(exit) && (exit.value.degraded === true || exit.value.error !== undefined);

export interface PersistedModelCatalogEntryInput {
  /** Serialized ProviderModelDiscoveryCacheKey — the map key. */
  readonly key: string;
  readonly result: ProviderListModelsResult;
  readonly storedAt: number;
}

export function makeProviderModelDiscoveryCache<E>(options?: {
  readonly now?: () => number;
  readonly freshTtlMs?: number;
  readonly staleTtlMs?: number;
  readonly failureTtlMs?: number;
  readonly degradedFailureTtlMs?: number;
  readonly timeoutMs?: number;
  readonly maxEntries?: number;
  /**
   * Snapshots hydrated from disk (providerModelCatalogCache.ts). `storedAt` is
   * preserved so fresh/stale windows stay honest across restarts.
   */
  readonly persistedCatalogs?: ReadonlyArray<PersistedModelCatalogEntryInput>;
  /** Invoked with the full catalog snapshot after every mutation (store, expiry, clear). */
  readonly onCatalogsChanged?: (entries: ReadonlyArray<PersistedModelCatalogEntryInput>) => void;
}): ProviderModelDiscoveryCache<E> {
  const now = options?.now ?? (() => Date.now());
  const freshTtlMs = options?.freshTtlMs ?? PROVIDER_MODEL_DISCOVERY_FRESH_TTL_MS;
  const staleTtlMs = options?.staleTtlMs ?? PROVIDER_MODEL_DISCOVERY_STALE_TTL_MS;
  const failureTtlMs = options?.failureTtlMs ?? PROVIDER_MODEL_DISCOVERY_FAILURE_TTL_MS;
  const degradedFailureTtlMs =
    options?.degradedFailureTtlMs ??
    options?.failureTtlMs ??
    PROVIDER_MODEL_DISCOVERY_DEGRADED_TTL_MS;
  const timeoutMs = options?.timeoutMs ?? PROVIDER_MODEL_DISCOVERY_TIMEOUT_MS;
  const maxEntries = options?.maxEntries ?? PROVIDER_MODEL_DISCOVERY_CACHE_MAX_ENTRIES;

  const catalogs = new Map<string, CatalogEntry>();
  const failures = new Map<string, FailureEntry>();
  const inflight = new Map<string, Deferred.Deferred<ProviderListModelsResult, unknown>>();

  const emitCatalogsChanged = () => {
    try {
      options?.onCatalogsChanged?.(
        [...catalogs.entries()].map(([key, entry]) => ({
          key,
          result: entry.result,
          storedAt: entry.storedAt,
        })),
      );
    } catch {
      // The listener persists snapshots; a throwing listener must not strand
      // the deferred waiters that applyExit resolves right after this call.
    }
  };

  // Hydrate from the persisted snapshot; entries already past the stale TTL are
  // dead on arrival and dropped (emitting once so the file is cleaned too).
  const bootedAt = now();
  let droppedPersisted = false;
  for (const entry of options?.persistedCatalogs ?? []) {
    if (!isUsableCatalog(entry.result) || bootedAt - entry.storedAt > staleTtlMs) {
      droppedPersisted = true;
      continue;
    }
    catalogs.set(entry.key, {
      key: parseSerializedProviderModelDiscoveryCacheKey(entry.key),
      result: entry.result,
      storedAt: entry.storedAt,
    });
    while (catalogs.size > maxEntries) {
      const oldest = catalogs.keys().next().value;
      if (oldest === undefined) break;
      catalogs.delete(oldest);
      droppedPersisted = true;
    }
  }
  if (droppedPersisted) emitCatalogsChanged();

  const readCatalog = (serialized: string, at: number): CatalogEntry | undefined => {
    const entry = catalogs.get(serialized);
    if (entry === undefined) return undefined;
    if (at - entry.storedAt > staleTtlMs) {
      catalogs.delete(serialized);
      emitCatalogsChanged();
      return undefined;
    }
    return entry;
  };

  const readCwdFallbackCatalog = (
    key: ProviderModelDiscoveryCacheKey,
    at: number,
  ): CatalogEntry | undefined => {
    let best: CatalogEntry | undefined;
    let expiredAny = false;
    for (const [entrySerialized, entry] of catalogs.entries()) {
      if (at - entry.storedAt > staleTtlMs) {
        catalogs.delete(entrySerialized);
        expiredAny = true;
        continue;
      }
      if (!matchesIgnoringCwd(entry.key, key)) continue;
      if (!best || entry.storedAt > best.storedAt) best = entry;
    }
    if (expiredAny) emitCatalogsChanged();
    return best;
  };

  const readFailure = (serialized: string, at: number): FailureEntry | undefined => {
    const entry = failures.get(serialized);
    if (entry === undefined) return undefined;
    const ttl = entry.degraded ? degradedFailureTtlMs : failureTtlMs;
    if (at - entry.storedAt > ttl) {
      failures.delete(serialized);
      return undefined;
    }
    return entry;
  };

  const storeCatalog = (
    key: ProviderModelDiscoveryCacheKey,
    serialized: string,
    result: ProviderListModelsResult,
    at: number,
  ) => {
    failures.delete(serialized);
    // Re-insert so Map iteration order doubles as an LRU order.
    catalogs.delete(serialized);
    catalogs.set(serialized, { key, result: { ...result, cached: false }, storedAt: at });
    while (catalogs.size > maxEntries) {
      const oldest = catalogs.keys().next().value;
      if (oldest === undefined) break;
      catalogs.delete(oldest);
    }
    emitCatalogsChanged();
  };

  const storeFailure = (
    serialized: string,
    exit: Exit.Exit<ProviderListModelsResult, unknown>,
    at: number,
  ) => {
    failures.set(serialized, { exit, storedAt: at, degraded: isDegradedCatalogExit(exit) });
    while (failures.size > maxEntries) {
      const oldest = failures.keys().next().value;
      if (oldest === undefined) break;
      failures.delete(oldest);
    }
  };

  const applyExit = (
    key: ProviderModelDiscoveryCacheKey,
    serialized: string,
    exit: DiscoveryExit<E>,
  ) => {
    const at = now();
    if (Exit.isSuccess(exit) && isUsableCatalog(exit.value)) {
      storeCatalog(key, serialized, exit.value, at);
      return;
    }
    // An error-free empty response is authoritative: do not keep offering
    // models the provider has removed. Replay it briefly before rediscovery.
    if (
      Exit.isSuccess(exit) &&
      exit.value.error === undefined &&
      exit.value.degraded !== true &&
      catalogs.delete(serialized)
    ) {
      emitCatalogsChanged();
    }
    storeFailure(serialized, exit, at);
  };

  /**
   * Start (or join) the single in-flight discovery for `serialized`. The work
   * runs on a detached fiber so it outlives the requesting RPC and so every
   * concurrent caller observes the same exit.
   */
  const startDiscovery = (
    key: ProviderModelDiscoveryCacheKey,
    serialized: string,
    discover: Effect.Effect<ProviderListModelsResult, E>,
  ): Effect.Effect<Deferred.Deferred<ProviderListModelsResult, unknown>> =>
    Effect.gen(function* () {
      const existing = inflight.get(serialized);
      if (existing !== undefined) return existing;
      const deferred = yield* Deferred.make<ProviderListModelsResult, unknown>();
      inflight.set(serialized, deferred);
      const run = discover.pipe(
        Effect.timeoutOption(timeoutMs),
        Effect.flatMap((result) =>
          Option.isSome(result)
            ? Effect.succeed(result.value)
            : Effect.fail(
                new ProviderAdapterRequestError({
                  provider: key.provider,
                  method: "models/list",
                  detail: `Model discovery timed out after ${Math.round(timeoutMs / 1000)}s.`,
                }),
              ),
        ),
        Effect.exit,
        Effect.flatMap((exit) => {
          inflight.delete(serialized);
          applyExit(key, serialized, exit as DiscoveryExit<E>);
          return Deferred.done(deferred, exit);
        }),
      );
      yield* Effect.forkDetach(run);
      return deferred;
    });

  // A fallback can serve a cold lookup, but even interactive refreshes retain
  // the last complete catalog until it expires instead of dropping model IDs.
  const retainLastGoodCatalog = (serialized: string, result: ProviderListModelsResult) => {
    if (result.degraded !== true) return result;
    const entry = readCatalog(serialized, now());
    return entry === undefined ? result : { ...entry.result, cached: true };
  };

  const awaitDiscovery = (
    serialized: string,
    deferred: Deferred.Deferred<ProviderListModelsResult, unknown>,
  ): Effect.Effect<ProviderListModelsResult, E | ProviderAdapterRequestError> =>
    Deferred.await(deferred).pipe(
      Effect.map((result) => retainLastGoodCatalog(serialized, result)),
    ) as Effect.Effect<ProviderListModelsResult, E | ProviderAdapterRequestError>;

  const lookup: ProviderModelDiscoveryCache<E>["lookup"] = (
    key,
    discover,
    refresh,
    lookupOptions,
  ) =>
    Effect.gen(function* () {
      const serialized = serializeProviderModelDiscoveryCacheKey(key);
      const at = now();
      const effectiveFreshTtlMs = lookupOptions?.freshTtlMs ?? freshTtlMs;
      const exactEntry = readCatalog(serialized, at);
      const entry =
        exactEntry ??
        (lookupOptions?.allowCwdFallback ? readCwdFallbackCatalog(key, at) : undefined);
      const failure = readFailure(serialized, at);
      if (refresh !== undefined) {
        const pending = inflight.get(serialized);
        if (pending !== undefined) return yield* awaitDiscovery(serialized, pending);
        if (failure !== undefined) {
          return retainLastGoodCatalog(serialized, yield* failure.exit as DiscoveryExit<E>);
        }
        const freshWindow =
          refresh === "now" ? MANUAL_REFRESH_MIN_INTERVAL_MS : effectiveFreshTtlMs;
        if (entry !== undefined && at - entry.storedAt <= freshWindow) {
          return { ...entry.result, cached: true };
        }
        return yield* awaitDiscovery(serialized, yield* startDiscovery(key, serialized, discover));
      }
      if (entry !== undefined) {
        if (at - entry.storedAt <= effectiveFreshTtlMs) {
          return { ...entry.result, cached: true };
        }
        // Stale-while-revalidate: answer now, refresh behind the caller.
        if (failure === undefined) {
          yield* startDiscovery(key, serialized, discover);
        }
        return { ...entry.result, cached: true };
      }
      const pending = inflight.get(serialized);
      if (pending !== undefined) {
        return yield* awaitDiscovery(serialized, pending);
      }
      if (failure !== undefined) {
        return retainLastGoodCatalog(serialized, yield* failure.exit as DiscoveryExit<E>);
      }
      const deferred = yield* startDiscovery(key, serialized, discover);
      return yield* awaitDiscovery(serialized, deferred);
    });

  const peekBestForInstance: ProviderModelDiscoveryCache<E>["peekBestForInstance"] = (
    provider,
    instanceId,
    cwd,
    overrideFreshTtlMs,
  ) => {
    const at = now();
    const effectiveFreshTtlMs = overrideFreshTtlMs ?? freshTtlMs;
    let exactMatch: CatalogEntry | undefined;
    let anyMatch: CatalogEntry | undefined;
    let expiredAny = false;
    for (const [entrySerialized, entry] of catalogs.entries()) {
      if (at - entry.storedAt > staleTtlMs) {
        catalogs.delete(entrySerialized);
        expiredAny = true;
        continue;
      }
      if (!entry.key) continue;
      if (entry.key.provider !== provider) continue;
      if (!matchesInstanceId(provider, entry.key.instanceId, instanceId)) continue;
      if (cwd && entry.key.cwd === cwd) {
        if (!exactMatch || entry.storedAt > exactMatch.storedAt) exactMatch = entry;
      }
      if (!anyMatch || entry.storedAt > anyMatch.storedAt) anyMatch = entry;
    }
    if (expiredAny) emitCatalogsChanged();
    const picked = exactMatch ?? anyMatch;
    if (!picked) return undefined;
    return {
      result: picked.result,
      storedAt: picked.storedAt,
      stale: at - picked.storedAt > effectiveFreshTtlMs,
    };
  };

  return {
    lookup,
    peekBestForInstance,
    clear: () => {
      const hadCatalogs = catalogs.size > 0;
      catalogs.clear();
      failures.clear();
      if (hadCatalogs) emitCatalogsChanged();
    },
    size: () => catalogs.size,
  };
}
