// FILE: disclosureMotion.ts
// Purpose: Shared open/close motion tokens for collapsible UI (sidebar lists, transcript panels, etc.).
// Layer: Web UI motion primitive
// Exports: class-name helpers + Collapsible panel tokens
// Why: Sidebar project/thread expand and chat disclosures reused the same grid/opacity
//      timing in multiple places; centralize it so new expand/collapse surfaces stay consistent.

import type { CSSProperties } from "react";

import { cn } from "~/lib/utils";

// Pass13's explicit conversation parity scope uses the installed Codex motion
// profiles. Keep these here, alongside the default Moss disclosure contract,
// so transcript rows never define their own timing or easing.
export const CONVERSATION_DISCLOSURE_MS = 300;
export const CONVERSATION_DISCLOSURE_CHEVRON_CLASS = "duration-[300ms]";
export const CONVERSATION_SUMMARY_CHEVRON_CLASS = "duration-[150ms]";
const CONVERSATION_DISCLOSURE_EASE = [0.19, 1, 0.22, 1] as const;
const CONVERSATION_SUMMARY_OPEN_EASE = [0.33, 1, 0.68, 1] as const;
const CONVERSATION_SUMMARY_CLOSE_EASE = [0.23, 1, 0.32, 1] as const;

export function conversationDisclosureTransition(reducedMotion: boolean) {
  return {
    duration: reducedMotion ? 0 : CONVERSATION_DISCLOSURE_MS / 1000,
    ease: [...CONVERSATION_DISCLOSURE_EASE] as [number, number, number, number],
  };
}

function cssDisclosureTransition(
  reducedMotion: boolean,
  durationMs: number,
  ease: readonly number[],
  properties: string,
): CSSProperties {
  return {
    transitionProperty: reducedMotion ? "none" : properties,
    transitionDuration: reducedMotion ? "0s" : `${durationMs}ms`,
    transitionTimingFunction: `cubic-bezier(${ease.join(", ")})`,
  };
}

export function conversationDisclosureStyle(reducedMotion: boolean): CSSProperties {
  return cssDisclosureTransition(
    reducedMotion,
    CONVERSATION_DISCLOSURE_MS,
    CONVERSATION_DISCLOSURE_EASE,
    "height, opacity",
  );
}

export function conversationSummaryStyle(reducedMotion: boolean, open: boolean): CSSProperties {
  return cssDisclosureTransition(
    reducedMotion,
    open ? 220 : 150,
    open ? CONVERSATION_SUMMARY_OPEN_EASE : CONVERSATION_SUMMARY_CLOSE_EASE,
    "height, opacity, transform",
  );
}

export const DISCLOSURE_TRANSITION_MS = 220;
export const DISCLOSURE_CLEANUP_BUFFER_MS = 40;

/** Shell grid that animates height via grid-template-rows + fade. */
export const DISCLOSURE_SHELL_MOTION_CLASS =
  "grid transition-[grid-template-rows,opacity] duration-220 ease-out motion-reduce:transition-none";

export const DISCLOSURE_SHELL_OPEN_CLASS = "grid-rows-[1fr] opacity-100";
export const DISCLOSURE_SHELL_CLOSED_CLASS = "grid-rows-[0fr] opacity-0";

/** Required inner wrapper so grid-row collapse measures correctly. */
export const DISCLOSURE_INNER_CLASS = "min-h-0 overflow-hidden";

/** Optional content drift/fade layered on top of the shell animation. */
export const DISCLOSURE_CONTENT_MOTION_CLASS =
  "transition-[opacity,translate] duration-220 ease-out motion-reduce:transition-none";

export const DISCLOSURE_CONTENT_OPEN_CLASS = "translate-y-0 opacity-100";
export const DISCLOSURE_CONTENT_CLOSED_CLASS = "-translate-y-1 opacity-0 pointer-events-none";

/**
 * Opacity-only reveal for elements that hold their place in the layout while
 * they show and hide: overlay hints, status lines, and anything absolutely
 * positioned, where collapsing the box would move the thing it annotates.
 * Same duration and curve as the collapsing disclosures.
 */
export const DISCLOSURE_FADE_MOTION_CLASS =
  "transition-opacity duration-220 ease-out motion-reduce:transition-none";

export function disclosureFadeClassName(open: boolean, className?: string) {
  return cn(DISCLOSURE_FADE_MOTION_CLASS, open ? "opacity-100" : "opacity-0", className);
}

