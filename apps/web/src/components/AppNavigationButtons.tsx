// FILE: AppNavigationButtons.tsx
// Purpose: Renders Electron-only browser-style route back/forward controls.
// Layer: Shared web shell chrome
// Depends on: appNavigation history helpers, header Button/Tooltip primitives

import { useRouter } from "@tanstack/react-router";

import { ArrowLeftIcon, ArrowRightIcon } from "~/lib/icons";
import {
  appHistory,
  goBackInAppHistory,
  goForwardInAppHistory,
  useAppNavigationState,
} from "~/appNavigation";
import { desktopTitleBarControlsShown } from "~/lib/desktopTitleBar";
import { cn, isMacNavigatorPlatform } from "~/lib/utils";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function AppNavigationButtons({ className }: { className?: string }) {
  // The router's own history (the app's history in the app); outside a router, the app's history.
  const history = useRouter({ warn: false })?.history ?? appHistory;
  const { canGoBack, canGoForward } = useAppNavigationState(history);
  const isMac = isMacNavigatorPlatform();
  const backShortcutLabel = isMac ? "⌘[" : "Alt+Left";
  const forwardShortcutLabel = isMac ? "⌘]" : "Alt+Right";

  if (!desktopTitleBarControlsShown()) {
    return null;
  }

  return (
    <div
      className={cn(
        "-ms-1 flex shrink-0 items-center gap-0.5 [-webkit-app-region:no-drag]",
        className,
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-8 rounded-control"
              aria-label="Back"
              disabled={!canGoBack}
              onClick={() => goBackInAppHistory(history)}
            />
          }
        >
          <ArrowLeftIcon className="size-4" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Back ({backShortcutLabel})</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-8 rounded-control"
              aria-label="Forward"
              disabled={!canGoForward}
              onClick={() => goForwardInAppHistory(history)}
            />
          }
        >
          <ArrowRightIcon className="size-4" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Forward ({forwardShortcutLabel})</TooltipPopup>
      </Tooltip>
    </div>
  );
}
