import { readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import {
  parseJsonLines,
  readMossLoopStatus,
  type MossLoopEvent,
  type MossLoopStatus,
  type MossLoopTask,
} from "./moss-loop-status.ts";

export interface MossMemoryPacketOptions {
  readonly createdAt?: string;
  readonly eventLimit?: number;
  readonly taskLimit?: number;
}

export interface MossMemorySignal {
  readonly code:
    | "active-task-missing-from-context"
    | "completed-task-missing-evidence"
    | "evidence-index-missing"
    | "latest-review-missing-from-context"
    | "release-gate-failed";
  readonly severity: "warning" | "error";
  readonly message: string;
}

export interface MossMemoryRecentDecision {
  readonly eventId: string;
  readonly createdAt: string;
  readonly actorRole: string | null;
  readonly correlationId: string | null;
  readonly taskId: string | null;
  readonly decision: string | null;
  readonly notes: string | null;
  readonly evidence: ReadonlyArray<string>;
}

export interface MossMemoryTaskSummary {
  readonly taskId: string;
  readonly status: string;
  readonly owner: string;
  readonly title: string;
  readonly evidenceCount: number;
}

export interface MossMemoryPacket {
  readonly version: 1;
  readonly generatedAt: string;
  readonly sourceFiles: ReadonlyArray<string>;
  readonly statusSummary: string | null;
  readonly durableFacts: ReadonlyArray<string>;
  readonly activeTasks: ReadonlyArray<MossMemoryTaskSummary>;
  readonly recentTasks: ReadonlyArray<MossMemoryTaskSummary>;
  readonly nextTasks: ReadonlyArray<string>;
  readonly recentDecisions: ReadonlyArray<MossMemoryRecentDecision>;
  readonly evidenceRefs: {
    readonly indexedEvidenceFiles: ReadonlyArray<string>;
    readonly taskEvidenceRefs: ReadonlyArray<string>;
    readonly commandRefs: ReadonlyArray<string>;
    readonly artifactRefs: ReadonlyArray<string>;
  };
  readonly ledger: {
    readonly eventCount: number;
    readonly taskCount: number;
    readonly releaseGateStatus: "pass" | "fail";
    readonly issueCount: number;
    readonly activeTaskIds: ReadonlyArray<string>;
  };
  readonly contextSignals: ReadonlyArray<MossMemorySignal>;
  readonly openRisks: ReadonlyArray<string>;
  readonly recommendedContextUpdates: ReadonlyArray<string>;
  readonly readiness: {
    readonly status: "ready" | "blocked";
    readonly summary: string;
  };
}

function unique(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(values)].filter((value) => value.length > 0);
}

