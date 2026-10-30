// FILE: MessagesTimeline.logic.ts
// Purpose: Owns the pure row-derivation helpers used by the transcript hot path.
// Layer: Web chat presentation helpers
// Exports: row derivation, structural sharing, copy/timer helpers

import {
  MODEL_OPTIONS_BY_PROVIDER,
  type InlineVisualActivityPayload,
  type MessageId,
  type ProviderTurnTrigger,
  type RuntimeCodexErrorInfo,
  type TurnId,
} from "@synara/contracts";
import { readInlineVisualEmbedIds } from "@synara/shared/inlineVisual";
import { htmlRenderReferencesEqual, type HtmlRenderReference } from "@synara/shared/htmlRender";
import { formatModelDisplayName } from "@synara/shared/model";
import {
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
  type ProviderKind,
} from "@synara/contracts";
import { isProviderKind } from "../../providerOrdering";
import { type TimelineEntry, type WorkLogEntry, formatElapsed } from "../../session-logic";
import { isCodexRuntimeWarningType, type WorkLogUserInputExchangeItem } from "../../workLog";
import { normalizeCompactToolLabel as normalizeCompactToolLabelValue } from "../../lib/toolCallLabel";
import { localizeProviderRuntimeMessage } from "../../lib/providerRuntimeMessages";
import type { MossLocaleCode } from "../../appSettings";
import type { ModelReroutedReason } from "../../workLog";
import type { TaskListTaskSnapshot, WorkLogGeneratedImage } from "../../workLog";
import { isCodexActivityStatusWorkEntry } from "./agentActivity.logic";
import {
  isSummarizableToolCallEntry,
  MIN_COLLAPSIBLE_TOOL_GROUP_SIZE,
  summarizeToolCallGroup,
  workEntryRowCount,
  type ToolCallGroupSummary,
} from "./toolCallGroup.logic";
import {
  type ChatMessage,
  type ProposedPlan,
  type TurnDiffSummary,
  type WorktreeSetupSnapshot,
  type WorktreeSetupStep,
} from "../../types";
import {
  isReasoningPresentationActive,
  isReasoningPresentationEntry,
  resolveReasoningBody,
} from "./reasoningPresentation";
import { computeWorkedDurationMs } from "./workedForPresentation";
import { isProviderSignInExpiredError } from "./threadErrorPresentation";
import type { UserStoppedRecord } from "./userStoppedPresentation";

export const MAX_VISIBLE_WORK_LOG_ENTRIES = 6;

export const CAPACITY_RETRY_DELAYS_SECONDS = [10, 30, 120, 300] as const;

export interface CapacityRetryState {
  readonly turnId: TurnId;
  /** Null means the automatic schedule is exhausted; manual retry remains available. */
  readonly delaySeconds: number | null;
}

export type CapacityRetryTrigger = ProviderTurnTrigger;

/**
 * A command acknowledgement is not itself a projection update. Keep the
 * terminal fast path fail-closed until the session revision moves past the
 * revision observed when the command was dispatched.
 */
export function hasCapacityRetryProjectionAdvancedSince(
  baselineUpdatedAt: string | null | undefined,
  currentUpdatedAt: string | null | undefined,
): boolean {
  if (currentUpdatedAt === null || currentUpdatedAt === undefined) return false;
  if (baselineUpdatedAt === null || baselineUpdatedAt === undefined) return true;
  const baselineMs = Date.parse(baselineUpdatedAt);
  const currentMs = Date.parse(currentUpdatedAt);
  if (!Number.isFinite(baselineMs) || !Number.isFinite(currentMs)) {
    return currentUpdatedAt !== baselineUpdatedAt;
  }
  return currentMs > baselineMs;
}

export function shouldClearCapacityRetryInFlight(input: {
  readonly dispatchAccepted: boolean;
  readonly observedStarting: boolean;
  readonly sessionStatus: string | null | undefined;
  readonly baselineUpdatedAt: string | null | undefined;
  readonly currentUpdatedAt: string | null | undefined;
}): boolean {
  if (input.sessionStatus !== "error") return false;
  if (input.observedStarting) return true;
  return (
    input.dispatchAccepted &&
    hasCapacityRetryProjectionAdvancedSince(input.baselineUpdatedAt, input.currentUpdatedAt)
  );
}

/**
 * Derive capacity retry state only from typed durable system-error rows. The
 * current latest turn gates the CTA; rows before a visible user message or a
 * different terminal error cannot contribute to the automatic backoff streak.
 */
export function deriveCapacityRetryState(input: {
  readonly timelineEntries: ReadonlyArray<TimelineEntry>;
  readonly latestTurnId: TurnId | null | undefined;
}): CapacityRetryState | null {
  const latestTurnId = input.latestTurnId;
  if (latestTurnId === null || latestTurnId === undefined) return null;

  let currentRowIndex = -1;
  let latestTerminalRowIndex = -1;
  for (let index = input.timelineEntries.length - 1; index >= 0; index -= 1) {
    const entry = input.timelineEntries[index];
    if (entry?.kind !== "system-error" && entry?.kind !== "turn-error") continue;
    latestTerminalRowIndex = index;
    break;
  }
  if (latestTerminalRowIndex < 0) return null;
  const latestTerminalRow = input.timelineEntries[latestTerminalRowIndex];
  if (latestTerminalRow?.kind !== "system-error" || latestTerminalRow.turnId !== latestTurnId) {
    return null;
  }
  for (let index = latestTerminalRowIndex + 1; index < input.timelineEntries.length; index += 1) {
    const entry = input.timelineEntries[index];
    if (entry?.kind === "message" && entry.message.role === "user") {
      return null;
    }
  }
  const systemError = latestTerminalRow.entry.systemError;
  if (systemError?.provider !== "codex" || systemError.errorInfo !== "serverOverloaded") {
    return null;
  }
  currentRowIndex = latestTerminalRowIndex;
  if (currentRowIndex < 0) return null;

  let streak = 0;
  const countedTurnIds = new Set<TurnId>();
  for (let index = currentRowIndex; index >= 0; index -= 1) {
    const entry = input.timelineEntries[index];
    if (!entry) continue;
    if (entry.kind === "message" && entry.message.role === "user") break;
    if (entry.kind === "turn-error") break;
    if (entry.kind !== "system-error") continue;
    const systemError = entry.entry.systemError;
    if (systemError?.provider !== "codex" || systemError.errorInfo !== "serverOverloaded") {
      break;
    }
    if (entry.turnId === null || entry.turnId === undefined) break;
    if (countedTurnIds.has(entry.turnId)) continue;
    countedTurnIds.add(entry.turnId);
    streak += 1;
  }
  if (streak === 0) return null;
  return {
    turnId: latestTurnId,
    delaySeconds: CAPACITY_RETRY_DELAYS_SECONDS[streak - 1] ?? null,
  };
}

import {
  type GeneratedImageGallery,
  generatedImageGalleryKey,
  isTypedGeneratedImageEntry,
  groupGeneratedImagesByTurn,
  suppressGeneratedImageCompatibilityMarkdown,
  hasGeneratedImageGalleryContent,
} from "./generatedImageGallery.logic";
export {
  type GeneratedImageGallery,
  type GeneratedImageGalleryImage,
  generatedImageTurnKey,
  generatedImageGalleryKey,
  isTypedGeneratedImageEntry,
  groupGeneratedImagesByTurn,
  omitGeneratedImageWorkEntries,
  suppressGeneratedImageCompatibilityMarkdown,
  hasGeneratedImageGalleryContent,
} from "./generatedImageGallery.logic";

// A "Show N more" toggle costs a row of its own, so hiding one or two rows
// behind it saves nothing and only hides work. Lists collapse only when the
// toggle would hide at least this many rows.
export const MIN_HIDDEN_ROWS_TO_COLLAPSE = 3;

// How many of `total` rows a list capped at `maxVisible` hides, or 0 when the
// cap would hide too few rows to be worth a toggle.
export function collapsibleHiddenRowCount(total: number, maxVisible: number): number {
  const hidden = Math.max(0, total - Math.max(0, maxVisible));
  return hidden >= MIN_HIDDEN_ROWS_TO_COLLAPSE ? hidden : 0;
}

export function canSubmitUserMessageEdit(input: {
  draft: string;
  allowEmpty: boolean;
  disabled: boolean;
}): boolean {
  return (input.allowEmpty || input.draft.trim().length > 0) && !input.disabled;
}

// Ordered item folded into a settled turn's single turn header disclosure.
// A turn can interleave tool work and intermediate assistant narration
// (preambles), so the collapsed panel keeps both in chronological order.
export type CollapsedTurnItem =
  | { kind: "work"; id: string; entry: WorkLogEntry }
  | { kind: "reasoning"; id: string; entry: WorkLogEntry }
  | { kind: "todo-plan"; id: string; tasks: ReadonlyArray<TaskListTaskSnapshot> }
  | { kind: "narration"; id: string; message: ChatMessage };

// A settled turn's collapsed items re-chunked for rendering: consecutive
// summarizable tool rows fold into one "Ran N commands..." disclosure while
// narration and rich rows pass through individually.
export type CollapsedTurnChunk =
  | { kind: "item"; item: CollapsedTurnItem }
  | { kind: "tool-group"; id: string; entries: WorkLogEntry[] }
  | { kind: "background-group"; id: string; entries: WorkLogEntry[] };

export type WorkEntryChunk =
  | { kind: "item"; id: string; entry: WorkLogEntry }
  | { kind: "tool-group"; id: string; entries: WorkLogEntry[] }
  | { kind: "background-group"; id: string; entries: WorkLogEntry[] };

// A cascade of background task rows reads as noise past a couple; three or
// more in a row share one expandable line.
export const MIN_BACKGROUND_TASK_GROUP_SIZE = 3;

function isBackgroundTaskItem(
  item: CollapsedTurnItem,
): item is Extract<CollapsedTurnItem, { kind: "work" }> {
  return item.kind === "work" && item.entry.backgroundTask !== undefined;
}

// Splits runs of 3+ consecutive background task rows into their own group.
function groupBackgroundTaskRuns(chunks: ReadonlyArray<CollapsedTurnChunk>): CollapsedTurnChunk[] {
  const grouped: CollapsedTurnChunk[] = [];
  let run: Extract<CollapsedTurnItem, { kind: "work" }>[] = [];
  const flushRun = () => {
    if (run.length >= MIN_BACKGROUND_TASK_GROUP_SIZE) {
      grouped.push({
        kind: "background-group",
        id: run[0]!.id,
        entries: run.map((item) => item.entry),
      });
    } else {
      for (const item of run) grouped.push({ kind: "item", item });
    }
    run = [];
  };
  for (const chunk of chunks) {
    if (chunk.kind === "item" && isBackgroundTaskItem(chunk.item)) {
      run.push(chunk.item);
      continue;
    }
    flushRun();
    grouped.push(chunk);
  }
  flushRun();
  return grouped;
}

export function mergeAdjacentSubagentRunItems(
  items: ReadonlyArray<CollapsedTurnItem>,
): CollapsedTurnItem[] {
  const merged: CollapsedTurnItem[] = [];
  for (const item of items) {
    const previous = merged.at(-1);
    if (
      item.kind !== "work" ||
      !item.entry.subagentRun ||
      previous?.kind !== "work" ||
      !previous.entry.subagentRun ||
      (previous.entry.turnId !== undefined &&
        item.entry.turnId !== undefined &&
        previous.entry.turnId !== item.entry.turnId)
    ) {
      merged.push(item);
      continue;
    }
    const nextMembers = item.entry.subagentRun.members;
    const previousMembers = previous.entry.subagentRun.members;
    const overlaps = previousMembers.some((member) =>
      nextMembers.some((next) => next.key === member.key),
    );
    if (overlaps) {
      merged.push(item);
      continue;
    }
    merged[merged.length - 1] = {
      kind: "work",
      id: previous.id,
      entry: {
        ...previous.entry,
        subagents: [...(previous.entry.subagents ?? []), ...(item.entry.subagents ?? [])],
        subagentRun: {
          members: [...previousMembers, ...nextMembers],
          entryIds: [
            ...(previous.entry.subagentRun.entryIds ?? [previous.entry.id]),
            ...(item.entry.subagentRun.entryIds ?? [item.entry.id]),
          ],
        },
      },
    };
  }
  return merged;
}

export function chunkCollapsedTurnItems(
  items: ReadonlyArray<CollapsedTurnItem>,
): CollapsedTurnChunk[] {
  const chunks: CollapsedTurnChunk[] = [];
  let pendingRun: Extract<CollapsedTurnItem, { kind: "work" }>[] = [];

  const flushPendingRun = () => {
    if (pendingRun.length === 0) return;
    const pendingRowCount = pendingRun.reduce(
      (total, item) => total + workEntryRowCount(item.entry),
      0,
    );
    if (pendingRowCount >= MIN_COLLAPSIBLE_TOOL_GROUP_SIZE) {
      chunks.push({
        kind: "tool-group",
        id: pendingRun[0]!.id,
        entries: pendingRun.map((item) => item.entry),
      });
    } else {
      for (const item of pendingRun) {
        chunks.push({ kind: "item", item });
      }
    }
    pendingRun = [];
  };

  for (const item of items) {
    if (item.kind === "work" && isSummarizableToolCallEntry(item.entry)) {
      pendingRun.push(item);
      continue;
    }
    flushPendingRun();
    chunks.push({ kind: "item", item });
  }
  flushPendingRun();
  return groupBackgroundTaskRuns(chunks);
}

export function chunkWorkEntries(entries: ReadonlyArray<WorkLogEntry>): WorkEntryChunk[] {
  return chunkCollapsedTurnItems(
    entries.map((entry) => ({ kind: "work" as const, id: entry.id, entry })),
  ).map((chunk) => {
    if (chunk.kind === "tool-group" || chunk.kind === "background-group") return chunk;
    if (chunk.item.kind !== "work") {
      throw new Error("Work-entry chunking produced an unexpected narration item.");
    }
    return { kind: "item", id: chunk.item.id, entry: chunk.item.entry };
  });
}

// One renderable block of a work group: `summary` is non-null when the block
// renders collapsed behind a "Ran N commands..." disclosure. `liveEntry` is
// non-null while a tool run is still open: the run renders as one line wearing
// the latest status description, falling back to the newest call.
export interface WorkEntryRenderPlanChunk {
  id: string;
  entries: WorkLogEntry[];
  summary: ToolCallGroupSummary | null;
  liveEntry: WorkLogEntry | null;
  // Three or more background task rows sharing one expandable line.
  backgroundGroup?: boolean;
}

// Keep the latest activity description visible as technical calls arrive.
function pickLiveToolEntry(entries: ReadonlyArray<WorkLogEntry>): WorkLogEntry {
  return entries.findLast(isCodexActivityStatusWorkEntry) ?? entries.at(-1)!;
}

