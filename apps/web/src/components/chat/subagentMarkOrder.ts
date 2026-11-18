// FILE: subagentMarkOrder.ts
// Purpose: Which mark each subagent wears. Within one parent chat, marks are handed out in order
//          of first appearance in its work log, and a mark once given is kept for the life of the
//          window: a subagent the chat names for the first time takes the next free position,
//          even when it comes from older turns that loaded later, so no mark changes under the
//          person's eyes and no two subagents of a chat share one until the family runs out
//          (18 outlines in 8 colours; after that the colours shift, so an outline comes back in a
//          new colour before any mark repeats). The work log is rebuilt from the chat's stored
//          activities, so the same loaded log gives the same marks after a restart.
// Layer: Chat UI state (a small external store read with useSyncExternalStore)
// Exports: subagentMarkKey, subagentMarkOrderFromEntries, registerSubagentMarkOrder,
//          subagentMarkIndexFor, useSubagentMarkIndex, subagentMarkAppearance,
//          resetSubagentMarkOrderForTests

import { useSyncExternalStore } from "react";

import { SUBAGENT_MARK_TONES } from "~/theme/subagentMarkColors";

import { SUBAGENT_MARK_SHAPE_COUNT } from "./subagentMarkGeometry";

interface SubagentIdentityLike {
  readonly threadId: string;
  readonly providerThreadId?: string | undefined;
  readonly resolvedThreadId?: string | undefined;
}

interface WorkEntryLike {
  readonly subagents?: ReadonlyArray<SubagentIdentityLike> | undefined;
}

const CHILD_THREAD_PREFIX = /^subagent:[^:]+:(.+)$/;

/** One key per subagent, whichever id a surface holds (provider thread id or child thread id). */
export function subagentMarkKey(seed: string): string {
  const trimmed = seed.trim();
  return CHILD_THREAD_PREFIX.exec(trimmed)?.[1] ?? trimmed;
}

/** One chat's hand-out: every id a subagent is known by, and the next free position. */
interface ChatHandOut {
  readonly positions: Map<string, number>;
  next: number;
}

/**
 * Gives every subagent the entries name a position: the one it already holds under any of its
 * ids, or else the next free one. Never moves a position once given. Returns the keys it added.
 */
function handOut(chat: ChatHandOut, entries: ReadonlyArray<WorkEntryLike>): string[] {
  const added: string[] = [];
  for (const entry of entries) {
    for (const subagent of entry.subagents ?? []) {
      const keys = [subagent.threadId, subagent.providerThreadId, subagent.resolvedThreadId]
        .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
        .map(subagentMarkKey);
      if (keys.length === 0) continue;
      const known = keys.map((key) => chat.positions.get(key)).find((index) => index !== undefined);
      const index = known ?? chat.next++;
      for (const key of keys) {
        if (chat.positions.has(key)) continue;
        chat.positions.set(key, index);
        added.push(key);
      }
    }
  }
  return added;
}

/** Order of first appearance in one work log, as a fresh window would hand it out. */
export function subagentMarkOrderFromEntries(
  entries: ReadonlyArray<WorkEntryLike>,
): Map<string, number> {
  const chat: ChatHandOut = { positions: new Map(), next: 0 };
  handOut(chat, entries);
  return chat.positions;
}

const chats = new Map<string, ChatHandOut>();
// Provider thread ids are unique across chats, so one lookup serves every open chat; the first
// chat to name a subagent owns its mark, and no chat can move another chat's marks.
const assigned = new Map<string, number>();
const listeners = new Set<() => void>();

/** Hands out marks to the subagents this chat's loaded work log names, keeping every earlier one. */
export function registerSubagentMarkOrder(
  parentThreadId: string,
  entries: ReadonlyArray<WorkEntryLike>,
): void {
  let chat = chats.get(parentThreadId);
  if (!chat) {
    chat = { positions: new Map(), next: 0 };
    chats.set(parentThreadId, chat);
  }
  let changed = false;
  for (const key of handOut(chat, entries)) {
    if (assigned.has(key)) continue;
    assigned.set(key, chat.positions.get(key)!);
    changed = true;
  }
  if (changed) for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Before the chat's work log has named a subagent (a row rendered on its own, a test), its id
 * picks a stable mark; bits are mixed so ids that differ in one character land far apart.
 */
function fallbackIndex(key: string): number {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (Math.imul(hash, 31) + key.charCodeAt(index)) | 0;
  }
  let mixed = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x45d9f3b);
  mixed ^= mixed >>> 16;
  return (mixed >>> 0) % SUBAGENT_MARK_SHAPE_COUNT;
}

export function subagentMarkIndexFor(seed: string): number {
  const key = subagentMarkKey(seed);
  return assigned.get(key) ?? fallbackIndex(key);
}

export function useSubagentMarkIndex(seed: string): number {
  return useSyncExternalStore(
    subscribe,
    () => subagentMarkIndexFor(seed),
    () => subagentMarkIndexFor(seed),
  );
}

/**
 * Outline and colour for a position. The first 18 take outlines in order and colours in turn
 * (8 colours, so 9-16 bring new outlines in the same colours). Past 18 the colours shift each
 * round, so an outline only returns in a colour it has not worn yet (8 x 18 marks in all).
 */
export function subagentMarkAppearance(index: number): {
  readonly shape: number;
  readonly tone: number;
} {
  const position = Math.max(0, Math.floor(index));
  const round = Math.floor(position / SUBAGENT_MARK_SHAPE_COUNT);
  return {
    shape: position % SUBAGENT_MARK_SHAPE_COUNT,
    tone: (position + round) % SUBAGENT_MARK_TONES.length,
  };
}

export function resetSubagentMarkOrderForTests(): void {
  chats.clear();
  assigned.clear();
  for (const listener of listeners) listener();
}
