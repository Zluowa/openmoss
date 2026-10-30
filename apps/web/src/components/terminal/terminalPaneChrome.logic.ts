// FILE: terminalPaneChrome.logic.ts
// Purpose: Keeps drawer chrome minimal while preserving capability-driven workspace controls.
// Layer: Pure terminal presentation policy

import type { ThreadTerminalPresentationMode } from "../../types";

export type TerminalPaneTrailingAction =
  | "close-drawer-terminal"
  | "delete-active-terminal"
  | "move-to-own-group"
  | "split-down"
  | "split-right"
  | "toggle-presentation"
  | "toggle-side-panel";

export interface TerminalPaneChromePlan {
  showInlineTabClose: boolean;
  showNewTerminalTab: boolean;
  trailingActions: TerminalPaneTrailingAction[];
}

interface ResolveTerminalPaneChromeInput {
  presentationMode: ThreadTerminalPresentationMode;
  canCloseDrawer: boolean;
  canCloseTerminal: boolean;
  canMoveTerminalToGroup: boolean;
  canNewTerminalTab: boolean;
  canSplitTerminalDown: boolean;
  canSplitTerminalRight: boolean;
  canTogglePanel: boolean;
  canTogglePresentationMode: boolean;
}

export function resolveTerminalPaneChrome(
  input: ResolveTerminalPaneChromeInput,
): TerminalPaneChromePlan {
  if (input.presentationMode === "drawer") {
    return {
      showInlineTabClose: false,
      showNewTerminalTab: input.canNewTerminalTab,
      trailingActions: input.canCloseDrawer ? ["close-drawer-terminal"] : [],
    };
  }

  const trailingActions: TerminalPaneTrailingAction[] = [];
  if (input.canMoveTerminalToGroup) trailingActions.push("move-to-own-group");
  if (input.canSplitTerminalRight) trailingActions.push("split-right");
  if (input.canSplitTerminalDown) trailingActions.push("split-down");
  if (input.canTogglePresentationMode) trailingActions.push("toggle-presentation");
  if (input.canTogglePanel) trailingActions.push("toggle-side-panel");
  if (input.canCloseTerminal) trailingActions.push("delete-active-terminal");

  return {
    showInlineTabClose: input.canCloseTerminal,
    showNewTerminalTab: input.canNewTerminalTab,
    trailingActions,
  };
}
