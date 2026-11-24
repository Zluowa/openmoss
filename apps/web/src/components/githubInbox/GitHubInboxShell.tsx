// FILE: GitHubInboxShell.tsx
// Purpose: The page frame of 代码审查: the content card inset beside the sidebar with the top
//          strip that holds the sidebar toggle, plus an optional pane docked beside the card. The
//          inbox and the GitHub connection screen both draw inside it, so the page looks the same
//          before and after GitHub is connected.
// Layer: GitHub inbox UI component
// Exports: GitHubInboxShell

import type { ReactNode } from "react";

import {
  CHAT_BACKGROUND_CLASS_NAME,
  CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME,
  CHAT_MAIN_VIEWPORT_SHELL_CLASS_NAME,
} from "../chat/composerPickerStyles";
import { RouteInsetSurface } from "../RouteInsetSurface";
import { RouteSurfaceHeader } from "../RouteSurface";
import { cn } from "~/lib/utils";

export function GitHubInboxShell({
  children,
  aside,
}: {
  children: ReactNode;
  /** Docked beside the card (the Ask side chat). */
  aside?: ReactNode;
}) {
  return (
    <div className={cn(CHAT_MAIN_VIEWPORT_SHELL_CLASS_NAME, CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME)}>
      <RouteInsetSurface surfaceClassName="bg-transparent">
        <div
          className={cn(
            "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
            CHAT_BACKGROUND_CLASS_NAME,
          )}
          data-github-inbox-shell=""
        >
          {/* Like Settings: the title lives at the top of the list column, so this strip only
              holds the sidebar toggle (shown while the sidebar is collapsed) and stays a drag
              region. */}
          <RouteSurfaceHeader
            divider={false}
            className="app-top-bar shrink-0"
            // Keeps the shell band's height even though the strip holds only the toggle.
            rowClassName="h-[var(--app-top-strip-height)]"
          />
          {children}
        </div>
      </RouteInsetSurface>
      {aside}
    </div>
  );
}
