// FILE: taskCompletion.logic.ts
// Purpose: Detects new thread lifecycle notifications and builds alert copy.
// Layer: Notification logic
// Exports: lifecycle detection helpers and notification copy helpers

import {
  defaultTerminalTitleForCliKind,
  type TerminalCliKind,
  type TerminalVisualState,
} from "@moss/shared/terminalThreads";
import { markdownToPlainText, truncatePlainText } from "@moss/shared/markdownPlainText";
import { pendingRequestInstanceKey, type ApprovalRequestKind } from "@moss/shared/threadSummary";
import type { Thread, ThreadSession } from "../types";
import {
  derivePendingApprovals,
  countOutstandingBackgroundWork,
  derivePendingBackgroundWork,
  derivePendingUserInputs,
  hasLiveLatestTurn,
} from "../session-logic";

export interface CompletedThreadCandidate {
  threadId: Thread["id"];
  projectId: Thread["projectId"];
  title: string;
  turnId: NonNullable<Thread["latestTurn"]>["turnId"];
  completedAt: string;
  assistantSummary: string | null;
}
import type { MossLocaleCode } from "../uiLocale";

export interface ThreadAttentionCandidate {
  kind: "approval" | "user-input";
  threadId: Thread["id"];
  projectId: Thread["projectId"];
  title: string;
  requestId: string;
  createdAt: string;
  requestKind?: ApprovalRequestKind;
  summary?: string;
}

export interface SnoozeReminderCandidate {
  threadId: Thread["id"];
  title: string;
  reminderAt: string;
}

/** Reminders deliberately include the initial snapshot so an overdue wakeup
 * survives a closed app. Persisted receipts, rather than a lifecycle transition,
 * determine whether the notification has already been shown. */
export function collectSnoozeReminderCandidates(
  threads: readonly Pick<
    Thread,
    "id" | "title" | "archivedAt" | "snoozedUntil" | "snoozeReminderAt"
  >[],
): SnoozeReminderCandidate[] {
  return threads.flatMap((thread) =>
    thread.archivedAt == null &&
    thread.snoozedUntil == null &&
    thread.snoozeReminderAt &&
    Number.isFinite(Date.parse(thread.snoozeReminderAt))
      ? [{ threadId: thread.id, title: thread.title, reminderAt: thread.snoozeReminderAt }]
      : [],
  );
}

interface TerminalNotificationThreadState {
  runningTerminalIds: string[];
  terminalAttentionStatesById: Record<string, "attention" | "review">;
  terminalCliKindsById: Record<string, TerminalCliKind>;
  terminalIds: string[];
  terminalLabelsById: Record<string, string>;
  terminalTitleOverridesById: Record<string, string>;
}

export interface CompletedTerminalCandidate {
  cliKind: TerminalCliKind | null;
  terminalId: string;
  threadId: Thread["id"];
  title: string;
}

export interface TerminalAttentionCandidate {
  cliKind: TerminalCliKind | null;
  terminalId: string;
  threadId: Thread["id"];
  title: string;
}

type ThreadSessionStatus = ThreadSession["status"];

// Thread completion toasts are for off-screen work; visible threads already show the result inline.
export function shouldShowThreadNotificationToast(input: {
  threadId: Thread["id"];
  visibleThreadIds: ReadonlySet<Thread["id"]>;
}): boolean {
  return !input.visibleThreadIds.has(input.threadId);
}

export function shouldAttemptSystemTaskNotification(input: {
  enabled: boolean;
  isWindowForeground: boolean;
}): boolean {
  return input.enabled && !input.isWindowForeground;
}

// Treat sidebar "working" states as the only notification-worthy starting point.
function isRunningStatus(status: ThreadSessionStatus | null | undefined): boolean {
  return status === "running" || status === "connecting";
}

const NOTIFICATION_SUMMARY_MAX_LENGTH = 120;

// Reduce rich assistant output to readable notification context. Toasts and OS
// notifications should never expose Markdown syntax or turn into mini transcripts.
function summarizeAssistantText(text: string): string | null {
  const plainText = markdownToPlainText(text);
  return plainText.length === 0
    ? null
    : truncatePlainText(plainText, NOTIFICATION_SUMMARY_MAX_LENGTH);
}

