// FILE: silentTurnWatch.ts
// Purpose: Notices a running turn whose provider has sent nothing at all for a long stretch of
//          active time, and notices the moment it speaks again. It never stops a turn.
// Layer: Orchestration (pure state; ProviderRuntimeIngestion feeds it events and ticks)
// Exports: SILENT_TURN_NOTICE_MS, SILENT_TURN_OPEN_TOOL_NOTICE_MS, SilentTurnWatchConfig,
//          createSilentTurnWatch, SilentTurnTransition

import { isToolLifecycleItemType, type ProviderRuntimeEvent, type TurnId } from "@moss/contracts";
import { ServiceMap } from "effect";

/**
 * A running turn that has produced no event at all (no text, thinking, tool call, tool
 * progress, task or provider status) for this long is called silent. A healthy turn shows
 * something within seconds; Claude Code's own stream watchdog waits at least 5 minutes for a
 * silent model stream, and the page-action guard (#587) stops a page run after the same 180 s.
 */
export const SILENT_TURN_NOTICE_MS = 180_000;
/**
 * While a tool call is open the provider may say nothing until it finishes, and a long build,
 * test run or a large tool input is legitimate. Same bound as the page-action guard.
 */
export const SILENT_TURN_OPEN_TOOL_NOTICE_MS = 600_000;

export interface SilentTurnWatchBounds {
  readonly noticeMs: number;
  readonly openToolNoticeMs: number;
  readonly tickMs: number;
  readonly now: () => number;
}

/** Tests shorten the bounds and drive the clock; production uses the defaults. */
export class SilentTurnWatchConfig extends ServiceMap.Service<
  SilentTurnWatchConfig,
  Partial<SilentTurnWatchBounds>
>()("moss/orchestration/SilentTurnWatchConfig") {}

export const DEFAULT_SILENT_TURN_WATCH_BOUNDS: SilentTurnWatchBounds = {
  noticeMs: SILENT_TURN_NOTICE_MS,
  openToolNoticeMs: SILENT_TURN_OPEN_TOOL_NOTICE_MS,
  tickMs: 1_000,
  now: () => Date.now(),
};

export type SilentTurnTransition =
  | {
      readonly kind: "silent";
      readonly threadId: ProviderRuntimeEvent["threadId"];
      readonly turnId: TurnId;
      readonly silentForMs: number;
      readonly thresholdMs: number;
      readonly openToolCalls: number;
    }
  | {
      readonly kind: "cleared";
      readonly threadId: ProviderRuntimeEvent["threadId"];
      readonly turnId: TurnId;
      readonly silentForMs: number;
    };

type Watch = {
  readonly turnId: TurnId;
  silentMs: number;
  noticed: boolean;
  readonly openTools: Set<string>;
  readonly pendingRequests: Set<string>;
};

const TURN_END_EVENTS: ReadonlySet<ProviderRuntimeEvent["type"]> = new Set([
  "turn.completed",
  "turn.aborted",
  "session.exited",
]);

/**
 * One watch per thread with a running turn. Every provider event is a sign of life and
 * restarts the count; time spent waiting on the person (an approval or a question) does not
 * count. Time is added by the caller in active-time steps, so a stalled server cannot make a
 * turn look silent.
 */
export function createSilentTurnWatch(
  bounds: Pick<SilentTurnWatchBounds, "noticeMs" | "openToolNoticeMs">,
) {
  const watches = new Map<string, Watch>();
  const cleared = (threadId: ProviderRuntimeEvent["threadId"], watch: Watch) =>
    watch.noticed
      ? ({ kind: "cleared", threadId, turnId: watch.turnId, silentForMs: watch.silentMs } as const)
      : null;

  return {
    observe(event: ProviderRuntimeEvent): SilentTurnTransition | null {
      const watch = watches.get(event.threadId);
      if (event.type === "turn.started" && event.turnId !== undefined) {
        watches.set(event.threadId, {
          turnId: event.turnId,
          silentMs: 0,
          noticed: false,
          openTools: new Set(),
          pendingRequests: new Set(),
        });
        return watch ? cleared(event.threadId, watch) : null;
      }
      if (!watch) return null;
      if (
        TURN_END_EVENTS.has(event.type) &&
        (event.turnId === undefined || event.turnId === watch.turnId)
      ) {
        watches.delete(event.threadId);
        return cleared(event.threadId, watch);
      }
      const itemId = event.itemId as string | undefined;
      if (
        event.type === "item.started" &&
        itemId &&
        isToolLifecycleItemType(event.payload.itemType)
      )
        watch.openTools.add(itemId);
      else if (event.type === "item.completed" && itemId) watch.openTools.delete(itemId);
      const requestId = event.requestId as string | undefined;
      if ((event.type === "request.opened" || event.type === "user-input.requested") && requestId)
        watch.pendingRequests.add(requestId);
      else if (
        (event.type === "request.resolved" || event.type === "user-input.resolved") &&
        requestId
      )
        watch.pendingRequests.delete(requestId);
      const transition = cleared(event.threadId, watch);
      watch.silentMs = 0;
      watch.noticed = false;
      return transition;
    },

    /** Adds one active-time step to every watch and reports turns that just became silent. */
    advance(stepMs: number): SilentTurnTransition[] {
      const transitions: SilentTurnTransition[] = [];
      for (const [threadId, watch] of watches) {
        if (watch.noticed) continue;
        // Waiting on the person is not silence.
        if (watch.pendingRequests.size > 0) {
          watch.silentMs = 0;
          continue;
        }
        watch.silentMs += stepMs;
        const thresholdMs = watch.openTools.size > 0 ? bounds.openToolNoticeMs : bounds.noticeMs;
        if (watch.silentMs < thresholdMs) continue;
        watch.noticed = true;
        transitions.push({
          kind: "silent",
          threadId: threadId as ProviderRuntimeEvent["threadId"],
          turnId: watch.turnId,
          silentForMs: watch.silentMs,
          thresholdMs,
          openToolCalls: watch.openTools.size,
        });
      }
      return transitions;
    },

    get size() {
      return watches.size;
    },
  };
}
