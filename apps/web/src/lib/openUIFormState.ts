import type { MossAccountSessionState, MossCloudAccountState } from "@synara/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import { mossServerQueryKeys } from "~/components/auth/mossServerReactQuery";
import { readMossImagesAccountBoundary } from "./mossImagesAccountBoundary";

export interface OpenUIFormScope {
  readonly threadId: string | undefined;
  readonly messageId: string | undefined;
  readonly segmentIndex: number | undefined;
  readonly blockOffset: number | undefined;
  readonly code: string;
  readonly isStreaming?: boolean | undefined;
}

interface FormCache {
  readonly boundary: string;
  readonly generation: number;
  readonly states: Map<string, Record<string, unknown>>;
}

interface ClientCache {
  current: FormCache;
  readonly synchronize: () => FormCache;
  readonly listeners: Set<() => void>;
}

const caches = new WeakMap<QueryClient, ClientCache>();
const CACHE_LIMIT = 50;
let nextGeneration = 0;

function clientCache(client: QueryClient): ClientCache {
  const existing = caches.get(client);
  if (existing) return existing;
  const fresh = (boundary: string): FormCache => ({
    boundary,
    generation: ++nextGeneration,
    states: new Map(),
  });
  const owner: ClientCache = {
    current: fresh(readMossImagesAccountBoundary(client)),
    listeners: new Set(),
    synchronize: () => {
      const boundary = readMossImagesAccountBoundary(client);
      if (boundary !== owner.current.boundary) {
        owner.current.states.clear();
        owner.current = fresh(boundary);
        for (const notify of owner.listeners) notify();
      }
      return owner.current;
    },
  };
  caches.set(client, owner);
  const accountQueries = new Set([
    JSON.stringify(mossServerQueryKeys.mossAccountSession()),
    JSON.stringify(mossServerQueryKeys.mossCloudAccountState()),
  ]);
  // One pair of identity-only listeners for this QueryClient's lifetime. The
  // WeakMap does not keep a discarded client alive. Observe transitions even
  // with no mounted frame, including A -> signed out -> A in one React batch.
  client.getQueryCache().subscribe((event) => {
    if (accountQueries.has(JSON.stringify(event.query.queryKey))) owner.synchronize();
  });
  client.getMutationCache().subscribe(() => owner.synchronize());
  return owner;
}

function currentCache(client: QueryClient): FormCache {
  return clientCache(client).synchronize();
}

function hasKnownAccount(client: QueryClient): boolean {
  const phone = client.getQueryState<MossAccountSessionState>(
    mossServerQueryKeys.mossAccountSession(),
  );
  const cloud = client.getQueryState<MossCloudAccountState>(
    mossServerQueryKeys.mossCloudAccountState(),
  );
  const phoneKnown =
    phone?.status === "success" &&
    phone.data?.authenticated === true &&
    Boolean(phone.data.session?.user.id);
  const cloudKnown =
    cloud?.status === "success" &&
    cloud.data?.authenticated === true &&
    Boolean(cloud.data.account?.id);
  const phoneRealm = phone?.data?.activeRealm;
  const cloudRealm = cloud?.data?.activeRealm;
  if (phoneRealm && cloudRealm && phoneRealm !== cloudRealm) return false;
  const realm = phoneRealm ?? cloudRealm;
  if (realm === "cn") return phoneKnown;
  if (realm === "global") return cloudKnown;
  // Older servers may omit the realm. Only one unambiguous authenticated owner
  // can enable remount persistence; a missing identity never shares a fallback.
  return phoneKnown !== cloudKnown;
}

/** A short-lived lease over existing identity metadata; never starts an auth query. */
export function leaseOpenUIFormState(client: QueryClient, scope: OpenUIFormScope) {
  return leaseFromCache(client, scope, currentCache(client));
}

function leaseFromCache(client: QueryClient, scope: OpenUIFormScope, cache: FormCache) {
  const complete =
    Boolean(scope.threadId && scope.messageId) &&
    typeof scope.blockOffset === "number" &&
    Number.isSafeInteger(scope.blockOffset) &&
    scope.blockOffset >= 0 &&
    (scope.segmentIndex === undefined ||
      (Number.isSafeInteger(scope.segmentIndex) && scope.segmentIndex >= 0));
  const location = [
    scope.threadId ?? null,
    scope.messageId ?? null,
    scope.segmentIndex ?? null,
    scope.blockOffset ?? null,
  ];
  const key = JSON.stringify([...location, scope.code]);
  const isCurrent = () =>
    currentCache(client) === cache &&
    complete &&
    !scope.isStreaming &&
    !cache.boundary.startsWith("pending:") &&
    hasKnownAccount(client);
  return {
    // Preserve the incremental parser while text streams. Only a completed
    // exact program can restore or save a draft; owner changes always remount.
    rendererKey: JSON.stringify([
      cache.generation,
      location,
      scope.isStreaming ? ["streaming"] : ["complete", scope.code],
    ]),
    read(): Record<string, unknown> | undefined {
      if (!isCurrent()) return undefined;
      const value = cache.states.get(key);
      if (value) {
        cache.states.delete(key);
        cache.states.set(key, value);
      }
      return value;
    },
    write(state: Record<string, unknown>): void {
      if (!isCurrent()) return;
      cache.states.delete(key);
      cache.states.set(key, state);
      while (cache.states.size > CACHE_LIMIT) {
        const oldest = cache.states.keys().next().value;
        if (oldest === undefined) break;
        cache.states.delete(oldest);
      }
    },
  };
}

/** The generation changes even when a batched account A -> B -> A returns to the same identity. */
export function useOpenUIFormState(client: QueryClient, scope: OpenUIFormScope) {
  const subscribe = useCallback(
    (notify: () => void) => {
      const owner = clientCache(client);
      owner.listeners.add(notify);
      return () => {
        owner.listeners.delete(notify);
      };
    },
    [client],
  );
  const getSnapshot = useCallback(() => currentCache(client), [client]);
  const cache = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return leaseFromCache(client, scope, cache);
}

export type OpenUIFormStateLease = ReturnType<typeof leaseOpenUIFormState>;
