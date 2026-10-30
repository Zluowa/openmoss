// FILE: quickChatVisibilityStore.ts
// Purpose: Publishes the open Quick Chat overlay thread so off-route ChatView
//          mounts can receive the same detail-lease and toast visibility as
//          route/split/dock sidechat panes.
// Layer: Web UI store

import type { ThreadId } from "@synara/contracts";
import { create } from "zustand";

export interface QuickChatVisibilityState {
  windowOpen: boolean;
  activeThreadId: ThreadId | null;
  setVisibility: (input: { windowOpen: boolean; activeThreadId: ThreadId | null }) => void;
  clearVisibility: () => void;
}

export const useQuickChatVisibilityStore = create<QuickChatVisibilityState>((set) => ({
  windowOpen: false,
  activeThreadId: null,
  setVisibility: (input) => {
    set((state) => {
      if (state.windowOpen === input.windowOpen && state.activeThreadId === input.activeThreadId) {
        return state;
      }
      return {
        windowOpen: input.windowOpen,
        activeThreadId: input.activeThreadId,
      };
    });
  },
  clearVisibility: () => {
    set((state) => {
      if (!state.windowOpen && state.activeThreadId === null) {
        return state;
      }
      return { windowOpen: false, activeThreadId: null };
    });
  },
}));
