import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { readMossIterationPacket, type MossIterationPacket } from "./moss-iteration-packet.ts";
import {
  parseJsonLines,
  readMossLoopStatus,
  type MossLoopEvent,
  type MossLoopStatus,
  type MossLoopTask,
} from "./moss-loop-status.ts";

const execFileAsync = promisify(execFile);

export interface MossReviewPacketOptions {
  readonly createdAt?: string;
  readonly taskId?: string;
  readonly eventLimit?: number;
  readonly changedFiles?: ReadonlyArray<string>;
}

export interface MossReviewChangedFile {
  readonly path: string;
  readonly status: string;
  readonly raw: string;
}

export interface MossReviewIssue {
  readonly code:
    | "changed-files-empty"
    | "qa-evidence-missing"
    | "release-gate-failed"
    | "reviewer-decision-pending"
    | "reviewer-role-invalid"
    | "reviewer-self-approval";
  readonly severity: "warning" | "error";
  readonly message: string;
}

export interface MossReviewCheck {
  readonly id: string;
  readonly status: "pass" | "pending" | "fail";
  readonly summary: string;
  readonly issueCodes: ReadonlyArray<MossReviewIssue["code"]>;
}

export interface MossReviewPacket {
  readonly version: 1;
  readonly generatedAt: string;
  readonly sourceFiles: ReadonlyArray<string>;
  readonly task: {
    readonly taskId: string;
    readonly title: string;
    readonly owner: string;
    readonly status: string;
    readonly correlationId: string | null;
  };
  readonly iterationPacket: {
    readonly objective: string;
    readonly roleAssignments: MossIterationPacket["roleAssignments"];
    readonly fileScope: MossIterationPacket["fileScope"];
    readonly acceptance: MossIterationPacket["acceptance"];
    readonly requiredVerificationCommands: MossIterationPacket["requiredVerificationCommands"];
  };
  readonly changedFiles: ReadonlyArray<MossReviewChangedFile>;
  readonly qaEvidence: {
    readonly taskEvidenceRefs: ReadonlyArray<string>;
    readonly eventEvidenceRefs: ReadonlyArray<string>;
    readonly commandRefs: ReadonlyArray<string>;
    readonly artifactRefs: ReadonlyArray<string>;
    readonly evidenceEventIds: ReadonlyArray<string>;
  };
  readonly reviewerDecision: {
    readonly eventId: string;
    readonly actorRole: string | null;
    readonly decision: string | null;
    readonly notes: string | null;
    readonly evidence: ReadonlyArray<string>;
  } | null;
  readonly ledger: {
    readonly eventCount: number;
    readonly taskCount: number;
    readonly releaseGateStatus: "pass" | "fail";
    readonly issueCount: number;
    readonly activeTaskIds: ReadonlyArray<string>;
  };
  readonly recentEvents: ReadonlyArray<{
    readonly eventId: string;
    readonly type: string;
    readonly createdAt: string;
    readonly actorRole: string | null;
    readonly correlationId: string | null;
    readonly evidence: ReadonlyArray<string>;
  }>;
  readonly checks: ReadonlyArray<MossReviewCheck>;
  readonly issues: ReadonlyArray<MossReviewIssue>;
  readonly readiness: {
    readonly status: "ready" | "pending" | "blocked";
    readonly summary: string;
  };
}

function unique(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(values)].filter((value) => value.length > 0);
}

function isCommandRef(value: string): boolean {
  return /^(bun|git|node|npm|pnpm|yarn)\b/.test(value);
}

function normalizeChangedFiles(
  values: ReadonlyArray<string>,
): ReadonlyArray<MossReviewChangedFile> {
  return values.map((path) => ({
    path,
    status: "specified",
    raw: path,
  }));
}

function parseGitStatus(stdout: string): ReadonlyArray<MossReviewChangedFile> {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((raw) => {
      const status = raw.slice(0, 2).trim() || "changed";
      const pathPart = raw.slice(3).trim();
      const path = pathPart.includes(" -> ")
        ? (pathPart.split(" -> ").at(-1) ?? pathPart)
        : pathPart;
      return {
        path,
        status,
        raw,
      };
    });
}