// Plans a work group's entries block by block. Boundaries are the entries a
// summary can never absorb — thinking/info narration, errors, rich cards — so
// each tool run between boundaries folds independently. A run stays expanded
// only while it still has running work, or while it is the trailing block of
// the live transcript tail (`tailIsLive`): the moment a new narration block
// starts after it, it stops being the tail and collapses mid-turn. An expanded
// run never lists its rows: it folds to a single line for its selected entry.
export function planWorkEntryRenderChunks(
  entries: ReadonlyArray<WorkLogEntry>,
  options: { tailIsLive: boolean },
): WorkEntryRenderPlanChunk[] {
  const chunks = chunkWorkEntries(entries);
  return chunks.map((chunk, index) => {
    if (chunk.kind === "item") {
      return { id: chunk.id, entries: [chunk.entry], summary: null, liveEntry: null };
    }
    if (chunk.kind === "background-group") {
      return {
        id: chunk.id,
        entries: chunk.entries,
        summary: null,
        liveEntry: null,
        backgroundGroup: true,
      };
    }
    const summary = summarizeToolCallGroup(chunk.entries);
    const isLiveTail = options.tailIsLive && index === chunks.length - 1;
    const collapsed = summary !== null && !summary.hasRunningEntry && !isLiveTail;
    return {
      id: chunk.id,
      entries: chunk.entries,
      summary: collapsed ? summary : null,
      liveEntry: summary !== null && !collapsed ? pickLiveToolEntry(chunk.entries) : null,
    };
  });
}

// A folded chunk renders as one line (settled summary or live newest call)
// instead of listing its rows.
export function isFoldedWorkEntryChunk(chunk: WorkEntryRenderPlanChunk): boolean {
  return chunk.summary !== null || chunk.liveEntry !== null || chunk.backgroundGroup === true;
}

// How a folded chunk renders: the line's summary, the rows its disclosure
// reveals, and a suffix for the open-state key. A live line reveals only the
// other entries, and keeps its own open state so the run
// settles collapsed even when the live line was opened.
export function resolveWorkEntryChunkFold(
  chunk: WorkEntryRenderPlanChunk,
): { summary: ToolCallGroupSummary; entries: WorkLogEntry[]; keySuffix: string } | null {
  if (chunk.summary !== null) {
    return { summary: chunk.summary, entries: chunk.entries, keySuffix: "" };
  }
  const liveSummary = chunk.liveEntry ? summarizeToolCallGroup(chunk.entries) : null;
  if (!liveSummary) return null;
  return {
    summary: liveSummary,
    // A multi-file edit wears a count ("Edited 9 files"), so its own file rows
    // still belong behind the line.
    entries: chunk.entries.filter(
      (entry) => entry !== chunk.liveEntry || workEntryRowCount(entry) > 1,
    ),
    keySuffix: ":live",
  };
}

export interface CappedWorkEntryRenderPlan {
  chunks: WorkEntryRenderPlanChunk[];
  hasOverflow: boolean;
  hiddenEntryCount: number;
}

// Keeps collapsed summaries intact while bounding only the entries that still
// render openly. Callers can exclude boundary/status rows from the budget when
// those rows are rendered separately from tool calls.
export function capOpenWorkEntryRenderChunks(
  chunks: ReadonlyArray<WorkEntryRenderPlanChunk>,
  options: {
    expanded: boolean;
    maxVisibleEntries: number;
    keep: "first" | "last";
    shouldCapEntry?: (entry: WorkLogEntry) => boolean;
  },
): CappedWorkEntryRenderPlan {
  const shouldCapEntry = options.shouldCapEntry ?? (() => true);
  const openEntries = chunks.flatMap((chunk) =>
    isFoldedWorkEntryChunk(chunk) ? [] : chunk.entries.filter(shouldCapEntry),
  );
  const maxVisibleEntries = Math.max(0, options.maxVisibleEntries);
  const hiddenEntryCount = collapsibleHiddenRowCount(openEntries.length, maxVisibleEntries);
  const hasOverflow = hiddenEntryCount > 0;

  if (!hasOverflow || options.expanded) {
    return { chunks: [...chunks], hasOverflow, hiddenEntryCount: 0 };
  }

  const visibleEntries =
    maxVisibleEntries === 0
      ? []
      : options.keep === "last"
        ? openEntries.slice(-maxVisibleEntries)
        : openEntries.slice(0, maxVisibleEntries);
  const visibleEntrySet = new Set(visibleEntries);

  return {
    chunks: chunks.map((chunk) => {
      if (isFoldedWorkEntryChunk(chunk)) return chunk;
      return {
        ...chunk,
        entries: chunk.entries.filter(
          (entry) => !shouldCapEntry(entry) || visibleEntrySet.has(entry),
        ),
      };
    }),
    hasOverflow,
    hiddenEntryCount,
  };
}

// The newest work group in the transcript — the one still allowed to render its
// rows inline while the turn is live. Everything older collapses to a summary.
export function findLastLiveWorkGroupId(rows: ReadonlyArray<MessagesTimelineRow>): string | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.kind === "work") {
      return row.id;
    }
    if (row.kind === "message") {
      const groupId = row.inlineWorkGroupId ?? row.leadingWorkGroupId;
      if (groupId) {
        return groupId;
      }
      // A user message closes the previous turn: nothing before it is live.
      if (row.message.role === "user") {
        return null;
      }
    }
  }
  return null;
}

/** The model a turn ran on, as the provider reported it. */
export interface TurnModel {
  readonly provider: ProviderKind;
  readonly model: string;
}

/** Provider-reported lifecycle of one turn, used for its settled header. */
export interface TurnTiming {
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  /** The turn ended interrupted; the source may be unknown. */
  readonly interrupted: boolean;
  /** A Stop request for this turn preceded its interrupted outcome. */
  readonly stoppedByUser?: boolean;
  /** The provider ended the turn early (error, usage limit, crash). */
  readonly failed?: boolean;
  /** Short reason for a provider-side interruption, when known. */
  readonly failureReason?: string | null;
  readonly model?: TurnModel | null;
}

function activityPayloadRecord(
  activity: OrchestrationThreadActivity,
): Record<string, unknown> | null {
  const payload = activity.payload;
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

const MAX_TURN_FAILURE_REASON_CHARS = 80;

// A short, human reason for a provider-side interruption: well-known causes get
// a fixed phrase, anything else its first line, clipped to sit in a header.
export function summarizeTurnFailureReason(input: {
  errorCode?: string | null;
  message?: string | null;
}): string | null {
  const message = input.message?.trim() ?? "";
  if (input.errorCode === "server_overloaded" || /at capacity|overloaded/i.test(message)) {
    return "model at capacity";
  }
  if (/usage limit|rate limit|quota|out of credits/i.test(message)) {
    return "usage limit reached";
  }
  if (isProviderSignInExpiredError(message)) {
    return "sign-in expired";
  }
  const firstLine = message.split(/\r?\n/u, 1)[0]?.trim() ?? "";
  if (firstLine.length === 0) {
    return null;
  }
  return firstLine.length > MAX_TURN_FAILURE_REASON_CHARS
    ? `${firstLine.slice(0, MAX_TURN_FAILURE_REASON_CHARS - 1).trimEnd()}…`
    : firstLine;
}

// The model a `turn.started` activity names; Claude's context-window reports
// stand in for turns recorded before turns carried their model.
function activityTurnModel(activity: OrchestrationThreadActivity): {
  model: TurnModel;
  authoritative: boolean;
} | null {
  const payload = activityPayloadRecord(activity);
  if (activity.kind === "turn.started") {
    const model = nonEmptyString(payload?.model);
    const provider = nonEmptyString(payload?.provider);
    return model && provider && isProviderKind(provider)
      ? { model: { provider, model }, authoritative: true }
      : null;
  }
  if (activity.kind === "context-window.updated") {
    const claudeCache = payload?.claudeCache;
    const model =
      typeof claudeCache === "object" && claudeCache !== null
        ? nonEmptyString((claudeCache as Record<string, unknown>).model)
        : null;
    return model ? { model: { provider: "claudeAgent", model }, authoritative: false } : null;
  }
  return null;
}

// Collects what the thread knows about each turn's real start, end and outcome.
// Checkpoints carry earlier turns, the latest turn carries the live one, and the
// turn lifecycle activities say which turns were stopped or failed and which
// model ran them.
export function deriveTurnTimingByTurnId(input: {
  turnDiffSummaries: ReadonlyArray<Pick<TurnDiffSummary, "turnId" | "startedAt" | "completedAt">>;
  latestTurn: Pick<
    OrchestrationLatestTurn,
    "turnId" | "state" | "startedAt" | "completedAt"
  > | null;
  activities: ReadonlyArray<OrchestrationThreadActivity>;
}): ReadonlyMap<TurnId, TurnTiming> {
  const timings = new Map<TurnId, TurnTiming>();
  const update = (turnId: TurnId, patch: Partial<TurnTiming>) => {
    const timing = timings.get(turnId);
    timings.set(turnId, {
      startedAt: timing?.startedAt ?? null,
      completedAt: timing?.completedAt ?? null,
      interrupted: timing?.interrupted ?? false,
      ...(timing?.failed ? { failed: true, failureReason: timing.failureReason ?? null } : {}),
      ...(timing?.model ? { model: timing.model } : {}),
      ...patch,
    });
  };
  for (const summary of input.turnDiffSummaries) {
    timings.set(summary.turnId, {
      startedAt: summary.startedAt ?? null,
      completedAt: summary.completedAt,
      interrupted: false,
    });
  }
  const settledStateByTurnId = new Map<TurnId, unknown>();
  const authoritativeModelTurnIds = new Set<TurnId>();
  const stopRequestedAtByTurnId = new Map<TurnId, string>();
  for (const activity of input.activities) {
    if (activity.turnId === null) continue;
    const payload = activityPayloadRecord(activity);
    if (activity.kind === "turn.stop-requested" && payload?.requestedBy === "user") {
      if (!stopRequestedAtByTurnId.has(activity.turnId))
        stopRequestedAtByTurnId.set(activity.turnId, activity.createdAt);
      continue;
    }
    if (activity.kind === "turn.started") {
      update(activity.turnId, {
        startedAt: timings.get(activity.turnId)?.startedAt ?? activity.createdAt,
      });
    }
    if (activity.kind === "turn.completed") {
      update(activity.turnId, {
        completedAt: timings.get(activity.turnId)?.completedAt ?? activity.createdAt,
      });
    }
    const turnModel = activityTurnModel(activity);
    if (turnModel && !authoritativeModelTurnIds.has(activity.turnId)) {
      if (turnModel.authoritative) authoritativeModelTurnIds.add(activity.turnId);
      update(activity.turnId, { model: turnModel.model });
      continue;
    }
    if (activity.kind === "turn.completed" || activity.kind === "turn.aborted") {
      settledStateByTurnId.set(
        activity.turnId,
        activity.kind === "turn.aborted" ? "interrupted" : payload?.state,
      );
    }
    const stopped =
      activity.kind === "turn.aborted" ||
      (activity.kind === "turn.completed" &&
        (payload?.state === "interrupted" || payload?.state === "cancelled"));
    if (stopped) {
      update(activity.turnId, {
        completedAt: timings.get(activity.turnId)?.completedAt ?? activity.createdAt,
        interrupted: true,
      });
      continue;
    }
    const failed =
      (activity.kind === "turn.completed" &&
        (payload?.state === "failed" || activity.tone === "error")) ||
      activity.kind === "runtime.error";
    if (failed) {
      const previousReason = timings.get(activity.turnId)?.failureReason ?? null;
      update(activity.turnId, {
        failed: true,
        failureReason:
          summarizeTurnFailureReason({
            errorCode: nonEmptyString(payload?.errorCode),
            message: nonEmptyString(payload?.errorMessage) ?? nonEmptyString(payload?.message),
          }) ?? previousReason,
        ...(activity.kind === "turn.completed"
          ? { completedAt: timings.get(activity.turnId)?.completedAt ?? activity.createdAt }
          : {}),
      });
    }
  }
  // A runtime error the turn recovered from is not how it ended.
  for (const [turnId, state] of settledStateByTurnId) {
    const timing = timings.get(turnId);
    if (timing?.failed && state === "completed") {
      const { failed: _failed, failureReason: _failureReason, ...rest } = timing;
      timings.set(turnId, rest);
    }
  }
  const latestTurn = input.latestTurn;
  if (latestTurn) {
    const timing = timings.get(latestTurn.turnId);
    update(latestTurn.turnId, {
      startedAt: latestTurn.startedAt ?? timing?.startedAt ?? null,
      completedAt: latestTurn.completedAt ?? timing?.completedAt ?? null,
      interrupted: latestTurn.state === "interrupted" || (timing?.interrupted ?? false),
      ...(latestTurn.state === "error" && !timing?.failed
        ? { failed: true, failureReason: null }
        : {}),
    });
  }
  for (const [turnId, timing] of timings) {
    const requestedAt = stopRequestedAtByTurnId.get(turnId);
    if (
      timing.interrupted &&
      !timing.failed &&
      requestedAt &&
      timing.completedAt &&
      Date.parse(requestedAt) <= Date.parse(timing.completedAt)
    ) {
      timings.set(turnId, { ...timing, stoppedByUser: true });
    }
  }
  return timings;
}

// "“Run delayed echo” finished", or a count when several tasks woke the turn.
export function formatTurnResumedBy(resumedBy: ReadonlyArray<TurnResumedBy>): string {
  if (resumedBy.length === 1) {
    const [only] = resumedBy;
    return `“${only!.description ?? "Background task"}” ${only!.outcome}`;
  }
  const outcomes = new Set(resumedBy.map((item) => item.outcome));
  return outcomes.size === 1
    ? `${resumedBy.length} background tasks ${resumedBy[0]!.outcome}`
    : `${resumedBy.length} background tasks ended`;
}

// The text of a settled turn header, without the clock time, model or icon:
// "Worked 20s", "Stopped by you after 16s", "Interrupted after 16s · usage
// limit reached", "Resumed: “Run delayed echo” finished · 3s".
export function editedFilesFromWorkEntries(
  entries: ReadonlyArray<Pick<WorkLogEntry, "changedFiles" | "requestKind" | "itemType">>,
): TurnDiffSummary["files"] {
  const byPath = new Map<string, TurnDiffSummary["files"][number]>();
  for (const entry of entries) {
    if (entry.requestKind !== "file-change" && entry.itemType !== "file_change") continue;
    for (const path of entry.changedFiles ?? []) {
      const trimmed = path.trim();
      if (!trimmed || byPath.has(trimmed)) continue;
      byPath.set(trimmed, { path: trimmed, kind: "modified" });
    }
  }
  return [...byPath.values()];
}

export function formatTurnHeaderLabel(
  header: Pick<TurnHeader, "elapsed" | "outcome" | "reason" | "resumedBy">,
): string {
  switch (header.outcome) {
    case "stopped":
      return header.elapsed ? `Stopped by you after ${header.elapsed}` : "Stopped by you";
    case "interrupted": {
      const base = header.elapsed ? `Interrupted after ${header.elapsed}` : "Interrupted";
      return header.reason ? `${base} · ${header.reason}` : base;
    }
    case "completed":
      if (header.resumedBy && header.resumedBy.length > 0) {
        const resumed = `Resumed: ${formatTurnResumedBy(header.resumedBy)}`;
        return header.elapsed ? `${resumed} · ${header.elapsed}` : resumed;
      }
      return header.elapsed ? `Worked for ${header.elapsed}` : "Details";
  }
}

export interface TimelineDurationMessage {
  codexReplay?: ChatMessage["codexReplay"];
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  turnId?: string | null;
  completedAt?: string | undefined;
}

interface TimelineDiffMessage {
  id: MessageId;
  role: "user" | "assistant" | "system";
  turnId: TurnId | null;
}

/** A background task whose completion woke the agent into a new turn. */
export interface TurnResumedBy {
  readonly description: string | null;
  readonly outcome: "finished" | "failed" | "stopped" | "updated";
}

/**
 * The line that opens every settled turn: "Worked 20s · 22:33 ✓", with the
 * final state, the model only when it changed since the previous turn, and
 * the background task that woke the turn when one did.
 */
export interface TurnHeader {
  readonly elapsed: string | null;
  /** When the turn ended, for the clock time. */
  readonly endedAt: string | null;
  readonly outcome: "completed" | "stopped" | "interrupted";
  /** Why the provider interrupted the turn, when known. */
  readonly reason: string | null;
  readonly modelChange: TurnModel | null;
  readonly resumedBy: ReadonlyArray<TurnResumedBy> | null;
}

export interface TurnEndMarker {
  readonly elapsed: string | null;
  readonly outcome: "stopped" | "interrupted";
  readonly reason: string | null;
}

export type MessagesTimelineRow =
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: WorkLogEntry[];
      // Set on the last row of a stopped turn that has no settled header.
      turnEndMarker?: TurnEndMarker;
    }
  | {
      /** Synthetic divider for a model change seeded into the local turn. */
      kind: "model-changed";
      id: string;
      createdAt: string;
      messageId: MessageId;
      fromModel: string;
      toModel: string;
      fromModelDisplayName?: string;
      toModelDisplayName?: string;
      status?: "optimistic" | "durable" | "failed";
    }
  | {
      /** Provider-owned reroute divider; never generic turn work. */
      kind: "model-rerouted";
      id: string;
      createdAt: string;
      sequence?: number;
      turnId?: TurnId | null;
      fromModel: string;
      toModel: string;
      reason: ModelReroutedReason;
    }
  | {
      /** User-owned stop attribution; never generic work or Worked-for. */
      kind: "user-stopped";
      id: string;
      createdAt: string;
      turnId: TurnId;
      userMessageId: MessageId;
      startedAt: string;
      completedAt: string;
    }
  | {
      /** Explicit provider failure attached to the anchored local turn. */
      kind: "turn-error";
      id: string;
      createdAt: string;
      messageId: MessageId;
      message: string;
    }
  | {
      /** Durable typed terminal provider failure, never generic Worked-for work. */
      kind: "system-error";
      id: string;
      createdAt: string;
      sequence?: number;
      turnId?: TurnId | null;
      entry: WorkLogEntry;
    }
  | {
      /** Compaction is a standalone status primitive, not turn work. */
      kind: "context-compaction";
      id: string;
      createdAt: string;
      entry: WorkLogEntry;
    }
  | {
      /** Provider checklist progress is a compact transcript primitive. */
      kind: "todo-plan";
      id: string;
      createdAt: string;
      sequence?: number;
      turnId?: TurnId | null;
      tasks: ReadonlyArray<TaskListTaskSnapshot>;
    }
  | {
      /** Reasoning is a first-class transcript primitive, not generic work. */
      kind: "reasoning";
      id: string;
      createdAt: string;
      entry: WorkLogEntry;
      active: boolean;
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      leadingWorkEntries?: WorkLogEntry[];
      leadingWorkGroupId?: string;
      inlineWorkEntries?: WorkLogEntry[];
      inlineWorkGroupId?: string;
      /** Visible pages remain between this turn's Worked-for row and its prose. */
      inlineHtmlRenders?: Array<{
        id: string;
        htmlRender: HtmlRenderReference;
      }>;
      collapsedTurnItems?: CollapsedTurnItem[];
      // Set on the terminal assistant, or the request if an interrupted turn
      // produced no assistant/work rows.
      collapsedWorkDurationMs?: number | null;
      collapsedWorkElapsed?: string | null;
      turnHeader?: TurnHeader;
      leadingInlineVisuals?: ReadonlyArray<InlineVisualActivityPayload>;
      // Set on the last row of a stopped turn that has no settled header.
      turnEndMarker?: TurnEndMarker;
      durationStart: string;
      showAssistantCopyButton: boolean;
      assistantCopyStreaming: boolean;
      assistantTurnDiffSummary?: TurnDiffSummary | undefined;
      generatedImageGallery?: GeneratedImageGallery | undefined;
      // True while this row's turn is still running. The end-of-turn changes
      // card (Undo / Review) is held back until the turn settles so it cannot
      // pre-empt the composer's live changes strip mid-turn.
      assistantTurnInProgress?: boolean | undefined;
      revertTurnCount?: number | undefined;
    }
  | {
      /** Standalone assistant-labelled gallery for a provider turn with no assistant item. */
      kind: "generated-image-gallery";
      id: string;
      createdAt: string;
      gallery: GeneratedImageGallery;
    }
  | {
      // One slice of a completed assistant message whose streamed text was
      // interleaved with tool rows; rendered compactly at its own start time.
      kind: "message-segment";
      id: string;
      createdAt: string;
      message: ChatMessage;
      segmentIndex: number;
      generatedImageGallery?: GeneratedImageGallery | undefined;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      // A visual the agent published with `moss_show_visual` that the reply did
      // not place, and that no settled answer has absorbed under its header.
      kind: "inline-visual";
      id: string;
      createdAt: string;
      visual: InlineVisualActivityPayload;
      turnId?: TurnId;
      turnEndMarker?: TurnEndMarker;
    }
  | {
      kind: "html-render";
      id: string;
      createdAt: string;
      turnId?: TurnId | null;
      htmlRender: HtmlRenderReference;
    }
  | {
      // An answered agent question shown as a question/answer exchange. Like
      // the plan card it stays visible when the turn folds into the turn header.
      kind: "user-input";
      id: string;
      createdAt: string;
      entry: WorkLogEntry & { userInputExchange: ReadonlyArray<WorkLogUserInputExchangeItem> };
    }
  | { kind: "working"; id: string; createdAt: string | null }
  | {
      // Live-turn header that mirrors the settled turn header ("Working 12s"
      // + hairline), but is non-collapsible and counts up while the turn is
      // still running. Sits at the top of the active turn.
      kind: "working-header";
      id: string;
      createdAt: string;
      modelChange?: TurnModel | null;
      resumedBy?: ReadonlyArray<TurnResumedBy> | null;
    }
  | {
      // Transient "Preparing worktree..." step card shown during the New
      // worktree first-send setup. `open` drives the shared disclosure close
      // animation while the presentation hook keeps the row mounted.
      kind: "worktree-setup";
      id: string;
      steps: ReadonlyArray<WorktreeSetupStep>;
      open: boolean;
    };

