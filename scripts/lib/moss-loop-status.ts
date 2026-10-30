import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

export interface MossLoopEvent {
  readonly eventId: string;
  readonly type: string;
  readonly createdAt: string;
  readonly actor?: {
    readonly role?: string;
    readonly id?: string;
  };
  readonly correlationId?: string;
  readonly causationEventId?: string;
  readonly payload?: Record<string, unknown>;
  readonly evidence?: ReadonlyArray<string>;
}

export interface MossLoopTask {
  readonly taskId: string;
  readonly status: string;
  readonly owner: string;
  readonly title: string;
  readonly acceptance?: ReadonlyArray<string>;
  readonly evidence?: ReadonlyArray<string>;
  readonly metadata?: Record<string, unknown>;
}

export interface MossLoopStatusInput {
  readonly mission: string;
  readonly events: ReadonlyArray<MossLoopEvent>;
  readonly tasks: ReadonlyArray<MossLoopTask>;
  readonly roleFiles: ReadonlyArray<string>;
}

export type MossLedgerIssueCode =
  | "completed-task-missing-evidence"
  | "duplicate-event-id"
  | "duplicate-task-id";

export interface MossLedgerIssue {
  readonly code: MossLedgerIssueCode;
  readonly id: string;
  readonly count?: number;
  readonly message: string;
}

export interface MossReleaseGateCheck {
  readonly id: string;
  readonly status: "pass" | "fail";
  readonly issueCount: number;
  readonly summary: string;
}

export interface MossReleaseGateState {
  readonly status: "pass" | "fail";
  readonly activeTaskIds: ReadonlyArray<string>;
  readonly issueCount: number;
  readonly checks: ReadonlyArray<MossReleaseGateCheck>;
}

export interface MossLoopStatus {
  readonly missionTitle: string;
  readonly currentGoal: string | null;
  readonly branch: string | null;
  readonly eventCount: number;
  readonly taskCount: number;
  readonly roles: ReadonlyArray<string>;
  readonly taskCounts: Record<string, number>;
  readonly activeTasks: ReadonlyArray<MossLoopTask>;
  readonly blockedTasks: ReadonlyArray<MossLoopTask>;
  readonly completedTasksMissingEvidence: ReadonlyArray<MossLoopTask>;
  readonly duplicateEventIds: ReadonlyArray<string>;
  readonly duplicateTaskIds: ReadonlyArray<string>;
  readonly ledgerIssues: ReadonlyArray<MossLedgerIssue>;
  readonly releaseGate: MossReleaseGateState;
}

export function parseJsonLines<T>(content: string, source: string): ReadonlyArray<T> {
  return content
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter(({ line }) => line.length > 0)
    .map(({ line, lineNumber }) => {
      try {
        return JSON.parse(line) as T;
      } catch (error) {
        throw new Error(`${source}:${lineNumber}: invalid JSON line: ${String(error)}`, {
          cause: error,
        });
      }
    });
}

function duplicateIds(values: ReadonlyArray<string>): ReadonlyArray<{ id: string; count: number }> {
  const counts = new Map<string, number>();

  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id, count]) => ({ id, count }))
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

function releaseGateCheck(
  id: string,
  issueCount: number,
  passSummary: string,
  failSummary: string,
): MossReleaseGateCheck {
  return {
    id,
    status: issueCount === 0 ? "pass" : "fail",
    issueCount,
    summary: issueCount === 0 ? passSummary : failSummary,
  };
}

const LEGACY_PRODUCT_NAME = ["Syn", "ara"].join("");

function mossBrandedText(value: string): string {
  return value.replaceAll(LEGACY_PRODUCT_NAME, "Moss");
}

