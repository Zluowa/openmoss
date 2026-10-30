// Native history has authoritative item order and turn boundaries. Timestamps
// alone cannot recover either (thread/read only supplies turn-level times).
import { CodexReplayTurn, type OrchestrationThreadActivity } from "@synara/contracts";
import { Schema } from "effect";
import type { ChatMessage } from "../types";
import type { TimelineEntry } from "../workLog";

const decodedTurns = new WeakMap<OrchestrationThreadActivity, CodexReplayTurn | null>();
const annotatedMessages = new WeakMap<ChatMessage, ChatMessage>();

export function deriveCodexReplayTurns(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): CodexReplayTurn[] {
  return activities.flatMap((activity) => {
    if (activity.kind !== "codex.turn.replayed") return [];
    if (!decodedTurns.has(activity)) {
      const decoded = Schema.decodeUnknownOption(CodexReplayTurn)(activity.payload);
      decodedTurns.set(activity, decoded._tag === "Some" ? decoded.value : null);
    }
    const turn = decodedTurns.get(activity);
    return turn ? [turn] : [];
  });
}

export function applyCodexReplayOrder(
  rows: TimelineEntry[],
  turns: ReadonlyArray<CodexReplayTurn>,
): TimelineEntry[] {
  if (turns.length === 0) return rows;
  const canonicalIds = new Set(turns.flatMap((turn) => turn.entries.map((entry) => entry.id)));
  // Canonical replay replaces old workspace transport text copies. Their
  // durable records remain intact, but duplicate/hidden provider inputs should
  // not reappear as extra user turns after upgrading a text-only import.
  rows = rows.filter(
    (row) =>
      row.kind !== "message" || !row.id.startsWith("workspace-import:") || canonicalIds.has(row.id),
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const groups = new Map<string, TimelineEntry[]>();
  for (const turn of turns) {
    const group: TimelineEntry[] = [];
    let firstUser = true;
    for (const entry of turn.entries) {
      const row = byId.get(entry.id);
      if (!row) continue;
      let replayRow = row;
      if (row.kind === "message") {
        const openingUser = row.message.role === "user" && firstUser;
        if (row.message.role === "user") firstUser = false;
        let message = annotatedMessages.get(row.message);
        if (message?.codexReplay?.turn !== turn) {
          message = { ...row.message, codexReplay: { turn, openingUser } };
          annotatedMessages.set(row.message, message);
        }
        replayRow = { ...row, message };
      }
      group.push(replayRow);
      groups.set(row.id, group);
    }
  }
  const emitted = new Set<TimelineEntry[]>();
  return rows.flatMap((row) => {
    const group = groups.get(row.id);
    if (!group) return [row];
    if (emitted.has(group)) return [];
    emitted.add(group);
    return group;
  });
}
