// FILE: rightDockMotion.logic.ts
// Purpose: Encodes the Codex-specific right dock motion without changing the shared left sidebar.
// Layer: Pure presentation contract

export const RIGHT_DOCK_MOTION = Object.freeze({
  type: "spring" as const,
  durationMs: 500,
  bounce: 0.1,
});

export const RIGHT_DOCK_FULL_WIDTH_CONTROL_TOOLTIP_DELAY_MS = 250;

/**
 * A restrained overshooting curve approximates the native 0.1-bounce spring.
 * It is applied to the layout gap and panel container together so their width,
 * right edge, and opacity stay in lockstep throughout open/close.
 */
export const RIGHT_DOCK_CHROME_MOTION_CLASS =
  "transition-[left,right,width,opacity] duration-500 ease-[cubic-bezier(0.34,1.1,0.64,1)] group-data-[collapsible=offcanvas]:opacity-0 motion-reduce:transition-none";

export const RIGHT_DOCK_CHROME_MOTION_SUPPRESSED_CLASS = "transition-none! duration-0!";

export function resolveRightDockChromeMotionClass(input: { suppressMotion: boolean }): string {
  return input.suppressMotion
    ? RIGHT_DOCK_CHROME_MOTION_SUPPRESSED_CLASS
    : RIGHT_DOCK_CHROME_MOTION_CLASS;
}
