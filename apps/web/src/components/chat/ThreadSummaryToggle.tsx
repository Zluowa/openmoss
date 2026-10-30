// FILE: ThreadSummaryToggle.tsx
// Purpose: Exact Codex-style summary toolbar trigger and responsive overlay popover.
// Layer: Chat shell presentation

import { type ComponentProps, type ReactNode, useCallback, useEffect, useRef } from "react";

import { cn } from "~/lib/utils";

import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { CHAT_HEADER_TOGGLE_CLASS_NAME } from "./chatHeaderControls";
import {
  THREAD_SUMMARY_POPOVER_OFFSET_PX,
  THREAD_SUMMARY_TOOLTIP_DELAY_MS,
  type ThreadSummaryPanelState,
} from "./threadSummaryPanel.logic";

type PopoverOpenChangeHandler = NonNullable<ComponentProps<typeof Popover>["onOpenChange"]>;

const RIGHT_DOCK_SURFACE_SELECTOR = '[data-testid="right-dock-panel"]';

function isWithinRightDock(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(RIGHT_DOCK_SURFACE_SELECTOR) !== null;
}

function isRightDockInteraction(event: Event): boolean {
  if (event.composedPath().some((target) => isWithinRightDock(target))) {
    return true;
  }
  return event instanceof FocusEvent && isWithinRightDock(event.relatedTarget);
}

/**
 * The summary action is conditionally mounted by ChatHeader. Clear its controlled
 * open state after a real unmount so disabling and later re-enabling the feature
 * cannot resurrect a stale popover. Deferring one task lets React StrictMode's
 * setup-cleanup-setup probe cancel the cleanup before it is mistaken for unmount.
 */
function useClearOpenStateOnUnmount(
  isOpen: boolean,
  onPopoverOpenChange: (open: boolean) => void,
): void {
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;
  const onPopoverOpenChangeRef = useRef(onPopoverOpenChange);
  onPopoverOpenChangeRef.current = onPopoverOpenChange;
  const cleanupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (cleanupTimerRef.current !== null) {
      clearTimeout(cleanupTimerRef.current);
      cleanupTimerRef.current = null;
    }

    return () => {
      if (!isOpenRef.current) {
        return;
      }
      cleanupTimerRef.current = setTimeout(() => {
        cleanupTimerRef.current = null;
        if (isOpenRef.current) {
          onPopoverOpenChangeRef.current(false);
        }
      }, 0);
    };
  }, []);
}

export function ThreadSummaryIcon({ className }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 20 20" fill="currentColor" className={className}>
      <path d="M5.693 11.056a2.71 2.71 0 0 1 2.432 2.694l-.015.277a2.71 2.71 0 0 1-2.694 2.432l-.276-.015a2.71 2.71 0 0 1-2.418-2.417l-.014-.277a2.709 2.709 0 0 1 2.708-2.708l.277.014Zm-.277 1.316a1.378 1.378 0 1 0 0 2.757 1.378 1.378 0 0 0 0-2.757Zm11.384.727a.665.665 0 0 1 0 1.302l-.134.014h-5.833a.665.665 0 0 1 0-1.33h5.833l.135.014ZM5.693 3.556A2.71 2.71 0 0 1 8.125 6.25l-.015.277A2.71 2.71 0 0 1 5.416 8.96l-.276-.015a2.71 2.71 0 0 1-2.418-2.417l-.014-.277a2.709 2.709 0 0 1 2.708-2.708l.277.014Zm-.277 1.316a1.378 1.378 0 1 0 .001 2.757 1.378 1.378 0 0 0-.001-2.757Zm11.384.727a.665.665 0 0 1 0 1.302l-.134.014h-5.833a.665.665 0 0 1 0-1.33h5.833l.135.014Z" />
    </svg>
  );
}

export function ThreadSummaryToggle({
  state,
  onToggle,
  onPopoverOpenChange,
  children,
}: {
  state: ThreadSummaryPanelState;
  onToggle: () => void;
  onPopoverOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const overlay = state.displayMode === "overlay";
  const isPopoverOpen = overlay && state.isPopoverOpen;
  const pressed = overlay ? state.isPopoverOpen : state.isPinned;
  const label = overlay ? "切换摘要" : "切换置顶摘要";
  useClearOpenStateOnUnmount(isPopoverOpen, onPopoverOpenChange);

  const handlePopoverOpenChange = useCallback<PopoverOpenChangeHandler>(
    (open, eventDetails) => {
      if (
        !open &&
        (eventDetails.reason === "outside-press" || eventDetails.reason === "focus-out") &&
        isRightDockInteraction(eventDetails.event)
      ) {
        // Base UI also owns internal open state, so skipping the controlled
        // callback is insufficient: cancellation keeps both state layers open.
        eventDetails.cancel();
        return;
      }
      onPopoverOpenChange(open);
    },
    [onPopoverOpenChange],
  );

  const button = (
    <Toggle
      className={cn(
        CHAT_HEADER_TOGGLE_CLASS_NAME,
        "!size-7 [&_svg,&_[data-slot=central-icon]]:mx-0",
      )}
      pressed={pressed}
      {...(overlay ? {} : { onPressedChange: onToggle })}
      aria-label={label}
      title={label}
      data-testid="chat-header-thread-summary-toggle"
      data-display-mode={state.displayMode}
      data-summary-presentation={overlay ? "popover" : "inline"}
      variant="default"
      size="xs"
    >
      <ThreadSummaryIcon className="size-4" />
    </Toggle>
  );

  return (
    <Popover open={isPopoverOpen} onOpenChange={handlePopoverOpenChange}>
      <Tooltip>
        <TooltipTrigger
          delay={THREAD_SUMMARY_TOOLTIP_DELAY_MS}
          render={overlay ? <PopoverTrigger render={button} /> : button}
        />
        <TooltipPopup side="bottom">{label}</TooltipPopup>
      </Tooltip>
      {overlay && state.isPopoverOpen ? (
        <PopoverPopup
          align="end"
          side="bottom"
          sideOffset={THREAD_SUMMARY_POPOVER_OFFSET_PX}
          data-summary-anchor-offset={THREAD_SUMMARY_POPOVER_OFFSET_PX}
          className="!w-auto !overflow-visible !rounded-popover !bg-transparent !p-0 !shadow-none !ring-0 !backdrop-blur-none before:hidden [&_[data-slot=popover-viewport]]:!p-0"
        >
          {children}
        </PopoverPopup>
      ) : null}
    </Popover>
  );
}
