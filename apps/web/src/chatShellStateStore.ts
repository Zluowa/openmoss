// FILE: chatShellStateStore.ts
// Purpose: Publishes ChatView's shell state (empty landing vs active thread) so the
//          route shell can decide whether to mount the unified desktop titlebar.
// Layer: Web client state
// Depends on: zustand

import { create } from "zustand";

export type ChatShellState = "voice" | "home-empty" | "project-empty" | "active-thread";

interface ChatShellStateStoreState {
  readonly shellState: ChatShellState;
  readonly setShellState: (shellState: ChatShellState) => void;
}

export const useChatShellStateStore = create<ChatShellStateStoreState>((set) => ({
  shellState: "home-empty",
  setShellState: (shellState) =>
    set((current) => (current.shellState === shellState ? current : { shellState })),
}));

/** The unified white desktop shell only owns empty landings (home and project drafts).
 * Active threads and voice keep the original route-owned chrome. */
export function isEmptyLandingShellState(shellState: ChatShellState): boolean {
  return shellState === "home-empty" || shellState === "project-empty";
}
