// Canonical item_completed records are the desktop replay model. The older
// response_item/event_msg text copies are transport history, not extra rows.
import { fileURLToPath } from "node:url";
import type { CodexReplaySourceTurn } from "../orchestration/codexReplay";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function milliseconds(value: unknown): number | undefined {
  const duration = record(value);
  return duration && typeof duration.secs === "number" && typeof duration.nanos === "number"
    ? Math.floor(duration.secs * 1_000 + duration.nanos / 1_000_000)
    : undefined;
}

function iso(value: unknown, fallback: string): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

export function normalizeCodexRolloutItem(value: unknown): Record<string, unknown> | null {
  const item = record(value);
  if (!item || typeof item.id !== "string" || typeof item.type !== "string") return null;
  const type = item.type[0]!.toLowerCase() + item.type.slice(1);
  const normalized: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(item)) {
    // Private model reasoning is never part of the displayed reasoning summary.
    if (key === "raw_content") continue;
    normalized[key.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase())] = field;
  }
  normalized.type = type;
  if (item.status === "in_progress") normalized.status = "inProgress";
  if (type === "agentMessage") {
    normalized.text = Array.isArray(item.content)
      ? item.content
          .flatMap((part) => {
            const text = record(part);
            return (text?.type === "Text" || text?.type === "text") && typeof text.text === "string"
              ? [text.text]
              : [];
          })
          .join("")
      : item.text;
    delete normalized.content;
  }
  if (type === "reasoning") {
    normalized.summary = item.summary_text ?? [];
    normalized.content = [];
    delete normalized.summaryText;
  }
  if (type === "commandExecution") {
    // The canonical shell argv contains the exact command as the -c argument.
    const argv = Array.isArray(item.command)
      ? item.command.filter((arg): arg is string => typeof arg === "string")
      : null;
    const shellFlag = argv?.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg)) ?? -1;
    normalized.command = argv
      ? shellFlag >= 0 && argv[shellFlag + 1] !== undefined
        ? argv[shellFlag + 1]
        : argv
            .map((arg) => (/^[\w./:-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`))
            .join(" ")
      : item.command;
    normalized.commandActions = item.parsed_cmd ?? item.commandActions ?? [];
    if (typeof item.source === "string")
      normalized.source = item.source.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase());
    if (typeof item.cwd === "string" && item.cwd.startsWith("file://")) {
      try {
        normalized.cwd = fileURLToPath(item.cwd);
      } catch {
        /* Preserve invalid paths for diagnostics. */
      }
    }
    delete normalized.parsedCmd;
  }
  const durationMs = milliseconds(item.duration);
  if (durationMs !== undefined) normalized.durationMs = durationMs;
  delete normalized.duration;
  return normalized;
}

type MutableTurn = {
  id: string;
  items: Record<string, unknown>[];
  status: string;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  itemTimes: Record<string, { createdAt: string; updatedAt: string }>;
  itemIndices: Map<string, number>;
};

export class CodexRolloutHistory {
  private readonly turns = new Map<string, MutableTurn>();
  private itemCount = 0;
  private byteCount = 0;
  private canonical = false;
  private currentTurnId: string | undefined;
  threadId: string | undefined;
  parentThreadId: string | undefined;
  agentPath: string | undefined;
  agentNickname: string | undefined;

  constructor(private readonly sanitize: (text: string) => string = (text) => text) {}

  add(value: Record<string, unknown>, fallbackTime: string): void {
    const payload = record(value.payload);
    if (!payload) return;
    if (value.type === "session_meta") {
      if (typeof payload.id === "string") this.threadId = payload.id;
      const source = record(record(payload.source)?.subagent);
      const spawn = record(source?.thread_spawn);
      if (typeof spawn?.parent_thread_id === "string") this.parentThreadId = spawn.parent_thread_id;
      if (typeof payload.agent_path === "string") this.agentPath = payload.agent_path;
      if (typeof payload.agent_nickname === "string") this.agentNickname = payload.agent_nickname;
      return;
    }
    if (value.type !== "event_msg") return;
    const turnId = typeof payload.turn_id === "string" ? payload.turn_id : this.currentTurnId;
    if (!turnId) return;
    if (payload.type === "task_started") this.currentTurnId = turnId;
    if (
      !["task_started", "task_complete", "turn_aborted", "item_completed"].includes(
        String(payload.type),
      )
    )
      return;
    let turn = this.turns.get(turnId);
    if (!turn) {
      if (this.turns.size >= 2_000) throw new Error("Codex replay exceeds the turn limit.");
      turn = { id: turnId, items: [], status: "inProgress", itemTimes: {}, itemIndices: new Map() };
      this.turns.set(turnId, turn);
    }
    if (typeof payload.started_at === "number") turn.startedAt = payload.started_at;
    if (typeof payload.completed_at === "number") turn.completedAt = payload.completed_at;
    if (typeof payload.duration_ms === "number") turn.durationMs = payload.duration_ms;
    if (payload.type === "task_complete") turn.status = "completed";
    if (payload.type === "turn_aborted") turn.status = "interrupted";
    if (payload.type !== "item_completed") return;
    const item = normalizeCodexRolloutItem(payload.item);
    if (!item) return;
    this.canonical = true;
    // Apply the same credential redaction as text imports to tool arguments and
    // outputs without changing protocol keys, ids or whitespace in code blocks.
    const sanitizeValue = (field: unknown): unknown => {
      if (typeof field === "string") return this.sanitize(field);
      if (Array.isArray(field)) return field.map(sanitizeValue);
      const object = record(field);
      return object
        ? Object.fromEntries(
            Object.entries(object).map(([key, child]) => [key, sanitizeValue(child)]),
          )
        : field;
    };
    const sanitized = sanitizeValue(item) as Record<string, unknown>;
    this.byteCount += Buffer.byteLength(JSON.stringify(sanitized));
    if (++this.itemCount > 100_000 || this.byteCount > 64 * 1024 * 1024)
      throw new Error("Codex replay exceeds the item or byte limit.");
    const id = item.id as string;
    const previous = turn.itemIndices.get(id);
    if (previous === undefined) {
      turn.itemIndices.set(id, turn.items.length);
      turn.items.push(sanitized);
    } else turn.items[previous] = sanitized;
    turn.itemTimes[id] = {
      createdAt: iso(payload.started_at_ms, fallbackTime),
      updatedAt: iso(payload.completed_at_ms, fallbackTime),
    };
  }

  snapshot(): ReadonlyArray<CodexReplaySourceTurn> | undefined {
    return this.canonical
      ? [...this.turns.values()]
          .filter((turn) => turn.items.length > 0)
          .map(({ itemIndices: _itemIndices, ...turn }) => turn)
      : undefined;
  }
}
