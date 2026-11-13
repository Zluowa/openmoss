import { describe, expect, it, vi } from "vitest";

import {
  createRendererStorageFlusher,
  RENDERER_STORAGE_TRAILING_FLUSH_MS,
} from "./rendererStorageFlush";

describe("createRendererStorageFlusher", () => {
  it("flushes at once and once more after the trailing delay, sharing one timer", () => {
    const timers: Array<{ callback: () => void; delayMs: number }> = [];
    const flushRequest = createRendererStorageFlusher({
      schedule: (callback, delayMs) => timers.push({ callback, delayMs }),
    });
    const session = { flushStorageData: vi.fn() };

    flushRequest(session);
    flushRequest(session);
    expect(session.flushStorageData).toHaveBeenCalledTimes(2);
    expect(timers).toHaveLength(1);
    expect(timers[0]?.delayMs).toBe(RENDERER_STORAGE_TRAILING_FLUSH_MS);

    timers[0]?.callback();
    expect(session.flushStorageData).toHaveBeenCalledTimes(3);

    // After the trailing flush ran, a new request schedules a new one.
    flushRequest(session);
    expect(timers).toHaveLength(2);
  });

  it("never throws when the session is already gone", () => {
    const timers: Array<() => void> = [];
    const flushRequest = createRendererStorageFlusher({
      schedule: (callback) => timers.push(callback),
    });
    const session = {
      flushStorageData: () => {
        throw new Error("Session destroyed");
      },
    };
    expect(() => flushRequest(session)).not.toThrow();
    expect(() => timers[0]?.()).not.toThrow();
  });
});