/** Chevron rotation paired with the shell motion. */
export const DISCLOSURE_CHEVRON_MOTION_CLASS =
  "size-3 shrink-0 text-muted-foreground transition-transform duration-220 ease-out motion-reduce:transition-none";

/** Base-ui Collapsible panel height animation using the same timing curve. */
export const DISCLOSURE_COLLAPSIBLE_PANEL_CLASS =
  "h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-220 ease-out motion-reduce:transition-none data-ending-style:h-0 data-starting-style:h-0 data-open:data-ending-style:[height:var(--collapsible-panel-height)]";

/**
 * Inline-axis (width) reveal for side panels that open/close along the
 * horizontal axis. Same timing curve as the vertical disclosures so every
 * toggle in the app stays consistent. Pair `open ? openWidthClassName : "w-0"`.
 */
export const DISCLOSURE_WIDTH_MOTION_CLASS =
  "overflow-hidden transition-[width] duration-220 ease-out motion-reduce:transition-none";

export function disclosureWidthClassName(
  open: boolean,
  openWidthClassName: string,
  className?: string,
) {
  return cn(DISCLOSURE_WIDTH_MOTION_CLASS, open ? openWidthClassName : "w-0", className);
}

export function disclosureShellClassName(open: boolean, className?: string) {
  return cn(
    DISCLOSURE_SHELL_MOTION_CLASS,
    open ? DISCLOSURE_SHELL_OPEN_CLASS : DISCLOSURE_SHELL_CLOSED_CLASS,
    className,
  );
}

export function disclosureContentClassName(open: boolean, className?: string) {
  return cn(
    DISCLOSURE_CONTENT_MOTION_CLASS,
    open ? DISCLOSURE_CONTENT_OPEN_CLASS : DISCLOSURE_CONTENT_CLOSED_CLASS,
    className,
  );
}

export function disclosureChevronClassName(open: boolean, className?: string) {
  return cn(DISCLOSURE_CHEVRON_MOTION_CLASS, open && "rotate-90", className);
}

/**
 * Pop reveal for a floating card that materializes from its top-right corner.
 * Asymmetric timing: slow deliberate arrival, snappy exit. Same ease-out
 * curve as the other disclosures.
 */
export const DISCLOSURE_POP_OPEN_MS = 280;
export const DISCLOSURE_POP_CLOSE_MS = 160;

/** Base transition covering opacity + translate/scale with the open duration. */
export const DISCLOSURE_POP_MOTION_CLASS =
  "origin-top-right transition-[opacity,translate,scale] duration-280 ease-out motion-reduce:transition-none";

export const DISCLOSURE_POP_OPEN_CLASS = "translate-y-0 scale-100 opacity-100";
export const DISCLOSURE_POP_CLOSED_CLASS =
  "translate-y-1.5 scale-[0.97] opacity-0 pointer-events-none duration-160";

export function disclosurePopClassName(open: boolean, className?: string) {
  return cn(
    DISCLOSURE_POP_MOTION_CLASS,
    open ? DISCLOSURE_POP_OPEN_CLASS : DISCLOSURE_POP_CLOSED_CLASS,
    className,
  );
}

/** Floating side-card reveal used by Codex-style summary surfaces. */
export const DISCLOSURE_FLOATING_PANEL_MOTION_CLASS =
  "origin-right transition-[opacity,transform] duration-[220ms] ease-out motion-reduce:transition-none";

/** Motion projection uses the same timing as the CSS disclosure paths. */
export function disclosureHeightTransition(reducedMotion: boolean) {
  return {
    duration: reducedMotion ? 0 : DISCLOSURE_TRANSITION_MS / 1000,
    ease: [0, 0, 0.2, 1] as [number, number, number, number],
  };
}

export const DISCLOSURE_FLOATING_PANEL_OPEN_CLASS = "translate-x-0 scale-100 opacity-100";
export const DISCLOSURE_FLOATING_PANEL_CLOSED_CLASS =
  "pointer-events-none translate-x-full scale-[0.8] opacity-0";

export function disclosureFloatingPanelClassName(open: boolean, className?: string) {
  return cn(
    DISCLOSURE_FLOATING_PANEL_MOTION_CLASS,
    open ? DISCLOSURE_FLOATING_PANEL_OPEN_CLASS : DISCLOSURE_FLOATING_PANEL_CLOSED_CLASS,
    className,
  );
}
