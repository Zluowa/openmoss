import { describe, expect, it } from "vitest";

import { resolveTodoPlanPresentation } from "./todoPlanPresentation";

describe("resolveTodoPlanPresentation", () => {
  it("selects the first in-progress step", () => {
    expect(
      resolveTodoPlanPresentation([
        { task: "Done", status: "completed" },
        { task: "Current", status: "inProgress" },
        { task: "Later", status: "pending" },
      ]),
    ).toMatchObject({
      currentStepIndex: 1,
      stepNumber: 2,
      stepCount: 3,
      completedCount: 1,
      isComplete: false,
    });
    expect(
      resolveTodoPlanPresentation([
        { task: "Done", status: "completed" },
        { task: "Current", status: "inProgress" },
        { task: "Later", status: "pending" },
      ])?.percent,
    ).toBeCloseTo(100 / 3);
  });

  it("selects the first unfinished step when no step is in progress", () => {
    expect(
      resolveTodoPlanPresentation([
        { task: "Done", status: "completed" },
        { task: "Next", status: "pending" },
        { task: "Later", status: "pending" },
      ]),
    ).toMatchObject({
      currentStepIndex: 1,
      stepNumber: 2,
      completedCount: 1,
      isComplete: false,
    });
    expect(
      resolveTodoPlanPresentation([
        { task: "Done", status: "completed" },
        { task: "Next", status: "pending" },
        { task: "Later", status: "pending" },
      ])?.percent,
    ).toBeCloseTo(100 / 3);
  });

  it("selects the last step and reports complete when every task is complete", () => {
    expect(
      resolveTodoPlanPresentation([
        { task: "First", status: "completed" },
        { task: "Last", status: "completed" },
      ]),
    ).toEqual({
      currentStepIndex: 1,
      stepNumber: 2,
      stepCount: 2,
      completedCount: 2,
      percent: 100,
      isComplete: true,
    });
  });

  it("does not render a pill for an empty snapshot", () => {
    expect(resolveTodoPlanPresentation([])).toBeNull();
  });
});