async function readGitChangedFiles(
  repoRoot: string,
): Promise<ReadonlyArray<MossReviewChangedFile>> {
  const { stdout } = await execFileAsync("git", ["status", "--short", "--untracked-files=all"], {
    cwd: repoRoot,
  });
  return parseGitStatus(String(stdout));
}

function selectTargetTask(
  tasks: ReadonlyArray<MossLoopTask>,
  iterationPacket: MossIterationPacket,
) {
  const task = tasks.find((entry) => entry.taskId === iterationPacket.task.taskId);
  if (!task) {
    throw new Error(`Moss review target task not found: ${iterationPacket.task.taskId}`);
  }
  return task;
}

function findTaskCorrelation(events: ReadonlyArray<MossLoopEvent>, taskId: string): string | null {
  const startEvent = events
    .toReversed()
    .find((event) => event.type === "moss.task.started" && event.payload?.taskId === taskId);
  return startEvent?.correlationId ?? null;
}

function compactEvent(event: MossLoopEvent): MossReviewPacket["recentEvents"][number] {
  return {
    eventId: event.eventId,
    type: event.type,
    createdAt: event.createdAt,
    actorRole: event.actor?.role ?? null,
    correlationId: event.correlationId ?? null,
    evidence: event.evidence ?? [],
  };
}

function readPayloadString(event: MossLoopEvent, key: string): string | null {
  const value = event.payload?.[key];
  return typeof value === "string" ? value : null;
}

function makeIssue(issue: MossReviewIssue): MossReviewIssue {
  return issue;
}

function makeCheck(
  id: string,
  status: MossReviewCheck["status"],
  summary: string,
  issueCodes: ReadonlyArray<MossReviewIssue["code"]> = [],
): MossReviewCheck {
  return {
    id,
    status,
    summary,
    issueCodes,
  };
}

function deriveReadiness(issues: ReadonlyArray<MossReviewIssue>): MossReviewPacket["readiness"] {
  if (issues.some((issue) => issue.severity === "error")) {
    return {
      status: "blocked",
      summary: "Review packet has blocking errors.",
    };
  }
  if (issues.length > 0) {
    return {
      status: "pending",
      summary: "Review packet is generated, but review or evidence is still pending.",
    };
  }
  return {
    status: "ready",
    summary: "Review packet is ready for Reviewer decision.",
  };
}

