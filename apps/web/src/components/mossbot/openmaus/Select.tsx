// Adapted from OpenMaus @ 58378e8 (Apache-2.0). See third_party/openmaus/UI-PORTS.md.
import type { ComponentProps } from "react";
import { ChevronDown } from "./icons";
import { cn } from "~/lib/utils";

const VARIANTS = {
  field: "rounded-control border border-border/40 bg-muted text-foreground",
  pill: "h-8 rounded-full border border-border/40 bg-muted/60 font-medium text-foreground hover:bg-muted",
  ghost:
    "h-7 rounded-control border-[0.5px] [border-color:var(--settings-edge,color-mix(in_srgb,var(--foreground)_8%,transparent))] bg-transparent text-foreground hover:bg-foreground/[0.06] [field-sizing:content]",
  quiet:
    "rounded-control bg-foreground/[0.05] text-foreground outline-none hover:bg-foreground/[0.08] focus-visible:ring-[1.5px] focus-visible:ring-ring",
} as const;

const GHOST = { select: "pl-2.5 pr-[18px] text-ui-sm", chevron: "right-1" };

// The 14px chevron draws its stroke ~3.5px inside its box, so the box sits that much nearer the edge than the text's padding.
const SIZES = {
  lg: { select: "py-2.5 pl-3 pr-9 text-ui", chevron: "right-2" },
  md: { select: "py-2 pl-3 pr-9 text-ui-sm", chevron: "right-2" },
  sm: { select: "py-1.5 pl-2.5 pr-8 text-ui-sm", chevron: "right-1.5" },
} as const;

export function Select({
  className,
  variant = "field",
  size = "md",
  ...props
}: Omit<ComponentProps<"select">, "size"> & {
  variant?: keyof typeof VARIANTS;
  size?: keyof typeof SIZES;
}) {
  return (
    <div className={cn("relative inline-flex min-w-0", className)}>
      {/* The platform draws the open list (white by default) while the options inherit the skin's ink, so they get the menu colour. */}
      <select
        {...props}
        className={cn(
          "peer w-full min-w-0 cursor-pointer appearance-none truncate [color-scheme:var(--code-color-scheme)] [&_option]:bg-popover [&_option]:text-foreground disabled:cursor-default disabled:opacity-50",
          VARIANTS[variant],
          variant === "ghost" ? GHOST.select : SIZES[size].select,
        )}
      />
      <ChevronDown
        size={variant === "ghost" ? 12 : 14}
        aria-hidden
        className={cn(
          "pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted-foreground peer-disabled:opacity-50",
          variant === "ghost" ? GHOST.chevron : SIZES[size].chevron,
        )}
      />
    </div>
  );
}
