// FILE: SettingsPageFrame.tsx
// Purpose: The frame every settings page shares — the opaque settings card, its
//          surface (which starts the page below the top strip in the rail
//          layout), and the top strip — so Settings › Plugins and the other
//          sections share one geometry.
// Layer: Settings UI
// Exports: SettingsPageFrame

import type { ReactNode } from "react";

import { useDesktopTopBarTrafficLightGutterClassName } from "~/hooks/useDesktopTopBarGutter";
import { cn } from "~/lib/utils";
import { SETTINGS_PAGE_BACKGROUND_CLASS_NAME } from "~/settingsPanelStyles";
import {
  CHAT_SURFACE_HEADER_HEIGHT_CLASS,
  CHAT_SURFACE_HEADER_PADDING_X_CLASS,
} from "../chat/chatHeaderControls";
import {
  CHAT_CONTENT_CARD_CLASS_NAME,
  CHAT_MAIN_VIEWPORT_SHELL_CLASS_NAME,
} from "../chat/composerPickerStyles";
import { RouteInsetSurface } from "../RouteInsetSurface";
import { SidebarHeaderNavigationControls } from "../SidebarHeaderNavigationControls";

/**
 * Companion sidebar trigger so settings is reachable-and-exitable even when the
 * sidebar is collapsed (web/mobile have no global Back arrow). Pinned to the
 * card's top-left — at the same header height + traffic-light gutter as the
 * chat and route headers — so the collapsed-state toggle sits by the traffic
 * lights instead of floating in the centered settings body. It renders nothing
 * while the sidebar is open (SidebarHeaderNavigationControls returns null), so it
 * adds no navigation chrome in the common (open) state and never shifts the centered
 * content (hence absolute, not a layout-occupying header row). The strip stays a
 * drag-region so the Windows frameless window can be moved by its top edge; the
 * caption buttons themselves are a separate fixed cluster (see root route). Clicks
 * pass through it to the page's own header row (window dragging is native and
 * unaffected); only the sidebar toggle takes them.
 */
function SettingsPageTopStrip() {
  const trafficLightGutterClassName = useDesktopTopBarTrafficLightGutterClassName();
  return (
    <div
      data-testid="settings-page-top-strip"
      className={cn(
        "drag-region pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center",
        CHAT_SURFACE_HEADER_PADDING_X_CLASS,
        CHAT_SURFACE_HEADER_HEIGHT_CLASS,
        trafficLightGutterClassName,
      )}
    >
      <div className="pointer-events-auto">
        <SidebarHeaderNavigationControls />
      </div>
    </div>
  );
}

export function SettingsPageFrame({ children }: { readonly children: ReactNode }) {
  return (
    <div
      className={cn(
        CHAT_MAIN_VIEWPORT_SHELL_CLASS_NAME,
        SETTINGS_PAGE_BACKGROUND_CLASS_NAME,
        CHAT_CONTENT_CARD_CLASS_NAME,
      )}
    >
      <RouteInsetSurface surfaceClassName={SETTINGS_PAGE_BACKGROUND_CLASS_NAME}>
        <SettingsPageTopStrip />
        {children}
      </RouteInsetSurface>
    </div>
  );
}
