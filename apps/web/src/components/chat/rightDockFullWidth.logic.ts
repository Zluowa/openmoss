// FILE: rightDockFullWidth.logic.ts
// Purpose: Owns the Codex-style right-panel full-width lifecycle and presentation contract.
// Layer: Chat right-dock pure state helpers
// Depends on: Resolved keybindings and their shared label formatter.

import type { ResolvedKeybindingsConfig } from "@synara/contracts";

import { formatShortcutLabel, shortcutLabelForCommand } from "../../keybindings";

/** Codex clears full-width panel mode when the app shell reaches its compact breakpoint. */
export const RIGHT_DOCK_FULL_WIDTH_AUTO_EXIT_MAX_WIDTH_PX = 960;

export interface RightDockFullWidthState {
  fullWidth: boolean;
  restoreFullWidthOnNextOpen: boolean;
}

export type RightDockFullWidthEvent =
  | { type: "set-full-width"; fullWidth: boolean; shellWidth?: number }
  | { type: "temporary-close" }
  | { type: "open" }
  | { type: "shell-resized"; width: number };

export function createRightDockFullWidthState(): RightDockFullWidthState {
  return {
    fullWidth: false,
    restoreFullWidthOnNextOpen: false,
  };
}

export function reduceRightDockFullWidthState(
  state: RightDockFullWidthState,
  event: RightDockFullWidthEvent,
): RightDockFullWidthState {
  switch (event.type) {
    case "set-full-width":
      if (
        event.fullWidth &&
        event.shellWidth !== undefined &&
        event.shellWidth > 0 &&
        event.shellWidth <= RIGHT_DOCK_FULL_WIDTH_AUTO_EXIT_MAX_WIDTH_PX
      ) {
        return createRightDockFullWidthState();
      }
      if (state.fullWidth === event.fullWidth && !state.restoreFullWidthOnNextOpen) {
        return state;
      }
      return {
        fullWidth: event.fullWidth,
        restoreFullWidthOnNextOpen: false,
      };
    case "temporary-close":
      if (!state.fullWidth) {
        return state;
      }
      return {
        fullWidth: false,
        restoreFullWidthOnNextOpen: true,
      };
    case "open":
      if (!state.restoreFullWidthOnNextOpen) {
        return state;
      }
      return {
        fullWidth: true,
        restoreFullWidthOnNextOpen: false,
      };
    case "shell-resized":
      if (
        event.width > RIGHT_DOCK_FULL_WIDTH_AUTO_EXIT_MAX_WIDTH_PX ||
        (!state.fullWidth && !state.restoreFullWidthOnNextOpen)
      ) {
        return state;
      }
      return createRightDockFullWidthState();
  }
}

/**
 * Treat a pending restore as full width on the first open render. This mirrors
 * Codex's restore-on-open atom without flashing one regular-width frame.
 */
export function resolveRightDockEffectiveFullWidth(
  state: RightDockFullWidthState,
  rightDockOpen: boolean,
): boolean {
  return rightDockOpen && (state.fullWidth || state.restoreFullWidthOnNextOpen);
}

export function shouldHideMainChatHeaderForRightDock(input: {
  rightDockOpen: boolean;
  rightDockFullWidth: boolean;
}): boolean {
  return input.rightDockOpen && input.rightDockFullWidth;
}

const REGULAR_RIGHT_DOCK_PANEL_CLASS_NAME =
  "border-l border-[var(--app-surface-divider)] text-foreground";

export interface RightDockChromeContract {
  panelClassName: string;
  resizable: boolean;
  showSidebarRail: boolean;
}

export function resolveRightDockChromeContract(fullWidth: boolean): RightDockChromeContract {
  if (fullWidth) {
    return {
      panelClassName: "text-foreground",
      resizable: false,
      showSidebarRail: false,
    };
  }
  return {
    panelClassName: REGULAR_RIGHT_DOCK_PANEL_CLASS_NAME,
    resizable: true,
    showSidebarRail: true,
  };
}

export function formatRightDockSurfaceControlTooltip(
  label: string,
  shortcutLabel: string | null,
): string {
  return shortcutLabel ? `${label} (${shortcutLabel})` : label;
}

export function resolveRightDockSurfaceControlShortcutLabels(
  keybindings: ResolvedKeybindingsConfig,
  platform?: string,
): { bottomPanel: string; rightPanel: string } {
  return {
    bottomPanel:
      shortcutLabelForCommand(keybindings, "terminal.toggle", platform) ??
      formatShortcutLabel(
        {
          key: "j",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
        platform,
      ),
    rightPanel:
      shortcutLabelForCommand(keybindings, "rightPanel.toggle", platform) ??
      formatShortcutLabel(
        {
          key: "b",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: true,
          modKey: true,
        },
        platform,
      ),
  };
}
