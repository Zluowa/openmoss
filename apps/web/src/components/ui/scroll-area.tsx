"use client";

import {
  ScrollArea as ScrollAreaPrimitive,
  ScrollAreaCorner,
  ScrollAreaScrollbar,
  ScrollAreaThumb,
  ScrollAreaViewport,
} from "@ui-sdk/react/scroll-area";
import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";
import { definedProps, type Loose } from "./uiSdkProps";

type ScrollAreaProps = Loose<Omit<ComponentProps<typeof ScrollAreaPrimitive>, "className">> & {
  className?: string | undefined;
  scrollFade?: boolean;
  scrollbarGutter?: boolean;
  hideScrollbars?: boolean;
};

function ScrollArea({
  className,
  children,
  scrollFade: scrollFadeProp,
  scrollbarGutter: scrollbarGutterProp,
  hideScrollbars: hideScrollbarsProp,
  ...props
}: ScrollAreaProps) {
  const scrollFade = scrollFadeProp ?? false;
  const scrollbarGutter = scrollbarGutterProp ?? false;
  const hideScrollbars = hideScrollbarsProp ?? false;
  return (
    <ScrollAreaPrimitive
      {...definedProps<object, ComponentProps<typeof ScrollAreaPrimitive>>(props)}
      className={cn("size-full min-h-0", className)}
    >
      <ScrollAreaViewport
        className={cn(
          "h-full overscroll-contain rounded-[inherit] outline-none transition-shadows focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background data-has-overflow-x:overscroll-x-contain",
          // UI SDK writes the scroll distances on the root and does not let them inherit, so the
          // viewport's edge fade reads them from its parent explicitly.
          scrollFade &&
            "[--scroll-area-overflow-x-end:inherit] [--scroll-area-overflow-x-start:inherit] [--scroll-area-overflow-y-end:inherit] [--scroll-area-overflow-y-start:inherit] mask-t-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-start)))] mask-b-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-end)))] mask-l-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-x-start)))] mask-r-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-x-end)))] [--fade-size:var(--scroll-edge-fade-size)]",
          scrollbarGutter && "data-has-overflow-y:pe-2.5 data-has-overflow-x:pb-2.5",
          hideScrollbars &&
            "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        )}
        data-slot="scroll-area-viewport"
        // `data-has-overflow-x/y` is the attribute pair Moss lists, palettes and theme CSS select
        // on (the names Base UI used); UI SDK calls them `data-overflow-x/y`, so both are kept.
        render={(viewportProps, state) => (
          <div
            {...viewportProps}
            data-has-overflow-x={state.overflowX ? "" : undefined}
            data-has-overflow-y={state.overflowY ? "" : undefined}
          />
        )}
      >
        {children}
      </ScrollAreaViewport>
      {!hideScrollbars && (
        <>
          <ScrollBar orientation="vertical" />
          <ScrollBar orientation="horizontal" />
          <ScrollAreaCorner data-slot="scroll-area-corner" />
        </>
      )}
    </ScrollAreaPrimitive>
  );
}

type ScrollBarProps = Loose<Omit<ComponentProps<typeof ScrollAreaScrollbar>, "className">> & {
  className?: string | undefined;
};

function ScrollBar({ className, orientation: orientationProp, ...props }: ScrollBarProps) {
  const orientation = orientationProp ?? "vertical";
  return (
    <ScrollAreaScrollbar
      className={cn(
        "m-1 flex opacity-0 transition-opacity delay-300 data-[orientation=horizontal]:h-1.5 data-[orientation=vertical]:w-1.5 data-[orientation=horizontal]:flex-col data-hovering:opacity-100 data-scrolling:opacity-100 data-hovering:delay-0 data-scrolling:delay-0 data-hovering:duration-100 data-scrolling:duration-100",
        className,
      )}
      {...definedProps<object, ComponentProps<typeof ScrollAreaScrollbar>>(props)}
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
    >
      <ScrollAreaThumb
        className="relative flex-1 rounded-full bg-foreground/15"
        data-slot="scroll-area-thumb"
      />
    </ScrollAreaScrollbar>
  );
}

export { ScrollArea, ScrollBar, type ScrollAreaProps };
