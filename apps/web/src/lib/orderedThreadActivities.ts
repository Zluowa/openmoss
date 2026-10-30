// Shared ordering for transcript projection and pending-interaction replay.
import type { OrchestrationThreadActivity } from "@synara/contracts";

const CONTEXT_COMPACTION_PROGRESS_LABEL = "Compacting context";

export function isContextCompactionProgressLabel(value: string | undefined): boolean {
  return (
    value === CONTEXT_COMPACTION_PROGRESS_LABEL ||
    value === "Compacting conversation..." ||
    value === "Context automatically compacting"
  );
}

const orderedActivitiesCache = new WeakMap<
  ReadonlyArray<OrchestrationThreadActivity>,
  ReadonlyArray<OrchestrationThreadActivity>
>();

function isActivityOrderStable(activities: ReadonlyArray<OrchestrationThreadActivity>): boolean {
  for (let index = 1; index < activities.length; index += 1) {
    if (compareActivitiesByOrder(activities[index - 1]!, activities[index]!) > 0) {
      return false;
    }
  }
  return true;
}

// Thread activity arrays are immutable store values and most call sites need the
// same order; cache it so chat startup does not sort the same array repeatedly.
export function orderedActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  const cached = orderedActivitiesCache.get(activities);
  if (cached) {
    return cached;
  }

  const ordered = isActivityOrderStable(activities)
    ? activities
    : activities.toSorted(compareActivitiesByOrder);
  orderedActivitiesCache.set(activities, ordered);
  return ordered;
}

function compareActivitiesByOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  const lifecycleRankComparison =
    compareActivityLifecycleRank(left.kind) - compareActivityLifecycleRank(right.kind);
  if (lifecycleRankComparison !== 0) {
    return lifecycleRankComparison;
  }

  // Compaction progress and terminal rows can share a millisecond; keep the
  // progress row first so the work-log collapse can fold the pair (event ids
  // are random and would otherwise order them arbitrarily).
  if (left.kind === "context-compaction" && right.kind === "context-compaction") {
    const compactionRankComparison =
      contextCompactionOrderRank(left.summary) - contextCompactionOrderRank(right.summary);
    if (compactionRankComparison !== 0) {
      return compactionRankComparison;
    }
  }

  return left.id.localeCompare(right.id);
}

function contextCompactionOrderRank(summary: string): number {
  return isContextCompactionProgressLabel(summary) ? 0 : 1;
}

function compareActivityLifecycleRank(kind: string): number {
  if (kind.endsWith(".started") || kind === "tool.started") {
    return 0;
  }
  if (kind.endsWith(".progress") || kind.endsWith(".updated")) {
    return 1;
  }
  if (kind.endsWith(".completed") || kind.endsWith(".resolved")) {
    return 2;
  }
  return 1;
}