export interface StableMessagesTimelineRowsState {
  byId: Map<string, MessagesTimelineRow>;
  result: MessagesTimelineRow[];
}

export interface ThreadFindJumpTarget {
  rowIndex: number;
  visibleMessageId: MessageId;
  expandCollapsedWorkMessageId?: MessageId;
  collapsedNarrationMessageId?: MessageId;
}

/**
 * Map a find match onto the row that currently owns it. Settled turns splice
 * earlier assistant messages out of the live list and fold them into the
 * terminal row's collapsed narration, so jumping by message id alone misses.
 */
export function resolveWorkEntryJumpTarget(
  rows: readonly MessagesTimelineRow[],
  entryId: string,
): { rowIndex: number; expandCollapsedWorkMessageId?: MessageId } | null {
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex]!;
    if (row.kind === "work" && row.groupedEntries.some((entry) => entry.id === entryId)) {
      return { rowIndex };
    }
    if (row.kind !== "message") continue;
    const hasEntry = (entries: readonly WorkLogEntry[] | undefined) =>
      (entries ?? []).some((entry) => entry.id === entryId);
    if (hasEntry(row.leadingWorkEntries) || hasEntry(row.inlineWorkEntries)) {
      return { rowIndex };
    }
    if (
      (row.collapsedTurnItems ?? []).some(
        (item) => item.kind === "work" && item.entry.id === entryId,
      )
    ) {
      return { rowIndex, expandCollapsedWorkMessageId: row.message.id };
    }
  }
  return null;
}

export function resolveThreadFindJumpTarget(
  rows: readonly MessagesTimelineRow[],
  match: { messageId: MessageId; segmentIndex?: number },
): ThreadFindJumpTarget | null {
  const { messageId, segmentIndex } = match;
  if (segmentIndex !== undefined) {
    const segmentRowIndex = rows.findIndex(
      (row) =>
        row.kind === "message-segment" &&
        row.message.id === messageId &&
        row.segmentIndex === segmentIndex,
    );
    if (segmentRowIndex >= 0) {
      return { rowIndex: segmentRowIndex, visibleMessageId: messageId };
    }
  }

  const messageRowIndex = rows.findIndex(
    (row) => row.kind === "message" && row.message.id === messageId,
  );
  if (messageRowIndex >= 0) {
    return { rowIndex: messageRowIndex, visibleMessageId: messageId };
  }

  const anySegmentRowIndex = rows.findIndex(
    (row) => row.kind === "message-segment" && row.message.id === messageId,
  );
  if (anySegmentRowIndex >= 0) {
    return { rowIndex: anySegmentRowIndex, visibleMessageId: messageId };
  }

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex]!;
    if (row.kind !== "message" || row.message.role !== "assistant") {
      continue;
    }
    const hasNarration = (row.collapsedTurnItems ?? []).some(
      (item) => item.kind === "narration" && item.message.id === messageId,
    );
    if (!hasNarration) {
      continue;
    }
    return {
      rowIndex,
      visibleMessageId: row.message.id,
      expandCollapsedWorkMessageId: row.message.id,
      collapsedNarrationMessageId: messageId,
    };
  }

  return null;
}

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && message.completedAt) {
      lastBoundary = message.completedAt;
    }
  }

  return result;
}

export function normalizeCompactToolLabel(value: string): string {
  return normalizeCompactToolLabelValue(value);
}

