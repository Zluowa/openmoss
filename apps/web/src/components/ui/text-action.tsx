// FILE: text-action.tsx
// Purpose: The quiet text action: a secondary action that reads as a word, not a button. Examples:
//          清除 under a filter line, More options under a task card, Load earlier above a room.
//          It is the shared ghost Button at the normal weight in the muted ink, darkening on hover,
//          with the ghost fill. Use Button for a real action and TextLink for a link in text.
// Layer: UI primitive
// Exports: TextAction

import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";
import { Button } from "./button";

type TextActionProps = Omit<ComponentProps<typeof Button>, "variant" | "size"> & {
  /** `xs` (13 px, the default) beside small controls; `sm` (14 px) on its own line. */
  size?: "xs" | "sm";
};

export function TextAction({ size, className, ...props }: TextActionProps) {
  return (
    <Button
      variant="ghost"
      size={size ?? "xs"}
      {...props}
      className={cn("font-normal text-muted-foreground hover:text-foreground", className)}
      data-text-action=""
    />
  );
}