// Build a short body from the turn's *final* assistant message — the end-of-turn reply
// that lands after the work/compaction, not the opening preamble. Prefer the canonical
// `latestTurn.assistantMessageId`; if it's missing/empty, fall back to the last non-empty
// assistant message of that turn so we still surface the latest reply.
function summarizeLatestAssistantMessage(thread: Thread): string | null {
  const latestTurnId = thread.latestTurn?.turnId ?? null;
  const finalAssistantMessageId = thread.latestTurn?.assistantMessageId ?? null;

  if (finalAssistantMessageId) {
    const finalMessage = thread.messages.find((message) => message.id === finalAssistantMessageId);
    if (finalMessage) {
      const summary = summarizeAssistantText(finalMessage.text);
      if (summary) {
        return summary;
      }
    }
  }

  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index];
    if (!message || message.role !== "assistant") {
      continue;
    }
    // Stay within the just-completed turn so an earlier/other-turn preamble can't win.
    if (latestTurnId && message.turnId !== latestTurnId) {
      continue;
    }
    const summary = summarizeAssistantText(message.text);
    if (summary) {
      return summary;
    }
  }
  return null;
}

function hadUnsettledTurn(thread: Thread | undefined): boolean {
  if (!thread) {
    return false;
  }
  if (hasLiveLatestTurn(thread.latestTurn, thread.session)) {
    return true;
  }
  return !thread.latestTurn?.completedAt && isRunningStatus(thread.session?.status);
}

function isCompletionNotificationSettled(thread: Thread | undefined): boolean {
  if (!thread?.latestTurn?.startedAt || !thread.latestTurn.completedAt) {
    return false;
  }
  if (!thread.session) {
    return true;
  }
  return thread.session.orchestrationStatus !== "running";
}

// Compare consecutive snapshots and emit fresh settled completions, even if the
// session snapshot skips directly to ready before the toast logic observes it.
export function collectCompletedThreadCandidates(
  previousThreads: readonly Thread[],
  nextThreads: readonly Thread[],
  options: {
    /**
     * Notify once the agent and every background subagent it launched have
     * finished, instead of each time the agent or one of its subagents stops.
     */
    readonly waitForSubagents?: boolean;
  } = {},
): CompletedThreadCandidate[] {
  const previousById = new Map(previousThreads.map((thread) => [thread.id, thread] as const));
  const candidates: CompletedThreadCandidate[] = [];

  for (const thread of nextThreads) {
    if (thread.snoozedUntil != null) continue;
    // A subagent's own thread finishing is a step of its parent's work, and
    // its result reaches the parent thread anyway.
    if (options.waitForSubagents && thread.parentThreadId) {
      continue;
    }
    const previousThread = previousById.get(thread.id);
    if (!previousThread) {
      continue;
    }
    // Every check below reads only these inputs, and with all three unchanged the
    // previous-snapshot dedupe further down always skips the thread. This runs on
    // every store flush for every loaded thread, so skip the per-thread activity
    // folds instead of replaying them for threads that did not move.
    if (
      previousThread.latestTurn === thread.latestTurn &&
      previousThread.session === thread.session &&
      previousThread.activities === thread.activities
    ) {
      continue;
    }

    const latestTurn = thread.latestTurn;
    const completedAt = latestTurn?.completedAt;
    if (!latestTurn || !completedAt) {
      continue;
    }
    // Interrupted/error settlements are not completions: the stop was either
    // user-initiated or already surfaced through the error state, and "Finished
    // working." copy would be wrong for both.
    if (latestTurn.state !== "completed") {
      continue;
    }
    if (!isCompletionNotificationSettled(thread)) {
      continue;
    }
    // Background subagents can keep running after the turn settles; "Finished
    // working." would be premature while tracked background tasks are live.
    if (
      (derivePendingBackgroundWork({
        activities: thread.activities,
        latestTurn: thread.latestTurn,
        session: thread.session,
      })?.count ?? 0) > 0
    ) {
      continue;
    }
    if (
      options.waitForSubagents &&
      countOutstandingBackgroundWork({ activities: thread.activities, session: thread.session }) > 0
    ) {
      continue;
    }
    if (!previousThread.session && !previousThread.latestTurn?.completedAt) {
      continue;
    }
    if (!hadUnsettledTurn(previousThread) && !previousThread.latestTurn?.completedAt) {
      continue;
    }
    if (
      previousThread.latestTurn?.turnId === thread.latestTurn?.turnId &&
      isCompletionNotificationSettled(previousThread) &&
      // A held completion can be released by the final task or session settling
      // without the parent entering another turn. Only dedupe a previously
      // settled snapshot if it was already eligible for the alert.
      !(
        options.waitForSubagents &&
        countOutstandingBackgroundWork({
          activities: previousThread.activities,
          session: previousThread.session,
        }) > 0
      )
    ) {
      continue;
    }

    candidates.push({
      threadId: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      turnId: latestTurn.turnId,
      completedAt,
      assistantSummary: summarizeLatestAssistantMessage(thread),
    });
  }

  return candidates;
}

