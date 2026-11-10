// FILE: nativeTranscripts.ts
// Purpose: Read the visible conversation straight from Codex rollout files and Claude Code
//          session files, without starting either agent, so an imported conversation can be
//          shown the moment it is opened.
// Layer: Provider local-history parsing
// Exports: readCodexRolloutMessages, readClaudeSessionMessages

import { readJsonlRecords } from "./jsonlRecords";
import { asRecord, isoTimestamp, nonEmptyString, visibleMessageText } from "./shared";
import type { LocalHistoryMessage } from "./types";

/**
 * Codex records what the person saw as `item_completed` UserMessage/AgentMessage events;
 * releases before those events wrote `user_message`/`agent_message`. The raw model input
 * (`response_item`) also carries injected instructions, so it is never used.
 */
export async function readCodexRolloutMessages(file: string): Promise<LocalHistoryMessage[]> {
  const items: LocalHistoryMessage[] = [];
  const legacy: LocalHistoryMessage[] = [];
  for await (const record of readJsonlRecords(file)) {
    if (record.type !== "event_msg") continue;
    const payload = asRecord(record.payload);
    const createdAt = isoTimestamp(record.timestamp);
    if (payload?.type === "item_completed") {
      const item = asRecord(payload.item);
      const kind = typeof item?.type === "string" ? item.type.toLowerCase() : "";
      const role = kind === "usermessage" ? "user" : kind === "agentmessage" ? "assistant" : null;
      const text = role ? visibleMessageText(item?.content ?? item?.text) : "";
      if (role && text) {
        items.push({ id: nonEmptyString(item?.id) ?? String(items.length), role, text, createdAt });
      }
    } else if (payload?.type === "user_message" || payload?.type === "agent_message") {
      const text = visibleMessageText(payload.message);
      if (text) {
        legacy.push({
          id: `legacy-${legacy.length}`,
          role: payload.type === "user_message" ? "user" : "assistant",
          text,
          createdAt,
        });
      }
    }
  }
  return items.length > 0 ? items : legacy;
}

interface ClaudeEntry {
  readonly uuid: string | undefined;
  readonly parentUuid: string | undefined;
  readonly messageId: string | undefined;
  readonly message: LocalHistoryMessage | undefined;
}

// Echoes of the CLI's own slash commands and their output, not conversation.
const CLAUDE_COMMAND_ECHO = /^<(?:command-|local-command-)/u;

function claudeMessage(
  record: Record<string, unknown>,
  index: number,
): LocalHistoryMessage | undefined {
  if (record.type !== "user" && record.type !== "assistant") return undefined;
  if (record.isSidechain === true || record.isMeta === true) return undefined;
  const message = asRecord(record.message);
  // Tool results arrive as user records; only text parts are the person's words.
  const text = visibleMessageText(message?.content);
  if (!text || CLAUDE_COMMAND_ECHO.test(text)) return undefined;
  return {
    id: nonEmptyString(record.uuid) ?? String(index),
    role: record.type,
    text,
    createdAt: isoTimestamp(record.timestamp),
  };
}

/**
 * Claude Code appends every record of every branch; the conversation shown is the chain from
 * the newest record back through `parentUuid`. One assistant reply can span several records
 * sharing a message id; their text is joined.
 */
export async function readClaudeSessionMessages(file: string): Promise<LocalHistoryMessage[]> {
  const entries: ClaudeEntry[] = [];
  for await (const record of readJsonlRecords(file)) {
    if (record.type !== "user" && record.type !== "assistant") continue;
    entries.push({
      uuid: nonEmptyString(record.uuid),
      parentUuid: nonEmptyString(record.parentUuid),
      messageId: nonEmptyString(asRecord(record.message)?.id),
      message: claudeMessage(record, entries.length),
    });
  }
  const byUuid = new Map(
    entries.flatMap((entry) => (entry.uuid ? [[entry.uuid, entry] as const] : [])),
  );
  const chain: ClaudeEntry[] = [];
  const seen = new Set<string>();
  let current = entries.at(-1);
  while (current?.uuid && !seen.has(current.uuid)) {
    seen.add(current.uuid);
    chain.push(current);
    current = current.parentUuid ? byUuid.get(current.parentUuid) : undefined;
  }
  const ordered = chain.length > 0 ? chain.toReversed() : entries;
  const messages: LocalHistoryMessage[] = [];
  let previous: ClaudeEntry | undefined;
  for (const entry of ordered) {
    if (!entry.message) continue;
    const last = messages.at(-1);
    if (
      last &&
      entry.message.role === "assistant" &&
      last.role === "assistant" &&
      entry.messageId !== undefined &&
      entry.messageId === previous?.messageId
    ) {
      messages[messages.length - 1] = { ...last, text: `${last.text}\n\n${entry.message.text}` };
    } else {
      messages.push(entry.message);
    }
    previous = entry;
  }
  return messages;
}
