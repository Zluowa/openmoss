import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "~/lib/utils";

// The leading icon is a Central glyph (a masked `span[data-slot=central-icon]`) or, for brand
// marks, an `<svg>`; the icon column, its sizing and tint key off either.
const alertVariants = cva(
  "relative grid w-full items-start gap-x-2 gap-y-0.5 rounded-xl border text-card-foreground has-[>:is(svg,[data-slot=central-icon])]:has-data-[slot=alert-action]:grid-cols-[calc(var(--spacing)*4)_1fr_auto] has-[>:is(svg,[data-slot=central-icon])]:grid-cols-[calc(var(--spacing)*4)_1fr] has-data-[slot=alert-action]:grid-cols-[1fr_auto] has-[>:is(svg,[data-slot=central-icon])]:gap-x-2 [&>:is(svg,[data-slot=central-icon])]:h-lh [&>:is(svg,[data-slot=central-icon])]:w-4",
  {
    defaultVariants: {
      variant: "default",
      size: "default",
    },
    variants: {
      variant: {
        default:
          "bg-transparent dark:bg-input/32 [&>:is(svg,[data-slot=central-icon])]:text-muted-foreground",
        error:
          "border-destructive/32 bg-destructive/4 [&>:is(svg,[data-slot=central-icon])]:text-destructive",
        info: "border-info/32 bg-info/4 [&>:is(svg,[data-slot=central-icon])]:text-info",
        success:
          "border-success/32 bg-success/4 [&>:is(svg,[data-slot=central-icon])]:text-success",
        warning:
          "border-warning/32 bg-warning/4 [&>:is(svg,[data-slot=central-icon])]:text-warning",
      },
      size: {
        default: "px-3.5 py-3 text-ui leading-snug",
        // Dense inline callout for panel chrome (source control / diff errors).
        sm: "rounded-md px-2.5 py-1.5 text-ui leading-snug",
      },
    },
  },
);

function Alert({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      className={cn(alertVariants({ variant, size }), className)}
      data-slot="alert"
      role="alert"
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("font-medium [:is(svg,[data-slot=central-icon])~&]:col-start-2", className)}
      data-slot="alert-title"
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2.5 text-muted-foreground [:is(svg,[data-slot=central-icon])~&]:col-start-2",
        className,
      )}
      data-slot="alert-description"
      {...props}
    />
  );
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex gap-1 max-sm:col-start-2 max-sm:mt-2 sm:row-start-1 sm:row-end-3 sm:self-center sm:[[data-slot=alert-description]~&]:col-start-2 sm:[[data-slot=alert-title]~&]:col-start-2 sm:[:is(svg,[data-slot=central-icon])~&]:col-start-2 sm:[:is(svg,[data-slot=central-icon])~[data-slot=alert-description]~&]:col-start-3 sm:[:is(svg,[data-slot=central-icon])~[data-slot=alert-title]~&]:col-start-3",
        className,
      )}
      data-slot="alert-action"
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription, AlertAction };
