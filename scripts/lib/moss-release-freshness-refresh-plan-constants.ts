export const MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER = [
  "strict-release-report-stale-proof",
  "loop-packet-freshness-artifact-refresh",
  "loop-packet-freshness-report-index",
  "release-freshness-refresh-plan-report-refresh",
  "release-freshness-refresh-plan-report-index",
  "loop-packet-refresh-plan-report-refresh",
  "loop-packet-refresh-plan-report-index",
  "release-report-artifact-refresh",
  "release-report-artifact-index",
  "compact-release-report",
  "final-release-gate",
] as const;

export type MossReleaseFreshnessRefreshPlanStepId =
  (typeof MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER)[number];
