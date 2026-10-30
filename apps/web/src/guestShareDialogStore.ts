// FILE: guestShareDialogStore.ts
// Purpose: Owns which thread the single global "Share with guest" dialog is open for.
// Layer: Web UI state
// Depends on: Zustand.

import type { ThreadId } from "@synara/contracts";
import { create } from "zustand";

interface GuestShareDialogStore {
  threadId: ThreadId | null;
  open: (threadId: ThreadId) => void;
  close: () => void;
}

export const useGuestShareDialogStore = create<GuestShareDialogStore>((set) => ({
  threadId: null,
  open: (threadId) => set({ threadId }),
  close: () => set({ threadId: null }),
}));

export function openGuestShareDialog(threadId: ThreadId): void {
  useGuestShareDialogStore.getState().open(threadId);
}
