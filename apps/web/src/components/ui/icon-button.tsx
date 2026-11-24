// FILE: icon-button.tsx
// Purpose: Centralizes labeled icon-only button behavior on top of the shadcn Button primitive.
// Layer: Shared UI primitive
// Exports: IconButton
// Depends on: Button variants and tooltip primitives.

import { forwardRef, type ComponentProps, type ReactNode } from "react";

import { cn } from "~/lib/utils";

import { Button } from "./button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";

type IconButtonProps = Omit<ComponentProps<typeof Button>, "aria-label" | "children"> & {
  label: string;
  tooltip?: ReactNode;
  tooltipDelay?: ComponentProps<typeof TooltipTrigger>["delay"];
  tooltipSide?: ComponentProps<typeof TooltipPopup>["side"];
  /** False keeps the tooltip open through a press, so it can confirm what the press did. */
  tooltipCloseOnClick?: boolean;
  children: ReactNode;
};

// Keeps the accessible label, optional browser title, and tooltip wiring identical everywhere.
const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    label,
    tooltip,
    tooltipDelay,
    tooltipSide: tooltipSideProp,
    tooltipCloseOnClick,
    title,
    className,
    size: sizeProp,
    variant: variantProp,
    children,
    ...buttonProps
  },
  ref,
) {
  const tooltipSide = tooltipSideProp ?? "top";
  const size = sizeProp === undefined ? "icon-xs" : sizeProp;
  const variant = variantProp === undefined ? "ghost" : variantProp;
  if (tooltip === undefined || tooltip === null) {
    return (
      <Button
        {...buttonProps}
        ref={ref}
        aria-label={label}
        className={cn("[&_svg,&_[data-slot=central-icon]]:mx-0", className)}
        size={size}
        title={title}
        variant={variant}
      >
        {children}
      </Button>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        delay={tooltipDelay}
        {...(tooltipCloseOnClick === false ? { closeOnClick: false } : {})}
        render={
          <Button
            {...buttonProps}
            ref={ref}
            aria-label={label}
            className={cn("[&_svg,&_[data-slot=central-icon]]:mx-0", className)}
            size={size}
            title={title}
            variant={variant}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side={tooltipSide}>
        {typeof tooltip === "string" ? <p>{tooltip}</p> : tooltip}
      </TooltipPopup>
    </Tooltip>
  );
});

export { IconButton };
