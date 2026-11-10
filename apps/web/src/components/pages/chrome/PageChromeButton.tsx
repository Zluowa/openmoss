// FILE: PageChromeButton.tsx
// Purpose: The button shape that sits inside a top-bar capsule: 28px, round, flat until hovered,
//          16px glyph with an optional label. Slots use it so every capsule looks the same.
// Layer: Space page chrome (owned by space-ui)

import type { ComponentType, ReactNode } from "react";

import { cn } from "~/lib/utils";

import {
  PAGE_CHROME_CAPSULE_BUTTON_CLASS_NAME,
  PAGE_CHROME_ICON_BUTTON_CLASS_NAME,
} from "./pageChromeStyles";

export function PageChromeButton(props: {
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
  /** Hide the label and keep it as the accessible name only. */
  iconOnly?: boolean;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children?: ReactNode;
}) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      aria-label={props.iconOnly ? props.label : undefined}
      aria-pressed={props.active}
      title={props.iconOnly ? props.label : undefined}
      disabled={props.disabled}
      onClick={props.onClick}
      className={cn(
        PAGE_CHROME_CAPSULE_BUTTON_CLASS_NAME,
        props.iconOnly && PAGE_CHROME_ICON_BUTTON_CLASS_NAME,
      )}
    >
      <Icon aria-hidden className="size-4 shrink-0" />
      {props.iconOnly ? null : <span>{props.label}</span>}
      {props.children}
    </button>
  );
}
