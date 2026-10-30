import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import type {
  MossLoopLedgerDashboardSnapshot,
  MossLoopLedgerDashboardStatus,
  MossLoopLedgerEvidenceSummary,
  MossLoopLedgerGateCheck,
  MossLoopLedgerReviewSummary,
  MossLoopLedgerRoleSummary,
  MossLoopLedgerTaskSummary,
} from "@synara/contracts";
import {
  parseJsonLines,
  summarizeMossLoop,
  type MossLoopEvent,
  type MossLoopStatus,
  type MossLoopTask,
} from "./moss-loop-status.ts";
import {
  readMossReleaseGateReportArtifactIndex,
  type MossReleaseGateReportArtifactIndex,
} from "./moss-release-gate-report-index.ts";
import {
  readMossReleaseFreshnessRefreshPlanReportIndex,
  type MossReleaseFreshnessRefreshPlanReportIndex,
} from "./moss-release-freshness-refresh-plan-report-index.ts";

export interface MossLoopLedgerSnapshotOptions {
  readonly createdAt?: string;
  readonly reviewLimit?: number;
  readonly evidenceLimit?: number;
}

interface RoleManifest {
  readonly role: string;
  readonly responsibility: string;
}

const ROLE_ORDER = [
  "Product Steward",
  "Architect",
  "Runtime Adapter Engineer",
  "UI Parity Engineer",
  "Memory Curator",
  "QA Gatekeeper",
  "Release Operator",
  "Reviewer",
];

function unique(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(values)].filter((value) => value.length > 0);
}

function extractMarkdownSection(content: string, heading: string): string | null {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) {
    return null;
  }

  const sectionLines: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) {
      break;
    }
    sectionLines.push(line);
  }

  const section = sectionLines.join("\n").trim();
  return section.length > 0 ? section : null;
}

function firstHeading(content: string): string | null {
  return (
    content
      .split(/\r?\n/)
      .find((line) => line.startsWith("# "))
      ?.replace(/^#\s+/, "")
      .trim() ?? null
  );
}

function firstParagraph(markdown: string | null): string | null {
  if (!markdown) {
    return null;
  }

  return (
    markdown
      .split(/\n\s*\n/)
      .map((entry) => entry.replace(/\s+/g, " ").trim())
      .find((entry) => entry.length > 0) ?? null
  );
}

function listBullets(markdown: string | null): ReadonlyArray<string> {
  if (!markdown) {
    return [];
  }

  const bullets: string[] = [];
  let currentBullet: string | null = null;

  for (const line of markdown.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith("- ")) {
      if (currentBullet) {
        bullets.push(currentBullet);
      }
      currentBullet = trimmedLine.replace(/^-\s+/, "").trim();
      continue;
    }
    if (currentBullet && trimmedLine.length > 0 && /^\s+/.test(line)) {
      currentBullet = `${currentBullet} ${trimmedLine}`;
    }
  }

  if (currentBullet) {
    bullets.push(currentBullet);
  }

  return bullets.filter((line) => line.length > 0);
}

