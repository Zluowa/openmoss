// FILE: idleResourcePool.ts
// Purpose: Keep per-conversation backend resources (a Canvas store: its folder's writer lease and
//          project state) open only while they are being used.
// Layer: Server runtime utility
// Exports: createIdleResourcePool, PoolableResource, IdleResourcePool, IdleResourceHandle
// Depends on: @moss/shared/runtimeResidency (the policy the window and the browser use too)
// Why: Every store used to stay open, lease included, until the server exited, so the cost grew
//      with every conversation ever opened. The shared planner closes the idle ones.
//
//   closed ──use──▶ open ──idle past the delay, or past maxLoaded (least recently used)──▶ closed
//
// - A resource never closes while a request is using it (it counts as pinned).
// - Each key has one stable handle for the life of the process, so callers may keep what they were
//   given: the next request reopens the resource transparently. There is never a second resource
//   for the same key, which for a Canvas store would fail on the folder's writer lease.
// - A use that arrives while the resource is closing waits for the close, then reopens.

import {
  planRuntimeResidency,
  type ResidentRuntimeState,
  type RuntimeResidencyPolicy,
} from "@moss/shared/runtimeResidency";

export interface PoolableResource {
  close(): void;
}

export interface IdleResourceHandle<R extends PoolableResource> {
  /** Run `work` with the open resource, opening it first when needed. */
  use<T>(work: (resource: R) => Promise<T> | T): Promise<T>;
  /** Close the resource now (after its in-flight requests); a later use reopens it. */
  close(): Promise<void>;
}

export interface IdleResourcePool<R extends PoolableResource> {
  /** The stable handle for `key`; `open` is used whenever the resource has to be (re)opened. */
  handle(key: string, open: () => Promise<R>): IdleResourceHandle<R>;
  /** Whether the resource for `key` is open or opening right now. */
  isOpen(key: string): boolean;
  /** How many resources are open or opening. */
  openCount(): number;
  /** Close every idle resource now and every busy one once its requests finish (shutdown). */
  closeAll(): Promise<void>;
}

interface Entry<R extends PoolableResource> {
  readonly key: string;
  // The latest caller's opener: a reopen uses current details (e.g. a renamed title).
  open: () => Promise<R>;
  current: Promise<R> | null;
  closing: Promise<void> | null;
  inFlight: number;
  /** Orders least recently used (strictly increasing). */
  lastUsedAt: number;
  /** When the last request finished (the clock), for the idle delay. */
  idleSince: number;
  closeWhenIdle: boolean;
  handle: IdleResourceHandle<R>;
}

export function createIdleResourcePool<R extends PoolableResource>(
  policy: RuntimeResidencyPolicy,
): IdleResourcePool<R> {
  const entries = new Map<string, Entry<R>>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Strictly increasing, so two uses in the same millisecond still order least recently used.
  let lastStamp = 0;
  const stamp = () => (lastStamp = Math.max(Date.now(), lastStamp + 1));

  const closeNow = (entry: Entry<R>): Promise<void> => {
    entry.closeWhenIdle = false;
    const current = entry.current;
    if (!current) return entry.closing ?? Promise.resolve();
    entry.current = null;
    const closing = current
      .then((resource) => resource.close())
      // A resource that failed to open has nothing to close.
      .catch(() => undefined)
      .finally(() => {
        if (entry.closing === closing) entry.closing = null;
      });
    entry.closing = closing;
    return closing;
  };

  const enforce = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const now = Date.now();
    const open = [...entries.values()].filter((entry) => entry.current);
    const plan = planRuntimeResidency({
      runtimes: open.map(
        (entry): ResidentRuntimeState => ({
          key: entry.key,
          owner: entry.key,
          visible: false,
          pinned: entry.inFlight > 0,
          lastActiveAt: entry.lastUsedAt,
          hiddenSince: entry.inFlight > 0 ? null : entry.idleSince,
        }),
      ),
      now,
      policy,
    });
    for (const key of plan.suspend) {
      const entry = entries.get(key);
      if (entry) void closeNow(entry);
    }
    if (plan.nextCheckAt === null) return;
    timer = setTimeout(enforce, Math.max(0, plan.nextCheckAt - now));
    // An idle store must never keep the server process alive.
    (timer as { unref?: () => void }).unref?.();
  };

  const acquire = async (entry: Entry<R>): Promise<R> => {
    while (entry.closing) await entry.closing;
    if (!entry.current) {
      const opening = entry.open();
      entry.current = opening;
      opening.catch(() => {
        // Forget a failed open so the next use tries again.
        if (entry.current === opening) entry.current = null;
      });
      enforce();
    }
    return entry.current;
  };

  const create = (key: string, open: () => Promise<R>): Entry<R> => {
    const entry: Entry<R> = {
      key,
      open,
      current: null,
      closing: null,
      inFlight: 0,
      lastUsedAt: 0,
      idleSince: 0,
      closeWhenIdle: false,
      handle: {
        use: async (work) => {
          entry.inFlight += 1;
          entry.lastUsedAt = stamp();
          try {
            return await work(await acquire(entry));
          } finally {
            entry.inFlight -= 1;
            entry.lastUsedAt = stamp();
            entry.idleSince = Date.now();
            if (entry.inFlight === 0 && entry.closeWhenIdle) void closeNow(entry);
            enforce();
          }
        },
        close: () => {
          if (entry.inFlight === 0) return closeNow(entry);
          // Let the requests that are using it finish first.
          entry.closeWhenIdle = true;
          return Promise.resolve();
        },
      },
    };
    return entry;
  };

  return {
    handle(key, open) {
      let entry = entries.get(key);
      if (!entry) {
        entry = create(key, open);
        entries.set(key, entry);
      } else entry.open = open;
      return entry.handle;
    },
    isOpen: (key) => Boolean(entries.get(key)?.current),
    openCount: () => [...entries.values()].filter((entry) => entry.current).length,
    closeAll: async () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      await Promise.all([...entries.values()].map((entry) => entry.handle.close()));
    },
  };
}
