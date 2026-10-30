// FILE: threadSummaryPanel.logic.ts
// Purpose: Pure responsive state machine for the Codex-style thread summary panel.
// Layer: Chat shell presentation logic

export const THREAD_SUMMARY_PANEL_WIDTH_PX = 300;
export const THREAD_SUMMARY_PANEL_GAP_PX = 16;
export const THREAD_SUMMARY_SHIFT_PX =
  -(THREAD_SUMMARY_PANEL_WIDTH_PX + THREAD_SUMMARY_PANEL_GAP_PX) / 2;
export const THREAD_SUMMARY_OVERLAY_RADIUS_PX = 20;
export const THREAD_SUMMARY_POPOVER_OFFSET_PX = 8;
export const THREAD_SUMMARY_TOOLTIP_DELAY_MS = 250;
export const THREAD_SUMMARY_MAX_SUBAGENT_PREVIEW = 4;
export const THREAD_SUMMARY_SECTION_DEFAULT_OPEN = true;

export type ThreadSummaryPanelDisplayMode = "overlay" | "shift" | "gutter";

export interface ThreadSummaryPanelState {
  displayMode: ThreadSummaryPanelDisplayMode;
  isPinned: boolean;
  isPopoverOpen: boolean;
}

export type ThreadSummaryPanelAction =
  | { type: "toggle" }
  | { type: "dismiss-popover" }
  | { type: "set-display-mode"; displayMode: ThreadSummaryPanelDisplayMode };

/**
 * Current Codex calculation: available side room is `(mainContentTargetWidth - 736) / 2`.
 * Under 180px it overlays, under 400px it shifts the transcript, otherwise it occupies gutter.
 */
export function resolveThreadSummaryPanelDisplayMode(
  mainContentTargetWidth: number,
): ThreadSummaryPanelDisplayMode {
  const availableSideRoom = (mainContentTargetWidth - 736) / 2;
  if (availableSideRoom < 180) return "overlay";
  if (availableSideRoom < 400) return "shift";
  return "gutter";
}

/**
 * Resolve the post-animation chat width from route-level geometry.
 *
 * The right dock animates its own width. Reading the chat column directly while
 * that animation is running makes the summary jump through overlay/shift/gutter
 * modes. Codex instead classifies against the layout's destination width.
 */
export function resolveThreadSummaryMainContentTargetWidth(input: {
  currentContentWidth: number;
  shellRowWidth: number | null;
  rightDockOpen: boolean;
  rightDockFullWidth: boolean;
  rightDockTargetWidth: number | null;
}): number {
  const currentContentWidth = Number.isFinite(input.currentContentWidth)
    ? Math.max(0, input.currentContentWidth)
    : 0;
  if (
    input.shellRowWidth === null ||
    !Number.isFinite(input.shellRowWidth) ||
    input.shellRowWidth <= 0
  ) {
    return currentContentWidth;
  }

  const shellRowWidth = Math.max(0, input.shellRowWidth);
  if (!input.rightDockOpen) return shellRowWidth;
  if (input.rightDockFullWidth) return 0;
  if (
    input.rightDockTargetWidth === null ||
    !Number.isFinite(input.rightDockTargetWidth) ||
    input.rightDockTargetWidth < 0
  ) {
    return currentContentWidth;
  }
  return Math.max(0, shellRowWidth - input.rightDockTargetWidth);
}

export function reduceThreadSummaryPanelState(
  current: ThreadSummaryPanelState,
  action: ThreadSummaryPanelAction,
): ThreadSummaryPanelState {
  switch (action.type) {
    case "toggle":
      return current.displayMode === "overlay"
        ? { ...current, isPopoverOpen: !current.isPopoverOpen }
        : { ...current, isPinned: !current.isPinned };
    case "dismiss-popover":
      return current.isPopoverOpen ? { ...current, isPopoverOpen: false } : current;
    case "set-display-mode": {
      const isPopoverOpen = action.displayMode === "overlay" ? current.isPopoverOpen : false;
      if (current.displayMode === action.displayMode && current.isPopoverOpen === isPopoverOpen) {
        return current;
      }
      return { ...current, displayMode: action.displayMode, isPopoverOpen };
    }
  }
}

export function resolveThreadSummaryPanelPresentation(state: ThreadSummaryPanelState): {
  visible: boolean;
  presentation: "popover" | "inline";
} {
  if (state.displayMode === "overlay") {
    return { visible: state.isPopoverOpen, presentation: "popover" };
  }
  return { visible: state.isPinned, presentation: "inline" };
}

export function resolveThreadSummaryContentShift(state: ThreadSummaryPanelState): number {
  return state.isPinned && state.displayMode === "shift" ? THREAD_SUMMARY_SHIFT_PX : 0;
}
