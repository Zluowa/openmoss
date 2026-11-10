// FILE: threadSendRequestStore.ts
// Purpose: Lets UI outside a thread view (the right-hand panel) ask that thread's chat view
//   to send a message, through the same path as a visual's follow-up choice: sent at once
//   on an empty composer, otherwise added under the reader's draft for them to send.
// Layer: Web UI state store

import { create } from "zustand";

export interface ThreadSendRequest {
  readonly id: string;
  readonly threadId: string;
  readonly message: string;
}

interface ThreadSendRequestState {
  readonly requests: readonly ThreadSendRequest[];
  readonly request: (threadId: string, message: string) => void;
  readonly take: (id: string) => void;
}

let nextRequestId = 0;

export const useThreadSendRequestStore = create<ThreadSendRequestState>()((set) => ({
  requests: [],
  request: (threadId, message) =>
    set((state) => ({
      requests: [...state.requests, { id: `send-${++nextRequestId}`, threadId, message }],
    })),
  take: (id) => set((state) => ({ requests: state.requests.filter((r) => r.id !== id) })),
}));

export function selectNextThreadSendRequest(threadId: string) {
  return (state: ThreadSendRequestState): ThreadSendRequest | null =>
    state.requests.find((request) => request.threadId === threadId) ?? null;
}
