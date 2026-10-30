import { Schema } from "effect";
import { IsoDateTime, NonNegativeInt } from "./baseSchemas";

export const MossLoopLedgerDashboardStatus = Schema.Literals(["pass", "pending", "blocked"]);
export type MossLoopLedgerDashboardStatus = typeof MossLoopLedgerDashboardStatus.Type;

export const MossLoopLedgerTaskSummary = Schema.Struct({
  taskId: Schema.String,
  title: Schema.String,
  owner: Schema.String,
  status: Schema.Literals(["active", "done", "blocked", "pending"]),
  acceptanceCount: NonNegativeInt,
  evidenceCount: NonNegativeInt,
});
export type MossLoopLedgerTaskSummary = typeof MossLoopLedgerTaskSummary.Type;

export const MossLoopLedgerReviewSummary = Schema.Struct({
  eventId: Schema.String,
  taskId: Schema.String,
  role: Schema.String,
  decision: Schema.Literals(["accepted", "needs-work", "blocked"]),
  createdAt: IsoDateTime,
  notes: Schema.String,
});
export type MossLoopLedgerReviewSummary = typeof MossLoopLedgerReviewSummary.Type;

export const MossLoopLedgerEvidenceSummary = Schema.Struct({
  label: Schema.String,
  kind: Schema.Literals(["file", "command", "smoke", "test"]),
  status: MossLoopLedgerDashboardStatus,
});
export type MossLoopLedgerEvidenceSummary = typeof MossLoopLedgerEvidenceSummary.Type;

export const MossLoopLedgerRoleSummary = Schema.Struct({
  role: Schema.String,
  activeTaskCount: NonNegativeInt,
  responsibility: Schema.String,
  status: Schema.Literals(["assigned", "idle", "blocked"]),
});
export type MossLoopLedgerRoleSummary = typeof MossLoopLedgerRoleSummary.Type;

export const MossLoopLedgerGateCheck = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  status: MossLoopLedgerDashboardStatus,
  summary: Schema.String,
  issueCount: NonNegativeInt,
});
export type MossLoopLedgerGateCheck = typeof MossLoopLedgerGateCheck.Type;

export const MossLoopLedgerReleaseFreshnessSummary = Schema.Struct({
  status: MossLoopLedgerDashboardStatus,
  readinessStatus: Schema.Literals(["pass", "fail"]),
  summary: Schema.String,
  manifestGateCount: NonNegativeInt,
  latestArtifactGateCount: Schema.optional(NonNegativeInt),
  artifactPath: Schema.optional(Schema.String),
  latestArtifactCreatedAt: Schema.optional(IsoDateTime),
  latestArtifactStatus: Schema.optional(Schema.Literals(["pass", "fail"])),
  issueCount: NonNegativeInt,
  issueCodes: Schema.Array(Schema.String),
  staleArtifactMessages: Schema.Array(Schema.String),
});
export type MossLoopLedgerReleaseFreshnessSummary =
  typeof MossLoopLedgerReleaseFreshnessSummary.Type;

export const MossLoopLedgerRefreshPlanSummary = Schema.Struct({
  status: MossLoopLedgerDashboardStatus,
  readinessStatus: Schema.Literals(["pass", "fail"]),
  summary: Schema.String,
  expectedStepCount: NonNegativeInt,
  latestStepCount: Schema.optional(NonNegativeInt),
  artifactPath: Schema.optional(Schema.String),
  latestArtifactCreatedAt: Schema.optional(IsoDateTime),
  latestArtifactStatus: Schema.optional(Schema.Literals(["pass", "fail"])),
  mode: Schema.optional(Schema.String),
  writesFiles: Schema.optional(Schema.Boolean),
  writesGlobalConfig: Schema.optional(Schema.Boolean),
  providerCredentialsRequired: Schema.optional(Schema.Boolean),
  requiresReleaseArtifactRefresh: Schema.optional(Schema.Boolean),
  requiresLoopFreshnessRefresh: Schema.optional(Schema.Boolean),
  issueCount: NonNegativeInt,
  issueCodes: Schema.Array(Schema.String),
});
export type MossLoopLedgerRefreshPlanSummary = typeof MossLoopLedgerRefreshPlanSummary.Type;

export const MossLoopLedgerDashboardSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  generatedAt: IsoDateTime,
  mission: Schema.Struct({
    title: Schema.String,
    currentGoal: Schema.String,
    branch: Schema.String,
    status: Schema.Literals(["active", "complete", "blocked"]),
  }),
  tasks: Schema.Struct({
    total: NonNegativeInt,
    counts: Schema.Struct({
      active: NonNegativeInt,
      done: NonNegativeInt,
      blocked: NonNegativeInt,
    }),
    active: Schema.Array(MossLoopLedgerTaskSummary),
    next: Schema.Array(Schema.String),
  }),
  reviews: Schema.Struct({
    recent: Schema.Array(MossLoopLedgerReviewSummary),
  }),
  evidence: Schema.Struct({
    indexedArtifacts: NonNegativeInt,
    taskEvidenceReferences: NonNegativeInt,
    commandReferences: NonNegativeInt,
    missingCompletedTaskEvidence: NonNegativeInt,
    recent: Schema.Array(MossLoopLedgerEvidenceSummary),
  }),
  roles: Schema.Array(MossLoopLedgerRoleSummary),
  releaseGate: Schema.Struct({
    status: MossLoopLedgerDashboardStatus,
    issueCount: NonNegativeInt,
    summary: Schema.String,
    checks: Schema.Array(MossLoopLedgerGateCheck),
    freshness: Schema.optional(MossLoopLedgerReleaseFreshnessSummary),
    refreshPlan: Schema.optional(MossLoopLedgerRefreshPlanSummary),
  }),
});
export type MossLoopLedgerDashboardSnapshot = typeof MossLoopLedgerDashboardSnapshot.Type;

export interface MossLoopLedgerDashboardModel {
  readonly generatedAt: string;
  readonly status: MossLoopLedgerDashboardStatus;
  readonly statusLabel: string;
  readonly statusSummary: string;
  readonly metricRows: ReadonlyArray<DashboardMetric>;
  readonly activeTasks: ReadonlyArray<MossLoopLedgerTaskSummary>;
  readonly recentReviews: ReadonlyArray<MossLoopLedgerReviewSummary>;
  readonly evidenceRows: ReadonlyArray<MossLoopLedgerEvidenceSummary>;
  readonly roles: ReadonlyArray<MossLoopLedgerRoleSummary>;
  readonly gateChecks: ReadonlyArray<MossLoopLedgerGateCheck>;
  readonly releaseFreshness: MossLoopLedgerDashboardReleaseFreshnessModel | null;
  readonly refreshPlan: MossLoopLedgerDashboardRefreshPlanModel | null;
}

export interface DashboardMetric {
  readonly label: string;
  readonly value: string;
  readonly tone?: MossLoopLedgerDashboardStatus | "muted";
}

export interface MossLoopLedgerDashboardReleaseFreshnessModel {
  readonly status: MossLoopLedgerDashboardStatus;
  readonly statusLabel: string;
  readonly readinessLabel: string;
  readonly manifestGateCountLabel: string;
  readonly latestArtifactGateCountLabel: string;
  readonly issueCountLabel: string;
  readonly artifactPathLabel: string;
  readonly summary: string;
}

export interface MossLoopLedgerDashboardRefreshPlanModel {
  readonly status: MossLoopLedgerDashboardStatus;
  readonly statusLabel: string;
  readonly readinessLabel: string;
  readonly expectedStepCountLabel: string;
  readonly latestStepCountLabel: string;
  readonly issueCountLabel: string;
  readonly artifactPathLabel: string;
  readonly latestArtifactStatusLabel: string;
  readonly modeLabel: string;
  readonly writeFlagsLabel: string;
  readonly refreshStateLabel: string;
  readonly summary: string;
}

