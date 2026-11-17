// FILE: innerPopupEscape.ts
// Purpose: Escape inside a dialog closes only the innermost popup, while dialogs are on Base UI and
//          menus, selects and popovers are on UI SDK (UI SDK part A; dialogs move in part 3).
// Layer: components/ui internals (not for app code).

import { useLayoutEffect } from "react";

import { closeOpenMenus } from "./menu";
//
// Under Base UI alone, a menu inside a dialog shared the dialog's popup tree, so Escape went to the
// menu only. A UI SDK popup is outside that tree: Base UI's dialog sees the same Escape and closes
// too (a markup session asks to discard, a settings dialog vanishes with its open select). The
// dialog roots therefore keep themselves open on an Escape while one of Moss's UI SDK popups shows;
// that popup takes the key.

/** The positioned parts of Moss's UI SDK popups that take Escape themselves. */
const ESCAPE_TAKING_POPUPS = [
  '[data-slot="menu-positioner"]',
  '[data-slot="select-positioner"]',
  '[data-slot="popover-positioner"]',
  '[data-slot="preview-card-positioner"]',
].join(", ");

/** Whether one of Moss's UI SDK popups is showing (closed ones stay in the page, hidden). */
export function innerPopupIsShowing(): boolean {
  if (typeof document === "undefined") return false;
  for (const element of document.querySelectorAll(ESCAPE_TAKING_POPUPS)) {
    if (element.closest("[hidden]")) continue;
    const box = element.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) return true;
  }
  return false;
}

type OpenChangeDetails =
  | { reason?: string; event?: Event; cancel?: () => void; allowPropagation?: () => void }
  | undefined;

/**
 * Escapes that belonged to an inner popup. Base UI's dialog hears one Escape twice (on its popup
 * and on the document); by the second time the popup may already have closed.
 */
const takenByInnerPopup = new WeakSet<Event>();

/**
 * Wraps a Base UI dialog root's `onOpenChange`: an Escape dismissal while a UI SDK popup shows is
 * cancelled, so only that popup closes. Everything else passes through unchanged.
 */
export function keepOpenForInnerPopupEscape<Rest extends unknown[]>(
  onOpenChange: ((open: boolean, details: any, ...rest: Rest) => void) | undefined,
): (open: boolean, details: any, ...rest: Rest) => void {
  return (open, details, ...rest) => {
    const change = details as OpenChangeDetails;
    const event = change?.event;
    const taken = event !== undefined && takenByInnerPopup.has(event);
    if (!open && change?.reason === "escape-key" && (taken || innerPopupIsShowing())) {
      if (event) takenByInnerPopup.add(event);
      change.cancel?.();
      // Base UI stops an Escape it handled from going further; this one belongs to the popup,
      // whose listener is on the document, so it must go on.
      change.allowPropagation?.();
      return;
    }
    // A dialog opening over an open menu takes over from it (see `closeOpenMenus`).
    if (open) closeOpenMenus();
    onOpenChange?.(open, details, ...rest);
  };
}

/** A dialog opened by its `open` prop closes open menus too, as one opened by its trigger. */
export function useCloseMenusWhenOpen(open: boolean | undefined): void {
  useLayoutEffect(() => {
    if (open) closeOpenMenus();
  }, [open]);
}