export function resolveAssistantMessageCopyState({
  text,
  showCopyButton,
  streaming,
}: {
  text: string | null;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const normalizedText = text?.trim() ? text : null;
  return {
    text: normalizedText,
    visible: showCopyButton && normalizedText !== null && !streaming,
  };
}

export type ContextCompactionPresentationMode = "manual" | "automatic" | "work";
export type ContextCompactionPresentationState = "active" | "settled" | "failed" | "cancelled";

/**
 * Compaction rows carry no tool lifecycle, so their terminal wording is the state;
 * a failed or stopped compaction must never read as compacted.
 */
export function contextCompactionPresentationState(input: {
  liveState: string | undefined;
  toolStatus: string | undefined;
  label: string;
}): ContextCompactionPresentationState {
  const { liveState, toolStatus, label } = input;
  if (liveState === "failed" || toolStatus === "failed" || /\bfailed\b/iu.test(label)) {
    return "failed";
  }
  if (liveState === "cancelled" || toolStatus === "cancelled" || /\bcancell?ed\b/iu.test(label)) {
    return "cancelled";
  }
  if (
    liveState === "completed" ||
    toolStatus === "completed" ||
    /(?:compacted|optimized)/iu.test(label)
  ) {
    return "settled";
  }
  return "active";
}

/**
 * Keeps the Codex compaction state matrix in one pure presentation seam. Moss
 * only selects Work mode when the provider payload explicitly carries it.
 */
export function contextCompactionDisplayLabel(input: {
  mode: ContextCompactionPresentationMode;
  state: ContextCompactionPresentationState;
}): string | null {
  if (input.state === "failed" || input.state === "cancelled") {
    return null;
  }
  if (input.mode === "work") {
    return input.state === "active" ? "Optimizing the conversation" : "Optimized the conversation";
  }
  if (input.mode === "manual") {
    return input.state === "active" ? "Compacting context" : "Context compacted";
  }
  return input.state === "active"
    ? "Context automatically compacting"
    : "Context automatically compacted";
}

/** Known provider labels are persisted with the local anchor; all unseen slugs
 * intentionally use the localized Custom fallback instead of exposing a slug. */
export function resolveTranscriptModelDisplayName(input: {
  model: string;
  displayName?: string;
  customLabel: string;
}): string {
  const displayName = input.displayName?.trim();
  if (displayName && displayName.length > 0) {
    return displayName;
  }
  const normalizedModel = input.model.trim().toLowerCase();
  for (const options of Object.values(MODEL_OPTIONS_BY_PROVIDER)) {
    const known = options.find((option) => option.slug.toLowerCase() === normalizedModel);
    if (known) {
      return formatModelDisplayName(known.slug) ?? known.name;
    }
  }
  // Runtime-discovered providers persist their provider formatter label on the
  // record. Arbitrary/unknown slugs remain localized Custom instead of leaking
  // an internal identifier.
  return input.customLabel;
}

type AssistantMessageDisplayInput = {
  readonly message: Pick<ChatMessage, "text" | "streaming">;
  readonly leadingWorkEntries?: ReadonlyArray<WorkLogEntry>;
  readonly inlineWorkEntries?: ReadonlyArray<WorkLogEntry>;
  readonly inlineHtmlRenders?: ReadonlyArray<{
    id: string;
    htmlRender: HtmlRenderReference;
  }>;
  readonly collapsedTurnItems?: ReadonlyArray<CollapsedTurnItem>;
  readonly generatedImageGallery?: GeneratedImageGallery | null | undefined;
};

function isVisibleGeneratedImageEntry(entry: WorkLogEntry): boolean {
  return (
    entry.itemType === "image_generation" &&
    entry.activityKind === "tool.completed" &&
    entry.tone !== "error" &&
    (entry.generatedImage == null || entry.generatedImage.state === "completed")
  );
}

/**
 * Resolves the markdown body for an assistant row. A completed image-generation
 * work item is already visible non-text output, so an adjacent empty provider
 * message must not add the misleading "(empty response)" placeholder. Truly
 * empty settled turns retain the placeholder, and live empty text stays blank.
 */
export function resolveAssistantMessageDisplayText(
  input: AssistantMessageDisplayInput,
  locale: MossLocaleCode = "en",
): string | null {
  const compatibilitySuppressedText = suppressGeneratedImageCompatibilityMarkdown(
    input.message.text,
    input.generatedImageGallery,
  );
  const hasVisibleGeneratedImage = [
    ...(input.leadingWorkEntries ?? []),
    ...(input.inlineWorkEntries ?? []),
    ...(input.collapsedTurnItems ?? []).flatMap((item) =>
      item.kind === "work" ? [item.entry] : [],
    ),
  ].some(isVisibleGeneratedImageEntry);
  const hasVisibleHtmlRender = (input.inlineHtmlRenders?.length ?? 0) > 0;

  let displayText: string | null;
  if (compatibilitySuppressedText.trim().length > 0) {
    displayText = compatibilitySuppressedText;
  } else if (input.message.streaming) {
    displayText = "";
  } else if (input.message.text && hasGeneratedImageGalleryContent(input.generatedImageGallery)) {
    displayText = null;
  } else if (
    hasVisibleGeneratedImage ||
    hasVisibleHtmlRender ||
    hasGeneratedImageGalleryContent(input.generatedImageGallery)
  ) {
    displayText = null;
  } else {
    displayText = "(empty response)";
  }
  if (displayText === null) {
    return null;
  }
  return localizeProviderRuntimeMessage(displayText, locale);
}

// Builds the "Files changed" lookup keyed by the last assistant row in the
// user-visible response segment. Provider mini-turns can emit diffs before the
// final answer, so the card follows the segment tail instead of the raw turn.
export function buildTurnDiffSummaryByAssistantMessageId(input: {
  turnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
  messages: ReadonlyArray<TimelineDiffMessage>;
}): Map<MessageId, TurnDiffSummary> {
  const byMessageId = new Map<MessageId, TurnDiffSummary>();
  if (input.turnDiffSummaries.length === 0) return byMessageId;

  const summaryByTurnId = new Map<string, TurnDiffSummary>();
  for (const summary of input.turnDiffSummaries) {
    summaryByTurnId.set(summary.turnId, summary);
  }

  const messageIndexByTurnId = new Map<string, number>();
  for (let index = 0; index < input.messages.length; index += 1) {
    const message = input.messages[index]!;
    if (message.role !== "assistant" || !message.turnId) continue;
    messageIndexByTurnId.set(message.turnId, index);
  }

  for (const [turnId, summary] of summaryByTurnId) {
    const anchorIndex = messageIndexByTurnId.get(turnId);
    if (anchorIndex === undefined) continue;
    let terminalAssistantMessageId: MessageId | null = null;
    for (let index = anchorIndex; index < input.messages.length; index += 1) {
      const message = input.messages[index]!;
      if (index > anchorIndex && message.role === "user") break;
      if (message.role === "assistant") {
        terminalAssistantMessageId = message.id;
      }
    }
    if (!terminalAssistantMessageId) continue;

    byMessageId.set(
      terminalAssistantMessageId,
      mergeTurnDiffSummaries(byMessageId.get(terminalAssistantMessageId), summary),
    );
  }
  return byMessageId;
}

// Keeps multi-turn provider responses from losing earlier "Files changed" rows
// when several turn-diff summaries anchor to the same final assistant message.
function mergeTurnDiffSummaries(
  existing: TurnDiffSummary | undefined,
  next: TurnDiffSummary,
): TurnDiffSummary {
  const checkpointTurnCountsFor = (summary: TurnDiffSummary): number[] => {
    if (
      summary.files.length === 0 ||
      summary.status === "missing" ||
      summary.status === "error" ||
      summary.checkpointRef === undefined ||
      summary.checkpointRef.startsWith("provider-diff:")
    ) {
      return [];
    }
    return (
      summary.checkpointTurnCounts ??
      (summary.checkpointTurnCount === undefined ? [] : [summary.checkpointTurnCount])
    );
  };
  if (!existing) {
    const checkpointTurnCounts = checkpointTurnCountsFor(next);
    return { ...next, checkpointTurnCounts };
  }

  const filesByPath = new Map(existing.files.map((file) => [file.path, file]));
  for (const file of next.files) {
    filesByPath.set(file.path, file);
  }
  const checkpointTurnCounts = new Set([
    ...checkpointTurnCountsFor(existing),
    ...checkpointTurnCountsFor(next),
  ]);
  const undoMetadata =
    checkpointTurnCountsFor(next).length > 0
      ? next
      : checkpointTurnCountsFor(existing).length > 0
        ? existing
        : next;
  const allDisplayedFilesUndoable = [existing, next].every(
    (summary) => summary.files.length === 0 || checkpointTurnCountsFor(summary).length > 0,
  );

  return {
    ...next,
    files: [...filesByPath.values()],
    checkpointRef: undoMetadata.checkpointRef,
    status: undoMetadata.status,
    checkpointTurnCount: undoMetadata.checkpointTurnCount,
    checkpointTurnCounts: allDisplayedFilesUndoable
      ? [...checkpointTurnCounts].toSorted((left, right) => left - right)
      : [],
  };
}

export function deriveTerminalAssistantMessageIds(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Set<string> {
  const terminalAssistantMessageIds = new Set<string>();
  let latestAssistantMessageId: string | null = null;

  for (const message of messages) {
    if (message.codexReplay) {
      if (latestAssistantMessageId) terminalAssistantMessageIds.add(latestAssistantMessageId);
      latestAssistantMessageId = null;
      const terminalId = message.codexReplay.turn.terminalMessageId;
      if (terminalId) terminalAssistantMessageIds.add(terminalId);
      continue;
    }
    if (message.role !== "assistant") {
      if (latestAssistantMessageId) {
        terminalAssistantMessageIds.add(latestAssistantMessageId);
        latestAssistantMessageId = null;
      }
      continue;
    }
    latestAssistantMessageId = message.id;
  }

  if (latestAssistantMessageId) {
    terminalAssistantMessageIds.add(latestAssistantMessageId);
  }

  return terminalAssistantMessageIds;
}

// Server-posted coordinator notices and provider handoff boundaries keep their own
// row: they are not turn work, so they never merge into or fold with a turn.
function isNonFoldableWorkEntry(
  entry: Pick<WorkLogEntry, "mossWorkerNotice" | "providerHandoff" | "turnFailure">,
): boolean {
  return Boolean(entry.mossWorkerNotice || entry.providerHandoff || entry.turnFailure);
}

// Server-posted coordinator notices and provider handoff boundaries keep their own
// row: they are not turn work, so they never merge into or fold with a turn.
export function isStandaloneWorkEntry(
  entry: Pick<
    WorkLogEntry,
    | "mossWorkerNotice"
    | "providerHandoff"
    | "turnFailure"
    | "subagentRun"
    | "activityKind"
    | "nativeEventType"
    | "turnId"
  >,
): boolean {
  return Boolean(
    entry.mossWorkerNotice ||
    entry.providerHandoff ||
    entry.turnFailure ||
    entry.subagentRun ||
    (entry.activityKind === "runtime.warning" &&
      entry.turnId == null &&
      isCodexRuntimeWarningType(entry.nativeEventType)),
  );
}

// Derives transcript rows from timeline entries while keeping live narration and
// tool rows in visual chronology. Work already waiting when assistant text
// arrives renders above that text; trailing work renders below it.
export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  isWorking: boolean;
  suppressWorkingIndicator?: boolean;
  worktreeSetup: WorktreeSetupSnapshot | null;
  worktreeSetupOpen: boolean;
  activeTurnInProgress?: boolean;
  // Background subagents still running after the parent turn ended: the parent
  // turn is idle but its work is not done, so it must not fold yet.
  subagentsRunning?: boolean;
  // User setting: false keeps every finished turn expanded.
  collapseFinishedTurns?: boolean;
  activeTurnId?: TurnId | null | undefined;
  activeTurnStartedAt: string | null;
  userStoppedRecords?: ReadonlyArray<UserStoppedRecord>;
  turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>;
  revertTurnCountByUserMessageId: ReadonlyMap<MessageId, number>;
  // Real per-turn start/end/outcome; settled headers fall back to message
  // timestamps for turns missing here.
  turnTimingByTurnId?: ReadonlyMap<TurnId, TurnTiming>;
  conversationOnly?: boolean;
}): MessagesTimelineRow[] {
  const nextRows: MessagesTimelineRow[] = [];
  const embeddedVisualOwners = collectInlineVisualEmbedOwners(input.timelineEntries);
  const generatedImageGalleries = groupGeneratedImagesByTurn(input.timelineEntries);
  const generatedImageTurnsWithTerminalAssistant = new Set<string>();
  // Typed image-generation activities remain in the chronology walk only long
  // enough to place their dedicated gallery row. They are never passed to
  // generic work grouping or Worked-for folding; legacy untyped records remain
  // ordinary work entries for compatibility.
  // A finished background task wakes the agent into a new response, so it ends
  // the previous response and starts the next one's clock like a user message.
  const responseMessages = input.timelineEntries.flatMap((entry): TimelineDurationMessage[] =>
    entry.kind === "message"
      ? [entry.message]
      : entry.kind === "work" &&
          (entry.entry.backgroundTaskCompletion || entry.entry.monitorNotification)
        ? [{ id: entry.id, role: "user", createdAt: entry.createdAt }]
        : [],
  );
  const terminalMessageCandidates = input.timelineEntries.flatMap(
    (entry): TimelineDurationMessage[] =>
      entry.kind === "message" || entry.kind === "message-segment"
        ? [entry.message]
        : entry.kind === "work" &&
            (entry.entry.backgroundTaskCompletion || entry.entry.monitorNotification)
          ? [{ id: entry.id, role: "user", createdAt: entry.createdAt }]
          : [],
  );
  const durationStartByMessageId = computeMessageDurationStart(responseMessages);
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(terminalMessageCandidates);
  for (const message of terminalMessageCandidates) {
    if (
      message.role === "assistant" &&
      message.turnId != null &&
      terminalAssistantMessageIds.has(message.id)
    ) {
      generatedImageTurnsWithTerminalAssistant.add(String(message.turnId));
    }
  }
  const terminalSegmentIndexByAssistantMessageId = new Map<string, number>();
  for (const timelineEntry of input.timelineEntries) {
    if (
      timelineEntry.kind !== "message-segment" ||
      timelineEntry.message.role !== "assistant" ||
      !terminalAssistantMessageIds.has(timelineEntry.message.id)
    ) {
      continue;
    }
    const current = terminalSegmentIndexByAssistantMessageId.get(timelineEntry.message.id);
    if (current === undefined || timelineEntry.segmentIndex > current) {
      terminalSegmentIndexByAssistantMessageId.set(
        timelineEntry.message.id,
        timelineEntry.segmentIndex,
      );
    }
  }
  const insertedStandaloneGeneratedImageGalleryKeys = new Set<string>();
  let pendingWorkGroup: Extract<MessagesTimelineRow, { kind: "work" }> | null = null;

  const groupedEntriesEqual = (
    left: ReadonlyArray<WorkLogEntry>,
    right: ReadonlyArray<WorkLogEntry>,
  ) => left.length === right.length && left.every((entry, index) => entry === right[index]);

  const appendWorkEntriesToPreviousAssistant = (
    groupedEntries: WorkLogEntry[],
    groupId: string,
  ): boolean => {
    const previousRow = nextRows.at(-1);
    if (
      !previousRow ||
      previousRow.kind !== "message" ||
      previousRow.message.role !== "assistant"
    ) {
      return false;
    }

    const nextInlineWorkEntries = previousRow.inlineWorkEntries
      ? [...previousRow.inlineWorkEntries, ...groupedEntries]
      : groupedEntries;

    if (groupedEntriesEqual(previousRow.inlineWorkEntries ?? [], nextInlineWorkEntries)) {
      return true;
    }

    previousRow.inlineWorkEntries = nextInlineWorkEntries;
    previousRow.inlineWorkGroupId ??= groupId;
    return true;
  };

  const flushPendingWorkGroup = (options?: { attachToPreviousAssistant?: boolean }) => {
    if (!pendingWorkGroup) return;
    const shouldAttachToPreviousAssistant = options?.attachToPreviousAssistant ?? true;
    if (
      !shouldAttachToPreviousAssistant ||
      !appendWorkEntriesToPreviousAssistant(pendingWorkGroup.groupedEntries, pendingWorkGroup.id)
    ) {
      nextRows.push(pendingWorkGroup);
    }
    pendingWorkGroup = null;
  };

  // Index of the last content entry (work/message/segment): a reasoning row only
  // gets the dedicated live-disclosure treatment at the transcript tail. Reasoning
  // with content after it has settled and follows the ordinary work-row path
  // (folded line + click-through to the activity detail, upstream parity).
  let lastContentEntryIndex = -1;
  for (let scan = input.timelineEntries.length - 1; scan >= 0; scan -= 1) {
    const candidate = input.timelineEntries[scan]!;
    if (
      candidate.kind === "work" ||
      candidate.kind === "message" ||
      candidate.kind === "message-segment"
    ) {
      lastContentEntryIndex = scan;
      break;
    }
  }
  for (let index = 0; index < input.timelineEntries.length; index += 1) {
    const timelineEntry = input.timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    if (timelineEntry.kind === "work" && isTypedGeneratedImageEntry(timelineEntry.entry)) {
      const galleryKey = generatedImageGalleryKey(timelineEntry.entry);
      const gallery = generatedImageGalleries.get(galleryKey);
      if (
        !gallery ||
        generatedImageTurnsWithTerminalAssistant.has(galleryKey) ||
        insertedStandaloneGeneratedImageGalleryKeys.has(galleryKey)
      ) {
        continue;
      }

      // Preserve the image activity's original transcript position. This is
      // especially important for a no-assistant turn between two user turns.
      flushPendingWorkGroup();
      insertedStandaloneGeneratedImageGalleryKeys.add(galleryKey);
      nextRows.push({
        kind: "generated-image-gallery",
        id: `generated-image-gallery:${galleryKey}`,
        createdAt: gallery.createdAt,
        gallery,
      });
      continue;
    }

    if (timelineEntry.kind === "work") {
      // Only intercept tail reasoning that carries real reasoning content. A bare
      // status line (preview only, no detail/lifecycle id) is the live group's
      // status wear, and settled reasoning behind later content follows the
      // ordinary work-row path — upstream folds both into the run, not into a
      // dedicated reasoning disclosure.
      if (
        isReasoningPresentationEntry(timelineEntry.entry) &&
        index >= lastContentEntryIndex &&
        (timelineEntry.entry.toolCallId !== undefined ||
          timelineEntry.entry.liveActivity !== undefined ||
          timelineEntry.entry.toolStatus !== undefined ||
          // Legacy progress summaries contain only a bold heading and an HTML
          // comment. Keep their readable status instead of hiding it inside a
          // disclosure whose heading stripping would leave an empty body.
          resolveReasoningBody(timelineEntry.entry.detail ?? "", "settled")
            .replace(/<!--[\s\S]*?-->/gu, "")
            .trim().length > 0)
      ) {
        flushPendingWorkGroup();
        nextRows.push({
          kind: "reasoning",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          entry: timelineEntry.entry,
          active: isReasoningPresentationActive(timelineEntry.entry),
        });
        continue;
      }
      const run = [
        { entry: timelineEntry.entry, id: timelineEntry.id, createdAt: timelineEntry.createdAt },
      ];
      let cursor = index + 1;
      while (cursor < input.timelineEntries.length) {
        const nextEntry = input.timelineEntries[cursor];
        if (
          !nextEntry ||
          nextEntry.kind !== "work" ||
          isTypedGeneratedImageEntry(nextEntry.entry) ||
          isReasoningPresentationEntry(nextEntry.entry)
        )
          break;
        run.push({ entry: nextEntry.entry, id: nextEntry.id, createdAt: nextEntry.createdAt });
        cursor += 1;
      }
      // Server-posted coordinator monitor rows keep their own work row: the
      // leading/inline merges into an assistant message hide them on
      // conversation-only surfaces, so they must never join a mergeable group.
      // Background task completions do too: they separate two responses.
      for (const runEntry of run) {
        if (runEntry.entry.subagentRun) {
          flushPendingWorkGroup({ attachToPreviousAssistant: false });
          const previous = nextRows.at(-1);
          const members = runEntry.entry.subagentRun.members;
          if (
            runEntry.entry.turnId &&
            previous?.kind === "work" &&
            previous.groupedEntries.every(
              (entry) =>
                entry.subagentRun &&
                entry.turnId === runEntry.entry.turnId &&
                !entry.subagentRun.members.some((member) =>
                  members.some((next) => next.key === member.key),
                ),
            )
          ) {
            previous.groupedEntries.push(runEntry.entry);
          } else {
            nextRows.push({
              kind: "work",
              id: runEntry.id,
              createdAt: runEntry.createdAt,
              groupedEntries: [runEntry.entry],
            });
          }
          continue;
        }
        const inlineVisual = runEntry.entry.inlineVisual;
        if (inlineVisual) {
          // A visual the reply places renders inside that message. One the
          // running turn has not placed yet waits for its reply instead of
          // showing above it and then jumping into the text.
          if (
            embeddedVisualOwners.has(inlineVisual.visualId) ||
            (input.activeTurnInProgress === true &&
              runEntry.entry.turnId != null &&
              runEntry.entry.turnId === input.activeTurnId)
          ) {
            continue;
          }
          flushPendingWorkGroup({ attachToPreviousAssistant: false });
          nextRows.push({
            kind: "inline-visual",
            id: runEntry.id,
            createdAt: runEntry.createdAt,
            visual: inlineVisual,
            ...(runEntry.entry.turnId ? { turnId: runEntry.entry.turnId } : {}),
          });
          continue;
        }
        const userInputExchange = runEntry.entry.userInputExchange;
        if (userInputExchange) {
          flushPendingWorkGroup({ attachToPreviousAssistant: false });
          nextRows.push({
            kind: "user-input",
            id: runEntry.id,
            createdAt: runEntry.createdAt,
            entry: { ...runEntry.entry, userInputExchange },
          });
        } else if (
          isStandaloneWorkEntry(runEntry.entry) ||
          runEntry.entry.backgroundTaskCompletion ||
          runEntry.entry.monitorNotification
        ) {
          flushPendingWorkGroup();
          nextRows.push({
            kind: "work",
            id: runEntry.id,
            createdAt: runEntry.createdAt,
            groupedEntries: [runEntry.entry],
          });
        } else if (pendingWorkGroup) {
          pendingWorkGroup.groupedEntries.push(runEntry.entry);
        } else {
          pendingWorkGroup = {
            kind: "work",
            id: runEntry.id,
            createdAt: runEntry.createdAt,
            groupedEntries: [runEntry.entry],
          };
        }
      }
      index = cursor - 1;
      continue;
    }

    if (timelineEntry.kind === "model-changed") {
      flushPendingWorkGroup({ attachToPreviousAssistant: false });
      nextRows.push({
        kind: "model-changed",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        messageId: timelineEntry.messageId,
        fromModel: timelineEntry.fromModel,
        toModel: timelineEntry.toModel,
        ...(timelineEntry.fromModelDisplayName
          ? { fromModelDisplayName: timelineEntry.fromModelDisplayName }
          : {}),
        ...(timelineEntry.toModelDisplayName
          ? { toModelDisplayName: timelineEntry.toModelDisplayName }
          : {}),
        ...(timelineEntry.status ? { status: timelineEntry.status } : {}),
      });
      continue;
    }

    if (timelineEntry.kind === "model-rerouted") {
      // Reroute risk copy is a standalone provider primitive. Keep it outside
      // generic work and outside the settled Worked-for fold.
      flushPendingWorkGroup({ attachToPreviousAssistant: false });
      nextRows.push({
        kind: "model-rerouted",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        ...(timelineEntry.sequence !== undefined ? { sequence: timelineEntry.sequence } : {}),
        ...(timelineEntry.turnId !== undefined ? { turnId: timelineEntry.turnId } : {}),
        fromModel: timelineEntry.fromModel,
        toModel: timelineEntry.toModel,
        reason: timelineEntry.reason,
      });
      continue;
    }

    if (timelineEntry.kind === "turn-error") {
      // A failed local turn stays visible after the optimistic user item; it is
      // a transcript boundary and must never be absorbed by Worked-for.
      flushPendingWorkGroup({ attachToPreviousAssistant: false });
      nextRows.push({
        kind: "turn-error",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        messageId: timelineEntry.messageId,
        message: timelineEntry.message,
      });
      continue;
    }

    if (timelineEntry.kind === "system-error") {
      // Typed terminal failures are a standalone transcript primitive. Keep a
      // hard boundary so the source activity cannot be absorbed into Worked-for.
      flushPendingWorkGroup({ attachToPreviousAssistant: false });
      nextRows.push({
        kind: "system-error",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        ...(timelineEntry.sequence !== undefined ? { sequence: timelineEntry.sequence } : {}),
        ...(timelineEntry.turnId !== undefined ? { turnId: timelineEntry.turnId } : {}),
        entry: timelineEntry.entry,
      });
      continue;
    }

    if (timelineEntry.kind === "context-compaction") {
      // A compaction row is deliberately not attached to the preceding
      // assistant and is a hard boundary for Worked-for collapse.
      flushPendingWorkGroup({ attachToPreviousAssistant: false });
      nextRows.push({
        kind: "context-compaction",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        entry: timelineEntry.entry,
      });
      continue;
    }

    if (timelineEntry.kind === "todo-plan") {
      // Checklist progress is its own compact primitive. It may still be folded
      // into a settled turn by the post-pass, so this row is not a fold boundary.
      flushPendingWorkGroup({ attachToPreviousAssistant: false });
      nextRows.push({
        kind: "todo-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        ...(timelineEntry.sequence !== undefined ? { sequence: timelineEntry.sequence } : {}),
        ...(timelineEntry.turnId !== undefined ? { turnId: timelineEntry.turnId } : {}),
        tasks: timelineEntry.tasks,
      });
      continue;
    }

    if (timelineEntry.kind === "proposed-plan") {
      // A plan card is a visible mid-turn artifact. Keep adjacent work as its
      // own row so final turn collapse can preserve the true chronology.
      flushPendingWorkGroup({ attachToPreviousAssistant: false });
      nextRows.push({
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan,
      });
      continue;
    }

    if (timelineEntry.kind === "html-render") {
      // A published page is part of the reply, so it stays visible like a plan card.
      flushPendingWorkGroup({ attachToPreviousAssistant: false });
      nextRows.push({
        kind: "html-render",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        ...(timelineEntry.turnId !== undefined ? { turnId: timelineEntry.turnId } : {}),
        htmlRender: timelineEntry.htmlRender,
      });
      continue;
    }

    if (timelineEntry.kind === "message-segment") {
      // Interleaved slice of assistant text, already alternating with the tool
      // rows in timeline order. Do not merge pending work into it: segment
      // boundaries ARE tool interventions, so each segment stands alone.
      flushPendingWorkGroup({ attachToPreviousAssistant: false });
      const generatedImageGallery =
        timelineEntry.message.role === "assistant" &&
        timelineEntry.message.turnId != null &&
        terminalAssistantMessageIds.has(timelineEntry.message.id) &&
        terminalSegmentIndexByAssistantMessageId.get(timelineEntry.message.id) ===
          timelineEntry.segmentIndex
          ? generatedImageGalleries.get(String(timelineEntry.message.turnId))
          : undefined;
      nextRows.push({
        kind: "message-segment",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        message: timelineEntry.message,
        segmentIndex: timelineEntry.segmentIndex,
        ...(generatedImageGallery ? { generatedImageGallery } : {}),
      });
      continue;
    }

    const message = timelineEntry.message;
    const leadingWorkEntries =
      message.role === "assistant" ? pendingWorkGroup?.groupedEntries : undefined;
    const leadingWorkGroupId = message.role === "assistant" ? pendingWorkGroup?.id : undefined;
    if (message.role === "assistant") {
      pendingWorkGroup = null;
    } else {
      flushPendingWorkGroup();
    }

    const assistantTurnStillInProgress =
      message.role === "assistant" &&
      input.activeTurnInProgress === true &&
      input.activeTurnId != null &&
      message.turnId === input.activeTurnId;
    const generatedImageGallery =
      message.role === "assistant" &&
      message.turnId != null &&
      terminalAssistantMessageIds.has(message.id)
        ? generatedImageGalleries.get(String(message.turnId))
        : undefined;

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message,
      ...(leadingWorkEntries ? { leadingWorkEntries } : {}),
      ...(leadingWorkGroupId ? { leadingWorkGroupId } : {}),
      durationStart: durationStartByMessageId.get(message.id) ?? message.createdAt,
      showAssistantCopyButton:
        message.role === "assistant" && terminalAssistantMessageIds.has(message.id),
      assistantCopyStreaming: message.streaming || assistantTurnStillInProgress,
      assistantTurnInProgress: assistantTurnStillInProgress,
      assistantTurnDiffSummary:
        message.role === "assistant"
          ? input.turnDiffSummaryByAssistantMessageId.get(message.id)
          : undefined,
      ...(generatedImageGallery ? { generatedImageGallery } : {}),
      revertTurnCount:
        message.role === "user" ? input.revertTurnCountByUserMessageId.get(message.id) : undefined,
    });
  }

  // Keep any trailing work summary visually attached to the last answer so a
  // completed chat does not end with a detached tool-log footer.
  flushPendingWorkGroup();

  const liveBoundary = findLiveTurnHeaderInsertion(nextRows, input.activeTurnId ?? null);
  if (liveBoundary.resumedStartedAt) {
    for (const row of nextRows) {
      if (
        row.kind === "message" &&
        row.message.role === "assistant" &&
        row.assistantTurnInProgress &&
        Date.parse(row.createdAt) < Date.parse(liveBoundary.resumedStartedAt)
      ) {
        row.assistantTurnInProgress = false;
        row.assistantCopyStreaming = row.message.streaming;
      }
    }
  }

  // Legacy Moss stop records remain visible when this turn has no upstream timing.
  // A timed turn uses the upstream stopped header, avoiding duplicate attribution.
  const legacyUserStoppedRecords = (input.userStoppedRecords ?? []).filter(
    (record) => !input.turnTimingByTurnId?.has(record.turnId),
  );
  insertUserStoppedRows(nextRows, legacyUserStoppedRecords);

  if (input.worktreeSetup) {
    nextRows.push({
      kind: "worktree-setup",
      id: "worktree-setup-row",
      steps: input.worktreeSetup.steps,
      open: input.worktreeSetupOpen,
    });
  }

  // An active reasoning primitive owns the Thinking header/body. Do not add a
  // second generic shimmer for the same live activity.
  const hasActiveReasoning = nextRows.some((row) => row.kind === "reasoning" && row.active);
  if (
    input.isWorking &&
    !input.suppressWorkingIndicator &&
    !hasActiveReasoning &&
    !(input.worktreeSetup && input.worktreeSetupOpen)
  ) {
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt,
    });
  }

  if (input.conversationOnly !== true) {
    collapseSettledTurns(nextRows, {
      terminalAssistantMessageIds,
      collapseWork: input.collapseFinishedTurns !== false,
      userStoppedTurnIds: new Set(legacyUserStoppedRecords.map((record) => String(record.turnId))),
      activeTurnInProgress:
        (input.activeTurnInProgress ?? false) || (input.subagentsRunning ?? false),
      activeTurnId: input.activeTurnId ?? null,
      activeResponseStartedAt: liveBoundary.resumedStartedAt,
      turnTimingByTurnId: input.turnTimingByTurnId,
    });
  }

  if (input.conversationOnly !== true && input.turnTimingByTurnId) {
    markInterruptedTurnsWithoutHeader(nextRows, input.turnTimingByTurnId);
  }

  // The live turn wears a "Working 12s" header + hairline — the counting-up
  // twin of a settled turn's header. It anchors to the top of the active turn
  // (right after the user message that opened it, or the background task
  // completion that woke it) and needs a real start time to count from; the
  // trailing "Thinking" shimmer covers the gap before one exists. Inserted
  // after collapse so folding is untouched.
  if (
    input.conversationOnly !== true &&
    input.isWorking &&
    input.activeTurnStartedAt &&
    !(input.worktreeSetup && input.worktreeSetupOpen)
  ) {
    const { index, resumedBy, resumedStartedAt } = findLiveTurnHeaderInsertion(
      nextRows,
      input.activeTurnId ?? null,
    );
    nextRows.splice(index, 0, {
      kind: "working-header",
      id: "working-header-row",
      createdAt: resumedStartedAt ?? input.activeTurnStartedAt,
      ...(resumedBy ? { resumedBy } : {}),
    });
  }

  if (input.conversationOnly !== true && input.turnTimingByTurnId) {
    assignTurnHeaderModelChanges(nextRows, input.turnTimingByTurnId, input.activeTurnId ?? null);
  }

  // A finished background task already shows on its own row and in the header
  // of the turn it woke ("Resumed: … finished"), so its completion line goes.
  return input.conversationOnly === true
    ? nextRows
    : nextRows.filter((row) => !isBackgroundTaskCompletionRow(row));
}

