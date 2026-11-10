import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

const created = vi.hoisted(() => [] as Array<{ disposed: boolean; prepared: number }>);

vi.mock("./windowsProcessSnapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./windowsProcessSnapshot")>()),
  createWindowsTeardownProcessSnapshotObserver: () => {
    const record = { disposed: false, prepared: 0 };
    created.push(record);
    return {
      prepareWithin: async () => {
        record.prepared += 1;
      },
      assertReady: () => {},
      capture: async () => null,
      captureWithin: async () => null,
      capturePidsWithin: async () => null,
      dispose: () => {
        record.disposed = true;
      },
    };
  },
}));

import {
  disposeWarmWindowsTeardownObservers,
  enableWarmWindowsTeardownObservers,
  hasWarmWindowsTeardownObserver,
  spawnChildWithPreparedTree,
} from "./supervisedProcessTeardown";

function fakeChild(pid: number) {
  return {
    pid,
    exitCode: null,
    signalCode: null,
    once: () => undefined,
    on: () => undefined,
    removeListener: () => undefined,
  } as unknown as ChildProcess;
}

describe("warm Windows teardown observers", () => {
  afterEach(() => {
    disposeWarmWindowsTeardownObservers();
    created.length = 0;
    vi.useRealTimers();
  });

  it("stays off unless the server turns it on, and never on other platforms", () => {
    vi.useFakeTimers();
    enableWarmWindowsTeardownObservers("linux");
    vi.advanceTimersByTime(60_000);
    expect(hasWarmWindowsTeardownObserver()).toBe(false);
    expect(created).toHaveLength(0);
  });

  it("hands a launch the warmed observer and warms the next one later", async () => {
    vi.useFakeTimers();
    enableWarmWindowsTeardownObservers("win32");
    expect(created).toHaveLength(0);
    vi.advanceTimersByTime(5_000);
    expect(hasWarmWindowsTeardownObserver()).toBe(true);
    expect(created).toHaveLength(1);

    await spawnChildWithPreparedTree({
      platform: "win32",
      beforeSpawn: () => {},
      spawn: () => fakeChild(424242),
      bind: () => undefined,
    });
    // The launch used the parked observer instead of starting its own.
    expect(created).toHaveLength(1);
    expect(created[0]!.disposed).toBe(false);
    expect(hasWarmWindowsTeardownObserver()).toBe(false);

    vi.advanceTimersByTime(5_000);
    expect(created).toHaveLength(2);
    expect(hasWarmWindowsTeardownObserver()).toBe(true);
  });

  it("closes the parked observer and stops refilling on server exit", () => {
    vi.useFakeTimers();
    enableWarmWindowsTeardownObservers("win32");
    vi.advanceTimersByTime(5_000);
    disposeWarmWindowsTeardownObservers();
    expect(created[0]!.disposed).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(created).toHaveLength(1);
  });
});
