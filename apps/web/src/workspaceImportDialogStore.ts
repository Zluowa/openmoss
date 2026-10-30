// FILE: workspaceImportDialogStore.ts
// Purpose: Owns the single global Import dialog opened from /import or Settings.
// Layer: Web UI state

import { create } from "zustand";

interface WorkspaceImportDialogStore {
  isOpen: boolean;
  openDialog: () => void;
  setOpen: (open: boolean) => void;
}

export const useWorkspaceImportDialogStore = create<WorkspaceImportDialogStore>((set) => ({
  isOpen: false,
  openDialog: () => set({ isOpen: true }),
  setOpen: (open) => set({ isOpen: open }),
}));
