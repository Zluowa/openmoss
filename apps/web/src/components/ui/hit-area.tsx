// FILE: hit-area.tsx
// Purpose: The shared hit area: a press target with no look of its own, for a tile, a whole card,
//          or a chip or row with custom content. It writes the focus ring, the interaction cursor and
//          the disabled state once; the content draws the rest. Where an existing part fits, use it
//          instead: ListRow for list rows, TextLink for inline links, Button / IconButton for
//          controls. It needs an accessible name: its own text, or `aria-label`.
// Layer: UI primitive (UI SDK's button underneath, so an agent bridge can find and press it)
// Exports: HitArea, HIT_AREA_CLASS_NAME

import { Button as ButtonPrimitive } from "@ui-sdk/react/button";
import type { ComponentProps, MouseEvent } from "react";

import { cn } from "~/lib/utils";
import { definedProps, type Loose } from "./uiSdkProps";

/** Focus ring, the app's interaction cursor (an arrow in the desktop app, a hand on the web)
 *  and the disabled state; nothing else. */
export const HIT_AREA_CLASS_NAME =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-64";

type HitAreaProps = Omit<
  Loose<ComponentProps<typeof ButtonPrimitive>>,
  "onClick" | "type" | "className"
> & {
  className?: string | undefined;
  type?: "button" | "submit" | undefined;
  /** A press. Its result is ignored: the hit area never turns pending (see Button). */
  onClick?: ((event: MouseEvent<HTMLElement>) => void) | undefined;
};

export function HitArea({ className, type, onClick, ...props }: HitAreaProps) {
  return (
    <ButtonPrimitive
      {...definedProps<object, ComponentProps<typeof ButtonPrimitive>>(props)}
      type={type ?? "button"}
      className={cn(HIT_AREA_CLASS_NAME, className)}
      data-hit-area=""
      {...(onClick
        ? {
            onClick: (event: MouseEvent<HTMLElement>) => {
              onClick(event);
            },
          }
        : {})}
    />
  );
}
