"use client";

import {
  createPopoverController,
  Popover as PopoverPrimitive,
  PopoverClose as PopoverClosePrimitive,
  PopoverContent,
  PopoverDescription as PopoverDescriptionPrimitive,
  PopoverTitle as PopoverTitlePrimitive,
  PopoverTrigger as PopoverTriggerPrimitive,
} from "@ui-sdk/react/popover";
import { createContext, useContext, useEffect, useRef } from "react";
import type { ComponentProps, FocusEvent as ReactFocusEvent, ReactNode } from "react";

import { cn } from "~/lib/utils";
import { APP_TRANSLUCENT_POPUP_SURFACE_CLASS_NAME } from "../chat/composerPickerStyles";
import { POPUP_INHERITANCE_RESET_CLASS_NAME } from "./tooltip";
import { useProvideTriggerOptions, useTriggerOptions } from "./triggerOptions";
import {
  definedProps,
  renderOpenTrigger,
  toAnchor,
  toFocusTarget,
  type Loose,
  type LooseRender,
} from "./uiSdkProps";

/** Detached triggers: UI SDK connects a trigger outside the popover through a controller. */
const PopoverCreateHandle = createPopoverController;

type PopoverChangeDetails = Parameters<
  NonNullable<ComponentProps<typeof PopoverPrimitive>["onOpenChange"]>
>[1];

type PopoverRootProps = Loose<Omit<ComponentProps<typeof PopoverPrimitive>, "onOpenChange">> & {
  /** As Base UI typed it: `details.event` is always an event (an empty one for a controller). */
  onOpenChange?:
    | ((open: boolean, details: Omit<PopoverChangeDetails, "event"> & { event: Event }) => void)
    | undefined;
};

/**
 * Lets the popup tell its root that focus has been inside it since it opened.
 */
const PopoverFocusSeen = createContext<(() => void) | null>(null);

/**
 * Non-modal by default, as Base UI's popover was: the page stays usable and focus leaving it
 * closes it. Hover options set on the trigger reach the root here.
 *
 * Focus that never entered cannot leave: a popover opened from a menu row closed at once on UI
 * SDK, because the closing menu handed focus back to its trigger after the popover had opened
 * (Base UI's menu did so before). A focus-out close counts only once focus has been inside.
 */
function Popover({ children, ...props }: PopoverRootProps) {
  const [fromTrigger, provide] = useTriggerOptions();
  const focusSeen = useRef(false);
  useEffect(() => {
    if (props.open) focusSeen.current = false;
  }, [props.open]);
  return (
    <PopoverFocusSeen.Provider
      value={() => {
        focusSeen.current = true;
      }}
    >
      <PopoverPrimitive
        {...definedProps<object, ComponentProps<typeof PopoverPrimitive>>({
          modal: false,
          ...props,
          openOnHover: props.openOnHover ?? fromTrigger.openOnHover,
          delay: props.delay ?? fromTrigger.delay,
          closeDelay: props.closeDelay ?? fromTrigger.closeDelay,
          onOpenChange: (open: boolean, details: PopoverChangeDetails) => {
            if (open) focusSeen.current = false;
            if (!open && details.reason === "focus-out" && !focusSeen.current) {
              details.cancel();
              return;
            }
            props.onOpenChange?.(
              open,
              details.event
                ? (details as Omit<PopoverChangeDetails, "event"> & { event: Event })
                : {
                    ...details,
                    event: new Event("programmatic"),
                    cancel: () => details.cancel(),
                  },
            );
          },
        })}
      >
        {provide(children as ReactNode)}
      </PopoverPrimitive>
    </PopoverFocusSeen.Provider>
  );
}

type PopoverTriggerProps = Loose<Omit<ComponentProps<typeof PopoverTriggerPrimitive>, "render">> & {
  render?: LooseRender | undefined;
  openOnHover?: boolean | undefined;
  delay?: number | undefined;
  closeDelay?: number | undefined;
  /** Accepted for callers written against Base UI; the trigger is a native button unless rendered. */
  nativeButton?: boolean | undefined;
};

function PopoverTrigger({
  openOnHover,
  delay,
  closeDelay,
  nativeButton: _nativeButton,
  ...props
}: PopoverTriggerProps) {
  useProvideTriggerOptions({ openOnHover, delay, closeDelay });
  return (
    <PopoverTriggerPrimitive
      {...definedProps<object, ComponentProps<typeof PopoverTriggerPrimitive>>({
        ...props,
        render: renderOpenTrigger(props.render, "button", "popover-trigger"),
      })}
      data-slot="popover-trigger"
    />
  );
}

type PopoverPopupProps = Omit<
  Loose<ComponentProps<typeof PopoverContent>>,
  "className" | "anchor" | "initialFocus"