function insertUserStoppedRows(
  rows: MessagesTimelineRow[],
  records: ReadonlyArray<UserStoppedRecord>,
): void {
  for (const record of records) {
    const rowId = userStoppedRowId(record);
    if (rows.some((row) => row.id === rowId)) {
      continue;
    }
    const userIndex = rows.findIndex(
      (row) => row.kind === "message" && row.message.id === record.userMessageId,
    );
    if (userIndex < 0) {
      continue;
    }
    let insertIndex = userIndex + 1;
    while (insertIndex < rows.length) {
      const next = rows[insertIndex]!;
      if (next.kind === "model-rerouted" && next.turnId === record.turnId) {
        insertIndex += 1;
        continue;
      }
      break;
    }
    rows.splice(insertIndex, 0, {
      kind: "user-stopped",
      id: rowId,
      createdAt: record.completedAt,
      turnId: record.turnId,
      userMessageId: record.userMessageId,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
    });
  }
}

function userStoppedRowId(record: UserStoppedRecord): string {
  return `user-stopped:${String(record.threadId)}:${String(record.turnId)}`;
}

// A stopped turn opens with a "Stopped by you after Xs" header when it has a
// final assistant message. One that was stopped before writing anything (or
// with folding turned off) ends on its own rows, so its last row carries the
// turn-end marker.
function markInterruptedTurnsWithoutHeader(
  rows: MessagesTimelineRow[],
  turnTimingByTurnId: ReadonlyMap<TurnId, TurnTiming>,
): void {
  const headedTurnIds = new Set<TurnId>();
  const lastRowIndexByTurnId = new Map<TurnId, number>();
  const requestRowIndexByTurnId = new Map<TurnId, number>();
  rows.forEach((row, index) => {
    if (row.kind === "message" && row.message.role === "assistant" && row.message.turnId) {
      if (row.turnHeader) headedTurnIds.add(row.message.turnId);
      lastRowIndexByTurnId.set(row.message.turnId, index);
    } else if (row.kind === "inline-visual" && row.turnId) {
      lastRowIndexByTurnId.set(row.turnId, index);
    } else if (row.kind === "work") {
      for (const entry of row.groupedEntries) {
        if (entry.turnId) lastRowIndexByTurnId.set(entry.turnId, index);
      }
    } else if (
      row.kind === "message" &&
      row.message.role === "user" &&
      row.message.turnId &&
      row.message.startsNewTurn !== false &&
      !requestRowIndexByTurnId.has(row.message.turnId)
    ) {
      requestRowIndexByTurnId.set(row.message.turnId, index);
    }
  });
  for (const [turnId, index] of lastRowIndexByTurnId) {
    const timing = turnTimingByTurnId.get(turnId);
    if (!timing || (!timing.interrupted && !timing.failed) || headedTurnIds.has(turnId)) continue;
    const row = rows[index]!;
    if (row.kind !== "work" && row.kind !== "message" && row.kind !== "inline-visual") continue;
    row.turnEndMarker = {
      elapsed:
        timing.startedAt && timing.completedAt
          ? (formatElapsed(timing.startedAt, timing.completedAt) ?? null)
          : null,
      outcome: timing.stoppedByUser && !timing.failed ? "stopped" : "interrupted",
      reason: timing.failureReason ?? null,
    };
  }
  // A request bound to a terminal turn is durable ownership evidence. A
  // queued, unbound request or Stop intent alone must never acquire a header.
  for (const [turnId, index] of requestRowIndexByTurnId) {
    if (lastRowIndexByTurnId.has(turnId) || headedTurnIds.has(turnId)) continue;
    const timing = turnTimingByTurnId.get(turnId);
    if (!timing?.completedAt || (!timing.interrupted && !timing.failed)) continue;
    const row = rows[index]!;
    if (row.kind !== "message") continue;
    row.turnHeader = {
      elapsed: timing.startedAt
        ? (formatElapsed(timing.startedAt, timing.completedAt) ?? null)
        : null,
      endedAt: timing.completedAt,
      outcome: timing.stoppedByUser && !timing.failed ? "stopped" : "interrupted",
      reason: timing.failureReason ?? null,
      modelChange: null,
      resumedBy: null,
    };
  }
}