// Identity of one settled completion. The snapshot diff above can re-emit the
// same completion when the session status wobbles out of and back into a settled
// state (e.g. a follow-up turn spinning up while latestTurn still points at the
// finished one); callers dedupe on this key so each completion notifies once.
// completedAt is deliberately excluded: the same turn's completedAt is rewritten
// by later events (assistant message, session settle, checkpoint diff) with
// slightly different timestamps, and a turn only ever completes once.
export function completedThreadNotificationKey(candidate: CompletedThreadCandidate): string {
  return `${candidate.threadId}:${candidate.turnId}`;
}
function resolveTerminalNotificationState(
  threadState: TerminalNotificationThreadState | undefined,
  terminalId: string,
): TerminalVisualState {
  if (!threadState) {
    return "idle";
  }
  if (threadState.terminalAttentionStatesById?.[terminalId] === "attention") {
    return "attention";
  }
  if ((threadState.runningTerminalIds ?? []).includes(terminalId)) {
    return "running";
  }
  if (threadState.terminalAttentionStatesById?.[terminalId] === "review") {
    return "review";
  }
  return "idle";
}

function resolveTerminalNotificationTitle(
  threadState: TerminalNotificationThreadState | undefined,
  terminalId: string,
): { cliKind: TerminalCliKind | null; title: string } {
  const cliKind = threadState?.terminalCliKindsById?.[terminalId] ?? null;
  const title =
    threadState?.terminalTitleOverridesById?.[terminalId]?.trim() ||
    threadState?.terminalLabelsById?.[terminalId]?.trim() ||
    (cliKind ? defaultTerminalTitleForCliKind(cliKind) : "Terminal");
  return { cliKind, title };
}

export function collectCompletedTerminalCandidates(
  previousByThreadId: Record<string, TerminalNotificationThreadState>,
  nextByThreadId: Record<string, TerminalNotificationThreadState>,
): CompletedTerminalCandidate[] {
  const threadIds = new Set([...Object.keys(previousByThreadId), ...Object.keys(nextByThreadId)]);
  const candidates: CompletedTerminalCandidate[] = [];

  for (const threadId of threadIds) {
    const previousThreadState = previousByThreadId[threadId];
    const nextThreadState = nextByThreadId[threadId];
    const terminalIds = new Set([
      ...(previousThreadState?.terminalIds ?? []),
      ...(nextThreadState?.terminalIds ?? []),
    ]);

    for (const terminalId of terminalIds) {
      const previousState = resolveTerminalNotificationState(previousThreadState, terminalId);
      const nextState = resolveTerminalNotificationState(nextThreadState, terminalId);
      if (nextState !== "review" || previousState === "review") {
        continue;
      }
      const { cliKind, title } = resolveTerminalNotificationTitle(nextThreadState, terminalId);
      candidates.push({
        threadId: threadId as Thread["id"],
        terminalId,
        cliKind,
        title,
      });
    }
  }

  return candidates;
}

function approvalSummary(requestKind: ApprovalRequestKind): string {
  switch (requestKind) {
    case "command":
      return "Command approval requested.";
    case "file-read":
      return "File-read approval requested.";
    case "file-change":
      return "File-change approval requested.";
    case "permissions":
      return "Permission approval requested.";
    case "computer-foreground":
      return "Computer access approval requested.";
    case "tool":
      return "Tool approval requested.";
  }
}

