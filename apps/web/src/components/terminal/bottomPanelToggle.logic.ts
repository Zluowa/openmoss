// FILE: bottomPanelToggle.logic.ts
// Purpose: Gives the header button and terminal.toggle command one bottom-panel state machine.
// Layer: Pure terminal shell behavior

import type { ThreadTerminalPresentationMode } from "../../types";

export interface BottomPanelToggleInput {
  terminalOpen: boolean;
  presentationMode: ThreadTerminalPresentationMode;
}

export interface BottomPanelToggleTransition {
  terminalOpen: boolean;
  presentationMode: "drawer";
  requestFocus: boolean;
}

export function resolveBottomPanelToggle(
  input: BottomPanelToggleInput,
): BottomPanelToggleTransition {
  const drawerOpen = input.terminalOpen && input.presentationMode === "drawer";
  if (drawerOpen) {
    return {
      terminalOpen: false,
      presentationMode: "drawer",
      requestFocus: false,
    };
  }

  return {
    terminalOpen: true,
    presentationMode: "drawer",
    requestFocus: true,
  };
}
