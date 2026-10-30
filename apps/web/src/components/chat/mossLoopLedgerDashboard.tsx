// FILE: mossLoopLedgerDashboard.tsx
// Purpose: Render a typed Moss loop-ledger snapshot without exposing raw JSONL to UI components.
// Layer: Web chat control-plane presentation helper
// Exports: dashboard snapshot renderer and model re-exports

import { type ReactNode, useMemo } from "react";

import { cn } from "~/lib/utils";
import {
  deriveMossLoopLedgerDashboardModel,
  type DashboardMetric,
  type MossLoopLedgerDashboardReleaseFreshnessModel,
  type MossLoopLedgerDashboardRefreshPlanModel,
  type MossLoopLedgerDashboardProps,
  type MossLoopLedgerDashboardStatus,
  type MossLoopLedgerEvidenceSummary,
  type MossLoopLedgerGateCheck,
  type MossLoopLedgerReviewSummary,
  type MossLoopLedgerRoleSummary,
  type MossLoopLedgerTaskSummary,
} from "./mossLoopLedgerDashboardModel";

export {
  deriveMossLoopLedgerDashboardModel,
  MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT,
} from "./mossLoopLedgerDashboardModel";
export type {
  DashboardMetric,
  MossLoopLedgerDashboardReleaseFreshnessModel,
  MossLoopLedgerDashboardRefreshPlanModel,
  MossLoopLedgerDashboardModel,
  MossLoopLedgerDashboardProps,
  MossLoopLedgerDashboardSnapshot,
  MossLoopLedgerDashboardStatus,
  MossLoopLedgerEvidenceSummary,
  MossLoopLedgerGateCheck,
  MossLoopLedgerReviewSummary,
  MossLoopLedgerRoleSummary,
  MossLoopLedgerTaskSummary,
} from "./mossLoopLedgerDashboardModel";

export function MossLoopLedgerDashboard({ snapshot, className }: MossLoopLedgerDashboardProps) {
  const model = useMemo(() => deriveMossLoopLedgerDashboardModel(snapshot), [snapshot]);

  return (
    <div
      className={cn("space-y-3 px-3 py-2 text-ui-lg", className)}
      data-moss-loop-ledger-dashboard=""
      data-status={model.status}
    >
      <header className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="font-medium text-foreground">Loop Ledger</div>
            <div className="mt-0.5 text-ui-sm text-muted-foreground">
              {snapshot.mission.branch} / {formatTime(snapshot.generatedAt)}
            </div>
          </div>
          <span
            className={cn(
              "rounded-md border px-2 py-1 text-ui-sm font-medium",
              statusBadgeClassName(model.status),
            )}
            data-moss-ledger-release-gate=""
            data-status={model.status}
          >
            {model.statusLabel}
          </span>
        </div>
        <p className="text-ui-sm leading-5 text-muted-foreground">{snapshot.mission.currentGoal}</p>
      </header>

      <dl className="grid grid-cols-2 gap-2" data-moss-ledger-metrics="">
        {model.metricRows.map((metric) => (
          <div
            key={metric.label}
            className="rounded-md border border-border/60 bg-background px-2.5 py-2"
          >
            <dt className="text-ui-sm text-muted-foreground">{metric.label}</dt>
            <dd className={cn("mt-1 text-lg font-semibold", metricClassName(metric.tone))}>
              {metric.value}
            </dd>
          </div>
        ))}
      </dl>

      <DashboardSection title="Active Tasks" emptyLabel="No active tasks">
        {model.activeTasks.map((task) => (
          <TaskRow key={task.taskId} task={task} />
        ))}
      </DashboardSection>

      <DashboardSection title="Recent Reviews" emptyLabel="No recent reviews">
        {model.recentReviews.map((review) => (
          <ReviewRow key={review.eventId} review={review} />
        ))}
      </DashboardSection>

      <DashboardSection title="Evidence" emptyLabel="No evidence">
        <div className="grid grid-cols-3 gap-2 text-ui-sm" data-moss-ledger-evidence-counts="">
          <CountPill label="Indexed" value={snapshot.evidence.indexedArtifacts} />
          <CountPill label="Commands" value={snapshot.evidence.commandReferences} />
          <CountPill label="Missing" value={snapshot.evidence.missingCompletedTaskEvidence} />
        </div>
        {model.evidenceRows.map((evidence) => (
          <EvidenceRow key={`${evidence.kind}:${evidence.label}`} evidence={evidence} />
        ))}
      </DashboardSection>

      <DashboardSection title="Roles" emptyLabel="No role manifests">
        {model.roles.map((role) => (
          <RoleRow key={role.role} role={role} />
        ))}
      </DashboardSection>

      <DashboardSection title="Release Gate" emptyLabel="No gate checks">
        <p className="text-ui-sm leading-5 text-muted-foreground">{model.statusSummary}</p>
        <ReleaseFreshnessSummary freshness={model.releaseFreshness} />
        <RefreshPlanSummary refreshPlan={model.refreshPlan} />
        {model.gateChecks.map((check) => (
          <GateCheckRow key={check.id} check={check} />
        ))}
      </DashboardSection>
    </div>
  );
}

