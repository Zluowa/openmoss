import { decodeSubagentReceiverThreadIds } from "@synara/shared/subagents";
// Replay uses the live Codex item normalizer and activity projection. This keeps
// Shell, MCP, reasoning and subagent semantics identical across the two paths.
import {
  EventId,
  MessageId,
  ProviderItemId,
  TurnId,
  type CodexReplayItem,
  type CodexReplayTurn,
  type ThreadHistoryImportEntry,
  type ThreadId,
} from "@synara/contracts";
import { mapCodexItemLifecycle } from "../provider/Layers/CodexAdapter";
import { projectProviderRuntimeActivities } from "./providerRuntimeActivityProjection";

export const CODEX_REPLAY_TURN_ACTIVITY_KIND = "codex.turn.replayed";

export interface CodexReplaySourceTurn {
  readonly id?: string;
  readonly items: ReadonlyArray<unknown>;
  readonly status?: string;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly durationMs?: number;
  /** Rollout records expose precise item times; thread/read exposes turn times. */
  readonly itemTimes?: Readonly<
    Record<string, { readonly createdAt: string; readonly updatedAt: string }>
  >;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonempty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function timestamp(seconds: number | undefined): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  const ms = seconds * 1_000;
  return Number.isFinite(new Date(ms).getTime()) ? new Date(ms).toISOString() : null;
}

function isoTimestamp(value: unknown, fallback: string): string {
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // Codex snapshots use seconds for turns and milliseconds for item fields.
    const milliseconds = Math.abs(value) >= 1_000_000_000_000 ? value : value * 1_000;
    const parsed = new Date(milliseconds);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }
  return fallback;
}

function nonNegativeNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  const duration = asRecord(value);
  if (
    duration &&
    typeof duration.secs === "number" &&
    Number.isFinite(duration.secs) &&
    typeof duration.nanos === "number" &&
    Number.isFinite(duration.nanos) &&
    duration.secs >= 0 &&
    duration.nanos >= 0
  ) {
    return Math.floor(duration.secs * 1_000 + duration.nanos / 1_000_000);
  }
  return null;
}

function canonicalTurnStatus(value: unknown): string {
  const status = typeof value === "string" ? value.trim() : value;
  switch (status) {
    case "inProgress":
    case "in_progress":
    case "running":
    case "started":
      return "inProgress";
    case "failed":
    case "error":
      return "failed";
    case "interrupted":
    case "aborted":
      return "interrupted";
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "complete":
    case "done":
      return "completed";
    default:
      // Preserve provider extensions so replay does not erase a future native
      // state. Missing/invalid values are the only ones that default closed.
      return typeof status === "string" && status.length > 0 ? status : "completed";
  }
}

function canonicalItemStatus(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const status = value.trim();
  switch (status) {
    case "in_progress":
    case "in-progress":
    case "running":
    case "started":
      return "inProgress";
    case "error":
      return "failed";
    case "rejected":
      return "declined";
    default:
      return status;
  }
}

function itemChildThreadIds(item: Record<string, unknown>): string[] {
  const children = new Set<string>(decodeSubagentReceiverThreadIds(item));
  for (const key of ["agentThreadId", "receiverThreadId", "receiver_thread_id"]) {
    if (typeof item[key] === "string" && item[key].trim()) children.add(item[key].trim());
  }
  return [...children];
}

function replayItemDescriptor(input: {
  readonly item: Record<string, unknown>;
  readonly turnId: TurnId;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lifecycle: CodexReplayItem["lifecycle"];
}): CodexReplayItem {
  const item = input.item;
  const parentTurnRaw = nonempty(item.parentTurnId ?? item.parent_turn_id);
  const nativeItemId = nonempty(item.id)?.trim() ?? `${input.turnId}:item`;
  const parentItemId = nonempty(item.parentItemId ?? item.parent_item_id)?.trim() ?? null;
  return {
    itemId: nativeItemId,
    itemType: nonempty(item.type ?? item.kind)?.trim() ?? "unknown",
    lifecycle: input.lifecycle,
    status: canonicalItemStatus(item.status),
    parentTurnId: parentTurnRaw ? TurnId.makeUnsafe(parentTurnRaw.trim()) : null,
    parentItemId,
    childThreadIds: itemChildThreadIds(item),
    createdAt: isoTimestamp(item.createdAt ?? item.startedAt ?? item.started_at, input.createdAt),
    updatedAt: isoTimestamp(
      item.updatedAt ?? item.completedAt ?? item.completed_at,
      input.updatedAt,
    ),
    durationMs: nonNegativeNumber(item.durationMs ?? item.duration),
  };
}

function messageText(item: Record<string, unknown>): string {
  if (typeof item.text === "string") return item.text;
  return Array.isArray(item.content)
    ? item.content
        .flatMap((value) => {
          const part = asRecord(value);
          return part?.type === "text" && typeof part.text === "string" ? [part.text] : [];
        })
        .join("")
    : "";
}