function requestedActivityInstanceKeys(
  activities: Thread["activities"],
  kind: "approval.requested" | "user-input.requested",
): Set<string> {
  return new Set(
    activities.flatMap((activity) => {
      if (activity.kind !== kind || !activity.payload) return [];
      const payload = activity.payload as Record<string, unknown>;
      return typeof payload.requestId === "string"
        ? [
            pendingRequestInstanceKey(
              payload.requestId,
              typeof payload.lifecycleGeneration === "string"
                ? payload.lifecycleGeneration
                : undefined,
            ),
          ]
        : [];
    }),
  );
}

// Compare consecutive activity snapshots and emit only fresh input-needed transitions.
export function collectThreadAttentionCandidates(
  previousThreads: readonly Thread[],
  nextThreads: readonly Thread[],
): ThreadAttentionCandidate[] {
  const previousById = new Map(previousThreads.map((thread) => [thread.id, thread] as const));
  const candidates: ThreadAttentionCandidate[] = [];

  for (const thread of nextThreads) {
    if (thread.snoozedUntil != null) continue;
    const previousThread = previousById.get(thread.id);
    if (!previousThread) {
      continue;
    }
    // Both derivations below are pure functions of these inputs. When none of
    // them changed (the whole workspace during ordinary text streaming, where
    // only message text moves), every next request id already sits in the
    // previous id set and nothing can be emitted, so replaying every thread's
    // activities per streamed token is skipped outright.
    if (
      previousThread.activities === thread.activities &&
      previousThread.pendingInteractions === thread.pendingInteractions &&
      previousThread.hasPendingApprovals === thread.hasPendingApprovals &&
      previousThread.hasPendingUserInput === thread.hasPendingUserInput &&
      previousThread.latestTurn?.turnId === thread.latestTurn?.turnId
    ) {
      continue;
    }

    const previousApprovalIds = new Set(
      derivePendingApprovals(previousThread.activities, previousThread.pendingInteractions, {
        authoritativeHasPending: previousThread.hasPendingApprovals,
        latestTurnId: previousThread.latestTurn?.turnId,
      }).map((approval) => approval.requestId),
    );
    const previousUserInputIds = new Set(
      derivePendingUserInputs(previousThread.activities, previousThread.pendingInteractions, {
        authoritativeHasPending: previousThread.hasPendingUserInput,
        latestTurnId: previousThread.latestTurn?.turnId,
      }).map((request) => request.requestId),
    );
    const previousApprovalActivityKeys = requestedActivityInstanceKeys(
      previousThread.activities,
      "approval.requested",
    );
    const previousUserInputActivityKeys = requestedActivityInstanceKeys(
      previousThread.activities,
      "user-input.requested",
    );

    for (const approval of derivePendingApprovals(thread.activities, thread.pendingInteractions, {
      authoritativeHasPending: thread.hasPendingApprovals,
      latestTurnId: thread.latestTurn?.turnId,
    })) {
      if (
        previousApprovalIds.has(approval.requestId) ||
        (thread.pendingInteractions === undefined &&
          previousApprovalActivityKeys.has(
            pendingRequestInstanceKey(approval.requestId, approval.lifecycleGeneration),
          ))
      ) {
        continue;
      }
      candidates.push({
        kind: "approval",
        threadId: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        requestId: approval.requestId,
        createdAt: approval.createdAt,
        requestKind: approval.requestKind,
      });
    }

    for (const request of derivePendingUserInputs(thread.activities, thread.pendingInteractions, {
      authoritativeHasPending: thread.hasPendingUserInput,
      latestTurnId: thread.latestTurn?.turnId,
    })) {
      if (
        previousUserInputIds.has(request.requestId) ||
        (thread.pendingInteractions === undefined &&
          previousUserInputActivityKeys.has(
            pendingRequestInstanceKey(request.requestId, request.lifecycleGeneration),
          ))
      ) {
        continue;
      }
      candidates.push({
        kind: "user-input",
        threadId: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        requestId: request.requestId,
        createdAt: request.createdAt,
      });
    }
  }

  return candidates.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function collectTerminalAttentionCandidates(
  previousByThreadId: Record<string, TerminalNotificationThreadState>,
  nextByThreadId: Record<string, TerminalNotificationThreadState>,
): TerminalAttentionCandidate[] {
  const threadIds = new Set([...Object.keys(previousByThreadId), ...Object.keys(nextByThreadId)]);
  const candidates: TerminalAttentionCandidate[] = [];

  for (const threadId of threadIds) {
    const previousThreadState = previousByThreadId[threadId];
    const nextThreadState = nextByThreadId[threadId];
    const terminalIds = new Set([
      ...(previousThreadState?.terminalIds ?? []),
      ...(nextThreadState?.terminalIds ?? []),
    ]);

    for (const terminalId of terminalIds) {
      const previousState = resolveTerminalNotificationState(previousThreadState, terminalId);
      const nextState = resolveTerminalNotificationState(nextThreadState, terminalId);
      if (nextState !== "attention" || previousState === "attention") {
        continue;
      }
      const { cliKind, title } = resolveTerminalNotificationTitle(nextThreadState, terminalId);
      candidates.push({
        threadId: threadId as Thread["id"],
        terminalId,
        cliKind,
        title,
      });
    }
  }

  return candidates;
}

// Keep toast and OS notification copy aligned across browser and desktop surfaces.
export function buildTaskCompletionCopy(
  candidate: CompletedThreadCandidate,
  locale: MossLocaleCode = "en",
): {
  title: string;
  body: string;
} {
  const normalizedTitle = candidate.title.trim();
  const threadLabel =
    normalizedTitle.length > 0
      ? normalizedTitle
      : locale === "zh-CN"
        ? "未命名对话"
        : "Untitled thread";

  return {
    title: threadLabel,
    body: candidate.assistantSummary || (locale === "zh-CN" ? "工作已完成。" : "Finished working."),
  };
}

export function buildThreadAttentionCopy(
  candidate: ThreadAttentionCandidate,
  locale: MossLocaleCode = "en",
): {
  title: string;
  body: string;
} {
  const normalizedTitle = candidate.title.trim();
  const threadLabel =
    normalizedTitle.length > 0
      ? normalizedTitle
      : locale === "zh-CN"
        ? "未命名对话"
        : "Untitled thread";
  const summary =
    candidate.summary ??
    (candidate.kind === "approval"
      ? approvalSummary(candidate.requestKind ?? "command")
      : locale === "zh-CN"
        ? "需要用户输入。"
        : "User input requested.");

  return {
    title: locale === "zh-CN" ? "需要输入" : "Input needed",
    body: `${threadLabel}${locale === "zh-CN" ? "：" : ": "}${summary}`,
  };
}

export function buildTerminalCompletionCopy(
  candidate: CompletedTerminalCandidate,
  locale: MossLocaleCode = "en",
): {
  title: string;
  body: string;
} {
  const terminalLabel = candidate.title.trim() || (locale === "zh-CN" ? "终端" : "Terminal");
  return {
    title: locale === "zh-CN" ? "终端任务已完成" : "Terminal task completed",
    body:
      locale === "zh-CN" ? `${terminalLabel} 已完成工作。` : `${terminalLabel} finished working.`,
  };
}

export function buildTerminalAttentionCopy(
  candidate: TerminalAttentionCandidate,
  locale: MossLocaleCode = "en",
): {
  title: string;
  body: string;
} {
  const terminalLabel = candidate.title.trim() || (locale === "zh-CN" ? "终端" : "Terminal");
  return {
    title: locale === "zh-CN" ? "终端需要输入" : "Terminal input needed",
    body:
      locale === "zh-CN"
        ? `${terminalLabel} 需要你的关注。`
        : `${terminalLabel} needs your attention.`,
  };
}

export const collectInputNeededThreadCandidates = collectThreadAttentionCandidates;

export const buildInputNeededCopy = buildThreadAttentionCopy;

// Hydration can replay old thread details after refresh; only timestamps after
// this notification runtime mounted should be treated as live events.
export function isNotificationRuntimeFreshTimestamp(
  candidateTimestamp: string,
  runtimeStartedAtMs: number,
): boolean {
  const candidateMs = Date.parse(candidateTimestamp);
  if (!Number.isFinite(candidateMs) || !Number.isFinite(runtimeStartedAtMs)) {
    return true;
  }
  return candidateMs > runtimeStartedAtMs;
}
