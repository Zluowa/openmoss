// FILE: list-row.tsx
// Purpose: The list row, from `SettingsListRow`: title in 14 px medium ink, an optional
//          description in muted ink, optional leading picture and trailing actions. Two heights
//          from the standard: `default` 32 (a compact row) and `lg` 48 (a row with a thumbnail).
//          Radius 8. A row given `onClick` is one hit area across the whole row (`HitArea`,
//          Moss's look): it takes keyboard focus, fills with 3.5% ink on hover and draws the focus
//          frame around the whole row; its actions stay separate buttons on top.
// Layer: UI primitive
// Exports: ListRow

import type { ComponentProps, ReactNode } from "react";

import { cn } from "~/lib/utils";
import { HitArea } from "./hit-area";
import {
  SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME,
  SETTINGS_CARD_ROW_TITLE_CLASS_NAME,
} from "~/settingsPanelStyles";

export function ListRow({
  title,
  description,
  leading,
  actions,
  size = "default",
  className,
  onClick,
  ...props
}: Omit<ComponentProps<"div">, "title" | "onClick"> & {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly leading?: ReactNode;
  readonly actions?: ReactNode;
  readonly size?: "default" | "lg";
  /** Makes the whole row one button. */
  readonly onClick?: () => void;
}) {
  const body = (
    <>
      {leading != null ? (
        <div className="flex shrink-0 items-center" data-slot="list-row-leading">
          {leading}
        </div>
      ) : null}
      <div className="min-w-0 flex-1 text-start">
        <div className={cn(SETTINGS_CARD_ROW_TITLE_CLASS_NAME, "truncate")}>{title}</div>
        {description != null ? (
          <div className={cn(SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME, "truncate")}>
            {description}
          </div>
        ) : null}
      </div>
    </>
  );
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-ui-gap-sm rounded-row px-3 py-1",
        size === "lg" ? "min-h-12" : "min-h-8",
        onClick &&
          "relative hover:bg-[color-mix(in_srgb,var(--foreground)_3.5%,transparent)] has-[>button:focus-visible]:ring-2 has-[>button:focus-visible]:ring-ring",
        className,
      )}
      data-slot="list-row"
      data-size={size}
      {...props}
    >
      {onClick ? (
        // The shared hit area across the row; the row draws the focus frame around itself.
        <HitArea
          onClick={() => {
            onClick();
          }}
          className="flex min-w-0 flex-1 items-center gap-ui-gap-sm after:absolute after:inset-0 after:rounded-row focus-visible:ring-0"
        >
          {body}
        </HitArea>
      ) : (
        body
      )}
      {actions != null ? (
        <div
          className="relative flex shrink-0 items-center gap-ui-gap-xs"
          data-slot="list-row-actions"
        >
          {actions}
        </div>
      ) : null}
    </div>
  );
}