function extractBacktickRefs(markdown: string): ReadonlyArray<string> {
  return unique(
    [...markdown.matchAll(/`([^`]+)`/g)]
      .map((match) => match[1]?.trim() ?? "")
      .filter((value) => value.length > 0),
  );
}

function isCommandRef(value: string): boolean {
  return /^(bun|git|node|npm|pnpm|yarn)\b/.test(value);
}

function evidenceKind(value: string): MossLoopLedgerEvidenceSummary["kind"] {
  if (isCommandRef(value)) {
    return /\b(test|vitest)\b/.test(value) ? "test" : "command";
  }
  return /smoke/i.test(value) ? "smoke" : "file";
}

function evidenceStatus(value: string): MossLoopLedgerDashboardStatus {
  return /\b(blocked|error|fail|failed)\b/i.test(value) ? "blocked" : "pass";
}

function taskSummary(task: MossLoopTask): MossLoopLedgerTaskSummary {
  const normalizedStatus =
    task.status === "active" || task.status === "done" || task.status === "blocked"
      ? task.status
      : "pending";

  return {
    taskId: task.taskId,
    title: task.title,
    owner: task.owner,
    status: normalizedStatus,
    acceptanceCount: task.acceptance?.length ?? 0,
    evidenceCount: task.evidence?.length ?? 0,
  };
}

function taskIdForCorrelation(
  events: ReadonlyArray<MossLoopEvent>,
  correlationId: string | undefined,
): string {
  if (!correlationId) {
    return "unknown";
  }

  const taskStart = events
    .toReversed()
    .find((event) => event.type === "moss.task.started" && event.correlationId === correlationId);
  const taskId = taskStart?.payload?.taskId;
  return typeof taskId === "string" ? taskId : "unknown";
}

function normalizeReviewDecision(value: unknown): MossLoopLedgerReviewSummary["decision"] {
  if (value === "accepted") {
    return "accepted";
  }
  if (value === "blocked") {
    return "blocked";
  }
  return "needs-work";
}

function recentReviews(
  events: ReadonlyArray<MossLoopEvent>,
  limit: number,
): ReadonlyArray<MossLoopLedgerReviewSummary> {
  return events
    .filter((event) => event.type === "moss.review.completed")
    .toReversed()
    .slice(0, limit)
    .map((event) => ({
      eventId: event.eventId,
      taskId: taskIdForCorrelation(events, event.correlationId),
      role: event.actor?.role ?? "Reviewer",
      decision: normalizeReviewDecision(event.payload?.decision),
      createdAt: event.createdAt,
      notes: typeof event.payload?.notes === "string" ? event.payload.notes : "",
    }));
}

function recentEvidence(
  events: ReadonlyArray<MossLoopEvent>,
  limit: number,
): ReadonlyArray<MossLoopLedgerEvidenceSummary> {
  return unique(
    events
      .filter((event) => event.type === "moss.evidence.recorded")
      .toReversed()
      .flatMap((event) => event.evidence ?? []),
  )
    .slice(0, limit)
    .map((label) => ({
      label,
      kind: evidenceKind(label),
      status: evidenceStatus(label),
    }));
}

function roleSortKey(role: string): number {
  const index = ROLE_ORDER.indexOf(role);
  return index === -1 ? ROLE_ORDER.length : index;
}

function parseRoleManifest(content: string): RoleManifest {
  const role = firstHeading(content) ?? "Unknown Role";
  const responsibility = firstParagraph(extractMarkdownSection(content, "Mission")) ?? role;
  return {
    role,
    responsibility,
  };
}

function roleSummaries(
  roles: ReadonlyArray<RoleManifest>,
  tasks: ReadonlyArray<MossLoopTask>,
): ReadonlyArray<MossLoopLedgerRoleSummary> {
  return roles
    .map((role) => {
      const activeTaskCount = tasks.filter(
        (task) => task.owner === role.role && task.status === "active",
      ).length;
      const blockedTaskCount = tasks.filter(
        (task) => task.owner === role.role && task.status === "blocked",
      ).length;
      const roleStatus: MossLoopLedgerRoleSummary["status"] =
        blockedTaskCount > 0 ? "blocked" : activeTaskCount > 0 ? "assigned" : "idle";

      return {
        role: role.role,
        activeTaskCount,
        responsibility: role.responsibility,
        status: roleStatus,
      };
    })
    .toSorted((left, right) => {
      const byKnownOrder = roleSortKey(left.role) - roleSortKey(right.role);
      return byKnownOrder === 0 ? left.role.localeCompare(right.role) : byKnownOrder;
    });
}

function gateStatus(status: "pass" | "fail"): MossLoopLedgerDashboardStatus {
  return status === "pass" ? "pass" : "blocked";
}

function gateCheck(
  check: MossLoopStatus["releaseGate"]["checks"][number],
): MossLoopLedgerGateCheck {
  return {
    id: check.id,
    label: check.id
      .split("-")
      .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
      .join(" "),
    status: gateStatus(check.status),
    summary: check.summary,
    issueCount: check.issueCount,
  };
}

function releaseGateSummary(status: MossLoopStatus): string {
  if (status.releaseGate.status === "fail") {
    return `Ledger status is blocked by ${status.releaseGate.issueCount} issue(s).`;
  }

  return `Ledger status is passing with ${status.activeTasks.length} active task(s) and no completed task missing evidence.`;
}

function releaseFreshnessSummary(
  index: MossReleaseGateReportArtifactIndex | undefined,
): MossLoopLedgerDashboardSnapshot["releaseGate"]["freshness"] | undefined {
  if (!index) {
    return undefined;
  }

  const evidence = index.latest?.freshnessEvidence;
  const indexIssueCodes = index.issues.map((issue) => issue.code);
  const indexStaleArtifactMessages = index.issues
    .filter((issue) => issue.code === "stale-artifact")
    .map((issue) => issue.message);
  const issueCodes = index.issues.length > 0 ? indexIssueCodes : (evidence?.issueCodes ?? []);
  const staleArtifactMessages =
    index.issues.length > 0 ? indexStaleArtifactMessages : (evidence?.staleArtifactMessages ?? []);
  const readinessStatus =
    index.readiness.status === "fail"
      ? index.readiness.status
      : (evidence?.readinessStatus ?? "pass");
  const latestArtifactPath = evidence?.latestArtifactPath ?? index.latest?.path;
  const latestArtifactCreatedAt = evidence?.latestArtifactCreatedAt ?? index.latest?.createdAt;
  const latestArtifactStatus = evidence?.latestArtifactStatus ?? index.latest?.status;
  const latestArtifactGateCount = evidence?.latestArtifactGateCount ?? index.latest?.gateCount;

  return {
    status: readinessStatus === "pass" ? "pass" : "blocked",
    readinessStatus,
    summary: index.readiness.summary,
    manifestGateCount: index.manifest.gateCount,
    ...(latestArtifactGateCount !== undefined ? { latestArtifactGateCount } : {}),
    ...(latestArtifactPath ? { artifactPath: latestArtifactPath } : {}),
    ...(latestArtifactCreatedAt ? { latestArtifactCreatedAt } : {}),
    ...(latestArtifactStatus ? { latestArtifactStatus } : {}),
    issueCount: index.issues.length,
    issueCodes,
    staleArtifactMessages,
  };
}

function refreshPlanSummary(
  index: MossReleaseFreshnessRefreshPlanReportIndex | undefined,
): MossLoopLedgerDashboardSnapshot["releaseGate"]["refreshPlan"] | undefined {
  if (!index) {
    return undefined;
  }

  const latest = index.latest;
  const issueCodes = index.issues.map((issue) => issue.code);
  const readinessStatus = index.readiness.status;

  return {
    status: readinessStatus === "pass" ? "pass" : "blocked",
    readinessStatus,
    summary: index.readiness.summary,
    expectedStepCount: index.expectedStepOrder.length,
    ...(latest ? { latestStepCount: latest.stepOrder.length } : {}),
    ...(latest?.path ? { artifactPath: latest.path } : {}),
    ...(latest?.createdAt ? { latestArtifactCreatedAt: latest.createdAt } : {}),
    ...(latest?.status ? { latestArtifactStatus: latest.status } : {}),
    ...(latest?.mode ? { mode: latest.mode } : {}),
    ...(latest ? { writesFiles: latest.writesFiles } : {}),
    ...(latest ? { writesGlobalConfig: latest.writesGlobalConfig } : {}),
    ...(latest ? { providerCredentialsRequired: latest.providerCredentialsRequired } : {}),
    ...(latest ? { requiresReleaseArtifactRefresh: latest.requiresReleaseArtifactRefresh } : {}),
    ...(latest ? { requiresLoopFreshnessRefresh: latest.requiresLoopFreshnessRefresh } : {}),
    issueCount: index.issues.length,
    issueCodes,
  };
}

export function buildMossLoopLedgerDashboardSnapshot(input: {
  readonly mission: string;
  readonly currentContext: string;
  readonly evidenceIndex: string;
  readonly events: ReadonlyArray<MossLoopEvent>;
  readonly tasks: ReadonlyArray<MossLoopTask>;
  readonly roles: ReadonlyArray<RoleManifest>;
  readonly releaseGateReportIndex?: MossReleaseGateReportArtifactIndex | undefined;
  readonly refreshPlanReportIndex?: MossReleaseFreshnessRefreshPlanReportIndex | undefined;
  readonly options?: MossLoopLedgerSnapshotOptions;
}): MossLoopLedgerDashboardSnapshot {
  const generatedAt = input.options?.createdAt ?? new Date().toISOString();
  const reviewLimit = input.options?.reviewLimit ?? 3;
  const evidenceLimit = input.options?.evidenceLimit ?? 4;
  const status = summarizeMossLoop({
    mission: input.mission,
    events: input.events,
    tasks: input.tasks,
    roleFiles: input.roles.map((role) => `${role.role}.md`),
  });
  const indexedArtifacts = extractBacktickRefs(input.evidenceIndex);
  const allEvidenceRefs = [
    ...indexedArtifacts,
    ...input.tasks.flatMap((task) => task.evidence ?? []),
    ...input.events.flatMap((event) => event.evidence ?? []),
  ];
  const commandReferences = unique(allEvidenceRefs.filter(isCommandRef));
  const activeTasks = input.tasks.filter((task) => task.status === "active");
  const releaseFreshness = releaseFreshnessSummary(input.releaseGateReportIndex);
  const refreshPlan = refreshPlanSummary(input.refreshPlanReportIndex);

  return {
    version: 1,
    generatedAt,
    mission: {
      title: status.missionTitle,
      currentGoal: status.currentGoal ?? "No active Moss goal recorded.",
      branch: status.branch ?? "unknown",
      status: status.releaseGate.status === "fail" ? "blocked" : "active",
    },
    tasks: {
      total: input.tasks.length,
      counts: {
        active: status.taskCounts.active ?? 0,
        done: status.taskCounts.done ?? 0,
        blocked: status.taskCounts.blocked ?? 0,
      },
      active: activeTasks.map(taskSummary),
      next: listBullets(extractMarkdownSection(input.currentContext, "Next Tasks")),
    },
    reviews: {
      recent: recentReviews(input.events, reviewLimit),
    },
    evidence: {
      indexedArtifacts: indexedArtifacts.length,
      taskEvidenceReferences: input.tasks.reduce(
        (count, task) => count + (task.evidence?.length ?? 0),
        0,
      ),
      commandReferences: commandReferences.length,
      missingCompletedTaskEvidence: status.completedTasksMissingEvidence.length,
      recent: recentEvidence(input.events, evidenceLimit),
    },
    roles: roleSummaries(input.roles, input.tasks),
    releaseGate: {
      status: gateStatus(status.releaseGate.status),
      issueCount: status.releaseGate.issueCount,
      summary: releaseGateSummary(status),
      checks: status.releaseGate.checks.map(gateCheck),
      ...(releaseFreshness ? { freshness: releaseFreshness } : {}),
      ...(refreshPlan ? { refreshPlan } : {}),
    },
  };
}

export async function readMossLoopLedgerDashboardSnapshot(
  repoRoot = process.cwd(),
  options: MossLoopLedgerSnapshotOptions = {},
): Promise<MossLoopLedgerDashboardSnapshot> {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const normalizedOptions = {
    ...options,
    createdAt,
  };
  const mossRoot = join(repoRoot, ".moss");
  const roleDirectory = join(mossRoot, "roles");
  const roleFileNames = (await readdir(roleDirectory))
    .filter((file) => file.endsWith(".md"))
    .toSorted();
  const [mission, currentContext, evidenceIndex, eventsContent, tasksContent, roleContents] =
    await Promise.all([
      readFile(join(mossRoot, "mission.md"), "utf8"),
      readFile(join(mossRoot, "context", "current.md"), "utf8"),
      readFile(join(mossRoot, "ledger", "evidence", "README.md"), "utf8"),
      readFile(join(mossRoot, "ledger", "events.jsonl"), "utf8"),
      readFile(join(mossRoot, "ledger", "tasks.jsonl"), "utf8"),
      Promise.all(roleFileNames.map((file) => readFile(join(roleDirectory, file), "utf8"))),
    ]);
  const releaseGateReportIndex = readMossReleaseGateReportArtifactIndex(repoRoot, {
    generatedAt: createdAt,
  });
  const refreshPlanReportIndex = readMossReleaseFreshnessRefreshPlanReportIndex(repoRoot, {
    generatedAt: createdAt,
  });

  return buildMossLoopLedgerDashboardSnapshot({
    mission,
    currentContext,
    evidenceIndex,
    events: parseJsonLines<MossLoopEvent>(
      eventsContent,
      relative(repoRoot, join(mossRoot, "ledger", "events.jsonl")),
    ),
    tasks: parseJsonLines<MossLoopTask>(
      tasksContent,
      relative(repoRoot, join(mossRoot, "ledger", "tasks.jsonl")),
    ),
    roles: roleContents.map(parseRoleManifest),
    releaseGateReportIndex,
    refreshPlanReportIndex,
    options: normalizedOptions,
  });
}
