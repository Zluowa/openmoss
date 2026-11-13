import { describe, expect, it, vi } from "vitest";

import { createVisibleDeadline, MCP_APP_DEADLINE_LATE_SLACK_MS } from "./startDeadline";

/** A hand-driven clock, timer list and page visibility. */
function harness() {
  let time = 0;
  let visible = true;
  const listeners = new Set<() => void>();
  const timers = new Map<number, { at: number; callback: () => void }>();
  let nextId = 1;
  return {
    now: () => time,
    setTimer: (callback: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: time + ms, callback });
      return id;
    },
    clearTimer: (id: unknown) => void timers.delete(id as number),
    visibility: {
      isVisible: () => visible,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    setVisible(next: boolean) {
      visible = next;
      for (const listener of listeners) listener();
    },
    /** Moves the clock; due timers fire (`lateBy` delays them, as a frozen page would). */
    advance(ms: number, lateBy = 0) {
      time += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at + lateBy <= time) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
    pending: () => timers.size,
  };
}

describe("createVisibleDeadline", () => {
  it("expires after the given visible time", () => {
    const h = harness();
    const onExpire = vi.fn();
    createVisibleDeadline({ ms: 1_000, onExpire, ...h });
    h.advance(999);
    expect(onExpire).not.toHaveBeenCalled();
    h.advance(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("does not count time while the window is hidden", () => {
    const h = harness();
    const onExpire = vi.fn();
    createVisibleDeadline({ ms: 1_000, onExpire, ...h });
    h.advance(600);
    h.setVisible(false);
    h.advance(60_000);
    expect(onExpire).not.toHaveBeenCalled();
    h.setVisible(true);
    h.advance(399);
    expect(onExpire).not.toHaveBeenCalled();
    h.advance(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("gives the time again when its timer fired long after it was due (a frozen page)", () => {
    const h = harness();
    const onExpire = vi.fn();
    createVisibleDeadline({ ms: 1_000, onExpire, ...h });
    // The timer only runs 1 000 + slack + 1 ms after it was due.
    h.advance(1_000 + MCP_APP_DEADLINE_LATE_SLACK_MS + 1, MCP_APP_DEADLINE_LATE_SLACK_MS + 1);
    expect(onExpire).not.toHaveBeenCalled();
    expect(h.pending()).toBe(1);
    h.advance(1_000);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("stops when cancelled", () => {
    const h = harness();
    const onExpire = vi.fn();
    const deadline = createVisibleDeadline({ ms: 1_000, onExpire, ...h });
    deadline.cancel();
    h.setVisible(false);
    h.setVisible(true);
    h.advance(5_000);
    expect(onExpire).not.toHaveBeenCalled();
    expect(h.pending()).toBe(0);
  });
});