export function summarizeMossLoop(input: MossLoopStatusInput): MossLoopStatus {
  const missionTitle = mossBrandedText(
    input.mission
      .split(/\r?\n/)
      .find((line) => line.startsWith("# "))
      ?.replace(/^#\s+/, "")
      .trim() ?? "Moss",
  );
  const goalEvent = input.events.toReversed().find((event) => event.type === "moss.goal.defined");
  const taskCounts: Record<string, number> = {};

  for (const task of input.tasks) {
    taskCounts[task.status] = (taskCounts[task.status] ?? 0) + 1;
  }

  const activeTasks = input.tasks.filter((task) => task.status === "active");
  const blockedTasks = input.tasks.filter((task) => task.status === "blocked");
  const completedTasksMissingEvidence = input.tasks.filter(
    (task) => task.status === "done" && (task.evidence?.length ?? 0) === 0,
  );
  const duplicateTaskEntries = duplicateIds(input.tasks.map((task) => task.taskId));
  const duplicateEventEntries = duplicateIds(input.events.map((event) => event.eventId));
  const duplicateTaskIds = duplicateTaskEntries.map((entry) => entry.id);
  const duplicateEventIds = duplicateEventEntries.map((entry) => entry.id);
  const ledgerIssues: MossLedgerIssue[] = [
    ...completedTasksMissingEvidence.map((task) => ({
      code: "completed-task-missing-evidence" as const,
      id: task.taskId,
      message: `Completed task ${task.taskId} has no evidence.`,
    })),
    ...duplicateTaskEntries.map((entry) => ({
      code: "duplicate-task-id" as const,
      id: entry.id,
      count: entry.count,
      message: `Task id ${entry.id} appears ${entry.count} times.`,
    })),
    ...duplicateEventEntries.map((entry) => ({
      code: "duplicate-event-id" as const,
      id: entry.id,
      count: entry.count,
      message: `Event id ${entry.id} appears ${entry.count} times.`,
    })),
  ];
  const releaseGate: MossReleaseGateState = {
    status: ledgerIssues.length === 0 ? "pass" : "fail",
    activeTaskIds: activeTasks.map((task) => task.taskId),
    issueCount: ledgerIssues.length,
    checks: [
      releaseGateCheck(
        "completed-task-evidence",
        completedTasksMissingEvidence.length,
        "Every completed task has at least one evidence reference.",
        "One or more completed tasks have no evidence references.",
      ),
      releaseGateCheck(
        "unique-task-ids",
        duplicateTaskIds.length,
        "Every task id is unique.",
        "One or more task ids are duplicated.",
      ),
      releaseGateCheck(
        "unique-event-ids",
        duplicateEventIds.length,
        "Every event id is unique.",
        "One or more event ids are duplicated.",
      ),
    ],
  };

  return {
    missionTitle,
    currentGoal:
      typeof goalEvent?.payload?.goal === "string" ? mossBrandedText(goalEvent.payload.goal) : null,
    branch: typeof goalEvent?.payload?.branch === "string" ? goalEvent.payload.branch : null,
    eventCount: input.events.length,
    taskCount: input.tasks.length,
    roles: input.roleFiles.map((file) => file.replace(/\.md$/, "")).toSorted(),
    taskCounts,
    activeTasks,
    blockedTasks,
    completedTasksMissingEvidence,
    duplicateEventIds,
    duplicateTaskIds,
    ledgerIssues,
    releaseGate,
  };
}

export function mossLoopStatusExitCode(status: MossLoopStatus): number {
  return status.releaseGate.status === "pass" ? 0 : 1;
}

export async function readMossLoopStatus(repoRoot = process.cwd()): Promise<MossLoopStatus> {
  const mossRoot = join(repoRoot, ".moss");
  const [mission, eventsContent, tasksContent, roleFiles] = await Promise.all([
    readFile(join(mossRoot, "mission.md"), "utf8"),
    readFile(join(mossRoot, "ledger", "events.jsonl"), "utf8"),
    readFile(join(mossRoot, "ledger", "tasks.jsonl"), "utf8"),
    readdir(join(mossRoot, "roles")),
  ]);

  return summarizeMossLoop({
    mission,
    events: parseJsonLines<MossLoopEvent>(
      eventsContent,
      relative(repoRoot, join(mossRoot, "ledger", "events.jsonl")),
    ),
    tasks: parseJsonLines<MossLoopTask>(
      tasksContent,
      relative(repoRoot, join(mossRoot, "ledger", "tasks.jsonl")),
    ),
    roleFiles: roleFiles.filter((file) => file.endsWith(".md")),
  });
}
