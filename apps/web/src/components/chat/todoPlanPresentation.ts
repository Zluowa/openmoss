// FILE: todoPlanPresentation.ts
// Purpose: Pure Codex-compatible checklist progress selection for transcript pills.
// Layer: Chat presentation helpers

import type { TaskListTaskSnapshot } from "../../workLog";

export interface TodoPlanPresentation {
  readonly currentStepIndex: number;
  readonly stepNumber: number;
  readonly stepCount: number;
  readonly completedCount: number;
  readonly percent: number;
  readonly isComplete: boolean;
}

/**
 * Selects the same step that Codex exposes in its compact todo-list primitive:
 * the first in-progress item, then the first unfinished item, then the last
 * completed item. Empty snapshots are not renderable transcript pills.
 */
export function resolveTodoPlanPresentation(
  tasks: ReadonlyArray<TaskListTaskSnapshot>,
): TodoPlanPresentation | null {
  if (tasks.length === 0) {
    return null;
  }

  const inProgressIndex = tasks.findIndex((task) => task.status === "inProgress");
  const unfinishedIndex = tasks.findIndex((task) => task.status !== "completed");
  const currentStepIndex =
    inProgressIndex >= 0
      ? inProgressIndex
      : unfinishedIndex >= 0
        ? unfinishedIndex
        : tasks.length - 1;
  const completedCount = tasks.filter((task) => task.status === "completed").length;
  const isComplete = completedCount === tasks.length;

  return {
    currentStepIndex,
    stepNumber: currentStepIndex + 1,
    stepCount: tasks.length,
    completedCount,
    percent: isComplete ? 100 : (completedCount / tasks.length) * 100,
    isComplete,
  };
}
