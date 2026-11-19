// FILE: useSettingsTargetScroll.ts
// Purpose: Bring a Settings deep-link target into view by scrolling only the page's own
// scroll area. scrollIntoView also scrolled the dialog itself, which pushed its title and
// close button off screen and cut the list at the bottom.
// Layer: web settings.

import { useEffect } from "react";

export function useSettingsTargetScroll(section: string, target: string | null | undefined): void {
  useEffect(() => {
    if (!target) return;
    const frame = window.requestAnimationFrame(() => {
      const element = document.getElementById(target);
      if (element) scrollWithinPane(element);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [section, target]);
}

/** Scrolls the nearest scrolling ancestor so `element` starts at its top, and nothing else. */
function scrollWithinPane(element: HTMLElement): void {
  let pane = element.parentElement;
  while (pane) {
    const overflowY = getComputedStyle(pane).overflowY;
    if ((overflowY === "auto" || overflowY === "scroll") && pane.scrollHeight > pane.clientHeight) {
      break;
    }
    pane = pane.parentElement;
  }
  if (!pane) return;
  // The dialog opens with a zoom, so measured distances are scaled until it settles.
  const paneBox = pane.getBoundingClientRect();
  const scale = pane.offsetHeight > 0 ? paneBox.height / pane.offsetHeight : 1;
  const top = (element.getBoundingClientRect().top - paneBox.top) / (scale || 1) + pane.scrollTop;
  pane.scrollTo({ top: Math.max(0, top) });
}