function DashboardSection({
  title,
  emptyLabel,
  children,
}: {
  readonly title: string;
  readonly emptyLabel: string;
  readonly children: ReactNode;
}) {
  const items = Array.isArray(children) ? children.filter(Boolean) : children;
  const empty = Array.isArray(items) ? items.length === 0 : !items;

  return (
    <section className="space-y-1.5" data-moss-ledger-section={title}>
      <div className="text-ui-sm font-medium uppercase tracking-normal text-muted-foreground">
        {title}
      </div>
      {empty ? <div className="text-ui-sm text-muted-foreground">{emptyLabel}</div> : items}
    </section>
  );
}

function TaskRow({ task }: { readonly task: MossLoopLedgerTaskSummary }) {
  return (
    <article
      className="rounded-md border border-border/60 bg-background px-2.5 py-2"
      data-moss-ledger-task=""
      data-status={task.status}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-medium text-foreground">{task.taskId}</span>
        <span className="shrink-0 text-ui-sm text-muted-foreground">{task.owner}</span>
      </div>
      <div className="mt-1 text-ui-sm leading-5 text-muted-foreground">{task.title}</div>
      <div className="mt-2 flex flex-wrap gap-1.5 text-ui-sm">
        <span className="rounded border border-border/60 px-1.5 py-0.5">
          {task.acceptanceCount} acceptance
        </span>
        <span className="rounded border border-border/60 px-1.5 py-0.5">
          {task.evidenceCount} evidence
        </span>
      </div>
    </article>
  );
}

function ReviewRow({ review }: { readonly review: MossLoopLedgerReviewSummary }) {
  return (
    <article
      className="rounded-md border border-border/60 bg-background px-2.5 py-2"
      data-moss-ledger-review=""
      data-decision={review.decision}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-foreground">{review.taskId}</span>
        <span className={cn("text-ui-sm", statusTextClassName(decisionStatus(review.decision)))}>
          {review.decision}
        </span>
      </div>
      <div className="mt-1 text-ui-sm text-muted-foreground">
        {review.role} / {formatTime(review.createdAt)}
      </div>
      <p className="mt-1 line-clamp-2 text-ui-sm leading-5 text-muted-foreground">{review.notes}</p>
    </article>
  );
}

function EvidenceRow({ evidence }: { readonly evidence: MossLoopLedgerEvidenceSummary }) {
  return (
    <div
      className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-background px-2.5 py-2 text-ui-sm"
      data-moss-ledger-evidence=""
      data-status={evidence.status}
    >
      <span className="min-w-0 truncate text-muted-foreground">{evidence.label}</span>
      <span className={cn("shrink-0", statusTextClassName(evidence.status))}>{evidence.kind}</span>
    </div>
  );
}

