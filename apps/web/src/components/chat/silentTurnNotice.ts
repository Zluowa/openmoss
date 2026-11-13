// FILE: silentTurnNotice.ts
// Purpose: Reads the server's silent-turn notice for a chat's running turn, and runs the
//          notice's "stop and retry" choice. The server decides silence (in active time);
//          this only shows it and clears it as soon as the server says the agent spoke.
// Layer: Chat transcript logic
// Exports: resolveSilentTurnNotice, SilentTurnNotice, stopAndRetrySilentTurn,
//          makeStopAndRetrySilentTurn

import type { ThreadId, TurnId } from "@moss/contracts";
import { PROVIDER_TURN_SILENT_ACTIVITY_KIND } from "@moss/shared/providerDeliveryBlock";

import { newCommandId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import { getThreadFromState } from "~/threadDerivation";

export interface SilentTurnNotice {
  /** The notice's activity; "keep waiting" hides this one notice. */
  readonly id: string;
  readonly turnId: TurnId;
  /** A tool call was open, so the longer bound applied. */
  readonly openToolCall: boolean;
  /** How long the turn had been silent when the server noticed. */
  readonly silentForMs: number;
}

/**
 * The notice to show for a thread, or null. Only the running latest turn shows one, and only
 * while its newest silent-turn record says "silent": the server writes "cleared" the moment
 * the provider sends anything, and a turn that ended shows no notice at all.
 */
export function resolveSilentTurnNotice(thread: {
  readonly latestTurn: { readonly turnId: TurnId; readonly state: string } | null;
  readonly activities: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly turnId: TurnId | null;
    readonly payload: unknown;
  }>;
}): SilentTurnNotice | null {
  const turn = thread.latestTurn;
  if (!turn || turn.state !== "running") return null;
  const latest = thread.activities.findLast(
    (activity) =>
      activity.kind === PROVIDER_TURN_SILENT_ACTIVITY_KIND && activity.turnId === turn.turnId,
  );
  const payload = latest?.payload as
    | { readonly state?: unknown; readonly openToolCalls?: unknown; readonly silentForMs?: unknown }
    | null
    | undefined;
  if (!latest || payload?.state !== "silent") return null;
  return {
    id: latest.id,
    turnId: turn.turnId,
    openToolCall: typeof payload.openToolCalls === "number" && payload.openToolCalls > 0,
    silentForMs: typeof payload.silentForMs === "number" ? payload.silentForMs : 0,
  };
}

/** How long "stop and retry" waits for the stopped turn to settle before giving up. */
const STOP_SETTLE_WAIT_MS = 30_000;
const STOP_SETTLE_POLL_MS = 200;

/**
 * Stops the silent turn, waits until it has settled, then continues the task with a new turn
 * (the same continuation the interrupted-task card sends). Resolves false when the turn did
 * not settle in time or the continuation was refused; the stop itself stands either way.
 */
export async function stopAndRetrySilentTurn(input: {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly interrupt: (input: { threadId: ThreadId; turnId: TurnId }) => Promise<unknown>;
  /** The latest turn's id and state as the chat currently shows them. */
  readonly readLatestTurn: () => { readonly turnId: TurnId; readonly state: string } | null;
  readonly continueTask: (turnId: TurnId) => Promise<boolean>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly waitMs?: number;
}): Promise<boolean> {
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  await input.interrupt({ threadId: input.threadId, turnId: input.turnId });
  const waitMs = input.waitMs ?? STOP_SETTLE_WAIT_MS;
  for (let waited = 0; ; waited += STOP_SETTLE_POLL_MS) {
    const turn = input.readLatestTurn();
    if (turn?.turnId !== input.turnId) return false;
    if (turn.state !== "running") break;
    if (waited >= waitMs) return false;
    await sleep(STOP_SETTLE_POLL_MS);
  }
  return input.continueTask(input.turnId);
}

/** "Stop and retry" for one chat, wired to the live store and server. */
export function makeStopAndRetrySilentTurn(
  threadId: ThreadId,
  continueTask: (turnId: TurnId) => Promise<boolean>,
): (turnId: TurnId) => Promise<boolean> {
  return (turnId) =>
    stopAndRetrySilentTurn({
      threadId,
      turnId,
      interrupt: async (target) => {
        const api = readNativeApi();
        if (!api) throw new Error("Moss is not connected.");
        await api.orchestration.dispatchCommand({
          type: "thread.turn.interrupt",
          requestedBy: "user",
          commandId: newCommandId(),
          threadId: target.threadId,
          turnId: target.turnId,
          createdAt: new Date().toISOString(),
        });
      },
      readLatestTurn: () => getThreadFromState(useStore.getState(), threadId)?.latestTurn ?? null,
      continueTask,
    }).catch(() => false);
}
