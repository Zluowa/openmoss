"use client";

import {
  HoverCard as HoverCardPrimitive,
  HoverCardContent,
  HoverCardTrigger as HoverCardTriggerPrimitive,
} from "@ui-sdk/react/hover-card";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "~/lib/utils";
import { POPUP_INHERITANCE_RESET_CLASS_NAME } from "./tooltip";
import { useProvideTriggerOptions, useTriggerOptions } from "./triggerOptions";
import { definedProps, type Loose, type LooseRender } from "./uiSdkProps";

// Hover-triggered, interactive card (UI SDK HoverCard). Unlike a Tooltip it
// stays open while the pointer moves into the popup, so its content can hold
// clickable controls (used by the sidebar project/folder hover card).
function PreviewCard({ children, ...props }: Loose<ComponentProps<typeof HoverCardPrimitive>>) {
  const [fromTrigger, provide] = useTriggerOptions();
  return (
    <HoverCardPrimitive
      {...definedProps<object, ComponentProps<typeof HoverCardPrimitive>>({
        ...props,
        delay: props.delay ?? fromTrigger.delay,
        closeDelay: props.closeDelay ?? fromTrigger.closeDelay,
      })}
    >
      {provide(children as ReactNode)}
    </HoverCardPrimitive>
  );
}

type PreviewCardTriggerProps = Loose<
  Omit<ComponentProps<typeof HoverCardTriggerPrimitive>, "render">
> & {
  render?: LooseRender | undefined;
  delay?: number | undefined;
  closeDelay?: number | undefined;
};

function PreviewCardTrigger({ delay, closeDelay, ...props }: PreviewCardTriggerProps) {
  useProvideTriggerOptions({ delay, closeDelay });
  return (
    <HoverCardTriggerPrimitive
      {...definedProps<object, ComponentProps<typeof HoverCardTriggerPrimitive>>(props)}
      data-slot="preview-card-trigger"
    />
  );
}

type PreviewCardPopupProps = Omit<Loose<ComponentProps<typeof HoverCardContent>>, "className"> & {
  className?: string | undefined;
  // Kept for callers; the positioned element is UI SDK's content part, which takes it.
  positionerClassName?: string | undefined;
};

function PreviewCardPopup({
  className,
  positionerClassName,
  align: alignProp,
  side: sideProp,
  sideOffset: sideOffsetProp,
  children,
  ...props
}: PreviewCardPopupProps) {
  return (
    <HoverCardContent
      {...definedProps<object, ComponentProps<typeof HoverCardContent>>(props)}
      align={alignProp ?? "start"}
      side={sideProp ?? "right"}
      sideOffset={sideOffsetProp ?? 8}
      // Base UI kept popups 5px from the window's edge; UI SDK's default is 8px.
      collisionPadding={(props as { collisionPadding?: number }).collisionPadding ?? 5}
      className={cn(
        POPUP_INHERITANCE_RESET_CLASS_NAME,
        "z-50 max-w-(--available-width) origin-(--transform-origin) outline-none transition-[scale,opacity] duration-200 ease-out motion-reduce:transition-none data-ending-style:scale-97 data-starting-style:scale-97 data-ending-style:opacity-0 data-starting-style:opacity-0",
        positionerClassName,
      )}
      render={(contentProps) => <div {...contentProps} data-slot="preview-card-positioner" />}
    >
      <div
        className={cn(
          "overflow-hidden rounded-popover border border-[color:var(--color-border-light)] bg-[var(--color-background-surface-under)] text-[var(--color-text-foreground)] shadow-lg",
          className,
        )}
        data-slot="preview-card-popup"
      >
        {children as ReactNode}
      </div>
    </HoverCardContent>
  );
}

export { PreviewCard, PreviewCardTrigger, PreviewCardPopup };
