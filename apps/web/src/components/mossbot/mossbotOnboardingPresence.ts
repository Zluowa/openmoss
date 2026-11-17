// FILE: mossbotOnboardingPresence.ts
// Purpose: Whether the Mossbot first-run onboarding is on screen. The chat shell reads it to hide the list panel
//          (and its title-bar toggle) while the stage is up, as a presentation state: the stored sidebar
//          open/closed preference is never written, so the panel comes back exactly as the person left it.
// Layer: Mossbot UI state (not persisted)
// Exports: useMossbotOnboardingPresence

import { create } from "zustand";

export const useMossbotOnboardingPresence = create<{
  readonly active: boolean;
  readonly setActive: (active: boolean) => void;
}>((set) => ({
  active: false,
  setActive: (active) => set({ active }),
}));
