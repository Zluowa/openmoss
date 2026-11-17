"use client";

import { Toggle as TogglePrimitive } from "@ui-sdk/react/toggle";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";
import { definedProps, type Loose } from "./uiSdkProps";

// Icon child rules name both an `<svg>` and a Central glyph span (see CENTRAL_ICON_SLOT).
const toggleVariants = cva(
  "[&_svg,&_[data-slot=central-icon]]:-mx-0.5 relative inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-2 whitespace-nowrap rounded-control border font-medium text-ui-lg leading-snug text-foreground outline-none pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 hover:bg-[var(--color-background-button-secondary-hover)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 data-pressed:bg-[var(--color-background-button-secondary)] data-pressed:text-[var(--color-text-foreground)] sm:text-ui [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg,&_[data-slot=central-icon]]:pointer-events-none [&_svg,&_[data-slot=central-icon]]:shrink-0",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default: "h-8 min-w-8 px-[calc(--spacing(2)-1px)] sm:h-7 sm:min-w-7",
        lg: "h-9 min-w-9 px-[calc(--spacing(2.5)-1px)] sm:h-8 sm:min-w-8",
        sm: "h-8 min-w-8 px-[calc(--spacing(1.5)-1px)] sm:h-7 sm:min-w-7",
        xs: "h-7 min-w-7 px-[calc(--spacing(1)-1px)] sm:h-6 sm:min-w-6 rounded-control-xs [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5",
      },
      variant: {
        default: "border-transparent",
        outline:
          "border-[color:var(--color-border)] bg-[var(--color-background-control-opaque)] dark:data-pressed:bg-[var(--color-background-button-secondary)] dark:hover:bg-[var(--color-background-button-secondary-hover)]",
      },
    },
  },
);

function Toggle({
  className,
  variant,
  size,
  ...props
}: Loose<Omit<ComponentProps<typeof TogglePrimitive>, "className">> & {
  className?: string | undefined;
} & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive
      {...definedProps<object, ComponentProps<typeof TogglePrimitive>>(props)}
      className={cn(toggleVariants({ className, size, variant }))}
      data-slot="toggle"
    />
  );
}

export { Toggle, toggleVariants };