export function buildMossReviewPacket(input: {
  readonly status: MossLoopStatus;
  readonly events: ReadonlyArray<MossLoopEvent>;
  readonly tasks: ReadonlyArray<MossLoopTask>;
  readonly iterationPacket: MossIterationPacket;
  readonly changedFiles: ReadonlyArray<MossReviewChangedFile>;
  readonly options?: MossReviewPacketOptions;
}): MossReviewPacket {
  const generatedAt = input.options?.createdAt ?? new Date().toISOString();
  const targetTask = selectTargetTask(input.tasks, input.iterationPacket);
  const correlationId = findTaskCorrelation(input.events, targetTask.taskId);
  const correlatedEvents = correlationId
    ? input.events.filter((event) => event.correlationId === correlationId)
    : [];
  const evidenceEvents = correlatedEvents.filter(
    (event) => event.type === "moss.evidence.recorded",
  );
  const reviewEvent =
    correlatedEvents.toReversed().find((event) => event.type === "moss.review.completed") ?? null;
  const taskEvidenceRefs = targetTask.evidence ?? [];
  const eventEvidenceRefs = unique(evidenceEvents.flatMap((event) => event.evidence ?? []));
  const allEvidenceRefs = unique([...taskEvidenceRefs, ...eventEvidenceRefs]);
  const commandRefs = allEvidenceRefs.filter(isCommandRef);
  const artifactRefs = allEvidenceRefs.filter((ref) => !isCommandRef(ref));
  const reviewerDecision = reviewEvent
    ? {
        eventId: reviewEvent.eventId,
        actorRole: reviewEvent.actor?.role ?? null,
        decision: readPayloadString(reviewEvent, "decision"),
        notes: readPayloadString(reviewEvent, "notes"),
        evidence: reviewEvent.evidence ?? [],
      }
    : null;
  const issues: MossReviewIssue[] = [];
  const checks: MossReviewCheck[] = [];

  if (input.changedFiles.length === 0) {
    issues.push(
      makeIssue({
        code: "changed-files-empty",
        severity: "warning",
        message: "No changed files were captured for this review packet.",
      }),
    );
    checks.push(
      makeCheck("changed-files", "pending", "No changed files were captured.", [
        "changed-files-empty",
      ]),
    );
  } else {
    checks.push(
      makeCheck("changed-files", "pass", `${input.changedFiles.length} changed files captured.`),
    );
  }

  if (input.status.releaseGate.status === "fail") {
    issues.push(
      makeIssue({
        code: "release-gate-failed",
        severity: "error",
        message: `Moss release gate is failing with ${input.status.releaseGate.issueCount} issue(s).`,
      }),
    );
    checks.push(
      makeCheck("release-gate", "fail", "Moss release gate is failing.", ["release-gate-failed"]),
    );
  } else {
    checks.push(makeCheck("release-gate", "pass", "Moss release gate is passing."));
  }

  if (allEvidenceRefs.length === 0) {
    const severity = targetTask.status === "done" ? "error" : "warning";
    issues.push(
      makeIssue({
        code: "qa-evidence-missing",
        severity,
        message: `No QA evidence references were found for ${targetTask.taskId}.`,
      }),
    );
    checks.push(
      makeCheck(
        "qa-evidence",
        severity === "error" ? "fail" : "pending",
        "No QA evidence references were found.",
        ["qa-evidence-missing"],
      ),
    );
  } else {
    checks.push(makeCheck("qa-evidence", "pass", `${allEvidenceRefs.length} evidence refs found.`));
  }

  if (!reviewerDecision) {
    issues.push(
      makeIssue({
        code: "reviewer-decision-pending",
        severity: "warning",
        message: `No Reviewer decision event was found for ${targetTask.taskId}.`,
      }),
    );
    checks.push(
      makeCheck("reviewer-decision", "pending", "Reviewer decision is pending.", [
        "reviewer-decision-pending",
      ]),
    );
  } else if (reviewerDecision.actorRole !== "Reviewer") {
    issues.push(
      makeIssue({
        code: "reviewer-role-invalid",
        severity: "error",
        message: `Review decision actor must be Reviewer, got ${reviewerDecision.actorRole ?? "none"}.`,
      }),
    );
    checks.push(
      makeCheck("reviewer-decision", "fail", "Review decision was not recorded by Reviewer.", [
        "reviewer-role-invalid",
      ]),
    );
  } else {
    checks.push(makeCheck("reviewer-decision", "pass", "Reviewer decision is present."));
  }

  if (!reviewerDecision) {
    checks.push(
      makeCheck("self-approval", "pending", "Self-approval check is pending reviewer decision."),
    );
  } else if (reviewerDecision.actorRole === targetTask.owner) {
    issues.push(
      makeIssue({
        code: "reviewer-self-approval",
        severity: "error",
        message: `${targetTask.owner} cannot approve its own task ${targetTask.taskId}.`,
      }),
    );
    checks.push(
      makeCheck("self-approval", "fail", "Reviewer actor matches task owner.", [
        "reviewer-self-approval",
      ]),
    );
  } else {
    checks.push(makeCheck("self-approval", "pass", "Reviewer actor is separate from task owner."));
  }

  const eventLimit = input.options?.eventLimit ?? 12;
  const recentEventsSource = correlatedEvents.length > 0 ? correlatedEvents : input.events;

  return {
    version: 1,
    generatedAt,
    sourceFiles: [
      ".moss/mission.md",
      ".moss/ledger/events.jsonl",
      ".moss/ledger/tasks.jsonl",
      ".moss/context/current.md",
      "scripts/moss-iteration-packet.ts",
      "scripts/moss-review-packet.ts",
    ],
    task: {
      taskId: targetTask.taskId,
      title: targetTask.title,
      owner: targetTask.owner,
      status: targetTask.status,
      correlationId,
    },
    iterationPacket: {
      objective: input.iterationPacket.objective,
      roleAssignments: input.iterationPacket.roleAssignments,
      fileScope: input.iterationPacket.fileScope,
      acceptance: input.iterationPacket.acceptance,
      requiredVerificationCommands: input.iterationPacket.requiredVerificationCommands,
    },
    changedFiles: input.changedFiles,
    qaEvidence: {
      taskEvidenceRefs,
      eventEvidenceRefs,
      commandRefs,
      artifactRefs,
      evidenceEventIds: evidenceEvents.map((event) => event.eventId),
    },
    reviewerDecision,
    ledger: {
      eventCount: input.status.eventCount,
      taskCount: input.status.taskCount,
      releaseGateStatus: input.status.releaseGate.status,
      issueCount: input.status.releaseGate.issueCount,
      activeTaskIds: input.status.releaseGate.activeTaskIds,
    },
    recentEvents: recentEventsSource.slice(-eventLimit).map(compactEvent),
    checks,
    issues,
    readiness: deriveReadiness(issues),
  };
}

