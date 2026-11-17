"use client";

import {
  Checkbox as CheckboxPrimitive,
  CheckboxIndicator as CheckboxIndicatorPrimitive,
  type CheckboxCheckedChangeReason,
} from "@ui-sdk/react/checkbox";
import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";
import { definedProps, type Loose } from "./uiSdkProps";

// Box + fill skins, shared with the menu's checkbox rows (`MenuCheckboxItem variant="checkbox"`).
export const CHECKBOX_BOX_CLASS_NAME =
  "relative inline-flex size-ui-icon shrink-0 items-center justify-center rounded-[calc(0.3125rem*var(--app-ui-scale,1))] border border-[color:var(--color-border-light)] bg-background outline-none ring-ring focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-background aria-invalid:border-destructive/36 focus-visible:aria-invalid:border-destructive/64 focus-visible:aria-invalid:ring-destructive/48 data-disabled:opacity-64 dark:not-data-checked:bg-input/32 dark:aria-invalid:ring-destructive/24";
export const CHECKBOX_INDICATOR_CLASS_NAME =
  "-inset-px absolute flex items-center justify-center rounded-[inherit] text-primary-foreground data-unchecked:hidden data-checked:bg-primary data-indeterminate:text-foreground";

export function CheckboxCheckGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={cn("size-ui-icon-sm", className)}
      fill="none"
      height="24"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="3"
      viewBox="0 0 24 24"
      width="24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M5.252 12.7 10.2 18.63 18.748 5.37" />
    </svg>
  );
}

type CheckboxPrimitiveProps = ComponentProps<typeof CheckboxPrimitive>;
type CheckboxChangeDetails = Parameters<NonNullable<CheckboxPrimitiveProps["onCheckedChange"]>>[1];

type CheckboxProps = Loose<
  Omit<CheckboxPrimitiveProps, "checked" | "defaultChecked" | "onCheckedChange" | "className">
> & {
  className?: string | undefined;
  checked?: boolean | undefined;
  defaultChecked?: boolean | undefined;
  /** Shows the mixed state (some of a group checked). A press makes it checked. */
  indeterminate?: boolean | undefined;
  /** Accepted for callers written against Base UI; the checkbox is always a native button. */
  nativeButton?: boolean | undefined;
  onCheckedChange?:
    | ((
        checked: boolean,
        details: CheckboxChangeDetails & { reason: CheckboxCheckedChangeReason },
      ) => void)
    | undefined;
};

function IndeterminateGlyph() {
  return (
    <svg
      className="size-ui-icon-sm"
      fill="none"
      height="24"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="3"
      viewBox="0 0 24 24"
      width="24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M5.252 12h13.496" />
    </svg>
  );
}

// Behaviour from UI SDK, look from Moss. The API stays the one callers know: `checked` is a
// boolean, the mixed state is its own `indeterminate` flag, and the change reports a boolean.
function Checkbox({
  className,
  checked,
  defaultChecked,
  indeterminate,
  nativeButton: _nativeButton,
  onCheckedChange,
  ...props
}: CheckboxProps) {
  const controlled = checked !== undefined || indeterminate === true;
  return (
    <CheckboxPrimitive
      {...definedProps<object, CheckboxPrimitiveProps>({
        ...props,
        checked: controlled ? (indeterminate ? "indeterminate" : (checked ?? false)) : undefined,
        defaultChecked,
        onCheckedChange: onCheckedChange
          ? (next: CheckboxPrimitiveProps["checked"], details: CheckboxChangeDetails) =>
              onCheckedChange(
                next === true,
                details as CheckboxChangeDetails & { reason: CheckboxCheckedChangeReason },
              )
          : undefined,
      })}
      className={cn(CHECKBOX_BOX_CLASS_NAME, className)}
      data-slot="checkbox"
    >
      <CheckboxIndicatorPrimitive
        className={CHECKBOX_INDICATOR_CLASS_NAME}
        data-slot="checkbox-indicator"
      >
        {(state) => (state.indeterminate ? <IndeterminateGlyph /> : <CheckboxCheckGlyph />)}
      </CheckboxIndicatorPrimitive>
    </CheckboxPrimitive>
  );
}

export { Checkbox, type CheckboxProps };
