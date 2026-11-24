// FILE: desktopTitleBar.ts
// Purpose: Whether this window draws its own title-bar chrome (the desktop app). One answer for
//          the back/forward arrows, the cluster's reserved box and the band over full-window
//          pages, so they never disagree (walk R-9).
// Layer: Web shell helpers

import { isElectron } from "~/env";
import { isMacNavigatorPlatform } from "~/lib/utils";

/** The desktop app shows the back/forward arrows beside the sidebar toggle. */
export function desktopTitleBarControlsShown(): boolean {
  return isElectron;
}

/**
 * The Windows and Linux desktop app draws the title bar itself, so full-window pages (图像,
 * 资料空间) need a band to drag the window by. macOS keeps its native title bar.
 */
export function desktopTitleBarBandShown(): boolean {
  return isElectron && !isMacNavigatorPlatform();
}