export function deriveMossLoopLedgerDashboardModel(
  snapshot: MossLoopLedgerDashboardSnapshot,
): MossLoopLedgerDashboardModel {
  const releaseFreshness = releaseFreshnessModel(snapshot.releaseGate.freshness);
  const refreshPlan = refreshPlanModel(snapshot.releaseGate.refreshPlan);

  return {
    generatedAt: snapshot.generatedAt,
    status: snapshot.releaseGate.status,
    statusLabel: statusLabel(snapshot.releaseGate.status),
    statusSummary: snapshot.releaseGate.summary,
    metricRows: [
      {
        label: "Tasks",
        value: `${snapshot.tasks.counts.done}/${snapshot.tasks.total} done`,
        tone: snapshot.tasks.counts.blocked > 0 ? "blocked" : "muted",
      },
      {
        label: "Active",
        value: String(snapshot.tasks.counts.active),
        tone: snapshot.tasks.counts.active > 0 ? "pending" : "muted",
      },
      {
        label: "Evidence",
        value: String(snapshot.evidence.taskEvidenceReferences),
        tone: snapshot.evidence.missingCompletedTaskEvidence > 0 ? "blocked" : "muted",
      },
      {
        label: "Roles",
        value: String(snapshot.roles.length),
        tone: snapshot.roles.some((role) => role.status === "blocked") ? "blocked" : "muted",
      },
      ...(releaseFreshness
        ? [
            {
              label: "Freshness",
              value: `${releaseFreshness.latestArtifactGateCountLabel}/${releaseFreshness.manifestGateCountLabel} gates`,
              tone: releaseFreshness.status,
            } satisfies DashboardMetric,
          ]
        : []),
      ...(refreshPlan
        ? [
            {
              label: "Refresh Plan",
              value: `${refreshPlan.latestStepCountLabel}/${refreshPlan.expectedStepCountLabel} steps`,
              tone: refreshPlan.status,
            } satisfies DashboardMetric,
          ]
        : []),
    ],
    activeTasks: snapshot.tasks.active,
    recentReviews: snapshot.reviews.recent,
    evidenceRows: snapshot.evidence.recent,
    roles: snapshot.roles,
    gateChecks: snapshot.releaseGate.checks,
    releaseFreshness,
    refreshPlan,
  };
}

function statusLabel(status: MossLoopLedgerDashboardStatus): string {
  switch (status) {
    case "pass":
      return "Pass";
    case "pending":
      return "Pending";
    case "blocked":
      return "Blocked";
  }
}

function releaseFreshnessModel(
  freshness: MossLoopLedgerReleaseFreshnessSummary | undefined,
): MossLoopLedgerDashboardReleaseFreshnessModel | null {
  if (!freshness) {
    return null;
  }

  return {
    status: freshness.status,
    statusLabel: statusLabel(freshness.status),
    readinessLabel: freshness.readinessStatus,
    manifestGateCountLabel: String(freshness.manifestGateCount),
    latestArtifactGateCountLabel:
      freshness.latestArtifactGateCount === undefined
        ? "none"
        : String(freshness.latestArtifactGateCount),
    issueCountLabel: String(freshness.issueCount),
    artifactPathLabel: freshness.artifactPath ?? "No release gate report artifact",
    summary: freshness.summary,
  };
}

function yesNo(value: boolean | undefined): string {
  if (value === undefined) {
    return "unknown";
  }
  return value ? "yes" : "no";
}

function refreshPlanModel(
  refreshPlan: MossLoopLedgerRefreshPlanSummary | undefined,
): MossLoopLedgerDashboardRefreshPlanModel | null {
  if (!refreshPlan) {
    return null;
  }

  return {
    status: refreshPlan.status,
    statusLabel: statusLabel(refreshPlan.status),
    readinessLabel: refreshPlan.readinessStatus,
    expectedStepCountLabel: String(refreshPlan.expectedStepCount),
    latestStepCountLabel:
      refreshPlan.latestStepCount === undefined ? "none" : String(refreshPlan.latestStepCount),
    issueCountLabel: String(refreshPlan.issueCount),
    artifactPathLabel: refreshPlan.artifactPath ?? "No refresh plan report artifact",
    latestArtifactStatusLabel: refreshPlan.latestArtifactStatus ?? "none",
    modeLabel: refreshPlan.mode ?? "unknown",
    writeFlagsLabel: `files ${yesNo(refreshPlan.writesFiles)} / global ${yesNo(
      refreshPlan.writesGlobalConfig,
    )} / creds ${yesNo(refreshPlan.providerCredentialsRequired)}`,
    refreshStateLabel: `release ${yesNo(
      refreshPlan.requiresReleaseArtifactRefresh,
    )} / loop ${yesNo(refreshPlan.requiresLoopFreshnessRefresh)}`,
    summary: refreshPlan.summary,
  };
}
