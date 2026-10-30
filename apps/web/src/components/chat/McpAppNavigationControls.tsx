// FILE: McpAppNavigationControls.tsx
// Purpose: Shared Back/Next controls for the one live MCP App inner document.

import type { MouseEvent, PointerEvent } from "react";

import { ArrowLeftIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import { IconButton } from "../ui/icon-button";
import { DOCK_HEADER_ICON_BUTTON_CLASS } from "./chatHeaderControls";

export type McpAppNavigationDelta = -1 | 1;

export interface McpAppNavigationControlsProps {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly onNavigate: (delta: McpAppNavigationDelta) => void;
  readonly className?: string;
}

function stopPropagation(event: MouseEvent | PointerEvent): void {
  event.stopPropagation();
}

export function McpAppNavigationControls(props: McpAppNavigationControlsProps) {
  if (!props.canGoBack && !props.canGoForward) return null;

  return (
    <div
      className={cn("pointer-events-auto flex items-center gap-px", props.className)}
      data-mcp-app-navigation-controls="true"
      onClick={stopPropagation}
      onPointerDown={stopPropagation}
    >
      <IconButton
        variant="ghost"
        size="icon-xs"
        className={cn(DOCK_HEADER_ICON_BUTTON_CLASS, "[&_svg,&_[data-slot=central-icon]]:size-3.5")}
        label="Back"
        title="Back"
        disabled={!props.canGoBack}
        onClick={(event) => {
          event.stopPropagation();
          props.onNavigate(-1);
        }}
        onPointerDown={stopPropagation}
      >
        <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
      </IconButton>
      <IconButton
        variant="ghost"
        size="icon-xs"
        className={cn(DOCK_HEADER_ICON_BUTTON_CLASS, "[&_svg,&_[data-slot=central-icon]]:size-3.5")}
        label="Next"
        title="Next"
        disabled={!props.canGoForward}
        onClick={(event) => {
          event.stopPropagation();
          props.onNavigate(1);
        }}
        onPointerDown={stopPropagation}
      >
        <ArrowLeftIcon aria-hidden="true" className="size-3.5 transform -scale-x-100" />
      </IconButton>
    </div>
  );
}

export default McpAppNavigationControls;