export function projectCodexSnapshotHistory(input: {
  readonly importedAt: string;
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<CodexReplaySourceTurn>;
  readonly messageIdAtIndex?: (index: number) => MessageId;
}): ReadonlyArray<ThreadHistoryImportEntry> {
  const entries: ThreadHistoryImportEntry[] = [];
  let messageIndex = 0;
  for (const [turnIndex, turn] of input.turns.entries()) {
    const turnId = TurnId.makeUnsafe(
      nonempty(turn.id)?.trim() ?? `import:${input.threadId}:turn:${turnIndex}`,
    );
    const startedAt = timestamp(turn.startedAt);
    const completedAt = timestamp(turn.completedAt);
    const durationMs =
      typeof turn.durationMs === "number" &&
      Number.isFinite(turn.durationMs) &&
      turn.durationMs >= 0
        ? turn.durationMs
        : null;
    const status = canonicalTurnStatus(turn.status);
    const replayEntries: CodexReplayTurn["entries"][number][] = [];
    let terminalMessageId: MessageId | null = null;

    for (const [itemIndex, value] of turn.items.entries()) {
      const item = asRecord(value);
      if (!item) continue;
      const nativeId = nonempty(item.id)?.trim() ?? `${turnId}:item:${itemIndex}`;
      const id = `codex-import:${input.threadId}:${nativeId}`;
      const time = turn.itemTimes?.[nativeId];
      const createdAt = time?.createdAt ?? startedAt ?? input.importedAt;
      const updatedAt = time?.updatedAt ?? completedAt ?? createdAt;
      const itemStatus = canonicalItemStatus(item.status);
      const lifecycle: CodexReplayItem["lifecycle"] =
        itemStatus === "inProgress"
          ? "started"
          : itemStatus === "updated"
            ? "updated"
            : "completed";
      const replayItem = replayItemDescriptor({
        item,
        turnId,
        createdAt,
        updatedAt,
        lifecycle,
      });

      if (item.type === "userMessage" || item.type === "agentMessage") {
        const text = messageText(item);
        if (!text) continue;
        const role = item.type === "userMessage" ? "user" : "assistant";
        const messageId = input.messageIdAtIndex?.(messageIndex++) ?? MessageId.makeUnsafe(id);
        const phase =
          item.phase === "commentary" || item.phase === "final_answer" ? item.phase : null;
        if (role === "assistant") terminalMessageId = messageId;
        entries.push({
          kind: "message",
          message: { messageId, role, text, turnId, createdAt, updatedAt },
        });
        replayEntries.push({ kind: "message", id: messageId, phase, item: replayItem });
        continue;
      }
      if (item.type === "plan") {
        const planMarkdown = nonempty(item.text)?.trim();
        if (planMarkdown) {
          entries.push({
            kind: "proposed-plan",
            proposedPlan: {
              id,
              turnId,
              planMarkdown,
              implementedAt: null,
              implementationThreadId: null,
              createdAt,
              updatedAt,
            },
          });
          replayEntries.push({ kind: "proposed-plan", id, item: replayItem });
        }
        continue;
      }

      if (
        item.type === "reasoning" &&
        (!Array.isArray(item.summary) ||
          !item.summary.some((part) => typeof part === "string" && part.trim()))
      )
        continue;
      const lifecycleMethod =
        itemStatus === "inProgress"
          ? "item.started"
          : itemStatus === "updated"
            ? "item.updated"
            : "item.completed";
      const normalized = mapCodexItemLifecycle(
        {
          id: EventId.makeUnsafe(id),
          provider: "codex",
          kind: "notification",
          threadId: input.threadId,
          turnId,
          itemId: ProviderItemId.makeUnsafe(nativeId),
          ...(replayItem.parentTurnId ? { parentTurnId: replayItem.parentTurnId } : {}),
          createdAt,
          method: lifecycleMethod.replace(".", "/"),
          payload: { item, threadId: input.threadId, turnId },
        },
        input.threadId,
        lifecycleMethod,
      );
      if (!normalized) continue;
      for (const activity of projectProviderRuntimeActivities(normalized)) {
        const activityWithReplayItem = {
          ...activity,
          payload: {
            ...(asRecord(activity.payload) ?? {}),
            replayItem,
          },
        };
        entries.push({ kind: "activity", activity: activityWithReplayItem });
        replayEntries.push({ kind: "activity", id: activity.id, item: replayItem });
      }
    }

    const replay: CodexReplayTurn = {
      version: 1,
      turnId,
      status,
      startedAt,
      completedAt,
      durationMs,
      terminalMessageId,
      entries: replayEntries,
    };
    entries.push({
      kind: "activity",
      activity: {
        id: EventId.makeUnsafe(`codex-replay-turn:${input.threadId}:${turnId}`),
        kind: CODEX_REPLAY_TURN_ACTIVITY_KIND,
        tone: "info",
        summary: "Codex replay turn",
        turnId,
        createdAt: startedAt ?? input.importedAt,
        payload: JSON.parse(JSON.stringify(replay)),
      },
    });
    if (status !== "inProgress") {
      entries.push({
        kind: "activity",
        activity: {
          id: EventId.makeUnsafe(`codex-replay-completed:${input.threadId}:${turnId}`),
          kind: "turn.completed",
          tone: status === "failed" ? "error" : "info",
          summary:
            status === "failed"
              ? "Turn failed"
              : status === "interrupted" || status === "cancelled"
                ? "Turn interrupted"
                : "Turn completed",
          turnId,
          createdAt: completedAt ?? input.importedAt,
          payload: { state: status },
        },
      });
    }
  }
  return entries;
}

export function codexReplayChildThreadIds(turns: ReadonlyArray<CodexReplaySourceTurn>): string[] {
  const children = new Set<string>();
  for (const turn of turns)
    for (const value of turn.items) {
      const item = asRecord(value);
      if (item?.type === "subAgentActivity" && typeof item.agentThreadId === "string")
        children.add(item.agentThreadId);
      if (item?.type === "collabAgentToolCall")
        for (const id of decodeSubagentReceiverThreadIds(item)) children.add(id);
    }
  return [...children];
}