function isCommandRef(value: string): boolean {
  return /^(bun|git|node|npm|pnpm|yarn)\b/.test(value);
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

function firstParagraph(markdown: string | null): string | null {
  if (!markdown) {
    return null;
  }
  const paragraph = markdown
    .split(/\n\s*\n/)
    .map((entry) => entry.replace(/\s+/g, " ").trim())
    .find((entry) => entry.length > 0);
  return paragraph ?? null;
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

function taskKeyword(title: string): string {
  return title
    .replace(/^Add\s+/i, "")
    .replace(/\s+for\s+Moss\s+loop\s+automation$/i, "")
    .trim()
    .toLowerCase();
}

function taskSummary(task: MossLoopTask): MossMemoryTaskSummary {
  return {
    taskId: task.taskId,
    status: task.status,
    owner: task.owner,
    title: task.title,
    evidenceCount: task.evidence?.length ?? 0,
  };
}

function payloadString(event: MossLoopEvent, key: string): string | null {
  const value = event.payload?.[key];
  return typeof value === "string" ? value : null;
}

function taskIdForCorrelation(
  events: ReadonlyArray<MossLoopEvent>,
  correlationId: string | null,
): string | null {
  if (!correlationId) {
    return null;
  }
  const taskStart = events.find(
    (event) => event.type === "moss.task.started" && event.correlationId === correlationId,
  );
  const taskId = taskStart?.payload?.taskId;
  return typeof taskId === "string" ? taskId : null;
}

function recentDecisions(
  events: ReadonlyArray<MossLoopEvent>,
  limit: number,
): ReadonlyArray<MossMemoryRecentDecision> {
  return events
    .filter((event) => event.type === "moss.review.completed")
    .slice(-limit)
    .map((event) => ({
      eventId: event.eventId,
      createdAt: event.createdAt,
      actorRole: event.actor?.role ?? null,
      correlationId: event.correlationId ?? null,
      taskId: taskIdForCorrelation(events, event.correlationId ?? null),
      decision: payloadString(event, "decision"),
      notes: payloadString(event, "notes"),
      evidence: event.evidence ?? [],
    }));
}

function sentence(label: string, value: string): string {
  const trimmedValue = value.trim();
  const suffix = /[.!?]$/.test(trimmedValue) ? "" : ".";
  return `${label}: ${trimmedValue}${suffix}`;
}

function buildDurableFacts(status: MossLoopStatus): ReadonlyArray<string> {
  return [
    sentence("Mission", status.missionTitle),
    status.currentGoal ? sentence("Current goal", status.currentGoal) : "",
    status.branch ? sentence("Branch", status.branch) : "",
    `Ledger: ${status.eventCount} events, ${status.taskCount} tasks, release gate ${status.releaseGate.status}.`,
    `Active tasks: ${status.releaseGate.activeTaskIds.join(", ") || "none"}.`,
  ].filter((fact) => fact.length > 0);
}

function buildSignals(input: {
  readonly status: MossLoopStatus;
  readonly tasks: ReadonlyArray<MossLoopTask>;
  readonly currentContext: string;
  readonly evidenceIndexRefs: ReadonlyArray<string>;
  readonly decisions: ReadonlyArray<MossMemoryRecentDecision>;
}): ReadonlyArray<MossMemorySignal> {
  const signals: MossMemorySignal[] = [];
  const contextLower = input.currentContext.toLowerCase();
  const latestDoneTask = input.tasks.toReversed().find((task) => task.status === "done");

  if (input.status.releaseGate.status === "fail") {
    signals.push({
      code: "release-gate-failed",
      severity: "error",
      message: `Moss release gate is failing with ${input.status.releaseGate.issueCount} issue(s).`,
    });
  }

  for (const task of input.status.completedTasksMissingEvidence) {
    signals.push({
      code: "completed-task-missing-evidence",
      severity: "error",
      message: `Completed task ${task.taskId} has no evidence references.`,
    });
  }

  for (const task of input.status.activeTasks) {
    const keyword = taskKeyword(task.title);
    if (keyword && !contextLower.includes(keyword)) {
      signals.push({
        code: "active-task-missing-from-context",
        severity: "warning",
        message: `Active task ${task.taskId} is not mentioned in .moss/context/current.md.`,
      });
    }
  }

  if (latestDoneTask) {
    const keyword = taskKeyword(latestDoneTask.title);
    if (keyword && !contextLower.includes(keyword)) {
      signals.push({
        code: "latest-review-missing-from-context",
        severity: "warning",
        message: `Latest completed task ${latestDoneTask.taskId} is not reflected in .moss/context/current.md.`,
      });
    }
  }

  const indexedBasenames = new Set(input.evidenceIndexRefs.map((ref) => basename(ref)));
  const taskEvidenceFiles = input.tasks.flatMap((task) =>
    (task.evidence ?? []).filter((ref) => ref.startsWith(".moss/ledger/evidence/")),
  );
  for (const evidenceRef of unique(taskEvidenceFiles)) {
    const evidenceName = basename(evidenceRef);
    if (!indexedBasenames.has(evidenceName)) {
      signals.push({
        code: "evidence-index-missing",
        severity: "warning",
        message: `Evidence file ${evidenceName} is referenced by a task but missing from the evidence index.`,
      });
    }
  }

  if (input.decisions.length > 0) {
    const latestDecision = input.decisions.at(-1);
    const latestTaskId = latestDecision?.taskId;
    const latestTask = latestTaskId
      ? input.tasks.find((task) => task.taskId === latestTaskId)
      : undefined;
    const keyword = latestTask ? taskKeyword(latestTask.title) : null;
    if (keyword && !contextLower.includes(keyword)) {
      signals.push({
        code: "latest-review-missing-from-context",
        severity: "warning",
        message: `Latest Reviewer decision for ${latestTaskId} is not summarized in current context.`,
      });
    }
  }

  return signals;
}

function buildRecommendedUpdates(input: {
  readonly activeTasks: ReadonlyArray<MossLoopTask>;
  readonly decisions: ReadonlyArray<MossMemoryRecentDecision>;
  readonly signals: ReadonlyArray<MossMemorySignal>;
}): ReadonlyArray<string> {
  const updates = [
    "Keep ## Status to one current paragraph summarizing the latest accepted iteration.",
    "Keep ## Active Goal as the durable product/control-plane scope, not this chat turn.",
    "Add newly accepted artifacts and evidence files under ## Current Evidence.",
    "Append verified commands under ## Verified Commands only after command output is observed.",
  ];

  for (const task of input.activeTasks) {
    updates.push(`Keep ## Next Tasks aligned with active task ${task.taskId}: ${task.title}.`);
  }
  for (const decision of input.decisions.slice(-3)) {
    if (decision.taskId && decision.decision) {
      updates.push(`Summarize Reviewer decision ${decision.decision} for ${decision.taskId}.`);
    }
  }
  for (const signal of input.signals) {
    updates.push(`Resolve ${signal.code}: ${signal.message}`);
  }

  return unique(updates);
}

function buildOpenRisks(input: {
  readonly status: MossLoopStatus;
  readonly signals: ReadonlyArray<MossMemorySignal>;
}): ReadonlyArray<string> {
  const risks = [
    "Context can drift if .moss/context/current.md is not updated after each accepted iteration.",
    "Evidence can become unverifiable if command outputs are summarized without exact command strings.",
  ];
  if (input.status.releaseGate.status === "fail") {
    risks.unshift(
      "Release gate is failing and must be fixed before treating memory as authoritative.",
    );
  }
  if (input.signals.some((signal) => signal.code === "evidence-index-missing")) {
    risks.push("Evidence index is missing one or more task evidence files.");
  }
  return unique(risks);
}

export function buildMossMemoryPacket(input: {
  readonly status: MossLoopStatus;
  readonly events: ReadonlyArray<MossLoopEvent>;
  readonly tasks: ReadonlyArray<MossLoopTask>;
  readonly currentContext: string;
  readonly evidenceIndex: string;
  readonly options?: MossMemoryPacketOptions;
}): MossMemoryPacket {
  const generatedAt = input.options?.createdAt ?? new Date().toISOString();
  const eventLimit = input.options?.eventLimit ?? 6;
  const taskLimit = input.options?.taskLimit ?? 8;
  const statusSummary = firstParagraph(extractMarkdownSection(input.currentContext, "Status"));
  const nextTasks = listBullets(extractMarkdownSection(input.currentContext, "Next Tasks"));
  const decisions = recentDecisions(input.events, eventLimit);
  const taskEvidenceRefs = unique(input.tasks.flatMap((task) => task.evidence ?? []));
  const commandRefs = taskEvidenceRefs.filter(isCommandRef);
  const artifactRefs = taskEvidenceRefs.filter((ref) => !isCommandRef(ref));
  const evidenceIndexRefs = extractBacktickRefs(input.evidenceIndex);
  const signals = buildSignals({
    status: input.status,
    tasks: input.tasks,
    currentContext: input.currentContext,
    evidenceIndexRefs,
    decisions,
  });

  return {
    version: 1,
    generatedAt,
    sourceFiles: [
      ".moss/context/current.md",
      ".moss/ledger/events.jsonl",
      ".moss/ledger/tasks.jsonl",
      ".moss/ledger/evidence/README.md",
    ],
    statusSummary,
    durableFacts: buildDurableFacts(input.status),
    activeTasks: input.status.activeTasks.map(taskSummary),
    recentTasks: input.tasks.slice(-taskLimit).map(taskSummary),
    nextTasks,
    recentDecisions: decisions,
    evidenceRefs: {
      indexedEvidenceFiles: evidenceIndexRefs,
      taskEvidenceRefs,
      commandRefs,
      artifactRefs,
    },
    ledger: {
      eventCount: input.status.eventCount,
      taskCount: input.status.taskCount,
      releaseGateStatus: input.status.releaseGate.status,
      issueCount: input.status.releaseGate.issueCount,
      activeTaskIds: input.status.releaseGate.activeTaskIds,
    },
    contextSignals: signals,
    openRisks: buildOpenRisks({
      status: input.status,
      signals,
    }),
    recommendedContextUpdates: buildRecommendedUpdates({
      activeTasks: input.status.activeTasks,
      decisions,
      signals,
    }),
    readiness: signals.some((signal) => signal.severity === "error")
      ? {
          status: "blocked",
          summary: "Memory packet has blocking context or ledger signals.",
        }
      : {
          status: "ready",
          summary: "Memory packet is ready to guide .moss/context/current.md updates.",
        },
  };
}

export async function readMossMemoryPacket(
  repoRoot = process.cwd(),
  options: MossMemoryPacketOptions = {},
): Promise<MossMemoryPacket> {
  const mossRoot = join(repoRoot, ".moss");
  const [status, eventsContent, tasksContent, currentContext, evidenceIndex] = await Promise.all([
    readMossLoopStatus(repoRoot),
    readFile(join(mossRoot, "ledger", "events.jsonl"), "utf8"),
    readFile(join(mossRoot, "ledger", "tasks.jsonl"), "utf8"),
    readFile(join(mossRoot, "context", "current.md"), "utf8"),
    readFile(join(mossRoot, "ledger", "evidence", "README.md"), "utf8"),
  ]);

  return buildMossMemoryPacket({
    status,
    events: parseJsonLines<MossLoopEvent>(
      eventsContent,
      relative(repoRoot, join(mossRoot, "ledger", "events.jsonl")),
    ),
    tasks: parseJsonLines<MossLoopTask>(
      tasksContent,
      relative(repoRoot, join(mossRoot, "ledger", "tasks.jsonl")),
    ),
    currentContext,
    evidenceIndex,
    options,
  });
}

export function mossMemoryPacketExitCode(packet: MossMemoryPacket): number {
  return packet.contextSignals.some((signal) => signal.severity === "error") ? 1 : 0;
}

function parseCliOptions(argv: ReadonlyArray<string>): MossMemoryPacketOptions {
  const options: { createdAt?: string; eventLimit?: number; taskLimit?: number } = {};

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
    if (arg === "--task-limit") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--task-limit requires a number");
      }
      const taskLimit = Number.parseInt(value, 10);
      if (!Number.isInteger(taskLimit) || taskLimit < 1) {
        throw new Error("--task-limit must be a positive integer");
      }
      options.taskLimit = taskLimit;
      index += 1;
      continue;
    }
    throw new Error(`unknown moss memory packet option: ${arg}`);
  }

  return options;
}

async function main(): Promise<void> {
  const packet = await readMossMemoryPacket(process.cwd(), parseCliOptions(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);
  process.exitCode = mossMemoryPacketExitCode(packet);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