function RoleRow({ role }: { readonly role: MossLoopLedgerRoleSummary }) {
  return (
    <div
      className="rounded-md border border-border/60 bg-background px-2.5 py-2"
      data-moss-ledger-role=""
      data-status={role.status}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-foreground">{role.role}</span>
        <span
          className={cn(
            "text-ui-sm",
            role.status === "blocked" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {role.activeTaskCount} active
        </span>
      </div>
      <p className="mt-1 text-ui-sm leading-5 text-muted-foreground">{role.responsibility}</p>
    </div>
  );
}

function GateCheckRow({ check }: { readonly check: MossLoopLedgerGateCheck }) {
  return (
    <div
      className="rounded-md border border-border/60 bg-background px-2.5 py-2"
      data-moss-ledger-gate-check=""
      data-status={check.status}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-foreground">{check.label}</span>
        <span className={cn("text-ui-sm", statusTextClassName(check.status))}>
          {check.issueCount} issues
        </span>
      </div>
      <div className="mt-1 text-ui-sm leading-5 text-muted-foreground">{check.summary}</div>
    </div>
  );
}

function ReleaseFreshnessSummary({
  freshness,
}: {
  readonly freshness: MossLoopLedgerDashboardReleaseFreshnessModel | null;
}) {
  if (!freshness) {
    return (
      <div
        className="rounded-md border border-border/60 bg-background px-2.5 py-2 text-ui-sm text-muted-foreground"
        data-moss-ledger-release-freshness="missing"
        data-status="pending"
      >
        Freshness evidence unavailable
      </div>
    );
  }

  return (
    <div
      className="space-y-2 rounded-md border border-border/60 bg-background px-2.5 py-2 text-ui-sm"
      data-moss-ledger-release-freshness=""
      data-status={freshness.status}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-foreground">Artifact freshness</span>
        <span className={cn("shrink-0", statusTextClassName(freshness.status))}>
          {freshness.statusLabel}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-2">
        <FreshnessMetric label="Readiness" value={freshness.readinessLabel} />
        <FreshnessMetric label="Issues" value={freshness.issueCountLabel} />
        <FreshnessMetric label="Manifest gates" value={freshness.manifestGateCountLabel} />
        <FreshnessMetric label="Latest gates" value={freshness.latestArtifactGateCountLabel} />
      </dl>
      <div className="truncate text-muted-foreground">{freshness.artifactPathLabel}</div>
      <p className="leading-5 text-muted-foreground">{freshness.summary}</p>
    </div>
  );
}

function RefreshPlanSummary({
  refreshPlan,
}: {
  readonly refreshPlan: MossLoopLedgerDashboardRefreshPlanModel | null;
}) {
  if (!refreshPlan) {
    return (
      <div
        className="rounded-md border border-border/60 bg-background px-2.5 py-2 text-ui-sm text-muted-foreground"
        data-moss-ledger-refresh-plan="missing"
        data-status="pending"
      >
        Refresh plan evidence unavailable
      </div>
    );
  }

  return (
    <div
      className="space-y-2 rounded-md border border-border/60 bg-background px-2.5 py-2 text-ui-sm"
      data-moss-ledger-refresh-plan=""
      data-status={refreshPlan.status}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-foreground">Refresh plan</span>
        <span className={cn("shrink-0", statusTextClassName(refreshPlan.status))}>
          {refreshPlan.statusLabel}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-2">
        <FreshnessMetric label="Readiness" value={refreshPlan.readinessLabel} />
        <FreshnessMetric label="Issues" value={refreshPlan.issueCountLabel} />
        <FreshnessMetric label="Steps" value={refreshPlan.latestStepCountLabel} />
        <FreshnessMetric label="Expected" value={refreshPlan.expectedStepCountLabel} />
        <FreshnessMetric label="Artifact status" value={refreshPlan.latestArtifactStatusLabel} />
        <FreshnessMetric label="Mode" value={refreshPlan.modeLabel} />
      </dl>
      <div className="text-muted-foreground">{refreshPlan.writeFlagsLabel}</div>
      <div className="text-muted-foreground">{refreshPlan.refreshStateLabel}</div>
      <div className="truncate text-muted-foreground">{refreshPlan.artifactPathLabel}</div>
      <p className="leading-5 text-muted-foreground">{refreshPlan.summary}</p>
    </div>
  );
}

function FreshnessMetric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium text-foreground">{value}</dd>
    </div>
  );
}

function CountPill({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <div className="rounded-md border border-border/60 bg-background px-2 py-1.5">
      <div className="text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-semibold text-foreground">{value}</div>
    </div>
  );
}

function decisionStatus(
  decision: MossLoopLedgerReviewSummary["decision"],
): MossLoopLedgerDashboardStatus {
  if (decision === "accepted") return "pass";
  if (decision === "blocked") return "blocked";
  return "pending";
}

function statusBadgeClassName(status: MossLoopLedgerDashboardStatus): string {
  switch (status) {
    case "pass":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "pending":
      return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "blocked":
      return "border-destructive/40 bg-destructive/10 text-destructive";
  }
}

function statusTextClassName(status: MossLoopLedgerDashboardStatus): string {
  switch (status) {
    case "pass":
      return "text-emerald-700 dark:text-emerald-300";
    case "pending":
      return "text-amber-700 dark:text-amber-300";
    case "blocked":
      return "text-destructive";
  }
}

function metricClassName(tone: DashboardMetric["tone"]): string {
  if (tone === "blocked") return "text-destructive";
  if (tone === "pending") return "text-amber-700 dark:text-amber-300";
  if (tone === "pass") return "text-emerald-700 dark:text-emerald-300";
  return "text-foreground";
}

function formatTime(value: string): string {
  return value.replace("T", " ").replace(".000Z", "Z");
}
