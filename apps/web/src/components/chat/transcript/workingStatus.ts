// FILE: workingStatus.ts
// Purpose: The desktop chat's working-line wording. A long think escalates its words
//          at fixed points (15/30/45/60 s) so a quiet wait still reads as progress;
//          a send in flight reads "Sending…".
// Layer: Chat transcript presentation logic (pure)
//          A provider start that runs past a few seconds says so, and that Moss keeps waiting.
// Exports: THINKING_TIER_SECONDS, SLOW_PROVIDER_START_NOTICE_MS, startingProviderName,
//          thinkingStatusKey, workingStatusKey, workingMarkSignal

import type { MossMarkActivity } from "~/lib/mossMarkMotion";
import type { TranslationKey } from "~/localization";
import type { TimelineEntry, WorkLogEntry } from "~/workLog";

/** Seconds at which the thinking words step up, in order. */
export const THINKING_TIER_SECONDS = [15, 30, 45, 60] as const;

const THINKING_TIER_KEYS = [
  "transcript.working.thinking",
  "transcript.working.stillThinking",
  "transcript.working.thinkingMore",
  "transcript.working.thinkingSomeMore",
  "transcript.working.almostDone",
] as const satisfies ReadonlyArray<TranslationKey>;

export function thinkingStatusKey(elapsedSeconds: number): TranslationKey {
  let tier = 0;
  for (const threshold of THINKING_TIER_SECONDS) {
    if (elapsedSeconds >= threshold) tier += 1;
  }
  return THINKING_TIER_KEYS[tier]!;
}

/**
 * Key for the transcript's working label, or null to keep the label as given
 * (provider start, retry and delivery-check lines carry their own text).
 */
export function workingStatusKey(label: string, elapsedSeconds: number): TranslationKey | null {
  if (label === "Thinking") return thinkingStatusKey(elapsedSeconds);
  if (label === "Loading") return "transcript.working.sending";
  return null;
}

/** What the working line's Moss mark shows, and the output count that drives its wind. */
export interface WorkingMarkSignal {
  readonly activity: MossMarkActivity;
  /** Grows with every streamed character and every new transcript entry of the live turn. */
  readonly progress: number;
}

function isRunningTool(entry: WorkLogEntry): boolean {
  if (entry.toolStatus) return entry.toolStatus === "running";
  return entry.activityKind === "tool.started" || entry.activityKind === "tool.updated";
}

/**
 * Reads the live turn's real state for the Moss mark (lib/mossMarkMotion.ts), from what the
 * transcript already knows:
 * - a finished turn settles the mark; a pending approval or question holds it, breathing;
 * - a send, an agent start and a delivery check light its folds; a retry stalls it;
 * - otherwise the newest entry decides: streaming text spins it, a running tool lights its
 *   folds, and anything else is thinking.
 */
export function workingMarkSignal(input: {
  readonly label: string;
  readonly entries: ReadonlyArray<TimelineEntry>;
  readonly awaitingUser: boolean;
  readonly finished: boolean;
}): WorkingMarkSignal {
  const { entries } = input;
  // Only the live turn counts: walk back to the message that opened it.
  let progress = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    const message =
      entry.kind === "message" || entry.kind === "message-segment" ? entry.message : null;
    if (message?.role === "user") break;
    progress += 1 + (message?.streaming ? message.text.length : 0);
  }
  const activity = ((): MossMarkActivity => {
    if (input.finished) return "done";
    if (input.awaitingUser) return "waiting";
    if (input.label.startsWith("Retrying")) return "stalled";
    if (input.label !== "Thinking") return "sending";
    const last = entries.at(-1);
    if (!last) return "thinking";
    if (
      (last.kind === "message" || last.kind === "message-segment") &&
      last.message.role === "assistant" &&
      last.message.streaming
    ) {
      return "replying";
    }
    if (last.kind === "work" && isRunningTool(last.entry)) return "working";
    return "thinking";
  })();
  return { activity, progress };
}

/** A provider start still running after this long reads as slow on the working line. */
export const SLOW_PROVIDER_START_NOTICE_MS = 8_000;

const STARTING_PROVIDER_LABEL = /^Starting (.+)…$/u;

/** The provider named by a "Starting <provider>…" working label, or null. */
export function startingProviderName(label: string): string | null {
  return STARTING_PROVIDER_LABEL.exec(label)?.[1] ?? null;
}
