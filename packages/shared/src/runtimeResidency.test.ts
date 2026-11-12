import { describe, expect, it } from "vitest";

import {
  planRuntimeResidency,
  RUNTIME_RESIDENCY_POLICIES,
  selectRuntimesOverBudget,
  type ResidentRuntimeState,
  type RuntimeResidencyPolicy,
} from "./runtimeResidency";

const policy: RuntimeResidencyPolicy = {
  hiddenSuspendMs: 1_000,
  pressuredHiddenSuspendMs: 100,
  maxHiddenPerOwner: 2,
  maxLoaded: 4,
};

function runtime(key: string, overrides: Partial<ResidentRuntimeState> = {}): ResidentRuntimeState {
  return {
    key,
    owner: "thread-a",
    visible: false,
    pinned: false,
    lastActiveAt: 0,
    hiddenSince: 0,
    ...overrides,
  };
}

describe("runtime residency", () => {
  it("suspends a hidden runtime once its delay has passed, and says when to look next", () => {
    const runtimes = [
      runtime("old", { hiddenSince: 0, lastActiveAt: 0 }),
      runtime("new", { hiddenSince: 600, lastActiveAt: 600 }),
    ];
    expect(planRuntimeResidency({ runtimes, now: 999, policy })).toEqual({
      suspend: [],
      nextCheckAt: 1_000,
    });
    expect(planRuntimeResidency({ runtimes, now: 1_000, policy })).toEqual({
      suspend: ["old"],
      nextCheckAt: 1_600,
    });
  });

  it("uses the shorter delay under memory pressure", () => {
    const runtimes = [runtime("a", { hiddenSince: 0 })];
    expect(planRuntimeResidency({ runtimes, now: 100, policy, pressured: true }).suspend).toEqual([
      "a",
    ]);
  });

  it("never suspends a shown or pinned runtime, however long or over budget", () => {
    const runtimes = [
      runtime("shown", { visible: true, hiddenSince: null }),
      runtime("pinned", { pinned: true, hiddenSince: 0 }),
      ...["x", "y", "z"].map((key, index) =>
        runtime(key, { owner: `thread-${key}`, hiddenSince: 5_000, lastActiveAt: index }),
      ),
    ];
    const plan = planRuntimeResidency({
      runtimes,
      now: 5_000,
      policy: { ...policy, maxLoaded: 1 },
    });
    expect(plan.suspend).toEqual(["x", "y", "z"]);
  });

  it("keeps each owner's most recently used hidden runtimes", () => {
    const runtimes = [
      runtime("a1", { lastActiveAt: 1 }),
      runtime("a2", { lastActiveAt: 3 }),
      runtime("a3", { lastActiveAt: 2 }),
      runtime("b1", { owner: "thread-b", lastActiveAt: 0 }),
    ];
    expect(selectRuntimesOverBudget({ runtimes, maxHiddenPerOwner: 2 })).toEqual(["a1"]);
  });

  it("keeps the app-wide count under its cap, least recently used hidden first", () => {
    const runtimes = [
      runtime("shown", { visible: true, hiddenSince: null, lastActiveAt: 0 }),
      runtime("a", { owner: "1", lastActiveAt: 5 }),
      runtime("b", { owner: "2", lastActiveAt: 1 }),
      runtime("c", { owner: "3", lastActiveAt: 3 }),
    ];
    expect(selectRuntimesOverBudget({ runtimes, maxLoaded: 2 })).toEqual(["b", "c"]);
  });

  it("counts a runtime suspended for its owner's limit once, not again for the app-wide cap", () => {
    const runtimes = [
      runtime("a1", { lastActiveAt: 1 }),
      runtime("a2", { lastActiveAt: 2 }),
      runtime("a3", { lastActiveAt: 3 }),
      runtime("b1", { owner: "thread-b", lastActiveAt: 4 }),
    ];
    // a1 leaves for thread-a's limit of 2; three remain, within the cap of 3.
    expect(selectRuntimesOverBudget({ runtimes, maxHiddenPerOwner: 2, maxLoaded: 3 })).toEqual([
      "a1",
    ]);
  });

  it("keeps the browser's numbers in the shared table", () => {
    expect(RUNTIME_RESIDENCY_POLICIES.browserTab).toEqual({
      hiddenSuspendMs: 600_000,
      pressuredHiddenSuspendMs: 60_000,
      maxHiddenPerOwner: 5,
      maxLoaded: 12,
    });
  });
});