> & {
  className?: string | undefined;
  /** An element, a ref, a function returning one, or anything with getBoundingClientRect(). */
  anchor?: Parameters<typeof toAnchor>[0];
  initialFocus?:
    | ComponentProps<typeof PopoverContent>["initialFocus"]
    | { current: HTMLElement | null };
  tooltipStyle?: boolean | undefined;
};

// Base UI's shape: UI SDK's content part is the positioner (a top-layer stacking context) and
// Moss's surface is a plain child, so the surface's `::before` blur stays behind its background.
function PopoverPopup({
  children,
  className,
  side: sideProp,
  align: alignProp,
  sideOffset: sideOffsetProp,
  alignOffset: alignOffsetProp,
  tooltipStyle: tooltipStyleProp,
  anchor,
  initialFocus,
  ...props
}: PopoverPopupProps) {
  const tooltipStyle = tooltipStyleProp ?? false;
  const markFocusSeen = useContext(PopoverFocusSeen);
  return (
    <PopoverContent
      {...definedProps<object, ComponentProps<typeof PopoverContent>>({
        ...props,
        anchor: toAnchor(anchor),
        initialFocus: toFocusTarget(initialFocus),
      })}
      align={alignProp ?? "center"}
      alignOffset={alignOffsetProp ?? 0}
      side={sideProp ?? "bottom"}
      sideOffset={sideOffsetProp ?? 4}
      // Base UI kept popups 5px from the window's edge; UI SDK's default is 8px.
      collisionPadding={(props as { collisionPadding?: number }).collisionPadding ?? 5}
      className={cn(
        POPUP_INHERITANCE_RESET_CLASS_NAME,
        "z-50 max-w-(--available-width) origin-(--transform-origin) outline-none transition-[scale,opacity] duration-120 ease-snap motion-reduce:transition-none data-starting-style:scale-98 data-starting-style:opacity-0",
      )}
      render={(contentProps) => (
        <div
          {...contentProps}
          onFocusCapture={(event: ReactFocusEvent<HTMLDivElement>) => {
            markFocusSeen?.();
            (
              contentProps as { onFocusCapture?: (event: ReactFocusEvent<HTMLDivElement>) => void }
            ).onFocusCapture?.(event);
          }}
          data-slot="popover-positioner"
        />
      )}
    >
      <div
        className={cn(
          APP_TRANSLUCENT_POPUP_SURFACE_CLASS_NAME,
          "relative flex outline-none has-data-[slot=calendar]:rounded-xl",
          tooltipStyle &&
            "w-fit text-balance rounded-control text-ui leading-snug shadow-md/5 before:rounded-[calc(var(--radius-control)-1px)]",
          className,
        )}
        data-slot="popover-popup"
      >
        <div
          className={cn(
            "relative size-full max-h-(--available-height) overflow-clip px-(--viewport-inline-padding) py-4 [--viewport-inline-padding:--spacing(4)] has-data-[slot=calendar]:p-2",
            tooltipStyle ? "py-1 [--viewport-inline-padding:--spacing(2)]" : "overflow-y-auto",
          )}
          data-slot="popover-viewport"
        >
          {children as ReactNode}
        </div>
      </div>
    </PopoverContent>
  );
}

function PopoverClose(props: Loose<ComponentProps<typeof PopoverClosePrimitive>>) {
  return (
    <PopoverClosePrimitive
      {...definedProps<object, ComponentProps<typeof PopoverClosePrimitive>>(props)}
      data-slot="popover-close"
    />
  );
}

function PopoverTitle({
  className,
  ...props
}: Omit<Loose<ComponentProps<typeof PopoverTitlePrimitive>>, "className"> & {
  className?: string | undefined;
}) {
  return (
    <PopoverTitlePrimitive
      {...definedProps<object, ComponentProps<typeof PopoverTitlePrimitive>>(props)}
      className={cn("font-medium text-lg leading-none", className)}
      data-slot="popover-title"
    />
  );
}

function PopoverDescription({
  className,
  ...props
}: Omit<Loose<ComponentProps<typeof PopoverDescriptionPrimitive>>, "className"> & {
  className?: string | undefined;
}) {
  return (
    <PopoverDescriptionPrimitive
      {...definedProps<object, ComponentProps<typeof PopoverDescriptionPrimitive>>(props)}
      className={cn("text-muted-foreground text-ui leading-snug", className)}
      data-slot="popover-description"
    />
  );
}

export {
  PopoverCreateHandle,
  Popover,
  PopoverTrigger,
  PopoverPopup,
  PopoverTitle,
  PopoverDescription,
  PopoverClose,
};