// The live turn starts at the request that opened it, so its header slots in
// right after it: requests queued behind the live turn stay below its work. A
// turn with no request of its own that a background task woke starts at that
// task's completion. A request not yet bound to its turn falls back to the
// most recent user message. Absent any user message (degenerate transcripts)
// the header leads the transcript so the "Working" copy is never lost.
function findLiveTurnHeaderInsertion(
  rows: ReadonlyArray<MessagesTimelineRow>,
  activeTurnId: TurnId | null,
): { index: number; resumedBy: TurnResumedBy[] | null; resumedStartedAt: string | null } {
  const lastCompletionIndex = rows.findLastIndex(isBackgroundTaskCompletionRow);
  const completionRow = rows[lastCompletionIndex];
  const completionBoundary = () => ({
    index: lastCompletionIndex + 1,
    resumedBy: collectResumedBy(rows, lastCompletionIndex),
    resumedStartedAt: completionRow?.kind === "work" ? completionRow.createdAt : null,
  });
  if (activeTurnId !== null) {
    const requestIndex = rows.findLastIndex(
      (row) =>
        row.kind === "message" &&
        row.message.role === "user" &&
        row.message.turnId === activeTurnId,
    );
    if (requestIndex >= 0) {
      // A completed answer before a newer notification proves a response
      // boundary even when the provider reuses the original request's id.
      const precedingAssistant = rows
        .slice(requestIndex + 1, lastCompletionIndex)
        .findLast(
          (row) =>
            row.kind === "message" &&
            row.message.role === "assistant" &&
            row.message.turnId === activeTurnId,
        );
      if (
        lastCompletionIndex > requestIndex &&
        precedingAssistant?.kind === "message" &&
        !precedingAssistant.message.streaming &&
        precedingAssistant.message.completedAt
      ) {
        return completionBoundary();
      }
      return { index: requestIndex + 1, resumedBy: null, resumedStartedAt: null };
    }
  }
  const lastRequestIndex = rows.findLastIndex(
    (row) => row.kind === "message" && row.message.role === "user",
  );
  if (lastCompletionIndex > lastRequestIndex) {
    return completionBoundary();
  }
  return { index: lastRequestIndex + 1, resumedBy: null, resumedStartedAt: null };
}

// Returns the terminal assistant only when it is still the transcript tail.
// A newer user message means the next turn has begun but has not produced text yet.
function isBackgroundTaskCompletionRow(row: MessagesTimelineRow): boolean {
  return (
    row.kind === "work" &&
    row.groupedEntries.some((entry) => entry.backgroundTaskCompletion || entry.monitorNotification)
  );
}

function findTailTerminalAssistantMessageId(
  rows: ReadonlyArray<MessagesTimelineRow>,
  terminalAssistantMessageIds: ReadonlySet<string>,
): string | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    // A response woken by a background task has not produced its own terminal
    // message yet; the previous response stays settled.
    if (isBackgroundTaskCompletionRow(row)) return null;
    if (row.kind !== "message") {
      continue;
    }
    return row.message.role === "assistant" && terminalAssistantMessageIds.has(row.message.id)
      ? row.message.id
      : null;
  }
  return null;
}

// Post-pass: collapse each *settled* turn into a single turn header
// disclosure on the turn's terminal assistant message. Unlike a per-message
// collapse, this folds every non-terminal assistant narration (preambles) AND
// the turn's tool work into one ordered group, so the transcript shows a single
// toggle + the final answer per turn (Remodex-style). The live turn stays
// expanded/inline so streaming output is never hidden behind a toggle.
function collapseSettledTurns(
  rows: MessagesTimelineRow[],
  options: {
    terminalAssistantMessageIds: ReadonlySet<string>;
    collapseWork: boolean;
    userStoppedTurnIds: ReadonlySet<string>;
    activeTurnInProgress: boolean;
    activeTurnId: TurnId | null;
    activeResponseStartedAt: string | null;
    turnTimingByTurnId: ReadonlyMap<TurnId, TurnTiming> | undefined;
  },
): void {
  const { terminalAssistantMessageIds, activeTurnInProgress, activeTurnId, turnTimingByTurnId } =
    options;
  const lastTerminalAssistantMessageId = activeTurnInProgress
    ? findTailTerminalAssistantMessageId(rows, terminalAssistantMessageIds)
    : null;

  const collectWorkItems = (entries: ReadonlyArray<WorkLogEntry>, into: CollapsedTurnItem[]) => {
    for (const entry of entries) {
      into.push({ kind: "work", id: entry.id, entry });
    }
  };

  const earliestTimestamp = (a: string, b: string): string => {
    const aMs = Date.parse(a);
    const bMs = Date.parse(b);
    if (Number.isNaN(aMs)) return b;
    if (Number.isNaN(bMs)) return a;
    return bMs < aMs ? b : a;
  };

  for (let pass = rows.length - 1; pass >= 0; pass -= 1) {
    const row = rows[pass]!;
    if (row.kind !== "message" || row.message.role !== "assistant") continue;
    const message = row.message;
    if (message.asyncUserInput) continue;
    // Only the terminal message of a turn owns the collapsed group.
    if (!terminalAssistantMessageIds.has(message.id)) continue;
    // Never collapse the live turn: streaming text or the in-progress turn stays
    // inline so the user sees output as it arrives.
    if (message.streaming || message.codexReplay?.turn.status === "inProgress") continue;
    const turnId = message.turnId ?? null;
    if (turnId !== null && options.userStoppedTurnIds.has(String(turnId))) continue;
    const turnIsActive =
      activeTurnInProgress &&
      (!options.activeResponseStartedAt ||
        Date.parse(message.createdAt) >= Date.parse(options.activeResponseStartedAt)) &&
      (activeTurnId != null
        ? (turnId != null && turnId === activeTurnId) ||
          message.id === lastTerminalAssistantMessageId
        : message.id === lastTerminalAssistantMessageId);
    if (turnIsActive) continue;

    // Scan back to the response boundary collecting rows to fold. Provider
    // mini-turns can have distinct turnIds inside one assistant answer, so the
    // user message boundary is the stable UI grouping point.
    let foldIndices: number[] = [];
    const inlineHtmlRenderIndices: number[] = [];
    const leadingVisuals: InlineVisualActivityPayload[] = [];
    const visualIndices: number[] = [];
    let wokenAt: string | null = null;
    let resumedBy: TurnResumedBy[] | null = null;
    for (let scan = pass - 1; scan >= 0; scan -= 1) {
      const prev = rows[scan]!;
      // The response started where a background task woke the agent; every
      // completion that arrived together woke it.
      if (isBackgroundTaskCompletionRow(prev)) {
        wokenAt = prev.kind === "work" ? prev.createdAt : null;
        resumedBy = collectResumedBy(rows, scan);
        break;
      }
      if (message.codexReplay && prev.kind === "message") {
        if (
          prev.message.codexReplay?.turn.turnId !== message.codexReplay.turn.turnId ||
          prev.message.codexReplay.openingUser
        )
          break;
        foldIndices.push(scan);
        continue;
      }
      if (message.codexReplay) {
        const nativeTurnId = message.codexReplay.turn.turnId;
        if (
          prev.kind === "work" &&
          prev.groupedEntries.some((entry) => entry.turnId !== nativeTurnId)
        )
          break;
        if (prev.kind === "reasoning" && prev.entry.turnId !== nativeTurnId) break;
        if (prev.kind === "todo-plan" && prev.turnId !== nativeTurnId) break;
        if (prev.kind === "proposed-plan" && prev.proposedPlan.turnId !== nativeTurnId) break;
        if (prev.kind === "html-render" && prev.turnId !== nativeTurnId) break;
        if (prev.kind === "inline-visual" && prev.turnId !== nativeTurnId) break;
      }
      if (prev.kind === "work") {
        // Older fixtures can still hand us a context-compaction entry inside a
        // generic work row. Keep the same hard boundary as the dedicated row.
        if (prev.groupedEntries.some((entry) => entry.activityKind === "context-compaction")) {
          break;
        }
        // Coordinator monitor rows are server-posted system pills, not turn
        // work — folding them into a collapsed turn would hide them on
        // conversation-only surfaces.
        if (prev.groupedEntries.some(isNonFoldableWorkEntry)) continue;
        foldIndices.push(scan);
        continue;
      }
      if (prev.kind === "context-compaction") {
        // A turnless compaction observed between a turn's tool work and its
        // answer belongs to that response's Worked-for disclosure. Keep it in
        // chronology while folding settled rows instead of leaving a detached
        // status card between the answer and its user boundary.
        foldIndices.push(scan);
        continue;
      }
      if (prev.kind === "message" && prev.message.role === "assistant") {
        if (prev.message.asyncUserInput) break;
        foldIndices.push(scan);
        continue;
      }
      // A settled assistant message whose streamed text interleaved with tool
      // rows renders as message-segment slices. They are still this turn's
      // narration, so they fold too instead of stranding everything earlier
      // outside the disclosure.
      if (prev.kind === "message-segment" && !prev.message.streaming) {
        foldIndices.push(scan);
        continue;
      }
      if (prev.kind === "reasoning") {
        // Settled reasoning belongs inside the turn's outer Worked-for summary,
        // while an active reasoning stream remains an independent live row.
        if (prev.active) break;
        foldIndices.push(scan);
        continue;
      }
      if (prev.kind === "todo-plan") {
        foldIndices.push(scan);
        continue;
      }
      if (prev.kind === "inline-visual") {
        // Keep the visual with the answer, under the turn header, instead of
        // leaving it above that header.
        leadingVisuals.unshift(prev.visual);
        visualIndices.push(scan);
        continue;
      }
      if (prev.kind === "html-render") {
        // Visual replies stay visible, but T3 places them after the turn's
        // collapsed Worked-for row and before the final prose. Associate them
        // with the terminal message so this outer row can render that order.
        inlineHtmlRenderIndices.push(scan);
        continue;
      }
      if (prev.kind === "proposed-plan" || prev.kind === "user-input") {
        // The plan card and answered questions stay visible, but they should not strand earlier
        // narration/work outside the final turn header disclosure.
        continue;
      }
      break;
    }
    foldIndices.reverse();
    // A standalone compaction row remains its own status primitive. It only
    // joins Worked-for when there is actual tool work in the same folded span.
    if (!foldIndices.some((index) => rows[index]?.kind === "work")) {
      foldIndices = foldIndices.filter((index) => rows[index]?.kind !== "context-compaction");
    }

    const collapsedItems: CollapsedTurnItem[] = [];
    // The disclosure folds everything back to the user boundary, so "Worked
    // for" must start where the folded segment starts. The terminal row's own
    // durationStart advances past intermediate *completed* assistant messages
    // (e.g. a failed attempt before a retry), which would report only the tail
    // of the turn instead of the full run.
    let collapsedStart = row.durationStart;
    // Provider mini-turns can split one answer across turn ids; the group runs
    // from the earliest of their starts.
    const foldedTurnIds = new Set<TurnId>(turnId ? [turnId] : []);
    // All slices of one segmented message share the same ChatMessage, so the
    // message folds once (at its first slice) to keep narration identity stable.
    const foldedSegmentMessageIds = new Set<string>();
    for (const index of foldIndices) {
      const folded = rows[index]!;
      if (
        (folded.kind === "message" || folded.kind === "message-segment") &&
        folded.message.turnId
      ) {
        foldedTurnIds.add(folded.message.turnId);
      }
      if (folded.kind === "work") {
        collapsedStart = earliestTimestamp(collapsedStart, folded.createdAt);
        collectWorkItems(folded.groupedEntries, collapsedItems);
      } else if (folded.kind === "context-compaction") {
        collapsedStart = earliestTimestamp(collapsedStart, folded.createdAt);
        collapsedItems.push({ kind: "work", id: folded.id, entry: folded.entry });
      } else if (folded.kind === "reasoning") {
        collapsedStart = earliestTimestamp(collapsedStart, folded.createdAt);
        collapsedItems.push({ kind: "reasoning", id: folded.id, entry: folded.entry });
      } else if (folded.kind === "todo-plan") {
        collapsedStart = earliestTimestamp(collapsedStart, folded.createdAt);
        collapsedItems.push({ kind: "todo-plan", id: folded.id, tasks: folded.tasks });
      } else if (folded.kind === "message-segment") {
        collapsedStart = earliestTimestamp(collapsedStart, folded.createdAt);
        if (!foldedSegmentMessageIds.has(folded.message.id)) {
          foldedSegmentMessageIds.add(folded.message.id);
          collapsedItems.push({
            kind: "narration",
            id: folded.message.id,
            message: folded.message,
          });
        }
      } else if (folded.kind === "message") {
        collapsedStart = earliestTimestamp(collapsedStart, folded.durationStart);
        if (folded.assistantTurnDiffSummary) {
          row.assistantTurnDiffSummary = mergeTurnDiffSummaries(
            folded.assistantTurnDiffSummary,
            row.assistantTurnDiffSummary ?? folded.assistantTurnDiffSummary,
          );
        }
        if (folded.leadingWorkEntries) collectWorkItems(folded.leadingWorkEntries, collapsedItems);
        if (folded.collapsedTurnItems) collapsedItems.push(...folded.collapsedTurnItems);
        collapsedItems.push({ kind: "narration", id: folded.message.id, message: folded.message });
        if (folded.inlineWorkEntries) collectWorkItems(folded.inlineWorkEntries, collapsedItems);
      }
    }
    // The terminal's own work rows are details around the final answer; fold
    // them into the disclosure so completed chats do not end with tool-log rows.
    if (row.leadingWorkEntries) collectWorkItems(row.leadingWorkEntries, collapsedItems);
    if (row.inlineWorkEntries) collectWorkItems(row.inlineWorkEntries, collapsedItems);

    // Message timestamps only bound the visible output: a turn without a
    // request (subagent child), a stopped turn, or a turn woken by a
    // background task would report the wrong span. Prefer the turn's own.
    const nextResponseBoundary = rows
      .slice(pass + 1)
      .find(
        (candidate) =>
          isBackgroundTaskCompletionRow(candidate) ||
          (candidate.kind === "message" && candidate.message.role === "user"),
      );
    const nextResponseBoundaryAt =
      nextResponseBoundary?.kind === "work" || nextResponseBoundary?.kind === "message"
        ? nextResponseBoundary.createdAt
        : null;
    const timingForThisResponse = (id: TurnId) => {
      const timing = turnTimingByTurnId?.get(id);
      if (
        nextResponseBoundaryAt &&
        ((timing?.startedAt &&
          Date.parse(timing.startedAt) >= Date.parse(nextResponseBoundaryAt)) ||
          (timing?.completedAt &&
            Date.parse(timing.completedAt) >= Date.parse(nextResponseBoundaryAt)))
      )
        return undefined;
      return timing;
    };
    const turnTiming = turnId ? timingForThisResponse(turnId) : undefined;
    let turnStart: string | null = null;
    for (const foldedTurnId of foldedTurnIds) {
      const startedAt = timingForThisResponse(foldedTurnId)?.startedAt ?? null;
      if (startedAt !== null) {
        turnStart = turnStart === null ? startedAt : earliestTimestamp(turnStart, startedAt);
      }
    }
    // A provider can open the turn a woken response belongs to only when it
    // replies; that response started when the background task finished.
    if (wokenAt !== null) turnStart = wokenAt;
    // A provider can reuse the launching turn id for a notification response.
    // An earlier terminal record belongs to the launch, not the resumed work.
    const responseTiming =
      wokenAt !== null &&
      (!turnTiming?.completedAt || Date.parse(turnTiming.completedAt) < Date.parse(wokenAt))
        ? undefined
        : turnTiming;
    const replay = message.codexReplay?.turn;
    const responseEnd = replay?.completedAt ?? responseTiming?.completedAt ?? message.completedAt;
    const workedDurationMs =
      replay?.durationMs ??
      computeWorkedDurationMs(replay?.startedAt ?? turnStart ?? collapsedStart, responseEnd);
    const elapsed =
      workedDurationMs === null
        ? null
        : formatElapsed(new Date(0).toISOString(), new Date(workedDurationMs).toISOString());
    // Every settled turn opens with its header, with or without work to fold.
    const header: TurnHeader = {
      elapsed: elapsed ?? null,
      endedAt: responseEnd ?? message.createdAt,
      outcome: responseTiming?.failed
        ? "interrupted"
        : responseTiming?.stoppedByUser
          ? "stopped"
          : responseTiming?.interrupted
            ? "interrupted"
            : "completed",
      reason: responseTiming?.failureReason ?? null,
      modelChange: null,
      resumedBy,
    };

    const headerRow = !options.collapseWork
      ? (foldIndices
          .map((index) => rows[index]!)
          .find(
            (candidate): candidate is Extract<MessagesTimelineRow, { kind: "message" }> =>
              candidate.kind === "message" && candidate.message.role === "assistant",
          ) ?? row)
      : row;
    headerRow.turnHeader = header;
    if (leadingVisuals.length > 0) headerRow.leadingInlineVisuals = leadingVisuals;
    if (!options.collapseWork) {
      for (const index of visualIndices.toSorted((a, b) => b - a)) rows.splice(index, 1);
      pass -= visualIndices.length;
      continue;
    }
    if (collapsedItems.length > 0) {
      row.collapsedTurnItems = collapsedItems;
      row.collapsedWorkElapsed = elapsed;
      row.collapsedWorkDurationMs = workedDurationMs;
      if (inlineHtmlRenderIndices.length > 0) {
        row.inlineHtmlRenders = inlineHtmlRenderIndices.flatMap((index) => {
          const visual = rows[index];
          return visual?.kind === "html-render"
            ? [{ id: visual.id, htmlRender: visual.htmlRender }]
            : [];
        });
      }
      delete row.leadingWorkEntries;
      delete row.leadingWorkGroupId;
      delete row.inlineWorkEntries;
      delete row.inlineWorkGroupId;
    }
    const removal = [
      ...new Set([
        ...(collapsedItems.length > 0 ? [...foldIndices, ...inlineHtmlRenderIndices] : []),
        ...visualIndices,
      ]),
    ];
    for (const index of removal.toSorted((a, b) => b - a)) rows.splice(index, 1);
    pass -= removal.length;
  }
}

