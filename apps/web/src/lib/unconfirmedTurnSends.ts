// FILE: unconfirmedTurnSends.ts
// Purpose: Holds a sent chat message whose delivery outcome is unknown (the connection went
//          while it was in flight) until the server's copy of the thread shows it, so the
//          message is neither silently lost nor sent twice.
// Layer: Web chat state
// Exports: useUnconfirmedTurnSends, settleFailedTurnSend, confirmUnconfirmedTurnSend,
//          retryUnconfirmedTurnSend, discardUnconfirmedTurnSend, getUnconfirmedTurnSend

import type { ClientOrchestrationCommand, MessageId, NativeApi, ThreadId } from "@moss/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { isRequestOutcomeUnknown } from "./requestOutcome";
import { wasThreadMessageAccepted } from "./threadTurnReceipt";

type TurnStartCommand = Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>;

export interface UnconfirmedTurnSend {
  /** The exact command sent. A retry resends it unchanged: the server answers a repeated
   *  command id from its receipt instead of applying it a second time. */
  readonly command: TurnStartCommand;
  /** What the person wrote; shown in the notice and returned to the composer on discard. */
  readonly prompt: string;
}

// Session storage keeps the held send across a page reload, where it is confirmed again.
export const useUnconfirmedTurnSends = create<{
  sends: Partial<Record<ThreadId, UnconfirmedTurnSend>>;
  hold: (send: UnconfirmedTurnSend) => void;
  release: (threadId: ThreadId, messageId: MessageId) => void;
}>()(
  persist(
    (set) => ({
      sends: {},
      hold: (send) =>
        set((state) => ({ sends: { ...state.sends, [send.command.threadId]: send } })),
      release: (threadId, messageId) =>
        set((state) => {
          if (state.sends[threadId]?.command.message.messageId !== messageId) return state;
          const sends = { ...state.sends };
          delete sends[threadId];
          return { sends };
        }),
    }),
    {
      name: "moss:unconfirmed-turn-sends",
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({ sends: state.sends }),
    },
  ),
);

export function getUnconfirmedTurnSend(threadId: ThreadId): UnconfirmedTurnSend | null {
  return useUnconfirmedTurnSends.getState().sends[threadId] ?? null;
}

type SnapshotApi = Pick<NativeApi["orchestration"], "getThreadDetailSnapshot">;

/**
 * Decides what a failed turn dispatch means. A message the server already shows was
 * accepted; checking the server's copy is the first confirmation attempt. When that check
 * cannot prove it and the request died with the connection, the message is held as
 * unconfirmed instead of being handed back to the composer, where sending it again could
 * duplicate it. Anything else is a refusal.
 */
export async function settleFailedTurnSend(input: {
  readonly error: unknown;
  readonly api: SnapshotApi;
  readonly send: UnconfirmedTurnSend;
  readonly alreadyReceived: () => boolean;
}): Promise<"accepted" | "unconfirmed" | "rejected"> {
  const { threadId, message } = input.send.command;
  if (input.alreadyReceived()) return "accepted";
  if (await wasThreadMessageAccepted(input.api, threadId, message.messageId)) return "accepted";
  if (!isRequestOutcomeUnknown(input.error)) return "rejected";
  useUnconfirmedTurnSends.getState().hold(input.send);
  return "unconfirmed";
}

/** Releases the held message once the server's copy of the thread shows it. */
export async function confirmUnconfirmedTurnSend(
  api: SnapshotApi,
  threadId: ThreadId,
): Promise<boolean> {
  const send = getUnconfirmedTurnSend(threadId);
  if (!send) return true;
  const messageId = send.command.message.messageId;
  if (!(await wasThreadMessageAccepted(api, threadId, messageId))) return false;
  useUnconfirmedTurnSends.getState().release(threadId, messageId);
  return true;
}

/**
 * Sends the held command again with its original command id, so the server applies it at
 * most once. A retry that again ends with an unknown outcome stays held; a refusal stays
 * held too, so the person can still discard it and keep their text.
 */
export async function retryUnconfirmedTurnSend(
  api: SnapshotApi & Pick<NativeApi["orchestration"], "dispatchCommand">,
  threadId: ThreadId,
): Promise<"confirmed" | "unconfirmed" | "rejected"> {
  const send = getUnconfirmedTurnSend(threadId);
  if (!send) return "confirmed";
  const messageId = send.command.message.messageId;
  try {
    await api.dispatchCommand(send.command);
  } catch (error) {
    if (await confirmUnconfirmedTurnSend(api, threadId)) return "confirmed";
    return isRequestOutcomeUnknown(error) ? "unconfirmed" : "rejected";
  }
  useUnconfirmedTurnSends.getState().release(threadId, messageId);
  return "confirmed";
}

/** Gives up on the held message and returns it so its text can go back to the composer. */
export function discardUnconfirmedTurnSend(threadId: ThreadId): UnconfirmedTurnSend | null {
  const send = getUnconfirmedTurnSend(threadId);
  if (send) useUnconfirmedTurnSends.getState().release(threadId, send.command.message.messageId);
  return send;
}
