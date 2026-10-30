import { Debouncer } from "@tanstack/react-pacer";
import type { PersistStorage, StorageValue } from "zustand/middleware";

export interface StateStorage<R = unknown> {
  getItem: (name: string) => string | null | Promise<string | null>;
  setItem: (name: string, value: string) => R;
  removeItem: (name: string) => R;
}

export interface DeferredPersistStorage<S> extends PersistStorage<S> {
  /** Serialize the latest captured state and write it through synchronously. */
  flush: () => void;
  /** Cancel any scheduled write and drop the captured state without persisting it. */
  dispose: () => void;
}

export function createMemoryStorage(): StateStorage {
  const store = new Map<string, string>();
  return {
    getItem: (name) => store.get(name) ?? null,
    setItem: (name, value) => {
      store.set(name, value);
    },
    removeItem: (name) => {
      store.delete(name);
    },
  };
}

/**
 * A zustand-persist-compatible storage that defers BOTH `partialize` and
 * `JSON.stringify` off the hot `set()` path.
 *
 * `createJSONStorage` (the zustand default) runs `partialize(get())` and the full
 * `JSON.stringify` of the entire store synchronously on every state change; only
 * the underlying `localStorage.setItem` I/O can be debounced. For large stores
 * (e.g. drafts carrying base64 image attachments) that per-keystroke serialization
 * is the dominant cost and stalls typing.
 *
 * Here, `setItem` only captures the latest `StorageValue` reference. The expensive
 * `partialize` + `JSON.stringify` runs a single time inside the debounced flush,
 * over the most recent captured state. The persisted bytes are identical to
 * `createJSONStorage` + a `partialize` config for the same final state — only
 * *when* serialization happens changes. At most one debounce window of changes can
 * be lost on a crash; wire `flush()` to `pagehide`/`visibilitychange` to bound that.
 *
 * IMPORTANT: pass `partialize` here and DO NOT also set `partialize` in the persist
 * config, otherwise partialize would run eagerly on every `set()` (defeating the
 * deferral) and then again at flush.
 */
interface PageHideEventTarget {
  readonly addEventListener?: (type: string, listener: () => void) => void;
}

interface PageVisibilityTarget extends PageHideEventTarget {
  readonly visibilityState: string;
}

export interface FlushBeforePageHideEnv {
  readonly window?: PageHideEventTarget | undefined;
  readonly document?: PageVisibilityTarget | undefined;
}

interface PageLifecycleFlushRegistration {
  readonly storageByKey: Map<string, Pick<DeferredPersistStorage<unknown>, "flush" | "dispose">>;
}

interface PageLifecycleFlushRegistry {
  readonly byTarget: WeakMap<object, PageLifecycleFlushRegistration>;
}

const PAGE_LIFECYCLE_FLUSH_REGISTRY = Symbol.for("moss.deferred-storage-page-lifecycle-flush");

function getPageLifecycleFlushRegistry(): PageLifecycleFlushRegistry {
  const host = globalThis as typeof globalThis & {
    [PAGE_LIFECYCLE_FLUSH_REGISTRY]?: PageLifecycleFlushRegistry;
  };
  return (host[PAGE_LIFECYCLE_FLUSH_REGISTRY] ??= {
    byTarget: new WeakMap<object, PageLifecycleFlushRegistration>(),
  });
}

function flushRegisteredStorages(registration: PageLifecycleFlushRegistration): void {
  let firstError: unknown;
  for (const storage of registration.storageByKey.values()) {
    try {
      storage.flush();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== undefined) {
    throw firstError;
  }
}

/**
 * Flush a debounced/deferred storage before the page goes away, so at most one
 * debounce window of changes can be lost. Wires `beforeunload`, `pagehide`, and
 * `visibilitychange`→hidden — the latter two fire on mobile/bfcache navigations
 * where `beforeunload` does not. No-ops when the DOM globals are unavailable
 * (SSR / non-browser test environments), and is injectable for testing.
 *
 * `key` must be stable for the storage. Re-registering the same key (for
 * example after an HMR module evaluation) flushes and disposes the old storage
 * before replacing it, without stacking another set of page lifecycle listeners.
 */
export function flushStorageBeforePageHide(
  key: string,
  storage: Pick<DeferredPersistStorage<unknown>, "flush" | "dispose">,
  env: FlushBeforePageHideEnv = {
    window: typeof window !== "undefined" ? window : undefined,
    document: typeof document !== "undefined" ? document : undefined,
  },
): void {
  const target = env.window ?? env.document;
  if (!target) {
    return;
  }

  const registry = getPageLifecycleFlushRegistry();
  const existing = registry.byTarget.get(target);
  if (existing) {
    const previous = existing.storageByKey.get(key);
    if (previous === storage) {
      return;
    }

    let firstError: unknown;
    if (previous) {
      try {
        previous.flush();
      } catch (error) {
        firstError ??= error;
      }
      try {
        previous.dispose();
      } catch (error) {
        firstError ??= error;
      }
    }
    existing.storageByKey.set(key, storage);
    if (firstError !== undefined) {
      throw firstError;
    }
    return;
  }

  const registration: PageLifecycleFlushRegistration = {
    storageByKey: new Map([[key, storage]]),
  };
  registry.byTarget.set(target, registration);
  const flushAll = () => flushRegisteredStorages(registration);
  if (typeof env.window?.addEventListener === "function") {
    env.window.addEventListener("beforeunload", flushAll);
    env.window.addEventListener("pagehide", flushAll);
  }
  const doc = env.document;
  if (typeof doc?.addEventListener === "function") {
    doc.addEventListener("visibilitychange", () => {
      if (doc.visibilityState === "hidden") {
        flushAll();
      }
    });
  }
}

export function createDeferredPersistStorage<State, Persisted = State>(options: {
  readonly getStorage: () => StateStorage;
  readonly partialize: (state: State) => Persisted;
  readonly debounceMs?: number;
}): DeferredPersistStorage<Persisted> {
  const { getStorage, partialize, debounceMs = 300 } = options;

  // Latest pending write, captured lazily. Serialization is deferred to flush time.
  // zustand's persist calls setItem with the FULL store state as `value.state`
  // (there must be no `partialize` in the persist config — see the doc above), so
  // it is typed as `Persisted` per the PersistStorage contract but is really `State`.
  let pending: { readonly name: string; readonly value: StorageValue<Persisted> } | null = null;

  const writePending = (): void => {
    if (pending === null) {
      return;
    }
    const { name, value } = pending;
    pending = null;
    // Mirror zustand's `{ state, version }` StorageValue key order so the produced
    // bytes stay identical to createJSONStorage for the same state.
    getStorage().setItem(
      name,
      JSON.stringify({
        state: partialize(value.state as unknown as State),
        version: value.version,
      }),
    );
  };

  const debouncedWrite = new Debouncer(() => writePending(), { wait: debounceMs });

  const parse = (value: string | null): StorageValue<Persisted> | null =>
    value === null ? null : (JSON.parse(value) as StorageValue<Persisted>);

  return {
    getItem: (name) => {
      const raw = getStorage().getItem(name);
      return raw instanceof Promise ? raw.then(parse) : parse(raw);
    },
    setItem: (name, value) => {
      pending = { name, value };
      debouncedWrite.maybeExecute();
    },
    removeItem: (name) => {
      pending = null;
      debouncedWrite.cancel();
      getStorage().removeItem(name);
    },
    flush: () => {
      debouncedWrite.cancel();
      writePending();
    },
    dispose: () => {
      debouncedWrite.cancel();
      pending = null;
    },
  };
}
