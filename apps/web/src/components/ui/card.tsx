// FILE: card.tsx
// Purpose: The card, for one independent object (an item, a photo, a task). The settings card
//          material (`SETTINGS_CARD_CLASS_NAME`): radius 12, hairline, the faint soft fill, no
//          shadow. `thumbnail` puts a picture on top, clipped by the card's corners, so tiles
//          are cards too. Never put a card inside a card.
// Layer: UI primitive
// Exports: Card

import type { ComponentProps, ReactNode } from "react";

import { cn } from "~/lib/utils";
import { SETTINGS_CARD_CLASS_NAME } from "~/settingsPanelStyles";

export function Card({
  thumbnail,
  className,
  children,
  ...props
}: ComponentProps<"div"> & {
  /** A picture or preview drawn edge to edge above the content. */
  readonly thumbnail?: ReactNode;
}) {
  return (
    <div className={cn(SETTINGS_CARD_CLASS_NAME, className)} data-slot="card" {...props}>
      {thumbnail != null ? (
        <div
          className="overflow-hidden border-b border-[color:var(--color-border)]"
          data-slot="card-thumbnail"
        >
          {thumbnail}
        </div>
      ) : null}
      {children}
    </div>
  );
}
