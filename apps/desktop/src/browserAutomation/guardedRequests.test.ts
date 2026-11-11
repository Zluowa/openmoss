import { describe, expect, it, vi } from "vitest";
import type { Session } from "electron";

import { GuardedRequestTracker } from "./guardedRequests";

type Listener = ((details: { id: number }) => void) | null;

function fakeSession() {
  const listeners: Record<"sent" | "completed" | "failed", Listener> = {
    sent: null,
    completed: null,
    failed: null,
  };
  const webRequest = {
    onSendHeaders: vi.fn((listener: Listener) => {
      listeners.sent = listener;
    }),
    onCompleted: vi.fn((listener: Listener) => {
      listeners.completed = listener;
    }),
    onErrorOccurred: vi.fn((listener: Listener) => {
      listeners.failed = listener;
    }),
  };
  return {
    session: { webRequest } as unknown as Session,
    listeners,
    send: (id: number) => listeners.sent?.({ id }),
    complete: (id: number) => listeners.completed?.({ id }),
    fail: (id: number) => listeners.failed?.({ id }),
  };
}

describe("GuardedRequestTracker", () => {
  it("records only requests sent while a lease is installed", async () => {
    const fake = fakeSession();
    const tracker = new GuardedRequestTracker(fake.session);
    tracker.begin();
    fake.send(1);
    fake.send(2);
    const guarded = tracker.end();
    fake.send(3); // After release: a direct request, not the worker's.
    expect(guarded.size).toBe(2);
    fake.complete(1);
    expect(guarded.size).toBe(1);
    const drained = guarded.drained(60_000);
    fake.fail(2);
    await expect(drained).resolves.toBeUndefined();
  });

  it("stops listening once nothing is recorded or draining", () => {
    const fake = fakeSession();
    const tracker = new GuardedRequestTracker(fake.session);
    tracker.begin();
    expect(fake.listeners.sent).toBeTypeOf("function");
    fake.send(1);
    tracker.end();
    // Still listening: request 1 flows through the released guard.
    expect(fake.listeners.completed).toBeTypeOf("function");
    fake.complete(1);
    expect(fake.listeners.sent).toBeNull();
    expect(fake.listeners.completed).toBeNull();
    expect(fake.listeners.failed).toBeNull();
  });

  it("gives up at the cap or on abort, never rejecting", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeSession();
      const tracker = new GuardedRequestTracker(fake.session);
      tracker.begin();
      fake.send(1);
      const capped = tracker.end().drained(1_000);
      vi.advanceTimersByTime(1_000);
      await expect(capped).resolves.toBeUndefined();

      tracker.begin();
      fake.send(2);
      const controller = new AbortController();
      const aborted = tracker.end().drained(60_000, controller.signal);
      controller.abort();
      await expect(aborted).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a released lease's requests apart from the next lease", () => {
    const fake = fakeSession();
    const tracker = new GuardedRequestTracker(fake.session);
    tracker.begin();
    fake.send(1);
    const first = tracker.end();
    tracker.begin();
    fake.send(2);
    const second = tracker.end();
    expect(first.size).toBe(1);
    expect(second.size).toBe(1);
    fake.complete(2);
    expect(first.size).toBe(1);
    expect(second.size).toBe(0);
  });
});
