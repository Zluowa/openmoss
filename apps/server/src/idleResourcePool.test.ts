import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeResidencyPolicy } from "@moss/shared/runtimeResidency";

import { createIdleResourcePool } from "./idleResourcePool";

function policy(idleMs: number, maxLoaded: number): RuntimeResidencyPolicy {
  return {
    hiddenSuspendMs: idleMs,
    pressuredHiddenSuspendMs: idleMs,
    maxHiddenPerOwner: 1,
    maxLoaded,
  };
}

interface FakeStore {
  readonly id: number;
  readonly close: () => void;
}

function opener() {
  let next = 0;
  const opened: FakeStore[] = [];
  const open = vi.fn(async (): Promise<FakeStore> => {
    const store = { id: ++next, close: vi.fn() };
    opened.push(store);
    return store;
  });
  return { open, opened };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("idle resource pool", () => {
  it("reuses one open store per key and closes it after the idle window", async () => {
    const pool = createIdleResourcePool<FakeStore>(policy(1_000, 4));
    const { open, opened } = opener();
    const handle = pool.handle("a", open);
    expect(pool.handle("a", open)).toBe(handle);

    await handle.use((store) => store.id);
    await handle.use((store) => store.id);
    expect(open).toHaveBeenCalledTimes(1);
    expect(pool.isOpen("a")).toBe(true);

    await vi.advanceTimersByTimeAsync(999);
    expect(opened[0]!.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(opened[0]!.close).toHaveBeenCalledTimes(1);
    expect(pool.openCount()).toBe(0);

    // The same handle reopens transparently.
    expect(await handle.use((store) => store.id)).toBe(2);
  });

  it("never closes a store while a request is using it", async () => {
    const pool = createIdleResourcePool<FakeStore>(policy(1_000, 4));
    const { open, opened } = opener();
    const handle = pool.handle("a", open);
    let finish!: () => void;
    const slow = handle.use(() => new Promise<void>((resolve) => (finish = resolve)));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(opened[0]!.close).not.toHaveBeenCalled();

    // An explicit close waits for the request, too.
    await handle.close();
    expect(opened[0]!.close).not.toHaveBeenCalled();
    finish();
    await slow;
    await vi.advanceTimersByTimeAsync(0);
    expect(opened[0]!.close).toHaveBeenCalledTimes(1);
  });

  it("closes the least recently used idle stores beyond the cap, never a busy one", async () => {
    const pool = createIdleResourcePool<FakeStore>(policy(60_000, 2));
    const a = opener();
    const b = opener();
    const c = opener();
    let finishA!: () => void;
    const busyA = pool.handle("a", a.open).use(() => new Promise<void>((r) => (finishA = r)));
    await vi.advanceTimersByTimeAsync(0);
    await pool.handle("b", b.open).use(() => undefined);
    await pool.handle("c", c.open).use(() => undefined);
    await vi.advanceTimersByTimeAsync(0);

    // "a" is the oldest but busy, so the idle "b" makes room.
    expect(a.opened[0]!.close).not.toHaveBeenCalled();
    expect(b.opened[0]!.close).toHaveBeenCalledTimes(1);
    expect(pool.openCount()).toBe(2);

    finishA();
    await busyA;
    await pool.handle("b", b.open).use(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    // Now "c" is the least recently used idle store.
    expect(c.opened[0]!.close).toHaveBeenCalledTimes(1);
    expect(pool.isOpen("a")).toBe(true);
    expect(pool.isOpen("b")).toBe(true);
  });

  it("waits for a close in progress before reopening, so one folder never has two stores", async () => {
    const pool = createIdleResourcePool<FakeStore>(policy(1_000, 4));
    const events: string[] = [];
    let opens = 0;
    const handle = pool.handle("a", async () => {
      const id = ++opens;
      events.push(`open ${id}`);
      return {
        id,
        close: vi.fn(() => {
          events.push(`closing ${id}`);
        }),
      };
    });
    await handle.use(() => undefined);
    // The close settles asynchronously; a use issued in the same tick must queue behind it.
    const closing = handle.close();
    const reopened = handle.use((store) => store.id);
    await closing;
    expect(await reopened).toBe(2);
    expect(events).toEqual(["open 1", "closing 1", "open 2"]);
  });

  it("forgets a store that failed to open and lets the next use try again", async () => {
    const pool = createIdleResourcePool<FakeStore>(policy(1_000, 4));
    const open = vi
      .fn<() => Promise<FakeStore>>()
      .mockRejectedValueOnce(new Error("canvas_bundle_unavailable"))
      .mockResolvedValueOnce({ id: 7, close: vi.fn() });
    const handle = pool.handle("a", open);
    await expect(handle.use(() => undefined)).rejects.toThrow("canvas_bundle_unavailable");
    expect(pool.isOpen("a")).toBe(false);
    expect(await handle.use((store) => store.id)).toBe(7);
  });

  it("reopens with the latest opener, so renamed details apply after an idle close", async () => {
    const pool = createIdleResourcePool<FakeStore>(policy(1_000, 4));
    const first = vi.fn(async () => ({ id: 1, close: vi.fn() }));
    const second = vi.fn(async () => ({ id: 2, close: vi.fn() }));
    await pool.handle("a", first).use(() => undefined);
    const handle = pool.handle("a", second);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await handle.use((store) => store.id)).toBe(2);
  });

  it("closes everything on shutdown", async () => {
    const pool = createIdleResourcePool<FakeStore>(policy(60_000, 4));
    const a = opener();
    const b = opener();
    await pool.handle("a", a.open).use(() => undefined);
    await pool.handle("b", b.open).use(() => undefined);
    await pool.closeAll();
    expect(a.opened[0]!.close).toHaveBeenCalledTimes(1);
    expect(b.opened[0]!.close).toHaveBeenCalledTimes(1);
    expect(pool.openCount()).toBe(0);
  });
});
