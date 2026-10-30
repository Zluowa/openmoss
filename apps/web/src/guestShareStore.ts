// FILE: guestShareStore.ts
// Purpose: Owner-side "share with guest" state for every thread, fed by the
//          `guestShare.subscribe` stream (snapshot, then upserts and removes).
// Layer: Web UI state
// Exports: useGuestShareStore, applyGuestShareOwnerEvent, selectors

import {
  type GuestShareOwnerEvent,
  pendingGuestMessageCount,
  type ThreadGuestShare,
  type ThreadId,
} from "@synara/contracts";
import { create } from "zustand";

export interface GuestShareState {
  sharesByThreadId: Readonly<Record<string, ThreadGuestShare | undefined>>;
  /** False until the stream's first snapshot; a reconnect replays one. */
  hydrated: boolean;
}

/** Pure reducer behind the store, so the stream's ordering rules are unit-testable. */
export function applyGuestShareOwnerEvent<State extends GuestShareState>(
  state: State,
  event: GuestShareOwnerEvent,
): State {
  switch (event.type) {
    case "snapshot": {
      const sharesByThreadId: Record<string, ThreadGuestShare> = {};
      for (const share of event.shares) {
        sharesByThreadId[share.threadId] = share;
      }
      return { ...state, sharesByThreadId, hydrated: true };
    }
    case "upsert": {
      const share = event.share;
      if (state.sharesByThreadId[share.threadId] === share) return state;
      return {
        ...state,
        sharesByThreadId: { ...state.sharesByThreadId, [share.threadId]: share },
      };
    }
    case "remove": {
      const existing = state.sharesByThreadId[event.threadId];
      // A remove for a share that a newer one already replaced must not drop the newer one.
      if (!existing || existing.id !== event.shareId) return state;
      const sharesByThreadId = { ...state.sharesByThreadId };
      delete sharesByThreadId[event.threadId];
      return { ...state, sharesByThreadId };
    }
  }
}

interface GuestShareStore extends GuestShareState {
  applyEvent: (event: GuestShareOwnerEvent) => void;
  clear: () => void;
}

export const useGuestShareStore = create<GuestShareStore>()((set) => ({
  sharesByThreadId: {},
  hydrated: false,
  applyEvent: (event) => set((current) => applyGuestShareOwnerEvent(current, event)),
  clear: () => set({ sharesByThreadId: {}, hydrated: false }),
}));

export function selectThreadGuestShare(threadId: ThreadId) {
  return (state: GuestShareState): ThreadGuestShare | null =>
    state.sharesByThreadId[threadId] ?? null;
}

export function selectPendingGuestMessageCount(threadId: ThreadId) {
  return (state: GuestShareState): number =>
    pendingGuestMessageCount(state.sharesByThreadId[threadId]);
}