// The background tasks whose completion rows end at `index`, oldest first.
function collectResumedBy(
  rows: ReadonlyArray<MessagesTimelineRow>,
  index: number,
): TurnResumedBy[] | null {
  const resumedBy: TurnResumedBy[] = [];
  for (let scan = index; scan >= 0; scan -= 1) {
    const row = rows[scan]!;
    if (!isBackgroundTaskCompletionRow(row) || row.kind !== "work") break;
    for (const entry of row.groupedEntries.toReversed()) {
      const completion = entry.backgroundTaskCompletion;
      const monitor = entry.monitorNotification;
      if (!completion && !monitor) continue;
      resumedBy.unshift({
        description: completion?.description ?? monitor?.name ?? null,
        outcome:
          completion?.outcome ??
          (monitor?.outcome === "completed" ? "finished" : monitor?.outcome) ??
          "finished",
      });
    }
  }
  return resumedBy.length > 0 ? resumedBy : null;
}

function turnModelsEqual(left: TurnModel, right: TurnModel): boolean {
  return left.provider === right.provider && left.model === right.model;
}

// Headers name the model only where it changed: each turn compares against
// the previous turn that reported one. The live header compares against the
// last settled one.
function assignTurnHeaderModelChanges(
  rows: MessagesTimelineRow[],
  turnTimingByTurnId: ReadonlyMap<TurnId, TurnTiming>,
  activeTurnId: TurnId | null,
): void {
  let previousModel: TurnModel | null = null;
  for (const row of rows) {
    const turnId =
      row.kind === "message" && row.turnHeader
        ? (row.message.turnId ?? null)
        : row.kind === "working-header"
          ? activeTurnId
          : null;
    if (turnId === null) continue;
    const model = turnTimingByTurnId.get(turnId)?.model ?? null;
    if (!model) continue;
    const modelChange =
      previousModel !== null && !turnModelsEqual(previousModel, model) ? model : null;
    if (row.kind === "message" && row.turnHeader) {
      row.turnHeader = { ...row.turnHeader, modelChange };
    } else if (row.kind === "working-header") {
      row.modelChange = modelChange;
    }
    previousModel = model;
  }
}

// Reuses stable row references so streaming updates only invalidate rows whose
// visible content actually changed.
export function computeStableMessagesTimelineRows(
  rows: MessagesTimelineRow[],
  previous: StableMessagesTimelineRowsState,
): StableMessagesTimelineRowsState {
  const next = new Map<string, MessagesTimelineRow>();
  let anyChanged = rows.length !== previous.byId.size;

  const result = rows.map((row, index) => {
    const prevRow = previous.byId.get(row.id);
    const nextRow = prevRow && isRowUnchanged(prevRow, row) ? prevRow : row;
    next.set(row.id, nextRow);
    if (!anyChanged && previous.result[index] !== nextRow) {
      anyChanged = true;
    }
    return nextRow;
  });

  return anyChanged ? { byId: next, result } : previous;
}

function stringArraysEqual(
  left: ReadonlyArray<string> | undefined,
  right: ReadonlyArray<string> | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function workLogSubagentActionsEqual(
  a: WorkLogEntry["subagentAction"],
  b: WorkLogEntry["subagentAction"],
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.tool === b.tool &&
    a.status === b.status &&
    a.summaryText === b.summaryText &&
    a.model === b.model &&
    a.prompt === b.prompt
  );
}

function workLogSubagentsEqual(
  left: WorkLogEntry["subagents"],
  right: WorkLogEntry["subagents"],
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  return left.every((a, index) => {
    const b = right[index];
    return (
      b !== undefined &&
      a.threadId === b.threadId &&
      a.providerThreadId === b.providerThreadId &&
      a.resolvedThreadId === b.resolvedThreadId &&
      a.agentId === b.agentId &&
      a.nickname === b.nickname &&
      a.role === b.role &&
      a.model === b.model &&
      a.prompt === b.prompt &&
      a.rawStatus === b.rawStatus &&
      a.latestUpdate === b.latestUpdate &&
      a.title === b.title &&
      a.statusLabel === b.statusLabel &&
      a.isActive === b.isActive
    );
  });
}

// The subagent card's per-subagent step and outcome are visible row content too.
function workLogSubagentRunsEqual(a: WorkLogEntry["subagentRun"], b: WorkLogEntry["subagentRun"]) {
  if (a === b) return true;
  if (
    !a ||
    !b ||
    a.members.length !== b.members.length ||
    !stringArraysEqual(a.entryIds, b.entryIds)
  )
    return false;
  return a.members.every((member, index) => {
    const other = b.members[index];
    return (
      other !== undefined &&
      member.key === other.key &&
      member.launchedAt === other.launchedAt &&
      member.latestStep === other.latestStep &&
      member.outcome === other.outcome &&
      member.failure === other.failure &&
      member.settledAt === other.settledAt &&
      member.nextLaunchedAt === other.nextLaunchedAt
    );
  });
}

// Automation card fields are visible row content, so stale equality would freeze the transcript UI.
function workLogAutomationsEqual(a: WorkLogEntry["automation"], b: WorkLogEntry["automation"]) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.cadenceLabel === b.cadenceLabel &&
    a.proposalState === b.proposalState
  );
}

function workLogMossThreadCreationsEqual(
  a: WorkLogEntry["mossThreadCreation"],
  b: WorkLogEntry["mossThreadCreation"],
) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (
    a.operationId !== b.operationId ||
    a.requestedCount !== b.requestedCount ||
    a.createdCount !== b.createdCount ||
    a.threads.length !== b.threads.length
  ) {
    return false;
  }
  return a.threads.every((thread, index) => {
    const other = b.threads[index];
    return (
      other !== undefined &&
      thread.threadId === other.threadId &&
      thread.title === other.title &&
      thread.provider === other.provider &&
      thread.model === other.model &&
      thread.environment === other.environment &&
      thread.status === other.status
    );
  });
}

function workLogToolOutputsEqual(
  a: NonNullable<WorkLogEntry["toolDetails"]>["output"],
  b: NonNullable<WorkLogEntry["toolDetails"]>["output"],
) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.output === b.output &&
    a.stdout === b.stdout &&
    a.stderr === b.stderr &&
    a.exitCode === b.exitCode &&
    a.truncated === b.truncated
  );
}

function workLogToolEditsEqual(
  left: NonNullable<WorkLogEntry["toolDetails"]>["edits"],
  right: NonNullable<WorkLogEntry["toolDetails"]>["edits"],
) {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  return left.every((edit, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      edit.path === other.path &&
      edit.oldText === other.oldText &&
      edit.newText === other.newText
    );
  });
}

function workLogToolDetailsEqual(a: WorkLogEntry["toolDetails"], b: WorkLogEntry["toolDetails"]) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.kind === b.kind &&
    a.title === b.title &&
    a.command === b.command &&
    a.diff === b.diff &&
    a.content === b.content &&
    stringArraysEqual(a.files, b.files) &&
    workLogToolOutputsEqual(a.output, b.output) &&
    workLogToolEditsEqual(a.edits, b.edits)
  );
}

function workLogLiveActivitiesEqual(
  a: WorkLogEntry["liveActivity"],
  b: WorkLogEntry["liveActivity"],
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.state === b.state &&
    a.label === b.label &&
    a.startedAt === b.startedAt &&
    a.lastActivityAt === b.lastActivityAt &&
    a.detail === b.detail &&
    a.progress === b.progress &&
    a.elapsedSeconds === b.elapsedSeconds
  );
}