export async function readMossReviewPacket(
  repoRoot = process.cwd(),
  options: MossReviewPacketOptions = {},
): Promise<MossReviewPacket> {
  const mossRoot = join(repoRoot, ".moss");
  const iterationOptions: { createdAt?: string; taskId?: string } = {};
  if (options.createdAt) {
    iterationOptions.createdAt = options.createdAt;
  }
  if (options.taskId) {
    iterationOptions.taskId = options.taskId;
  }
  const [status, eventsContent, tasksContent, iterationPacket, changedFiles] = await Promise.all([
    readMossLoopStatus(repoRoot),
    readFile(join(mossRoot, "ledger", "events.jsonl"), "utf8"),
    readFile(join(mossRoot, "ledger", "tasks.jsonl"), "utf8"),
    readMossIterationPacket(repoRoot, iterationOptions),
    options.changedFiles
      ? Promise.resolve(normalizeChangedFiles(options.changedFiles))
      : readGitChangedFiles(repoRoot),
  ]);

  return buildMossReviewPacket({
    status,
    events: parseJsonLines<MossLoopEvent>(
      eventsContent,
      relative(repoRoot, join(mossRoot, "ledger", "events.jsonl")),
    ),
    tasks: parseJsonLines<MossLoopTask>(
      tasksContent,
      relative(repoRoot, join(mossRoot, "ledger", "tasks.jsonl")),
    ),
    iterationPacket,
    changedFiles,
    options,
  });
}

export function mossReviewPacketExitCode(packet: MossReviewPacket): number {
  return packet.issues.some((issue) => issue.severity === "error") ? 1 : 0;
}

function parseCliOptions(argv: ReadonlyArray<string>): MossReviewPacketOptions {
  const options: {
    createdAt?: string;
    taskId?: string;
    eventLimit?: number;
    changedFiles?: string[];
  } = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--created-at") {
      const createdAt = argv[index + 1];
      if (!createdAt) {
        throw new Error("--created-at requires an ISO timestamp");
      }
      options.createdAt = createdAt;
      index += 1;
      continue;
    }
    if (arg === "--task-id") {
      const taskId = argv[index + 1];
      if (!taskId) {
        throw new Error("--task-id requires a Moss task id");
      }
      options.taskId = taskId;
      index += 1;
      continue;
    }
    if (arg === "--event-limit") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--event-limit requires a number");
      }
      const eventLimit = Number.parseInt(value, 10);
      if (!Number.isInteger(eventLimit) || eventLimit < 1) {
        throw new Error("--event-limit must be a positive integer");
      }
      options.eventLimit = eventLimit;
      index += 1;
      continue;
    }
    if (arg === "--changed-file") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--changed-file requires a file path");
      }
      options.changedFiles = [...(options.changedFiles ?? []), value];
      index += 1;
      continue;
    }
    throw new Error(`unknown moss review packet option: ${arg}`);
  }

  return options;
}

async function main(): Promise<void> {
  const packet = await readMossReviewPacket(process.cwd(), parseCliOptions(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);
  process.exitCode = mossReviewPacketExitCode(packet);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
