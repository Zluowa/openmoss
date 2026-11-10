import { WS_STREAM_LIMITS } from "@moss/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getRetainedThreadStreamBudget,
  noteThreadStreamCapacityRefused,
  resetRetainedThreadStreamBudget,
  subscribeRetainedThreadStreamBudget,
} from "./threadStreamLeaseBudget";

describe("threadStreamLeaseBudget", () => {
  afterEach(() => resetRetainedThreadStreamBudget());

  it("starts at the thread cap and shrinks one below what is leased on each refusal", () => {
    expect(getRetainedThreadStreamBudget()).toBe(WS_STREAM_LIMITS.threadPerClient);
    noteThreadStreamCapacityRefused(5);
    expect(getRetainedThreadStreamBudget()).toBe(4);
    noteThreadStreamCapacityRefused(5);
    expect(getRetainedThreadStreamBudget()).toBe(3);
    noteThreadStreamCapacityRefused(1);
    expect(getRetainedThreadStreamBudget()).toBe(0);
    noteThreadStreamCapacityRefused(1);
    expect(getRetainedThreadStreamBudget()).toBe(0);
  });

  it("tells listeners only when the budget moves, and resets for a new connection", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeRetainedThreadStreamBudget(listener);
    resetRetainedThreadStreamBudget();
    expect(listener).not.toHaveBeenCalled();
    noteThreadStreamCapacityRefused(3);
    expect(listener).toHaveBeenCalledTimes(1);
    resetRetainedThreadStreamBudget();
    expect(getRetainedThreadStreamBudget()).toBe(WS_STREAM_LIMITS.threadPerClient);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
