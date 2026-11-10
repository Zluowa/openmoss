// FILE: wrapUpPlan.ts
// Purpose: Where the transcript draws `moss_wrap_up` boxes, following the desktop chat:
//          the call itself never shows as a tool row; a box with a question stays live
//          under its turn until the person answers, then settles into a card above the
//          answer (the answer shown when it matches a button, the choices when not). A
//          box without a question draws nothing.
// Layer: Chat transcript logic (pure)
// Exports: WrapUpPlan, SettledWrapUp, resolveWrapUpPlan, isWrapUpTimelineEntry

import type { TurnId } from "@moss/contracts";
import { isWrapUpToolName, parseWrapUp, type WrapUp } from "@moss/shared/wrapUp";

import { parseToolArgumentSummary } from "~/lib/toolArgumentSummary";
import type { TimelineEntry } from "~/workLog";

export interface SettledWrapUp {
  box: WrapUp;
  /** The button the person picked, or null when they wrote something else. */
  answer: string | null;
}

export interface WrapUpPlan {
  /** Settled cards, keyed by the user message that followed the box. */
  settledByUserMessageId: ReadonlyMap<string, SettledWrapUp>;
  /** The box still waiting on the person, with the turn it belongs to. */
  live: { box: WrapUp; turnId: TurnId | null; afterMessageId: string | null } | null;
}

export function isWrapUpTimelineEntry(entry: TimelineEntry): boolean {
  return entry.kind === "work" && isWrapUpToolName(entry.entry.toolName);
}

function readBox(entry: TimelineEntry): WrapUp | null {
  if (entry.kind !== "work" || !entry.entry.detail) return null;
  return parseWrapUp(parseToolArgumentSummary(entry.entry.detail)?.args ?? null);
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

const EMPTY_PLAN: WrapUpPlan = { settledByUserMessageId: new Map(), live: null };

export function resolveWrapUpPlan(entries: ReadonlyArray<TimelineEntry>): WrapUpPlan {
  let pending: { box: WrapUp; turnId: TurnId | null } | null = null;
  let settled: Map<string, SettledWrapUp> | null = null;
  for (const entry of entries) {
    if (isWrapUpTimelineEntry(entry)) {
      const box = readBox(entry);
      // Only a box that asks something waits on the person; a later box replaces it.
      pending = box?.ask
        ? { box, turnId: entry.kind === "work" ? (entry.entry.turnId ?? null) : null }
        : null;
      continue;
    }
    if (
      entry.kind === "message" &&
      entry.message.role === "user" &&
      (entry.message.dispatchOrigin === undefined || entry.message.dispatchOrigin === "user") &&
      pending
    ) {
      const said = normalize(entry.message.text);
      const answer = pending.box.actions.find((label) => normalize(label) === said) ?? null;
      settled ??= new Map();
      settled.set(entry.message.id, { box: pending.box, answer });
      pending = null;
    }
  }
  if (!settled && !pending) return EMPTY_PLAN;
  // A peer can start a later turn while this question still waits on the person.
  // Keep its box attached to its own completed reply rather than the newest turn.
  const live = pending;
  const reply = live
    ? entries.findLast(
        (entry) =>
          entry.kind === "message" &&
          entry.message.role === "assistant" &&
          !entry.message.streaming &&
          (live.turnId === null || entry.message.turnId === live.turnId),
      )
    : undefined;
  return {
    settledByUserMessageId: settled ?? new Map(),
    live: live
      ? { ...live, afterMessageId: reply?.kind === "message" ? reply.message.id : null }
      : null,
  };
}