function runtimeCodexErrorInfoEqual(
  a: RuntimeCodexErrorInfo | undefined,
  b: RuntimeCodexErrorInfo | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (typeof a === "string" || typeof b === "string") return a === b;

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftActive = left.activeTurnNotSteerable as { turnKind?: unknown } | undefined;
  const rightActive = right.activeTurnNotSteerable as { turnKind?: unknown } | undefined;
  if (leftActive !== undefined || rightActive !== undefined) {
    return leftActive?.turnKind === rightActive?.turnKind;
  }

  for (const variant of [
    "httpConnectionFailed",
    "responseStreamConnectionFailed",
    "responseStreamDisconnected",
    "responseTooManyFailedAttempts",
  ]) {
    const leftDetail = left[variant] as { httpStatusCode?: number | null } | undefined;
    const rightDetail = right[variant] as { httpStatusCode?: number | null } | undefined;
    if (leftDetail !== undefined || rightDetail !== undefined) {
      return leftDetail?.httpStatusCode === rightDetail?.httpStatusCode;
    }
  }
  return false;
}

function workLogSystemErrorsEqual(
  a: WorkLogEntry["systemError"],
  b: WorkLogEntry["systemError"],
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.provider === b.provider &&
    a.providerInstanceId === b.providerInstanceId &&
    a.content === b.content &&
    runtimeCodexErrorInfoEqual(a.errorInfo, b.errorInfo)
  );
}

function workLogEntryContentEqual(a: WorkLogEntry, b: WorkLogEntry): boolean {
  return (
    a.id === b.id &&
    a.createdAt === b.createdAt &&
    a.turnId === b.turnId &&
    a.label === b.label &&
    a.detail === b.detail &&
    a.toolTitle === b.toolTitle &&
    a.command === b.command &&
    a.rawCommand === b.rawCommand &&
    a.preview === b.preview &&
    a.tone === b.tone &&
    a.itemType === b.itemType &&
    a.requestKind === b.requestKind &&
    a.activityKind === b.activityKind &&
    a.toolName === b.toolName &&
    a.toolCallId === b.toolCallId &&
    a.toolStatus === b.toolStatus &&
    a.subagentActivity === b.subagentActivity &&
    JSON.stringify(a.fileChangeKinds) === JSON.stringify(b.fileChangeKinds) &&
    a.modelRerouted?.fromModel === b.modelRerouted?.fromModel &&
    a.modelRerouted?.toModel === b.modelRerouted?.toModel &&
    a.modelRerouted?.reason === b.modelRerouted?.reason &&
    generatedImageStatesEqual(a.generatedImage, b.generatedImage) &&
    workLogSystemErrorsEqual(a.systemError, b.systemError) &&
    taskListSnapshotsEqual(a.taskList, b.taskList) &&
    stringArraysEqual(a.changedFiles, b.changedFiles) &&
    workLogSubagentActionsEqual(a.subagentAction, b.subagentAction) &&
    workLogSubagentsEqual(a.subagents, b.subagents) &&
    workLogSubagentRunsEqual(a.subagentRun, b.subagentRun) &&
    workLogAutomationsEqual(a.automation, b.automation) &&
    workLogMossThreadCreationsEqual(a.mossThreadCreation, b.mossThreadCreation) &&
    workLogLiveActivitiesEqual(a.liveActivity, b.liveActivity) &&
    workLogToolDetailsEqual(a.toolDetails, b.toolDetails) &&
    workLogBackgroundTasksEqual(a.backgroundTask, b.backgroundTask) &&
    a.userInputExchange === b.userInputExchange
  );
}

function generatedImageStatesEqual(
  left: WorkLogGeneratedImage | undefined,
  right: WorkLogGeneratedImage | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.state !== right.state) return false;
  if (left.callId !== right.callId) return false;
  if (left.state !== "completed" || right.state !== "completed") return true;
  return left.path === right.path;
}

function generatedImageGalleriesEqual(
  left: GeneratedImageGallery | undefined,
  right: GeneratedImageGallery | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.turnId === right.turnId &&
    left.createdAt === right.createdAt &&
    left.pendingImageCount === right.pendingImageCount &&
    left.images.length === right.images.length &&
    left.images.every((image, index) => {
      const other = right.images[index];
      return (
        other !== undefined &&
        image.id === other.id &&
        image.path === other.path &&
        image.callId === other.callId
      );
    })
  );
}

function taskListSnapshotsEqual(
  left: ReadonlyArray<TaskListTaskSnapshot> | undefined,
  right: ReadonlyArray<TaskListTaskSnapshot> | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((task, index) => {
    const other = right[index];
    return other !== undefined && task.task === other.task && task.status === other.status;
  });
}

function workLogEntryArraysEqual(
  left: ReadonlyArray<WorkLogEntry> | undefined,
  right: ReadonlyArray<WorkLogEntry> | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  return left.every((entry, index) => workLogEntryContentEqual(entry, right[index]!));
}

function inlineHtmlRendersEqual(
  left: ReadonlyArray<{ id: string; htmlRender: HtmlRenderReference }> | undefined,
  right: ReadonlyArray<{ id: string; htmlRender: HtmlRenderReference }> | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every(
    (visual, index) =>
      visual.id === right[index]?.id &&
      htmlRenderReferencesEqual(visual.htmlRender, right[index]!.htmlRender),
  );
}

function collapsedTurnItemsEqual(
  left: ReadonlyArray<CollapsedTurnItem> | undefined,
  right: ReadonlyArray<CollapsedTurnItem> | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  return left.every((item, index) => {
    const other = right[index]!;
    if (item.kind !== other.kind || item.id !== other.id) return false;
    if (item.kind === "work" && other.kind === "work") {
      return workLogEntryContentEqual(item.entry, other.entry);
    }
    if (item.kind === "reasoning" && other.kind === "reasoning") {
      return workLogEntryContentEqual(item.entry, other.entry);
    }
    if (item.kind === "todo-plan" && other.kind === "todo-plan") {
      return taskListSnapshotsEqual(item.tasks, other.tasks);
    }
    if (item.kind === "narration" && other.kind === "narration") {
      return item.message === other.message;
    }
    return false;
  });
}

function turnModelsMatch(left: TurnModel | null, right: TurnModel | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return turnModelsEqual(left, right);
}

function resumedByEqual(
  left: ReadonlyArray<TurnResumedBy> | null,
  right: ReadonlyArray<TurnResumedBy> | null,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every(
    (item, index) =>
      item.description === right[index]!.description && item.outcome === right[index]!.outcome,
  );
}

function turnHeadersEqual(left: TurnHeader | undefined, right: TurnHeader | undefined): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.elapsed === right.elapsed &&
    left.endedAt === right.endedAt &&
    left.outcome === right.outcome &&
    left.reason === right.reason &&
    turnModelsMatch(left.modelChange, right.modelChange) &&
    resumedByEqual(left.resumedBy, right.resumedBy)
  );
}

function turnEndMarkersEqual(
  left: TurnEndMarker | undefined,
  right: TurnEndMarker | undefined,
): boolean {
  return (
    left === right ||
    Boolean(
      left &&
      right &&
      left.elapsed === right.elapsed &&
      left.outcome === right.outcome &&
      left.reason === right.reason,
    )
  );
}

function workLogBackgroundTasksEqual(
  a: WorkLogEntry["backgroundTask"],
  b: WorkLogEntry["backgroundTask"],
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.taskId === b.taskId &&
    a.status === b.status &&
    a.command === b.command &&
    a.description === b.description &&
    a.startedAt === b.startedAt &&
    a.completedAt === b.completedAt &&
    a.exitCode === b.exitCode
  );
}

function inlineVisualsEqual(
  left: ReadonlyArray<InlineVisualActivityPayload> | undefined,
  right: ReadonlyArray<InlineVisualActivityPayload> | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((visual, index) => visual.visualId === right[index]?.visualId);
}

/** Every visual the transcript holds, by id, for replies that place them in their text. */
export function collectInlineVisuals(
  timelineEntries: ReadonlyArray<TimelineEntry>,
): ReadonlyMap<string, InlineVisualActivityPayload> {
  const visuals = new Map<string, InlineVisualActivityPayload>();
  for (const entry of timelineEntries) {
    if (entry.kind === "work" && entry.entry.inlineVisual) {
      visuals.set(entry.entry.inlineVisual.visualId, entry.entry.inlineVisual);
    }
  }
  return visuals;
}

/** Only the last visible assistant reply in the publishing turn can place its visual. */
export function collectInlineVisualEmbedOwners(
  entries: ReadonlyArray<TimelineEntry>,
): ReadonlyMap<string, string> {
  const turnByVisual = new Map<string, string>();
  const replyByTurn = new Map<string, { id: string; text: string }>();
  for (const entry of entries) {
    if (entry.kind === "work" && entry.entry.inlineVisual && entry.entry.turnId) {
      turnByVisual.set(entry.entry.inlineVisual.visualId, entry.entry.turnId);
    } else if (
      (entry.kind === "message" || entry.kind === "message-segment") &&
      entry.message.role === "assistant" &&
      entry.message.turnId
    ) {
      replyByTurn.set(entry.message.turnId, entry.message);
    }
  }
  const owners = new Map<string, string>();
  for (const [turnId, reply] of replyByTurn) {
    for (const id of readInlineVisualEmbedIds(reply.text)) {
      if (turnByVisual.get(id) === turnId) owners.set(id, reply.id);
    }
  }
  return owners;
}

function isRowUnchanged(a: MessagesTimelineRow, b: MessagesTimelineRow): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;

  switch (a.kind) {
    case "working":
      return a.createdAt === (b as typeof a).createdAt;

    case "working-header": {
      const bh = b as typeof a;
      return (
        a.createdAt === bh.createdAt &&
        turnModelsMatch(a.modelChange ?? null, bh.modelChange ?? null) &&
        resumedByEqual(a.resumedBy ?? null, bh.resumedBy ?? null)
      );
    }

    case "worktree-setup": {
      const bw = b as typeof a;
      return (
        a.open === bw.open &&
        a.steps.length === bw.steps.length &&
        a.steps.every((step, index) => {
          const other = bw.steps[index]!;
          return step.id === other.id && step.status === other.status && step.label === other.label;
        })
      );
    }

    case "proposed-plan":
      return a.proposedPlan === (b as typeof a).proposedPlan;

    case "html-render": {
      // Entries rebuild on any activity update; an equal page must keep its mounted frame.
      const bh = b as typeof a;
      return a.createdAt === bh.createdAt && htmlRenderReferencesEqual(a.htmlRender, bh.htmlRender);
    }

    case "user-input":
      return a.entry.userInputExchange === (b as typeof a).entry.userInputExchange;

    case "inline-visual": {
      const bv = b as typeof a;
      return (
        a.visual.visualId === bv.visual.visualId &&
        a.createdAt === bv.createdAt &&
        turnEndMarkersEqual(a.turnEndMarker, bv.turnEndMarker)
      );
    }

    case "work":
      return (
        a.createdAt === (b as typeof a).createdAt &&
        turnEndMarkersEqual(a.turnEndMarker, (b as typeof a).turnEndMarker) &&
        workLogEntryArraysEqual(a.groupedEntries, (b as typeof a).groupedEntries)
      );

    case "model-changed": {
      const bm = b as typeof a;
      return (
        a.createdAt === bm.createdAt &&
        a.messageId === bm.messageId &&
        a.fromModel === bm.fromModel &&
        a.toModel === bm.toModel &&
        a.fromModelDisplayName === bm.fromModelDisplayName &&
        a.toModelDisplayName === bm.toModelDisplayName &&
        a.status === bm.status
      );
    }

    case "model-rerouted": {
      const br = b as typeof a;
      return (
        a.createdAt === br.createdAt &&
        a.sequence === br.sequence &&
        a.turnId === br.turnId &&
        a.fromModel === br.fromModel &&
        a.toModel === br.toModel &&
        a.reason === br.reason
      );
    }

    case "user-stopped": {
      const bs = b as typeof a;
      return (
        a.createdAt === bs.createdAt &&
        a.turnId === bs.turnId &&
        a.userMessageId === bs.userMessageId &&
        a.startedAt === bs.startedAt &&
        a.completedAt === bs.completedAt
      );
    }

    case "turn-error": {
      const be = b as typeof a;
      return (
        a.createdAt === be.createdAt && a.messageId === be.messageId && a.message === be.message
      );
    }

    case "system-error": {
      const be = b as typeof a;
      return (
        a.createdAt === be.createdAt &&
        a.sequence === be.sequence &&
        a.turnId === be.turnId &&
        workLogEntryContentEqual(a.entry, be.entry)
      );
    }

    case "context-compaction": {
      const bc = b as typeof a;
      return a.createdAt === bc.createdAt && workLogEntryContentEqual(a.entry, bc.entry);
    }

    case "reasoning": {
      const br = b as typeof a;
      return (
        a.createdAt === br.createdAt &&
        a.active === br.active &&
        workLogEntryContentEqual(a.entry, br.entry)
      );
    }

    case "todo-plan": {
      const bt = b as typeof a;
      return (
        a.createdAt === bt.createdAt &&
        a.sequence === bt.sequence &&
        a.turnId === bt.turnId &&
        taskListSnapshotsEqual(a.tasks, bt.tasks)
      );
    }

    case "message": {
      const bm = b as typeof a;
      return (
        a.message === bm.message &&
        workLogEntryArraysEqual(a.leadingWorkEntries, bm.leadingWorkEntries) &&
        a.leadingWorkGroupId === bm.leadingWorkGroupId &&
        workLogEntryArraysEqual(a.inlineWorkEntries, bm.inlineWorkEntries) &&
        a.inlineWorkGroupId === bm.inlineWorkGroupId &&
        inlineHtmlRendersEqual(a.inlineHtmlRenders, bm.inlineHtmlRenders) &&
        collapsedTurnItemsEqual(a.collapsedTurnItems, bm.collapsedTurnItems) &&
        turnHeadersEqual(a.turnHeader, bm.turnHeader) &&
        inlineVisualsEqual(a.leadingInlineVisuals, bm.leadingInlineVisuals) &&
        turnEndMarkersEqual(a.turnEndMarker, bm.turnEndMarker) &&
        a.durationStart === bm.durationStart &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantCopyStreaming === bm.assistantCopyStreaming &&
        a.assistantTurnInProgress === bm.assistantTurnInProgress &&
        a.assistantTurnDiffSummary === bm.assistantTurnDiffSummary &&
        generatedImageGalleriesEqual(a.generatedImageGallery, bm.generatedImageGallery) &&
        a.revertTurnCount === bm.revertTurnCount
      );
    }

    case "message-segment": {
      const bm = b as typeof a;
      return (
        a.message === bm.message &&
        a.segmentIndex === bm.segmentIndex &&
        generatedImageGalleriesEqual(a.generatedImageGallery, bm.generatedImageGallery)
      );
    }

    case "generated-image-gallery": {
      const bg = b as typeof a;
      return a.createdAt === bg.createdAt && generatedImageGalleriesEqual(a.gallery, bg.gallery);
    }
  }
}
